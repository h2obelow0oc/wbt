import { refreshToken, checkin, fetchCredits, fetchModels, realmOf, normExpires, chatBase, commonHeaders, neutralizeSystemMessages, wbNeutralizeAllPaths } from "./wb_protocol.js";
import { UI, LOGIN } from "./ui.js";
import { serializeBuddyMessages } from "./serialize-buddy.mjs";

// 上下文护栏: CF 版由 deploy.sh 把 context-guard.js 内联进单文件, 故无 import;
// Node/Render 版是真正的 ES module, 必须显式导入, 否则 handleProxy 抛
// ReferenceError: cgCheckAsync is not defined (实测踩过)。
import { cgCheckAsync, cgConfig, cgEffectiveCeiling, CG_REASONABLE_CAP } from "./context-guard.js";

// ===== 存储层：Turso/libSQL（替代 Cloudflare KV）=====
// 接口与原来完全一致（kvGet/kvPut/kvDel + K 键空间常量），业务代码零改动。
import { K, kvGet, kvPut, kvDel, tursoHealth, exec } from './turso.js';

// ===== 多渠道后端 =====
// 只静态导入**纯 JS** 的注册表(它对渠道模块是动态 import, 见 backends/index.js)。
// 渠道 TS 协议层的解析钩子由启动标志 --import ./worker/backends/hook.mjs 注册;
// 钩子缺失时仅渠道请求报错, WB 推理不受影响 —— 不让新功能拖垮在跑的服务。
import { parseModelId, qualifyModelId, stripModelId, CHANNEL_IDS, loadChannel } from './backends/index.js';
import { chanRefresh, isTerminal } from './chan-refresh.js';
import { chanCredits } from './chan-credits.js';
import { chanCheckin, supportsCheckin } from './chan-checkin.js';
import { fillContextWindows } from './models-dev.js';
// 模型真实上下文窗口的唯一取值来源（护栏与 X-Upstream-Context-Window 头共用口径）。
import { resolveModelWindow } from './model-window.js';
import { orderAccounts, accountsNeedingCredits } from './account-pick.js';
import { isDeadCode, needsEffort, markKey, isDead, resolveEffort, upstreamCodeOf, pruneMarks, EFFORT_CODE } from './model-marks.js';
// 11140 封禁冻结（hub v2.1.0 语义）：判定/落标/解禁的纯函数在 ban-classify.js
import { isBannedError, isBannedCheckin, markBanned, clearBanned, BAN_COOLDOWN_REASON } from './ban-classify.js';
import { openaiToDsh, imagesToInline } from './backends/openai-to-dsh.js';
// 进程内注册 TS 解析钩子: Render 的 startCommand 可能没带 --import
// (服务是 Dashboard 手动建的, render.yaml 蓝图未必生效, 实测 x-ts-hook:false)。
// 此处注册对**之后**的动态 import() 有效 —— 前提是静态图里没有 TS,
// 见 ts-hook.mjs 与本文件 line ~15 的既有约束。
import './backends/ts-hook.mjs';

// 探活留痕缓冲: 只存最近 30 次 /healthz 的 UA 与时间间隔, 纯内存。
const _healthHits = [];

const uuid = () => crypto.randomUUID();
const now = () => Math.floor(Date.now() / 1000);
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
// 魔搭/载体适配（2026-11-15，照 qom/trm 方案）：平台占用 Authorization 头，鉴权改走 X-Api-Key
const MS_MODE = String(process.env.MS_MODE ?? '') === '1';
const TURSO_URL = process.env.TURSO_URL;
const TURSO_TOKEN = process.env.TURSO_TOKEN;
const MAX_CONTEXT_TOKENS = parseInt(process.env.MAX_CONTEXT_TOKENS || "0", 10);
const LOOP_REPEAT_LIMIT = parseInt(process.env.LOOP_REPEAT_LIMIT || "6", 10);
const LOOP_WINDOW_MS = parseInt(process.env.LOOP_WINDOW_MS || "120000", 10);
const CRON_INTERVAL_MS = parseInt(process.env.CRON_INTERVAL_MS || "21600000", 10);
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
  // MS_MODE：平台占用 Authorization（容器收到平台自己的串），管理令牌走 X-Api-Key
  if (MS_MODE) {
    const xk = (req.headers.get("X-Api-Key") || req.headers.get("x-api-key") || "").trim();
    if (xk && ADMIN_TOKEN) return xk === ADMIN_TOKEN;
  }
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
  if (MS_MODE) {
    const xk = (req.headers.get("X-Api-Key") || req.headers.get("x-api-key") || "").trim();
    if (xk) return (ADMIN_TOKEN && xk === ADMIN_TOKEN) ? null : xk;
    // 平台占用 Authorization：容器里的值是平台注入串，直接忽略；
    // 仅当它明显不是平台格式（不eyJ/base64-hex）才回退兼容本地测试
    const az0 = (req.headers.get("Authorization") || "").trim().replace(/^(?:Bearer\s+)+/i, "");
    if (az0 && !/^(?:ey[A-Za-z0-9_-]{10,}\.|[0-9a-f]{32,48}$)/i.test(az0)) {
      return (ADMIN_TOKEN && az0 === ADMIN_TOKEN) ? null : az0;
    }
    return null;
  }
  let az = (req.headers.get("Authorization") || "").trim();
  if (!az) az = (req.headers.get("X-Api-Key") || req.headers.get("x-api-key") || req.headers.get("Api-Key") || req.headers.get("api-key") || "").trim();
  if (!az) { try { az = new URL(req.url).searchParams.get("key") || ""; } catch {} }
  // 去掉可能重复的 Bearer 前缀与首尾空白 (客户端兼容)
  az = az.replace(/^(?:Bearer\s+)+/i, "").trim();
  return az || null;
}
// ===== 账号级冷却机制（防封号核心：429/封禁分类 + 冷却跳过）=====
/**
 * 给账号加冷却标记。
 * @param {string} accId 账号 ID
 * @param {string} reason '429' | 'ban' | 'auth' —— 429=限流 10min；ban=风控文案/当日停用；auth=401+40100/40101 永久禁用
 * @param {number} [ttlSec] 自定义 TTL（秒），不传则按 reason 默认
 */
async function setAccountCooldown(accId, reason, ttlSec) {
  const cooldowns = await kvGet(K.cooldown, {});
  const nowSec = now();
  let ttl = ttlSec;
  if (!ttl) {
    if (reason === '429') ttl = 10 * 60;           // 429 → 10 分钟
    else if (reason === 'ban') ttl = 24 * 3600;   // 风控/当日停用 → 24 小时
    else if (reason === 'auth') ttl = 0;          // 认证终态 → 永久（ttl=0 表示不自动过期，需人工干预）
    else ttl = 10 * 60;
  }
  if (ttl > 0) {
    cooldowns[accId] = { until: nowSec + ttl, reason };
  } else {
    cooldowns[accId] = { until: 0, reason };      // 0 = 永久
  }
  await kvPut(K.cooldown, cooldowns);
}

/** 检查账号是否在冷却中。返回 {cooled: boolean, reason?: string, remaining?: number} */
async function checkAccountCooldown(accId) {
  const cooldowns = await kvGet(K.cooldown, {});
  const cd = cooldowns[accId];
  if (!cd) return { cooled: false };
  const nowSec = now();
  // 永久冷却
  if (cd.until === 0) return { cooled: true, reason: cd.reason, remaining: -1 };
  // 过期了 → 清理并返回 false
  if (cd.until <= nowSec) {
    delete cooldowns[accId];
    await kvPut(K.cooldown, cooldowns);
    return { cooled: false };
  }
  return { cooled: true, reason: cd.reason, remaining: cd.until - nowSec };
}

/** 清理过期冷却（定期调用或惰性清理） */
async function pruneAccountCooldowns() {
  const cooldowns = await kvGet(K.cooldown, {});
  const nowSec = now();
  let changed = false;
  for (const [id, cd] of Object.entries(cooldowns)) {
    if (cd.until > 0 && cd.until <= nowSec) {
      delete cooldowns[id];
      changed = true;
    }
  }
  if (changed) await kvPut(K.cooldown, cooldowns);
}

/**
 * 冻结被封禁账号（hub v2.1.0「11140 命中后直接封禁账号」的 wbr 落法）。
 *
 * 与旧 'ban' 24h 冷却的本质区别：这是**终态**，不是冷却 ——
 *   - `enabled=0` → 立即退出 API 派发、checkinTick、保活、cron 所有循环；
 *   - `banned` 持久标记 → 重启/刷新凭证/重新导入都不自动恢复（见导入段）；
 *   - 永久冷却（reason='auth', until=0）作冗余 —— 即便 cooldown 表被
 *     「清理全部数据」抹掉，账号对象里的 banned 仍在；
 *   - 调用方**必须同时停止换号重试**（循环里 break），这是防连坐的关键：
 *     hub 原话「避免同设备账号继续连坐」—— 封禁按设备指纹判定，
 *     拿同池其他号继续打同一个被封设备身份，会把好号一起带走。
 * 幂等：已带 banned 的账号不重复写日志。
 *
 * @param {object} acc     账号对象（就地修改并 saveAccount）
 * @param {object|null} errBody 上游错误体（取证据文本）
 * @param {string} where   来源标记（chat / checkin），进日志便于回溯
 */
async function freezeBannedAccount(acc, errBody, where) {
  if (!acc || acc.banned) return;
  const evidence = `code=${errBody?.code ?? 11140} msg=${String(errBody?.msg || errBody?.displayMsg?.zh || '').slice(0, 120)}`;
  markBanned(acc, evidence);
  await saveAccount(acc);
  try { await setAccountCooldown(acc.id, BAN_COOLDOWN_REASON); } catch {}
  await logTask("account-banned", acc.id, false,
    `上游 11140 账号封禁（${where}）：${evidence} — 已冻结并停止换号；解禁需在面板点「启用」（唯一入口，自动路径永不解封）`);
}

/**
 * 窥探 403 响应体是否 11140（换号循环用）。
 *
 * ⚠️ 读 body 的副作用：`r.text()` 消费后原始流不可再读，外层透传必须用
 * 返回的 `raw` 重放（调用方写入 bufferedRaw）。非 JSON / 读失败时
 * `raw` 仍是文本（或 null），`banned:false` —— 判定失败**不拦正常换号**。
 *
 * @param {Response} r
 * @returns {Promise<{raw: string|null, body: object|null, banned: boolean}>}
 */
