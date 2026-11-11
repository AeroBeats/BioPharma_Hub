// 胶图处理：电泳凝胶图像增强 + Marker 标定 + 条带大小估算 + 标注导出
// 全部在浏览器本地 canvas 完成，图像不上传。
const $ = (s, el = document) => el.querySelector(s);

function esc(s) {
  const d = document.createElement("div");
  d.textContent = s ?? "";
  return d.innerHTML;
}

const DL2000 = [2000, 1000, 750, 500, 250, 100];

const gelState = {
  img: null,
  fileName: "",
  filters: { brightness: 100, contrast: 100, invert: false, gray: false },
  mode: "view", // view | ladder | band
  ladder: [], // {y, size}
  bands: [], // {y}
};

function filterString(f) {
  return `brightness(${f.brightness}%) contrast(${f.contrast}%)${f.gray ? " grayscale(1)" : ""}${f.invert ? " invert(1)" : ""}`;
}

function estimateSize(y) {
  const pts = gelState.ladder.filter((p) => p.size > 0).sort((a, b) => a.y - b.y);
  if (pts.length < 2) return null;
  const n = pts.length;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const p of pts) {
    const ly = Math.log10(p.size);
    sx += p.y; sy += ly; sxx += p.y * p.y; sxy += p.y * ly;
  }
  const denom = n * sxx - sx * sx;
  if (!denom) return null;
  const b = (n * sxy - sx * sy) / denom;
  const a = (sy - b * sx) / n;
  const size = Math.pow(10, a + b * y);
  const inRange = y >= pts[0].y && y <= pts[n - 1].y;
  return { size, inRange };
}

function fmtBp(v) {
  if (v >= 1000) return String(Math.round(v / 10) * 10);
  if (v >= 100) return String(Math.round(v / 5) * 5);
  return String(Math.round(v));
}

function drawGel(canvas) {
  const img = gelState.img;
  if (!img) return;
  const W = img.naturalWidth, H = img.naturalHeight;
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  ctx.filter = filterString(gelState.filters);
  ctx.drawImage(img, 0, 0);
  ctx.filter = "none";

  const r = Math.max(4, W * 0.006);
  const font = Math.max(12, Math.round(W * 0.018));
  ctx.font = `600 ${font}px "JetBrains Mono", monospace`;
  ctx.lineWidth = Math.max(1.5, W * 0.002);

  const label = (x, y, text, color) => {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = "#ffffff";
    ctx.stroke();
    ctx.strokeStyle = "rgba(0,0,0,.85)";
    ctx.lineWidth = Math.max(2, font * 0.22);
    ctx.strokeText(text, x + r + 4, y + font * 0.35);
    ctx.fillStyle = color;
    ctx.fillText(text, x + r + 4, y + font * 0.35);
    ctx.lineWidth = Math.max(1.5, W * 0.002);
  };

  for (const p of gelState.ladder) {
    label(W * 0.06, p.y, p.size > 0 ? `${p.size} bp` : "marker?", "#22c55e");
  }
  for (const p of gelState.bands) {
    const est = estimateSize(p.y);
    const text = est ? `${est.inRange ? "" : "~"}${fmtBp(est.size)} bp` : "需≥2个Marker";
    label(W * 0.5, p.y, text, "#f59e0b");
  }
}

