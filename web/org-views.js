// org-views.js — 组织视图：我的组织、创建（邀请码）、加入（组织码）、成员管理、审计、删除
import {
  authState, api, setCurrentOrg, refreshOrgs, currentOrg, currentRole,
  canManageCurrentOrg, isSuperAdmin,
} from "./auth.js";
import { promptPassword, confirmDialog, toast } from "./ui.js";

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

const ROLE_LABEL = { org_admin: "组织管理员", qa: "质量审核(QA)", sd: "研究负责人(SD)", member: "普通用户" };
const ROLE_OPTIONS = ["org_admin", "sd", "qa", "member"];
const ACTION_LABEL = {
  "org.create": "创建组织", "org.update": "修改组织", "org.join": "加入组织", "org.leave": "退出组织",
  "org.delete": "删除组织", "org.regenerate_code": "重置组织码", "invite_code.use": "使用邀请码",
  "membership.create": "添加成员", "membership.update": "修改成员", "membership.remove": "移除成员",
  "inventory.create": "新增库存", "inventory.update": "修改库存", "inventory.delete": "删除库存",
  "inventory.bulk_import": "批量导入库存", "inventory.bulk_update": "批量修改库存", "inventory.bulk_delete": "批量删除库存",
};

export function renderOrg(container) {
  if (!authState.user) { go("#/login"); return; }
  container.innerHTML = `
    <div class="page-head">
      <h1 class="page-title">组织</h1>
      <p class="page-desc">创建或加入组织，管理成员与组织码。库存等实验数据按组织共享。</p>
    </div>
    <div id="org-body"><div class="state">加载中…</div></div>`;
  renderOrgBody(container);
}

async function renderOrgBody(container) {
  await refreshOrgs();
  const body = $("#org-body", container);
  const co = currentOrg();

  const orgCards = authState.orgs.map((entry) => {
    const o = entry.org;
    const isCurrent = o.id === authState.currentOrgId;
    return `
      <div class="org-card ${isCurrent ? "org-card-current" : ""}">
        <div class="org-card-main">
          <div class="org-card-name">${esc(o.name)}
            <span class="chip chip-role">${esc(ROLE_LABEL[entry.role] || entry.role)}</span>
            ${isCurrent ? '<span class="inv-badge accent">当前</span>' : ""}</div>
          <div class="hint">组织码 <span class="mono">${esc(o.orgCode)}</span>${o.memberCount != null ? ` · ${o.memberCount} 名成员` : ""}</div>
        </div>
        ${isCurrent ? "" : `<button class="btn btn-sm" data-switch="${o.id}">切换</button>`}
      </div>`;
  }).join("") || `<div class="state">你还没有加入任何组织。用下方邀请码创建组织，或用组织码加入。</div>`;

  body.innerHTML = `
    <div class="card">
      <h3 class="card-title">我的组织</h3>
      <div class="org-list">${orgCards}</div>
    </div>

    <div class="org-two-col">
      <div class="card">
        <h3 class="card-title">创建组织</h3>
        <p class="hint">需要超级管理员发放的<strong>组织邀请码</strong>。创建后你将成为该组织的管理员。</p>
        <form id="create-org-form" class="stack-form">
          <div class="field"><label>组织邀请码</label><input class="input mono" id="co-invite" placeholder="INV-XXXXXXXXXX" maxlength="32" /></div>
          <div class="field"><label>组织名称</label><input class="input" id="co-name" placeholder="如：分子生物学实验室" maxlength="160" /></div>
          <div class="field"><label>简介（可选）</label><textarea class="textarea" id="co-desc" rows="2" maxlength="500"></textarea></div>
          <button class="btn btn-primary" type="submit">创建组织</button>
        </form>
      </div>

      <div class="card">
        <h3 class="card-title">加入组织</h3>
        <p class="hint">输入组织管理员发给你的<strong>组织码</strong>即可加入。</p>
        <form id="join-org-form" class="stack-form">
          <div class="field"><label>组织码</label><input class="input mono" id="jo-code" placeholder="ORG-XXXXXXXXXX" maxlength="32" /></div>
          <div class="field"><label>我的职务（可选）</label><input class="input" id="jo-title" placeholder="如：技术员 / 研究生" maxlength="120" /></div>
          <button class="btn btn-primary" type="submit">加入组织</button>
        </form>
      </div>
    </div>

    <div id="org-manage"></div>`;

  $$("[data-switch]", body).forEach((b) => b.addEventListener("click", () => {
    setCurrentOrg(Number(b.dataset.switch));
    toast("已切换当前组织", "ok");
    renderOrg(container);
  }));

  $("#create-org-form", body).addEventListener("submit", async (e) => {
    e.preventDefault();
    const inviteCode = $("#co-invite", body).value.trim();
    const name = $("#co-name", body).value.trim();
    const description = $("#co-desc", body).value.trim();
    if (!inviteCode || name.length < 2) { toast("请填写邀请码与组织名称（≥2 字）", "error"); return; }
    const res = await api("/api/orgs", { method: "POST", body: { inviteCode, name, description } });
    if (res.ok) {
      setCurrentOrg(res.org.id);
      await refreshOrgs();
      toast("组织已创建，你是管理员", "ok");
      renderOrg(container);
    } else {
      toast(res.error === "network" ? (res.message || "无法连接服务器") : (res.error || "创建失败"), "error");
    }
  });

  $("#join-org-form", body).addEventListener("submit", async (e) => {
    e.preventDefault();
    const orgCode = $("#jo-code", body).value.trim();
    const title = $("#jo-title", body).value.trim();
    if (!orgCode) { toast("请填写组织码", "error"); return; }
    const res = await api("/api/orgs/join", { method: "POST", body: { orgCode, title } });
    if (res.ok) {
      setCurrentOrg(res.org.id);
      await refreshOrgs();
      toast("已加入组织", "ok");
      renderOrg(container);
    } else {
      toast(res.error === "network" ? (res.message || "无法连接服务器") : (res.error || "加入失败"), "error");
    }
  });

  if (co) renderOrgManage($("#org-manage", container), co.id, container);
}

