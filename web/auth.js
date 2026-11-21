// auth.js — 会话、API 客户端与组织上下文（BioPharma Hub 用户/组织管理）
//
// 后端地址：生产环境用 Cloudflare 绑定的子域名；本地开发（localhost）自动指向
// http://127.0.0.1:8000 的 Flask 后端。若你的子域名不是 hubapi.aerobeats.xyz，
// 只需修改下面的 PROD_API。
const PROD_API = "https://hubapi.aerobeats.xyz";
const API_BASE = (location.hostname === "localhost" || location.hostname === "127.0.0.1")
  ? "http://127.0.0.1:8000"
  : PROD_API;

const TOKEN_KEY = "bph_auth_token";
const ORG_KEY = "bph_current_org";

export const authState = {
  ready: false,          // loadMe() 是否完成
  user: null,            // {id, username, displayName, isSuperAdmin, disabled, createdAt}
  orgs: [],              // [{org:{id,name,orgCode,...}, role, title, membershipId, memberCount?}]
  currentOrgId: Number(localStorage.getItem(ORG_KEY)) || null,
};

export function apiBase() { return API_BASE; }
export function getToken() { return localStorage.getItem(TOKEN_KEY) || ""; }
export function setToken(t) {
  if (t) localStorage.setItem(TOKEN_KEY, t);
  else localStorage.removeItem(TOKEN_KEY);
}

export function isLoggedIn() { return !!authState.user; }
export function isSuperAdmin() { return !!(authState.user && authState.user.isSuperAdmin); }

export function currentOrgEntry() {
  return authState.orgs.find((o) => o.org.id === authState.currentOrgId) || null;
}
export function currentOrg() {
  const e = currentOrgEntry();
  return e ? e.org : null;
}
export function currentRole() {
  const e = currentOrgEntry();
  return e ? e.role : null;
}
export function canManageCurrentOrg() {
  return isSuperAdmin() || currentRole() === "org_admin";
}
export function setCurrentOrg(id) {
  authState.currentOrgId = id || null;
  if (id) localStorage.setItem(ORG_KEY, String(id));
  else localStorage.removeItem(ORG_KEY);
}

// 401（token 失效/被禁用）时的回调，由 app.js 注入（跳转登录并刷新界面）。
let _onUnauthorized = () => {};
export function setUnauthorizedHandler(fn) { _onUnauthorized = fn || (() => {}); }

// 通用 API 调用。返回后端 JSON（含 ok 字段）。网络错误返回 {ok:false,error:"network"}。
export async function api(path, { method = "GET", body, auth = true } = {}) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (auth) {
    const t = getToken();
    if (t) headers["Authorization"] = "Bearer " + t;
  }
  let res;
  try {
    res = await fetch(API_BASE + path, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    return { ok: false, error: "network", message: "无法连接服务器，请检查网络或后端是否已启动" };
  }
  if (res.status === 401 && auth) {
    setToken("");
    authState.user = null;
    authState.orgs = [];
    _onUnauthorized();
  }
  let data;
  try {
    data = await res.json();
  } catch {
    data = { ok: false, error: "bad_response" };
  }
  if (data && data.ok === undefined) data.ok = res.ok;
  return data;
}

function _adoptOrgs(orgs) {
  authState.orgs = Array.isArray(orgs) ? orgs : [];
  const valid = authState.orgs.some((o) => o.org.id === authState.currentOrgId);
  if (!valid) {
    setCurrentOrg(authState.orgs.length ? authState.orgs[0].org.id : null);
  }
}

export async function loadMe() {
  const t = getToken();
  if (!t) {
    authState.user = null;
    authState.orgs = [];
    authState.ready = true;
    return;
  }
  const data = await api("/api/auth/me");
  if (data.ok) {
    authState.user = data.user;
    _adoptOrgs(data.orgs);
  } else {
    authState.user = null;
    authState.orgs = [];
    if (data.error === "invalid_token" || data.error === "unauthorized") setToken("");
  }
  authState.ready = true;
}

export async function login(username, password) {
  const data = await api("/api/auth/login", { method: "POST", body: { username, password }, auth: false });
  if (data.ok) {
    setToken(data.token);
    authState.user = data.user;
    _adoptOrgs(data.orgs);
  }
  return data;
}

export async function register(username, password, displayName) {
  const data = await api("/api/auth/register", { method: "POST", body: { username, password, displayName }, auth: false });
  if (data.ok) {
    setToken(data.token);
    authState.user = data.user;
    _adoptOrgs(data.orgs);
  }
  return data;
}

export function logout() {
  setToken("");
  authState.user = null;
  authState.orgs = [];
  setCurrentOrg(null);
}

export async function refreshOrgs() {
  const data = await api("/api/orgs");
  if (data.ok) _adoptOrgs(data.orgs);
  return data;
}
