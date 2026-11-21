// ui.js — 轻量共享 UI：电子签名密码弹窗、确认框、提示条
const $ = (s, el = document) => el.querySelector(s);

function esc(s) {
  const d = document.createElement("div");
  d.textContent = s ?? "";
  return d.innerHTML;
}

function ensureRoot() {
  let root = $("#ui-modal-root");
  if (!root) {
    root = document.createElement("div");
    root.id = "ui-modal-root";
    document.body.appendChild(root);
  }
  return root;
}

// 弹出需要输入登录密码的对话框（用于 21 CFR Part 11 风格电子签名确认）。
// resolve 输入的密码；取消则 resolve null。
export function promptPassword({ title = "安全确认", message = "", confirmLabel = "确认" } = {}) {
  return new Promise((resolve) => {
    const root = ensureRoot();
    root.innerHTML = `
      <div class="ui-mask">
        <div class="ui-modal card" role="dialog" aria-modal="true">
          <h3 class="ui-modal-title">${esc(title)}</h3>
          ${message ? `<p class="ui-modal-msg">${esc(message)}</p>` : ""}
          <div class="field">
            <label>请输入你的登录密码以电子签名</label>
            <input class="input" id="ui-pw" type="password" autocomplete="current-password" />
          </div>
          <div class="ui-modal-actions">
            <button class="btn btn-ghost" id="ui-cancel">取消</button>
            <button class="btn btn-primary" id="ui-ok">${esc(confirmLabel)}</button>
          </div>
        </div>
      </div>`;
    const close = (val) => { root.innerHTML = ""; resolve(val); };
    $("#ui-cancel", root).addEventListener("click", () => close(null));
    $("#ui-ok", root).addEventListener("click", () => close($("#ui-pw", root).value));
    $("#ui-pw", root).addEventListener("keydown", (e) => { if (e.key === "Enter") close(e.target.value); });
    $(".ui-mask", root).addEventListener("click", (e) => { if (e.target.classList.contains("ui-mask")) close(null); });
    setTimeout(() => $("#ui-pw", root)?.focus(), 30);
  });
}

// 通用单行输入弹窗。resolve 输入的字符串；取消则 resolve null。
export function promptInput({ title = "请输入", message = "", label = "", type = "text", placeholder = "", confirmLabel = "确定" } = {}) {
  return new Promise((resolve) => {
    const root = ensureRoot();
    root.innerHTML = `
      <div class="ui-mask">
        <div class="ui-modal card" role="dialog" aria-modal="true">
          <h3 class="ui-modal-title">${esc(title)}</h3>
          ${message ? `<p class="ui-modal-msg">${esc(message)}</p>` : ""}
          <div class="field">
            ${label ? `<label>${esc(label)}</label>` : ""}
            <input class="input" id="ui-input" type="${type}" placeholder="${esc(placeholder)}" />
          </div>
          <div class="ui-modal-actions">
            <button class="btn btn-ghost" id="ui-cancel">取消</button>
            <button class="btn btn-primary" id="ui-ok">${esc(confirmLabel)}</button>
          </div>
        </div>
      </div>`;
    const close = (val) => { root.innerHTML = ""; resolve(val); };
    $("#ui-cancel", root).addEventListener("click", () => close(null));
    $("#ui-ok", root).addEventListener("click", () => close($("#ui-input", root).value));
    $("#ui-input", root).addEventListener("keydown", (e) => { if (e.key === "Enter") close(e.target.value); });
    $(".ui-mask", root).addEventListener("click", (e) => { if (e.target.classList.contains("ui-mask")) close(null); });
    setTimeout(() => $("#ui-input", root)?.focus(), 30);
  });
}

// 确认对话框，resolve true/false。
export function confirmDialog({ title = "请确认", message = "", confirmLabel = "确定", danger = false } = {}) {  return new Promise((resolve) => {
    const root = ensureRoot();
    root.innerHTML = `
      <div class="ui-mask">
        <div class="ui-modal card" role="dialog" aria-modal="true">
          <h3 class="ui-modal-title">${esc(title)}</h3>
          ${message ? `<p class="ui-modal-msg">${esc(message)}</p>` : ""}
          <div class="ui-modal-actions">
            <button class="btn btn-ghost" id="ui-cancel">取消</button>
            <button class="btn ${danger ? "btn-danger" : "btn-primary"}" id="ui-ok">${esc(confirmLabel)}</button>
          </div>
        </div>
      </div>`;
    const close = (val) => { root.innerHTML = ""; resolve(val); };
    $("#ui-cancel", root).addEventListener("click", () => close(false));
    $("#ui-ok", root).addEventListener("click", () => close(true));
    $(".ui-mask", root).addEventListener("click", (e) => { if (e.target.classList.contains("ui-mask")) close(false); });
  });
}

// 右上角临时提示。type: ok | error | info
export function toast(message, type = "info", ms = 2600) {
  let host = $("#ui-toast-host");
  if (!host) {
    host = document.createElement("div");
    host.id = "ui-toast-host";
    document.body.appendChild(host);
  }
  const el = document.createElement("div");
  el.className = `ui-toast ui-toast-${type}`;
  el.textContent = message;
  host.appendChild(el);
  setTimeout(() => { el.classList.add("ui-toast-out"); setTimeout(() => el.remove(), 260); }, ms);
}
