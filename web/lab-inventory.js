// 库存管理：试剂/耗材台账。
// 双模式：未登录或无当前组织 → localStorage（本浏览器）；登录且有组织 → 按组织共享的服务器台账。
// QA 角色为只读（GLP 职责分离）。支持 CSV 导入导出、批量粘贴、批量管理与一次性本地迁移。
import { isLoggedIn, currentOrg, api } from "./auth.js";

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

function esc(s) {
  const d = document.createElement("div");
  d.textContent = s ?? "";
  return d.innerHTML;
}

const STORE_KEY = "bph_lab_inventory_v1";
const BOM = String.fromCharCode(0xfeff);
const stripBOM = (s) => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);
const CATEGORIES = ["试剂", "酶", "耗材", "菌株/细胞", "质粒/载体", "其他"];
const CSV_HEADERS = ["名称", "类别", "规格", "数量", "单位", "位置", "有效期", "低库存阈值", "备注", "厂家", "生产批次"];
const ITEM_FIELDS = ["name", "category", "spec", "qty", "unit", "location", "expiry", "low", "note", "vendor", "batch"];

const invState = {
  items: load(), query: "", category: "全部", editing: null, formOpen: false,
  message: null, selected: new Set(), pasteOpen: false, prefill: null,
  loading: false, loadError: null, canWrite: true,
};

// 当前已加载库存所属组织 id；null 表示本地（localStorage）模式。
let _activeOrgId = null;

function orgMode() {
  return isLoggedIn() && !!currentOrg();
}

function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function save() {
  localStorage.setItem(STORE_KEY, JSON.stringify(invState.items));
  pruneSelected();
}