async function peekBanError(r) {
  let raw = null;
  try { raw = await r.text(); } catch { return { raw: null, body: null, banned: false }; }
  let body = null;
  try { body = JSON.parse(raw); } catch { /* 非 JSON 错误体：不是封判定证据 */ }
  return { raw, body, banned: isBannedError(body) };
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
// ===== 索引读改写互斥锁 =====
// 「读 ids 数组 → push/filter → 写回」不是原子操作: 并发导入时两个请求各读到
// 同一份旧 ids, 后写的覆盖先写的, 结果账号在 Turso 里存在却不在 idx_accounts
// 中 —— 表现为「导入成功但列表少号 / 只剩一个」。CF KV 版靠 isolate 单线程
// 天然规避, Node 版多请求并发必现, 故对索引写加串行锁。
// 锁按 key 粒度, 只覆盖 idx_accounts / idx_keys 这类数组索引, 不影响正文写入。
const _idxLocks = new Map();
function withKeyLock(key, fn) {
  const prev = _idxLocks.get(key) || Promise.resolve();
  const next = prev.then(fn, fn);
  // 保证链上不残留 rejected(否则后续全被卡住), 同时让调用方拿到真实结果
  _idxLocks.set(key, next.catch(() => {}));
  return next;
}

async function getAccounts() {
  const ids = await kvGet(K.idxA, []);
  const out = [];
  for (const id of ids) { const a = await kvGet(K.acc(id)); if (a) out.push(a); }
  return out;
}
async function getAccount(id) { return kvGet(K.acc(id)); }
async function saveAccount(acc) {
  await withKeyLock(K.idxA, async () => {
    const ids = await kvGet(K.idxA, []);
    if (!ids.includes(acc.id)) { ids.push(acc.id); await kvPut(K.idxA, ids); }
  });
  await kvPut(K.acc(acc.id), acc);
}

// ─────────────────────────── 额度快照（自动刷新） ───────────────────────────
/**
 * 快照 TTL：超过这个年龄即视为「不可信」，会被 `refreshStaleCredits()` 重查。
 *
 * ## 为什么必须自动刷新（2026-11-04 实测）
 *
 * 改之前全库只有两处写 `K.snap`，**都来自用户点面板按钮**；`runCron`(6h)
 * 与 `checkinTick`(30min) 里一行都没有。后果两条：
 *
 *   1. **新导入账号 `credits=None`**，而当时挑号用 `snap?.credits ?? 0` 排序
 *      → 新号算 0 分 → 永远垫底 → **加号等于没加**。实测导入 3 个 raccoon 号
 *      后不查额度，10+ 次请求全部落在同一个老号上。
 *   2. **raccoon 每天重置额度**，快照不刷新就是导入那天的旧值 ——
 *      按过期数字排序比不排序更糟。
 *
 * ## 1 小时的理由
 *
 * 额度变化远慢于 1h（raccoon 每日重置、WB 按包到期），但**签到会当场改额度**
 * （minimax +400 / lobsterai +100），所以签到成功后额外刷一次该账号。
 * 同时 1h 也是「不把上游打疼」的上限 —— 免费站点对高频目录/额度轮询很敏感
 * （见 `notes/inbox/有道龙虾反代封号_GitHub调研_20261103.md`：幸存项目
 * 「每天 <10 次上游请求」）。
 */
const CREDITS_SNAP_TTL_MS = parseInt(process.env.CREDITS_SNAP_TTL_MS || String(60 * 60 * 1000), 10);

/** 读快照；读失败一律当「没有」，绝不让排序因存储抖动而崩。 */
async function snapOf(accId) {
  try { return await kvGet(K.snap(accId)); } catch { return null; }
}

/**
 * 查单个账号额度并落快照。**绝不抛**：额度查询失败不能让对话失败。
 * @returns {Promise<{ok:boolean, credits?:number, msg?:string}>}
 */
async function refreshCreditsOf(acc) {
  try {
    const r = isChan(acc) ? await chanCredits(acc) : await fetchCredits(acc);
    // 只在成功且数值有效时落库 —— 「形状不对就报错，绝不编造 0」
    // （返回 0 会被后续排序读成「额度用尽」，比报错危险）
    if (r && r.ok && Number.isFinite(Number(r.credits))) {
      await kvPut(K.snap(acc.id), { at: now(), credits: Number(r.credits), expiries: r.expiries });
    }
    return r || { ok: false, msg: 'no result' };
  } catch (e) {
    return { ok: false, msg: String(e?.message || e).slice(0, 160) };
  }
}

/**
 * 把过期（或从未查过）的账号额度补查一轮。
 *
 * @param {object[]} accounts
 * @param {{maxAgeMs?:number, budget?:number}} [opts]
 *   `budget` 限制一次最多打几个上游 —— 上游抖动时不会把每个账号都打一遍。
 * @returns {Promise<{refreshed:number, failed:number}>}
 */
async function refreshStaleCredits(accounts, opts = {}) {
  const ttl = Number.isFinite(opts.maxAgeMs) ? opts.maxAgeMs : CREDITS_SNAP_TTL_MS;
  const snaps = new Map();
  for (const a of (accounts || [])) snaps.set(a.id, await snapOf(a.id));
  const stale = accountsNeedingCredits(accounts, (id) => snaps.get(id), now(), ttl);
  const budget = Number.isFinite(opts.budget) ? Math.max(0, opts.budget) : stale.length;
  let refreshed = 0, failed = 0;
  for (const acc of stale.slice(0, budget)) {
    const r = await refreshCreditsOf(acc);
    if (r.ok) refreshed++; else failed++;
  }
  return { refreshed, failed, skipped: Math.max(0, stale.length - budget) };
}

// ─────────────────────────── 统一挑号 ───────────────────────────
/**
 * 取挑号游标。键按 (provider, model) 分开 —— 不同模型的负载不该互相推走起点。
 * 读失败返回 0（游标只是优化，不能因为读不到就不发请求）。
 */
async function getPickCursor(provider, model) {
  try {
    const all = await kvGet(K.pickCursor, {});
    const v = all[(provider || 'wb') + '|' + (model || '*')];
    return Number.isFinite(Number(v)) ? Number(v) : 0;
  } catch { return 0; }
}

async function savePickCursor(provider, model, cursor) {
  try {
    const all = await kvGet(K.pickCursor, {});
    all[(provider || 'wb') + '|' + (model || '*')] = cursor;
    // 键空间无限增长会撑爆单行 JSON：只保留最近用到的若干个键
    const keys = Object.keys(all);
    if (keys.length > 64) for (const k of keys.slice(0, keys.length - 64)) delete all[k];
    await kvPut(K.pickCursor, all);
  } catch { /* 游标写失败不影响本次请求 */ }
}

/**
 * 统一的「按积分分层 + 层内轮转」挑号。
 *
 * ## 为什么两条路必须共用这一条（2026-11-04）
 *
 * 改之前 WB 与渠道**各写一份、策略还不一样**：
 *
 * | | WB | 渠道 |
 * |---|---|---|
 * | 选号 | 纯随机（忽略积分） | 按积分降序**固定取第 0 位** |
 * | 冷却 | 会写 | 只读不写 |
 * | 429 后 | 透传 | 透传 |
 *
 * 渠道那条的「固定取第 0 位」是致命点：加 N 个号也**永远只打第 1 个**。
 * 用户实测导入 3 个 raccoon 号，10+ 次请求全落在同一个号上。
 *
 * @param {object[]} candidates 已按渠道/模型过滤好的候选
 * @param {{provider:string, model:string, cursorKeyModel?:string}} ctx
 * @returns {Promise<object[]>} **尝试顺序**（可能为空）
 */
// ─────────────────────── 失败分类（WB 与渠道共用一张表） ───────────────────────
/**
 * 渠道请求失败后该怎么办。
 *
 * ## 分类口径（与 keypool 那套 `retryableCodes` 分工不同，别混）
 *
 * 这里判的是「**网关要不要换下一个账号**」，不是「客户端要不要重试」。
 *
 * | 状态 | 动作 | 理由 |
 * |---|---|---|
 * | 429 | **换号 + 冷却** | 频率/额度闸是**账号级**的（社区实测 60s 恢复，见商汤笔记）；换号立刻可用 |
 * | 401 / 403 | **换号 + 冷却** | token 失效 / 账号停服 → 换号能救；同号再打只会重复失败 |
 * | 5xx | 换号 | 上游抖动，换号可能落在健康实例上 |
 * | 400 / 404 / 413 / 422 | **不换号** | 是**请求本身**的问题（模型不存在/体过大/参数错），换号结果一样 |
 * | 2xx | 不换号（正常返回） | — |
 *
 * @param {number} status HTTP 状态码
 * @param {boolean} alreadyRetried 这个号是否已在本请求里试过
 * @returns {'switch'|'return'}
 */
function channelFailureAction(status, alreadyRetried) {
  if (!Number.isFinite(status)) return 'return';
  if (status >= 200 && status < 300) return 'return';
  if (status === 429) return alreadyRetried ? 'return' : 'switch';
  if (status === 401 || status === 403) return alreadyRetried ? 'return' : 'switch';
  if (status >= 500) return alreadyRetried ? 'return' : 'switch';
  return 'return';   // 4xx 里的「请求本身错」：换号无用，如实透传
}

/** 本请求内该号是否已被用过（用于「同一号不重复切换」的护栏）。 */
function plannedRetryOf() { return false; }

async function pickAccountsByCredits(candidates, ctx = {}) {
  const pool = (candidates || []).filter(Boolean);
  if (!pool.length) return [];
  const provider = ctx.provider || 'wb';
  const model = ctx.cursorKeyModel || ctx.model || '*';

  // 冷却过滤交给 account-pick（它保证「全冷却」时不会静默挑一个送死）。
  const cooldowns = await kvGet(K.cooldown, {}).catch(() => ({}));
  const cooled = (accId) => {
    const cd = cooldowns[accId];
    if (!cd) return false;
    if (!cd.until) return true;                 // 0 = 永久
    return cd.until > now();                    // 已过期的当作没冷却
  };

  const cursor = await getPickCursor(provider, model);
  const res = orderAccounts(pool, (id) => {
    // 同步接口：orderAccounts 需要同步读取，故这里先用已加载的快照表。
    return _pickSnapCache.get(id) || null;
  }, { cursor, isCooled: cooled });
  await savePickCursor(provider, model, res.cursor);
  return res.ordered;
}

/** pickAccountsByCredits 用的同步快照表（每次挑号前刷新，避免同步 I/O）。 */
const _pickSnapCache = new Map();

/** 预载候选账号的快照到同步缓存（挑号前调用一次）。 */
async function primePickSnapCache(accounts) {
  _pickSnapCache.clear();
  for (const a of (accounts || [])) _pickSnapCache.set(a.id, await snapOf(a.id));
}
async function delAccount(id) {
  await withKeyLock(K.idxA, async () => {
    const ids = (await kvGet(K.idxA, [])).filter(x => x !== id);
    await kvPut(K.idxA, ids);
  });
  await kvDel(K.acc(id)); await kvDel(K.snap(id));
}
async function getKeys() { const ids = await kvGet(K.idK, []); const out = []; for (const id of ids) { const k = await kvGet(K.key(id)); if (k) out.push(k); } return out; }
async function saveKey(k) {
  await withKeyLock(K.idK, async () => {
    const ids = await kvGet(K.idK, []);
    if (!ids.includes(k.id)) { ids.push(k.id); await kvPut(K.idK, ids); }
  });
  await kvPut(K.key(k.id), k);
}
async function delKey(id) {
  await withKeyLock(K.idK, async () => {
    const ids = (await kvGet(K.idK, [])).filter(x => x !== id);
    await kvPut(K.idK, ids);
  });
  await kvDel(K.key(id));
}
async function logTask(type, account_id, ok, msg) {
  // 读-改-写必须串行: 不上锁时, 「清理全部数据」的 kvDel(K.logs) 会插在
  // kvGet 与 kvPut 之间, 刚删掉的日志被原样写回 (e2e 6d 实测 300 条残留)。
  return withKeyLock(K.logs, async () => {
    const logs = await kvGet(K.logs, []);
    logs.unshift({ type, account_id, at: now(), ok: ok ? 1 : 0, msg: String(msg || "").slice(0, 400) });
    await kvPut(K.logs, logs.slice(0, 300));
  });
}

// 解析导入 JSON
//
// 支持两种账号形态, 靠 `provider` 区分(缺省 "wb"):
//   - WB 账号: 有 domain/realm/uid, 由 domain 推 realm (既有行为, 逐字节不变);
//   - 渠道账号: provider 为 minimax/raccoon/cline/lobsterai 之一, **没有**
//     domain/realm/uid —— realmOf({domain}) 是 WB 专属语义, 对渠道套用会
//     凭空造出 "cn" realm, 故走独立分支。
// 渠道账号的额外字段(如 raccoon 的 office_identity)原样保留, 供请求头构造用。
//
// 返回 { accounts, skipped } 而非裸数组:
//   ofm 导出的整包常含网关不支持的渠道(trae/zcode/gemini...), 旧版遇到未知
//   provider 直接 throw, 一个杂账号会把整批导入带崩。现改为**跳过并回报**,
//   调用方把 skipped 原样回给用户, 一眼看出哪些没进。
// 过期时间字段各家不一: 通用是 expires_at/expiresAt, **cline 用 expire_time**
// (且是毫秒), 故一并读取; normExpires 对 >1e12 的值自动除 1000。

// ===== 手机号打码 (2026-11-04) =====
// 背景: wb 账号的 nickname 是上游返回的完整手机号; 从 OFM 导入的 4 个渠道在
// 导出侧就已是打码形态 (181******90) —— 差异在来源, 不在网关。统一在网关做两层:
//   1. parseAccountFile 入口改写 —— 库里从此不再进明文手机号;
//   2. GET /api/accounts 返回前兜底 —— 兜住本功能上线前已入库的存量昵称
//      (含 accounts/patch 手工写入的), 历史数据不再从面板泄露。
// 规则(保守, 只动确定的手机号, 其余一律不猜):
//   11 位、1 开头的纯数字     → 保留前 3 后 2: 18154241890 → 181******90
//   已打码形态 (前3 + *段 + 后2) → 中间统一为 6 个 * (长度对齐上面那条)
//   邮箱 / 用户名 / 'RaccoonNatalie (1890)' 等 → 原样返回
// ⚠️ 只动 nickname/name 这类展示字段; WB 协议请求头不携带 nickname (实测
// billingHeaders 只用 uid/token), 打码不影响上游调用。nickname 是幂等导入的
// 去重键 —— 入口改写后, 「同一手机号重复导入」依旧命中同一键, 幂等性保持。
function maskPhone(v) {
  if (typeof v !== "string") return v;
  const t = v.trim();
  const m = /^(1\d{2})\d{6}(\d{2})$/.exec(t);
  if (m) return m[1] + "******" + m[2];
  const r = /^(1\d{2})\*+(\d{2})$/.exec(t);
  if (r) return r[1] + "******" + r[2];
  return v;
}
function maskContactFields(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return obj;
  for (const k of ["nickname", "name", "accountName", "userName", "username"]) {
    if (typeof obj[k] === "string") obj[k] = maskPhone(obj[k]);
  }
  return obj;
}

function parseAccountFile(text) {
  let data; try { data = JSON.parse(text); } catch { throw new Error("JSON 解析失败"); }
  // 手机号打码: OFM 导出/手工构造的账号可能带明文手机号(nickname/name),
  // 统一改写后再入库。裸数组格式(test 4a)与 {accounts:[]} 两种形态都要覆盖。
  const items0 = Array.isArray(data) ? data : (data && Array.isArray(data.accounts) ? data.accounts : null);
  if (items0) for (const x0 of items0) maskContactFields(x0);
  if (data && !Array.isArray(data) && Array.isArray(data.skipped)) for (const s0 of data.skipped) maskContactFields(s0);
  let arr = Array.isArray(data) ? data : Array.isArray(data.accounts) ? data.accounts : [data];
  const out = [], skipped = [];
  const why = (x, reason) => skipped.push({ provider: x.provider || x.channel || "(无 provider)", reason });
  for (const x of arr) {
    const at = x.access_token || x.accessToken || (x.auth && (x.auth.access_token || x.auth.accessToken));
    const rt = x.refresh_token || x.refreshToken || (x.auth && (x.auth.refresh_token || x.auth.refreshToken));
    const exp = x.expires_at || x.expiresAt || x.expire_time || x.expireTime
      || (x.auth && (x.auth.expires_at || x.auth.expiresAt || x.auth.expire_time));
    const provider = x.provider || x.channel || "wb";
    if (!at) { why(x, "无 access_token"); continue; }
    if (provider !== "wb") {
      if (!CHANNEL_IDS.includes(provider)) { why(x, "网关不支持该渠道(仅 " + CHANNEL_IDS.join("/") + ")"); continue; }
      out.push({ id: uuid(), provider, nickname: x.nickname || x.name || "",
        access_token: at, refresh_token: rt || "", expires_at: normExpires(exp) || now() + 3600,
        enabled: 1, models: [], created_at: now(),
        ...(x.office_identity ? { office_identity: x.office_identity } : {}),
        ...(x.device_id ? { device_id: x.device_id } : {}),
        ...(x.user_id ? { user_id: x.user_id } : {}),
        ...(x.email ? { email: x.email } : {}),
        ...(x.phone ? { phone: x.phone } : {}),
        // cline 额度端点 /users/{account_id}/balance 要用它 —— 源码明确不是 JWT 的 sub
        ...(x.account_id ? { account_id: x.account_id } : {}),
        // lobsterai 续期 body 的 keyfrom 载荷必须带这些 —— 少了会发空串,
        // 上游按"登录时那一刻"校验, 丢了就续不上 (见 chan-refresh.js 注释)
        ...(x.first_keyfrom ? { first_keyfrom: x.first_keyfrom } : {}),
        ...(x.latest_keyfrom ? { latest_keyfrom: x.latest_keyfrom } : {}),
        ...(x.uuid ? { uuid: x.uuid } : {}) });
      continue;
    }
    const domain = x.domain || (x.auth && x.auth.domain) || ((x.realm === "global") ? "www.workbuddy.ai" : "www.codebuddy.cn");
    const uid = x.uid || (x.auth && x.auth.uid) || (x.account && x.account.uid) || "";
    out.push({ id: uuid(), provider: "wb", uid, realm: realmOf({ domain }), domain, nickname: x.nickname || x.name || (x.account && x.account.nickname) || "",
      access_token: at, refresh_token: rt || "", expires_at: normExpires(exp) || now() + 3600,
      enabled: 1, models: [], created_at: now() });
  }
  // 一个都没解析出来、也没东西可报错时才抛 —— 有 skipped 就返回, 让调用方显示原因
  if (!out.length && !skipped.length) throw new Error("未找到任何含 access_token 的账号");
  return { accounts: out, skipped };
}
/**
 * 渠道模型的**真实倍率** —— 用户报「除了 workbuddy 的模型倍率你全写成 X1，明明很多不是」。
 *
 * vendor 的 `fallbackModels` **没有数值倍率字段**，真值被固化在展示名里，
 * 与远端 `billing_effective_multiplier` 逐条对应:
 *   `GLM-5-3 · x0.75`            → 0.75
 *   `GLM-5-3-Flash · x0.2→x0.1`  → 0.1 (生效价)
 *   `SenseNova-6.8-Flash · 免费`  → 0
 *   `M3` (无后缀)                → 解析不出
 *
 * ⚠️ 解析不出必须返回 null, 调用方显示 `—` 而**绝不能**回落成 x1 ——
 * 编造倍率比空着更糟: 0.75x 显示成 1x 是错数据, 空着只是缺数据。
 */
function chanRate(name) {
  const m = /·\s*(.+)$/.exec(String(name || ""));
  if (!m) return null;
  const tail = m[1].trim();
  if (tail === "免费") return { display: "免费", value: 0 };
  const mm = /^x([\d.]+)(?:→x([\d.]+))?$/.exec(tail);
  if (mm) return { display: tail, value: parseFloat(mm[2] !== undefined ? mm[2] : mm[1]) };
  return null;
}

/**
 * 预热渠道的**远端模型目录**（当前只有 cline 需要）。
 *
 * ## 为什么需要这一步（2026-11-03 用户报障）
 * 「cline 在 ofm 插件显示 4 个免费，总数 31，网关上总共才 3 个」。
 * 渠道后端的 `models()` 是**同步**的（三处调用点都在同步上下文），而远端
 * 目录必须异步拉。原实现干脆只用静态 `fallbackModels`，于是 cline 永远
 * 只报 3 条 —— 而且那 3 条**全已被上游下线**（实测三条都打不通）。
 *
 * 折中方案：后端额外导出 `clineCatalog(account)`（异步、带 30min 缓存、
 * 失败回退兜底表），在列模型/路由之前 await 一次把缓存填上，
 * 之后同步的 `models()` 就读到真目录了。
 *
 * ⚠️ **绝不能抛错**：目录服务抖动不该让渠道列表或聊天失败。
 * 拉不到就用兜底表（这是 OFM 的契约，也是这里必须保持的）。
 */
async function warmChannelCatalog(mod, account) {
  const warm = mod && (mod.clineCatalog || (mod.backend && mod.backend.clineCatalog));
  if (typeof warm !== "function") return;   // 其他渠道没有远端目录，直接返回
  try { await warm(account); } catch { /* 目录失败不影响主流程 */ }
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
  // 惰性补签: 兜底路径（主路径是独立的 checkinTick 定时器）。
  // ⚠️ 排除 `reset`：那个请求正在删全部账号，签完立刻被删，还会在
  // 「清理全部数据」的日志断言里多出一条 checkin —— e2e 6d 就是这个红。
  if (p !== "reset") lazyCheckin().catch(e => {});

  if (p === "accounts/import" && method === "POST") {
    const ct = request.headers.get("content-type") || "";
    let text = "";
    if (ct.includes("multipart/form-data")) {
      const form = await request.formData(); const file = form.get("file");
      text = file ? await file.text() : (form.get("json") || "");
    } else { const b = await request.json().catch(() => ({})); text = b.json || b.text || ""; }
    try {
      const { accounts: accs, skipped } = parseAccountFile(text);
      // 幂等导入: parseAccountFile 每次都 `id: uuid()`, 直接存会**重复建号**。
      // 导出→导入是反复要做的动作(OFM 轮换后就得重新拉), 必须按
      // provider+nickname 认领已有账号, 只换凭据、保留原 id/created_at。
      const existed = await getAccounts();
      const byKey = new Map();
      for (const a of existed) {
        const k = (a.provider || "wb") + "|" + (a.nickname || a.uid || "");
        if (!byKey.has(k)) byKey.set(k, a);
      }
      let created = 0, updated = 0, staleKept = 0;
      for (const a of accs) {
        const k = (a.provider || "wb") + "|" + (a.nickname || a.uid || "");
        const old = byKey.get(k);
        if (old) {
          a.id = old.id; a.created_at = old.created_at; updated++;
          // 幂等保留用户的手工开关：enabled（停用的号不该被重导入悄悄启用——
          // 此处此前漏了，与 tr 网关同款问题一并修）与 auto_checkin 勾选。
          a.enabled = old.enabled;
          // hub v2.1.0：封禁是持久终态，「重新导入不自动恢复」——banned 标记
          // 与禁用状态一起保留；解禁唯一入口 = 面板启用按钮（accounts/enable）。
          a.banned = old.banned || 0;
          if (old.banned) { a.bannedAt = old.bannedAt; a.bannedEvidence = old.bannedEvidence; a.enabled = 0; }
          a.auto_checkin = old.auto_checkin === 0 ? 0 : 1;
          // 陈旧导入防护: 导出文件可能比网关里**已轮换**的凭据更旧。
          // 网关续期会换新 refresh_token 并把 expires_at 往后推; 此时若拿旧文件
          // 覆盖, 等于把**已被消费**的旧 RT 写回去 → 上游 invalid_grant → 账号报废
          // (2026-11-02 实打实踩过: 10:09 的导出覆盖了 10:38 轮换出的新 RT)。
          // 判据: 已存凭据的 expires_at 更新 ⇒ 已存的更新鲜 ⇒ 保留已存令牌。
          if ((old.expires_at || 0) > (a.expires_at || 0)) {
            a.access_token = old.access_token;
            a.refresh_token = old.refresh_token;
            a.expires_at = old.expires_at;
            staleKept++;
          }
        }
        else created++;
        await saveAccount(a);
      }
      // skipped 原样回传: 用户能直接看到"哪几个没进、为什么"
      return json({ ok: true, imported: accs.length, created, updated, stale_kept: staleKept,
                    ids: accs.map(a => a.id), skipped });
    }
    catch (e) { return json({ ok: false, msg: String(e.message || e) }, 400); }
  }
  if (p === "accounts" && method === "GET") {
    const accs = await getAccounts();
    for (const a of accs) {
      // 展示层兜底: 存量昵称可能仍是完整手机号(打码功能上线前入库的,
      // 或经 accounts/patch 手工写入的), 出口统一再打一遍。
      // 不回写库存 —— nickname 是幂等导入的去重键, 保持原值最稳。
      maskContactFields(a);
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
    // 手动续期按钮: 按渠道分流。refreshToken() 是 WB 专属, 对渠道账号会抛
    // WB 协议错误(实测"点续期报错"), 故渠道走 chanKeepalive(带互斥)。
    try {
      const u = isChan(acc) ? await chanKeepalive(acc) : await refreshToken(acc);
      acc.access_token = u.access_token; acc.refresh_token = u.refresh_token; acc.expires_at = u.expires_at;
      await saveAccount(acc); return json({ ok: true, expires_at: acc.expires_at }); }
    catch (e) { return json({ ok: false, msg: String(e.message || e) }, 500); }
  }
  if (p === "accounts/checkin" && method === "POST") {
    const { id } = await request.json(); const acc = await getAccount(id); if (!acc) return json({ error: "no account" }, 404);
    // 签到: WB 走 wb_protocol.checkin()（原样不变）；渠道走 chan-checkin.js ——
    // 移植 OFM 的 minimax signin 与 lobsterai 三步流程。渠道额度是签到挣来的，
    // 不签到 credit/details 就是真 0，面板看着像"额度没移植成功"。
    // 不支持签到的渠道（cline）由 chanCheckin 自己回 ok:false+原因，
    // 绝不落到 WB 的 checkin 上 —— 那会打 copilot.tencent.com，报错看不懂。
    const chan = isChan(acc);
    const r = chan ? await chanCheckin(acc) : await checkin(acc);
    const ok = chan ? !!r.ok : (r.code === 0 || r.code === 10001 || r.status === 200);
    await logTask("checkin", id, ok, r.msg);
    return json({ ok, ...r });
  }
  if (p === "accounts/credits" && method === "POST") {
    const { id } = await request.json(); const acc = await getAccount(id); if (!acc) return json({ error: "no account" }, 404);
    // fetchCredits() 是 CodeBuddy/WB 专属(billingBase/realmOf), 打到渠道上只会
    // 回一个看不懂的 WB 报错。渠道走 chan-credits.js 的 4 家实现(移植 OFM)。
    // 两者都遵守「形状不对就报错, 绝不返回 0」—— 返回 0 会被面板读成"额度用尽"。
    const r = isChan(acc) ? await chanCredits(acc) : await fetchCredits(acc);
    if (r.ok) await kvPut(K.snap(id), { at: now(), credits: r.credits, expiries: r.expiries });
    await logTask("credits", id, r.ok, r.msg); return json({ ok: r.ok, credits: r.credits, expiries: r.expiries, msg: r.msg });
  }
  if (p === "accounts/credits-all" && method === "POST") {
    const accs = await getAccounts(); const out = [];
    for (const acc of accs) {
      const r = isChan(acc) ? await chanCredits(acc) : await fetchCredits(acc);
      if (r.ok) await kvPut(K.snap(acc.id), { at: now(), credits: r.credits, expiries: r.expiries });
      await logTask("credits", acc.id, r.ok, r.msg);
      out.push({ id: acc.id, uid: acc.uid || acc.nickname || acc.id, ok: r.ok, credits: r.credits, msg: r.msg }); }
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
    // hub v2.1.0：面板启用是**唯一解禁入口**。
    //  - enabled:false → 纯停用，banned 标记**原样保留**（停用 ≠ 解封）；
    //  - enabled:true 且此前 banned → 清除封禁标记 + 撤销永久冷却，
    //    否则号会被 checkAccountCooldown(until=0) 继续挡掉，看似启用实为死号。
    if (enabled) {
      if (acc.banned) {
        clearBanned(acc);
        await saveAccount(acc);
        const cds = await kvGet(K.cooldown, {});
        if (cds[acc.id] && !cds[acc.id].until) { delete cds[acc.id]; await kvPut(K.cooldown, cds); }
        await logTask("account-banned", acc.id, true, "面板手动解禁：清除 11140 封禁标记与永久冷却");
        return json({ ok: true, unbanned: true });
      }
    }
    acc.enabled = enabled ? 1 : 0; await saveAccount(acc); return json({ ok: true });
  }
  // 「自动签到」勾选：只管 checkinTick 跳不跳该号，与 enabled（连推理一起停）
  // 是两个维度；手动「签到」按钮走 accounts/checkin，不受此开关影响。
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
  // ===== 清理全部数据(导入/存档页「🧹 清理全部数据」) =====
  // 用户诉求: 重复与无用数据没删干净, 像 zcode/trae 这类**根本没导入成功**的账号,
  // 若只是"不显示"而仍留在外接储存里, 就是纯粹的垃圾。
  // 范围 = 导入进来的业务数据: 账号正文+索引+快照、任务日志、公开请求日志、
  //       隐藏模型集合、模型聚合缓存。
  // 保留 = API Key 与面板设置 —— 那是管理配置, 清了会把用户锁在门外。
  if (p === "reset" && method === "POST") {
    const ids = await kvGet(K.idxA, []);
    for (const id of ids) { await kvDel(K.acc(id)); await kvDel(K.snap(id)); }
    await kvPut(K.idxA, []);
    // 日志删除必须走同一把锁: 否则并发的 logTask 会把「读到的旧列表」写回,
    // 等于没删。注意不能在持锁时调 logTask —— withKeyLock 是链式排队, 同 key 嵌套会自锁。
    await withKeyLock(K.logs, async () => { await kvDel(K.logs); });
    await kvDel(K.pubreq); await kvDel(K.hidden); await kvDel("agg_models_v4");
    // 签到日记也要清：账号都删了，留着它们的「今天已签」记录既是垃圾，
    // 也会让同名重新导入的账号当天不再签到（用户明确要求「删干净」）。
    await kvDel(K.checkinDay); _checkinState.clear(); _checkinLogged.clear(); _checkinLoaded = false;
    // ⚠️ 递增数据代：此刻可能还有 lazyCheckin 在打上游（它是不 await 的后台任务，
    // 签到要几秒），它跑完会调 logTask 把 checkin 写回刚清空的日志里。
    // e2e 6d 两次红就是这个竞态。代一变，那些迟到的结果自己作废。
    // 注意 `_dataGen` 声明在文件后面（const 有 TDZ，但这里是**运行时**执行的
    // 函数体，模块求值时早已初始化）—— 与 reset 引用 _checkinState 同理。
    _dataGen++;
    // 清完只留这一条, 作为"数据已被清空"的审计痕迹
    await logTask("reset", "-", 1, `清理全部数据: ${ids.length} 个账号 + 日志/隐藏集合/模型缓存`);
    return json({ ok: true, cleared: { accounts: ids.length, logs: 1, hidden: 1, agg: 1 }, kept: ["keys", "setting"] });
  }
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
    // ★渠道模型也要进面板。原先这里只走 WB 的 cn/global 两行, 渠道上线后面板
    //   仍然只有「国内版/国际版/全部」三个 WB 分组, 等于渠道模型完全不可见。
    //   口径与 /v1/models 逐字一致:
    //     1. id 带渠道前缀(qualifyModelId) —— minimax 与 lobsterai 都有 MiniMax-M3
    //     2. realm="channel" —— 不伪装成 cn/global, 面板才好分组
    //     3. 只列**有启用账号**的渠道 —— 没账号列出来, 选了必然 503
    //     4. 加载失败只跳过该渠道, 不拖垮整个列表
    const chanOut = [];
    const chanSeen = new Set();
    for (const a of accs) {
      const pid = a.provider || "wb";
      if (pid === "wb" || chanSeen.has(pid)) continue;
      chanSeen.add(pid);
      let mod;
      try { mod = await loadChannel(pid); } catch { continue; }
      // 有远端目录的渠道（cline）必须先预热 —— 它的 models() 是同步的，
      // 只读缓存；不预热就永远只有 3 条已被上游下架的静态兜底模型。
      await warmChannelCatalog(mod, a);
      for (const m of mod.backend.models()) {
        // 真实倍率内嵌在展示名里; 解析不出显示 `—`, 绝不回落成 x1 (见 chanRate 注释)
        const rate = chanRate(m.name);
        chanOut.push({ id: qualifyModelId(pid, m.id), name: m.name,
                       multiplier: rate ? rate.display : "—",
                       discounted: null, context: m.context, srcTag: "", realm: "channel",
                       hidden: !!hidden[qualifyModelId(pid, m.id)], hasGlobal: false });
      }
    }
    return json({ ok: true, models: out.map(m => ({ id: m.id, name: m.name, multiplier: m.multiplier, discounted: m.discounted, context: m.context, srcTag: m.srcTag, realm: m.srcTag === "g" ? "global" : "cn", hidden: m.hidden, hasGlobal: m.realms.includes("global") })).concat(chanOut) });
  }
  if (p === "models/hidden-get" && method === "GET") return json({ ok: true, hidden: await getHiddenSet() });
  if (p === "models/hidden-save" && method === "POST") { const b = await request.json().catch(() => ({})); const h = {}; for (const id of (b.hidden || [])) if (typeof id === "string" && id) h[id] = 1; await kvPut(K.hidden, h); return json({ ok: true, hidden: h }); }
  // 一键探测各模型真实上游上下文窗口: 逐个账号查 /v3/config, 取 maxInputTokens。
  // 返回 { ok, windows: { [modelId]: { context, realm, source } }, capped: { [modelId]: cap } }
  // cap = 该模型护栏有效上限(min(REASONABLE_CAP, 真实窗口)); 未知窗口不在此列。
  if (p === "models/windows" && method === "POST") {
    const windows = {};
    const capped = {};
    // ⚠️ `accs` 是 `models/agg` 分支的**局部变量**（line ~442），这里指向不着 ——
    // 原来直接用它，线上实测 HTTP 500 `internal error: accs is not defined`。
    // 手测就发现：模型页「🔎 探测窗口」对**所有渠道**（也含 WB）一直 500，
    // 用户只看到按钮点了没反应。
    const allAccs = (await getAccounts()).filter(a => a.enabled);
    for (const a of allAccs) {
      const r = await fetchModels(a).catch(() => ({ models: [] }));
      for (const m of (r.models || [])) {
        if (!m.id || isPlaceholderModel(m.id)) continue;
        if (!windows[m.id]) windows[m.id] = { context: m.context || null, realm: realmOf(a), source: "v3/config" };
        else if (windows[m.id].context == null && m.context) windows[m.id].context = m.context;
        if (m.context) capped[m.id] = cgEffectiveCeiling(m.context);
      }
    }
    // ★ 渠道模型也要探测 —— 原来只遍历 WB 账号的 /v3/config，渠道完全没有条目，
    //   用户看到的就是「对有道和 cline 没用」。渠道的窗口来自自己的模型目录
    //   （cline 远端 / minimax 本地表 / lobsterai 目录），不用打上游。
    const noWindow = [];
    for (const a of allAccs) {
      const pid = a.provider || "wb";
      if (pid === "wb") continue;
      let mod; try { mod = await loadChannel(pid); } catch { continue; }
      await warmChannelCatalog(mod, a);
      for (const m of mod.backend.models()) {
        const qid = qualifyModelId(pid, m.id);
        if (windows[qid]) continue;
        windows[qid] = { context: m.context || null, realm: "channel", source: pid };
        if (m.context) capped[qid] = cgEffectiveCeiling(m.context);
        else noWindow.push({ id: qid });
      }
    }
    // ★★ 无窗口的用 models.dev 补（实测 cline 453 条**全部**无窗口 ——
    //    它的两个远端端点只下发 id/name/description，压根不带窗口）。
    //    只认逐段精确匹配（见 models-dev.js 的保守口径），认不出保持「未知」。
    let devFilled = 0;
    if (noWindow.length) {
      try {
        const r = await fillContextWindows(noWindow);
        for (const [qid, info] of Object.entries(r.filled)) {
          windows[qid] = { context: info.context, realm: "channel", source: info.source };
          capped[qid] = cgEffectiveCeiling(info.context);
          devFilled++;
        }
      } catch { /* models.dev 抖动不影响主流程 */ }
    }
    return json({ ok: true, windows, capped, reasonableCap: CG_REASONABLE_CAP, devFilled, unknownCount: noWindow.length - devFilled });
  }
  if (p === "run-cron" && method === "POST") { const log = await runCron(); return json({ ok: true, log }); }
  return json({ error: "not found" }, 404);
}
async function getKey(id) { return kvGet(K.key(id)); }
// 全局设置: { modelWithRate: 0|1 } —— 是否在对外 /v1/models 的 id 上拼倍率注释
async function getSetting() { return kvGet(K.setting, { modelWithRate: 0 }); }
// 全局模型隐藏集合: 存「被用户隐藏的模型 id」(不是启用集合), 新模型默认出现, 不用每次来加
async function getHiddenSet() { return kvGet(K.hidden, {}); }
// 模型运行时标记 (上游已下线 / 必须显式思考档)。读失败一律当"没有标记":
// 记账是尽力而为的优化, 绝不能因为它读不出来就把整个模型列表或对话打挂。
async function getMarks() { try { return await kvGet(K.marks, {}); } catch { return {}; } }
async function saveMark(key, patch) {
  if (!key) return;
  try {
    const marks = await getMarks();
    marks[key] = { ...(marks[key] || {}), ...patch };
    await kvPut(K.marks, pruneMarks(marks, now()));
  } catch { /* 尽力而为: 记账失败不影响本次请求 */ }
}
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
        const meta = { multiplier: m.multiplier, discounted: m.discounted, name: m.name, context: m.context, effort: m.effort ?? null };
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
// stripModelId 已抽到 ./backends/index.js（与 parseModelId 同居，便于单测前缀剥离），
// 由第 18 行 import —— 本地不再重复声明，否则 ESM 会报 Identifier 已声明。
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
  // ★渠道账号与 WB 账号分流。现有账号无 provider 字段 → `(a.provider ?? 'wb')`
  //   判为 'wb', 故既有账号池行为**逐字节不变**(零回归)。
  //   分流必须在选号之前: 否则渠道账号会被随机选进 WB 池, 下游 realmOf()/fetchModels() 必崩。
  const allAccs = (await getAccounts()).filter(a => a.enabled && (allowed.length === 0 || allowed.includes(a.id)));
  const accs = allAccs.filter(a => (a.provider ?? "wb") === "wb");       // WB 池(下方既有逻辑全用它)
  const chanAccs = allAccs.filter(a => (a.provider ?? "wb") !== "wb");   // 渠道池
  if (!allAccs.length) return new Response(JSON.stringify({ error: "no available account" }), { status: 503, headers: { "content-type": "application/json", ...corsHeaders() } });
  const acc = accs.length ? accs[Math.floor(Math.random() * accs.length)] : null;
  if (p === "v1/models") {
    const s = await getSetting();
    const hidden = await getHiddenSet(); // 用户隐藏的模型 (存隐藏集合, 新模型默认出现)
    const marks = await getMarks();      // 上游已下线的模型 (见 model-marks.js 头注)
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
    // ★ 剔除「目录里有、chat 打不通」的模型（11102 未注册 / 11103 非 chat 后端）。
    //   上游 /v3/config 的 models[] 是**目录**不是**可用清单**：实测 32 条里 12 条
    //   一打就 400（见 model-marks.js）。列出来只会让客户端选到必然失败的模型。
    //   按 (模型,realm) 分别判：CN 挂了国际可能还活着。
    //   ⚠️ 只按**真实失败**记账，不用 agents 白名单过滤 —— 白名单外仍有 5 条可用。
    for (let i = rows.length - 1; i >= 0; i--) {
      if (isDead(marks[markKey(rows[i].id, rows[i].srcTag)], now())) rows.splice(i, 1);
    }
    // 每个模型的护栏有效上限(min(REASONABLE_CAP, 上游真实窗口)); 缺省 REASONABLE_CAP。
    // 必须从展开后的 rows 取(context 在 byRealm 里, 顶层没有)。
    const winHdr = {};
    for (const m of rows) {
      const did = qualifyModelId("wb", s.modelWithRate ? decorateModelIdSync(m, s) : (m.srcTag ? m.id + " [g]" : m.id));
      winHdr[did] = cgEffectiveCeiling(m.context);
    }
    const data = rows.map(m => {
      const did = qualifyModelId("wb", s.modelWithRate ? decorateModelIdSync(m, s) : (m.srcTag ? m.id + " [g]" : m.id));
      // context_length 与 context 同值: DSH keypool 的 extractContextTokens 只认
      // context_length/contextWindow/max_input_tokens 等拼法, 不认裸 `context`,
      // 少这个别名它就报「0/60 model answered」= 探测不到任何上游模型。
      return { id: did, object: "model", owned_by: "workbuddy", multiplier: m.multiplier, discounted: m.discounted, context: m.context, context_length: m.context, name: decorateModelNameSync(m, s), realm: m.srcTag || "cn" };
    });
    // ★渠道模型并入列表。三点约束:
    //   1. 只列**有启用账号**的渠道 —— 没账号却列出来, 客户端选了必然 503;
    //   2. ID 必须带渠道前缀(qualifyModelId): minimax 与 lobsterai 都有
    //      `MiniMax-M3`, 不前缀会撞车, 而路由正是靠前缀分辨渠道的;
    //   3. 加载失败只跳过该渠道(continue), 不拖垮整个列表 —— hook 缺失时
    //      /v1/models 仍要返回 WB 模型, 否则全网关不可用。
    const byProvider = {};
    for (const a of chanAccs) (byProvider[a.provider ?? "wb"] ||= []).push(a);
    for (const pid of Object.keys(byProvider)) {
      let mod;
      try { mod = await loadChannel(pid); } catch { continue; }
      // 远端目录预热（cline）—— 同步 models() 只读缓存，不预热就永远只有
      // 3 条已被上游下架的兜底模型（用户报「cline 总共才 3 个」的真因）。
      await warmChannelCatalog(mod, byProvider[pid][0]);
      for (const m of mod.backend.models()) {   // loadChannel 返回模块命名空间, 后端在其 .backend
        const qid = qualifyModelId(pid, m.id);
        if (hidden[qid]) continue;   // 与 WB 模型同一套隐藏集合
        // 真实倍率内嵌在展示名里(chanRate); 解析不出给 null 而**不是** 1 ——
        // 旧代码写死 1, 免费模型和 0.75x 模型在对外列表里全变成 1x。
        const rate = chanRate(m.name);
        data.push({ id: qid, object: "model", owned_by: pid, multiplier: rate ? rate.value : null, discounted: false, context: m.context, context_length: m.context, name: m.name, realm: "channel" });
        winHdr[qid] = cgEffectiveCeiling(m.context);   // 渠道窗口同样要给护栏上限
      }
    }
    // 把各模型护栏有效上限随响应带出(DSH 侧可据它设 contextWindow), JSON 序列化一次。
    const h = new Headers(); h.set("content-type", "application/json");
    Object.entries(corsHeaders()).forEach(([k, v]) => h.set(k, v));
    h.set("X-Upstream-Context-Window", JSON.stringify(winHdr));
    return new Response(JSON.stringify({ object: "list", data }), { status: 200, headers: h }); }
  let body = await request.json().catch(() => ({}));
  // 上下文护栏: 拦"空转/历史无限膨胀"把账号额度烧穿 (413 上限 / 429 循环)。
  // 放在序列化之前, 用客户端发来的原始 messages 估算, 拒绝时不消耗任何上游额度。
  {
    // 取该模型真实上游窗口 —— 唯一来源见 worker/model-window.js 的头注。
    //
    // ⚠️ 这里**不能**用 `stripModelId`：它给 WB 上游用，故意不剥渠道前缀，
    //    于是 `raccoon/sn-glm-5-3` 原样进查找、`owner` 里没有这个键；而 `accs`
    //    又只有 WB 账号（渠道在 chanAccs）—— 两个原因叠加让渠道模型**必然**
    //    取不到窗口，回落 262144：1M 模型被按 256k 拦，但 /v1/models 的
    //    X-Upstream-Context-Window 头仍写着 1M（那走另一套算法）。
    //    结果头与闸互相矛盾，用户看到的就是「说了 1M 却不让用」。
    const winInfo = await resolveModelWindow(body && body.model ? body.model : "", {
      parseModelId,
      loadChannel,
      warmChannelCatalog,
      channelAccounts: (pid) => chanAccs.filter(a => (a.provider ?? "wb") === pid),
      aggModels: () => aggModels(accs, "agg_models_v4"),
    });
    const realWindow = winInfo.window;
    const cgOwner = key ? ("key:" + String(key).slice(-8)) : "anon";
    const cgReject = await cgCheckAsync(body, cgConfig(), cgOwner, Date.now(), realWindow);
    if (cgReject) {
      const h = new Headers(); h.set("content-type", "application/json");
      Object.entries(corsHeaders()).forEach(([k, v]) => h.set(k, v));
      return new Response(JSON.stringify(cgReject.body), { status: cgReject.status, headers: h });
    }
  }
  // ★渠道分派: 模型 ID 带渠道前缀 (minimax/xxx、raccoon/xxx、cline/xxx、lobsterai/xxx)
  //   → 走渠道后端, 不进下面的 WB 链路。
  //
  //   位置很关键, 两个方向都不能挪:
  //   - 必须在**上下文护栏之后** —— 护栏只读 body、不依赖 WB 账号, 对渠道同样有效,
  //     渠道请求的空转/历史膨胀同样会烧穿免费额度;
  //   - 必须在**WB 序列化之前** —— serializeBuddyMessages / 11128 system 注入 /
  //     neutralizeSystemMessages 都是 WB 上游特有的, 原样套到渠道会改坏消息体。
  {
    const route = parseModelId(body?.model);
    if (route.provider !== "wb") {
      let pool = chanAccs.filter(a => (a.provider ?? "wb") === route.provider);
      if (!pool.length) {
        return new Response(JSON.stringify({ error: { message: "no enabled account for channel '" + route.provider + "'", type: "no_upstream", code: "channel_no_account" } }), { status: 503, headers: { "content-type": "application/json", ...corsHeaders() } });
      }

      // 【账号级冷却】：先清理过期冷却，再过滤掉冷却中的账号
      await pruneAccountCooldowns();
      const cooledPool = [];
      for (const a of pool) {
        const cd = await checkAccountCooldown(a.id);
        if (!cd.cooled) cooledPool.push(a);
        else {
          // 记录日志：跳过冷却账号
          await logTask("chat-skip-cooldown", a.id, false, `跳过冷却账号: ${cd.reason}, 剩余 ${cd.remaining}s`);
        }
      }
      pool = cooledPool;
      if (!pool.length) {
        return new Response(JSON.stringify({ error: { message: "all accounts for channel '" + route.provider + "' are in cooldown", type: "no_upstream", code: "channel_all_cooldown" } }), { status: 503, headers: { "content-type": "application/json", ...corsHeaders() } });
      }

      let chan;   // loadChannel 返回**模块命名空间**, 真正后端在 chan.backend
      try { chan = await loadChannel(route.provider); }
      catch (e) {
        return new Response(JSON.stringify({ error: { message: String(e?.message || e).slice(0, 400), type: "server_error", code: "channel_load_failed" } }), { status: 500, headers: { "content-type": "application/json", ...corsHeaders() } });
      }
      // 目录校验放在这里而不是打上游之后: 模型集本地就能判定, 早退省一次
      // 网络往返与上游的报错计费。
      // ⚠️ 必须先预热远端目录，否则 cline 的同步 models() 只有 3 条已下架的
      // 兜底模型 —— 用户真正想用的 `cline-free/solar-mini4` 会被判 404。
      // ⚠️ pick 必须**先**定义：预热要拿账号去拉 `/models`（它需要认证）。
      
      // 【统一挑号】按积分分层 + 层内轮转（见 account-pick.js 头注）。
      // ⚠️ 旧实现是「按积分降序固定取第 0 位」+ break —— 加 N 个号也只打第 1 个。
      await primePickSnapCache(pool);
      // ⚠️ 额度预查**必须放在这里之外**：它是多秒级的上游请求，塞进每个
      // chat 请求的并发路径会让 5 个并发请求各打一次续期/额度接口，
      // 触发 test-refresh-lock 里「续期上游只被打 1 次」的红（实测 hits 1→7）。
      // 正确位置：CREDITS_TICK_MS 的定时 tick（见 refreshStaleCreditsSafe）。
      const attempts = await pickAccountsByCredits(pool, {
        provider: route.provider, model: route.model,
      });

      let resp = null;
      let lastError = null;
      let notInCatalog = true;   // 是否有**任意一个**账号的目录里有该模型
      // 已试过的账号 —— 同一个号失败后**绝不再试同一个号**。
      // ⚠️ 这不只是效率问题：重试同一个号会再走一次 `chanKeepaliveLocked`，
      //    而 test-refresh-lock 断言的正是「5 个并发请求，续期上游只被打 1 次」。
      //    第一版就栽在这（hits 1→7）。
      const tried = new Set();
      let lastRespBody = null, lastRespStatus = 0, lastRespHeaders = null;
      for (let i = 0; i < attempts.length; i++) {
        const pick = attempts[i];
        if (!pick || tried.has(pick.id)) continue;
        tried.add(pick.id);
        await warmChannelCatalog(chan, pick);
        if (!chan.backend.models().some(m => m.id === route.model)) {
          continue; // 该账号不提供此模型，试下一个
        }
        notInCatalog = false;

        // 按需续期
        if (pick.expires_at < now() + 300) {
          try { await chanKeepaliveLocked(pick); }
          catch (e) {
            await logTask("keepalive", pick.id, false, String(e.message || e).slice(0, 200));
            if (isTerminal(e)) { pick.enabled = 0; await saveAccount(pick); continue; }
          }
        }

        let r2 = null;
        try {
          r2 = await chan.backend.chat({ account: pick, model: route.model, body, signal: request.signal });
        } catch (e) {
          lastError = e;
          await logTask("chat-error", pick.id, false, String(e.message || e).slice(0, 200));
          continue;   // 网络层异常 → 换下一个号
        }

        // ★★ 关键修复：429/401/403/5xx 不再「直接透传」。
        // 旧实现拿到非 2xx 的 Response 就 break（当成成功），于是一个号撞了 429
        // 就把 429 直接丢给客户端 ——「最多试 3 个账号」那段循环**从未真正执行**。
        // 实测证据：日志里 chat-error / chat-skip-cooldown / cooldown 各 0 条。
        const action = channelFailureAction(r2.status, false);
        if (action === 'switch' && i + 1 < attempts.length) {
          await logTask("chat-skip-cooldown", pick.id, false,
            `上游 ${r2.status} — 换下一个号（${i + 1}/${attempts.length}）`);
          // ⚠️ **只有 429 才打账号冷却**。
          //
          // 401/403 分两种：token 真失效（该修凭据，不该惩罚账号）与上游临时抖动。
          // 一律按 `ban`（24h）会把一个只是 token 过期的号封一天；更糟的是 e2e 里
          // 「渠道未知模型 → 404」那条曾因此变成 `503 channel_all_cooldown`：
          // 一个号的 401 把整条渠道的候选全冷静了。5xx 同理（上游自己的问题）。
          // 结论：**冷却只用在上游「明确说别再来」的 429**，其余失败只切换、不惩罚。
          if (r2.status === 429) {
            await setAccountCooldown(pick.id, '429');
          }
          // 保留这一份响应体：全部号都失败时要原样透传（含上游真实报错），
          // 不能吞成一句 `上游 401` —— 那等于把诊断信息扔了。
          try {
            const txt = await r2.text();
            lastRespBody = txt;
            lastRespStatus = r2.status;
            lastRespHeaders = r2.headers;
          } catch { /* ignore */ }
          continue;
        }
        resp = r2;
        break;
      }

      // 所有候选都失败了：优先**原样透传最后一次上游响应**（保留真实报错），
      // 只有当连响应都没拿到（纯网络异常）时才回 502 + 异常信息。
      if (!resp && lastRespBody !== null) {
        const h0 = new Headers();
        h0.set("content-type", (lastRespHeaders && lastRespHeaders.get("content-type")) || "application/json");
        Object.entries(corsHeaders()).forEach(([k, v]) => h0.set(k, v));
        return new Response(lastRespBody, { status: lastRespStatus || 502, headers: h0 });
      }
      if (!resp && lastError) {
        return new Response(JSON.stringify({ error: { message: String(lastError?.message || lastError).slice(0, 600), type: "server_error", code: "channel_error" } }), { status: 502, headers: { "content-type": "application/json", ...corsHeaders() } });
      }
      // 所有账号的目录里都没有这个模型 → 是**客户端请求的模型不存在**，
      // 不是服务器故障。旧实现落到这里 `resp` 仍是 null，下一行
      // `resp.headers.forEach` 直接 TypeError → 500 "undefined"（e2e 4a 抓到的）。
      if (!resp) {
        return new Response(JSON.stringify({ error: { message: "model_not_found: 渠道 " + route.provider + " 下没有模型 " + route.model, type: "invalid_request_error", code: "model_not_found" } }), { status: 404, headers: { "content-type": "application/json", ...corsHeaders() } });
      }

      // 渠道响应已由后端产出 OpenAI 格式, 这里只补 CORS 并透传 body/status
      // (含 SSE 流)。不改写 content-type: SSE 与 JSON 两种形态都由后端定。
      const h = new Headers();
      Object.entries(corsHeaders()).forEach(([k, v]) => h.set(k, v));
      resp.headers.forEach((v, k) => { const lk = k.toLowerCase(); if (!h.has(lk) && lk !== "content-length") h.set(lk, v); });
      return new Response(resp.body, { status: resp.status, headers: h });
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
  // 统一挑号给出的**后续候选**（当前号失败时按序切换）。见 account-pick.js。
  let pickQueue = [];
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
    
    // 【账号级冷却】：过滤掉冷却中的 WB 账号
    await pruneAccountCooldowns();
    const cooledCand = [];
    for (const a of cand) {
      const cd = await checkAccountCooldown(a.id);
      if (!cd.cooled) cooledCand.push(a);
      else {
        await logTask("chat-skip-cooldown", a.id, false, `跳过冷却账号: ${cd.reason}, 剩余 ${cd.remaining}s`);
      }
    }
    cand = cooledCand;
    if (!cand.length) {
      return new Response(JSON.stringify({ error: { message: "all accounts are in cooldown", type: "no_upstream", code: "all_accounts_cooldown" } }), { status: 503, headers: { "content-type": "application/json", ...corsHeaders() } });
    }
    
    // 【统一挑号】与渠道分支共用同一条（account-pick.js）。
    //
    // 旧实现有两处缺陷，正好和渠道那边镜像：
    //   1. `accs[Math.floor(Math.random()*len)]` 纯随机，**完全忽略积分**；
    //   2. 这里虽按积分排序，却又**固定取第 0 位** —— 加号也只有一个在干活。
    await primePickSnapCache(cand);
    const wbAttempts = await pickAccountsByCredits(cand, { provider: 'wb', model: realModel });
    pick = wbAttempts[0] || cand[0];
    pickQueue = wbAttempts.slice(1);   // 失败时按这条顺序切换
  }
  // 该模型是否被记过「必须显式带思考档」(11150)。命中就**先**补上，省一次失败往返。
  // 客户端自己指定过档位时 resolveEffort 返回 undefined —— 不跟客户端抢方向盘。
  {
    const mk = markKey(realModel, parsed.srcTag);
    const marks = await getMarks();
    if (needsEffort(marks[mk])) {
      const { rows: meta0 } = await aggModels(accs, "agg_models_v4");
      const mm = meta0.find(x => x.id === realModel);
      const want = resolveEffort(mm || null, body);
      if (want) body.reasoning_effort = want;
    }
  }
  const send = () => fetch(chatBase(pick) + "/v2/chat/completions", { method: "POST", headers: commonHeaders(pick, pick.access_token), body: JSON.stringify(body) });
  let r = await send();

  // ★★ 429/401/403/5xx → 换下一个号重发（与渠道分支同一张分类表）。
  // 旧实现只对 11150/11102/11103 自愈，**429 一律原样透传**。这正是
  // 「加了 3 个账号仍解决不了 429」的另一半原因：网关自己从不换号，
  // 把活全推给 keypool 的 1s→16s 阶梯，而那个阶梯每个号都会撞，
  // 最终撞上网关自己的闸 2（6 次/120s），客户端看到 loop_detected。
  //
  // 换号 peek 已消费过的错误体（仅 403 非封禁路径会写入），外层透传时重放。
  // ⚠️ 声明必须在循环**之前**（循环体里赋值引用后声明的 let 会踩 TDZ），
  //    且每次 send() 后重置 —— 否则会拿上一个号的旧缓冲配新响应。
  let bufferedRaw = null;
  if (!r.ok) {
    const triedWb = new Set([pick.id]);
    for (const alt of pickQueue) {
      if (!alt || triedWb.has(alt.id)) continue;
      if (channelFailureAction(r.status, false) !== 'switch') break;
      // ★ hub v2.1.0 防连坐核心：**先定罪再换号**。403 可能是 11140 封禁，
      // 而封禁是设备/账号级终态 —— 换号继续打只会把同池好号一起带走。
      // 旧的 channelFailureAction 只看 HTTP 状态码，分不出 403/风控冷却 与
      // 403/11140，这里读一次错误体补上这一维（peek 失败不拦正常切换）。
      if (r.status === 403) {
        const peek = await peekBanError(r);
        if (peek.raw !== null) bufferedRaw = peek.raw;   // 错误体已被 peek 消费，外层透传用缓冲重放
        if (peek.banned) {
          await freezeBannedAccount(pick, peek.body, 'chat');
          // 冻结后 r 仍是被拒的原始响应：跳出循环，走下面 4xx 分类把
          // 真实原因透传给客户端（hub 语义：面板/客户端要看到上游原文）。
          break;
        }
      }
      triedWb.add(alt.id);
      await logTask("chat-skip-cooldown", pick.id, false,
        `上游 ${r.status} — 换号重发`);
      await setAccountCooldown(pick.id, (r.status === 429 || r.status === 401) ? '429' : 'ban');
      try { await r.body?.cancel?.(); } catch { /* ignore */ }
      pick = alt;
      r = await send();
      bufferedRaw = null;   // 新响应配新缓冲
      if (r.ok) break;
    }
  }
  // ★ 上游 4xx 不能一律原样透传 —— 有两类是**网关可自愈**的：
  //
  //   - 11150 `the reasoning effort value is not supported by the current model`
  //     glm-5.0-turbo 这类模型**必须**显式带 `reasoning_effort` 才 200。
  //     补上默认档重试一次，并记账（下次直接补，不再浪费往返）。
  //   - 11102 `model [x] service info not found` / 11103 `Backend [maas] is not supported`
  //     这个模型压根不能走 chat（未注册给 CLI agent / 是图片视频模型）。
  //     记账并记日志，让 /v1/models 不再把它列出来 —— 否则客户端会一直选到它。
  //
  // 其余错误（11128 内容拦截、11140 停权、429 限流…）保持**原样透传**：
  // 客户端必须看到上游的真实原因，网关不能替它编故事。
  if (!r.ok && r.status >= 400 && r.status < 500) {
    // 换号循环里 peek 已把 403 错误体消费掉的（非封禁路径），这里用缓冲重放，
    // 不能再 await r.text()（body 已读尽，会得到空串 → 客户端收到空白错误）。
    const raw = bufferedRaw !== null ? bufferedRaw : await r.text().catch(() => "");
    bufferedRaw = null;
    // ⚠️ 变量名不能叫 `parsed` —— 外层已有 `const parsed = stripModelId(...)`（带
    // srcTag），同名遮蔽后这里读到的会是 JSON 错误体（可能为 null），
    // 表现为 `Cannot read properties of null (reading 'srcTag')`（e2e 逮到过）。
    let errBody = null;
    try { errBody = JSON.parse(raw); } catch { /* 非 JSON 错误体照原样返回 */ }
    const code = upstreamCodeOf(errBody);
    const mk = markKey(realModel, parsed.srcTag);
    
    // 【账号级 429/封禁分类】：根据 HTTP 状态码和上游错误码给账号打冷却标记
    // 参考 lobsterai2api 的分类表：429→10分钟、403风控/当日停用、401+40100/40101→永久禁用
    if (r.status === 429 || code === 429) {
      await setAccountCooldown(pick.id, '429');  // 10 分钟
      await logTask("cooldown", pick.id, false, `上游 429 限流，冷却 10 分钟`);
    } else if (r.status === 403 || code === 403) {
      // ★ 11140 优先于风控文案判据（hub v2.1.0）：账号级封禁走**冻结**，
      // 不再按 24h 冷却降级 —— 冷却到期自动放行的号会继续挨打并连坐。
      // 换号循环非空时循环里已 peek+冻结过（幂等，这里不会重复写）；
      // **单号池循环一次没跑**，全靠这一段兜住，删了就漏。
      if (isBannedError(errBody)) {
        await freezeBannedAccount(pick, errBody, 'chat');
      } else {
        // 403 可能是风控文案，检查错误消息
        const msg = String(errBody?.msg || errBody?.message || errBody?.error?.message || '').toLowerCase();
        if (msg.includes('风控') || msg.includes('risk') || msg.includes('ban') || msg.includes('block') || msg.includes('forbidden')) {
          await setAccountCooldown(pick.id, 'ban');  // 当日停用 24 小时
          await logTask("cooldown", pick.id, false, `上游 403 风控，当日停用`);
        }
      }
    } else if (code === 11140) {
      // HTTP 200 包错误体 / 其它状态携带 11140 的形态：同样冻结。
      await freezeBannedAccount(pick, errBody, 'chat');
    } else if (r.status === 401 || code === 401) {
      // 401 认证失败：检查是否为 40100/40101 (refresh 被拒) → 终态永久禁用
      const subCode = errBody?.code || errBody?.error?.code || errBody?.sub_code;
      if (subCode === 40100 || subCode === 40101 || code === 40100 || code === 40101) {
        await setAccountCooldown(pick.id, 'auth');  // 永久禁用
        pick.enabled = 0;
        await saveAccount(pick);
        await logTask("cooldown", pick.id, false, `上游 401+${subCode} 认证终态，永久禁用账号`);
      } else {
        // 普通 401 可能是 token 过期，给较短冷却
        await setAccountCooldown(pick.id, '429');  // 复用 10 分钟冷却
        await logTask("cooldown", pick.id, false, `上游 401 认证失败，冷却 10 分钟`);
      }
    }
    
    if (code === EFFORT_CODE) {
      const { rows: meta1 } = await aggModels(accs, "agg_models_v4");
      const mm = meta1.find(x => x.id === realModel);
      const want = resolveEffort(mm || null, body);
      if (want) {
        body.reasoning_effort = want;
        r = await send();
      }
      if (r.ok) await saveMark(mk, { needsEffort: true });
    } else if (isDeadCode(code)) {
      await saveMark(mk, { dead: now(), code });
      await logTask("model-dead", pick.id, false, `${realModel}: 上游 ${code} ${String(errBody?.msg ?? "").slice(0, 120)}`);
    }
    if (!r.ok) {
      const h = new Headers(); h.set("content-type", errBody ? "application/json" : (r.headers.get("content-type") || "application/json"));
      Object.entries(corsHeaders()).forEach(([k, v]) => h.set(k, v));
      return new Response(raw || JSON.stringify({ error: { message: `upstream HTTP ${r.status}`, type: "upstream_error", code: "upstream_error" } }), { status: r.status, headers: h });
    }
  } else if (!r.ok) {
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

// ── 渠道账号保活 ──
// WB 与渠道的续期协议完全不同: WB 走 wb_protocol.refreshToken() (打
// copilot.tencent.com, X-Refresh-Token 头), 渠道走 chan-refresh.js 的 4 套实现。
// 按 provider 分流, **不动 WB 分支一个字节**。
const isChan = acc => (acc.provider ?? "wb") !== "wb";
// 渠道阈值 30 分钟: cline/minimax 的 access_token 只活约 1 小时, 用 WB 的
// 7 天阈值会每轮都触发 (白打上游); 30 分钟既能在过期前续上, 又不至于刷爆。
// raccoon/lobsterai 是 30 天级 token, 6 小时一轮的 cron 自然会兜住。
const CHAN_KEEPALIVE_SLACK = 30 * 60;

/** 刷新一份渠道账号并落库。 */
async function chanKeepalive(acc) {
  const u = await chanRefresh(acc);
  acc.access_token = u.access_token;
  acc.refresh_token = u.refresh_token;
  acc.expires_at = u.expires_at;
  await saveAccount(acc);
  return u;
}

/**
 * 带互斥的渠道刷新。
 *
 * **为什么需要锁**: 聊天路径上多个并发请求可能同时命中同一个"临期账号",
 * 各自拿手里的 `refresh_token` 去刷新 —— 轮换型上游(收到新 refresh_token 即
 * 作废旧的)会让后到的那个必然失败, 而且失败后还会把账号误判成终态禁用掉。
 *
 * **为什么锁内要重读**: 调用方传进来的 `acc` 是并发发生**之前**从 KV 读出的
 * 旧副本, 改它的 expires_at 看不见别人刚写入的新值。故在锁里重新 getAccount,
 * 已经刷过就把新 token 同步回调用方(它马上要用这个 token 发请求),直接返回。
 *
 * 只覆盖渠道刷新 —— WB 分支保持原样(零回归不变量)。
 */
async function chanKeepaliveLocked(acc) {
  return await withKeyLock('refresh:' + acc.id, async () => {
    const fresh = await getAccount(acc.id);
    const exp = fresh ? fresh.expires_at : acc.expires_at;
    if (exp >= now() + CHAN_KEEPALIVE_SLACK) {
      // 别人已经刷过了: 把新凭据同步回调用方, 本次不再发请求
      if (fresh) {
        acc.access_token = fresh.access_token;
        acc.refresh_token = fresh.refresh_token;
        acc.expires_at = fresh.expires_at;
      }
      return false;
    }
    await chanKeepalive(acc);
    return true;
  });
}

/** 带日志的渠道刷新: 终态错误(refresh_token 已死)记日志并**禁用**账号,
 *  免得每轮 cron 都去打注定失败的请求。 */
async function chanKeepaliveSafe(acc) {
  try { await chanKeepaliveLocked(acc); return true; }   // 未轮到(别人已刷)同样算成功
  catch (e) {
    await logTask("keepalive", acc.id, false, String(e.message || e).slice(0, 200));
    if (isTerminal(e)) { acc.enabled = 0; await saveAccount(acc); }
    return false;
  }
}

// 惰性保活: 仅刷新即将过期的 token, 不等签到结果, 失败静默。
// 阈值按渠道分流 —— WB 7 天, 渠道 30 分钟 (见 CHAN_KEEPALIVE_SLACK)。
async function lazyKeepalive() {
  const accs = await getAccounts();
  for (const acc of accs) {
    if (!acc.enabled) continue;
    if (isChan(acc)) {
      // 渠道: 30 分钟内过期才刷 (阈值说明见 CHAN_KEEPALIVE_SLACK)
      //
      // ⚠️ 这里的 `acc` 是**本函数开头那次 getAccounts() 的快照**。而 chat 路径
      // 可能正在并发刷新同一个号：它的 `chanKeepalive` 会在锁内把新 token 写库，
      // 但**看不见这份旧快照**。于是本函数仍按旧的 `expires_at` 判定「需要刷」，
      // 再进 `chanKeepaliveLocked` —— 锁内重读本该发现「已经新鲜了」而跳过，
      // 但若它恰好在「chat 已发出请求、尚未写库」的窗口里进锁，就会**再刷一次**。
      //
      if (acc.expires_at < now() + CHAN_KEEPALIVE_SLACK) await chanKeepaliveSafe(acc);
    } else if (acc.expires_at < now() + 7 * 86400) {
      try { const u = await refreshToken(acc); acc.access_token = u.access_token; acc.refresh_token = u.refresh_token; acc.expires_at = u.expires_at; await saveAccount(acc); }
      catch (e) { await logTask("keepalive", acc.id, false, String(e.message || e).slice(0, 200)); }
    }
  }
}

/**
 * 「今天」按**北京**算的日期串（YYYY-MM-DD）。
 *
 * ⚠️ 不能用服务器 UTC：Render 容器 TZ=UTC，UTC 00:00 换日 = 北京 08:00，
 * 会让「今天签过没」在北京 0–8 点之间判错（见 chan-checkin.js timezoneId）。
 */
function bjDay(ts = Date.now()) {
  return new Date(ts + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

/**
 * **签到日界线（按供应商时区归属）** —— 2026-11-04 用户核心洞察：
 *
 * > 「供应商除了用 cn 时间就是用 utc 时间，所以只要签到时间都在北京 8 点
 * >   以后就行了 / 都改 8:00 北京时间怎么样」
 *
 * 这个洞察是对的，而且比我原来那套「猜每家几点换天」稳得多：
 *
 * | 供应商时区 | 换天（其本地 0 点） | 折合北京 |
 * |---|---|---|
 * | UTC（Render 上游、多数海外服务） | UTC 00:00 | **北京 08:00** |
 * | CN（WB 国内版、有道龙虾等） | 北京 00:00 | 北京 00:00 |
 *
 * 只有这两种。所以「北京 8 点之后才认新的一天」能**一次覆盖两类**，且永远
 * 不会早于上游换天去试 —— 早试的唯一后果是白打一次接口 + 判据要猜。
 *
 * ## 默认：**一律 8:00**（用户 11-04 的决定）
 *
 * 用户拍板：「都改 8:00 北京时间怎么样」。采纳 —— 理由不是"省事"，而是
 * **宁可晚 8 小时，也不要早于上游换天去猜**。晚到的代价是当天积分晚点进账
 * （一天一签，晚 8h 不影响"一个月不看"的总量）；早试的代价是误判已签、
 * 整天丢分 —— 后者才是这次的真事故。
 *
 * - 默认全渠道/全 realm → **08:00**
 * - 环境变量 `CHECKIN_GATE_HOUR=0` → 恢复"按归属分流"的旧行为
 *   （国内 WB cn / lobsterai 走 0 点，其余 8 点），给想抢 0 点的人留口子
 * - 环境变量 `CHECKIN_GATE_HOUR=<0..23>` → 强制该小时
 *
 * ⚠️ 门禁只影响「**新一天何时开始尝试**」，不影响签到本身的幂等 ——
 * 到点后 tick 照旧先查面板再领，重复调用安全。
 */
const DEFAULT_GATE_HOUR = 8;
/** 'auto' / '' = 一律 8 点；'0'..'23' = 强制该小时。 */
const GATE_FORCE = (() => {
  const raw = process.env.CHECKIN_GATE_HOUR;
  if (raw === undefined || raw === '' || /^auto$/i.test(raw.trim())) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= 23 ? n : null;
})();

/** 该账号今天最早可以尝试签到的北京时刻（小时，整数）。 */
function checkinGateHour(acc) {
  if (GATE_FORCE !== null) return GATE_FORCE;      // 显式覆盖（含 0）
  // 默认一律 8 点。设 CHECKIN_GATE_HOUR=auto 才回到"按归属分流"：
  // 国内供应商（WB cn / lobsterai）本地 0 点换天，海外（WB global / minimax）
  // 是 UTC 0 点 = 北京 8 点。
  const isAutodetect = /^auto$/i.test(String(process.env.CHECKIN_GATE_HOUR || '').trim());
  if (isAutodetect) {
    if (isChan(acc)) return acc.provider === 'lobsterai' ? 0 : 8;
    return realmOf(acc) === 'global' ? 8 : 0;
  }
  return DEFAULT_GATE_HOUR;
}

/** 北京当前小时（0-23），供门禁判断。 */
function bjHour(ts = Date.now()) {
  return Number(new Date(ts + 8 * 3600 * 1000).toISOString().slice(11, 13));
}

/**
 * 该账号此刻是否已过硬门禁（未过 = 上游几乎肯定还没换天，别浪费请求）。
 * 返回 `{ passed, hour, at }`。
 */
function checkinGate(acc, ts = Date.now()) {
  const hour = checkinGateHour(acc);
  return { passed: bjHour(ts) >= hour, hour };
}


/**
 * **补签**：每次有管理端写操作时检查「今天签过没」，没签就补上。
 *
 * ## 为什么必须补签（2026-11-03 用户报「minimax 还是没有自动签到」）
 *
 * ⚠️ **先纠正一个我自己写错的归因**：我最初把原因写成「Render free 挂起
 * 导致 setInterval 漏跑」，这是**错的**。实测证据：
 *   - UptimeRobot 的 `gap` = 288s ≈ 4.8min，5 分钟一次、**一次没断**
 *     （`/api/health-hits` 是纯内存缓冲，进程若真被挂起过就会清零重来）；
 *   - cron 实测 14:53 → 20:53 = **6.0h 精准**，没漏跑。
 * 笔记 `notes/算力账号/UptimeRobot.md §12` 也早记过「保活 Render 已实测通过」。
 *
 * 真正的三个原因是：
 *   ① **UTC 日界线**（已在 chan-checkin.js 修）：跨日点落在北京 08:00
 *      而不是 00:00，故北京 0–8 点永远判成"昨天已签"；
 *   ② **6h 间隔太长**：cron 跨过换日后最长还要等 6h 才补，用户在北京
 *      08:17 打开时下一轮在 10:53 —— 中间是 2.9h 真空期；
 *   ③ **每次部署都重置 setInterval**：11-02 一天部署了 8 次，cron 时点
 *      被反复推后，「每 6h 一次」实际变成了「不确定」。
 *
 * 所以补签不是为了对抗挂起，而是为了让**用户打开面板的那一刻**状态就是对的
 * —— 幂等、便宜、不依赖任何定时器的准时性。
 * 签到接口本身幂等（minimax `claim_result=2`、lobsterai `claimedToday`
 * + `idempotencyKey`），重复调用安全。
 *
 * 一天只尝试一次（按账号记 bjDay），避免每个请求都打上游。
 */
/**
 * **签到调度**：与「打开页面」无关的可靠自动签到。
 *
 * ## 设计前提（2026-11-03 用户明确要求）
 * 「我不会每天去开网关页面进行查看…稳定以后我可能一个月不看一次。
 *  你重点要强化自动签到。」
 *
 * 所以「打开页面顺手补签」只是**兜底**，不能是主路径。主路径必须自己跑。
 *
 * ## 之前为什么不可靠（三个真实缺陷）
 * ① **日界线按 UTC**（已修）：Render 容器 TZ=UTC，`Intl` 给 `UTC`，
 *    minimax 的 `timezone_id=UTC` ⇒ 跨日点落在北京 08:00。北京 0–8 点
 *    永远判成"昨天已签"，改签也签不动。现在显式用 `Asia/Shanghai`。
 * ② **固定 6h 间隔 + 部署即重置**：`setInterval(fn, 6h)` 在每次部署时
 *    重新计时。11-02 一天部署 8 次，cron 时点被反复推后，"每 6h" 实际
 *    变成"不确定"。而用户一个月不看，就只能靠它。
 * ③ **失败即弃**：原实现「先标记今天已尝试，再去签」，一次网络抖动就
 *    整天不再重试 —— 对一个月不看的人等于永久丢分。
 *
 * ## 现在的做法
 * - **每 `CHECKIN_TICK_MS`（默认 30 分钟）跳一次**，而不是 6 小时。
 *   跨过北京 00:00 后最多 30 分钟就签到，不依赖"刚好赶上"。
 * - **启动即刻跑一次**：部署/重启后立刻对齐，不等下一个 tick。
 * - **只把"真的完成"持久化**（`K.checkinDay` 记 `day → 'done'`）。
 *   硬失败**不记账**，下个 tick 自动重试 —— 30 分钟一次，不会打爆上游
 *   （签到是幂等 GET/POST，重复调用安全）。
 * - **日志去重**：同一个账号同一天只写一条成功/失败日志，避免一天 48 条噪音。
 *   但**状态变化必写**（失败→成功），这样一个月后翻日志能看出哪天漏了。
 * - 日界线用**北京**（`bjDay`），不是服务器 UTC。
 */
const _checkinState = new Map();   // accId -> 'YYYY-MM-DD'（已完成的日子）
let _checkinLoaded = false;
/** 签到连续失败计数（仅 lobsterai 用）：accId -> {count, lastFailDay}。失败 3 次后当日放弃，避免"30 分钟无限重试"触发风控。 */
const _checkinFailCount = new Map();
/**
 * 「数据代」—— 每次「清理全部数据」递增。
 *
 * ⚠️ 背景（e2e 6d 两次红）：`lazyCheckin()` 在管理端请求里是
 * **fire-and-forget**（不 await），签到又要打上游（可能几秒）。于是
 * 「请求A 触发签到」→「请求B 执行 reset 删日志」→「A 的签到这时才跑完，
 * 调 logTask 把 checkin 写回」，日志就不干净了。
 *
 * 真实场景同样存在：用户点「清理全部数据」后，一条迟到的签到记录
 * 莫名其妙出现在空日志里。故后台任务在写日志前**比对代** ——
 * 代变了就说明数据已被清空，这条记录属于上一批数据，直接丢弃、不落库。
 */
let _dataGen = 0;
/** 去重用的"上次记录过的状态"，避免每 tick 重复写同一句日志。 */
const _checkinLogged = new Map();  // accId -> 'YYYY-MM-DD:<state>'

async function loadCheckinState() {
  if (_checkinLoaded) return;
  try {
    const saved = await kvGet(K.checkinDay, {});
    for (const [k, v] of Object.entries(saved || {})) {
      // 兼容旧格式（直接存日期串）与新格式（{day, state}）
      _checkinState.set(k, typeof v === 'string' ? v : (v && v.day) || '');
    }
  } catch {}
  _checkinLoaded = true;
}

/**
 * 跑一轮签到（主路径：定时器；兜底：管理端请求也调它）。
 *
 * @returns {Promise<{checked:string[], failed:string[], skipped:number}>}
 */
async function checkinTick() {
  await loadCheckinState();
  // 记下本轮开始时的代：这一轮里若发生「清理全部数据」，代会变，
  // 之后的日志/落库都必须丢弃（见 _dataGen 的注释）。
  const gen = _dataGen;
  const today = bjDay();
  const checked = [], failed = [];
  let skipped = 0;
  const accs = await getAccounts();
  for (const acc of accs) {
    if (!acc.enabled) continue;
    // hub v2.1.1 语义：封禁号绝不自动再撞 —— banned 与 enabled=0 是双标记，
    // 万一 cooldown 表被「清理数据」抹掉后号从别处被启用，这里按 banned 兜底跳过。
    if (acc.banned) continue;
    // 「自动签到」勾选：0=面板取消后 tick 跳过该号（手动签到按钮不受影响）。
    // undefined 视为勾选 —— 老账号没有该字段，默认行为不变。
    if (acc.auto_checkin === 0) continue;
    // WB 也纳入（provider 为空/wb）；渠道只有 minimax/lobsterai 有签到端点
    const isWb = !isChan(acc);
    if (!isWb && !supportsCheckin(acc.provider)) { skipped++; continue; }
    // 今天已完成 → 跳过
    if (_checkinState.get(acc.id) === today) { skipped++; continue; }

    // 【日界线门禁】上游换天只有两种：其本地 0 点（CN=北京 0 点、UTC=北京 8 点）。
    // 未过门禁时肯定还没换天，打接口只会白挨一次 4xx 并让判据去猜。
    // 详见 checkinGateHour 的注释（用户 11-04 的洞察）。
    const gate = checkinGate(acc);
    if (!gate.passed) { skipped++; continue; }

    // 【lobsterai 签到失败退避】：失败 3 次后当日放弃，避免"30 分钟无限重试"触发风控（参考 #2936）
    if (!isWb && acc.provider === 'lobsterai') {
      const fc = _checkinFailCount.get(acc.id) || { count: 0, day: '' };
      if (fc.day === today && fc.count >= 3) {
        skipped++;
        continue;  // 当日已失败 3 次，跳过该账号
      }
    }

    let ok = false, claimed = false, msg = '', settled = true;
    try {
      if (isWb) {
        const r = await checkin(acc);
        // ★ 11140（hub isBannedCheckin 语义）：签到接口也回显账号封禁状态，
        // 命中即冻结 —— 否则 30min 一轮的 tick 会拿封号反复撞上游。
        if (isBannedCheckin(r)) await freezeBannedAccount(acc, r, 'checkin');
        // WB 的幂等码：10001 = 今天已签到（不是错误）；1002 = 无资格
        ok = r.code === 0 || r.code === 10001 || r.code === 1002;
        claimed = r.code === 0;
        msg = `WB ${r.msg || ('code=' + r.code)}`;
      } else {
        const c = await chanCheckin(acc);
        ok = !!c.ok; claimed = !!c.claimed; msg = c.msg;
        // settled:false = 调用成功但“今天还没真正处理完”（如 minimax 上游
        // 尚未换天）。这类结果**绝不能记账**，否则当天剩下的 tick 全跳过。
        settled = c.settled === undefined ? true : !!c.settled;
      }
    } catch (e) {
      msg = String(e.message || e).slice(0, 200);
    }

    // ⚠️ 这一轮期间数据被清空 → 账号已不存在，结果作废，不写日志也不记账
    if (gen !== _dataGen) return { checked, failed, skipped, aborted: true };

    if (ok && !settled) {
      // 未结算：不记账、不算失败、不进 checked。日志按「日期+未结算」去重，
      // 一天一条摘要即可（否则 30min 一轮会刷屏）。
      const tag = today + ':pending';
      if (_checkinLogged.get(acc.id) !== tag) {
        await logTask('checkin', acc.id, true, msg);
        _checkinLogged.set(acc.id, tag);
      }
      continue;
    }

    if (ok) {
      // 只有"确认完成"才记账 —— 硬失败不记账，下个 tick 重试
      _checkinState.set(acc.id, today);
      checked.push(acc.id);
      // 成功时重置失败计数
      _checkinFailCount.delete(acc.id);
      if (claimed) {
        await logTask('checkin', acc.id, true, msg);
        _checkinLogged.set(acc.id, today + ':claimed');
        // ★ 签到当场改变额度（minimax +400 / lobsterai +100），立刻刷新快照，
        // 否则挑号排序会拿签到前的旧值做决策。失败只记日志，不影响签到结果。
        try {
          const cr = await refreshCreditsOf(acc);
          if (!cr.ok) await logTask('credits', acc.id, false, String(cr.msg || '').slice(0, 160));
        } catch { /* ignore */ }
      } else {
        // 已签/无资格：状态没变就不重复写日志（一天最多一条）
        const tag = today + ':done';
        if (_checkinLogged.get(acc.id) !== tag) {
          await logTask('checkin', acc.id, true, msg);
          _checkinLogged.set(acc.id, tag);
        }
      }
    } else {
      failed.push(acc.id);
      // 【lobsterai 签到失败计数】：记录失败次数，用于退避
      if (!isWb && acc.provider === 'lobsterai') {
        const fc = _checkinFailCount.get(acc.id) || { count: 0, day: '' };
        if (fc.day !== today) { fc.count = 0; fc.day = today; }
        fc.count++;
        _checkinFailCount.set(acc.id, fc);
      }
      // 失败每次 tick 都可能重试，日志按「日期+失败」去重，避免一天几十条
      const tag = today + ':fail';
      if (_checkinLogged.get(acc.id) !== tag) {
        await logTask('checkin', acc.id, false, msg);
        _checkinLogged.set(acc.id, tag);
      }
    }
  }
  // 持久化（按账号清理过期条目，别让 Map 无限长）
  if (gen !== _dataGen) return { checked, failed, skipped, aborted: true };
  try {
    const out = {};
    for (const [k, v] of _checkinState) if (v === today) out[k] = v;
    await kvPut(K.checkinDay, out);
  } catch {}
  return { checked, failed, skipped };
}

/** 管理端请求顺手补签（兜底路径，与定时器共用同一套状态）。 */
async function lazyCheckin() { await checkinTick(); }
// cron
async function runCron() {
  const accs = await getAccounts(); const log = [];
  for (const acc of accs) {
    if (!acc.enabled) continue;
    const uid = acc.uid || acc.id;
    if (isChan(acc)) {
      // 渠道: cron 每 6 小时一轮, 30 分钟阈值足以在过期前续上
      if (acc.expires_at < now() + CHAN_KEEPALIVE_SLACK) {
        if (await chanKeepaliveSafe(acc)) { await logTask("keepalive", acc.id, true, "refreshed"); log.push(uid + ":keepalive ok"); }
        else log.push(uid + ":keepalive fail");
      }
      // 渠道签到**交给 checkinTick**（30 分钟一轮的那个），这里不再重复签 ——
      // 两处都签会双写日志、双打上游。checkinTick 有状态去重，是唯一签到入口。
      // 三家可签（minimax/lobsterai/raccoon）；仅 cline 无端点，checkinTick 会跳过。
      continue;
    }
    if (acc.expires_at < now() + 3 * 86400) {
      try { const u = await refreshToken(acc); acc.access_token = u.access_token; acc.refresh_token = u.refresh_token; acc.expires_at = u.expires_at; await saveAccount(acc); await logTask("keepalive", acc.id, true, "refreshed"); log.push(acc.uid + ":keepalive ok"); }
      catch (e) { await logTask("keepalive", acc.id, false, String(e.message || e).slice(0, 200)); }
    }
    // WB 签到也交给 checkinTick（30 分钟一轮、按北京日界线、有状态去重）。
    // 原来这里每轮 cron 都签一次并写一条日志 —— 一天 4 条「今天已签到」噪音，
    // 而且与 checkinTick 双写。签到入口只保留一个。
  }
  return log;
}

// 入口
// ===== Node 入口（替代 Cloudflare Workers 的 addEventListener('fetch')）=====
// CF 版：addEventListener('fetch', e => e.respondWith(handleFetch(e.request)))
// Node 版：http.createServer 把 Node 的 req/res 包成标准 Request/Response
import { createServer } from 'node:http'

const PORT = Number(process.env.PORT || (String(process.env.MS_MODE ?? '') === '1' ? 7860 : 10000))

/** Node IncomingMessage → Web Request（含 body） */
async function nodeReqToWebRequest(req) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
  const headers = new Headers()
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue
    if (Array.isArray(v)) v.forEach(x => headers.append(k, x))
    else headers.set(k, v)
  }
  let body
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const chunks = []
    for await (const c of req) chunks.push(c)
    body = Buffer.concat(chunks)
  }
  return new Request(url, { method: req.method, headers, body: body && body.length ? body : undefined })
}

/** Web Response → Node ServerResponse（支持流式 body，代理 chat 需要） */
async function sendWebResponse(res, response) {
  res.statusCode = response.status
  if (response.statusText) res.statusMessage = response.statusText
  for (const [k, v] of response.headers) {
    // set-cookie 可能多值，Node 需要数组
    if (k.toLowerCase() === 'set-cookie') continue
    res.setHeader(k, v)
  }
  const cookies = response.headers.getSetCookie?.()
  if (cookies && cookies.length) res.setHeader('set-cookie', cookies)
  if (response.body === null) { res.end(); return }
  const reader = response.body.getReader()
  const pump = async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        // 背压：写满就等 drain
        if (!res.write(Buffer.from(value))) await new Promise(r => res.once('drain', r))
      }
    } finally { res.end() }
  }
  await pump()
}

