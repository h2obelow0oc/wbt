import { refreshToken, checkin, fetchCredits, fetchModels, realmOf, normExpires, chatBase, commonHeaders, neutralizeSystemMessages, wbNeutralizeAllPaths } from "./wb_protocol.js";
import { UI } from "./ui.js";
import { serializeBuddyMessages } from "./serialize-buddy.mjs";

// ===== KV 存储层 (classic worker 不支持 D1, 用 KV 代替) =====
// 键: idx_accounts=JSON id数组; acc:<id>=账号; idx_keys=JSON数组; key:<id>=key; snap:<id>=额度; logs=JSON数组
const K = {
  idxA: "idx_accounts", idxK: "idx_keys", logs: "logs", pubreq: "pubreq", setting: "setting",
  hidden: "model_hidden", acc: id => "acc:" + id, key: id => "key:" + id, snap: id => "snap:" + id,
};
async function kvGet(k, d = null) { const v = await KV.get(k); if (v == null) return d; try { return JSON.parse(v); } catch { return d; } }
async function kvPut(k, v) { await KV.put(k, JSON.stringify(v)); }
async function kvDel(k) { await KV.delete(k); }

const uuid = () => crypto.randomUUID();
const now = () => Math.floor(Date.now() / 1000);
function json(d, s = 200) { return new Response(JSON.stringify(d), { status: s, headers: { "content-type": "application/json" } }); }
function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Requested-With",
    "Access-Control-Max-Age": "86400",
  };
}

function authOk(req) {
  const az = req.headers.get("Authorization") || "";
  if (az.startsWith("Bearer ")) { const k = az.slice(7); return ADMIN_TOKEN && k === ADMIN_TOKEN; }
  // 也接受会话 cookie
  const c = req.headers.get("Cookie") || "";
  const m = c.match(/wbsess=([0-9a-f]+)/);
  if (m) return sessValid(m[1]);
  return false;
}
// 管理令牌不落明文体: cookie 存其 sha256; 比对时用同样哈希
async function sha256(s) { const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))); return Array.from(d).map(b => b.toString(16).padStart(2, "0")).join(""); }
async function sessValid(hash) { const target = await sha256(ADMIN_TOKEN); return hash === target; }
function getCookie(req, name) { const c = req.headers.get("Cookie") || ""; const m = c.match(new RegExp(name + "=([^;]+)")); return m ? m[1] : ""; }
function apiKeyOf(req) {
  let az = (req.headers.get("Authorization") || "").trim();
  if (!az) az = (req.headers.get("X-Api-Key") || req.headers.get("x-api-key") || req.headers.get("Api-Key") || req.headers.get("api-key") || "").trim();
  if (!az) { try { az = new URL(req.url).searchParams.get("key") || ""; } catch {} }
  // 去掉可能重复的 Bearer 前缀与首尾空白 (客户端兼容)
  az = az.replace(/^(?:Bearer\s+)+/i, "").trim();
  return az || null;
}
// 记录公开代理请求 (排查客户端接入): 只存鉴权形状/指纹, 不存明文 key
async function logPubReq(req, p) {
  try {
    const az = req.headers.get("Authorization") || "";
    const raw = az.startsWith("Bearer ") ? az.slice(7).trim() : az.trim();
    let shape, fp = "", klen = 0;
    if (raw) {
      klen = raw.length;
      fp = (await sha256(raw)).slice(0, 8);
      shape = (az.startsWith("Bearer ") ? "bearer:" : "raw:") + raw.slice(0, 12) + "…";
    } else shape = "none";
    const logs = await kvGet(K.pubreq, []);
    logs.unshift({ at: now(), p, m: req.method, auth: shape, klen, fp, ua: (req.headers.get("User-Agent") || "").slice(0, 60) });
    await kvPut(K.pubreq, logs.slice(0, 50));
  } catch {}
}

// 账号
async function getAccounts() {
  const ids = await kvGet(K.idxA, []);
  const out = [];
  for (const id of ids) { const a = await kvGet(K.acc(id)); if (a) out.push(a); }
  return out;
}
async function getAccount(id) { return kvGet(K.acc(id)); }
async function saveAccount(acc) {
  const ids = await kvGet(K.idxA, []);
  if (!ids.includes(acc.id)) ids.push(acc.id);
  await kvPut(K.idxA, ids); await kvPut(K.acc(acc.id), acc);
}
async function delAccount(id) {
  const ids = (await kvGet(K.idxA, [])).filter(x => x !== id);
  await kvPut(K.idxA, ids); await kvDel(K.acc(id)); await kvDel(K.snap(id));
}
async function getKeys() { const ids = await kvGet(K.idK, []); const out = []; for (const id of ids) { const k = await kvGet(K.key(id)); if (k) out.push(k); } return out; }
async function saveKey(k) { const ids = await kvGet(K.idK, []); if (!ids.includes(k.id)) ids.push(k.id); await kvPut(K.idK, ids); await kvPut(K.key(k.id), k); }
async function delKey(id) { const ids = (await kvGet(K.idK, [])).filter(x => x !== id); await kvPut(K.idK, ids); await kvDel(K.key(id)); }
async function logTask(type, account_id, ok, msg) {
  const logs = await kvGet(K.logs, []);
  logs.unshift({ type, account_id, at: now(), ok: ok ? 1 : 0, msg: String(msg || "").slice(0, 400) });
  await kvPut(K.logs, logs.slice(0, 300));
}

