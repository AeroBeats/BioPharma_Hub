// admin-views.js — 超级管理员后台：概览、邀请码、用户管理、组织总览
import { authState, api, isSuperAdmin } from "./auth.js";
import { promptPassword, promptInput, confirmDialog, toast } from "./ui.js";

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

function esc(s) {
  const d = document.createElement("div");
  d.textContent = s ?? "";
  return d.innerHTML;
}
function go(hash) {
  if (location.hash === hash) window.dispatchEvent(new HashChangeEvent("hashchange"));
  else location.hash = hash;
}

export function renderAdmin(container) {
  if (!authState.user) { go("#/login"); return; }
  if (!isSuperAdmin()) {
    container.innerHTML = `<div class="page-head"><h1 class="page-title">管理后台</h1></div>
      <div class="card"><div class="state">仅超级管理员可访问此页面。</div></div>`;
    return;
  }
  container.innerHTML = `
    <div class="page-head">
      <h1 class="page-title">管理后台</h1>
      <p class="page-desc">超级管理员：发放组织邀请码、管理用户与组织。所有敏感操作需电子签名并留痕。</p>
    </div>
    <div id="admin-body"><div class="state">加载中…</div></div>`;
  renderAdminBody(container);
}

async function renderAdminBody(container) {
  const [statsRes, codesRes, usersRes, orgsRes] = await Promise.all([
    api("/api/admin/stats"),
    api("/api/admin/invite-codes"),
    api("/api/admin/users"),
    api("/api/admin/orgs"),
  ]);
  const stats = statsRes.ok ? statsRes : { users: 0, orgs: 0, inventoryItems: 0 };
  const codes = codesRes.ok ? codesRes.codes : [];
  const users = usersRes.ok ? usersRes.users : [];
  const orgs = orgsRes.ok ? orgsRes.orgs : [];
  const body = $("#admin-body", container);

  body.innerHTML = `
    <div class="admin-stats">
      <div class="card stat-card"><div class="stat-num">${stats.users}</div><div class="stat-label">用户</div></div>
      <div class="card stat-card"><div class="stat-num">${stats.orgs}</div><div class="stat-label">组织</div></div>
      <div class="card stat-card"><div class="stat-num">${stats.inventoryItems}</div><div class="stat-label">库存条目</div></div>
      <div class="card stat-card"><div class="stat-num">${codes.filter((c) => c.active).length}</div><div class="stat-label">有效邀请码</div></div>
    </div>

    <div class="card">
      <h3 class="card-title">组织邀请码</h3>
      <p class="hint">用户凭邀请码创建组织并成为该组织管理员。可设使用次数与有效期。</p>
      <form id="invite-form" class="invite-form">
        <div class="field"><label>备注</label><input class="input" id="iv-note" placeholder="如：发给课题组张老师" maxlength="255" /></div>
        <div class="field"><label>可用次数</label><input class="input" id="iv-uses" type="number" min="1" max="1000" value="1" /></div>
        <div class="field"><label>有效天数</label><input class="input" id="iv-days" type="number" min="0" value="30" placeholder="0=永久" /></div>
        <button class="btn btn-primary" type="submit">生成邀请码</button>
      </form>
      <div class="table-wrap">
        <table class="inv-table">
          <thead><tr><th>邀请码</th><th>备注</th><th>使用</th><th>有效期</th><th>状态</th><th></th></tr></thead>
          <tbody>${codes.map((c) => `<tr>
            <td class="mono">${esc(c.code)}</td>
            <td class="hint">${esc(c.note || "—")}</td>
            <td class="hint">${c.useCount}/${c.maxUses}</td>
            <td class="hint">${c.expiresAt ? esc(c.expiresAt.slice(0, 10)) : "永久"}</td>
            <td>${c.active ? '<span class="inv-badge accent">有效</span>' : '<span class="inv-badge mute">失效</span>'}</td>
            <td><button class="btn btn-sm" data-copy-code="${esc(c.code)}">复制</button>
                <button class="btn btn-sm btn-ghost" data-revoke="${c.id}">吊销</button></td>
          </tr>`).join("") || `<tr><td colspan="6" class="state">还没有邀请码</td></tr>`}</tbody>
        </table>
      </div>
    </div>

    <div class="card">
      <h3 class="card-title">用户管理（${users.length}）</h3>
      <div class="field" style="max-width:280px"><input class="input" id="user-search" placeholder="搜索用户名/显示名…" /></div>
      <div class="table-wrap">
        <table class="inv-table">
          <thead><tr><th>用户</th><th>组织数</th><th>超级管理员</th><th>状态</th><th>操作</th></tr></thead>
          <tbody id="user-tbody">${userRows(users)}</tbody>
        </table>
      </div>
    </div>

    <div class="card">
      <h3 class="card-title">组织总览（${orgs.length}）</h3>
      <div class="table-wrap">
        <table class="inv-table">
          <thead><tr><th>组织</th><th>组织码</th><th>成员</th><th>创建时间</th><th></th></tr></thead>
          <tbody>${orgs.map((o) => `<tr>
            <td>${esc(o.name)}</td>
            <td class="mono">${esc(o.orgCode)}</td>
            <td class="hint">${o.memberCount}</td>
            <td class="hint">${esc((o.createdAt || "").slice(0, 10))}</td>
            <td><button class="btn btn-sm btn-ghost" data-del-org="${o.id}" data-name="${esc(o.name)}">删除</button></td>
          </tr>`).join("") || `<tr><td colspan="5" class="state">还没有组织</td></tr>`}</tbody>
        </table>
      </div>
    </div>`;

  // invite code generate
  $("#invite-form", body).addEventListener("submit", async (e) => {
    e.preventDefault();
    const note = $("#iv-note", body).value.trim();
    const maxUses = Number($("#iv-uses", body).value) || 1;
    const expiresInDays = Number($("#iv-days", body).value) || 0;
    const res = await api("/api/admin/invite-codes", { method: "POST", body: { note, maxUses, expiresInDays } });
    if (res.ok) { toast(`邀请码已生成：${res.code.code}`, "ok", 4000); renderAdminBody(container); }
    else toast(res.error || "生成失败", "error");
  });
  $$("[data-copy-code]", body).forEach((b) => b.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(b.dataset.copyCode); toast("已复制", "ok"); } catch { toast("复制失败", "error"); }
  }));
  $$("[data-revoke]", body).forEach((b) => b.addEventListener("click", async () => {
    const ok = await confirmDialog({ title: "吊销邀请码", message: "吊销后该邀请码不可再用于创建组织。", confirmLabel: "吊销", danger: true });
    if (!ok) return;
    const res = await api(`/api/admin/invite-codes/${b.dataset.revoke}`, { method: "DELETE" });
    if (res.ok) { toast("已吊销", "ok"); renderAdminBody(container); } else toast(res.error || "失败", "error");
  }));

  // user search
  $("#user-search", body).addEventListener("input", (e) => {
    const q = e.target.value.trim().toLowerCase();
    const filtered = users.filter((u) => (u.username + " " + (u.displayName || "")).toLowerCase().includes(q));
    $("#user-tbody", body).innerHTML = userRows(filtered);
    wireUserRows(body, container, users);
  });
  wireUserRows(body, container, users);

  // delete org
  $$("[data-del-org]", body).forEach((b) => b.addEventListener("click", async () => {
    const ok = await confirmDialog({ title: "删除组织", message: `将删除「${b.dataset.name}」及其成员关系与库存（软删除，审计留痕）。`, confirmLabel: "继续", danger: true });
    if (!ok) return;
    const pw = await promptPassword({ title: "电子签名确认", message: "删除组织需输入你的登录密码完成电子签名。", confirmLabel: "签名并删除" });
    if (pw === null) return;
    const res = await api(`/api/orgs/${b.dataset.delOrg}`, { method: "DELETE", body: { reason: "超级管理员删除", password: pw } });
    if (res.ok) { toast("组织已删除", "ok"); renderAdminBody(container); } else toast(res.error || "删除失败", "error");
  }));
}

