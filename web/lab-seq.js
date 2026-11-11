// 序列对比：双序列全局比对（Needleman-Wunsch，线性空位罚分）
// DNA: match +2 / mismatch -1 / gap -2；蛋白: BLOSUM62 / gap -4
const $ = (s, el = document) => el.querySelector(s);

function esc(s) {
  const d = document.createElement("div");
  d.textContent = s ?? "";
  return d.innerHTML;
}

const AA_ORDER = "ARNDCQEGHILKMFPSTWYV";
const BLOSUM62_ROWS = [
  "4 -1 -2 -2 0 -1 -1 0 -2 -1 -1 -1 -1 -2 -1 1 0 -3 -2 0",
  "-1 5 0 -2 -3 1 0 -2 0 -3 -2 2 -1 -3 -2 -1 -1 -3 -2 -3",
  "-2 0 6 1 -3 0 0 0 1 -3 -3 0 -2 -3 -2 1 0 -4 -2 -3",
  "-2 -2 1 6 -3 0 2 -1 -1 -3 -4 -1 -3 -3 -1 0 -1 -4 -3 -3",
  "0 -3 -3 -3 9 -3 -4 -3 -3 -1 -1 -3 -1 -2 -3 -1 -1 -2 -2 -1",
  "-1 1 0 0 -3 5 2 -2 0 -3 -2 1 0 -3 -1 0 -1 -2 -1 -2",
  "-1 0 0 2 -4 2 5 -2 0 -3 -3 1 -2 -3 -1 0 -1 -3 -2 -2",
  "0 -2 0 -1 -3 -2 -2 6 -2 -4 -4 -2 -3 -3 -2 0 -2 -2 -3 -3",
  "-2 0 1 -1 -3 0 0 -2 8 -3 -3 -1 -2 -1 -2 -1 -2 -2 2 -3",
  "-1 -3 -3 -3 -1 -3 -3 -4 -3 4 2 -3 1 0 -3 -2 -1 -3 -1 3",
  "-1 -2 -3 -4 -1 -2 -3 -4 -3 2 4 -2 2 0 -3 -2 -1 -2 -1 1",
  "-1 2 0 -1 -3 1 1 -2 -1 -3 -2 5 -1 -3 -1 0 -1 -3 -2 -2",
  "-1 -1 -2 -3 -1 0 -2 -3 -2 1 2 -1 5 0 -2 -1 -1 -1 -1 1",
  "-2 -3 -3 -3 -2 -3 -3 -3 -1 0 0 -3 0 6 -4 -2 -2 1 3 -1",
  "-1 -2 -2 -1 -3 -1 -1 -2 -2 -3 -3 -1 -2 -4 7 -1 -1 -4 -3 -2",
  "1 -1 1 0 -1 0 0 0 -1 -2 -2 0 -1 -2 -1 4 1 -3 -2 -2",
  "0 -1 0 -1 -1 -1 -1 -2 -2 -1 -1 -1 -1 -2 -1 1 5 -2 -2 0",
  "-3 -3 -4 -4 -2 -2 -3 -2 -2 -3 -2 -3 -1 1 -4 -3 -2 11 2 -3",
  "-2 -2 -2 -3 -2 -1 -2 -3 2 -1 -1 -2 -1 3 -3 -2 -2 2 7 -1",
  "0 -3 -3 -3 -1 -2 -2 -3 -3 3 1 -2 1 -1 -2 -2 0 -3 -1 4",
];
const BLOSUM = {};
BLOSUM62_ROWS.forEach((row, i) => {
  const vals = row.split(" ").map(Number);
  BLOSUM[AA_ORDER[i]] = {};
  vals.forEach((v, j) => { BLOSUM[AA_ORDER[i]][AA_ORDER[j]] = v; });
});

const MAX_LEN = 2000;

const seqState = { a: "", b: "", type: "auto", result: null, error: null, running: false };

function cleanSeq(raw) {
  return raw
    .split(/\r?\n/)
    .filter((l) => !l.trim().startsWith(">"))
    .join("")
    .replace(/[\s\d]/g, "")
    .toUpperCase();
}

function detectType(a, b) {
  const s = (a + b).replace(/-/g, "");
  if (!s.length) return "dna";
  const dna = (s.match(/[ACGTUN]/g) || []).length;
  return dna / s.length > 0.85 ? "dna" : "protein";
}

function sanitizeProtein(s) {
  return s.replace(/[^ARNDCQEGHILKMFPSTWYV]/g, "X");
}

function makeScorer(type) {
  if (type === "dna") {
    return { gap: -2, fn: (x, y) => (x === y ? 2 : -1) };
  }
  return {
    gap: -4,
    fn: (x, y) => {
      if (x === "X" || y === "X") return -1;
      return BLOSUM[x]?.[y] ?? -1;
    },
  };
}