// 解析导入 JSON
function parseAccountFile(text) {
  let data; try { data = JSON.parse(text); } catch { throw new Error("JSON 解析失败"); }
  let arr = Array.isArray(data) ? data : Array.isArray(data.accounts) ? data.accounts : [data];
  const out = [];
  for (const x of arr) {
    const at = x.access_token || x.accessToken || (x.auth && (x.auth.access_token || x.auth.accessToken));
    const rt = x.refresh_token || x.refreshToken || (x.auth && (x.auth.refresh_token || x.auth.refreshToken));
    const domain = x.domain || (x.auth && x.auth.domain) || ((x.realm === "global") ? "www.workbuddy.ai" : "www.codebuddy.cn");
    const uid = x.uid || (x.auth && x.auth.uid) || "";
    const exp = x.expires_at || x.expiresAt || (x.auth && (x.auth.expires_at || x.auth.expiresAt));
    if (!at) continue;
    out.push({ id: uuid(), uid, realm: realmOf({ domain }), domain, nickname: x.nickname || x.name || "",
      access_token: at, refresh_token: rt || "", expires_at: normExpires(exp) || now() + 3600,
      enabled: 1, models: [], created_at: now() });
  }
  if (!out.length) throw new Error("未找到任何含 access_token 的账号");
  return out;
}
function genApiKey() { const rnd = n => Array.from(crypto.getRandomValues(new Uint8Array(n))).map(b => b.toString(16).padStart(2, "0")).join(""); return "sk-wb-" + rnd(24); }

