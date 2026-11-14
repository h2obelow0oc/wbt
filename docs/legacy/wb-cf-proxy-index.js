/**
 * WorkBuddy / CodeBuddy OpenAI 兼容代理 (方案1: token 上云)
 * Service Worker 经典格式 (addEventListener)。
 */
const CHAT_BASE = {
  cn: "https://copilot.tencent.com",
  global: "https://www.workbuddy.ai",
};
const ORIGIN = {
  cn: "https://www.codebuddy.cn",
  global: "https://www.workbuddy.ai",
};
const CLIENT_UA = "CLI/2.63.2 CodeBuddy/2.63.2";
const REFRESH_SKEW = 10 * 60;

// 按 token.domain 自动判定 region，env.WB_REGION 仅作兜底
function regionOf(env, tok) {
  const d = (tok && tok.domain) || "";
  if (d.includes("codebuddy.ai") || d.includes("workbuddy.ai")) return "global";
  if (d.includes("codebuddy.cn") || d.includes("copilot.tencent.com") || d.includes("tencent")) return "cn";
  return (env.WB_REGION === "global") ? "global" : "cn";
}
function chatBase(env, tok) { return CHAT_BASE[regionOf(env, tok)]; }
function originReferer(env, tok) { return ORIGIN[regionOf(env, tok)]; }

function jsonError(msg, status, type) {
  status = status || 500; type = type || "internal_error";
  return new Response(JSON.stringify({ error: { message: msg, type: type } }), {
    status: status, headers: { "content-type": "application/json" },
  });
}
async function loadToken(env) {
  const key = env.KV_KEY || "session";
  const raw = await env.WB_TOKENS.get(key);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}