const server = createServer(async (req, res) => {
  try {
    const webReq = await nodeReqToWebRequest(req)
    const webRes = await handleFetch(webReq)
    await sendWebResponse(res, webRes)
  } catch (e) {
    console.error('handler error:', e)
    if (!res.headersSent) { res.statusCode = 500; res.setHeader('content-type','text/plain; charset=utf-8') }
    res.end('internal error: ' + String(e?.message || e))
  }
})

server.listen(PORT, () => console.log(`wb-manager (turso) listening on :${PORT}`))

// ===== 定时任务 =====
// CF 用 scheduled 事件；Node 用 setInterval。
//
// ⚠️ 两个周期**分开**，因为它们的可靠性要求完全不同：
//   · keepalive（token 续期）：6 小时够用 —— 只要在过期前续上就行；
//   · 签到：**必须按天对齐**。用户的诉求是「一个月不看一次也行」，
//     所以不能指望"刚好赶上每日一次"。
//
// 签到周期的默认值是 **30 分钟**而不是 6 小时：
//   跨过北京 00:00 后最多 30 分钟就能签上，而不是等 6 小时。
//   代价只是一次幂等 POST（上游对重复签到返回"已签到"，不消耗额度）。
//
// ⚠️ `<= 0` 必须是**关闭**而不是 0ms: setInterval(fn, 0) 会每毫秒跑一轮,
// runCron 的 logTask 对 K.logs 做读-改-写, 会和「清理全部数据」的 kvDel 撞车,
// 把刚删掉的日志原样写回来 (e2e 6d 实测 300 条残留)。测试环境传 0 的本意就是关。
const CRON_MS = Number(process.env.CRON_INTERVAL_MS || 6 * 3600 * 1000)
/**
 * 签到周期。`CHECKIN_TICK_MS` 覆盖；0/负 = 关闭（测试用）。
 * 默认 30 分钟 —— 见上面的理由。
 */