// ===== 路由 =====
async function handleApi(request, url) {
  const p = url.pathname.replace(/^\/api\//, "").replace(/\/$/, "");
  const method = request.method;
  const isPub = p === "v1/models" || p === "v1/chat/completions";
  // 登录: 校验管理令牌, 种会话 cookie (存 sha256, 不明文)
  if (p === "login" && method === "POST") {
    const b = await request.json().catch(() => ({}));
    if (!ADMIN_TOKEN || b.token !== ADMIN_TOKEN) return json({ ok: false, error: "令牌错误" }, 401);
    const hash = await sha256(ADMIN_TOKEN);
    return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json", "Set-Cookie": "wbsess=" + hash + "; Path=/; HttpOnly; SameSite=Lax; Max-Age=864000" } });
  }
  if (p === "logout" && method === "POST") {
    return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json", "Set-Cookie": "wbsess=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0" } });
  }
  if (!authOk(request) && !isPub) return json({ error: "unauthorized" }, 401);
  if (isPub) return handleProxy(request, p);
  // 惰性保活: 每类写操作前顺手刷新 7 天内快过期的 token (不阻断主请求)
  lazyKeepalive().catch(e => {});

  if (p === "accounts/import" && method === "POST") {
    const ct = request.headers.get("content-type") || "";
    let text = "";
    if (ct.includes("multipart/form-data")) {
      const form = await request.formData(); const file = form.get("file");
      text = file ? await file.text() : (form.get("json") || "");
    } else { const b = await request.json().catch(() => ({})); text = b.json || b.text || ""; }
    try { const accs = parseAccountFile(text); for (const a of accs) await saveAccount(a);
      return json({ ok: true, imported: accs.length, ids: accs.map(a => a.id) }); }
    catch (e) { return json({ ok: false, msg: String(e.message || e) }, 400); }
  }
  if (p === "accounts" && method === "GET") {
    const accs = await getAccounts();
    for (const a of accs) {
      const sn = await kvGet(K.snap(a.id));
      a.credits = sn ? sn.credits : null; a.credits_at = sn ? sn.at : null;
      a.expiries = sn ? (sn.expiries || []) : []; a.token_expired = a.expires_at < now();
      // 不在前端暴露完整 token, 仅留脱敏头与是否存在标记
      a.token_head = (a.access_token || "").slice(0, 18) + "…";
      delete a.access_token; delete a.refresh_token;
    }
    return json({ ok: true, accounts: accs });
  }
  if (p === "accounts/refresh" && method === "POST") {
    const { id } = await request.json(); const acc = await getAccount(id); if (!acc) return json({ error: "no account" }, 404);
    try { const u = await refreshToken(acc); acc.access_token = u.access_token; acc.refresh_token = u.refresh_token; acc.expires_at = u.expires_at; await saveAccount(acc); return json({ ok: true, expires_at: acc.expires_at }); }
    catch (e) { return json({ ok: false, msg: String(e.message || e) }, 500); }
  }
  if (p === "accounts/checkin" && method === "POST") {
    const { id } = await request.json(); const acc = await getAccount(id); if (!acc) return json({ error: "no account" }, 404);
    const r = await checkin(acc); await logTask("checkin", id, r.code === 0 || r.code === 10001 || r.status === 200, r.msg);
    return json({ ok: r.code === 0 || r.code === 10001 || r.status === 200, ...r });
  }
  if (p === "accounts/credits" && method === "POST") {
    const { id } = await request.json(); const acc = await getAccount(id); if (!acc) return json({ error: "no account" }, 404);
    const r = await fetchCredits(acc);
    if (r.ok) await kvPut(K.snap(id), { at: now(), credits: r.credits, expiries: r.expiries });
    await logTask("credits", id, r.ok, r.msg); return json({ ok: r.ok, credits: r.credits, expiries: r.expiries, msg: r.msg });
  }
  if (p === "accounts/credits-all" && method === "POST") {
    const accs = await getAccounts(); const out = [];
    for (const acc of accs) { const r = await fetchCredits(acc);
      if (r.ok) await kvPut(K.snap(acc.id), { at: now(), credits: r.credits, expiries: r.expiries });
      await logTask("credits", acc.id, r.ok, r.msg);
      out.push({ id: acc.id, uid: acc.uid, ok: r.ok, credits: r.credits, msg: r.msg }); }
    const sum = out.filter(o => o.ok).reduce((s, o) => s + (o.credits || 0), 0);
    return json({ ok: true, results: out, total: sum });
  }
  if (p === "accounts/models" && method === "POST") {
    const { id } = await request.json(); const acc = await getAccount(id); if (!acc) return json({ error: "no account" }, 404);
    const r = await fetchModels(acc); r.saved = acc.models || []; return json(r);
  }
  if (p === "accounts/models-save" && method === "POST") {
    const { id, models } = await request.json(); const acc = await getAccount(id); if (!acc) return json({ error: "no account" }, 404);
    acc.models = models || []; await saveAccount(acc); return json({ ok: true });
  }
  if (p === "accounts/enable" && method === "POST") {
    const { id, enabled } = await request.json(); const acc = await getAccount(id); if (!acc) return json({ error: "no account" }, 404);
    acc.enabled = enabled ? 1 : 0; await saveAccount(acc); return json({ ok: true });
  }
  // 「自动签到」勾选（与 Render 版 index_turso.js 对等；UI 两版共用）。
  if (p === "accounts/auto-checkin" && method === "POST") {
    const { id, auto } = await request.json(); const acc = await getAccount(id); if (!acc) return json({ error: "no account" }, 404);
    acc.auto_checkin = auto ? 1 : 0; await saveAccount(acc); return json({ ok: true });
  }
  // 账号字段修补: uid/nickname/domain 等 (uid 缺失会导致上游发 X-No-User-Id,
  // 国际版渠道校验更容易拦; 面板 token 导入链路曾丢 uid, 用此端点补齐)
  if (p === "accounts/patch" && method === "POST") {
    const b = await request.json(); const acc = await getAccount(b.id); if (!acc) return json({ error: "no account" }, 404);
    for (const f of ["uid", "nickname", "domain"]) if (typeof b[f] === "string") acc[f] = b[f];
    if (typeof acc.uid !== "string") acc.uid = "";
    await saveAccount(acc); return json({ ok: true, account: { id: acc.id, uid: acc.uid, domain: acc.domain } });
  }
  if (p === "accounts/delete" && method === "POST") {
    const { id } = await request.json(); await delAccount(id); return json({ ok: true });
  }
  if (p === "keys" && method === "GET") return json({ ok: true, keys: await getKeys() });
  if (p === "keys/create" && method === "POST") {
    const b = await request.json().catch(() => ({}));
    const k = { id: uuid(), apikey: genApiKey(), name: b.name || "", account_ids: b.account_ids || [], enabled: 1, created_at: now(), note: b.note || "" };
    await saveKey(k); return json({ ok: true, key: k });
  }
  if (p === "keys/update" && method === "POST") {
    const b = await request.json(); const k = await getKey(b.id); if (!k) return json({ error: "no key" }, 404);
    if (typeof b.name !== "undefined") k.name = b.name;
    if (typeof b.account_ids !== "undefined") k.account_ids = b.account_ids;
    if (typeof b.enabled !== "undefined") k.enabled = b.enabled ? 1 : 0;
    if (typeof b.note !== "undefined") k.note = b.note;
    await saveKey(k); return json({ ok: true });
  }
  if (p === "keys/delete" && method === "POST") { const { id } = await request.json(); await delKey(id); return json({ ok: true }); }
  if (p === "keys/clear" && method === "POST") { const ids = await kvGet(K.idK, []); for (const id of ids) await kvDel(K.key(id)); await kvPut(K.idK, []); return json({ ok: true }); }
  if (p === "logs" && method === "GET") return json({ ok: true, logs: await kvGet(K.logs, []) });
  if (p === "publog" && method === "GET") return json({ ok: true, logs: await kvGet(K.pubreq, []) });
  if (p === "setting/get" && method === "GET") return json({ ok: true, setting: await getSetting() });
  if (p === "setting/save" && method === "POST") { const b = await request.json().catch(() => ({})); const cur = await getSetting(); const setting = { ...cur, ...b }; await kvPut(K.setting, setting); return json({ ok: true, setting }); }
  if (p === "models/agg" && method === "POST") {
    const b = await request.json().catch(() => ({}));
    const accs = (await getAccounts()).filter(a => a.enabled);
    const hidden = await getHiddenSet();
    const { rows } = await aggModels(accs, "agg_models_v4", !!b.force);
    // 展开成与 /v1/models 相同的行: 同名模型国内/国际各一条
    // 与 /v1/models 一致: 禁用账号贡献的 realm 不展示 (hasGlobal 保真面板数据)
    const hasAnyCn2 = accs.some(a => realmOf(a) === "cn");
    const hasAnyGlobal2 = accs.some(a => realmOf(a) === "global");
    const out = [];
    for (const m of rows) {
      const hasCn = hasAnyCn2 && m.realms.includes("cn"), hasGlobal = hasAnyGlobal2 && m.realms.includes("global");
      // 各 realm 行铺平自己的倍率/折扣/名字/上下文 (与 /v1/models 同一套 byRealm 语义)
      if (hasCn && hasGlobal) { out.push({ ...m, ...(m.byRealm.cn || {}), srcTag: "", hidden: !!hidden[m.id] }); out.push({ ...m, ...(m.byRealm.global || {}), srcTag: "g", hidden: !!hidden[m.id] }); }
      else if (hasCn) out.push({ ...m, ...(m.byRealm.cn || {}), srcTag: "", hidden: !!hidden[m.id] });
      else if (hasGlobal) out.push({ ...m, ...(m.byRealm.global || {}), srcTag: "g", hidden: !!hidden[m.id] });
    }
    return json({ ok: true, models: out.map(m => ({ id: m.id, name: m.name, multiplier: m.multiplier, discounted: m.discounted, context: m.context, srcTag: m.srcTag, realm: m.srcTag === "g" ? "global" : "cn", hidden: m.hidden, hasGlobal: m.realms.includes("global") })) });
  }
  if (p === "models/hidden-get" && method === "GET") return json({ ok: true, hidden: await getHiddenSet() });
  if (p === "models/hidden-save" && method === "POST") { const b = await request.json().catch(() => ({})); const h = {}; for (const id of (b.hidden || [])) if (typeof id === "string" && id) h[id] = 1; await kvPut(K.hidden, h); return json({ ok: true, hidden: h }); }
  // 一键探测各模型真实上游上下文窗口: 逐个账号查 /v3/config, 取 maxInputTokens。
  // 返回 { ok, windows: { [modelId]: { context, realm, source } }, capped: { [modelId]: cap } }
  // cap = 该模型护栏有效上限(min(REASONABLE_CAP, 真实窗口)); 未知窗口不在此列。
  if (p === "models/windows" && method === "POST") {
    const windows = {};
    const capped = {};
    for (const a of accs) {
      const r = await fetchModels(a).catch(() => ({ models: [] }));
      for (const m of (r.models || [])) {
        if (!m.id || isPlaceholderModel(m.id)) continue;
        if (!windows[m.id]) windows[m.id] = { context: m.context || null, realm: realmOf(a), source: "v3/config" };
        else if (windows[m.id].context == null && m.context) windows[m.id].context = m.context;
        if (m.context) capped[m.id] = cgEffectiveCeiling(m.context);
      }
    }
    return json({ ok: true, windows, capped, reasonableCap: CG_REASONABLE_CAP });
  }
  if (p === "run-cron" && method === "POST") { const log = await runCron(); return json({ ok: true, log }); }
  return json({ error: "not found" }, 404);
}
async function getKey(id) { return kvGet(K.key(id)); }
// 全局设置: { modelWithRate: 0|1 } —— 是否在对外 /v1/models 的 id 上拼倍率注释
async function getSetting() { return kvGet(K.setting, { modelWithRate: 0 }); }
// 全局模型隐藏集合: 存「被用户隐藏的模型 id」(不是启用集合), 新模型默认出现, 不用每次来加
async function getHiddenSet() { return kvGet(K.hidden, {}); }
// 聚合全部账号模型: 按 id 去重, 记录每个模型出现的 realm(cn/global); KV 缓存 5 分钟防抖动
async function aggModels(accs, cacheKey, force) {
  let rows = null, owner = null;
  if (cacheKey && !force) {
    const cached = await kvGet(cacheKey, null);
    if (cached && cached.at > now() - 300) { rows = cached.map; owner = cached.owner; }
  }
  if (!rows || !owner) {
    const byId = new Map(); owner = {};
    for (const a of accs) {
      const r = await fetchModels(a).catch(() => ({ models: [] }));
      const realm = realmOf(a);
      for (const m of (r.models || [])) {
        if (isPlaceholderModel(m.id)) continue; // 过滤 default-model 等占位
        // 倍率/折扣按 realm 各存一份: 同名模型 CN/国际价格经常不同
        // (如 deepseek-v4.1-flash CN=x0.11, 国际=免费促销)。旧版全局只留
        // 首个非空倍率, 先扫到 CN 就把国际的 x0.00+免费 吞掉 → 展示错价。
        const meta = { multiplier: m.multiplier, discounted: m.discounted, name: m.name, context: m.context };
        const prev = byId.get(m.id);
        if (!prev) byId.set(m.id, { id: m.id, maxOutput: m.maxOutput, supportsImages: m.supportsImages, realms: [realm], owners: [a.id], byRealm: { [realm]: meta } });
        else {
          if (!prev.realms.includes(realm)) prev.realms.push(realm);
          if (!prev.owners.includes(a.id)) prev.owners.push(a.id);
          prev.byRealm = prev.byRealm || {};
          if (!prev.byRealm[realm]) prev.byRealm[realm] = meta;
          else if (!prev.byRealm[realm].multiplier && meta.multiplier) prev.byRealm[realm] = meta; // 同 realm 多账号: 取首个有倍率的
        }
        (owner[m.id] = owner[m.id] || []).push(a.id);
      }
    }
    rows = [...byId.values()];
    if (cacheKey && rows.length) await kvPut(cacheKey, { at: now(), map: rows, owner });
  }
  return { rows, owner };
}
function decorateModelIdSync(m, s) {
  // 把倍率/折扣拼进 id, 让只渲染 id 的客户端也能看到倍率注释
  // m.srcTag="g" 表示国际来源 (同名模型复制出 g 那条, 供用户区分国内/国际分别选用)
  if (!s || !s.modelWithRate) return m.id;
  const parts = [];
  if (m.discounted) parts.push(m.discounted === "免费" ? "免费" : (m.discounted + "折"));
  else if (m.multiplier) parts.push(m.multiplier);
  if (m.srcTag) parts.push(m.srcTag); // g = 国际来源标记
  return parts.length ? (m.id + " [" + parts.join("/") + "]") : m.id;
}
function decorateModelNameSync(m, s) {
  // 把倍率/折扣拼进 name, 让只渲染 name 的客户端 (如 dsh) 也能看到倍率注释
  // 与 decorateModelIdSync 不同: name 始终带倍率, 不受 modelWithRate 开关控制
  // (开关只管 id; dsh 读 name, 关了开关 dsh 就看不到倍率了)
  const parts = [];
  if (m.discounted) parts.push(m.discounted === "免费" ? "免费" : (m.discounted + "折"));
  else if (m.multiplier) parts.push(m.multiplier);
  if (m.srcTag) parts.push(m.srcTag === "g" ? "国际" : m.srcTag);
  return parts.length ? (m.name + " [" + parts.join("/") + "]") : m.name;
}
function stripModelId(id) {
  // 对话前剥掉 ' [...]$' 后缀, 还原真实模型 id 与来源标记 (g=国际)
  const i = id.indexOf(" [");
  const clean = i >= 0 ? id.slice(0, i) : id;
  const srcTag = (i >= 0 && /\[[^\]]*\bg\b[^\]]*\]/.test(id)) ? "g" : "";
  return { id: clean, srcTag };
}
function isPlaceholderModel(id) {
  // global 账号 /v3/config 里存在一批无真实供应商的占位模型 (带 -model 后缀), 对外暴露会污染列表
  // 注意: CN 的裸 'default' (x2.00) 是真模型, 不在此列
  return /^(default|fast|balanced|primary|deep)-model$/.test(id);
}

