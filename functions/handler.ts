// BioPharma Hub edge function: news aggregation, translation, protocol AI enhancement.
// Conservative TypeScript (Deno). No external deps. Global try/catch to avoid raw 500s.

const NEWS_CACHE_MS = 10 * 60 * 1000;
const TRANS_CACHE_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8000;

let newsCache: { at: number; data: unknown } | null = null;
const transCache = new Map<string, { at: number; data: string }>();

const FEEDS = [
  { name: "GEN", url: "https://www.genengnews.com/feed/", lang: "en" },
  { name: "BioPharma Dive", url: "https://www.biopharmadive.com/feeds/news/", lang: "en" },
  { name: "Endpoints News", url: "https://endpts.com/feed/", lang: "en" },
  { name: "STAT News", url: "https://www.statnews.com/feed/", lang: "en" },
  { name: "Nature Biotechnology", url: "https://www.nature.com/nbt.rss", lang: "en" },
  { name: "FierceBiotech", url: "https://www.fiercebiotech.com/rss/xml", lang: "en" },
  { name: "ScienceDaily", url: "https://www.sciencedaily.com/rss/top/biotechnology.xml", lang: "en" },
  { name: "生物谷", url: "https://www.bioon.com/rss.xml", lang: "zh" },
];

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store", ...extra },
  });
}

function safeDateISO(value: string): string {
  if (!value) return "";
  const t = Date.parse(value.trim());
  if (Number.isNaN(t)) return "";
  try {
    return new Date(t).toISOString();
  } catch {
    return "";
  }
}

function decodeEntities(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .trim();
}

function tagText(block: string, tag: string): string {
  const re = new RegExp("<" + tag + "[^>]*>([\\s\\S]*?)</" + tag + ">", "i");
  const m = block.match(re);
  return m ? decodeEntities(m[1]) : "";
}

function parseFeed(xml: string, sourceName: string, lang: string): any[] {
  const items: any[] = [];
  const itemRe = /<item[\s>][\s\S]*?<\/item>|<entry[\s>][\s\S]*?<\/entry>/gi;
  const blocks = xml.match(itemRe) || [];
  for (const block of blocks.slice(0, 20)) {
    const title = tagText(block, "title");
    let link = tagText(block, "link");
    if (!link) {
      const m = block.match(/<link[^>]*href=["']([^"']+)["']/i);
      if (m) link = m[1];
    }
    const descRaw = tagText(block, "description") || tagText(block, "summary") || tagText(block, "content");
    const description = descRaw.replace(/<[^>]+>/g, "").slice(0, 300);
    const pubRaw =
      tagText(block, "pubDate") ||
      tagText(block, "published") ||
      tagText(block, "updated") ||
      tagText(block, "dc:date");
    if (!title) continue;
    items.push({
      title,
      link,
      description,
      source: sourceName,
      lang,
      publishedAt: safeDateISO(pubRaw),
    });
  }
  return items;
}

async function fetchWithTimeout(url: string): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { "User-Agent": "Mozilla/5.0 (BioPharmaHub/1.0)" },
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

async function collectNews(): Promise<unknown> {
  if (newsCache && Date.now() - newsCache.at < NEWS_CACHE_MS) {
    return newsCache.data;
  }
  const settled = await Promise.all(
    FEEDS.map(async (feed) => {
      try {
        const xml = await fetchWithTimeout(feed.url);
        return { feed, items: parseFeed(xml, feed.name, feed.lang) };
      } catch {
        return { feed, items: [] as any[] };
      }
    }),
  );
  const items: any[] = [];
  const sources: any[] = [];
  for (const s of settled) {
    sources.push({ name: s.feed.name, lang: s.feed.lang, count: s.items.length, ok: s.items.length > 0 });
    for (const it of s.items) items.push(it);
  }
  items.sort((a, b) => (b.publishedAt || "").localeCompare(a.publishedAt || ""));
  const data = { ok: true, items: items.slice(0, 80), sources, fetchedAt: new Date().toISOString() };
  newsCache = { at: Date.now(), data };
  return data;
}