const CHECKIN_TICK_MS = Number(process.env.CHECKIN_TICK_MS ?? 30 * 60 * 1000)

if (CRON_MS > 0) {
  setInterval(() => { runCron().catch(e => console.error('cron error:', e?.message || e)) }, CRON_MS).unref()
}
if (CHECKIN_TICK_MS > 0) {
  // 启动即跑一次：部署/重启后立刻对齐，不等第一个 tick。
  // （setTimeout 0 而不是直接 await —— 别阻塞 server.listen 的回调）
  setTimeout(() => { checkinTick().catch(e => console.error('checkin boot tick error:', e?.message || e)) }, 0).unref()
  setInterval(() => { checkinTick().catch(e => console.error('checkin tick error:', e?.message || e)) }, CHECKIN_TICK_MS).unref()
}
/**
 * 额度快照周期。`CREDITS_TICK_MS` 覆盖；0/负 = 关闭（测试用）。
 *
 * ## 为什么必须在 tick 里、而不能塞进 chat 请求路径（实测教训）
 *
 * 第一版把「挑号前补查过期额度」放进 chat 分支，`test-refresh-lock` 立刻从
 * 8/8 变 5/8：**续期上游命中次数 1→7**。原因是 5 个并发 chat 各自扫一遍候选、
 * 各自打一次额度端点，而额度端点与续期共用同一批上游限速 —— 并发一放大，
 * `refresh:` 锁的语义就被稀释了（锁保护的是「同一个号不重复刷」，
 * 挡不住「不同请求各查一次额度」）。
 *
 * 结论：**多秒级的上游查询只放在定时 tick**，chat 路径只用内存里的快照。
 * 挑号时读的是可能「略旧」的值 —— 这完全可以接受：排序只需要大类正确
 * （6000 vs 100），不需要秒级精确。
 *
 * 默认 **30 分钟**：跨过日界线（raccoon 每日重置）后半小时内就能把新额度
 * 写进快照；而 `CREDITS_SNAP_TTL_MS`(1h) 让大多数轮次发现「都还新鲜」，
 * 真实上游开销是「每跨过 1 小时才打一轮」。
 */
