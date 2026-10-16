import { TEMPLATES, getTemplate } from "./templates.js";

// ── Utilities ─────────────────────────────────
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

function esc(s) {
  const d = document.createElement("div");
  d.textContent = s ?? "";
  return d.innerHTML;
}

function timeAgo(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d)) return "";
  const diff = Date.now() - d.getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} 小时前`;
  const day = Math.floor(h / 24);
  if (day < 30) return `${day} 天前`;
  return d.toLocaleDateString("zh-CN");
}

function formatDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return isNaN(d) ? "" : d.toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" });
}

// ── Router ─────────────────────────────────
const ROUTES = {
  news: { title: "行业新闻", render: renderNews },
  protocols: { title: "Protocol 设计", render: renderProtocols },
  tools: { title: "小工具", render: renderTools },
  english: { title: "英语学习", render: renderEnglish },
  about: { title: "关于", render: renderAbout },
};

function navigate() {
  const hash = location.hash.replace("#/", "") || "news";
  const route = ROUTES[hash] ? hash : "news";

  $$(".nav-item").forEach((a) => a.classList.toggle("active", a.dataset.route === route));
  $("#topbar-title").textContent = ROUTES[route].title;
  $("#topbar-actions").innerHTML = "";
  closeSidebar();

  const view = $("#view");
  view.innerHTML = "";
  ROUTES[route].render(view);
}

window.addEventListener("hashchange", navigate);

// ── Mobile sidebar ─────────────────────────────────
function openSidebar() {
  $("#sidebar").classList.add("open");
  $("#overlay").hidden = false;
  $("#menu-btn").setAttribute("aria-expanded", "true");
}
function closeSidebar() {
  $("#sidebar").classList.remove("open");
  $("#overlay").hidden = true;
  $("#menu-btn").setAttribute("aria-expanded", "false");
}
$("#menu-btn")?.addEventListener("click", openSidebar);
$("#overlay")?.addEventListener("click", closeSidebar);

// ── NEWS VIEW ─────────────────────────────────
const newsState = { items: [], sources: [], filter: "全部", query: "", loading: true, error: null, updatedAt: null, failedSources: [], translations: {}, translating: false };

// Static pre-generated news (GitHub Actions → web/data/news.json). Resolved
// relative to this module so it works at a domain root or a project sub-path.
const NEWS_JSON_URL = new URL("data/news.json", import.meta.url).href;

function applyNewsData(data) {
  newsState.items = data.items || [];
  newsState.sources = data.sources || [];
  newsState.updatedAt = data.updatedAt || data.fetchedAt || null;
  newsState.failedSources = data.failedSources || [];
  if (data.translations) {
    newsState.translations = { ...newsState.translations, ...data.translations };
  }
}

async function fetchNews() {
  newsState.loading = true;
  newsState.error = null;
  renderNewsList();

  let usedStatic = false;
  // 1) Static build-time data — primary source on GitHub Pages / Qoder Sites.
  try {
    const res = await fetch(`${NEWS_JSON_URL}?t=${Date.now()}`, { cache: "no-store" });
    if (res.ok) {
      const data = await res.json();
      if (data && data.ok && Array.isArray(data.items) && data.items.length > 0) {
        applyNewsData(data);
        usedStatic = true;
      }
    }
  } catch { /* fall through to live function */ }

  // 2) Live edge function fallback (only when static data is unavailable).
  if (!usedStatic) {
    try {
      const res = await fetch("/functions/v1/app/news");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "unknown");
      applyNewsData(data);
    } catch (e) {
      newsState.error = e.message;
    }
  }

  newsState.loading = false;
  renderNewsList();
  // Static JSON already bakes in translations; only the live path needs a runtime call.
  if (!usedStatic && newsState.items.length > 0) fetchTranslations();
}

async function fetchTranslations() {
  const enTitles = newsState.items
    .filter((i) => i.lang === "en" && i.title)
    .slice(0, 50)
    .map((i) => i.title);
  if (enTitles.length === 0) return;

  newsState.translating = true;
  renderNewsList();
  try {
    const res = await fetch("/functions/v1/app/news/translate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ titles: enTitles }),
    });
    if (res.ok) {
      const data = await res.json();
      if (data.ok && data.translations) {
        newsState.translations = { ...newsState.translations, ...data.translations };
      }
    }
  } catch { /* silent */ }
  finally {
    newsState.translating = false;
    renderNewsList();
  }
}

function renderNews(container) {
  container.innerHTML = `
    <div class="page-head">
      <h1>生物医药行业新闻</h1>
      <p>实时聚合全球生物医药领域资讯，涵盖研发进展、审批动态、市场趋势与技术突破。标题自动翻译为中文。</p>
    </div>
    <div class="news-toolbar">
      <div class="search-box">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
        <input type="search" id="news-search" placeholder="搜索新闻标题或摘要…" aria-label="搜索新闻" />
      </div>
      <div class="filter-chips" id="news-filters"></div>
      <button class="btn btn-sm" id="news-refresh" title="刷新">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 3v6h-6"/></svg>
        刷新
      </button>
    </div>
    <div class="news-meta" id="news-meta"></div>
    <div class="news-list" id="news-list"></div>
  `;

  const categories = ["全部", "研发", "审批", "市场", "技术"];
  const filtersEl = $("#news-filters");
  filtersEl.innerHTML = categories.map((c) =>
    `<button class="chip ${c === newsState.filter ? "active" : ""}" data-cat="${c}">${c}</button>`
  ).join("");
  filtersEl.addEventListener("click", (e) => {
    const btn = e.target.closest(".chip");
    if (!btn) return;
    newsState.filter = btn.dataset.cat;
    $$(".chip", filtersEl).forEach((c) => c.classList.toggle("active", c.dataset.cat === newsState.filter));
    renderNewsList();
  });

  $("#news-search").addEventListener("input", (e) => {
    newsState.query = e.target.value.trim().toLowerCase();
    renderNewsList();
  });

  $("#news-refresh").addEventListener("click", fetchNews);

  if (newsState.items.length === 0 && !newsState.error) fetchNews();
  else renderNewsList();
}

function renderNewsList() {
  const listEl = $("#news-list");
  const metaEl = $("#news-meta");
  if (!listEl) return;

  if (newsState.loading) {
    listEl.innerHTML = Array.from({ length: 6 }, () => `<div class="skeleton skel-item"></div>`).join("");
    metaEl.innerHTML = `<span class="spinner" style="width:14px;height:14px;border-width:2px"></span> 正在加载最新资讯…`;
    return;
  }

  if (newsState.error) {
    listEl.innerHTML = `
      <div class="state">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="9"/><path d="M12 8v4M12 16h.01"/></svg>
        <div class="state-title">新闻加载失败</div>
        <div class="state-desc">${esc(newsState.error)}。新闻数据由定时任务生成，请稍后重试，或确认 data/news.json 已就绪。</div>
        <button class="btn btn-primary" id="news-retry-btn">重新加载</button>
      </div>`;
    $("#news-retry-btn")?.addEventListener("click", fetchNews);
    metaEl.innerHTML = "";
    return;
  }

  let items = newsState.items;
  if (newsState.filter !== "全部") items = items.filter((i) => i.category === newsState.filter);
  if (newsState.query) {
    const q = newsState.query;
    items = items.filter((i) =>
      i.title.toLowerCase().includes(q) ||
      (i.titleZh || newsState.translations[i.title] || "").toLowerCase().includes(q) ||
      (i.summary || "").toLowerCase().includes(q) ||
      i.source.toLowerCase().includes(q)
    );
  }

  metaEl.innerHTML = `
    <span>共 <strong>${items.length}</strong> 条</span>
    <span class="dot"></span>
    <span>更新于 ${timeAgo(newsState.updatedAt)}</span>
    ${newsState.translating ? `<span class="dot"></span><span style="color:var(--accent)">翻译中…</span>` : ""}
    ${newsState.failedSources.length ? `<span class="dot"></span><span style="color:var(--amber)">${newsState.failedSources.length} 个源暂不可用</span>` : ""}
  `;

  if (items.length === 0) {
    listEl.innerHTML = `
      <div class="state">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
        <div class="state-title">没有匹配的新闻</div>
        <div class="state-desc">尝试调整搜索关键词或筛选条件。</div>
      </div>`;
    return;
  }

  listEl.innerHTML = items.slice(0, 60).map((item) => {
    const zhTitle = item.titleZh || newsState.translations[item.title];
    const isEn = item.lang === "en";
    return `
    <a class="news-item" href="${esc(item.link)}" target="_blank" rel="noopener noreferrer">
      <div class="news-item-head">
        <span class="source-badge">${esc(item.source)}</span>
        <span class="cat-badge cat-${esc(item.category)}">${esc(item.category)}</span>
        <span class="news-time">${timeAgo(item.publishedAt)}</span>
      </div>
      ${isEn && zhTitle ? `<div class="news-title news-title-zh">${esc(zhTitle)}</div><div class="news-title-en">${esc(item.title)}</div>` : `<div class="news-title">${esc(item.title)}</div>`}
      ${item.summary ? `<div class="news-summary">${esc(item.summary)}</div>` : ""}
    </a>`;
  }).join("");
}

// ── PROTOCOL VIEW ─────────────────────────────────
const protoState = { templateId: "pcr", values: {}, aiResult: null, aiLoading: false, aiError: null };

function renderProtocols(container) {
  const tpl = getTemplate(protoState.templateId) || TEMPLATES[0];

  if (Object.keys(protoState.values).length === 0 || protoState.values.__tpl !== tpl.id) {
    protoState.values = { __tpl: tpl.id };
    tpl.fields.forEach((f) => { if (f.default !== undefined) protoState.values[f.key] = f.default; });
  }

  container.innerHTML = `
    <div class="page-head">
      <h1>Protocol 辅助设计</h1>
      <p>选择实验模板，填写参数，自动生成结构化 Protocol 文档。支持打印导出，可选 AI 智能优化。</p>
    </div>
    <div class="proto-layout">
      <div class="proto-panel card" id="proto-left">
        <h2>实验模板</h2>
        <p class="panel-desc">选择实验类型后填写右侧参数</p>
        <div class="template-grid" id="template-grid"></div>
      </div>
      <div class="proto-output" id="proto-right">
        <div class="proto-panel card" id="proto-form-panel"></div>
        <div id="proto-doc-container"></div>
        <div id="proto-ai-container"></div>
      </div>
    </div>
  `;

  renderTemplateGrid(tpl);
  renderForm(tpl);
  renderDoc(tpl);
  renderAI();
}

function renderTemplateGrid(selected) {
  const grid = $("#template-grid");
  grid.innerHTML = TEMPLATES.map((t) => `
    <button class="template-card ${t.id === selected.id ? "selected" : ""}" data-id="${t.id}">
      <div class="template-icon" style="background:${t.bg};color:${t.color}">${t.icon}</div>
      <div class="template-info">
        <div class="template-name">${esc(t.name)}</div>
        <div class="template-desc">${esc(t.desc)}</div>
      </div>
    </button>
  `).join("");

  grid.onclick = (e) => {
    const btn = e.target.closest(".template-card");
    if (!btn) return;
    protoState.templateId = btn.dataset.id;
    protoState.values = { __tpl: btn.dataset.id };
    const tpl = getTemplate(btn.dataset.id);
    tpl.fields.forEach((f) => { if (f.default !== undefined) protoState.values[f.key] = f.default; });
    protoState.aiResult = null;
    protoState.aiError = null;
    renderProtocols($("#view"));
  };
}

function renderForm(tpl) {
  const panel = $("#proto-form-panel");
  panel.innerHTML = `
    <h2>实验参数</h2>
    <p class="panel-desc">${esc(tpl.name)} — 填写以下参数生成 Protocol</p>
    <form id="proto-form" autocomplete="off"></form>
  `;

  const form = $("#proto-form");
  let html = `<div class="form-section"><div class="form-section-title">基本参数</div>`;

  tpl.fields.forEach((f, i) => {
    if (i === Math.ceil(tpl.fields.length / 2)) html += `</div><div class="form-section"><div class="form-section-title">反应条件</div>`;
    const val = protoState.values[f.key] ?? f.default ?? "";
    html += `<div class="field">
      <label for="f-${f.key}">${esc(f.label)}${f.required ? ' <span style="color:var(--rose)">*</span>' : ""}</label>`;
    if (f.type === "select") {
      const opts = f.options || [];
      html += `<select class="select" id="f-${f.key}" data-key="${f.key}">
        ${opts.map((o) => `<option value="${esc(o)}" ${String(val) === String(o) ? "selected" : ""}>${esc(o)}</option>`).join("")}
      </select>`;
    } else if (f.type === "textarea") {
      html += `<textarea class="textarea" id="f-${f.key}" data-key="${f.key}" rows="3" placeholder="${esc(f.placeholder || "")}">${esc(val)}</textarea>`;
    } else {
      html += `<input class="input ${f.mono ? "input-mono" : ""}" type="${f.type === "number" ? "number" : "text"}" id="f-${f.key}" data-key="${f.key}"
        value="${esc(val)}" placeholder="${esc(f.placeholder || "")}"
        ${f.min !== undefined ? `min="${f.min}"` : ""} ${f.max !== undefined ? `max="${f.max}"` : ""} ${f.step ? `step="${f.step}"` : ""} />`;
    }
    if (f.hint) html += `<div class="hint">${esc(f.hint)}</div>`;
    html += `</div>`;
  });
  html += `</div>`;

  form.innerHTML = html;
  const onInput = (e) => {
    const el = e.target.closest("[data-key]");
    if (!el) return;
    protoState.values[el.dataset.key] = el.type === "number" ? (el.value === "" ? "" : Number(el.value)) : el.value;
    renderDoc(tpl);
  };
  form.addEventListener("input", onInput);
  form.addEventListener("change", onInput);
}

function renderDoc(tpl) {
  const container = $("#proto-doc-container");
  const v = protoState.values;
  const now = new Date();

  let reagents = [], steps = [], notes = [];
  try { reagents = tpl.reagents(v) || []; } catch { /* */ }
  try { steps = tpl.steps(v) || []; } catch { /* */ }
  try { notes = (tpl.notes ? tpl.notes(v) : []) || []; } catch { /* */ }

  const title = tpl.name + (v.targetGene ? ` — ${v.targetGene}` : v.targetProtein ? ` — ${v.targetProtein}` : v.plasmidName ? ` — ${v.plasmidName}` : v.cellLine ? ` — ${v.cellLine}` : v.analyte ? ` — ${v.analyte}` : "");

  container.innerHTML = `
    <div class="output-actions">
      <button class="btn btn-primary" id="btn-print">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9V2h12v7"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>
        打印 / 导出 PDF
      </button>
      <button class="btn" id="btn-copy">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
        复制文本
      </button>
      <span style="font-size:12px;color:var(--text-3);margin-left:auto">实时预览 · 修改参数即时更新</span>
    </div>
    <div class="protocol-doc" id="protocol-doc">
      <h1>${esc(title)}</h1>
      <div class="doc-meta">
        <span>模板：${esc(tpl.name)}</span>
        <span>生成日期：${formatDate(now.toISOString())}</span>
        <span>BioPharma Hub</span>
      </div>
      ${reagents.length ? `
      <h2>试剂与耗材</h2>
      <table class="reagent-table">
        <thead><tr><th>试剂/耗材</th><th>用量/规格</th></tr></thead>
        <tbody>${reagents.map(([name, amount]) => `<tr><td style="font-family:var(--font-body)">${esc(name)}</td><td>${esc(amount)}</td></tr>`).join("")}</tbody>
      </table>` : ""}
      ${notes.filter((n) => n.type === "warning").map((n) => `<div class="warning-box"><strong>⚠ 注意：</strong>${esc(n.text)}</div>`).join("")}
      ${steps.map((s, i) => `
      <h2>${i + 1}. ${esc(s.h)}</h2>
      <ol>${s.items.map((item) => `<li>${esc(item)}</li>`).join("")}</ol>`).join("")}
      ${notes.filter((n) => n.type === "note").length ? `
      <h2>注意事项与提示</h2>
      <ul>${notes.filter((n) => n.type === "note").map((n) => `<li>${esc(n.text)}</li>`).join("")}</ul>` : ""}
    </div>
  `;

  $("#btn-print").addEventListener("click", () => window.print());
  $("#btn-copy").addEventListener("click", async () => {
    const text = $("#protocol-doc").innerText;
    try {
      await navigator.clipboard.writeText(text);
      const btn = $("#btn-copy");
      btn.textContent = "已复制 ✓";
      setTimeout(() => { btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> 复制文本`; }, 2000);
    } catch { alert("复制失败，请手动选择文本复制。"); }
  });
}