async function translateBatch(titles: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const todo: string[] = [];
  for (const t of titles) {
    const cached = transCache.get(t);
    if (cached && Date.now() - cached.at < TRANS_CACHE_MS) {
      out[t] = cached.data;
    } else {
      todo.push(t);
    }
  }
  if (todo.length === 0) return out;
  const chunk = todo.slice(0, 40);
  const q = chunk.join("\n");
  const url =
    "https://translate.googleapis.com/translate_a/t?client=gtx&sl=en&tl=zh-CN&dt=t&q=" + encodeURIComponent(q);
  try {
    const res = await fetchWithTimeout(url);
    const data = JSON.parse(res);
    let translated = "";
    if (Array.isArray(data) && Array.isArray(data[0])) {
      translated = (data[0] as any[]).map((x) => (Array.isArray(x) ? x[0] : "")).join("");
    } else if (data && Array.isArray(data.sentences)) {
      translated = data.sentences.map((x: any) => x.trans || "").join("");
    }
    const parts = translated.split("\n");
    chunk.forEach((orig, i) => {
      const zh = (parts[i] || "").trim();
      if (zh) {
        out[orig] = zh;
        transCache.set(orig, { at: Date.now(), data: zh });
      }
    });
  } catch {
    // leave untranslated; caller falls back to original title
  }
  return out;
}

async function enhanceProtocol(payload: any): Promise<Response> {
  const deno = (globalThis as any).Deno;
  const pat = deno?.env?.get?.("QODER_PAT") || "";
  const topic = String(payload?.topic || "").slice(0, 400);
  const draft = String(payload?.draft || "").slice(0, 6000);
  if (!topic && !draft) {
    return json({ ok: false, error: "empty_input" }, 400);
  }
  if (!pat) {
    return json({
      ok: true,
      ai: false,
      note: "AI 增强当前不可用（未配置访问令牌）。以下为模板生成的标准流程，可直接使用。",
    });
  }
  try {
    const res = await fetch("https://api.qoder.com.cn/api/v1/cloud/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + pat },
      body: JSON.stringify({
        messages: [
          {
            role: "system",
            content:
              "你是一名资深生物医药实验设计顾问。请针对用户提供的 Protocol 草稿，给出专业、简洁、可执行的优化建议，包括关键步骤注意事项、常见失败原因和改进方向。用中文回答。",
          },
          { role: "user", content: "Protocol 主题：" + topic + "\n\n当前草稿：\n" + draft },
        ],
      }),
    });
    if (!res.ok) {
      return json({
        ok: true,
        ai: false,
        note: "AI 服务暂时不可用（HTTP " + res.status + "）。模板流程仍可正常使用。",
      });
    }
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content || data?.content || data?.message || "";
    return json({ ok: true, ai: true, text: String(text) });
  } catch {
    return json({ ok: true, ai: false, note: "AI 服务连接失败。模板流程仍可正常使用。" });
  }
}

export async function handler(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "");

    if (path.endsWith("/health")) {
      return json({ ok: true, service: "biopharma-hub", time: new Date().toISOString() });
    }
    if (path.endsWith("/feeds")) {
      return json({ ok: true, feeds: FEEDS });
    }
    if (path.endsWith("/news")) {
      return json(await collectNews());
    }
    if (path.endsWith("/news/translate")) {
      if (request.method !== "POST") {
        return json({ ok: false, error: "method_not_allowed" }, 405, { Allow: "POST" });
      }
      const body = await request.json().catch(() => ({}));
      const titles = Array.isArray(body?.titles)
        ? body.titles.filter((t: any) => typeof t === "string").slice(0, 40)
        : [];
      return json({ ok: true, translations: await translateBatch(titles) });
    }
    if (path.endsWith("/protocol/enhance")) {
      if (request.method !== "POST") {
        return json({ ok: false, error: "method_not_allowed" }, 405, { Allow: "POST" });
      }
      const body = await request.json().catch(() => ({}));
      return await enhanceProtocol(body);
    }
    return json({ ok: false, error: "not_found", path }, 404);
  } catch (err) {
    return json(
      { ok: false, error: "internal_error", detail: String((err as Error)?.message || err) },
      500,
    );
  }
}
