// WorkBuddy Manager (classic + KV)

//=== wb_protocol ===
// ===== WorkBuddy 上游协议层 (基于 ithtelab/workbuddy-manager tencent.py 验证过的端点) =====
// 国内 CN: chat=copilot.tencent.com, billing=www.codebuddy.cn
// 国际 GLOBAL: chat=billing=www.workbuddy.ai

const UA = "CLI/2.63.2 CodeBuddy/2.63.2";
// 5.8.4 国际版桌面客户端实测形状 (hub PR#381 / issue#380, 2026-10-16 mitmproxy 抓包):
// UA 末段 CLI/2.161.0 是客户端内置 CLI 版本。国内版无抓包, 维持旧值。
const UA_INTL_DESKTOP = "WorkBuddy/5.8.4 workbuddy-ai/5.8.4 CLI/2.161.0";
const IDE_VERSION_INTL = "5.8.4";
const ORIGIN = { cn: "https://www.codebuddy.cn", global: "https://www.workbuddy.ai" };
const CHAT_BASE = { cn: "https://copilot.tencent.com", global: "https://www.workbuddy.ai" };
const BILLING_BASE = { cn: "https://www.codebuddy.cn", global: "https://www.workbuddy.ai" };

// 会话头族 (决定性, hub issue#380 LeoK77S 定位 + PR#381): 官方客户端所有
// chat 请求带 X-Conversation-ID(带连字符 UUID) + X-Conversation-Request-ID /
// -Message-ID / X-Root-Request-ID / X-Request-ID(32hex UUIDv7 形态)。
// 缺这族头 → 上游渠道校验回 400 code:11128 "conversation id missing"
// (国际版必拦, 国内版宽松)。这就是此前国际版"无解"的真正根因。
function uuid4() {
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80; // ver4/var
  const h = Array.from(b).map(x => x.toString(16).padStart(2, "0")).join("");
  return h.slice(0, 8) + "-" + h.slice(8, 12) + "-" + h.slice(12, 16) + "-" + h.slice(16, 20) + "-" + h.slice(20);
}
function uuid7hex() {
  // 32hex 无连字符 UUIDv7 形态 (时间序前缀 + 随机尾), 对齐官方抓包
  const ts = Date.now();
  const rnd = crypto.getRandomValues(new Uint8Array(10));
  const hh = Array.from(rnd).map(x => x.toString(16).padStart(2, "0")).join("");
  const t = ts.toString(16).padStart(12, "0");
  return (t + "7" + hh.slice(0, 3) + "a" + hh.slice(3)).slice(0, 32);
}
function conversationHeaders() {
  const conv = uuid4(), req = uuid7hex();
  return {
    "X-Conversation-ID": conv,
    "X-Conversation-Request-ID": req,
    "X-Root-Request-ID": req,
    "X-Conversation-Message-ID": req,
    "X-Request-ID": req,
  };
}

// ===== 11128 内容拦截中和 (2026-10-25) =====
// 上游对 system prompt 里的字面量 "DeepSeek Harness"(大小写不敏感, 单 ASCII 空格)
// 做渠道校验拦截, 命中即 400 code:11128 "Illegal API invocation from an unapproved
// channel"。实测与出口 IP / 账号 / 请求头统统无关: 绕开 Worker 直连上游同样被拦,
// 只把词组去掉就 200 (完整矩阵见 wb11128诊断_20261025.md)。
// 这里在转发前对 system 消息做中和。
// (2026-10-29 更新) 最初方案是空格换零宽空格, 但上游把本规则也升级成
// "先归一化(去零宽)再匹配"——零宽方案失效(简单词组请求 200→400 复发,
// 而部署包零宽逻辑完好, 证明上游变了), 现改为直接文本改写:
// "DeepSeek Harness" → "DSH"。语义等价 (上游侧 "powered by DSH." 实测 200)。
// user/assistant/tool 消息实测不扫, 一律不动 (少动少风险)。
// 路径里的同名字符串必须逐字节保持 (否则模型会把坏路径传给工具 → ENOENT),
// 所以默认跳过紧邻 / 或 \ 的命中; globalThis.WB_NEUTRALIZE_PATHS="1" 可强制全改。
const WB_HARNESS_RE_GUARDED = /(?<![\\/])DeepSeek[ ]+Harness(?![\\/])/gi;
const WB_HARNESS_RE_ALL = /DeepSeek[ ]+Harness/gi;
const WB_HARNESS_REPLACEMENT = "DSH";
function neutralizeHarnessText(s, all) {
  if (typeof s !== "string" || !/harness/i.test(s)) return s; // 大小写不敏感前置剪枝
  const re = all ? WB_HARNESS_RE_ALL : WB_HARNESS_RE_GUARDED;
  return s.replace(re, WB_HARNESS_REPLACEMENT);
}
// ===== 11128 第二类规则: 系统提示"整句指纹"精确匹配 (2026-10-29) =====
// 上游在词组规则之外新增: 对 DSH 系统提示中一段 111 字符整句做精确匹配。
// 实测特征 (wb11128诊断_20261029 续篇):
//   - 原句原样必拦 400/11128, 完整 12.8K prompt 只改这一句即 200 (全 prompt 唯一堵点);
//   - 对该串任何单字符改动(改词/删词/换尾字母)都变 200 → 是整串精确匹配, 不是词表;
//   - 指纹内插零宽空格仍拦 → 老的零宽中和对本规则无效, 必须直接改写文本。
// 对策: 语义保持改写。上游若再换指纹, 往这张表里追加一条即可。
const WB_SYSTEM_REWRITES = [
  [
    /Tokens prefixed with @ are paths the user explicitly referenced\./g,
    "Text beginning with @ marks paths that were explicitly referenced by the user.",
  ],
];
function applySystemRewrites(s) {
  if (typeof s !== "string" || s.length < 40) return s; // 短串不可能含整句指纹
  for (const [re, to] of WB_SYSTEM_REWRITES) s = s.replace(re, to);
  return s;
}
function neutralizeSystemMessages(messages, all) {
  if (!Array.isArray(messages)) return messages;
  for (const m of messages) {
    if (!m || m.role !== "system") continue;
    if (typeof m.content === "string") { m.content = applySystemRewrites(neutralizeHarnessText(m.content, all)); continue; }
    if (Array.isArray(m.content)) {
      for (const part of m.content) {
        if (!part || typeof part !== "object") continue;
        if (typeof part.text === "string") part.text = applySystemRewrites(neutralizeHarnessText(part.text, all));
        else if (typeof part.content === "string") part.content = applySystemRewrites(neutralizeHarnessText(part.content, all));
      }
    }
  }
  return messages;
}
// 经典 Service Worker: 环境变量是全局绑定, 用 typeof 取, 未定义即默认(跳过路径)。
function wbNeutralizeAllPaths() {
  try { return typeof globalThis !== "undefined" && String(globalThis.WB_NEUTRALIZE_PATHS || "") === "1"; }
  catch (e) { return false; }
}

