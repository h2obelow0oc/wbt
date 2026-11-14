import { refreshToken, checkin, fetchCredits, fetchModels, realmOf, normExpires, chatBase, commonHeaders } from "./wb_protocol.js";

// ---------- 工具 ----------
const uuid = () => crypto.randomUUID();
const now = () => Math.floor(Date.now() / 1000);
function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}
function authOk(req, env) {
  const az = req.headers.get("Authorization") || "";
  const key = az.startsWith("Bearer ") ? az.slice(7) : "";
  return env.ADMIN_TOKEN && key === env.ADMIN_TOKEN;
}
function apiKeyOk(req, env) {
  const az = req.headers.get("Authorization") || "";
  const key = az.startsWith("Bearer ") ? az.slice(7) : "";
  if (!key) return null;
  return key; // 下游 key，查库校验在调用处
}

// ---------- 账号存储 ----------
async function getAccounts(db) {
  const { results } = await db.prepare("SELECT * FROM accounts").all();
  return results.map(rowToAccount);
}
function rowToAccount(r) {
  return { id: r.id, uid: r.uid, realm: r.realm, domain: r.domain, nickname: r.nickname,
    access_token: r.access_token, refresh_token: r.refresh_token, expires_at: r.expires_at,
    enabled: !!r.enabled, models: JSON.parse(r.models || "[]"), created_at: r.created_at };
}
async function saveAccount(db, acc) {
  await db.prepare(
    `INSERT OR REPLACE INTO accounts (id,uid,realm,domain,nickname,access_token,refresh_token,expires_at,enabled,models,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(acc.id, acc.uid, acc.realm, acc.domain, acc.nickname, acc.access_token,
    acc.refresh_token, acc.expires_at, acc.enabled ? 1 : 0, JSON.stringify(acc.models), acc.created_at).run();
}
async function getAccount(db, id) {
  const r = await db.prepare("SELECT * FROM accounts WHERE id=?").bind(id).first();
  return r ? rowToAccount(r) : null;
}

// 从导入的 json 提取账号(s)
function parseAccountFile(text) {
  let data;
  try { data = JSON.parse(text); } catch (e) { throw new Error("JSON 解析失败"); }
  // 支持数组 / 单对象 / {accounts:[...]}
  let arr = [];
  if (Array.isArray(data)) arr = data;
  else if (Array.isArray(data.accounts)) arr = data.accounts;
  else arr = [data];
  const out = [];
  for (const x of arr) {
    const at = x.access_token || x.accessToken || (x.auth && (x.auth.access_token || x.auth.accessToken));
    const rt = x.refresh_token || x.refreshToken || (x.auth && (x.auth.refresh_token || x.auth.refreshToken));
    const domain = x.domain || (x.auth && x.auth.domain) || (realmOf({ domain: x.domain }) === "global" ? "www.workbuddy.ai" : "www.codebuddy.cn");
    const uid = x.uid || (x.auth && x.auth.uid) || "";
    const exp = x.expires_at || x.expiresAt || (x.auth && (x.auth.expires_at || x.auth.expiresAt));
    if (!at) continue;
    out.push({
      id: uuid(), uid, realm: realmOf({ domain }), domain, nickname: x.nickname || x.name || "",
      access_token: at, refresh_token: rt || "", expires_at: normExpires(exp) || now() + 3600,
      enabled: 1, models: [], created_at: now(),
    });
  }
  if (!out.length) throw new Error("未找到任何含 access_token 的账号");
  return out;
}

// ---------- API key ----------
function genApiKey() {
  const rnd = (n) => Array.from(crypto.getRandomValues(new Uint8Array(n))).map(b => b.toString(16).padStart(2, "0")).join("");
  return "sk-wb-" + rnd(24);
}
async function getKeys(db) {
  const { results } = await db.prepare("SELECT * FROM apikeys ORDER BY created_at DESC").all();
  return results.map(r => ({ ...r, account_ids: JSON.parse(r.account_ids || "[]") }));
}

// ---------- 任务日志 / 额度快照 ----------
async function logTask(db, type, account_id, ok, msg) {
  await db.prepare("INSERT INTO task_log (type,account_id,at,ok,msg) VALUES (?,?,?,?,?)")
    .bind(type, account_id, now(), ok ? 1 : 0, String(msg || "").slice(0, 500)).run();
}

// ---------- 路由 ----------
async function handleApi(request, env, url) {
  const db = env.DB;
  const p = url.pathname.replace(/^\/api\//, "").replace(/\/$/, "");
  const method = request.method;

  if (!authOk(request, env) && p !== "v1/models" && p !== "v1/chat/completions" && !p.startsWith("v1/")) {
    return json({ error: "unauthorized" }, 401);
  }

  // 公开代理面 (下游 key)
  if (p === "v1/models" || p === "v1/chat/completions") {
    return handleProxy(request, env, p);
  }

  // 导入账号 (粘贴 or 文件上传)
  if (p === "accounts/import" && method === "POST") {
    const ct = request.headers.get("content-type") || "";
    let text = "";
    if (ct.includes("multipart/form-data")) {
      const form = await request.formData();
      const file = form.get("file");
      text = file ? await file.text() : (form.get("json") || "");
    } else {
      const body = await request.json().catch(() => ({}));
      text = body.json || body.text || "";
    }
    const accs = parseAccountFile(text);
    for (const a of accs) await saveAccount(db, a);
    return json({ ok: true, imported: accs.length, ids: accs.map(a => a.id) });
  }

  if (p === "accounts" && method === "GET") {
    const accs = await getAccounts(db);
    // 附额度快照
    for (const a of accs) {
      const sn = await db.prepare("SELECT * FROM credits_snap WHERE account_id=?").bind(a.id).first();
      a.credits = sn ? sn.credits : null; a.credits_at = sn ? sn.at : null;
      a.expiries = sn ? JSON.parse(sn.expiries || "[]") : [];
      a.token_expired = a.expires_at < now();
    }
    return json({ ok: true, accounts: accs });
  }

  if (p === "accounts/refresh" && method === "POST") {
    const { id } = await request.json();
    const acc = await getAccount(db, id); if (!acc) return json({ error: "no account" }, 404);
    try {
      const upd = await refreshToken(acc);
      acc.access_token = upd.access_token; acc.refresh_token = upd.refresh_token; acc.expires_at = upd.expires_at;
      await saveAccount(db, acc);
      return json({ ok: true, expires_at: acc.expires_at });
    } catch (e) { return json({ ok: false, msg: String(e) }, 500); }
  }

  if (p === "accounts/checkin" && method === "POST") {
    const { id } = await request.json();
    const acc = await getAccount(db, id); if (!acc) return json({ error: "no account" }, 404);
    const r = await checkin(acc);
    await logTask(db, "checkin", id, r.code === 0 || r.code === 10001 || r.status === 200, r.msg);
    return json({ ok: r.code === 0 || r.code === 10001 || r.status === 200, ...r });
  }

  if (p === "accounts/credits" && method === "POST") {
    const { id } = await request.json();
    const acc = await getAccount(db, id); if (!acc) return json({ error: "no account" }, 404);
    const r = await fetchCredits(acc);
    if (r.ok) {
      await db.prepare("INSERT OR REPLACE INTO credits_snap VALUES (?,?,?,?)")
        .bind(id, now(), r.credits, JSON.stringify(r.expiries)).run();
    }
    await logTask(db, "credits", id, r.ok, r.msg);
    return json({ ok: r.ok, credits: r.credits, expiries: r.expiries, msg: r.msg });
  }

  if (p === "accounts/credits-all" && method === "POST") {
    const accs = await getAccounts(db);
    const out = [];
    for (const acc of accs) {
      const r = await fetchCredits(acc);
      if (r.ok) await db.prepare("INSERT OR REPLACE INTO credits_snap VALUES (?,?,?,?)")
        .bind(acc.id, now(), r.credits, JSON.stringify(r.expiries)).run();
      await logTask(db, "credits", acc.id, r.ok, r.msg);
      out.push({ id: acc.id, uid: acc.uid, ok: r.ok, credits: r.credits, msg: r.msg });
    }
    const sum = out.filter(o => o.ok).reduce((s, o) => s + (o.credits || 0), 0);
    return json({ ok: true, results: out, total: sum });
  }

  if (p === "accounts/models" && method === "POST") {
    const { id } = await request.json();
    const acc = await getAccount(db, id); if (!acc) return json({ error: "no account" }, 404);
    const r = await fetchModels(acc);
    return json(r);
  }

  if (p === "accounts/models-save" && method === "POST") {
    const { id, models } = await request.json();
    const acc = await getAccount(db, id); if (!acc) return json({ error: "no account" }, 404);
    acc.models = models || [];
    await saveAccount(db, acc);
    return json({ ok: true });
  }

  if (p === "accounts/enable" && method === "POST") {
    const { id, enabled } = await request.json();
    await db.prepare("UPDATE accounts SET enabled=? WHERE id=?").bind(enabled ? 1 : 0, id).run();
    return json({ ok: true });
  }

  if (p === "accounts/delete" && method === "POST") {
    const { id } = await request.json();
    await db.prepare("DELETE FROM accounts WHERE id=?").bind(id).run();
    return json({ ok: true });
  }

  // ---- API key 管理 ----
  if (p === "keys" && method === "GET") {
    return json({ ok: true, keys: await getKeys(db) });
  }
  if (p === "keys/create" && method === "POST") {
    const b = await request.json().catch(() => ({}));
    const k = { id: uuid(), apikey: genApiKey(), name: b.name || "", account_ids: b.account_ids || [], enabled: 1, created_at: now(), note: b.note || "" };
    await db.prepare("INSERT INTO apikeys VALUES (?,?,?,?,?,?,?)")
      .bind(k.id, k.apikey, k.name, JSON.stringify(k.account_ids), 1, k.created_at, k.note).run();
    return json({ ok: true, key: k });
  }
  if (p === "keys/update" && method === "POST") {
    const b = await request.json();
    await db.prepare("UPDATE apikeys SET name=?,account_ids=?,enabled=?,note=? WHERE id=?")
      .bind(b.name || "", JSON.stringify(b.account_ids || []), b.enabled ? 1 : 0, b.note || "", b.id).run();
    return json({ ok: true });
  }
  if (p === "keys/delete" && method === "POST") {
    const { id } = await request.json();
    await db.prepare("DELETE FROM apikeys WHERE id=?").bind(id).run();
    return json({ ok: true });
  }
  if (p === "keys/clear" && method === "POST") {
    await db.prepare("DELETE FROM apikeys").run();
    return json({ ok: true });
  }

  if (p === "logs" && method === "GET") {
    const { results } = await db.prepare("SELECT * FROM task_log ORDER BY at DESC LIMIT 200").all();
    return json({ ok: true, logs: results });
  }

  return json({ error: "not found" }, 404);
}

// ---------- 下游代理 (v1) ----------
async function handleProxy(request, env, p) {
  const db = env.DB;
  const key = apiKeyOk(request, env);
  const krow = key ? await db.prepare("SELECT * FROM apikeys WHERE apikey=?").bind(key).first() : null;
  if (!krow || !krow.enabled) return json({ error: "invalid or disabled api key" }, 401);
  // 选账号: key 指定 or 全部启用
  const allowed = JSON.parse(krow.account_ids || "[]");
  const accs = (await getAccounts(db)).filter(a => a.enabled && (allowed.length === 0 || allowed.includes(a.id)));
  if (!accs.length) return json({ error: "no available account" }, 503);
  const acc = accs[Math.floor(Math.random() * accs.length)];
  if (p === "v1/models") {
    const r = await fetchModels(acc);
    return json({ object: "list", data: r.models.map(m => ({ id: m.id, object: "model", owned_by: "workbuddy", multiplier: m.multiplier })) });
  }
  // chat: 转发上游
  let body = await request.json().catch(() => ({}));
  body.stream = true;
  const r = await fetch(chatBase(acc) + "/v2/chat/completions", {
    method: "POST", headers: commonHeaders(acc, acc.access_token), body: JSON.stringify(body),
  });
  return new Response(r.body, { status: r.status, headers: { "content-type": r.headers.get("content-type") || "text/event-stream" } });
}

// ---------- cron ----------
async function runCron(env) {
  const db = env.DB;
  const accs = await getAccounts(db);
  const log = [];
  for (const acc of accs) {
    if (!acc.enabled) continue;
    // 保活: 过期前 3 天刷新
    if (acc.expires_at < now() + 3 * 86400) {
      try { const u = await refreshToken(acc); acc.access_token = u.access_token; acc.refresh_token = u.refresh_token; acc.expires_at = u.expires_at; await saveAccount(db, acc); await logTask(db, "keepalive", acc.id, true, "refreshed"); log.push(acc.uid + ":keepalive ok"); }
      catch (e) { await logTask(db, "keepalive", acc.id, false, String(e).slice(0, 200)); }
    }
    // 签到
    try { const r = await checkin(acc); await logTask(db, "checkin", acc.id, r.code === 0 || r.code === 10001, r.msg); log.push(acc.uid + ":checkin " + r.msg); }
    catch (e) { await logTask(db, "checkin", acc.id, false, String(e).slice(0, 200)); }
  }
  return log;
}

// ---------- 入口 ----------
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/healthz") return new Response("ok");
    if (url.pathname.startsWith("/api/")) return handleApi(request, env, url);
    if (url.pathname === "/") return new Response(UI, { headers: { "content-type": "text/html; charset=utf-8" } });
    return new Response("WorkBuddy Manager", { status: 404 });
  },
  async scheduled(event, env) {
    const log = await runCron(env);
    return new Response(JSON.stringify(log));
  },
};

import { UI } from "./ui.js";