export function renderGel(container) {
  container.innerHTML = `
    <div class="gel-layout">
      <div class="card gel-main">
        <div class="gel-head">
          <h2>胶图处理</h2>
          <div class="gel-head-actions">
            <label class="btn btn-sm" for="gel-file">上传胶图</label>
            <input type="file" id="gel-file" accept="image/*" hidden />
            <button class="btn btn-sm" id="gel-export" ${gelState.img ? "" : "disabled"}>导出标注 PNG</button>
          </div>
        </div>
        <p class="panel-desc">图像增强、Marker 标定与条带大小估算（log 线性回归）。所有处理在本地完成，不上传服务器。</p>
        <div class="gel-canvas-wrap" id="gel-wrap">
          ${gelState.img
            ? `<canvas id="gel-canvas"></canvas>`
            : `<div class="state">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M8 7v10M12 7v10M16 7v10"/></svg>
                <div class="state-title">尚未载入胶图</div>
                <div class="state-desc">点击"上传胶图"选择电泳照片（PNG/JPG）。建议拍摄时保证 Marker  lane 与样品 lane 平行、无倾斜。</div>
              </div>`}
        </div>
        ${gelState.img ? `<div class="hint">当前文件：${esc(gelState.fileName)} · ${gelState.img.naturalWidth}×${gelState.img.naturalHeight}px</div>` : ""}
      </div>
      <div class="card gel-side">
        <h2>图像增强</h2>
        <div class="field">
          <label for="gel-brightness">亮度 <span id="gel-brightness-val">${gelState.filters.brightness}%</span></label>
          <input type="range" id="gel-brightness" min="30" max="250" value="${gelState.filters.brightness}" />
        </div>
        <div class="field">
          <label for="gel-contrast">对比度 <span id="gel-contrast-val">${gelState.filters.contrast}%</span></label>
          <input type="range" id="gel-contrast" min="30" max="300" value="${gelState.filters.contrast}" />
        </div>
        <div class="gel-checks">
          <label><input type="checkbox" id="gel-invert" ${gelState.filters.invert ? "checked" : ""} /> 反相</label>
          <label><input type="checkbox" id="gel-gray" ${gelState.filters.gray ? "checked" : ""} /> 灰度</label>
          <button class="btn btn-sm" id="gel-reset-filters">重置</button>
        </div>

        <h2 style="margin-top:18px">标点模式</h2>
        <div class="filter-chips" id="gel-modes">
          <button class="chip ${gelState.mode === "view" ? "active" : ""}" data-mode="view">浏览</button>
          <button class="chip ${gelState.mode === "ladder" ? "active" : ""}" data-mode="ladder">加 Marker</button>
          <button class="chip ${gelState.mode === "band" ? "active" : ""}" data-mode="band">测条带</button>
        </div>
        <div class="hint" id="gel-mode-hint"></div>

        <div class="gel-points">
          <div class="gel-points-head">
            <strong>Marker（绿）</strong>
            <button class="btn btn-sm" id="gel-preset">DL2000 预设</button>
            <button class="btn btn-sm" id="gel-clear-ladder">清空</button>
          </div>
          <div id="gel-ladder-list"></div>
          <div class="gel-points-head" style="margin-top:12px">
            <strong>待测条带（橙）</strong>
            <button class="btn btn-sm" id="gel-clear-bands">清空</button>
          </div>
          <div id="gel-band-list"></div>
        </div>
      </div>
    </div>
  `;

  const canvas = $("#gel-canvas");
  if (canvas) {
    drawGel(canvas);
    canvas.style.cursor = gelState.mode === "view" ? "default" : "crosshair";
    canvas.addEventListener("click", (e) => {
      if (gelState.mode === "view") return;
      const rect = canvas.getBoundingClientRect();
      const y = Math.round((e.clientY - rect.top) * (canvas.height / rect.height));
      if (gelState.mode === "ladder") gelState.ladder.push({ y, size: 0 });
      else gelState.bands.push({ y });
      drawGel(canvas);
      renderPointLists();
    });
  }

  $("#gel-file").addEventListener("change", (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      gelState.img = img;
      gelState.fileName = file.name;
      gelState.ladder = [];
      gelState.bands = [];
      URL.revokeObjectURL(url);
      renderGel(container);
    };
    img.src = url;
  });

  const onFilter = () => { if (canvas) drawGel(canvas); };
  $("#gel-brightness").addEventListener("input", (e) => {
    gelState.filters.brightness = Number(e.target.value);
    $("#gel-brightness-val").textContent = e.target.value + "%";
    onFilter();
  });
  $("#gel-contrast").addEventListener("input", (e) => {
    gelState.filters.contrast = Number(e.target.value);
    $("#gel-contrast-val").textContent = e.target.value + "%";
    onFilter();
  });
  $("#gel-invert").addEventListener("change", (e) => { gelState.filters.invert = e.target.checked; onFilter(); });
  $("#gel-gray").addEventListener("change", (e) => { gelState.filters.gray = e.target.checked; onFilter(); });
  $("#gel-reset-filters").addEventListener("click", () => {
    gelState.filters = { brightness: 100, contrast: 100, invert: false, gray: false };
    renderGel(container);
  });

  $("#gel-modes").addEventListener("click", (e) => {
    const btn = e.target.closest(".chip");
    if (!btn) return;
    gelState.mode = btn.dataset.mode;
    renderGel(container);
  });

  $("#gel-preset").addEventListener("click", () => {
    const sorted = [...gelState.ladder].sort((a, b) => a.y - b.y);
    sorted.forEach((p, i) => { p.size = DL2000[i] ?? 0; });
    if (canvas) drawGel(canvas);
    renderPointLists();
  });
  $("#gel-clear-ladder").addEventListener("click", () => {
    gelState.ladder = [];
    if (canvas) drawGel(canvas);
    renderPointLists();
  });
  $("#gel-clear-bands").addEventListener("click", () => {
    gelState.bands = [];
    if (canvas) drawGel(canvas);
    renderPointLists();
  });

  $("#gel-export").addEventListener("click", () => {
    if (!gelState.img) return;
    const tmp = document.createElement("canvas");
    drawGel(tmp);
    tmp.toBlob((blob) => {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "gel-annotated.png";
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    }, "image/png");
  });

  renderPointLists();
  updateModeHint();
}