function pruneSelected() {
  const ids = new Set(invState.items.map((i) => i.id));
  invState.selected.forEach((id) => { if (!ids.has(id)) invState.selected.delete(id); });
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function daysToExpiry(item) {
  if (!item.expiry) return null;
  const d = new Date(item.expiry + "T00:00:00");
  if (isNaN(d)) return null;
  return Math.ceil((d.getTime() - Date.now()) / 86400000);
}

function itemStatus(item) {
  const days = daysToExpiry(item);
  if (days !== null && days < 0) return { key: "expired", label: "已过期", cls: "rose" };
  if (days !== null && days <= 30) return { key: "soon", label: `临期 ${days}天`, cls: "amber" };
  if (item.low !== "" && item.low != null && Number(item.qty) <= Number(item.low)) {
    return { key: "low", label: "低库存", cls: "amber" };
  }
  return { key: "ok", label: "正常", cls: "accent" };
}

// ── 对外接口：供 Protocol 库存核对与 AI 上下文使用 ─────────────────
export function inventoryItems() {
  return invState.items;
}

export function inventoryStatus(item) {
  return itemStatus(item);
}

export function prefillNewItem(data) {
  invState.editing = null;
  invState.formOpen = true;
  invState.prefill = data;
}

export function setInventoryQuery(q) {
  invState.query = q;
  invState.category = "全部";
}

function normName(s) {
  return String(s || "").toLowerCase().replace(/[\s()（）[\]【】\-–—_,，.。:：/\\%％]+/g, "");
}

function nameTokens(s) {
  const raw = String(s || "").toLowerCase().match(/[a-z0-9]{2,}|[一-鿿]{2,}/g) || [];
  return new Set(raw.map((t) => (/^[a-z]{4,}s$/.test(t) ? t.slice(0, -1) : t)));
}

function nameNumbers(s) {
  return new Set(String(s || "").toLowerCase().match(/\d+(?:\.\d+)?%?|\b(?:i{1,3}|iv|vi{0,3})\b/g) || []);
}

// 名称模糊匹配：归一化全等 > 包含 > 共享词元（复数词干归一）；浓度/编号不同（70% vs 75%、Solution I vs II）不互配
export function matchInventory(name) {
  const n = normName(name);
  if (!n) return null;
  const tn = nameTokens(name);
  const nn = nameNumbers(name);
  let best = null, bestScore = 0;
  for (const it of invState.items) {
    const m = normName(it.name);
    if (!m) continue;
    const mn = nameNumbers(it.name);
    if (nn.size && mn.size && ![...nn].some((x) => mn.has(x))) continue;
    let score = 0;
    if (m === n) score = 100;
    else if (m.includes(n) || n.includes(m)) score = 60 + Math.min(m.length, n.length);
    else {
      const tm = nameTokens(it.name);
      let shared = 0;
      for (const t of tn) {
        if (tm.has(t)) shared += /^[a-z0-9]+$/.test(t) ? (t.length >= 3 ? 2 : 1) : 2;
      }
      if (shared >= 3) score = 20 + shared * 5;
    }
    if (score > bestScore) { bestScore = score; best = it; }
  }
  return best;
}

function filteredItems() {
  let items = [...invState.items];
  if (invState.category !== "全部") items = items.filter((i) => i.category === invState.category);
  if (invState.query) {
    const q = invState.query.toLowerCase();
    items = items.filter((i) =>
      [i.name, i.spec, i.vendor, i.batch, i.location, i.note].some((v) => (v || "").toLowerCase().includes(q))
    );
  }
  items.sort((a, b) => {
    const da = a.expiry || "9999-12-31", db = b.expiry || "9999-12-31";
    return da === db ? (a.name || "").localeCompare(b.name || "", "zh") : da.localeCompare(db);
  });
  return items;
}

// ── 服务器（组织）台账 API ─────────────────────────────────────────
function _normalizeOrgItem(it) {
  // 统一 id 为字符串，与本地模式一致，避免选择/比较时类型不匹配。
  return { ...it, id: String(it.id) };
}

function _invPath(suffix = "") {
  return `/api/orgs/${_activeOrgId}/inventory${suffix}`;
}

async function _fetchOrgItems(orgId, container) {
  const res = await api(`/api/orgs/${orgId}/inventory`);
  if (_activeOrgId !== orgId) return; // 期间已切换组织/模式
  if (res.ok) {
    invState.items = (res.items || []).map(_normalizeOrgItem);
    invState.canWrite = res.canWrite !== false;
    invState.loadError = null;
  } else {
    invState.loadError = res.error === "network" ? (res.message || "无法连接服务器") : (res.error || "加载库存失败");
  }
  invState.loading = false;
  pruneSelected();
  if (_activeOrgId === orgId) _paint(container);
}

async function _reloadOrg(container) {
  if (_activeOrgId == null) return;
  invState.loading = true;
  invState.loadError = null;
  _paint(container);
  await _fetchOrgItems(_activeOrgId, container);
}

// ── 渲染入口：模式分发 ─────────────────────────────────────────────
export function renderInventory(container) {
  const org = orgMode() ? currentOrg() : null;
  const wantOrgId = org ? org.id : null;

  if (wantOrgId !== _activeOrgId) {
    _activeOrgId = wantOrgId;
    invState.selected.clear();
    invState.formOpen = false;
    invState.editing = null;
    invState.prefill = null;
    invState.pasteOpen = false;
    invState.message = null;
    invState.loadError = null;
    if (wantOrgId === null) {
      invState.items = load();
      invState.canWrite = true;
      invState.loading = false;
    } else {
      invState.items = [];
      invState.canWrite = true;
      invState.loading = true;
      _paint(container);
      _fetchOrgItems(wantOrgId, container);
      return;
    }
  }
  _paint(container);
}

function _writable() {
  return !orgMode() || invState.canWrite;
}

function _migrationInfo() {
  if (!orgMode() || !invState.canWrite) return null;
  const flagKey = `bph_inv_migrated_${_activeOrgId}`;
  if (localStorage.getItem(flagKey)) return null;
  const localItems = load();
  if (!localItems.length) return null;
  return { count: localItems.length, flagKey, localItems };
}

function _paint(container) {
  if (invState.loading) {
    container.innerHTML = `
      <div class="card inv-panel">
        <div class="inv-head"><div><h2>库存管理</h2>
          <p class="panel-desc">正在从组织服务器加载共享台账…</p></div></div>
        <div class="state"><div class="state-title">加载中…</div></div>
      </div>`;
    return;
  }

  const org = orgMode() ? currentOrg() : null;
  const writable = _writable();
  const items = filteredItems();
  const low = invState.items.filter((i) => itemStatus(i).key === "low").length;
  const soon = invState.items.filter((i) => itemStatus(i).key === "soon").length;
  const expired = invState.items.filter((i) => itemStatus(i).key === "expired").length;
  const mig = _migrationInfo();
  const colspan = writable ? 11 : 10;

  const modeDesc = org
    ? (writable
      ? `数据按组织共享（服务器台账）：${esc(org.name)}。支持 CSV 导入导出备份。`
      : `当前组织「${esc(org.name)}」的共享台账。你的角色为只读（QA），不能修改。`)
    : "试剂与耗材台账，数据保存在本浏览器（localStorage）。支持 CSV 导入导出备份。";

  container.innerHTML = `
    <div class="card inv-panel">
      <div class="inv-head">
        <div>
          <h2>库存管理</h2>
          <p class="panel-desc">${modeDesc}</p>
        </div>
        <div class="inv-head-actions">
          ${writable ? `<button class="btn btn-primary btn-sm" id="inv-add">+ 新增条目</button>
          <button class="btn btn-sm" id="inv-paste-toggle">批量粘贴</button>` : ""}
          <button class="btn btn-sm" id="inv-export">导出 CSV</button>
          ${writable ? `<label class="btn btn-sm" for="inv-import">导入 CSV</label>
          <input type="file" id="inv-import" accept=".csv,text/csv" hidden />` : ""}
          ${org ? `<button class="btn btn-sm btn-ghost" id="inv-refresh" title="从服务器刷新">刷新</button>` : ""}
        </div>
      </div>

      ${invState.loadError ? `<div class="ai-unavailable" style="border-left:3px solid var(--rose);background:var(--rose-soft);color:var(--rose);margin-bottom:12px">
        ${esc(invState.loadError)} <button class="btn btn-sm" id="inv-retry" style="margin-left:8px">重试</button></div>` : ""}

      ${mig ? `<div class="ai-unavailable" style="border-left:3px solid var(--accent);background:var(--accent-soft);color:var(--accent-hover);margin-bottom:12px">
        检测到本浏览器有 <strong>${mig.count}</strong> 条本地库存。
        <button class="btn btn-sm btn-primary" id="inv-migrate" style="margin-left:8px">迁移到组织台账</button>
        <button class="btn btn-sm btn-ghost" id="inv-migrate-skip" style="margin-left:4px">暂不</button>
      </div>` : ""}

      <div class="inv-stats">
        <span>共 <strong>${invState.items.length}</strong> 条</span>
        <span class="dot"></span>
        <span style="color:var(--amber)">低库存 <strong>${low}</strong></span>
        <span class="dot"></span>
        <span style="color:var(--amber)">临期 <strong>${soon}</strong></span>
        <span class="dot"></span>
        <span style="color:var(--rose)">过期 <strong>${expired}</strong></span>
      </div>
      ${invState.message ? `<div class="ai-unavailable" style="border-left:3px solid var(--accent);background:var(--accent-soft);color:var(--accent-hover);margin-bottom:12px">${esc(invState.message)}</div>` : ""}
      <div id="inv-form-slot"></div>
      <div id="inv-paste-slot"></div>
      <div id="inv-bulk-slot"></div>
      <div class="news-toolbar" style="margin-bottom:12px">
        <div class="search-box">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
          <input type="search" id="inv-search" placeholder="搜索名称 / 规格 / 厂家 / 批次 / 位置 / 备注…" value="${esc(invState.query)}" />
        </div>
        <div class="filter-chips" id="inv-cats">
          ${["全部", ...CATEGORIES].map((c) => `<button class="chip ${c === invState.category ? "active" : ""}" data-cat="${c}">${c}</button>`).join("")}
        </div>
      </div>
      <div class="inv-table-wrap">
        ${items.length ? `
        <table class="inv-table">
          <thead><tr>${writable ? `<th class="inv-check-col"><input type="checkbox" id="inv-sel-all" aria-label="全选当前列表" ${items.length && items.every((i) => invState.selected.has(i.id)) ? "checked" : ""} /></th>` : ""}<th>名称</th><th>类别</th><th>规格</th><th>厂家</th><th>生产批次</th><th>数量</th><th>位置</th><th>有效期</th><th>状态</th><th></th></tr></thead>
          <tbody>
            ${items.map((i) => {
              const st = itemStatus(i);
              return `<tr>
                ${writable ? `<td class="inv-check-col"><input type="checkbox" class="inv-check" data-sel="${i.id}" aria-label="选择 ${esc(i.name)}" ${invState.selected.has(i.id) ? "checked" : ""} /></td>` : ""}
                <td class="inv-name">${esc(i.name)}${i.note ? `<div class="hint">${esc(i.note)}</div>` : ""}</td>
                <td>${esc(i.category)}</td>
                <td>${esc(i.spec)}</td>
                <td>${esc(i.vendor) || "—"}</td>
                <td class="input-mono">${esc(i.batch) || "—"}</td>
                <td class="input-mono">${esc(String(i.qty))} ${esc(i.unit)}</td>
                <td>${esc(i.location)}</td>
                <td class="input-mono">${esc(i.expiry) || "—"}</td>
                <td><span class="inv-badge inv-badge-${st.cls}">${st.label}</span></td>
                <td class="inv-ops">
                  ${writable ? `<button class="btn btn-sm btn-ghost" data-edit="${i.id}">编辑</button>
                  <button class="btn btn-sm btn-ghost" data-del="${i.id}" style="color:var(--rose)">删除</button>` : `<span class="hint">只读</span>`}
                </td>
              </tr>`;
            }).join("")}
          </tbody>
        </table>` : `
        <div class="state">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 8v13H3V8"/><path d="M1 3h22v5H1z"/><path d="M10 12h4"/></svg>
          <div class="state-title">${invState.items.length ? "没有匹配的条目" : "库存为空"}</div>
          <div class="state-desc">${invState.items.length ? "调整搜索或筛选条件。" : (writable ? "点击「+ 新增条目」开始建立试剂台账，或导入已有 CSV。" : "该组织暂无库存记录。")}</div>
        </div>`}
      </div>
    </div>
  `;

  // ── 事件绑定 ──
  $("#inv-retry")?.addEventListener("click", () => _reloadOrg(container));
  $("#inv-refresh")?.addEventListener("click", () => _reloadOrg(container));

  if (mig) {
    $("#inv-migrate").addEventListener("click", () => _migrateLocal(container, mig));
    $("#inv-migrate-skip").addEventListener("click", () => {
      localStorage.setItem(mig.flagKey, "skipped");
      _paint(container);
    });
  }

  if (invState.formOpen && writable) renderForm(container);

  $("#inv-add")?.addEventListener("click", () => {
    invState.editing = null;
    invState.formOpen = true;
    renderForm(container);
  });
  $("#inv-search").addEventListener("input", (e) => {
    invState.query = e.target.value.trim();
    _paint(container);
    const inp = $("#inv-search");
    inp.focus();
    inp.setSelectionRange(inp.value.length, inp.value.length);
  });
  $("#inv-cats").addEventListener("click", (e) => {
    const btn = e.target.closest(".chip");
    if (!btn) return;
    invState.category = btn.dataset.cat;
    _paint(container);
  });
  $("#inv-export").addEventListener("click", exportCSV);
  $("#inv-import")?.addEventListener("change", (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const clean = stripBOM(String(reader.result));
      ingestRows(parseCSV(clean, detectDelim(clean)), container, "CSV 导入");
    };
    reader.readAsText(file, "utf-8");
  });

  if (writable) {
    $$("[data-edit]", container).forEach((btn) => {
      btn.addEventListener("click", () => {
        invState.editing = invState.items.find((i) => i.id === btn.dataset.edit) || null;
        invState.formOpen = true;
        renderForm(container);
      });
    });
    $$("[data-del]", container).forEach((btn) => {
      btn.addEventListener("click", () => deleteOne(btn.dataset.del, container));
    });
    $("#inv-paste-toggle").addEventListener("click", () => {
      invState.pasteOpen = !invState.pasteOpen;
      renderPastePanel(container);
    });
    $("#inv-sel-all")?.addEventListener("change", (e) => {
      const ids = items.map((i) => i.id);
      ids.forEach((id) => e.target.checked ? invState.selected.add(id) : invState.selected.delete(id));
      _paint(container);
    });
    $$(".inv-check", container).forEach((cb) => {
      cb.addEventListener("change", () => {
        if (cb.checked) invState.selected.add(cb.dataset.sel);
        else invState.selected.delete(cb.dataset.sel);
        _paint(container);
      });
    });
    const selAll = $("#inv-sel-all");
    if (selAll) selAll.indeterminate = !selAll.checked && items.some((i) => invState.selected.has(i.id));
    renderPastePanel(container);
    renderBulkBar(container);
  } else {
    const ps = $("#inv-paste-slot"); if (ps) ps.innerHTML = "";
    const bs = $("#inv-bulk-slot"); if (bs) bs.innerHTML = "";
  }
}

