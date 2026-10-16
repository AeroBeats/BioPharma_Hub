// BioPharma Hub AI backend for Cloudflare Workers.
// Deploy via Cloudflare dashboard (Workers & Pages → Create Worker → paste this file).
// Required Secret: QODER_PAT  (Workers & Pages → Settings → Variables and Secrets)
// Optional Var:    ALLOWED_ORIGINS (comma-separated CORS whitelist;
//                   default "https://aerobeats.github.io")

const QODER_API = "https://api.qoder.com.cn/api/v1/cloud/chat/completions";

const SYSTEM_PROMPT =
  "你是一名资深生物医药实验设计顾问。请针对用户提供的 Protocol 草稿，给出专业、简洁、可执行的优化建议，" +
  "包括关键步骤注意事项、常见失败原因和改进方向。用中文回答，使用 Markdown 格式。";

function corsHeaders(request, env) {
  const allowed = (env.ALLOWED_ORIGINS || "https://aerobeats.github.io")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const origin = request.headers.get("Origin");
  const headers = {
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
  if (origin && allowed.includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Vary"] = "Origin";
  } else if (!origin) {
    // Non-browser client (curl / health check).
    headers["Access-Control-Allow-Origin"] = "*";
  }
  // A disallowed browser origin gets no Allow-Origin header → browser blocks it.
  return headers;
}

function json(body, cors, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...cors,
    },
  });
}

async function enhance(payload, env, cors) {
  const topic = String(payload?.topic || "").slice(0, 400);
  const draft = String(payload?.draft || "").slice(0, 8000);
  if (!topic && !draft) return json({ ok: false, error: "empty_input" }, cors, 400);

  const pat = env.QODER_PAT;
  if (!pat) {
    return json({ ok: true, ai: false, note: "后端未配置 QODER_PAT，AI 暂不可用。" }, cors);
  }

  try {
    const res = await fetch(QODER_API, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + pat },
      body: JSON.stringify({
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: "Protocol 主题：" + topic + "\n\n当前草稿：\n" + draft },
        ],
      }),
    });
    if (!res.ok) {
      return json({ ok: true, ai: false, note: "AI 服务暂时不可用（HTTP " + res.status + "）。模板流程仍可正常使用。" }, cors);
    }
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content || data?.content || data?.message || "";
    return json({ ok: true, ai: true, text: String(text) }, cors);
  } catch {
    return json({ ok: true, ai: false, note: "AI 服务连接失败。模板流程仍可正常使用。" }, cors);
  }
}

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "");

    if (path.endsWith("/health")) {
      return json({ ok: true, service: "biopharma-hub-ai" }, cors);
    }
    if (path.endsWith("/protocol/enhance")) {
      if (request.method !== "POST") {
        return json({ ok: false, error: "method_not_allowed" }, cors, 405);
      }
      let payload = {};
      try {
        payload = await request.json();
      } catch {
        payload = {};
      }
      return enhance(payload, env, cors);
    }
    return json({ ok: false, error: "not_found", path }, cors, 404);
  },
};
