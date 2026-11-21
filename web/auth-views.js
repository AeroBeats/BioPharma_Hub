// auth-views.js — 登录、注册、账号（个人中心）视图
import {
  authState, login, register, logout, api, setCurrentOrg, refreshOrgs,
  isSuperAdmin, currentOrg,
} from "./auth.js";

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

function esc(s) {
  const d = document.createElement("div");
  d.textContent = s ?? "";
  return d.innerHTML;
}

function go(hash) {
  if (location.hash === hash) {
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  } else {
    location.hash = hash;
  }
}

function afterAuthRedirect() {
  go(authState.orgs.length ? "#/news" : "#/org");
}

const ROLE_LABEL = { org_admin: "组织管理员", qa: "质量审核(QA)", sd: "研究负责人(SD)", member: "普通用户" };

// ── 登录 ─────────────────────────────────────────────
export function renderLogin(container) {
  container.innerHTML = `
    <div class="auth-wrap">
      <div class="card auth-card">
        <div class="auth-head">
          <h2>登录 BioPharma Hub</h2>
          <p class="hint">使用你的账号登录，进入组织共享的实验室工作台</p>
        </div>
        <form id="login-form" class="auth-form" autocomplete="on">
          <div class="field">
            <label for="login-user">用户名</label>
            <input class="input" id="login-user" name="username" autocomplete="username" required maxlength="32" />
          </div>
          <div class="field">
            <label for="login-pass">密码</label>
            <input class="input" id="login-pass" name="password" type="password" autocomplete="current-password" required />
          </div>
          <div class="auth-error" id="login-error" hidden></div>
          <button class="btn btn-primary auth-submit" id="login-submit" type="submit">登录</button>
        </form>
        <p class="auth-alt">还没有账号？<a href="#/register">注册新账号</a></p>
      </div>
    </div>`;

  const form = $("#login-form", container);
  const errBox = $("#login-error", container);
  const btn = $("#login-submit", container);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    errBox.hidden = true;
    btn.disabled = true;
    btn.textContent = "登录中…";
    const username = $("#login-user", container).value.trim();
    const password = $("#login-pass", container).value;
    const res = await login(username, password);
    if (res.ok) {
      afterAuthRedirect();
    } else {
      errBox.textContent = res.error === "network" ? (res.message || "无法连接服务器") : (res.error || "登录失败");
      errBox.hidden = false;
      btn.disabled = false;
      btn.textContent = "登录";
    }
  });
}

// ── 注册 ─────────────────────────────────────────────
export function renderRegister(container) {
  container.innerHTML = `
    <div class="auth-wrap">
      <div class="card auth-card">
        <div class="auth-head">
          <h2>注册新账号</h2>
          <p class="hint">注册后可凭组织邀请码创建组织，或凭组织码加入已有组织</p>
        </div>
        <form id="reg-form" class="auth-form">
          <div class="field">
            <label for="reg-user">用户名 <span class="req">*</span></label>
            <input class="input" id="reg-user" autocomplete="username" required maxlength="32" placeholder="3-32 位字母/数字/下划线/中文" />
          </div>
          <div class="field">
            <label for="reg-name">显示名（可选）</label>
            <input class="input" id="reg-name" maxlength="120" placeholder="如：张三 / 课题一组" />
          </div>
          <div class="field">
            <label for="reg-pass">密码 <span class="req">*</span></label>
            <input class="input" id="reg-pass" type="password" autocomplete="new-password" required placeholder="至少 8 位" />
          </div>
          <div class="field">
            <label for="reg-pass2">确认密码 <span class="req">*</span></label>
            <input class="input" id="reg-pass2" type="password" autocomplete="new-password" required />
          </div>
          <div class="auth-error" id="reg-error" hidden></div>
          <button class="btn btn-primary auth-submit" id="reg-submit" type="submit">注册并登录</button>
        </form>
        <p class="auth-alt">已有账号？<a href="#/login">直接登录</a></p>
      </div>
    </div>`;

  const form = $("#reg-form", container);
  const errBox = $("#reg-error", container);
  const btn = $("#reg-submit", container);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    errBox.hidden = true;
    const username = $("#reg-user", container).value.trim();
    const displayName = $("#reg-name", container).value.trim();
    const p1 = $("#reg-pass", container).value;
    const p2 = $("#reg-pass2", container).value;
    if (p1 !== p2) {
      errBox.textContent = "两次输入的密码不一致";
      errBox.hidden = false;
      return;
    }
    if (p1.length < 8) {
      errBox.textContent = "密码至少 8 位";
      errBox.hidden = false;
      return;
    }
    btn.disabled = true;
    btn.textContent = "注册中…";
    const res = await register(username, p1, displayName);
    if (res.ok) {
      afterAuthRedirect();
    } else {
      errBox.textContent = res.error === "network" ? (res.message || "无法连接服务器") : (res.error || "注册失败");
      errBox.hidden = false;
      btn.disabled = false;
      btn.textContent = "注册并登录";
    }
  });
}

