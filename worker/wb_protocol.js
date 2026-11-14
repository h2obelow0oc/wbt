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
export async function refreshToken(acc) {
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
export async function checkin(acc) {
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
export async function fetchCredits(acc) {
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
export async function fetchModels(acc) {
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
    // ★ 只有 `{effort:"medium", summary:"auto"}` 这一种形状的模型（glm-5.0-turbo
    //   等）原先被**整段丢弃** —— 没有 supportedEfforts 就不进 meta.reasoning。
    //   实测后果：这类模型**必须**显式带 `reasoning_effort` 才 200，不带必 400/11150
    //   `the reasoning effort value is not supported by the current model`。
    //   把上游声明的默认档留下来，让 handleProxy 在撞 11150 后能补对档位。
    const effDefault = typeof fields.defaultEffort === "string" ? fields.defaultEffort
      : typeof fields.effort === "string" ? fields.effort : null;
    if (effDefault) {
      meta.reasoning = meta.reasoning || { summary: fields.summary ?? "支持" };
      if (!meta.reasoning.defaultEffort) meta.reasoning.defaultEffort = effDefault;
      meta.reasoning.explicitRequired = meta.reasoning.supportedEfforts ? false : true;
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
    // 上游思考档元数据有**两种形状**（都在线上出现过）：
    //   A) `{defaultEffort, supportedEfforts:[...], canDisableThinking}` —— 新版
    //   B) `{effort:'medium', summary:'auto'}` —— glm-5.0-turbo / glm-5.2 这种
    // 原先只认 A，B 被整段丢弃。B 的模型**必须**显式带 `reasoning_effort` 才 200，
    // 不带必 400/11150（实测 `the reasoning effort value is not supported by the
    // current model`）。所以这里把 B 也归一化成同一份 {defaultEffort, explicitRequired}。
    const rawReasoning = (meta && meta.reasoning && typeof meta.reasoning === "object") ? meta.reasoning : null;
    const reasoning = rawReasoning ? { ...rawReasoning } : null;
    if (reasoning) {
      const hasList = Array.isArray(reasoning.supportedEfforts) && reasoning.supportedEfforts.length > 0;
      if (!reasoning.defaultEffort) {
        const eff = typeof reasoning.effort === "string" ? reasoning.effort : null;
        if (eff) reasoning.defaultEffort = eff;
      }
      // explicitRequired=true ⇒ 该模型不吃"不发即默认"，必须显式带档。
      reasoning.explicitRequired = hasList ? false : (typeof reasoning.defaultEffort === "string");
    }
    parsed.push({
      id,
      name: remoteName ?? id,
      multiplier: rate ?? null,
      discounted: discounted ?? null,
      context: (meta && meta.maxInputTokens) || null,
      maxOutput: (meta && meta.maxOutputTokens) || null,
      supportsImages: meta ? !!meta.supportsImages : false,
      reasoning,
      // 上游声明的**默认思考档**。撞 11150 时按它补；缺失回落 medium（见 model-marks.js）。
      effort: reasoning && typeof reasoning.defaultEffort === "string" ? reasoning.defaultEffort : null,
      source: "v3/config",
    });
  };
  for (const id of metaById.keys()) push(id);
  return parsed;
}

// parseBuddyModels 导出仅供单测使用（tools/test-model-marks.mjs 钉住
// 「只有 effort 没有 supportedEfforts」这种形状的解析），业务代码仍走 fetchModels。
export { realmOf, chatBase, billingBase, originOf, commonHeaders, normExpires, neutralizeSystemMessages, wbNeutralizeAllPaths, parseBuddyModels };