// ── 一次性迁移：本浏览器 localStorage → 组织服务器台账 ─────────────
async function _migrateLocal(container, mig) {
  const ok = confirm(`将本浏览器的 ${mig.count} 条库存复制到组织台账？\n（本地数据保留，不会删除）`);
  if (!ok) return;
  const rows = mig.localItems.map((i) => {
    const o = {};
    ITEM_FIELDS.forEach((f) => { o[f] = i[f] == null ? "" : String(i[f]); });
    return o;
  }).filter((r) => r.name);
  const btn = $("#inv-migrate");
  if (btn) { btn.disabled = true; btn.textContent = "迁移中…"; }
  const res = await api(_invPath("/bulk"), { method: "POST", body: { items: rows } });
  if (!res.ok) {
    invState.message = res.error === "network" ? (res.message || "无法连接服务器") : (res.error || "迁移失败");
    _paint(container);
    return;
  }
  localStorage.setItem(mig.flagKey, String(res.count));
  invState.message = `已迁移 ${res.count} 条到组织台账。`;
  await _reloadOrg(container);
}

// ── 变更操作（双模式） ─────────────────────────────────────────────
async function deleteOne(id, container) {
  const item = invState.items.find((i) => i.id === id);
  if (!item) return;
  if (!confirm(`删除「${item.name}」？`)) return;
  if (orgMode()) {
    const res = await api(_invPath(`/${id}`), { method: "DELETE", body: { reason: "用户删除" } });
    if (!res.ok) { invState.message = res.error === "network" ? (res.message || "无法连接服务器") : (res.error || "删除失败"); _paint(container); return; }
    invState.items = invState.items.filter((i) => i.id !== id);
    invState.selected.delete(id);
  } else {
    invState.items = invState.items.filter((i) => i.id !== id);
    save();
  }
  invState.message = orgMode() ? `已删除「${item.name}」（审计留痕）。` : null;
  _paint(container);
}