async function saveToken(env, tok) {
  const key = env.KV_KEY || "session";
  await env.WB_TOKENS.put(key, JSON.stringify(tok));
}
function normExpiresAt(v) {
  const n = Number(v) || 0;
  if (n > 1e12) return Math.floor(n / 1000); // 毫秒 -> 秒
  return n;
}
function needsRefresh(tok) {
  if (!tok || !tok.accessToken) return true;
  const exp = normExpiresAt(tok.expiresAt);
  if (exp <= 0) return true;
  return (Math.floor(Date.now() / 1000) + REFRESH_SKEW) >= exp;
}
async function refreshToken(env, tok) {
  if (!tok || !tok.refreshToken) throw new Error("no refreshToken — 需要重新登录导出");
  const url = chatBase(env, tok) + "/v2/plugin/auth/token/refresh";
  const headers = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/plain, */*",
    "X-Requested-With": "XMLHttpRequest",
    "Origin": originReferer(env, tok),
    "Referer": originReferer(env, tok) + "/",
    "User-Agent": CLIENT_UA,
    "X-Refresh-Token": tok.refreshToken,
    "X-Auth-Refresh-Source": "workbuddy",
  };
  if (tok.enterpriseId) headers["X-Enterprise-Id"] = tok.enterpriseId;
  const resp = await fetch(url, { method: "POST", headers: headers });
  if (!resp.ok) {
    const b = await resp.text().catch(() => "");
    throw new Error("refresh 失败 HTTP " + resp.status + ": " + b.slice(0, 200));
  }
  const data = await resp.json().catch(() => null);
  if (!data || !data.accessToken) throw new Error("refresh_failed: 回包无 accessToken — 需重新登录");
  const next = Object.assign({}, tok, {
    accessToken: data.accessToken,
    refreshToken: data.refreshToken || tok.refreshToken,
    domain: data.domain || tok.domain,
    expiresAt: data.expiresIn > 0 ? Math.floor(Date.now() / 1000) + Number(data.expiresIn) : tok.expiresAt,
  });
  await saveToken(env, next);
  return next;
}
async function ensureToken(env) {
  let tok = await loadToken(env);
  if (!tok || !tok.accessToken) throw new Error("未配置 token — 请先设置 WB_TOKENS");
  if (needsRefresh(tok)) tok = await refreshToken(env, tok);
  return tok;
}
function chatHeaders(env, tok) {
  const h = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/plain, */*",
    "X-Requested-With": "XMLHttpRequest",
    "Origin": originReferer(env, tok),
    "Referer": originReferer(env, tok) + "/",
    "User-Agent": CLIENT_UA,
    "X-Product": "SaaS",
  };
  if (tok.accessToken) h["Authorization"] = "Bearer " + tok.accessToken; else h["X-No-Authorization"] = "1";
  if (tok.uid) h["X-User-Id"] = tok.uid; else h["X-No-User-Id"] = "1";
  if (tok.enterpriseId) h["X-Enterprise-Id"] = tok.enterpriseId; else h["X-No-Enterprise-Info"] = "1";
  if (tok.domain) h["X-Domain"] = tok.domain; else h["X-No-Department-Info"] = "1";
  return h;
}
async function handleChat(request, env) {
  let tok;
  try { tok = await ensureToken(env); } catch (e) { return jsonError("token 不可用: " + e.message, 500); }
  let body;
  try { body = await request.json(); } catch (e) { return jsonError("invalid json body", 400, "invalid_request"); }
  if (typeof body.model === "string" && body.model.includes(":")) {
    body.model = body.model.split(":").slice(1).join(":");
  }
  // workbuddy.ai 强制要求首条消息是 system prompt, 否则被安全策略拦截 (code:11128)
  if (!Array.isArray(body.messages) || body.messages.length === 0 || body.messages[0].role !== "system") {
    body.messages = [{ role: "system", content: "You are a helpful assistant." }, ...(body.messages || [])];
  }
  const clientStream = body.stream === true;
  // 上游只支持流式, 强制 stream:true
  body.stream = true;
  const upstreamUrl = chatBase(env, tok) + "/v2/chat/completions";
  const headers = chatHeaders(env, tok);
  const upstreamResp = await fetch(upstreamUrl, {
    method: "POST", headers: headers, body: JSON.stringify(body),
  });

  // 上游错误直接透传
  if (!upstreamResp.ok) {
    const ct = upstreamResp.headers.get("content-type") || "application/json";
    return new Response(upstreamResp.body, {
      status: upstreamResp.status, headers: { "content-type": ct, "cache-control": "no-store" },
    });
  }

  // 客户端也要流式 -> 直接转发 SSE
  if (clientStream) {
    return new Response(upstreamResp.body, {
      status: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-store" },
    });
  }

  // 客户端要非流式 -> 聚合 SSE 成单个 JSON
  const chunks = await aggregateStream(upstreamResp);
  return new Response(JSON.stringify(chunks), {
    status: 200, headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

// 解析 SSE, 聚合成 OpenAI 非流式 chat.completion
async function aggregateStream(resp) {
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let content = "";
  let role = "assistant";
  let model = "";
  let id = "";
  let created = 0;
  let finishReason = null;
  let usage = null;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop();
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const payload = t.slice(5).trim();
      if (payload === "[DONE]") continue;
      let obj;
      try { obj = JSON.parse(payload); } catch (e) { continue; }
      const ch = obj.choices && obj.choices[0];
      if (!ch) continue;
      if (obj.id) id = obj.id;
      if (obj.model) model = obj.model;
      if (obj.created) created = obj.created;
      const d = ch.delta || {};
      if (d.role) role = d.role;
      if (d.content) content += d.content;
      if (ch.finish_reason) finishReason = ch.finish_reason;
      if (obj.usage) usage = obj.usage;
    }
  }
  return {
    id: id || "cmb-agg",
    object: "chat.completion",
    created: created || Math.floor(Date.now() / 1000),
    model: model || "workbuddy",
    choices: [{ index: 0, message: { role: role, content: content }, finish_reason: finishReason || "stop" }],
    usage: usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}
async function handleModels(env) {
  let tok;
  try { tok = await ensureToken(env); } catch (e) { return jsonError("token 不可用: " + e.message, 500); }
  try {
    const mResp = await fetch(chatBase(env, tok) + "/console/enterprises/personal/models", {
      headers: {
        "Authorization": "Bearer " + tok.accessToken,
        "Accept": "application/json",
        "Origin": originReferer(env, tok),
        "Referer": originReferer(env, tok) + "/",
        "User-Agent": CLIENT_UA,
      },
    });
    if (mResp.ok) {
      const data = await mResp.json().catch(() => null);
      if (data && Array.isArray(data.data)) {
        return new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } });
      }
    }
  } catch (e) {}
  const r = regionOf(env, tok);
  const models = r === "global"
    ? [ { id: "deepseek-v3", object: "model", created: 0, owned_by: "workbuddy" } ]
    : [ { id: "deepseek-v4-flash", object: "model", created: 0, owned_by: "workbuddy" },
        { id: "deepseek-v4-flash-0731", object: "model", created: 0, owned_by: "workbuddy" } ];
  const fallback = { object: "list", data: models };
  return new Response(JSON.stringify(fallback), { headers: { "content-type": "application/json" } });
}
async function handle(request, env) {
  const url = new URL(request.url);
  if (url.pathname === "/healthz") {
    const tok = await loadToken(env);
    if (tok && tok.accessToken) return new Response("ok", { status: 200 });
    return new Response("no token", { status: 503 });
  }
  if (env.GATEWAY_API_KEY) {
    const az = request.headers.get("Authorization") || "";
    const key = az.startsWith("Bearer ") ? az.slice(7) : "";
    if (key !== env.GATEWAY_API_KEY) return jsonError("invalid api key", 401, "invalid_api_key");
  }
  if (url.pathname === "/v1/chat/completions" && request.method === "POST") return handleChat(request, env);
  if (url.pathname === "/v1/models" && request.method === "GET") return handleModels(env);
  return jsonError("not found", 404, "not_found");
}
const __env = {
  WB_TOKENS: (typeof WB_TOKENS !== "undefined") ? WB_TOKENS : null,
  WB_REGION: (typeof WB_REGION !== "undefined") ? WB_REGION : "cn",
  KV_KEY: (typeof KV_KEY !== "undefined") ? KV_KEY : "session",
  GATEWAY_API_KEY: (typeof GATEWAY_API_KEY !== "undefined") ? GATEWAY_API_KEY : null,
};
addEventListener("fetch", (event) => {
  event.respondWith(handle(event.request, __env).catch((e) => jsonError(String((e && e.message) || e), 500)));
});