// ── AI Panel ─────────────────────────────────
function renderAI() {
  const container = $("#proto-ai-container");
  container.innerHTML = `
    <div class="ai-panel">
      <div class="ai-panel-head">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2a4 4 0 0 1 4 4v1a4 4 0 0 1-8 0V6a4 4 0 0 1 4-4z"/><path d="M8 14s-4 2-4 6h16c0-4-4-6-4-6"/></svg>
        <span>AI 智能优化</span>
      </div>
      <div class="ai-panel-body" id="ai-body"></div>
    </div>
  `;
  renderAIBody();
}

function renderAIBody() {
  const body = $("#ai-body");
  if (!body) return;

  if (protoState.aiLoading) {
    body.innerHTML = `<div style="display:flex;align-items:center;gap:10px;padding:8px 0">
      <span class="spinner" style="width:18px;height:18px;border-width:2px"></span>
      <span style="font-size:13px;color:var(--text-2)">AI 正在分析你的 Protocol…</span></div>`;
    return;
  }

  if (protoState.aiError) {
    body.innerHTML = `
      <div class="ai-unavailable" style="border-left:3px solid var(--rose);background:var(--rose-soft);color:#7a2536">${esc(protoState.aiError)}</div>
      <div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap">
        <textarea class="textarea" id="ai-instruction" rows="2" placeholder="补充说明（可选）">优化步骤并补充注意事项</textarea>
        <button class="btn btn-primary" id="ai-retry" style="align-self:flex-end">重试</button>
      </div>`;
    $("#ai-retry").addEventListener("click", () => callAI());
    return;
  }

  if (protoState.aiResult) {
    body.innerHTML = `
      <div class="ai-result">${renderMarkdown(protoState.aiResult)}</div>
      <div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        <textarea class="textarea" id="ai-instruction" rows="2" style="flex:1;min-width:200px" placeholder="追问或要求修改…"></textarea>
        <button class="btn btn-primary" id="ai-again" style="align-self:flex-end">继续优化</button>
        <button class="btn btn-sm" id="ai-clear" style="align-self:flex-end">清除</button>
      </div>`;
    $("#ai-again").addEventListener("click", () => callAI());
    $("#ai-clear").addEventListener("click", () => { protoState.aiResult = null; renderAIBody(); });
    return;
  }

  body.innerHTML = `
    <p style="font-size:12.5px;color:var(--text-2);margin-bottom:10px">AI 将根据当前 Protocol 参数，提供步骤优化、潜在问题提示和注意事项补充。</p>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <textarea class="textarea" id="ai-instruction" rows="2" style="flex:1;min-width:200px" placeholder="补充说明（可选）：如"优化退火温度"、"增加阳性对照步骤""></textarea>
      <button class="btn btn-primary" id="ai-run" style="align-self:flex-end">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m5 3 14 9-14 9V3z"/></svg>
        AI 优化
      </button>
    </div>`;
  $("#ai-run").addEventListener("click", () => callAI());
}