async function ingestRows(rows, container, sourceLabel) {
  const { newItems, added, skipped } = rowsToItems(rows);
  if (!added) {
    invState.message = `${sourceLabel}：没有新增（重复或无效行 ${skipped} 条）。`;
    invState.pasteOpen = false;
    _paint(container);
    return;
  }
  if (orgMode()) {
    const res = await api(_invPath("/bulk"), { method: "POST", body: { items: newItems } });
    if (!res.ok) {
      invState.message = res.error === "network" ? (res.message || "无法连接服务器") : (res.error || "导入失败");
      _paint(container);
      return;
    }
    (res.items || []).forEach((it) => invState.items.unshift(_normalizeOrgItem(it)));
    invState.message = `${sourceLabel}：新增 ${res.count} 条，跳过重复 ${skipped} 条（审计留痕）。`;
  } else {
    newItems.forEach((d) => invState.items.push({ id: uid(), ...d }));
    save();
    invState.message = `${sourceLabel}：新增 ${added} 条，跳过重复 ${skipped} 条。`;
  }
  invState.pasteOpen = false;
  _paint(container);
}

function renderPastePanel(container) {
  const slot = $("#inv-paste-slot");
  if (!slot) return;
  if (!invState.pasteOpen) { slot.innerHTML = ""; return; }
  slot.innerHTML = `
    <div class="paste-panel">
      <div class="form-section-title">批量粘贴导入</div>
      <textarea class="textarea input-mono" id="inv-paste-text" rows="6" placeholder="名称,类别,规格,数量,单位,位置,有效期,低库存阈值,备注,厂家,生产批次&#10;Taq DNA 聚合酶,酶,500 U,2,支,-20℃ 冰箱 A2,2026-12-01,2,含甘油,Thermo Fisher,LOT1234567&#10;也可以直接从 Excel 复制粘贴（Tab 分隔）；首行表头可省略；旧版 9 列格式仍兼容"></textarea>
      <div class="hint">自动识别逗号 / Tab 分隔；首行含"名称"视为表头，否则按模板列顺序解析；重复条目（名称+规格+位置）自动跳过。</div>
      <div class="inv-form-actions">
        <button class="btn btn-primary btn-sm" id="inv-paste-run">导入粘贴内容</button>
        <button class="btn btn-sm" id="inv-paste-tpl">下载 CSV 模板</button>
        <button class="btn btn-sm" id="inv-paste-cancel">取消</button>
      </div>
    </div>
  `;
  $("#inv-paste-run").addEventListener("click", () => {
    const text = $("#inv-paste-text").value;
    if (!text.trim()) { invState.message = "粘贴内容为空。"; _paint(container); return; }
    const clean = stripBOM(text);
    ingestRows(parseCSV(clean, detectDelim(clean)), container, "粘贴导入");
  });
  $("#inv-paste-tpl").addEventListener("click", () => {
    downloadCSV([
      CSV_HEADERS.join(","),
      "Taq DNA 聚合酶,酶,500 U,2,支,-20℃ 冰箱 A2,2026-12-01,2,含甘油,Thermo Fisher,LOT1234567",
      "1.5 mL 离心管,耗材,500 个/包,10,包,架 B3,,3,,Axygen,LOT88888",
    ], "lab-inventory-template.csv");
  });
  $("#inv-paste-cancel").addEventListener("click", () => {
    invState.pasteOpen = false;
    renderPastePanel(container);
  });
}

