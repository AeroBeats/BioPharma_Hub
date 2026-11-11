// 库存管理：试剂/耗材台账，localStorage 持久化，CSV 导入导出
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

function esc(s) {
  const d = document.createElement("div");
  d.textContent = s ?? "";
  return d.innerHTML;
}

const STORE_KEY = "bph_lab_inventory_v1";
const CATEGORIES = ["试剂", "酶", "耗材", "菌株/细胞", "质粒/载体", "其他"];
const CSV_HEADERS = ["名称", "类别", "规格", "数量", "单位", "位置", "有效期", "低库存阈值", "备注"];

const invState = { items: load(), query: "", category: "全部", editing: null, formOpen: false, message: null };

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

function filteredItems() {
  let items = [...invState.items];
  if (invState.category !== "全部") items = items.filter((i) => i.category === invState.category);
  if (invState.query) {
    const q = invState.query.toLowerCase();
    items = items.filter((i) =>
      [i.name, i.spec, i.location, i.note].some((v) => (v || "").toLowerCase().includes(q))
    );
  }
  items.sort((a, b) => {
    const da = a.expiry || "9999-12-31", db = b.expiry || "9999-12-31";
    return da === db ? (a.name || "").localeCompare(b.name || "", "zh") : da.localeCompare(db);
  });
  return items;
}

export function renderInventory(container) {
  const items = filteredItems();
  const low = invState.items.filter((i) => itemStatus(i).key === "low").length;
  const soon = invState.items.filter((i) => itemStatus(i).key === "soon").length;
  const expired = invState.items.filter((i) => itemStatus(i).key === "expired").length;

  container.innerHTML = `
    <div class="card inv-panel">
      <div class="inv-head">
        <div>
          <h2>库存管理</h2>
          <p class="panel-desc">试剂与耗材台账，数据保存在本浏览器（localStorage）。支持 CSV 导入导出备份。</p>
        </div>
        <div class="inv-head-actions">
          <button class="btn btn-primary btn-sm" id="inv-add">+ 新增条目</button>
          <button class="btn btn-sm" id="inv-export">导出 CSV</button>
          <label class="btn btn-sm" for="inv-import">导入 CSV</label>
          <input type="file" id="inv-import" accept=".csv,text/csv" hidden />
        </div>
      </div>
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
      <div class="news-toolbar" style="margin-bottom:12px">
        <div class="search-box">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
          <input type="search" id="inv-search" placeholder="搜索名称 / 规格 / 位置 / 备注…" value="${esc(invState.query)}" />
        </div>
        <div class="filter-chips" id="inv-cats">
          ${["全部", ...CATEGORIES].map((c) => `<button class="chip ${c === invState.category ? "active" : ""}" data-cat="${c}">${c}</button>`).join("")}
        </div>
      </div>
      <div class="inv-table-wrap">
        ${items.length ? `
        <table class="inv-table">
          <thead><tr><th>名称</th><th>类别</th><th>规格</th><th>数量</th><th>位置</th><th>有效期</th><th>状态</th><th></th></tr></thead>
          <tbody>
            ${items.map((i) => {
              const st = itemStatus(i);
              return `<tr>
                <td class="inv-name">${esc(i.name)}${i.note ? `<div class="hint">${esc(i.note)}</div>` : ""}</td>
                <td>${esc(i.category)}</td>
                <td>${esc(i.spec)}</td>
                <td class="input-mono">${esc(String(i.qty))} ${esc(i.unit)}</td>
                <td>${esc(i.location)}</td>
                <td class="input-mono">${esc(i.expiry) || "—"}</td>
                <td><span class="inv-badge inv-badge-${st.cls}">${st.label}</span></td>
                <td class="inv-ops">
                  <button class="btn btn-sm btn-ghost" data-edit="${i.id}">编辑</button>
                  <button class="btn btn-sm btn-ghost" data-del="${i.id}" style="color:var(--rose)">删除</button>
                </td>
              </tr>`;
            }).join("")}
          </tbody>
        </table>` : `
        <div class="state">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 8v13H3V8"/><path d="M1 3h22v5H1z"/><path d="M10 12h4"/></svg>
          <div class="state-title">${invState.items.length ? "没有匹配的条目" : "库存为空"}</div>
          <div class="state-desc">${invState.items.length ? "调整搜索或筛选条件。" : "点击「+ 新增条目」开始建立试剂台账，或导入已有 CSV。"}</div>
        </div>`}
      </div>
    </div>
  `;

  if (invState.formOpen) renderForm(container);

  $("#inv-add").addEventListener("click", () => {
    invState.editing = null;
    invState.formOpen = true;
    renderForm(container);
  });
  $("#inv-search").addEventListener("input", (e) => {
    invState.query = e.target.value.trim();
    renderInventory(container);
    const inp = $("#inv-search");
    inp.focus();
    inp.setSelectionRange(inp.value.length, inp.value.length);
  });
  $("#inv-cats").addEventListener("click", (e) => {
    const btn = e.target.closest(".chip");
    if (!btn) return;
    invState.category = btn.dataset.cat;
    renderInventory(container);
  });
  $("#inv-export").addEventListener("click", exportCSV);
  $("#inv-import").addEventListener("change", (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const added = importCSV(String(reader.result));
      invState.message = `导入完成：新增 ${added} 条（重复条目已跳过）。`;
      save();
      renderInventory(container);
    };
    reader.readAsText(file, "utf-8");
  });
  $$("[data-edit]", container).forEach((btn) => {
    btn.addEventListener("click", () => {
      invState.editing = invState.items.find((i) => i.id === btn.dataset.edit) || null;
      invState.formOpen = true;
      renderForm(container);
    });
  });
  $$("[data-del]", container).forEach((btn) => {
    btn.addEventListener("click", () => {
      const item = invState.items.find((i) => i.id === btn.dataset.del);
      if (!item) return;
      if (!confirm(`删除「${item.name}」？此操作不可撤销。`)) return;
      invState.items = invState.items.filter((i) => i.id !== item.id);
      save();
      renderInventory(container);
    });
  });
}