function needlemanWunsch(a, b, scorer) {
  const n = a.length, m = b.length, W = m + 1;
  const S = new Int32Array((n + 1) * W);
  const T = new Uint8Array((n + 1) * W); // 0=diag 1=up 2=left
  for (let i = 1; i <= n; i++) { S[i * W] = i * scorer.gap; T[i * W] = 1; }
  for (let j = 1; j <= m; j++) { S[j] = j * scorer.gap; T[j] = 2; }
  for (let i = 1; i <= n; i++) {
    const ai = a[i - 1];
    const row = i * W, prev = (i - 1) * W;
    for (let j = 1; j <= m; j++) {
      const d = S[prev + j - 1] + scorer.fn(ai, b[j - 1]);
      const u = S[prev + j] + scorer.gap;
      const l = S[row + j - 1] + scorer.gap;
      let best = d, t = 0;
      if (u > best) { best = u; t = 1; }
      if (l > best) { best = l; t = 2; }
      S[row + j] = best;
      T[row + j] = t;
    }
  }
  let i = n, j = m;
  const oa = [], ob = [];
  while (i > 0 || j > 0) {
    const t = i === 0 ? 2 : j === 0 ? 1 : T[i * W + j];
    if (t === 0) { oa.push(a[i - 1]); ob.push(b[j - 1]); i--; j--; }
    else if (t === 1) { oa.push(a[i - 1]); ob.push("-"); i--; }
    else { oa.push("-"); ob.push(b[j - 1]); j--; }
  }
  return { a: oa.reverse().join(""), b: ob.reverse().join(""), score: S[n * W + m] };
}

function computeStats(aln, type) {
  let ident = 0, pos = 0, gaps = 0, cols = 0;
  for (let i = 0; i < aln.a.length; i++) {
    const x = aln.a[i], y = aln.b[i];
    if (x === "-" || y === "-") { gaps++; continue; }
    cols++;
    if (x === y) { ident++; pos++; }
    else if (type === "protein" && (BLOSUM[x]?.[y] ?? -1) > 0) pos++;
  }
  return {
    length: aln.a.length,
    ident, pos, gaps, cols,
    identityPct: cols ? (100 * ident / cols) : 0,
    positivePct: cols ? (100 * pos / cols) : 0,
  };
}

function alignmentHTML(aln, type) {
  const W = 60;
  let html = "";
  let pa = 0, pb = 0;
  for (let start = 0; start < aln.a.length; start += W) {
    const sa = aln.a.slice(start, start + W);
    const sb = aln.b.slice(start, start + W);
    const na = sa.replace(/-/g, "").length;
    const nb = sb.replace(/-/g, "").length;
    let mid = "";
    let lineA = "", lineB = "";
    for (let k = 0; k < sa.length; k++) {
      const x = sa[k], y = sb[k];
      let cls, mc;
      if (x === "-" || y === "-") { cls = "gap"; mc = " "; }
      else if (x === y) { cls = "ok"; mc = "|"; }
      else if (type === "protein" && (BLOSUM[x]?.[y] ?? -1) > 0) { cls = "pos"; mc = ":"; }
      else { cls = "mm"; mc = " "; }
      mid += mc;
      lineA += `<span class="aln-${cls}">${esc(x)}</span>`;
      lineB += `<span class="aln-${cls}">${esc(y)}</span>`;
    }
    const endA = pa + na, endB = pb + nb;
    html += `<span class="aln-num">${String(pa + 1).padStart(5)}</span>  ${lineA}  <span class="aln-num">${endA}</span>\n`;
    html += `       ${esc(mid)}\n`;
    html += `<span class="aln-num">${String(pb + 1).padStart(5)}</span>  ${lineB}  <span class="aln-num">${endB}</span>\n\n`;
    pa = endA; pb = endB;
  }
  return html;
}

function alignmentText(aln) {
  const W = 60;
  let out = "";
  for (let s = 0; s < aln.a.length; s += W) {
    const sa = aln.a.slice(s, s + W), sb = aln.b.slice(s, s + W);
    let mid = "";
    for (let k = 0; k < sa.length; k++) {
      mid += sa[k] === sb[k] && sa[k] !== "-" ? "|" : " ";
    }
    out += `${sa}\n${mid}\n${sb}\n\n`;
  }
  return out;
}

const EXAMPLE_DNA = [
  ">seq_A\nATGGCTAGCTAGGCTAGCTAGGCTAAGCTAGCTAGGCTAGCTAGGCTAGCTAGGCTAACGTTAGC",
  ">seq_B\nATGGCTAGCTAGGCTAGCTAGGCTAAGCTAGCTTGGCTAGCTAGGCTAGCTAGGCTACGTTAGC",
];
const EXAMPLE_PROTEIN = [
  ">insulin_A_human\nGIVEQCCTSICSLYQLENYCN",
  ">insulin_A_bovine\nGIVEQCCASVCSLYQLENYCN",
];