// ── 账号 / 个人中心 ─────────────────────────────────
export function renderAccount(container) {
  const u = authState.user;
  if (!u) { go("#/login"); return; }
  const orgRows = authState.orgs.map((entry) => {
    const o = entry.org;
    const isCurrent = o.id === authState.currentOrgId;
    return `
      <tr class="${isCurrent ? "row-current" : ""}">
        <td>${esc(o.name)}</td>
        <td><span class="chip chip-role">${esc(ROLE_LABEL[entry.role] || entry.role)}</span></td>
        <td class="mono">${esc(o.orgCode)}</td>
        <td>${isCurrent ? '<span class="inv-badge accent">当前</span>' : `<button class="btn btn-sm" data-switch="${o.id}">设为当前</button>`}</td>
      </tr>`;
  }).join("") || `<tr><td colspan="4" class="state">你还没有加入任何组织。去 <a href="#/org">创建或加入组织</a>。</td></tr>`;

  container.innerHTML = `
    <div class="page-head">
      <h1 class="page-title">账号</h1>
      <p class="page-desc">管理你的登录信息、组织与密码</p>
    </div>

    <div class="card acct-card">
      <div class="acct-id">
        <div class="acct-avatar">${esc((u.displayName || u.username || "?").slice(0, 1).toUpperCase())}</div>
        <div>
          <div class="acct-name">${esc(u.displayName || u.username)}
            ${isSuperAdmin() ? '<span class="chip chip-super">超级管理员</span>' : ""}</div>
          <div class="hint">用户名：${esc(u.username)} · 当前组织：${esc(currentOrg()?.name || "未选择")}</div>
        </div>
        <button class="btn btn-ghost" id="acct-logout" style="margin-left:auto">退出登录</button>
      </div>
    </div>

    <div class="card">
      <h3 class="card-title">我的组织</h3>
      <div class="table-wrap">
        <table class="inv-table acct-orgs">
          <thead><tr><th>组织</th><th>我的角色</th><th>组织码</th><th></th></tr></thead>
          <tbody>${orgRows}</tbody>
        </table>
      </div>
      <p class="hint" style="margin-top:8px">切换当前组织后，实验室库存等数据会切换到该组织。</p>
    </div>

    <div class="card">
      <h3 class="card-title">修改密码</h3>
      <form id="pw-form" class="pw-form">
        <div class="field"><label>原密码</label><input class="input" id="pw-old" type="password" autocomplete="current-password" required /></div>
        <div class="field"><label>新密码</label><input class="input" id="pw-new" type="password" autocomplete="new-password" required placeholder="至少 8 位" /></div>
        <div class="field"><label>确认新密码</label><input class="input" id="pw-new2" type="password" autocomplete="new-password" required /></div>
        <div class="auth-error" id="pw-error" hidden></div>
        <div class="auth-ok" id="pw-ok" hidden>密码已更新</div>
        <button class="btn btn-primary" id="pw-submit" type="submit">更新密码</button>
      </form>
    </div>`;

  $$("[data-switch]", container).forEach((btn) => btn.addEventListener("click", () => {
    setCurrentOrg(Number(btn.dataset.switch));
    renderAccount(container);
  }));

  $("#acct-logout", container).addEventListener("click", () => {
    logout();
    go("#/news");
  });

  $("#pw-form", container).addEventListener("submit", async (e) => {
    e.preventDefault();
    const errBox = $("#pw-error", container);
    const okBox = $("#pw-ok", container);
    errBox.hidden = true; okBox.hidden = true;
    const oldP = $("#pw-old", container).value;
    const n1 = $("#pw-new", container).value;
    const n2 = $("#pw-new2", container).value;
    if (n1 !== n2) { errBox.textContent = "两次输入的新密码不一致"; errBox.hidden = false; return; }
    if (n1.length < 8) { errBox.textContent = "新密码至少 8 位"; errBox.hidden = false; return; }
    const btn = $("#pw-submit", container);
    btn.disabled = true;
    const res = await api("/api/auth/password", { method: "POST", body: { oldPassword: oldP, newPassword: n1 } });
    btn.disabled = false;
    if (res.ok) {
      okBox.hidden = false;
      $("#pw-old", container).value = ""; $("#pw-new", container).value = ""; $("#pw-new2", container).value = "";
    } else {
      errBox.textContent = res.error === "network" ? (res.message || "无法连接服务器") : (res.error || "修改失败");
      errBox.hidden = false;
    }
  });
}