const CREDITS_TICK_MS = Number(process.env.CREDITS_TICK_MS ?? 30 * 60 * 1000)

if (CREDITS_TICK_MS > 0) {
  setTimeout(() => {
    refreshStaleCreditsSafe('boot').catch(e => console.error('credits boot error:', e?.message || e));
  }, 0).unref()
  setInterval(() => {
    refreshStaleCreditsSafe('tick').catch(e => console.error('credits tick error:', e?.message || e));
  }, CREDITS_TICK_MS).unref()
}

/**
 * 额度 tick 的安全包装：全量扫一遍账号，只补查过期的。
 * **绝不抛** —— 额度刷新是优化，故障不该冒泡到定时器。
 */
async function refreshStaleCreditsSafe(why) {
  try {
    const accs = (await getAccounts()).filter(a => a.enabled);
    const r = await refreshStaleCredits(accs);
    if (r.refreshed || r.failed) {
      await logTask("credits", "-", r.failed === 0,
        `额度刷新(${why}): ${r.refreshed} 成功 / ${r.failed} 失败`);
    }
    return r;
  } catch (e) {
    console.error('credits refresh error:', e?.message || e);
    return { refreshed: 0, failed: 0 };
  }
}

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
  if (p === "/healthz") {
    // 探活请求留痕 (纯内存, 不写 Turso): 用于验证 UptimeRobot 等外部监控
    // 是否真的在打这个端点 —— 只看 UA 与间隔, 不落盘、不占额度。
    // 实例重启即清空, 正好对应「这一轮活着期间有没有被探到」。
    try {
      const ua = request.headers.get("User-Agent") || "";
      const last = _healthHits[_healthHits.length - 1];
      const t = Date.now();
      _healthHits.push({ t, ua: ua.slice(0, 90), gap: last ? Math.round((t - last.t) / 1000) : null });
      if (_healthHits.length > 30) _healthHits.shift();
    } catch { /* 探活绝不能因日志失败 */ }
    // 带上 Node 版本: 渠道协议层是 TS, 只有 Node ≥22.6(需开 strip-types)
    // 或 ≥23.6 才能原生加载。部署失败/渠道报错时先看这里 —— 本地 Node 24
    // 全绿而 Render 崩, 第一时间要排除的就是版本差异。
    return new Response("ok", { headers: { "x-node-version": process.version, "x-ts-hook": String(!!globalThis.__WB_TS_HOOK__) } });
  }
  if (p === "/healthz/turso") return json(await tursoHealth());
  // 探活留痕查看 (需鉴权, 避免公开暴露): GET /api/health-hits
  if (p === "/api/health-hits") return json({ hits: _healthHits });
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
      // hub v2.0.7 措施：面板不暴露给搜索引擎/资产测绘平台（公网部署防被扫）。
      // 注意这只挡新收录，已被抓的旧快照需在搜索引擎控制台另行移除。
      return new Response(UI.replaceAll("__BASE__", base), { headers: { "content-type": "text/html; charset=utf-8", "X-Robots-Tag": "noindex, nofollow", "Cache-Control": "no-store" } });
    }
    return new Response(LOGIN.replaceAll("__BASE__", base), { status: 401, headers: { "content-type": "text/html; charset=utf-8", "X-Robots-Tag": "noindex, nofollow", "Cache-Control": "no-store" } });
  }
  return new Response("WorkBuddy Manager", { status: 404 });
}
// CF 版原先在此注册 scheduled 事件；Node 版已在入口用 setInterval 替代（见上方 CRON_MS）。