// 下游代理
async function handleProxy(request, p) {
  await logPubReq(request, p);
  const key = apiKeyOf(request); const krow = key ? await getKeyByValue(key) : null;
  if (!krow || !krow.enabled) return new Response(JSON.stringify({ error: { message: "invalid or disabled api key", type: "invalid_api_key", code: "invalid_api_key" } }), { status: 401, headers: { "content-type": "application/json", ...corsHeaders() } });
  const allowed = krow.account_ids || [];
  const accs = (await getAccounts()).filter(a => a.enabled && (allowed.length === 0 || allowed.includes(a.id)));
  if (!accs.length) return new Response(JSON.stringify({ error: "no available account" }), { status: 503, headers: { "content-type": "application/json", ...corsHeaders() } });
  const acc = accs[Math.floor(Math.random() * accs.length)];
  if (p === "v1/models") {
    const s = await getSetting();
    const hidden = await getHiddenSet(); // 用户隐藏的模型 (存隐藏集合, 新模型默认出现)
    const { rows: merged } = await aggModels(accs, "agg_models_v4");
    // 展开: 两边都有 -> 国内条(无 g) + 国际条(g); 单边 -> 仅对应条 (global 加 g)
    // 只显示启用账号可达的 realm: 禁用账号贡献的 realm 不再出现,
    // 避免客户端选了 [g] 模型却无账号可用 (计划下线国际版时列表不再误导)
    const hasAnyCn = accs.some(a => realmOf(a) === "cn");
    const hasAnyGlobal = accs.some(a => realmOf(a) === "global");
    const rows = [];
    for (const m of merged) {
      if (hidden[m.id]) continue; // 用户显式隐藏此模型 (两个来源都不显示)
      const hasCn = hasAnyCn && m.realms.includes("cn"), hasGlobal = hasAnyGlobal && m.realms.includes("global");
      // 各 realm 行铺平自己的倍率/折扣/名字/上下文 (byRealm 见 aggModels)
      if (hasCn && hasGlobal) { rows.push({ ...m, ...(m.byRealm.cn || {}), srcTag: "" }); rows.push({ ...m, ...(m.byRealm.global || {}), srcTag: "g" }); }
      else if (hasCn) rows.push({ ...m, ...(m.byRealm.cn || {}), srcTag: "" });
      else if (hasGlobal) rows.push({ ...m, ...(m.byRealm.global || {}), srcTag: "g" });
    }
    // 每个模型的护栏有效上限(min(REASONABLE_CAP, 上游真实窗口)); 缺省 REASONABLE_CAP。
    // 必须从展开后的 rows 取(context 在 byRealm 里, 顶层没有)。
    const winHdr = {};
    for (const m of rows) {
      const did = s.modelWithRate ? decorateModelIdSync(m, s) : (m.srcTag ? m.id + " [g]" : m.id);
      winHdr[did] = cgEffectiveCeiling(m.context);
    }
    const data = rows.map(m => {
      const did = s.modelWithRate ? decorateModelIdSync(m, s) : (m.srcTag ? m.id + " [g]" : m.id);
      return { id: did, object: "model", owned_by: "workbuddy", multiplier: m.multiplier, discounted: m.discounted, context: m.context, name: decorateModelNameSync(m, s), realm: m.srcTag || "cn" };
    });
    // 把各模型护栏有效上限随响应带出(DSH 侧可据它设 contextWindow), JSON 序列化一次。
    const h = new Headers(); h.set("content-type", "application/json");
    Object.entries(corsHeaders()).forEach(([k, v]) => h.set(k, v));
    h.set("X-Upstream-Context-Window", JSON.stringify(winHdr));
    return new Response(JSON.stringify({ object: "list", data }), { status: 200, headers: h }); }
  let body = await request.json().catch(() => ({}));
  // 上下文护栏: 拦"空转/历史无限膨胀"把账号额度烧穿 (413 上限 / 429 循环)。
  // 放在序列化之前, 用客户端发来的原始 messages 估算, 拒绝时不消耗任何上游额度。
  {
    // 取该模型真实上游窗口: 来自 /v3/config 的 maxInputTokens(已含在 agg 聚合里)。
    // 未知窗口 -> null, 护栏回落 REASONABLE_CAP 兜底(防止"无限制"模型烧穿额度)。
    const parsedModel = body && body.model ? stripModelId(body.model) : { id: "", srcTag: "" };
    let realWindow = null;
    if (parsedModel.id) {
      const { owner } = await aggModels(accs, "agg_models_v4");
      const m = (owner[parsedModel.id] || []).length ? owner[parsedModel.id] : null;
      // owner[id] 是该模型支持的账号数组; 窗口从任意支持账号的模型 meta 取。
      if (m) {
        const acc0 = accs.find(a => m.includes(a.id));
        if (acc0) {
          const r = await fetchModels(acc0).catch(() => ({ models: [] }));
          const mm = (r.models || []).find(x => x.id === parsedModel.id);
          if (mm && mm.context) realWindow = mm.context;
        }
      }
    }
    const cgOwner = key ? ("key:" + String(key).slice(-8)) : "anon";
    const cgReject = await cgCheckAsync(body, cgConfig(), cgOwner, Date.now(), realWindow);
    if (cgReject) {
      const h = new Headers(); h.set("content-type", "application/json");
      Object.entries(corsHeaders()).forEach(([k, v]) => h.set(k, v));
      return new Response(JSON.stringify(cgReject.body), { status: cgReject.status, headers: h });
    }
  }
  const clientStream = body.stream === true; // 记录客户端原始意愿; 上游只支持流式, 非流式需聚合
  body.stream = true;
  // 序列化消息体为 WorkBuddy/CodeBuddy wire 格式: 清理孤儿工具调用,
  // 补 reasoning_content, content 展平, tool 参数规范化. 修复 400 (no body).
  if (Array.isArray(body.messages)) body.messages = serializeBuddyMessages(body.messages);
  // 11128 修复 (移植自 wb-cf-proxy): 腾讯网关强制要求首条消息是 system,
  // 否则以 code:11128 "request illegal" 渠道校验拦截. 客户端没带 system 时注入默认值.
  if (!Array.isArray(body.messages) || body.messages.length === 0 || body.messages[0].role !== "system") {
    body.messages = [{ role: "system", content: "You are a helpful assistant." }, ...(body.messages || [])];
  }
  // 11128 内容拦截中和 (2026-10-25): 上游对 system 消息里的字面量 "DeepSeek Harness"
  // (大小写不敏感/单空格) 做渠道校验拦截, 命中即 400/11128, 与出口/账号/请求头无关。
  // 只改 system, 空格换零宽空格; 路径里的同名字符串默认跳过 (见 wb11128诊断_20261025.md)。
  body.messages = neutralizeSystemMessages(body.messages, wbNeutralizeAllPaths());
  const parsed = body && body.model ? stripModelId(body.model) : { id: "", srcTag: "" };
  const realModel = parsed.id;
  if (realModel) body.model = realModel;
  // 对话: 不带 g -> 优先国内账号 (省国际额度); 带 g -> 强制国际账号; 找不到支持者再逐级兜底
  let pick = acc;
  if (realModel) {
    const { owner } = await aggModels(accs, "agg_models_v4");
    const owners = owner[realModel] || [];
    let cand = accs.filter(a => owners.includes(a.id));
    const wantRealm = parsed.srcTag === "g" ? "global" : "cn";
    let pref = cand.filter(a => realmOf(a) === wantRealm);
    // g 兜底保护: 请求带 [g] 但没有任何启用的国际账号时, 绝不静默落到 CN
    // 账号 (本来该走国际的模型打到 CN 上游, 结果不可预测——可能过、可能
    // "not system" 11128、可能模型不存在)。503 明示客户端改用无 g 条目。
    if (parsed.srcTag === "g" && !pref.length) {
      return new Response(JSON.stringify({ error: { message: "global realm requested but no global account enabled; use the non-g model id instead", type: "no_upstream", code: "realm_disabled" } }), { status: 503, headers: { "content-type": "application/json", ...corsHeaders() } });
    }
    if (pref.length) cand = pref;
    if (!cand.length) cand = accs.filter(a => owners.includes(a.id));
    if (!cand.length) cand = accs; // 最终兜底
    if (cand.length) pick = cand[Math.floor(Math.random() * cand.length)];
  }
  const r = await fetch(chatBase(pick) + "/v2/chat/completions", { method: "POST", headers: commonHeaders(pick, pick.access_token), body: JSON.stringify(body) });
  // 上游错误: 原样透传 (保持状态码与报文体, 客户端能看到真实原因)
  if (!r.ok) {
    const h = new Headers(); h.set("content-type", r.headers.get("content-type") || "application/json");
    Object.entries(corsHeaders()).forEach(([k, v]) => h.set(k, v));
    return new Response(r.body, { status: r.status, headers: h });
  }
  // 客户端要流式 → 直接转发 SSE
  if (clientStream) {
    const h = new Headers(); h.set("content-type", "text/event-stream"); h.set("cache-control", "no-store");
    Object.entries(corsHeaders()).forEach(([k, v]) => h.set(k, v));
    return new Response(r.body, { status: r.status, headers: h });
  }
  // 客户端要非流式 → 把上游强制流式的 SSE 聚合回单个 chat.completion JSON
  // (移植自 wb-cf-proxy aggregateStream; 上游只支持流式, 但普通 OpenAI 客户端
  //  常默认 stream:false, 直接透传 SSE 会把事件流当 JSON 解析而报错)
  const completion = await aggregateSseToCompletion(r);
  const h = new Headers(); h.set("content-type", "application/json"); h.set("cache-control", "no-store");
  Object.entries(corsHeaders()).forEach(([k, v]) => h.set(k, v));
  return new Response(JSON.stringify(completion), { status: 200, headers: h });
}