function updateModeHint() {
  const el = $("#gel-mode-hint");
  if (!el) return;
  const hints = {
    view: "浏览模式：点击图像不加点。",
    ladder: "在 Marker lane 上从上到下依次点击各已知条带，然后在右侧填写大小（或点 DL2000 预设）。",
    band: "点击样品 lane 中的待测条带，自动按 Marker 回归估算大小（bp）。",
  };
  el.textContent = hints[gelState.mode];
}

function renderPointLists() {
  const ladderEl = $("#gel-ladder-list");
  const bandEl = $("#gel-band-list");
  if (!ladderEl || !bandEl) return;

  ladderEl.innerHTML = gelState.ladder.length
    ? gelState.ladder.map((p, i) => `
      <div class="pt-row">
        <span class="pt-y">#${i + 1} · y=${p.y}px</span>
        <input class="input input-mono pt-size" type="number" min="1" data-i="${i}" value="${p.size || ""}" placeholder="bp" />
        <button class="btn btn-sm btn-ghost pt-del" data-kind="ladder" data-i="${i}" title="删除">×</button>
      </div>`).join("")
    : `<div class="hint">暂无 Marker 点</div>`;

  bandEl.innerHTML = gelState.bands.length
    ? gelState.bands.map((p, i) => {
        const est = estimateSize(p.y);
        return `
        <div class="pt-row">
          <span class="pt-y">#${i + 1} · y=${p.y}px</span>
          <span class="pt-est">${est ? `${est.inRange ? "" : "~"}${fmtBp(est.size)} bp` : "—"}</span>
          <button class="btn btn-sm btn-ghost pt-del" data-kind="band" data-i="${i}" title="删除">×</button>
        </div>`;
      }).join("")
    : `<div class="hint">暂无待测条带</div>`;

  ladderEl.querySelectorAll(".pt-size").forEach((inp) => {
    inp.addEventListener("change", (e) => {
      gelState.ladder[Number(e.target.dataset.i)].size = Number(e.target.value) || 0;
      const canvas = $("#gel-canvas");
      if (canvas) drawGel(canvas);
      renderPointLists();
    });
  });
  document.querySelectorAll(".pt-del").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const { kind, i } = e.currentTarget.dataset;
      if (kind === "ladder") gelState.ladder.splice(Number(i), 1);
      else gelState.bands.splice(Number(i), 1);
      const canvas = $("#gel-canvas");
      if (canvas) drawGel(canvas);
      renderPointLists();
    });
  });
}