export function renderSeq(container) {
  container.innerHTML = `
    <div class="card seq-panel">
      <h2>序列对比</h2>
      <p class="panel-desc">双序列全局比对（Needleman-Wunsch）。支持 FASTA 或纯序列；DNA 计分 +2/-1/-2，蛋白使用 BLOSUM62（空位 -4）。单条上限 ${MAX_LEN} 残基。</p>
      <div class="seq-inputs">
        <div class="field">
          <label for="seq-a">序列 A</label>
          <textarea class="textarea input-mono" id="seq-a" rows="5" placeholder=">seq_A&#10;ATGGCTAGC…">${esc(seqState.a)}</textarea>
        </div>
        <div class="field">
          <label for="seq-b">序列 B</label>
          <textarea class="textarea input-mono" id="seq-b" rows="5" placeholder=">seq_B&#10;ATGGCTAGC…">${esc(seqState.b)}</textarea>
        </div>
      </div>
      <div class="seq-controls">
        <select class="select" id="seq-type" style="width:auto">
          <option value="auto" ${seqState.type === "auto" ? "selected" : ""}>自动识别类型</option>
          <option value="dna" ${seqState.type === "dna" ? "selected" : ""}>DNA / RNA</option>
          <option value="protein" ${seqState.type === "protein" ? "selected" : ""}>蛋白质</option>
        </select>
        <button class="btn btn-primary" id="seq-run">开始比对</button>
        <button class="btn" id="seq-example">载入示例</button>
        <button class="btn" id="seq-clear">清空</button>
      </div>
      <div id="seq-out"></div>
    </div>
  `;

  $("#seq-a").addEventListener("input", (e) => { seqState.a = e.target.value; });
  $("#seq-b").addEventListener("input", (e) => { seqState.b = e.target.value; });
  $("#seq-type").addEventListener("change", (e) => { seqState.type = e.target.value; });
  $("#seq-run").addEventListener("click", runAlign);
  $("#seq-clear").addEventListener("click", () => {
    seqState.a = ""; seqState.b = ""; seqState.result = null; seqState.error = null;
    renderSeq(container);
  });
  $("#seq-example").addEventListener("click", () => {
    const isProtein = seqState.type === "protein";
    const ex = isProtein ? EXAMPLE_PROTEIN : EXAMPLE_DNA;
    seqState.a = ex[0]; seqState.b = ex[1];
    seqState.result = null; seqState.error = null;
    renderSeq(container);
  });

  renderSeqOut();
}

function runAlign() {
  const a = cleanSeq(seqState.a);
  const b = cleanSeq(seqState.b);
  seqState.error = null;
  seqState.result = null;
  if (!a || !b) { seqState.error = "请输入两条序列。"; renderSeqOut(); return; }
  if (a.length > MAX_LEN || b.length > MAX_LEN) {
    seqState.error = `序列过长（A: ${a.length}, B: ${b.length}），单条上限 ${MAX_LEN} 残基。`;
    renderSeqOut(); return;
  }
  const type = seqState.type === "auto" ? detectType(a, b) : seqState.type;
  const sa = type === "protein" ? sanitizeProtein(a) : a.replace(/U/g, "T");
  const sb = type === "protein" ? sanitizeProtein(b) : b.replace(/U/g, "T");
  seqState.running = true;
  renderSeqOut();
  setTimeout(() => {
    try {
      const aln = needlemanWunsch(sa, sb, makeScorer(type));
      seqState.result = { aln, type, stats: computeStats(aln, type) };
    } catch (e) {
      seqState.error = "比对失败：" + e.message;
    }
    seqState.running = false;
    renderSeqOut();
  }, 30);
}

function renderSeqOut() {
  const out = $("#seq-out");
  if (!out) return;
  if (seqState.running) {
    out.innerHTML = `<div class="seq-running"><span class="spinner" style="width:16px;height:16px;border-width:2px"></span> 正在比对…</div>`;
    return;
  }
  if (seqState.error) {
    out.innerHTML = `<div class="ai-unavailable" style="border-left:3px solid var(--rose);background:var(--rose-soft);color:#7a2536;margin-top:14px">${esc(seqState.error)}</div>`;
    return;
  }
  if (!seqState.result) { out.innerHTML = ""; return; }
  const { aln, type, stats } = seqState.result;
  out.innerHTML = `
    <div class="seq-stats">
      <span>类型 <strong>${type === "dna" ? "DNA" : "蛋白"}</strong></span>
      <span>比对长度 <strong>${stats.length}</strong></span>
      <span>一致性 <strong>${stats.identityPct.toFixed(1)}%</strong> (${stats.ident}/${stats.cols})</span>
      ${type === "protein" ? `<span>相似性 <strong>${stats.positivePct.toFixed(1)}%</strong></span>` : ""}
      <span>空位 <strong>${stats.gaps}</strong></span>
      <span>得分 <strong>${aln.score}</strong></span>
      <button class="btn btn-sm" id="seq-copy" style="margin-left:auto">复制比对结果</button>
    </div>
    <pre class="aln-pre">${alignmentHTML(aln, type)}</pre>
    <div class="hint">图例：<span class="aln-ok">|</span> 完全一致 · <span class="aln-pos">:</span> 保守替换（蛋白） · <span class="aln-mm">空格</span> 错配 · <span class="aln-gap">-</span> 空位</div>
  `;
  $("#seq-copy").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(alignmentText(aln));
      const b = $("#seq-copy");
      b.textContent = "已复制 ✓";
      setTimeout(() => { b.textContent = "复制比对结果"; }, 1500);
    } catch { /* clipboard unavailable */ }
  });
}