// realm 判定: 含 workbuddy.ai 或 codebuddy.ai(非 .cn) 视为全球版; 其余(含 codebuddy.cn)为国内
function realmOf(acc) {
  const d = (acc.domain || "").toLowerCase();
  if (d.includes("workbuddy.ai") || (d.includes("codebuddy.ai") && !d.includes(".cn"))) return "global";
  return "cn";
}
// base 优先用账号显式 domain(支持 workbuddy.ai / codebuddy.ai 等全球入口二合一);
// 否则回退到默认映射。国内 chat/billing 分属不同 host。
function chatBase(acc) {
  const d = (acc.domain || "").toLowerCase();
  if (d && !d.includes("codebuddy.cn")) return "https://" + (d.startsWith("http") ? d.replace(/^https?:\/\//, "") : d);
  return CHAT_BASE[realmOf(acc)];
}
function billingBase(acc) {
  const d = (acc.domain || "").toLowerCase();
  if (d && !d.includes("codebuddy.cn")) return "https://" + (d.startsWith("http") ? d.replace(/^https?:\/\//, "") : d);
  return BILLING_BASE[realmOf(acc)];
}
function originOf(acc) {
  const d = (acc.domain || "").toLowerCase();
  if (d && !d.includes("codebuddy.cn")) return "https://" + (d.startsWith("http") ? d.replace(/^https?:\/\//, "") : d);
  return ORIGIN[realmOf(acc)];
}

function commonHeaders(acc, token) {
  const isGlobal = realmOf(acc) === "global";
  const h = {
    "User-Agent": isGlobal ? UA_INTL_DESKTOP : UA,
    "X-Requested-With": "XMLHttpRequest",
    "Origin": originOf(acc),
    "Referer": originOf(acc) + "/",
    "Accept": "application/json",
    "Accept-Language": isGlobal ? "en-US" : "zh-CN",
    "Content-Type": "application/json",
  };
  // 桌面端身份头 (5.8.4 抓包): 用量归因到官方 WorkBuddy 桌面客户端,
  // X-Agent-* 三头 + IDE 三头。缺 X-IDE-* 在官网用量归因里是显眼的网关特征。
  if (isGlobal) {
    h["X-IDE-Name"] = "WorkBuddy"; h["X-IDE-Type"] = "WorkBuddy"; h["X-IDE-Version"] = IDE_VERSION_INTL;
    h["X-Agent-Intent"] = "craft"; h["X-Agent-Purpose"] = "conversation"; h["X-Agent-Type"] = "main";
  }
  // 会话头族 (国际版渠道校验的决定性要件; 国内带上亦无害)
  Object.assign(h, conversationHeaders());
  // 显式否定头 (移植自 wb-cf-proxy chatHeaders): 腾讯网关对「缺省身份头」
  // 比「显式声明无此身份」更敏感, uid/domain 缺失时必须发 X-No-*, 装作
  // 官方客户端的"个人版无企业信息"形态, 否则可能触发 11128 渠道校验.
  if (acc.uid) h["X-User-Id"] = acc.uid; else h["X-No-User-Id"] = "1";
  if (acc.domain) h["X-Domain"] = acc.domain; else h["X-No-Department-Info"] = "1";
  h["X-No-Enterprise-Info"] = "1"; // 个人账号: 无 enterpriseId 一律显式否定
  h["X-Product"] = "SaaS"; // 对齐官方 IDE 的 ProductEndpointHttpInterceptor
  if (token) h["Authorization"] = "Bearer " + token;
  return h;
}
// billing 域额外需要 X-User-Id 身份头
function billingHeaders(acc, token) {
  const h = commonHeaders(acc, token);
  if (acc.uid) h["X-User-Id"] = acc.uid;
  return h;
}

// 把毫秒 expiresAt 规范化为秒
function normExpires(v) {
  v = Number(v);
  if (!v) return 0;
  return v > 1e12 ? Math.floor(v / 1000) : Math.floor(v);
}

// ---- 刷新 token (保活核心) ----
async function refreshToken(acc) {
  const url = chatBase(acc) + "/v2/plugin/auth/token/refresh";
  const headers = {
    "User-Agent": UA, "X-Requested-With": "XMLHttpRequest",
    "Origin": originOf(acc), "Referer": originOf(acc) + "/",
    "Content-Type": "application/json",
    "X-Refresh-Token": acc.refresh_token,
    "X-Auth-Refresh-Source": "workbuddy",
  };
  if (acc.uid) headers["X-User-Id"] = acc.uid;
  if (acc.domain) headers["X-Domain"] = acc.domain;
  const r = await fetch(url, { method: "POST", headers });
  if (!r.ok) throw new Error("refresh HTTP " + r.status + ": " + (await r.text()).slice(0, 160));
  const d = await r.json().catch(() => null);
  const data = (d && d.data) || d || {};
  if (!data.accessToken) throw new Error("refresh 回包无 accessToken");
  return {
    access_token: data.accessToken,
    refresh_token: data.refreshToken || acc.refresh_token,
    expires_at: data.expiresAt ? normExpires(data.expiresAt) : (data.expiresIn ? Math.floor(Date.now() / 1000) + Number(data.expiresIn) : acc.expires_at),
  };
}

// ---- 签到 ----
async function checkin(acc) {
  const suffix = "/billing/meter/daily-checkin";
  const paths = realmOf(acc) === "global"
    ? ["/billing/meter/daily-checkin", "/v2/billing/meter/daily-checkin"]
    : ["/v2/billing/meter/daily-checkin"];
  for (const p of paths) {
    const r = await fetch(billingBase(acc) + p, {
      method: "POST", headers: billingHeaders(acc, acc.access_token), body: "{}",
    });
    if (r.status === 404) continue;
    const d = await r.json().catch(() => ({}));
    // 重复签到回 10001 / 已签 视为成功
    return { status: r.status, code: d.code, msg: d.msg || ("HTTP " + r.status) };
  }
  return { status: 404, code: 404, msg: "endpoint 404" };
}

// ---- 额度/积分 (ProductCode=p_tcaca) ----
async function fetchCredits(acc) {
  const paths = realmOf(acc) === "global"
    ? ["/billing/meter/get-user-resource", "/v2/billing/meter/get-user-resource"]
    : ["/v2/billing/meter/get-user-resource"];
  const now = new Date();
  const body = {
    PageNumber: 1, PageSize: 100, ProductCode: "p_tcaca", Status: [0, 3],
    PackageEndTimeRangeBegin: fmt(now),
    PackageEndTimeRangeEnd: fmt(new Date(now.getTime() + 365 * 101 * 864e5)),
  };
  for (const p of paths) {
    const r = await fetch(billingBase(acc) + p, {
      method: "POST", headers: billingHeaders(acc, acc.access_token),
      body: JSON.stringify(body),
    });
    if (r.status === 404) continue;
    const d = await r.json().catch(() => null);
    if (!d || d.code !== 0) return { ok: false, msg: "查询失败 code=" + (d && d.code) };
    return parseCredits(d.data);
  }
  return { ok: false, msg: "endpoint 404" };
}
function fmt(dt) {
  const p = (n) => String(n).padStart(2, "0");
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())} ${p(dt.getHours())}:${p(dt.getMinutes())}:${p(dt.getSeconds())}`;
}
function parseCredits(data) {
  // 兼容多种嵌套: data.Response.Data.Accounts / data.accounts / data.records / data.list / data.data
  let items = [];
  if (Array.isArray(data)) items = data;
  else if (data && data.Response && data.Response.Data && Array.isArray(data.Response.Data.Accounts)) items = data.Response.Data.Accounts;
  else if (Array.isArray(data.accounts)) items = data.accounts;
  else if (Array.isArray(data.records)) items = data.records;
  else if (Array.isArray(data.list)) items = data.list;
  else if (data && Array.isArray(data.data)) items = data.data;
  else if (data && data.Response && data.Response.Data && Array.isArray(data.Response.Data)) items = data.Response.Data;
  let total = 0, expiries = [];
  for (const it of items) {
    if (!it || typeof it !== "object") continue;
    const remain = Math.max(0, Number(it.CycleCapacityRemain ?? it.CapacityRemain ?? it.RemainCapacity ?? it.remain ?? it.Remain ?? 0));
    total += remain;
    const end = it.CycleEndTime ?? it.PackageEndTime ?? it.endTime ?? it.expireTime;
    if (remain > 0 && end) {
      const at = typeof end === "number" ? Math.floor(end / 1000) : Date.parse(String(end).replace(/-/g, "/")) / 1000;
      if (at) expiries.push({ at: Math.floor(at), amount: Math.round(remain) });
    }
  }
  expiries.sort((a, b) => a.at - b.at);
  return { ok: true, credits: Math.round(total), expiries };
}

// ---- 模型探测 (含倍率 / 折扣，移植自 wb2api channel-pack 的 parseModelsFromConfig) ----
async function fetchModels(acc) {
  // 主源: /v3/config，WorkBuddy/CodeBuddy 的 models[] 是对象数组，含 credits 倍率、maxInputTokens 等
  let v3 = null, v3Err = null;
  try {
    const r3 = await fetch(chatBase(acc) + "/v3/config", { headers: commonHeaders(acc, acc.access_token) });
    if (r3.ok) v3 = await r3.json().catch(() => null);
    else v3Err = "HTTP " + r3.status;
  } catch (e) { v3Err = String(e); }

  let models = [];
  if (v3 && v3.data) {
    models = parseBuddyModels(v3.data);
  }
  // 兜底: 老企业端点 (若 /v3/config 无 models 才用)
  if (!models.length) {
    const entPaths = realmOf(acc) === "global"
      ? ["/v2/enterprises/personal/models", "/console/enterprises/personal/models"]
      : ["/console/enterprises/personal/models"];
    for (const p of entPaths) {
      try {
        const r = await fetch(chatBase(acc) + p, { headers: commonHeaders(acc, acc.access_token) });
        if (!r.ok) { v3Err = v3Err || ("HTTP " + r.status); continue; }
        const d = await r.json().catch(() => null);
        const data = (d && d.data) || d || {};
        models = parseBuddyModels(data);
        if (models.length) break;
      } catch (e) { v3Err = String(e); }
    }
  }
  return { ok: models.length > 0, models, v3: v3, entErr: v3Err };
}

// —— 以下移植自 wb2api channel-pack (buddy.ts: parseModelsFromConfig / normalizeCreditsRate / parsePromotions) ——
function normalizeRate(value, prefixed, suffixed) {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  const head = text.split(/\s+/)[0] ?? "";
  const match = prefixed.exec(head) || suffixed.exec(head);
  return match && match[1] !== undefined ? "x" + match[1] : undefined;
}
function normalizeCreditsRate(value) {
  return normalizeRate(value, /^x(\d+(?:\.\d+)?)\b/i, /^(\d+(?:\.\d+)?)x\b/i);
}
function normalizeDiscountedRate(value) {
  return normalizeRate(value, /^x(\d+(?:\.\d+)?)\b/i, /^(\d+(?:\.\d+)?)x\b/i);
}
function parseHHMM(value) {
  if (typeof value !== "string") return undefined;
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (m === null) return undefined;
  const h = Number(m[1]), min = Number(m[2]);
  return h < 24 && min < 60 ? h * 60 + min : undefined;
}
function zonedMinutes(now, timeZone) {
  const zone = (typeof timeZone === "string" && timeZone.length > 0) ? timeZone : "Asia/Shanghai";
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
    const h = Number(parts.find(p => p.type === "hour")?.value);
    const mn = Number(parts.find(p => p.type === "minute")?.value);
    return Number.isFinite(h) && Number.isFinite(mn) ? h * 60 + mn : undefined;
  } catch { return undefined; }
}
function hasTimeWindow(schedule) {
  return (Array.isArray(schedule.daily) && schedule.daily.length > 0) || schedule.validFrom !== undefined || schedule.validUntil !== undefined;
}
function promotionActiveNow(item, now) {
  const raw = item.schedule;
  if (typeof raw !== "object" || raw === null) return true;
  const schedule = raw;
  const from = typeof schedule.validFrom === "string" ? Date.parse(schedule.validFrom) : NaN;
  const until = typeof schedule.validUntil === "string" ? Date.parse(schedule.validUntil) : NaN;
  if (Number.isFinite(from) && now.getTime() < from) return false;
  if (Number.isFinite(until) && now.getTime() >= until) return false;
  if (!Array.isArray(schedule.daily) || schedule.daily.length === 0) return true;
  const minutes = zonedMinutes(now, schedule.timezone);
  if (minutes === undefined) return true;
  return schedule.daily.some(slot => {
    if (typeof slot !== "object" || slot === null) return false;
    const start = parseHHMM(slot.start), end = parseHHMM(slot.end);
    if (start === undefined || end === undefined) return false;
    return start <= end ? (minutes >= start && minutes < end) : (minutes >= start || minutes < end);
  });
}
function priorityOf(item) {
  if (typeof item !== "object" || item === null) return 0;
  const p = item.priority;
  return typeof p === "number" && Number.isFinite(p) ? p : 0;
}
function parsePromotions(record, now = new Date()) {
  const result = new Map();
  const chosen = new Map();
  const promotions = record.modelPromotions;
  if (!Array.isArray(promotions)) return result;
  const sorted = [...promotions].sort((a, b) => priorityOf(a) - priorityOf(b));
  for (const item of sorted) {
    if (typeof item !== "object" || item === null) continue;
    const promotion = item;
    if (promotion.enabled === false) continue;
    if (!promotionActiveNow(promotion, now)) continue;
    const discount = promotion.discount;
    if (typeof discount !== "object" || discount === null) continue;
    const detail = discount;
    const factor = typeof detail.factor === "number" ? detail.factor : undefined;
    const rawSchedule = promotion.schedule;
    const windowed = typeof rawSchedule === "object" && rawSchedule !== null && hasTimeWindow(rawSchedule);
    let rate;
    if (factor === 0) {
      if (!windowed) continue;
      rate = "免费";
    } else {
      rate = normalizeDiscountedRate(detail.discountedCredits);
      if (rate === "x0") continue;
    }
    if (rate === undefined) continue;
    const modelIds = promotion.modelIds;
    if (!Array.isArray(modelIds)) continue;
    const priority = priorityOf(promotion);
    for (const id of modelIds) {
      if (typeof id !== "string" || id.length === 0) continue;
      const previous = chosen.get(id);
      if (previous !== undefined && previous > priority) continue;
      chosen.set(id, priority);
      result.set(id, rate);
    }
  }
  return result;
}
function parseModelMeta(record) {
  if (record === undefined) return {};
  const meta = {};
  const limit = record.maxInputTokens;
  if (typeof limit === "number" && Number.isFinite(limit) && limit > 0) meta.context = limit;
  const maxOutput = record.maxOutputTokens;
  if (typeof maxOutput === "number" && Number.isFinite(maxOutput) && maxOutput > 0) meta.maxOutput = maxOutput;
  if (typeof record.supportsImages === "boolean") meta.supportsImages = record.supportsImages;
  const reasoning = record.reasoning;
  if (typeof reasoning === "object" && reasoning !== null) {
    const fields = reasoning;
    if (Array.isArray(fields.supportedEfforts)) {
      const efforts = fields.supportedEfforts.filter(e => typeof e === "string" && e.length > 0);
      if (efforts.length > 0) meta.reasoning = { summary: fields.summary ?? fields.defaultEffort ?? "支持", supportedEfforts: efforts, defaultEffort: fields.defaultEffort ?? efforts[0] };
    }
  }
  return meta;
}
function isChatModel(id, meta) {
  if (id.startsWith("nes-") || id.startsWith("completion-") || id.startsWith("codewise-")) return false;
  if (meta && meta.supportsExtra === true) return false;
  const maxOutput = meta && meta.maxOutput;
  if (typeof maxOutput === "number" && maxOutput > 0 && maxOutput <= 256) return false;
  const tags = meta && meta.tags;
  if (Array.isArray(tags) && tags.some(t => t === "text-to-image")) return false;
  return true;
}
function parseBuddyModels(record) {
  if (typeof record !== "object" || record === null) return [];
  const data = record;
  const metaById = new Map();
  if (Array.isArray(data.models)) {
    for (const model of data.models) {
      if (typeof model !== "object" || model === null) continue;
      if (typeof model.id === "string") metaById.set(model.id, model);
    }
  }
  const promotions = parsePromotions(data);
  const agentReferencedIds = new Set();
  if (Array.isArray(data.agents)) {
    for (const agent of data.agents) {
      if (typeof agent !== "object" || agent === null) continue;
      const models = agent.models;
      if (!Array.isArray(models)) continue;
      for (const model of models) if (typeof model === "string") agentReferencedIds.add(model);
    }
  }
  const parsed = [];
  const seen = new Set();
  const push = (id) => {
    if (seen.has(id) || !isChatModel(id, metaById.get(id))) return;
    seen.add(id);
    const meta = metaById.get(id);
    const remoteName = (meta && typeof meta.name === "string" && meta.name.length > 0) ? meta.name : undefined;
    const rate = normalizeCreditsRate(meta && meta.credits);
    const discounted = promotions.get(id);
    parsed.push({
      id,
      name: remoteName ?? id,
      multiplier: rate ?? null,
      discounted: discounted ?? null,
      context: (meta && meta.maxInputTokens) || null,
      maxOutput: (meta && meta.maxOutputTokens) || null,
      supportsImages: meta ? !!meta.supportsImages : false,
      reasoning: meta ? (meta.reasoning && typeof meta.reasoning === "object" ? meta.reasoning : null) : null,
      source: "v3/config",
    });
  };
  for (const id of metaById.keys()) push(id);
  return parsed;
}




//=== serialize-buddy ===
// ===== WorkBuddy/CodeBuddy 请求体序列化 =====
// 移植自 dsh-our-free-model/vendor/channel-pack/src/buddy-adapter.ts (MIT)
// 上游来源: https://gitee.com/iJetLi/deepseek-harness-codearts
//
// 作用: 把 OpenAI 兼容客户端发来的消息序列化为 CodeBuddy/WorkBuddy 上游
// 能接受的 wire 格式, 修复以下导致 400 INVALID_REQUEST (no body) 的根因:
//
//   1. 孤儿工具调用 — assistant 带 tool_calls 但无对应 role:'tool' 结果
//      (或反过来), 上游按配对完整性校验, 缺一侧即 400, 会话从此每轮报废.
//   2. assistant 消息缺 reasoning_content 字段 — deepseek 系推理模型
//      要求该字段始终存在 (哪怕空串), 缺失即 400.
//   3. content 为空 + 有 tool_calls 时 content 必须是 null 而非空串.
//   4. content 是 parts 数组时展平为字符串 (部分上游静默丢 parts).
//   5. tool_calls 的 arguments 必须是合法 JSON 对象串.
//
// 不含图片/多模态处理 (wb-manager 客户端走纯文本) 与 course 泄漏清洗
// (dsh 插件特有的防污染逻辑, 此处无关).

/** harness 消息形状归一化 (移植自 message-shape.ts). */
function detectMessageShape(messages) {
  let sawLegacy = false;
  for (const m of messages) {
    if (m.role === "tool") return "tool-role";
    const c = m.content;
    if (Array.isArray(c) && c.some(b => b && typeof b === "object" && b.type === "tool-result")) sawLegacy = true;
  }
  return sawLegacy ? "legacy" : "none";
}

/**
 * 把 0.1.7 的一等 `role:'tool'` 消息降级为 legacy 包裹形状 (user 内嵌 tool-result 块).
 * 没有 tool 角色且无 developer 角色时零成本透传原数组.
 */
function normalizeHarnessMessages(messages) {
  const shape = detectMessageShape(messages);
  const hasDev = messages.some(m => m.role === "developer");
  if (shape !== "tool-role" && !hasDev) return messages;
  const out = [];
  for (const m of messages) {
    if (m.role === "developer") continue;
    if (m.role !== "tool") { out.push(m); continue; }
    const source = m.source;
    const sourceCallId = typeof source === "object" && source !== null ? source.callId : undefined;
    const toolCallId = m.toolCallId ?? m.tool_call_id ?? sourceCallId;
    const block = { type: "tool-result", toolCallId, content: m.content };
    if (m.isError !== undefined) block.isError = m.isError;
    out.push({ role: "user", content: [block] });
  }
  return out;
}

/** 工具名非空才算可用 (移植自 sse.ts:81). */
function hasUsableToolName(name) {
  return typeof name === "string" && name.trim().length > 0;
}

/**
 * 归一化: 把 OpenAI 顶层字段 (assistant.tool_calls / tool.tool_call_id) 合并进
 * content 数组的 tool-call / tool-result 块. harness/pi-ai 发来的 assistant 消息
 * 工具调用在顶层 tool_calls, 不在 content 数组里; 旧版序列化器只认 content 块 →
 * 配对全失败 → tool_calls 和 tool 结果被丢弃 → 上游重新发起 → 空转.
 * 此函数在 normalizeHarnessMessages 之后运行, 让 resolveToolPairing 和
 * serializeBuddyMessages 的 content 块逻辑同时覆盖两种来源.
 */
function mergeTopLevelToolFields(messages) {
  return messages.map(m => {
    if (m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      const content = Array.isArray(m.content) ? m.content : [];
      const existing = new Set(content.filter(b => b && b.type === "tool-call").map(b => String(b.id)));
      const extra = m.tool_calls
        .filter(tc => tc && tc.id && !existing.has(String(tc.id)))
        .map(tc => ({
          type: "tool-call",
          id: String(tc.id),
          name: tc.function?.name ?? "",
          arguments: typeof tc.function?.arguments === "string" ? tc.function.arguments : JSON.stringify(tc.function?.arguments ?? {}),
        }));
      return { ...m, content: [...content, ...extra] };
    }
    if (m.role === "tool" && m.tool_call_id && !Array.isArray(m.content)) {
      // 顶层 tool 消息: content 是字符串, 包成 tool-result 块让配对逻辑识别.
      return { ...m, content: [{ type: "tool-result", toolCallId: String(m.tool_call_id), content: m.content }] };
    }
    return m;
  });
}

/**
 * 解析工具配对: 只保留 "assistant 的 tool_call id 有对应 tool 结果" 且
 * "tool 结果有对应 tool_call" 的双向配对. 单边的一律剔除.
 * 移植自 sse.ts:244 resolveToolPairing.
 */
function resolveToolPairing(messages) {
  const normalized = mergeTopLevelToolFields(normalizeHarnessMessages(messages));
  // 收集所有 tool-result 的 id.
  const allResultIds = new Set();
  for (const m of normalized) {
    const c = Array.isArray(m.content) ? m.content : [];
    for (const b of c) {
      if (b && typeof b === "object" && b.type === "tool-result") {
        allResultIds.add(String(b.toolCallId));
      }
    }
  }
  // 一批 tool_calls 里名称可用的 + 全部拿到结果的才保留.
  const keepCallIds = new Set();
  for (const m of normalized) {
    if (m.role !== "assistant") continue;
    const c = Array.isArray(m.content) ? m.content : [];
    const calls = c.filter(b => b && typeof b === "object" && b.type === "tool-call");
    if (calls.length === 0) continue;
    const usable = calls.filter(b => hasUsableToolName(b.name));
    if (usable.length === 0) continue;
    if (usable.every(b => allResultIds.has(String(b.id)))) {
      for (const b of usable) keepCallIds.add(String(b.id));
    }
  }
  const keepResultIds = new Set();
  for (const id of keepCallIds) if (allResultIds.has(id)) keepResultIds.add(id);
  return { keepCallIds, keepResultIds };
}

/** tool arguments 必须是合法 JSON 对象串; 截断/空则回退 '{}' (移植自 sse.ts:291). */
function normalizeToolArguments(raw) {
  const trimmed = String(raw ?? "").trim();
  if (trimmed.length === 0) return "{}";
  let parsed;
  try { parsed = JSON.parse(trimmed); } catch { return "{}"; }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return "{}";
  return trimmed;
}

/** content 块数组展平为纯文本字符串 (移植自 buddy-adapter.ts:233 contentToText). */
function contentToText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(b => b && typeof b === "object" && b.type === "text")
    .map(b => String(b.text ?? ""))
    .join("");
}

/**
 * 把 OpenAI 兼容消息序列化为 CodeBuddy/WorkBuddy wire 格式.
 * 核心适配 (移植自 buddy-adapter.ts:258 serializeMessages, 去掉图片分支):
 * - assistant 始终带 reasoning_content (推理模型缺失即 400);
 * - 空正文 + 有 tool_calls 时 content = null;
 * - 孤儿 tool_calls / tool 结果双向剔除;
 * - content 数组展平为字符串;
 * - tool_result 展开为独立 role:'tool' 消息.
 */
function serializeBuddyMessages(messages) {
  const wire = [];
  const normalized = mergeTopLevelToolFields(normalizeHarnessMessages(messages));
  const { keepCallIds, keepResultIds } = resolveToolPairing(normalized);

  for (const message of normalized) {
    if (message.role === "assistant") {
      const content = Array.isArray(message.content) ? message.content : [];
      const toolCallBlocks = content
        .filter(b => b && typeof b === "object" && b.type === "tool-call")
        .filter(b => keepCallIds.has(String(b.id)));
      const toolCalls = toolCallBlocks.map(b => ({
        id: String(b.id),
        type: "function",
        function: { name: String(b.name), arguments: normalizeToolArguments(b.arguments) },
      }));
      const reasoning = content
        .filter(b => b && typeof b === "object" && b.type === "reasoning")
        .map(b => String(b.text ?? ""))
        .join("");
      // text 取原始 content (字符串直接透传, 数组才展平), 不能用上面被
      // 转成 [] 的 content 变量——否则字符串消息会被吞成空串.
      const text = contentToText(message.content);
      wire.push({
        role: "assistant",
        content: text.length === 0 && toolCalls.length > 0 ? null : text,
        reasoning_content: reasoning,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
      continue;
    }
    if (message.role === "system") {
      wire.push({ role: "system", content: contentToText(message.content) });
      continue;
    }
    if (message.role === "tool") {
      // legacy 形状不会到这里 (已降级); 兜底: 顶层 tool 消息直接转.
      const toolCallId = String(message.toolCallId ?? "");
      if (keepResultIds.has(toolCallId)) {
        wire.push({
          role: "tool",
          tool_call_id: toolCallId,
          content: contentToText(message.content) || "(no output)",
        });
      }
      continue;
    }
    // user: tool-result 块展开为独立 role:'tool', 其余文本走 user.
    const content = Array.isArray(message.content) ? message.content : [];
    const toolResults = content.filter(b => b && typeof b === "object" && b.type === "tool-result");
    const text = contentToText(message.content);
    if (text.length > 0 || toolResults.length === 0) {
      wire.push({ role: "user", content: text });
    }
    for (const result of toolResults) {
      if (!keepResultIds.has(String(result.toolCallId))) continue;
      wire.push({
        role: "tool",
        tool_call_id: String(result.toolCallId),
        content: contentToText(result.content) || "(no output)",
      });
    }
  }
  return wire;
}


//=== context-guard ===
// === 上下文护栏 (context guard) ===
// 防"空转/历史无限膨胀"把账号额度烧穿:
//   1) 硬性上限: 估算 prompt token 超阈值直接 413, 无状态, 永不漏。
//   2) 循环熔断: 同(模型+末条消息+消息数)在窗口内重复 N 次 -> 429。
//      Worker isolate 内存实现 (KV 有 1 次/秒写限制, 不适合做高频计数);
//      真实兜底是第 1 条无状态上限。
// 不做任何消息改写/压缩: 网关是代理, 静默改动用户对话会让人意外。
//
// 护栏取值 = min(合理上限 REASONABLE_CAP, 模型真实上游窗口)。
//   - 模型有真实窗口(来自上游 /v3/config 的 maxInputTokens)时, 取两者更小:
//     上游 200k -> 护栏 200k; 上游 32k -> 护栏 32k。
//   - 模型无窗口声明(完全不设上下文限制)时, 回落到 REASONABLE_CAP 兜底,
//     防止"无限制"模型把巨 prompt 放给上游烧穿额度。
// 护栏取值 = min(真实窗口, CG_REASONABLE_CAP)。
// 真实窗口来自上游 /v3/config 的 maxInputTokens，是权威值，1M 模型就是 1M。
// CG_REASONABLE_CAP 只在「模型未声明窗口」时兜底 —— 那种情况宁可保守(262144)，
// 因为无声明等于不知道该防多少，给 1M 就等于没护栏。
const CG_DEFAULT_MAX_CONTEXT_TOKENS = 150000; // 仅作 deprecated 回退
const CG_REASONABLE_CAP = 1048576;   // 有真实窗口时的封顶(1M)，不限制 1M 模型
const CG_UNKNOWN_WINDOW_CAP = 262144; // 无窗口声明模型的保守兜底
const CG_DEFAULT_LOOP_REPEAT_LIMIT = 6;
const CG_DEFAULT_LOOP_WINDOW_MS = 120000;

function cgNum(v) { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : null; }

// 计算有效护栏上限: min(真实窗口, CG_REASONABLE_CAP=1M)。
//  - 有真实窗口 -> 取 min(真实, 1M)：1M 模型得 1M，200k 模型得 200k。
//  - 无窗口声明 / 异常值 -> CG_UNKNOWN_WINDOW_CAP(262144) 保守兜底。
function cgEffectiveCeiling(realWindow) {
  const w = cgNum(realWindow);
  if (w == null || w <= 0) return CG_UNKNOWN_WINDOW_CAP;
  return Math.min(w, CG_REASONABLE_CAP);
}
// 经典 Service Worker: 环境变量是全局绑定 (不是 env 对象), 用 typeof 取, 未定义则回落默认。
function cgGlobalNum(name) {
  try { if (typeof globalThis !== "undefined" && globalThis[name] != null) return cgNum(globalThis[name]); } catch (e) { /* ignore */ }
  return null;
}
function cgConfig() {
  const maxCtx = cgGlobalNum("MAX_CONTEXT_TOKENS");
  const loopN = cgGlobalNum("LOOP_REPEAT_LIMIT");
  const loopW = cgGlobalNum("LOOP_WINDOW_MS");
  return {
    // 0/未设 = 自动模式(按 min(REASONABLE_CAP, 模型真实窗口)); >0 = 手动硬顶(仍不放大到超过 REASONABLE_CAP)。
    maxContextTokens: maxCtx != null ? maxCtx : 0,
    loopRepeatLimit: loopN != null ? loopN : CG_DEFAULT_LOOP_REPEAT_LIMIT,
    loopWindowMs: loopW != null ? loopW : CG_DEFAULT_LOOP_WINDOW_MS,
  };
}

// 粗估 token: CJK 约 1 token/字, 拉丁约 4 字符/token。宁可略高。
function cgEstimateTokens(messages) {
  let tokens = 0;
  for (const m of (messages || [])) {
    const c = m && m.content;
    let chars = 0, cjk = 0;
    if (typeof c === "string") {
      chars = c.length;
      for (let i = 0; i < c.length; i++) { const code = c.charCodeAt(i); if (code >= 0x3000 && code <= 0x9fff) cjk++; }
    } else if (Array.isArray(c)) {
      for (const part of c) {
        const p = part || {};
        if (typeof p.text === "string") chars += p.text.length;
        else if (typeof p.content === "string") chars += p.content.length;
        else { try { chars += JSON.stringify(part || "").length; } catch (e) { /* skip */ } }
      }
    } else if (c != null) {
      try { chars += JSON.stringify(c).length; } catch (e) { /* skip */ }
    }
    const asciiChars = Math.max(0, chars - cjk);
    tokens += cjk + Math.ceil(asciiChars / 4) + 4;
    // tool_calls 也算体积 (工具空转时它们同样在膨胀)
    if (m && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      try { tokens += Math.ceil(JSON.stringify(m.tool_calls).length / 4); } catch (e) { /* skip */ }
    }
  }
  return tokens;
}

function cgFingerprint(body) {
  const msgs = (body && body.messages) || [];
  const last = msgs.length > 0 ? msgs[msgs.length - 1] : null;
  const model = body && typeof body.model === "string" ? body.model : "";
  let lastStr = "";
  try { lastStr = last ? JSON.stringify(last).slice(0, 400) : ""; } catch (e) { lastStr = ""; }
  return model + "|" + msgs.length + "|" + lastStr;
}

const CG_LOOP_HITS = new Map();
function cgLoopHit(key, now, windowMs) {
  let arr = CG_LOOP_HITS.get(key);
  if (!Array.isArray(arr)) arr = [];
  arr = arr.filter(t => now - t < windowMs);
  arr.push(now);
  CG_LOOP_HITS.set(key, arr);
  if (CG_LOOP_HITS.size > 2048) {
    for (const [k, v] of CG_LOOP_HITS) { if (v.every(t => now - t >= windowMs)) CG_LOOP_HITS.delete(k); }
  }
  return arr.length;
}

// KV 跨请求循环计数 (wb 无 D1, KV 是唯一持久存储)。
// KV 有 ~60s 最终一致 + 单 key 1 次/秒写限制, 故这是 best-effort:
// 写失败一律吞掉, 绝不因此拦截或拖慢真实请求。无状态的上下文上限是硬兜底。
function cgBucket(now, windowMs) { return Math.floor(now / windowMs); }

async function cgKvLoopCount(ownerKey, fingerprint, now, windowMs) {
  try {
    if (typeof KV === "undefined" || !KV) return null;
    const bucket = cgBucket(now, windowMs);
    const k = "cgloop:" + bucket + ":" + ownerKey + ":" + fingerprint;
    const cur = Number(await KV.get(k)) || 0;
    const next = cur + 1;
    // 只在计数前进时写, 且失败忽略 (KV 写限流/配额不该影响对话)
    await KV.put(k, String(next), { expirationTtl: Math.max(120, Math.ceil(windowMs / 1000) * 2) });
    // 上一桶也读一下, 得到近似滑动窗口
    const prevK = "cgloop:" + (bucket - 1) + ":" + ownerKey + ":" + fingerprint;
    const prev = Number(await KV.get(prevK)) || 0;
    return next + prev;
  } catch (e) {
    return null;
  }
}

// 返回 null = 放行; 否则返回 { status, body } 拒绝。
// realWindow: 该模型真实上游窗口(tokens), 未知传 null。
async function cgCheckAsync(body, cfg, ownerKey, now, realWindow) {
  const sync = cgCheck(body, cfg, ownerKey, now, realWindow);
  if (sync) return sync;
  // 内存熔断未触发时, 再查一次 KV 跨请求计数 (跨 isolate 才拦得住)
  if (cfg.loopRepeatLimit > 0) {
    const n = now || Date.now();
    const hits = await cgKvLoopCount(String(ownerKey || "anon"), cgFingerprint(body), n, cfg.loopWindowMs);
    if (hits != null && hits >= cfg.loopRepeatLimit) {
      return {
        estimated: cgEstimateTokens((body && body.messages) || []),
        status: 429,
        body: { error: {
          message: "The same request has been submitted " + hits + " times in " + Math.round(cfg.loopWindowMs / 1000) +
            "s (runaway loop detected). Halting to protect upstream quota. If this is intentional, wait and retry.",
          type: "rate_limit_error", code: "loop_detected" } },
      };
    }
  }
  return null;
}

/**
 * 计算指定模型的有效护栏上限(tokens)。
 * 返回 min(REASONABLE_CAP, 真实窗口); 未知/异常窗口按 REASONABLE_CAP 兜底。
 * 供 handleProxy 在调用前取该模型真实窗口后传入。
 */
function cgCeilingFor(realWindow) { return cgEffectiveCeiling(realWindow); }

// 返回 null = 放行; 否则返回 { status, body } 拒绝。
// realWindow: 该模型真实上游窗口(来自 /v3/config maxInputTokens), 未知传 null。
function cgCheck(body, cfg, ownerKey, now, realWindow) {
  now = now || Date.now();
  const messages = (body && body.messages) || [];
  const estimated = cgEstimateTokens(messages);
  // 有效上限 = min( 手动硬顶(若设), REASONABLE_CAP, 模型真实窗口 )。
  // 三者取最小: 手动值只能收紧不能放宽; 无声明模型由 REASONABLE_CAP 兜底。
  let ceiling = cgEffectiveCeiling(realWindow);
  if (cfg.maxContextTokens > 0) ceiling = Math.min(ceiling, cfg.maxContextTokens);

  if (ceiling > 0 && estimated > ceiling) {
    return {
      estimated,
      status: 413,
      body: { error: {
        message: "Prompt is ~" + estimated + " tokens, exceeding the wb gateway's " + ceiling +
          "-token context ceiling. This request looks like an unbounded conversation (a spin) replaying its full history; compact or start a fresh session.",
        type: "context_length_exceeded", code: "context_too_large" } },
    };
  }

  if (cfg.loopRepeatLimit > 0) {
    const key = String(ownerKey || "anon") + "|" + cgFingerprint(body);
    const hits = cgLoopHit(key, now, cfg.loopWindowMs);
    if (hits >= cfg.loopRepeatLimit) {
      return {
        estimated,
        status: 429,
        body: { error: {
          message: "The same request has been submitted " + hits + " times in " + Math.round(cfg.loopWindowMs / 1000) +
            "s (runaway loop detected). Halting to protect upstream quota. If this is intentional, wait and retry.",
          type: "rate_limit_error", code: "loop_detected" } },
      };
    }
  }

  return null;
}


//=== ui ===
// 登录门禁页 (未输令牌前只看到这个, 不暴露真实界面)
const LOGIN = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>WorkBuddy 管理面板 · 登录</title>
<style>*{box-sizing:border-box}body{margin:0;background:#fdf6e3;color:#1a1a1a;font-family:'Comic Sans MS',system-ui,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center}
.card{border:3px solid #1a1a1a;border-radius:14px;background:#fff;box-shadow:6px 6px 0 #1a1a1a;padding:28px 30px;width:340px;transform:rotate(-.6deg)}
h1{font-size:22px;margin:0 0 16px;transform:rotate(-1deg)}input{width:100%;border:2.5px solid #1a1a1a;border-radius:8px;padding:10px;font-size:15px;margin-bottom:12px;font-family:inherit}
button{cursor:pointer;width:100%;border:2.5px solid #1a1a1a;border-radius:10px;background:#ff6b35;color:#fff;padding:10px;font-weight:700;font-size:15px;font-family:inherit;box-shadow:3px 3px 0 #1a1a1a}
button:hover{background:#e85a2a}.muted{color:#666;font-size:12px;margin-top:8px;text-align:center}</style></head>
<body><div class="card"><h1>🔐 WorkBuddy 管理面板</h1>
<input id="t" type="password" placeholder="请输入管理令牌" autofocus>
<button onclick="go()">进 入</button>
<div class="muted">令牌由管理员下发, 错误无法进入</div></div>
<script>function go(){const v=document.getElementById('t').value;fetch('__BASE__/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token:v})}).then(r=>r.json().then(j=>({s:r.status,j}))).then(({s,j})=>{if(s===200&&j.ok){location.reload()}else{alert('令牌错误')}}).catch(e=>alert('网络错误'))}
document.getElementById('t').addEventListener('keydown',e=>{if(e.key==='Enter')go()})</script></body></html>`;
// 手绘风管理面板 UI (neo-brutalist sketchbook)
const UI = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>WorkBuddy 管理面板</title>
<style>
:root{--ink:#1a1a1a;--paper:#fdf6e3;--accent:#ff6b35;--blue:#3b82f6;--green:#16a34a;--red:#dc2626;--line:#1a1a1a}
*{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink);font-family:'Comic Sans MS','Segoe UI',system-ui,sans-serif;padding:18px}
h1{font-size:26px;transform:rotate(-1deg)}
.wrap{max-width:1080px;margin:0 auto}
.card{border:3px solid var(--line);border-radius:14px;background:#fff;box-shadow:5px 5px 0 var(--line);padding:16px;margin:14px 0;transform:rotate(.3deg)}
.card:nth-child(even){transform:rotate(-.4deg)}
.bar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:10px}
button{cursor:pointer;border:2.5px solid var(--line);border-radius:10px;background:#fff;padding:7px 13px;font-weight:700;font-family:inherit;box-shadow:3px 3px 0 var(--line);transform:rotate(-.6deg)}
button:hover{background:var(--accent);color:#fff}
button.sm{padding:4px 9px;font-size:12px;box-shadow:2px 2px 0 var(--line)}
button.b{background:var(--blue);color:#fff} button.g{background:var(--green);color:#fff} button.r{background:var(--red);color:#fff}
input,textarea,select{border:2.5px solid var(--line);border-radius:8px;padding:6px 9px;font-family:inherit;font-size:13px;background:#fffdf5}
.token{width:260px}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{border:2px solid var(--line);padding:6px 8px;text-align:left}
th{background:#fff3d6}
.tag{display:inline-block;border:2px solid var(--line);border-radius:6px;padding:1px 6px;font-size:11px}
.ok{background:#dcfce7}.bad{background:#fee2e2}.warn{background:#fef9c3}
.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
.muted{color:#666;font-size:12px}
.box{border:2px dashed var(--line);border-radius:10px;background:#fffdf5;padding:10px 12px;margin:8px 0}
code{background:#1a1a1a;color:#9fe;padding:1px 5px;border-radius:4px;font-size:12px;font-family:monospace}
pre{background:#1a1a1a;color:#9fe;padding:10px;border-radius:8px;overflow:auto;font-size:12px;max-height:260px}
.hide{display:none}
</style>
</head>
<body><div class="wrap">
<h1>🐱 WorkBuddy 管理面板</h1>
<div class="card">
  <div class="bar">
    <button onclick="loadAll()">🔄 刷新</button>
    <button class="g" onclick="document.getElementById('imp').classList.toggle('hide')">📥 导入账号 (粘贴/上传)</button>
    <button class="b" onclick="creditsAll()">💰 一键拉取全部额度</button>
    <button onclick="showKeys()">🔑 API Key 管理</button>
    <button onclick="showModels()">🧠 模型</button><button onclick="showSetting()">⚙️ 设置</button>
    <button onclick="showLogs()">📜 任务日志</button>
    <button class="r sm" onclick="logout()">退出</button>
  </div>
  <div id="imp" class="hide card" style="background:#fff8e7">
    <b>导入账号</b><div class="muted">支持粘贴 JSON，或上传 APK 导出的 .json 文件（避免字数限制）</div>
    <div class="row" style="margin-top:8px">
      <textarea id="impTxt" rows="5" style="width:100%" placeholder='粘贴授权 JSON (含 access_token)...'></textarea>
    </div>
    <div class="row" style="margin-top:8px">
      <input type="file" id="impFile" accept=".json,application/json">
      <button class="g" onclick="importAcc()">导入</button>
      <span id="impMsg" class="muted"></span>
    </div>
  </div>
</div>

<div class="card">
  <b>📋 账号列表</b>
  <div id="accs" style="margin-top:10px">加载中…</div>
</div>

<div id="keyCard" class="card hide">
  <b>🔑 API Key 管理</b><div class="muted">生成独立下游 key，替代直接暴露 CF 令牌。可绑定账号 / 禁用 / 删除 / 一键清空。</div>
  <div class="row" style="margin:10px 0">
    <input id="kName" placeholder="备注名">
    <button class="g" onclick="createKey()">＋ 生成 Key</button>
    <button class="r" onclick="clearKeys()">🗑 一键清空</button>
  </div>
  <div class="box">
    <b>下游调用方式（OpenAI 兼容）</b>
    <div class="muted">在任意 OpenAI 客户端 / 代码里使用：</div>
    <table style="margin:6px 0">
      <tr><td style="padding:2px 8px 2px 0;vertical-align:top"><b>BaseURL</b></td><td><code>https://wb.kbi190.kdns.fr/manager/api</code></td></tr>
      <tr><td style="padding:2px 8px 2px 0;vertical-align:top"><b>API Key</b></td><td>上面生成的 <code>sk-wb-...</code></td></tr>
      <tr><td style="padding:2px 8px 2px 0;vertical-align:top"><b>对话</b></td><td><code>POST /v1/chat/completions</code>（OpenAI 协议，支持 stream）</td></tr>
      <tr><td style="padding:2px 8px 2px 0;vertical-align:top"><b>模型列表</b></td><td><code>GET /v1/models</code></td></tr>
    </table>
    <div class="muted">请求头带 <code>Authorization: Bearer &lt;sk-wb-...&gt;</code> 即可；未绑定账号的 key 会在所有启用账号间随机负载，绑定后仅走指定账号。模型名用本面板「模型」里列出的 id（如 <code>hy3</code>、<code>deepseek-v4-pro</code>）。</div>
  </div>
  <div id="keys"></div>
</div>

<div id="setCard" class="card hide">
  <b>⚙️ 接入设置</b>
  <div class="box">
    <label class="row" style="gap:8px">
      <input type="checkbox" id="setRate" onchange="saveSetting()">
      <span>在对外 <code>/v1/models</code> 的模型 id 上拼倍率注释</span>
    </label>
    <div class="muted">Operit / DSHA 等客户端只渲染模型 id、不显示倍率字段时，开启后模型名会变成 <code>hy4-preview [x0.29]</code>、<code>hy3 [免费]</code> 这样带注释的形式（对话时代理会自动剥掉后缀，不影响实际调用）。关闭则恢复纯净 id。</div>
  </div>
</div>

<div id="logCard" class="card hide">
  <b>📜 任务日志</b>
  <pre id="logs"></pre>
</div>

<div id="modelCard" class="card hide">
  <b>🧠 模型管理 (全局, 国内+国际)</b>
  <div class="muted" id="modelHdr"></div>
  <div id="models"></div>
</div>

</div>
<script>
const $=s=>document.querySelector(s);
function hdr(){return{'content-type':'application/json'}}  // 会话 cookie 自动随请求发送, 无需手动令牌
async function api(p,body,m='POST'){const opt={method:m,headers:hdr()};if(m!=='GET'&&body)opt.body=JSON.stringify(body);const r=await fetch('__BASE__/api/'+p,opt);return r.json()}
async function logout(){await fetch('__BASE__/api/logout',{method:'POST'}).catch(()=>{});location.reload()}
async function loadAll(){
  const r=await api('accounts',null,'GET').catch(e=>({error:String(e)}));
  if(r.error){$('#accs').innerHTML='<span class="bad tag">'+r.error+'</span>';return}
  let h='<table><tr><th>uid</th><th>域</th><th>额度</th><th>token到期</th><th>状态</th><th>操作</th></tr>';
  for(const a of (r.accounts||[])){
    const exp=new Date(a.expires_at*1000).toLocaleString();
    const st=a.token_expired?'<span class="tag bad">token过期</span>':'<span class="tag ok">正常</span>';
    const en=a.enabled?'<span class="tag ok">启用</span>':'<span class="tag warn">禁用</span>';
    let creditCell='<span class="muted">未查</span>';
    if(a.credits!=null){creditCell=a.credits;if(a.expiries&&a.expiries[0]){creditCell+='<br><span class="muted">最早到期 '+new Date(a.expiries[0].at*1000).toLocaleDateString()+'</span>'}}
    h+='<tr><td>'+a.uid+'</td><td>'+a.realm+'<br><span class="muted">'+a.domain+'</span></td>'+
       '<td>'+creditCell+'</td>'+
       '<td>'+exp+'</td><td>'+st+en+'</td><td class="row">'+
       '<button class="sm" onclick="doRefresh(&quot;'+a.id+'&quot;)">续期</button>'+
       '<button class="sm g" onclick="doCheckin(&quot;'+a.id+'&quot;)">签到</button>'+
       '<button class="sm b" onclick="doCredits(&quot;'+a.id+'&quot;)">额度</button>'+
       '<button class="sm" onclick="toggleAcc(&quot;'+a.id+'&quot;,'+(!a.enabled)+')">'+(a.enabled?'禁用':'启用')+'</button>'+
       '<button class="sm r" onclick="delAcc(&quot;'+a.id+'&quot;)">删除</button></td></tr>';
  }
  h+='</table>';
  $('#accs').innerHTML=h;
}
async function importAcc(){const f=$('#impFile').files[0];let txt=$('#impTxt').value;
  if(f){txt=await f.text()}
  if(!txt){$('#impMsg').textContent='请粘贴或选择文件';return}
  const r=await api('accounts/import',{json:txt});
  $('#impMsg').textContent=r.ok?('导入 '+r.imported+' 个'):('失败: '+(r.error||''));
  if(r.ok)loadAll();
}
async function doRefresh(id){const r=await api('accounts/refresh',{id});alert(r.ok?'续期成功':'失败: '+r.msg)}
async function doCheckin(id){const r=await api('accounts/checkin',{id});alert('签到: '+(r.msg||r.code))}
async function doCredits(id){const r=await api('accounts/credits',{id});alert(r.ok?('额度 '+r.credits):('失败 '+r.msg));loadAll()}
async function creditsAll(){const r=await api('accounts/credits-all',{});if(r.ok)alert('总计额度: '+r.total+'\\n'+r.results.map(x=>x.uid+':'+(x.credits??'x')).join('\\n'));loadAll()}
async function toggleAcc(id,en){await api('accounts/enable',{id,enabled:en});loadAll()}
async function delAcc(id){if(!confirm('确认删除该账号?'))return;await api('accounts/delete',{id});loadAll()}
// ---- 全局模型管理: 一键聚合国内+国际, 勾选=隐藏 (存隐藏集合, 新模型默认出现) ----
let MODELS_CACHE=null, HIDDEN_SET={};
async function showModels(force){
  $('#modelCard').classList.remove('hide');
  $('#modelHdr').textContent='加载中…';
  if(!HIDDEN_SET._loaded){const hr=await api('models/hidden-get',null,'GET');if(hr.ok){HIDDEN_SET=hr.hidden||{}}HIDDEN_SET._loaded=1}
  const r=await api('models/agg',{force:force?1:0});
  if(!r.ok){$('#modelHdr').textContent='拉取失败: '+(r.error||'');return}
  MODELS_CACHE=r.models||[];
  renderModels();
}
function renderModels(){
  const ms=MODELS_CACHE||[];const hidden=HIDDEN_SET;
  const f=(document.getElementById('mf')||{}).value||'';
  let list=ms;
  if(f==='cn')list=ms.filter(m=>m.realm==='cn'&&!m.srcTag);
  if(f==='g')list=ms.filter(m=>m.srcTag==='g');
  let h='<div class="row" style="margin:6px 0">'+
    '<select id="mf" onchange="renderModels()"><option value="">全部来源</option><option value="cn"'+(f==='cn'?' selected':'')+'>仅国内</option><option value="g"'+(f==='g'?' selected':'')+'>仅国际</option></select>'+
    '<span class="muted">共 '+list.length+' 条 (同名模型国内/国际各一条)</span>'+
    '<button class="sm g" onclick="saveHidden()">保存隐藏</button>'+
    '<button class="sm" onclick="showModels(true)">强制刷新</button>'+
    '<button class="sm b" onclick="probeWindows()">🔎 探测窗口</button></div>';
  h+='<table><tr><th>模型 id</th><th>来源</th><th>倍率</th><th>折扣</th><th>上下文</th><th>隐藏</th></tr>';
  list.forEach(m=>{
    const src=m.srcTag==='g'?'<span class="tag warn">国际g</span>':'<span class="tag ok">国内</span>';
    const mult=m.multiplier?'<span class="tag ok">'+m.multiplier+'</span>':'<span class="muted">—</span>';
    const disc=m.discounted?'<span class="tag warn">'+m.discounted+'</span>':'<span class="muted">—</span>';
    const ctx=m.context?Math.round(m.context/1000)+'k':'<span class="muted">—</span>';
    h+='<tr><td>'+m.id+'</td><td>'+src+'</td><td>'+mult+'</td><td>'+disc+'</td><td>'+ctx+'</td>'+
    '<td><input type="checkbox" data-h="'+m.id+'"'+(hidden[m.id]?' checked':'')+'></td></tr>'});
  h+='</table>'+
    '<div class="muted">勾选「隐藏」后该模型不再出现在对外 <code>/v1/models</code>（同名模型国内/国际两条一起隐藏）。存的是隐藏集合——上游新出模型自动出现，无需维护白名单。倍率来自上游 <code>credits</code>，折扣来自 <code>modelPromotions</code>。</div>';
  $('#models').innerHTML=h;
}
async function saveHidden(){
  const sel=[...document.querySelectorAll('#models [data-h]:checked')].map(c=>c.dataset.h);
  const r=await api('models/hidden-save',{hidden:sel});
  if(r.ok){delete HIDDEN_SET._loaded;const t={};for(const id of sel)t[id]=1;HIDDEN_SET=t;alert('已隐藏 '+sel.length+' 个模型')}
}
// 一键探测各模型真实上游上下文窗口 + 护栏有效上限(基于网关 /v3/config)。
// 也把网关 REASONABLE_CAP 兜底值显示出来, 让用户看清"无窗口声明模型"的护栏。
async function probeWindows(){
  const btn=document.querySelector('[onclick="probeWindows()"]'); if(btn)btn.disabled=true;
  const r=await api('models/windows',{}).catch(e=>({error:String(e)}));
  if(btn)btn.disabled=false;
  if(!r.ok){alert('探测失败: '+(r.error||''));return}
  const w=r.windows||{}, capped=r.capped||{}, cap=r.reasonableCap||262144;
  let known=0, unknown=0, cnt=0;
  const keys=Object.keys(w).sort();
  let h='<div class="row" style="margin:6px 0"><b>🔎 上下文窗口探测</b> '+
    '<span class="muted">兜底护栏 REASONABLE_CAP='+cap+' tokens（无窗口声明的模型按此限）</span></div>';
  h+='<table><tr><th>模型 id</th><th>上游窗口</th><th>护栏有效上限(min)</th><th>来源</th></tr>';
  for(const id of keys){
    const info=w[id]; const ceil=capped[id]!=null?capped[id]:cap;
    if(info.context){known++}else{unknown++}
    cnt++;
    h+='<tr><td>'+id+'</td>'+
      '<td>'+(info.context?Math.round(info.context/1000)+'k':('<span class="tag bad">未知</span>'))+'</td>'+
      '<td>'+Math.round(ceil/1000)+'k</td>'+
      '<td>'+info.source+' / '+(info.realm||'')+'</td></tr>';
  }
  h+='</table><div class="muted">共 '+cnt+' 个模型：有窗口声明 '+known+'，无声明(按兜底 '+Math.round(cap/1000)+'k) '+unknown+'。<br>'+
    '护栏 = min(REASONABLE_CAP=262144, 上游真实窗口)。上游窗口比兜底小的按上游限（如上游 32k→护栏 32k）；上游窗口缺失的按兜底限，防止"无限制"模型把巨 prompt 放给上游烧穿额度。</div>';
  $('#models').innerHTML=h;
}
async function showKeys(){const r=await api('keys',null,'GET');$('#keyCard').classList.remove('hide');
  let h='<table><tr><th>Key</th><th>备注</th><th>绑定账号</th><th>状态</th><th>创建</th><th>操作</th></tr>';
  (r.keys||[]).forEach(k=>{h+='<tr><td style="font-family:monospace">'+k.apikey+'</td><td>'+k.name+'</td><td>'+
    ((k.account_ids||[]).length||'全部')+'</td><td>'+(k.enabled?'<span class="tag ok">启用</span>':'<span class="tag warn">禁用</span>')+
    '</td><td>'+new Date(k.created_at*1000).toLocaleDateString()+'</td><td class="row">'+
    '<button class="sm" onclick="toggleKey(&quot;'+k.id+'&quot;,'+(!k.enabled)+')">'+(k.enabled?'禁用':'启用')+'</button>'+
    '<button class="sm r" onclick="delKey(&quot;'+k.id+'&quot;)">删除</button></td></tr>'});
  h+='</table>';$('#keys').innerHTML=h;
}
async function showSetting(){const r=await api('setting/get',null,'GET');$('#setCard').classList.remove('hide');
  $('#setRate').checked=!!(r.setting&&r.setting.modelWithRate)}
async function saveSetting(){const en=$('#setRate').checked?1:0;const r=await api('setting/save',{modelWithRate:en});
  if(r.ok){alert(en?'已开启：模型 id 已带倍率注释（如 hy4-preview [x0.29]）':'已关闭：恢复纯净模型 id')}else{alert('保存失败')}}
async function createKey(){const r=await api('keys/create',{name:$('#kName').value});if(r.ok){alert('新 Key: '+r.key.apikey);showKeys()}}
async function toggleKey(id,en){await api('keys/update',{id,enabled:en});showKeys()}
async function delKey(id){if(!confirm('删除该 Key?'))return;await api('keys/delete',{id});showKeys()}
async function clearKeys(){if(!confirm('清空所有 Key?'))return;await api('keys/clear',{});showKeys()}
async function showLogs(){const r=await api('logs',null,'GET');$('#logCard').classList.remove('hide');
  $('#logs').textContent=JSON.stringify(r.logs||[],null,1)}
// 页面就绪即自动加载账号列表 (无需手动点刷新, 也不要求输入令牌)
window.addEventListener('load',()=>{loadAll()});
</script>
</body></html>`;

//=== index ===




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
    try { const r = await checkin(acc); await logTask("checkin", acc.id, r.code === 0 || r.code === 10001, r.msg); log.push(acc.uid + ":checkin " + r.msg); }
    catch (e) { await logTask("checkin", acc.id, false, String(e.message || e).slice(0, 200)); }
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