/** 把上游 SSE 流聚合为单个 OpenAI chat.completion JSON (非流式客户端支持). */
async function aggregateSseToCompletion(resp) {
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = "", content = "", role = "assistant", model = "", id = "", created = 0, finishReason = null, usage = null;
  const toolCalls = new Map(); // index -> 累积的 tool_call 对象
  for (;;) {
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
      let obj; try { obj = JSON.parse(payload); } catch { continue; }
      const ch = obj.choices && obj.choices[0];
      if (!ch) continue;
      if (obj.id) id = obj.id;
      if (obj.model) model = obj.model;
      if (obj.created) created = obj.created;
      const d = ch.delta || {};
      if (d.role) role = d.role;
      if (typeof d.content === "string") content += d.content;
      // ---------- 累积 delta.tool_calls (按 index 合并 id/type/name/arguments 分片) ----------
      const dts = d.tool_calls;
      if (Array.isArray(dts) && dts.length) {
        for (const tc of dts) {
          const idx = tc.index ?? 0;
          const cur = toolCalls.get(idx) || { id: "", type: "", function: { name: "", arguments: "" } };
          if (tc.id) cur.id = tc.id;
          if (tc.type) cur.type = tc.type;
          if (tc.function) {
            if (tc.function.name) cur.function.name += tc.function.name;
            if (typeof tc.function.arguments === "string") cur.function.arguments += tc.function.arguments;
          }
          toolCalls.set(idx, cur);
        }
      }
      if (ch.finish_reason) finishReason = ch.finish_reason;
      if (obj.usage) usage = obj.usage;
    }
  }
  const mergedToolCalls = [...toolCalls.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => c);
  const message = { role, content };
  if (mergedToolCalls.length) message.tool_calls = mergedToolCalls;
  return {
    id: id || "cmb-agg",
    object: "chat.completion",
    created: created || Math.floor(Date.now() / 1000),
    model: model || "workbuddy",
    choices: [{ index: 0, message, finish_reason: finishReason || "stop" }],
    usage: usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}