function userRows(users) {
  return users.map((u) => `<tr data-user-row="${u.id}">
    <td>${esc(u.displayName || u.username)} <span class="hint">@${esc(u.username)}</span></td>
    <td class="hint">${u.orgCount}</td>
    <td><label class="switch"><input type="checkbox" data-sa="${u.id}" ${u.isSuperAdmin ? "checked" : ""} ${u.id === authState.user.id ? "disabled" : ""} /><span class="slider"></span></label></td>
    <td>${u.disabled ? '<span class="inv-badge rose">已禁用</span>' : '<span class="inv-badge accent">正常</span>'}</td>
    <td>
      <button class="btn btn-sm" data-toggle-disable="${u.id}" data-disabled="${u.disabled ? "1" : ""}" data-name="${esc(u.username)}" ${u.id === authState.user.id ? "disabled" : ""}>${u.disabled ? "启用" : "禁用"}</button>
      <button class="btn btn-sm" data-reset-pw="${u.id}" data-name="${esc(u.username)}">重置密码</button>
      <button class="btn btn-sm btn-ghost" data-del-user="${u.id}" data-name="${esc(u.username)}" ${u.id === authState.user.id ? "disabled" : ""}>删除</button>
    </td>
  </tr>`).join("") || `<tr><td colspan="5" class="state">无匹配用户</td></tr>`;
}