function renderMarkdown(md) {
  let html = esc(md);
  html = html.replace(/^### (.+)$/gm, "<h3>$1</h3>");
  html = html.replace(/^## (.+)$/gm, "<h2>$1</h2>");
  html = html.replace(/^# (.+)$/gm, "<h1>$1</h1>");
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/`(.+?)`/g, "<code>$1</code>");
  html = html.replace(/^[-*] (.+)$/gm, "<li>$1</li>");
  html = html.replace(/(<li>.*<\/li>\n?)+/g, (m) => `<ul>${m}</ul>`);
  html = html.replace(/^\d+\. (.+)$/gm, "<li>$1</li>");
  html = html.replace(/\n{2,}/g, "<br/><br/>");
  html = html.replace(/\n/g, "<br/>");
  return html;
}

async function callAI() {
  const instruction = $("#ai-instruction")?.value?.trim() || "优化步骤并补充注意事项";
  const tpl = getTemplate(protoState.templateId) || TEMPLATES[0];
  const protocolText = $("#protocol-doc")?.innerText || "";

  protoState.aiLoading = true;
  protoState.aiError = null;
  renderAIBody();

  try {
    const res = await fetch("/functions/v1/app/protocol/enhance", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        topic: `${tpl.name}实验`,
        draft: (protocolText + "\n\n用户补充要求：" + instruction).slice(0, 8000),
      }),
    });
    const ctype = res.headers.get("content-type") || "";
    if (!ctype.includes("application/json")) {
      // Static hosting (GitHub Pages) answers with an HTML 404 — no backend here.
      protoState.aiError =
        "AI 优化依赖后端接口，当前静态托管（GitHub Pages）不提供该服务。模板生成的 Protocol 仍可正常使用、打印与导出。";
    } else {
      const data = await res.json();
      if (!res.ok || !data.ok) {
        protoState.aiError = data.message || data.error || `请求失败 (HTTP ${res.status})`;
      } else if (data.ai === false) {
        protoState.aiError = data.note || "AI 服务暂不可用。";
      } else {
        protoState.aiResult = data.text || data.content || "（AI 未返回内容）";
      }
    }
  } catch (e) {
    protoState.aiError = `网络错误：${e.message}`;
  } finally {
    protoState.aiLoading = false;
    renderAIBody();
  }
}