async function getKeyByValue(key) {
  const ids = await kvGet(K.idK, []);
  for (const id of ids) { const k = await kvGet(K.key(id)); if (k && k.apikey === key) return k; }
  return null;
}

// 惰性保活: 仅刷新即将过期(<7天)的 token, 不等签到结果, 失败静默
async function lazyKeepalive() {
  const accs = await getAccounts();
  for (const acc of accs) {
    if (!acc.enabled) continue;
    if (acc.expires_at < now() + 7 * 86400) {
      try { const u = await refreshToken(acc); acc.access_token = u.access_token; acc.refresh_token = u.refresh_token; acc.expires_at = u.expires_at; await saveAccount(acc); }
      catch (e) { await logTask("keepalive", acc.id, false, String(e.message || e).slice(0, 200)); }
    }
  }
}
// cron
async function runCron() {
  const accs = await getAccounts(); const log = [];
  for (const acc of accs) {
    if (!acc.enabled) continue;
    if (acc.expires_at < now() + 3 * 86400) {
      try { const u = await refreshToken(acc); acc.access_token = u.access_token; acc.refresh_token = u.refresh_token; acc.expires_at = u.expires_at; await saveAccount(acc); await logTask("keepalive", acc.id, true, "refreshed"); log.push(acc.uid + ":keepalive ok"); }
      catch (e) { await logTask("keepalive", acc.id, false, String(e.message || e).slice(0, 200)); }
    }
    // 「自动签到」勾选：0=只跳过 checkin（续期不受影响）；undefined=勾选（老账号行为不变）。
    if (acc.auto_checkin !== 0) {
    try { const r = await checkin(acc); await logTask("checkin", acc.id, r.code === 0 || r.code === 10001, r.msg); log.push(acc.uid + ":checkin " + r.msg); }
    catch (e) { await logTask("checkin", acc.id, false, String(e.message || e).slice(0, 200)); }
    }
  }
  return log;
}