function renderForm(container) {
  const slot = $("#inv-form-slot");
  if (!slot) return;
  const it = invState.editing || {};
  slot.innerHTML = `
    <form class="inv-form" id="inv-form" autocomplete="off">
      <div class="form-section-title">${invState.editing ? "编辑条目" : "新增条目"}</div>
      <div class="inv-form-grid">
        <div class="field"><label>名称 *</label><input class="input" name="name" required value="${esc(it.name || "")}" placeholder="如 Taq DNA 聚合酶" /></div>
        <div class="field"><label>类别</label><select class="select" name="category">${CATEGORIES.map((c) => `<option ${(it.category || "试剂") === c ? "selected" : ""}>${c}</option>`).join("")}</select></div>
        <div class="field"><label>规格</label><input class="input" name="spec" value="${esc(it.spec || "")}" placeholder="如 500 U / 5 U/µL" /></div>
        <div class="field"><label>数量 *</label><input class="input input-mono" name="qty" type="number" step="any" min="0" required value="${esc(it.qty ?? "")}" /></div>
        <div class="field"><label>单位</label><input class="input" name="unit" value="${esc(it.unit || "")}" placeholder="支 / 盒 / mL" /></div>
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
    slot.innerHTML = "";
  });
  $("#inv-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const data = {
      name: String(fd.get("name") || "").trim(),
      category: String(fd.get("category") || "试剂"),
      spec: String(fd.get("spec") || "").trim(),
      qty: String(fd.get("qty") || "").trim(),
      unit: String(fd.get("unit") || "").trim(),
      location: String(fd.get("location") || "").trim(),
      expiry: String(fd.get("expiry") || "").trim(),
      low: String(fd.get("low") || "").trim(),
      note: String(fd.get("note") || "").trim(),
    };
    if (!data.name || data.qty === "") return;
    if (invState.editing) {
      Object.assign(invState.editing, data);
    } else {
      invState.items.push({ id: uid(), ...data });
    }
    invState.formOpen = false;
    invState.editing = null;
    invState.message = null;
    save();
    renderInventory(container);
  });
}

function csvEscape(v) {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function exportCSV() {
  const rows = [CSV_HEADERS.join(",")];
  for (const i of invState.items) {
    rows.push([i.name, i.category, i.spec, i.qty, i.unit, i.location, i.expiry, i.low, i.note].map(csvEscape).join(","));
  }
  const blob = new Blob(["\uFEFF" + rows.join("\r\n")], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `lab-inventory-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

function parseCSV(text) {
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
    else if (ch === ",") { row.push(cur); cur = ""; }
    else if (ch === "\n") { row.push(cur); rows.push(row); row = []; cur = ""; }
    else if (ch !== "\r") cur += ch;
  }
  if (cur !== "" || row.length) { row.push(cur); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

function importCSV(text) {
  const rows = parseCSV(text.replace(/^\uFEFF/, ""));
  if (!rows.length) return 0;
  const header = rows[0].map((h) => h.trim());
  const idx = (name) => header.indexOf(name);
  if (idx("名称") === -1) return 0;
  const get = (r, name) => {
    const i = idx(name);
    return i === -1 ? "" : (r[i] || "").trim();
  };
  let added = 0;
  for (const r of rows.slice(1)) {
    const name = get(r, "名称");
    if (!name) continue;
    const spec = get(r, "规格"), location = get(r, "位置");
    const dup = invState.items.some((i) => i.name === name && i.spec === spec && i.location === location);
    if (dup) continue;
    invState.items.push({
      id: uid(),
      name,
      category: CATEGORIES.includes(get(r, "类别")) ? get(r, "类别") : "其他",
      spec,
      qty: get(r, "数量") || "0",
      unit: get(r, "单位"),
      location,
      expiry: get(r, "有效期"),
      low: get(r, "低库存阈值"),
      note: get(r, "备注"),
    });
    added++;
  }
  return added;
}