function renderBulkBar(container) {
  const slot = $("#inv-bulk-slot");
  if (!slot) return;
  const n = invState.selected.size;
  if (!n) { slot.innerHTML = ""; return; }
  slot.innerHTML = `
    <div class="inv-bulkbar">
      <strong>已选 ${n} 项</strong>
      <select class="select" id="inv-bulk-cat" style="width:auto" aria-label="批量修改类别">
        <option value="">改类别…</option>
        ${CATEGORIES.map((c) => `<option>${c}</option>`).join("")}
      </select>
      <input class="input" id="inv-bulk-loc" style="width:170px" placeholder="批量改位置，回车应用" aria-label="批量修改位置" />
      <button class="btn btn-sm" id="inv-bulk-export">导出所选</button>
      <button class="btn btn-sm" id="inv-bulk-del" style="color:var(--rose)">删除所选</button>
      <button class="btn btn-sm btn-ghost" id="inv-bulk-clear">取消选择</button>
    </div>
  `;
  const selectedItems = () => invState.items.filter((i) => invState.selected.has(i.id));
  const selectedIds = () => selectedItems().map((i) => i.id);

  $("#inv-bulk-cat").addEventListener("change", async (e) => {
    const cat = e.target.value;
    if (!cat) return;
    if (orgMode()) {
      const res = await api(_invPath("/bulk-update"), { method: "POST", body: { ids: selectedIds().map(Number), patch: { category: cat } } });
      if (!res.ok) { invState.message = res.error === "network" ? (res.message || "无法连接服务器") : (res.error || "批量修改失败"); _paint(container); return; }
      selectedItems().forEach((i) => { i.category = cat; });
      invState.message = `已将 ${res.count} 条类别改为「${cat}」（审计留痕）。`;
    } else {
      selectedItems().forEach((i) => { i.category = cat; });
      invState.message = `已将 ${n} 条类别改为「${cat}」。`;
      save();
    }
    _paint(container);
  });

  const applyLoc = async () => {
    const loc = $("#inv-bulk-loc").value.trim();
    if (!loc) return;
    if (orgMode()) {
      const res = await api(_invPath("/bulk-update"), { method: "POST", body: { ids: selectedIds().map(Number), patch: { location: loc } } });
      if (!res.ok) { invState.message = res.error === "network" ? (res.message || "无法连接服务器") : (res.error || "批量修改失败"); _paint(container); return; }
      selectedItems().forEach((i) => { i.location = loc; });
      invState.message = `已将 ${res.count} 条位置改为「${loc}」（审计留痕）。`;
    } else {
      selectedItems().forEach((i) => { i.location = loc; });
      invState.message = `已将 ${n} 条位置改为「${loc}」。`;
      save();
    }
    _paint(container);
  };
  $("#inv-bulk-loc").addEventListener("change", applyLoc);
  $("#inv-bulk-loc").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); applyLoc(); } });

  $("#inv-bulk-export").addEventListener("click", () => {
    exportItems(selectedItems(), `lab-inventory-selected-${new Date().toISOString().slice(0, 10)}.csv`);
  });
  $("#inv-bulk-del").addEventListener("click", async () => {
    if (!confirm(`删除所选 ${n} 条？`)) return;
    if (orgMode()) {
      const res = await api(_invPath("/bulk-delete"), { method: "POST", body: { ids: selectedIds().map(Number), reason: "批量删除" } });
      if (!res.ok) { invState.message = res.error === "network" ? (res.message || "无法连接服务器") : (res.error || "批量删除失败"); _paint(container); return; }
      const del = new Set(selectedIds());
      invState.items = invState.items.filter((i) => !del.has(i.id));
      invState.message = `已删除 ${res.count} 条（审计留痕）。`;
    } else {
      invState.items = invState.items.filter((i) => !invState.selected.has(i.id));
      invState.message = `已删除 ${n} 条。`;
      save();
    }
    invState.selected.clear();
    _paint(container);
  });
  $("#inv-bulk-clear").addEventListener("click", () => {
    invState.selected.clear();
    _paint(container);
  });
}