// 入口
addEventListener('fetch', event => { event.respondWith(handleFetch(event.request)); });
async function handleFetch(request) {
  const url = new URL(request.url);
  // 支持挂在子路径下 (如 wb.kbi190.kdns.fr/manager/*): 剥前缀后内部转发
  let p = url.pathname;
  let base = "";
  if (p === "/manager" || p.startsWith("/manager/")) { base = "/manager"; p = p.slice(8) || "/"; }
  const url2 = new URL(request.url); url2.pathname = p;
  const req2 = new Request(url2, request);
  // CORS 预检
  if (request.method === "OPTIONS") {
    const h = corsHeaders(); h["content-type"] = "application/json";
    return new Response(null, { status: 204, headers: h });
  }
  if (p === "/healthz") return new Response("ok");
  // 公开代理: 兼容 /v1/... 与 /api/v1/... 两种前缀 (Operit 填 BaseURL 不带 /api 时也能用)
  if (p === "/v1/models" || p === "/v1/chat/completions") {
    const r = await handleProxy(req2, "/v1/models" === p ? "v1/models" : "v1/chat/completions");
    const h = new Headers(r.headers); Object.entries(corsHeaders()).forEach(([k, v]) => h.set(k, v));
    return new Response(r.body, { status: r.status, headers: h });
  }
  if (p.startsWith("/api/")) return handleApi(req2, url2);
  // 未登录: 返回登录门禁页 (不暴露真实管理界面); 已登录才返回 UI
  if (p === "/" || p === "/manager") {
    const sess = getCookie(request, "wbsess");
    if (sess && await sessValid(sess)) {
      return new Response(UI.replaceAll("__BASE__", base), { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    return new Response(LOGIN.replaceAll("__BASE__", base), { status: 401, headers: { "content-type": "text/html; charset=utf-8" } });
  }
  return new Response("WorkBuddy Manager", { status: 404 });
}
addEventListener('scheduled', event => { event.waitUntil(runCron()); });