async function renderOrgManage(el, orgId, container) {
  el.innerHTML = `<div class="card"><div class="state">加载组织详情…</div></div>`;
  const [detailRes, membersRes] = await Promise.all([
    api(`/api/orgs/${orgId}`),
    api(`/api/orgs/${orgId}/members`),
  ]);
  if (!detailRes.ok) { el.innerHTML = ""; return; }
  const org = detailRes.org;
  const role = detailRes.role;
  const canManage = detailRes.canManage;
  const members = membersRes.ok ? membersRes.members : [];

  const memberRows = members.map((m) => {
    const roleCell = canManage && m.userId !== authState.user.id
      ? `<select class="select select-sm" data-role-user="${m.userId}">
          ${ROLE_OPTIONS.map((r) => `<option value="${r}" ${r === m.role ? "selected" : ""}>${ROLE_LABEL[r]}</option>`).join("")}
        </select>`
      : `<span class="chip chip-role">${esc(ROLE_LABEL[m.role] || m.role)}</span>`;
    const removeCell = canManage && m.userId !== authState.user.id
      ? `<button class="btn btn-sm btn-ghost" data-remove-user="${m.userId}" data-name="${esc(m.username)}">移除</button>`
      : "";
    return `<tr>
      <td>${esc(m.displayName || m.username)}${m.isSuperAdmin ? ' <span class="chip chip-super">超管</span>' : ""}</td>
      <td class="hint">${esc(m.username)}</td>
      <td class="hint">${esc(m.title || "—")}</td>
      <td>${roleCell}</td>
      <td>${removeCell}</td>
    </tr>`;
  }).join("");

  el.innerHTML = `
    <div class="card">
      <div class="org-manage-head">
        <h3 class="card-title">${esc(org.name)}</h3>
        <span class="chip chip-role">${esc(ROLE_LABEL[role] || role)}</span>
        ${canManage ? `<button class="btn btn-sm btn-ghost" id="org-delete" style="margin-left:auto">删除组织</button>` : ""}
      </div>
      <div class="org-code-row">
        <span class="hint">组织码（发给成员加入）：</span>
        <span class="mono org-code" id="org-code-val">${esc(org.orgCode)}</span>
        <button class="btn btn-sm" id="org-code-copy">复制</button>
        ${canManage ? `<button class="btn btn-sm btn-ghost" id="org-code-regen">重置</button>` : ""}
      </div>
      ${canManage ? `
      <form id="org-edit-form" class="org-edit-form">
        <div class="field"><label>组织名称</label><input class="input" id="oe-name" value="${esc(org.name)}" maxlength="160" /></div>
        <div class="field"><label>简介</label><textarea class="textarea" id="oe-desc" rows="2" maxlength="500">${esc(org.description || "")}</textarea></div>
        <button class="btn btn-primary btn-sm" type="submit">保存修改</button>
      </form>` : ""}
    </div>

    <div class="card">
      <h3 class="card-title">成员（${members.length}）</h3>
      <div class="table-wrap">
        <table class="inv-table members-table">
          <thead><tr><th>显示名</th><th>用户名</th><th>职务</th><th>角色</th><th></th></tr></thead>
          <tbody>${memberRows || `<tr><td colspan="5" class="state">暂无成员</td></tr>`}</tbody>
        </table>
      </div>
    </div>

    ${(role === "org_admin" || role === "qa" || isSuperAdmin()) ? `
    <div class="card">
      <h3 class="card-title">审计追踪 <span class="hint">（GLP：追加式、不可改删）</span></h3>
      <div id="org-audit"><div class="state">加载中…</div></div>
    </div>` : ""}`;

  // wire members
  $$("[data-role-user]", el).forEach((sel) => sel.addEventListener("change", async () => {
    const userId = Number(sel.dataset.roleUser);
    const res = await api(`/api/orgs/${orgId}/members/${userId}`, { method: "PATCH", body: { role: sel.value } });
    if (res.ok) toast("成员角色已更新", "ok");
    else { toast(res.error || "更新失败", "error"); renderOrgManage(el, orgId, container); }
  }));
  $$("[data-remove-user]", el).forEach((btn) => btn.addEventListener("click", async () => {
    const userId = Number(btn.dataset.removeUser);
    const ok = await confirmDialog({ title: "移除成员", message: `确定将「${btn.dataset.name}」移出组织？`, confirmLabel: "移除", danger: true });
    if (!ok) return;
    const res = await api(`/api/orgs/${orgId}/members/${userId}`, { method: "DELETE", body: { reason: "管理员移除" } });
    if (res.ok) { toast("已移除成员", "ok"); renderOrgManage(el, orgId, container); }
    else toast(res.error || "移除失败", "error");
  }));

  // copy / regenerate org code
  $("#org-code-copy", el)?.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(org.orgCode); toast("组织码已复制", "ok"); }
    catch { toast("复制失败，请手动选择", "error"); }
  });
  $("#org-code-regen", el)?.addEventListener("click", async () => {
    const ok = await confirmDialog({ title: "重置组织码", message: "重置后旧组织码立即失效，成员需用新码加入。确定？", confirmLabel: "重置" });
    if (!ok) return;
    const res = await api(`/api/orgs/${orgId}/regenerate-code`, { method: "POST" });
    if (res.ok) { $("#org-code-val", el).textContent = res.orgCode; toast("组织码已重置", "ok"); await refreshOrgs(); }
    else toast(res.error || "重置失败", "error");
  });

  // edit org
  $("#org-edit-form", el)?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = $("#oe-name", el).value.trim();
    const description = $("#oe-desc", el).value.trim();
    if (name.length < 2) { toast("组织名称至少 2 个字符", "error"); return; }
    const res = await api(`/api/orgs/${orgId}`, { method: "PATCH", body: { name, description } });
    if (res.ok) { toast("已保存", "ok"); await refreshOrgs(); renderOrg(container); }
    else toast(res.error || "保存失败", "error");
  });

  // delete org (e-signature)
  $("#org-delete", el)?.addEventListener("click", async () => {
    const ok = await confirmDialog({ title: "删除组织", message: `将删除「${org.name}」及其成员关系与库存（软删除，审计留痕）。此操作需电子签名。`, confirmLabel: "继续删除", danger: true });
    if (!ok) return;
    const pw = await promptPassword({ title: "电子签名确认", message: "删除组织属敏感操作，请输入你的登录密码完成电子签名。", confirmLabel: "签名并删除" });
    if (pw === null) return;
    const res = await api(`/api/orgs/${orgId}`, { method: "DELETE", body: { reason: "管理员删除", password: pw } });
    if (res.ok) {
      toast("组织已删除", "ok");
      setCurrentOrg(null);
      await refreshOrgs();
      renderOrg(container);
    } else toast(res.error || "删除失败", "error");
  });

  // audit trail
  const auditEl = $("#org-audit", el);
  if (auditEl) {
    const res = await api(`/api/orgs/${orgId}/audit?limit=100`);
    if (res.ok && res.entries.length) {
      auditEl.innerHTML = `<div class="table-wrap"><table class="inv-table audit-table">
        <thead><tr><th>时间</th><th>操作人</th><th>动作</th><th>对象</th></tr></thead>
        <tbody>${res.entries.map((e) => `<tr>
          <td class="hint mono">${esc((e.createdAt || "").replace("T", " ").slice(0, 19))}</td>
          <td>${esc(e.actorName || "系统")}</td>
          <td>${esc(ACTION_LABEL[e.action] || e.action)}</td>
          <td class="hint">${esc(e.entityType)}${e.entityId ? "#" + esc(e.entityId) : ""}</td>
        </tr>`).join("")}</tbody></table></div>`;
    } else {
      auditEl.innerHTML = `<div class="state">暂无审计记录</div>`;
    }
  }
}