function renderForm(container) {
  const slot = $("#inv-form-slot");
  if (!slot) return;
  const it = invState.editing || invState.prefill || {};
  slot.innerHTML = `
    <form class="inv-form" id="inv-form" autocomplete="off">
      <div class="form-section-title">${invState.editing ? "编辑条目" : "新增条目"}</div>
      <div class="inv-form-grid">
        <div class="field"><label>名称 *</label><input class="input" name="name" required value="${esc(it.name || "")}" placeholder="如 Taq DNA 聚合酶" /></div>
        <div class="field"><label>类别</label><select class="select" name="category">${CATEGORIES.map((c) => `<option ${(it.category || "试剂") === c ? "selected" : ""}>${c}</option>`).join("")}</select></div>
        <div class="field"><label>规格</label><input class="input" name="spec" value="${esc(it.spec || "")}" placeholder="如 500 U / 5 U/µL" /></div>
        <div class="field"><label>数量 *</label><input class="input input-mono" name="qty" type="number" step="any" min="0" required value="${esc(it.qty ?? "")}" /></div>
        <div class="field"><label>单位</label><input class="input" name="unit" value="${esc(it.unit || "")}" placeholder="支 / 盒 / mL" /></div>
        <div class="field"><label>厂家</label><input class="input" name="vendor" value="${esc(it.vendor || "")}" placeholder="如 Thermo Fisher / 生工" /></div>
        <div class="field"><label>生产批次</label><input class="input input-mono" name="batch" value="${esc(it.batch || "")}" placeholder="如 Lot 1234567" /></div>
        <div class="field"><label>位置</label><input class="input" name="location" value="${esc(it.location || "")}" placeholder="如 -20℃ 冰箱 A2 层" /></div>
        <div class="field"><label>有效期</label><input class="input input-mono" name="expiry" type="date" value="${esc(it.expiry || "")}" /></div>
        <div class="field"><label>低库存阈值</label><input class="input input-mono" name="low" type="number" step="any" min="0" value="${esc(it.low ?? "")}" placeholder="数量≤该值时提醒" /></div>
        <div class="field inv-form-note"><label>备注</label><input class="input" name="note" value="${esc(it.note || "")}" /></div>
      </div>
      <div class="inv-form-actions">
        <button class="btn btn-primary btn-sm" type="submit">保存</button>
        <button class="btn btn-sm" type="button" id="inv-cancel">取消</button>
      </div>
    </form>
  `;
  $("#inv-cancel").addEventListener("click", () => {
    invState.formOpen = false;
    invState.editing = null;
    invState.prefill = null;
    slot.innerHTML = "";
  });
  $("#inv-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const data = {};
    ITEM_FIELDS.forEach((f) => { data[f] = String(fd.get(f) ?? "").trim(); });
    if (!data.category) data.category = "试剂";
    if (!data.name || data.qty === "") return;

    const submitBtn = e.target.querySelector('button[type="submit"]');
    if (orgMode()) {
      submitBtn.disabled = true;
      const editing = invState.editing;
      const res = editing
        ? await api(_invPath(`/${editing.id}`), { method: "PATCH", body: data })
        : await api(_invPath(), { method: "POST", body: data });
      submitBtn.disabled = false;
      if (!res.ok) {
        invState.message = res.error === "network" ? (res.message || "无法连接服务器") : (res.error || "保存失败");
        _paint(container);
        return;
      }
      const norm = _normalizeOrgItem(res.item);
      if (editing) {
        const idx = invState.items.findIndex((x) => x.id === norm.id);
        if (idx >= 0) invState.items[idx] = norm; else invState.items.unshift(norm);
      } else {
        invState.items.unshift(norm);
      }
    } else {
      if (invState.editing) {
        Object.assign(invState.editing, data);
      } else {
        invState.items.push({ id: uid(), ...data });
      }
      save();
    }
    invState.formOpen = false;
    invState.editing = null;
    invState.prefill = null;
    invState.message = null;
    _paint(container);
  });
}