// ── TOOLS VIEW (PDF/MD Conversion) ─────────────────────────────────
function renderTools(container) {
  container.innerHTML = `
    <div class="page-head">
      <h1>小工具</h1>
      <p>实用的文档格式转换工具，全部在浏览器本地运行，无需上传服务器。</p>
    </div>
    <div class="tools-grid">
      <div class="card tool-card" id="tool-pdf2md">
        <div class="tool-header">
          <span class="tool-icon" style="background:#fdeaee;color:#b3384d">📄</span>
          <div><h3>PDF → Markdown</h3><p>提取 PDF 文本内容，转换为 Markdown 格式</p></div>
        </div>
        <div class="tool-body">
          <div class="file-drop" id="pdf-drop">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M12 18v-6"/><path d="m9 15 3-3 3 3"/></svg>
            <p>拖放 PDF 文件到此处，或点击选择</p>
            <input type="file" id="pdf-input" accept=".pdf" hidden />
          </div>
          <div id="pdf-status" class="tool-status"></div>
          <div class="tool-output" id="pdf-output" hidden>
            <div class="tool-output-head">
              <span>转换结果 (Markdown)</span>
              <div style="display:flex;gap:6px">
                <button class="btn btn-sm" id="pdf-copy">复制</button>
                <button class="btn btn-sm" id="pdf-download">下载 .md</button>
              </div>
            </div>
            <textarea class="textarea tool-textarea" id="pdf-md" rows="14" readonly></textarea>
          </div>
        </div>
      </div>

      <div class="card tool-card" id="tool-md2pdf">
        <div class="tool-header">
          <span class="tool-icon" style="background:#e6f4f1;color:#0d7d6c">📝</span>
          <div><h3>Markdown → PDF</h3><p>将 Markdown 文本渲染为可打印的 PDF 文档</p></div>
        </div>
        <div class="tool-body">
          <textarea class="textarea tool-textarea" id="md-input" rows="10" placeholder="在此粘贴或输入 Markdown 内容…&#10;&#10;# 标题&#10;## 二级标题&#10;- 列表项&#10;**粗体** 和 *斜体*"></textarea>
          <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">
            <button class="btn" id="md-preview-btn">预览</button>
            <button class="btn btn-primary" id="md-pdf-btn">导出 PDF</button>
            <button class="btn" id="md-file-btn">从文件加载</button>
            <input type="file" id="md-file-input" accept=".md,.markdown,.txt" hidden />
          </div>
          <div class="tool-output" id="md-preview" hidden>
            <div class="tool-output-head"><span>预览</span></div>
            <div class="md-rendered" id="md-rendered"></div>
          </div>
        </div>
      </div>
    </div>
  `;

  // PDF → MD
  const pdfDrop = $("#pdf-drop");
  const pdfInput = $("#pdf-input");
  pdfDrop.addEventListener("click", () => pdfInput.click());
  pdfDrop.addEventListener("dragover", (e) => { e.preventDefault(); pdfDrop.classList.add("dragover"); });
  pdfDrop.addEventListener("dragleave", () => pdfDrop.classList.remove("dragover"));
  pdfDrop.addEventListener("drop", (e) => { e.preventDefault(); pdfDrop.classList.remove("dragover"); if (e.dataTransfer.files[0]) handlePdf(e.dataTransfer.files[0]); });
  pdfInput.addEventListener("change", () => { if (pdfInput.files[0]) handlePdf(pdfInput.files[0]); });

  // MD → PDF
  $("#md-preview-btn").addEventListener("click", previewMd);
  $("#md-pdf-btn").addEventListener("click", exportMdPdf);
  $("#md-file-btn").addEventListener("click", () => $("#md-file-input").click());
  $("#md-file-input").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => { $("#md-input").value = reader.result; previewMd(); };
    reader.readAsText(file);
  });
  $("#md-copy")?.addEventListener("click", () => {
    navigator.clipboard.writeText($("#pdf-md").value);
    $("#md-copy").textContent = "已复制 ✓";
    setTimeout(() => { $("#md-copy").textContent = "复制"; }, 1500);
  });
  $("#pdf-download")?.addEventListener("click", () => {
    const blob = new Blob([$("#pdf-md").value], { type: "text/markdown" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "converted.md";
    a.click();
    URL.revokeObjectURL(a.href);
  });
}

async function handlePdf(file) {
  const status = $("#pdf-status");
  status.innerHTML = `<span class="spinner" style="width:14px;height:14px;border-width:2px"></span> 正在解析 ${esc(file.name)}…`;
  $("#pdf-output").hidden = true;

  try {
    // Load pdf.js from CDN
    if (!window.pdfjsLib) {
      await loadScript("https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.min.mjs");
      const pdfjs = await import("https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.min.mjs");
      pdfjs.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.worker.min.mjs";
      window.pdfjsLib = pdfjs;
    }

    const arrayBuffer = await file.arrayBuffer();
    const pdf = await window.pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    let md = `# ${file.name.replace(/\.pdf$/i, "")}\n\n`;
    md += `> 来源：${file.name} · ${pdf.numPages} 页 · 转换时间：${new Date().toLocaleString("zh-CN")}\n\n---\n\n`;

    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      const text = content.items.map((item) => item.str).join(" ");
      // Basic structure detection
      const lines = text.split(/\n|(?<=[.。])\s+/).filter((l) => l.trim());
      md += `## 第 ${i} 页\n\n`;
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        // Detect headings (short lines, possibly numbered)
        if (trimmed.length < 60 && (/^\d+[\.\、]/.test(trimmed) || /^[A-Z\u4e00-\u9fff]/.test(trimmed) && !trimmed.endsWith("。") && !trimmed.endsWith("."))) {
          md += `### ${trimmed}\n\n`;
        } else {
          md += `${trimmed}\n\n`;
        }
      }
      status.innerHTML = `<span class="spinner" style="width:14px;height:14px;border-width:2px"></span> 解析中… 第 ${i}/${pdf.numPages} 页`;
    }

    $("#pdf-md").value = md;
    $("#pdf-output").hidden = false;
    status.innerHTML = `<span style="color:var(--accent)">✓ 转换完成，共 ${pdf.numPages} 页</span>`;
  } catch (e) {
    status.innerHTML = `<span style="color:var(--rose)">✗ 解析失败：${esc(e.message)}</span>`;
  }
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
    const s = document.createElement("script");
    s.src = src;
    s.type = "module";
    s.onload = resolve;
    s.onerror = reject;
    document.head.appendChild(s);
  });
}