function wireUserRows(body, container, users) {
  const byId = (id) => users.find((u) => u.id === Number(id));

  $$("[data-sa]", body).forEach((cb) => cb.addEventListener("change", async () => {
    const id = cb.dataset.sa;
    const want = cb.checked;
    const pw = await promptPassword({ title: "电子签名确认", message: `将「${byId(id)?.username}」${want ? "设为" : "撤销"}超级管理员，请输入你的登录密码签名。`, confirmLabel: "签名并保存" });
    if (pw === null) { cb.checked = !want; return; }
    const res = await api(`/api/admin/users/${id}`, { method: "PATCH", body: { isSuperAdmin: want, password: pw } });
    if (res.ok) toast("已更新", "ok");
    else { toast(res.error || "失败", "error"); cb.checked = !want; }
  }));

  $$("[data-toggle-disable]", body).forEach((b) => b.addEventListener("click", async () => {
    const id = b.dataset.toggleDisable;
    const want = b.dataset.disabled !== "1"; // toggle to disabled=want
    const pw = await promptPassword({ title: "电子签名确认", message: `${want ? "禁用" : "启用"}用户「${b.dataset.name}」，请输入你的登录密码签名。`, confirmLabel: "签名并保存" });
    if (pw === null) return;
    const res = await api(`/api/admin/users/${id}`, { method: "PATCH", body: { disabled: want, password: pw } });
    if (res.ok) { toast(want ? "已禁用" : "已启用", "ok"); renderAdminBody(container); }
    else toast(res.error || "失败", "error");
  }));

  $$("[data-reset-pw]", body).forEach((b) => b.addEventListener("click", async () => {
    const id = b.dataset.resetPw;
    const np = await promptInput({ title: "重置密码", message: `为用户「${b.dataset.name}」设置新密码（至少 8 位）。`, label: "新密码", type: "password", confirmLabel: "重置" });
    if (np === null) return;
    if (np.length < 8) { toast("新密码至少 8 位", "error"); return; }
    const res = await api(`/api/admin/users/${id}/reset-password`, { method: "POST", body: { newPassword: np } });
    if (res.ok) toast("密码已重置", "ok"); else toast(res.error || "失败", "error");
  }));

  $$("[data-del-user]", body).forEach((b) => b.addEventListener("click", async () => {
    const id = b.dataset.delUser;
    const ok = await confirmDialog({ title: "删除用户", message: `将删除用户「${b.dataset.name}」及其组织成员关系（软删除，审计留痕）。`, confirmLabel: "继续", danger: true });
    if (!ok) return;
    const pw = await promptPassword({ title: "电子签名确认", message: "删除用户需输入你的登录密码完成电子签名。", confirmLabel: "签名并删除" });
    if (pw === null) return;
    const res = await api(`/api/admin/users/${id}`, { method: "DELETE", body: { reason: "超级管理员删除", password: pw } });
    if (res.ok) { toast("用户已删除", "ok"); renderAdminBody(container); } else toast(res.error || "删除失败", "error");
  }));
}