function csvEscape(v) {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function downloadCSV(rows, filename) {
  const blob = new Blob([BOM + rows.join("\r\n")], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

function exportItems(items, filename) {
  const rows = [CSV_HEADERS.join(",")];
  for (const i of items) {
    rows.push([i.name, i.category, i.spec, i.qty, i.unit, i.location, i.expiry, i.low, i.note, i.vendor, i.batch].map(csvEscape).join(","));
  }
  downloadCSV(rows, filename);
}

function exportCSV() {
  exportItems(invState.items, `lab-inventory-${new Date().toISOString().slice(0, 10)}.csv`);
}

function detectDelim(text) {
  const line = text.split(/\r?\n/).find((l) => l.trim()) || "";
  return (line.match(/\t/g) || []).length > (line.match(/,/g) || []).length ? "\t" : ",";
}

function parseCSV(text, delim = ",") {
  const rows = [];
  let row = [], cur = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cur += '"'; i++; }
        else inQ = false;
      } else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === delim) { row.push(cur); cur = ""; }
    else if (ch === "\n") { row.push(cur); rows.push(row); row = []; cur = ""; }
    else if (ch !== "\r") cur += ch;
  }
  if (cur !== "" || row.length) { row.push(cur); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

// 解析为「待新增」的字段对象（不含 id），并对名称+规格+位置去重。
function rowsToItems(rows) {
  if (!rows.length) return { newItems: [], added: 0, skipped: 0 };
  let header = rows[0].map((h) => h.trim());
  let dataRows = rows.slice(1);
  if (!header.includes("名称")) { header = CSV_HEADERS; dataRows = rows; }
  const idx = (name) => header.indexOf(name);
  const get = (r, name) => {
    const i = idx(name);
    return i === -1 ? "" : (r[i] || "").trim();
  };
  const newItems = [];
  let added = 0, skipped = 0;
  const seen = (name, spec, location) =>
    invState.items.some((i) => i.name === name && i.spec === spec && i.location === location) ||
    newItems.some((i) => i.name === name && i.spec === spec && i.location === location);
  for (const r of dataRows) {
    const name = get(r, "名称");
    if (!name) continue;
    const spec = get(r, "规格"), location = get(r, "位置");
    if (seen(name, spec, location)) { skipped++; continue; }
    newItems.push({
      name,
      category: CATEGORIES.includes(get(r, "类别")) ? get(r, "类别") : "其他",
      spec,
      qty: get(r, "数量") || "0",
      unit: get(r, "单位"),
      location,
      expiry: get(r, "有效期"),
      low: get(r, "低库存阈值"),
      note: get(r, "备注"),
      vendor: get(r, "厂家"),
      batch: get(r, "生产批次"),
    });
    added++;
  }
  return { newItems, added, skipped };
}