function mdToHtml(md) {
  let html = esc(md);
  html = html.replace(/^### (.+)$/gm, "<h3>$1</h3>");
  html = html.replace(/^## (.+)$/gm, "<h2>$1</h2>");
  html = html.replace(/^# (.+)$/gm, "<h1>$1</h1>");
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\*(.+?)\*/g, "<em>$1</em>");
  html = html.replace(/`(.+?)`/g, "<code>$1</code>");
  html = html.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');
  html = html.replace(/^---$/gm, "<hr/>");
  html = html.replace(/^[-*] (.+)$/gm, "<li>$1</li>");
  html = html.replace(/(<li>.*<\/li>\n?)+/g, (m) => `<ul>${m}</ul>`);
  html = html.replace(/^\d+\. (.+)$/gm, "<li>$1</li>");
  html = html.replace(/\n{2,}/g, "</p><p>");
  html = `<p>${html}</p>`;
  html = html.replace(/<p><\/p>/g, "");
  html = html.replace(/<p>(<h[1-3]>)/g, "$1").replace(/(<\/h[1-3]>)<\/p>/g, "$1");
  html = html.replace(/<p>(<ul>)/g, "$1").replace(/(<\/ul>)<\/p>/g, "$1");
  html = html.replace(/<p>(<hr\/>)<\/p>/g, "$1");
  html = html.replace(/<p>(<blockquote>)/g, "$1").replace(/(<\/blockquote>)<\/p>/g, "$1");
  return html;
}

function previewMd() {
  const md = $("#md-input").value;
  if (!md.trim()) return;
  $("#md-rendered").innerHTML = mdToHtml(md);
  $("#md-preview").hidden = false;
}

function exportMdPdf() {
  const md = $("#md-input").value;
  if (!md.trim()) { alert("请先输入 Markdown 内容"); return; }
  previewMd();
  // Open print dialog with rendered content
  const win = window.open("", "_blank");
  win.document.write(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Markdown Export</title>
    <style>body{font-family:Inter,"PingFang SC","Microsoft YaHei",sans-serif;max-width:800px;margin:40px auto;padding:0 20px;line-height:1.7;color:#1a1a1a;font-size:14px}
    h1{font-size:22px;border-bottom:2px solid #0d7d6c;padding-bottom:8px}h2{font-size:17px;color:#0d7d6c;margin-top:24px}h3{font-size:15px}
    code{background:#f3f4f6;padding:2px 5px;border-radius:3px;font-size:13px}blockquote{border-left:3px solid #0d7d6c;padding-left:12px;color:#555;margin-left:0}
    ul,ol{padding-left:24px}li{margin-bottom:4px}hr{border:none;border-top:1px solid #e5e7eb;margin:20px 0}</style>
    </head><body>${mdToHtml(md)}</body></html>`);
  win.document.close();
  setTimeout(() => win.print(), 300);
}

// ── ENGLISH LEARNING VIEW ─────────────────────────────────
const VOCAB = [
  { en: "pharmacokinetics", zh: "药代动力学", def: "The study of how drugs move through the body (ADME)", example: "The pharmacokinetics of the new antibody showed a half-life of 21 days." },
  { en: "pharmacodynamics", zh: "药效学", def: "The study of drug effects on the body", example: "Pharmacodynamics data revealed dose-dependent receptor occupancy." },
  { en: "bioavailability", zh: "生物利用度", def: "The fraction of a drug that reaches systemic circulation", example: "Oral bioavailability was only 12% due to first-pass metabolism." },
  { en: "monoclonal antibody", zh: "单克隆抗体", def: "An antibody derived from a single B-cell clone", example: "The monoclonal antibody targets PD-L1 on tumor cells." },
  { en: "polymerase chain reaction", zh: "聚合酶链式反应", def: "A technique to amplify specific DNA segments", example: "Quantitative PCR confirmed a 5-fold increase in gene expression." },
  { en: "western blot", zh: "蛋白质免疫印迹", def: "A technique to detect specific proteins in a sample", example: "Western blot analysis showed reduced p53 expression in treated cells." },
  { en: "flow cytometry", zh: "流式细胞术", def: "A technique for analyzing cell populations", example: "Flow cytometry revealed 40% apoptosis in the treatment group." },
  { en: "immunohistochemistry", zh: "免疫组化", def: "Staining tissue sections with antibodies to localize proteins", example: "Immunohistochemistry confirmed HER2 overexpression in the tumor." },
  { en: "electrophoresis", zh: "电泳", def: "Separation of molecules by charge and size in a gel", example: "Agarose gel electrophoresis showed a single band at 500 bp." },
  { en: "centrifugation", zh: "离心", def: "Separating components by density using centrifugal force", example: "After centrifugation at 12,000 rpm, the pellet contained the DNA." },
  { en: "transfection", zh: "转染", def: "Introducing nucleic acids into eukaryotic cells", example: "Lipofectamine-mediated transfection achieved 70% efficiency." },
  { en: "apoptosis", zh: "细胞凋亡", def: "Programmed cell death", example: "The drug induced apoptosis via the caspase-3 pathway." },
  { en: "proliferation", zh: "增殖", def: "Rapid cell division and growth", example: "Cell proliferation was inhibited by 60% at 10 μM." },
  { en: "differentiation", zh: "分化", def: "Cells becoming specialized in structure and function", example: "Stem cell differentiation into cardiomyocytes was confirmed by cTnT staining." },
  { en: "aliquot", zh: "等分试样", def: "A portion of a total volume", example: "Store aliquots at -80°C to avoid repeated freeze-thaw cycles." },
  { en: "supernatant", zh: "上清液", def: "The liquid above a pellet after centrifugation", example: "Collect the supernatant carefully without disturbing the pellet." },
  { en: "precipitate", zh: "沉淀", def: "A solid that forms from a solution", example: "DNA precipitate appeared after adding isopropanol." },
  { en: "buffer", zh: "缓冲液", def: "A solution that resists pH change", example: "Resuspend the pellet in TE buffer (pH 8.0)." },
  { en: "assay", zh: "测定/分析", def: "A procedure to measure a substance or activity", example: "The ELISA assay detected IL-6 at 15 pg/mL." },
  { en: "in vitro / in vivo", zh: "体外 / 体内", def: "In glass (lab) / in living organism", example: "In vitro results were validated in vivo using a mouse xenograft model." },
  { en: "clinical trial", zh: "临床试验", def: "Research studies testing interventions in humans", example: "The Phase III clinical trial met its primary endpoint." },
  { en: "placebo", zh: "安慰剂", def: "An inactive substance used as a control", example: "Patients received either the drug or a placebo." },
  { en: "endpoint", zh: "终点指标", def: "The outcome measure in a clinical trial", example: "Progression-free survival was the primary endpoint." },
  { en: "biomarker", zh: "生物标志物", def: "A measurable indicator of a biological state", example: "CA-125 is a biomarker for ovarian cancer." },
  { en: "formulation", zh: "制剂/配方", def: "The process of preparing a drug in its final form", example: "The lipid nanoparticle formulation improved mRNA stability." },
];

const engState = { mode: "flashcard", idx: 0, revealed: false, known: new Set(), quizScore: 0, quizTotal: 0 };

function renderEnglish(container) {
  container.innerHTML = `
    <div class="page-head">
      <h1>生物医药英语学习</h1>
      <p>掌握生物医药领域核心英文术语，提升文献阅读与学术写作能力。</p>
    </div>
    <div class="eng-tabs">
      <button class="chip ${engState.mode === "flashcard" ? "active" : ""}" data-mode="flashcard">词汇卡片</button>
      <button class="chip ${engState.mode === "quiz" ? "active" : ""}" data-mode="quiz">测验模式</button>
      <button class="chip ${engState.mode === "list" ? "active" : ""}" data-mode="list">术语表</button>
      <button class="chip ${engState.mode === "reading" ? "active" : ""}" data-mode="reading">新闻精读</button>
    </div>
    <div id="eng-content"></div>
  `;

  container.querySelector(".eng-tabs").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-mode]");
    if (!btn) return;
    engState.mode = btn.dataset.mode;
    $$(".eng-tabs .chip", container).forEach((c) => c.classList.toggle("active", c.dataset.mode === engState.mode));
    renderEngContent();
  });

  renderEngContent();
}

function renderEngContent() {
  const el = $("#eng-content");
  if (!el) return;
  switch (engState.mode) {
    case "flashcard": renderFlashcard(el); break;
    case "quiz": renderQuiz(el); break;
    case "list": renderVocabList(el); break;
    case "reading": renderReading(el); break;
  }
}

function renderFlashcard(el) {
  const word = VOCAB[engState.idx % VOCAB.length];
  el.innerHTML = `
    <div class="flashcard-container">
      <div class="flashcard ${engState.revealed ? "revealed" : ""}" id="flashcard">
        <div class="fc-front">
          <div class="fc-word">${esc(word.en)}</div>
          <div class="fc-hint">点击卡片查看释义</div>
        </div>
        <div class="fc-back">
          <div class="fc-zh">${esc(word.zh)}</div>
          <div class="fc-def">${esc(word.def)}</div>
          <div class="fc-example"><em>Example:</em> ${esc(word.example)}</div>
        </div>
      </div>
      <div class="fc-controls">
        <button class="btn" id="fc-prev">← 上一个</button>
        <span class="fc-counter">${(engState.idx % VOCAB.length) + 1} / ${VOCAB.length}</span>
        <button class="btn" id="fc-next">下一个 →</button>
      </div>
      <div class="fc-actions">
        <button class="btn btn-sm ${engState.known.has(word.en) ? "btn-primary" : ""}" id="fc-known">
          ${engState.known.has(word.en) ? "✓ 已掌握" : "标记为已掌握"}
        </button>
        <button class="btn btn-sm" id="fc-shuffle">随机打乱</button>
      </div>
    </div>
  `;

  $("#flashcard").addEventListener("click", () => { engState.revealed = !engState.revealed; renderEngContent(); });
  $("#fc-prev").addEventListener("click", () => { engState.idx = (engState.idx - 1 + VOCAB.length) % VOCAB.length; engState.revealed = false; renderEngContent(); });
  $("#fc-next").addEventListener("click", () => { engState.idx = (engState.idx + 1) % VOCAB.length; engState.revealed = false; renderEngContent(); });
  $("#fc-known").addEventListener("click", () => {
    if (engState.known.has(word.en)) engState.known.delete(word.en);
    else engState.known.add(word.en);
    renderEngContent();
  });
  $("#fc-shuffle").addEventListener("click", () => { engState.idx = Math.floor(Math.random() * VOCAB.length); engState.revealed = false; renderEngContent(); });
}

let quizData = null;
function renderQuiz(el) {
  if (!quizData || quizData.done) {
    // Generate quiz: 10 random questions
    const shuffled = [...VOCAB].sort(() => Math.random() - 0.5).slice(0, 10);
    quizData = { questions: shuffled.map((w) => {
      const wrongOptions = VOCAB.filter((v) => v.en !== w.en).sort(() => Math.random() - 0.5).slice(0, 3);
      const options = [w, ...wrongOptions].sort(() => Math.random() - 0.5);
      return { word: w, options, type: Math.random() > 0.5 ? "en2zh" : "zh2en" };
    }), current: 0, score: 0, done: false };
  }

  const q = quizData.questions[quizData.current];
  if (!q) { quizData.done = true; renderQuiz(el); return; }

  el.innerHTML = `
    <div class="quiz-container">
      <div class="quiz-progress">
        <div class="quiz-bar"><div class="quiz-bar-fill" style="width:${(quizData.current / quizData.questions.length) * 100}%"></div></div>
        <span>${quizData.current + 1} / ${quizData.questions.length} · 得分 ${quizData.score}</span>
      </div>
      <div class="quiz-question">
        <span class="quiz-type-badge">${q.type === "en2zh" ? "英 → 中" : "中 → 英"}</span>
        <div class="quiz-word">${q.type === "en2zh" ? esc(q.word.en) : esc(q.word.zh)}</div>
      </div>
      <div class="quiz-options" id="quiz-options">
        ${q.options.map((o, i) => `
          <button class="quiz-option" data-idx="${i}">
            ${q.type === "en2zh" ? esc(o.zh) : esc(o.en)}
          </button>
        `).join("")}
      </div>
      <div id="quiz-feedback"></div>
    </div>
  `;

  $("#quiz-options").addEventListener("click", (e) => {
    const btn = e.target.closest(".quiz-option");
    if (!btn || btn.disabled) return;
    const idx = Number(btn.dataset.idx);
    const correct = q.options[idx] === q.word;
    $$(".quiz-option").forEach((b, i) => {
      b.disabled = true;
      if (q.options[i] === q.word) b.classList.add("correct");
      else if (i === idx && !correct) b.classList.add("wrong");
    });
    if (correct) quizData.score++;
    $("#quiz-feedback").innerHTML = `
      <div class="quiz-fb ${correct ? "fb-correct" : "fb-wrong"}">
        ${correct ? "✓ 正确！" : `✗ 错误。正确答案：<strong>${q.type === "en2zh" ? esc(q.word.zh) : esc(q.word.en)}</strong>`}
        <div class="quiz-fb-detail">${esc(q.word.def)}<br/><em>${esc(q.word.example)}</em></div>
        <button class="btn btn-primary btn-sm" id="quiz-next" style="margin-top:8px">${quizData.current < quizData.questions.length - 1 ? "下一题 →" : "查看结果"}</button>
      </div>`;
    $("#quiz-next").addEventListener("click", () => {
      quizData.current++;
      if (quizData.current >= quizData.questions.length) {
        quizData.done = true;
        el.innerHTML = `
          <div class="quiz-result">
            <div class="quiz-score">${quizData.score} / ${quizData.questions.length}</div>
            <p>${quizData.score >= 8 ? "太棒了！术语掌握得很扎实。" : quizData.score >= 5 ? "不错，继续加油！" : "建议多复习词汇卡片再来挑战。"}</p>
            <button class="btn btn-primary" id="quiz-restart">重新开始</button>
          </div>`;
        $("#quiz-restart").addEventListener("click", () => { quizData = null; renderEngContent(); });
      } else {
        renderEngContent();
      }
    });
  });
}

function renderVocabList(el) {
  el.innerHTML = `
    <div class="card" style="padding:18px;margin-top:14px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <h3 style="font-size:14px">生物医药核心术语 (${VOCAB.length} 词)</h3>
        <span style="font-size:12px;color:var(--text-3)">已掌握：${engState.known.size} / ${VOCAB.length}</span>
      </div>
      <div class="vocab-table">
        <div class="vocab-head"><span>英文术语</span><span>中文释义</span><span>英文定义</span></div>
        ${VOCAB.map((w) => `
          <div class="vocab-row ${engState.known.has(w.en) ? "vocab-known" : ""}">
            <span class="vocab-en">${esc(w.en)}${engState.known.has(w.en) ? " ✓" : ""}</span>
            <span class="vocab-zh">${esc(w.zh)}</span>
            <span class="vocab-def">${esc(w.def)}</span>
          </div>
        `).join("")}
      </div>
    </div>
  `;
}

function renderReading(el) {
  const enItems = newsState.items.filter((i) => i.lang === "en").slice(0, 5);
  if (enItems.length === 0) {
    el.innerHTML = `
      <div class="state" style="margin-top:20px">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>
        <div class="state-title">暂无新闻数据</div>
        <div class="state-desc">请先访问"行业新闻"页面加载资讯，然后回到此处进行精读练习。</div>
        <a href="#/news" class="btn btn-primary">去加载新闻</a>
      </div>`;
    return;
  }

  el.innerHTML = `
    <div style="margin-top:14px">
      <p style="font-size:13px;color:var(--text-2);margin-bottom:14px">选择一条英文新闻进行精读。生词会自动高亮，点击可查看释义。</p>
      <div class="reading-list">
        ${enItems.map((item, i) => `
          <button class="reading-item" data-idx="${i}">
            <span class="source-badge">${esc(item.source)}</span>
            <span class="reading-title">${esc(item.title)}</span>
          </button>
        `).join("")}
      </div>
      <div id="reading-detail"></div>
    </div>
  `;

  el.querySelector(".reading-list").addEventListener("click", (e) => {
    const btn = e.target.closest(".reading-item");
    if (!btn) return;
    const item = enItems[Number(btn.dataset.idx)];
    showReadingDetail(item);
  });
}

function showReadingDetail(item) {
  const detail = $("#reading-detail");
  if (!detail) return;

  // Highlight vocabulary words in the text
  const text = `${item.title}. ${item.summary || ""}`;
  const vocabWords = VOCAB.map((v) => v.en.toLowerCase());
  let highlighted = esc(text);

  // Highlight known bio terms
  const bioTerms = /\b(pharmacokinetics|pharmacodynamics|bioavailability|monoclonal antibody|polymerase chain reaction|western blot|flow cytometry|immunohistochemistry|electrophoresis|centrifugation|transfection|apoptosis|proliferation|differentiation|aliquot|supernatant|precipitate|buffer|assay|in vitro|in vivo|clinical trial|placebo|endpoint|biomarker|formulation|antibody|receptor|inhibitor|agonist|antagonist|dosage|efficacy|toxicity|metabolism|excretion|absorption|distribution|half-life|bioequivalence|generic drug|biologic|small molecule|target|indication|contraindication|adverse event|protocol|placebo-controlled|randomized|double-blind|cohort|randomization|stratification|enrollment|screening|baseline|follow-up|outcome|statistically significant|p-value|confidence interval|hazard ratio|odds ratio|relative risk|number needed to treat|intention-to-treat|per-protocol|interim analysis|data monitoring|regulatory|approval|submission|filing|fast track|breakthrough therapy|orphan drug|priority review|accelerated approval|Phase I|Phase II|Phase III|Phase IV|preclinical|IND|NDA|BLA|CTA|GMP|GLP|GCP|ICH|FDA|EMA|NMPA)\b/gi;

  highlighted = highlighted.replace(bioTerms, (match) => {
    const vocab = VOCAB.find((v) => v.en.toLowerCase() === match.toLowerCase());
    if (vocab) return `<mark class="term-mark" data-term="${esc(vocab.en)}" title="${esc(vocab.zh)}: ${esc(vocab.def)}">${match}</mark>`;
    return `<mark class="term-mark-2" title="生物医药术语">${match}</mark>`;
  });

  detail.innerHTML = `
    <div class="card reading-card" style="margin-top:14px;padding:20px">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;margin-bottom:12px">
        <div>
          <span class="source-badge">${esc(item.source)}</span>
          <span class="cat-badge cat-${esc(item.category)}" style="margin-left:6px">${esc(item.category)}</span>
        </div>
        <a href="${esc(item.link)}" target="_blank" rel="noopener" class="btn btn-sm">阅读原文 ↗</a>
      </div>
      <h3 style="font-size:16px;margin-bottom:10px;line-height:1.4">${esc(item.title)}</h3>
      ${(item.titleZh || newsState.translations[item.title]) ? `<p style="font-size:13px;color:var(--accent);margin-bottom:10px">${esc(item.titleZh || newsState.translations[item.title])}</p>` : ""}
      <div class="reading-text">${highlighted}</div>
      <div style="margin-top:14px;padding-top:12px;border-top:1px solid var(--border)">
        <p style="font-size:12px;color:var(--text-3);margin-bottom:8px">💡 高亮词汇为生物医药核心术语，鼠标悬停查看释义。点击可加入生词本。</p>
        <div id="reading-word-detail"></div>
      </div>
    </div>
  `;

  detail.addEventListener("click", (e) => {
    const mark = e.target.closest(".term-mark");
    if (!mark) return;
    const term = mark.dataset.term;
    const vocab = VOCAB.find((v) => v.en.toLowerCase() === term.toLowerCase());
    if (vocab) {
      $("#reading-word-detail").innerHTML = `
        <div class="word-detail-card">
          <strong>${esc(vocab.en)}</strong> — ${esc(vocab.zh)}
          <p>${esc(vocab.def)}</p>
          <p style="color:var(--text-3);font-style:italic">${esc(vocab.example)}</p>
        </div>`;
    }
  });
}

// ── ABOUT VIEW ─────────────────────────────────
function renderAbout(container) {
  container.innerHTML = `
    <div class="page-head">
      <h1>关于 BioPharma Hub</h1>
      <p>面向生物医药专业学生与科研人员的资讯聚合、实验设计与学习辅助平台。</p>
    </div>
    <div class="about-grid">
      <div class="about-card card">
        <h3><span class="about-icon" style="background:var(--accent-soft);color:var(--accent)">📰</span> 实时新闻聚合</h3>
        <p>通过 RSS 实时抓取全球 8 个生物医药权威信源，按研发、审批、市场、技术分类。英文标题自动翻译为中文，双语对照显示。</p>
      </div>
      <div class="about-card card">
        <h3><span class="about-icon" style="background:var(--violet-soft);color:var(--violet)">🧪</span> Protocol 辅助设计</h3>
        <p>内置 6 种常用实验模板，填写参数即可生成结构化 Protocol（含试剂表、步骤、注意事项），支持打印导出和 AI 智能优化。</p>
      </div>
      <div class="about-card card">
        <h3><span class="about-icon" style="background:var(--amber-soft);color:var(--amber)">🔧</span> 文档工具</h3>
        <p>PDF → Markdown 转换（基于 pdf.js 本地解析）和 Markdown → PDF 导出，全部在浏览器端完成，无需上传。</p>
      </div>
      <div class="about-card card">
        <h3><span class="about-icon" style="background:#e8f1fa;color:#2563a8">📖</span> 英语学习</h3>
        <p>生物医药核心术语词汇卡片、选择题测验、术语速查表，以及基于实时新闻的精读练习（自动高亮专业词汇）。</p>
      </div>
    </div>
    <p style="margin-top:24px;font-size:12px;color:var(--text-3);text-align:center">
      BioPharma Hub · 为生物医药学习者构建 · 中国药科大学生物技术
    </p>
  `;
}

// ── Init ─────────────────────────────────
navigate();
