/**
 * 渠道签到 —— 移植 OFM `channel-pack/src/{minimax,lobsterai}-credits.ts` 的签到部分。
 *
 * ## 为什么必须移植
 * 渠道额度是**签到挣来的**: minimax 每日签到给 800 分, 从不签到的话
 * `credit/details` 返回的就是 `details:[] / total_count:0` —— 那是**真 0**,
 * 不是查询失败。实测某账号一直显示 0, 看起来像"额度没移植成功", 实为没签到。
 *
 * ## 支持范围（2026-11-06 实测修正 —— 此前照抄 OFM 的说法是错的）
 * | 渠道 | 每日签到 | 依据 |
 * |---|---|---|
 * | minimax   | ✅ | `signin/status` + `signin/claim` |
 * | lobsterai | ✅ | 三步 client-activities 流程 |
 * | raccoon   | ✅ | `GET /api/web/office/v3/setting_info`（「登录」信号本身，见下） |
 * | cline     | ❌ | OFM: 「签到不存在」 |
 *
 * ## raccoon 的真相（2026-11-06 网关实测，推翻 OFM「每日 300 无签到端点」）
 * 官方规则（doc.xiaohuanxiong.com 积分规则说明）：每日 300 每天 00:00 **自动发放**，
 * 未登录则**当日 24:00 清零**，当天登录过 → 延长至 7 天。纯 API 流量（推理/额度 GET）
 * 不算「登录」，所以 11-04 导入的 4 个号三天来**发一笔清一笔、一次都没拿到**
 * （账单 `daily_grant`+`daily_expire` 成对出现，daily_points 恒 0 —— 铁证）。
 * 实测打一发 `GET /api/web/office/v3/setting_info`（web 端登录后的设置拉取，
 * issue dsh-our-free-model#430 的线索）：balance 立刻 +300、账单落下 `daily_grant`。
 * ⚠️ 它**不走 points 前缀**，续期/额度读的 `RACCOON_API_BASE` 覆盖到不了它 ——
 * 必须单独读 `RACCOON_CHECKIN_BASE`（否则「关掉 raccoon 签到」的测试会把请求
 * 打到**真实商汤**，踩过一次才立的规矩）。
 *
 * ## 两条照抄的坑
 * 1. minimax 的 `timezone_id` 是**必填 query 参数**；不带报 `invalid timezone_id`，
 *    而且该错误是 **HTTP 200** —— 只看状态码会把它当成功。
 * 2. `points` 是总数、`bonus_points` 是其中的「额外」部分，**相加会虚高一倍**
 *    （实测第 1 天 800 / 400，面板显示「签到得 800」+「额外 400」）。
 */
import { randomUUID } from 'node:crypto';
import { products, override } from './chan-refresh.js';

const TIMEOUT_MS = 15000;

const MINIMAX_SIGNIN_STATUS_PATH = '/minimax-cloud/api/v1/signin/status';
const MINIMAX_SIGNIN_CLAIM_PATH = '/minimax-cloud/api/v1/signin/claim';
const LOBSTERAI_SLOT_PATH = '/api/client-activities/slot';
const LOBSTERAI_ACTIVITY_PATH = '/api/client-activities';
// slot 固定 query —— 照抄 sigin.py:52-53；这些值是真实客户端观察到的，改了可能拿不到活动
const SLOT_PLACEMENT = 'desktop_sidebar';
const SLOT_CONTAINER_API_VERSION = '2';
const SLOT_PLATFORM = 'win32';

/** 单日状态（asar `SigninDayStatus`）。 */
const SIGNIN_STATUS = { Upcoming: 1, Claimable: 2, Claimed: 3, Disabled: 4 };
/** 领取结果（asar `SigninClaimResult`）。 */
const CLAIM_RESULT = { Claimed: 1, AlreadyClaimed: 2 };

/** 支持每日签到的渠道（面板据此决定是否渲染「签到」按钮）。 */
export const CHECKINABLE = ['minimax', 'lobsterai', 'raccoon'];

// ──────────────────────────── 小工具 ────────────────────────────
/**
 * 签到用的 IANA 时区名 —— minimax 的 `timezone_id` 必填参数。
 *
 * ⚠️ **不能让服务器的默认 TZ 决定日界线**（2026-11-03 用户报障的真因之一）：
 * Render 容器 TZ 是 **UTC**，`Intl...resolvedOptions().timeZone` 返回 `UTC`，
 * 于是「今天」按 UTC 算 —— UTC 00:00 换日 = 北京 **08:00** 换日。
 * 后果：用户在北京 07:59 看仍是"昨天"（已签、无可领），08:17 手动点却
 * 能签，看起来像「自动签到失效」，实际是日界线错位。再叠加 cron 每 6h
 * 一轮，跨过北京 08:00 的那轮可能落在 10:45，于是 08:00–10:45 之间
 * 用户永远看到"没签到"。
 *
 * OFM 源码用的是「本机时区」，它跑在用户自己的机器上所以正确；
 * 网关跑在 UTC 服务器上，**必须显式指定**才等价。
 * 优先级：`CHECKIN_TIMEZONE` 环境变量 → `Asia/Shanghai`（用户本机时区）。
 */
function timezoneId() {
  const forced = String(process.env.CHECKIN_TIMEZONE || '').trim();
  if (forced) return forced;
  // 用户在北京 —— 签到日界线必须按北京算，不能随部署机器 TZ 走
  return 'Asia/Shanghai';
}

async function getJson(url, headers) {
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  const text = await r.text().catch(() => '');
  let b; try { b = JSON.parse(text); } catch { b = undefined; }
  // 把原文也带回来：403/502 这类错误常常不是 JSON（网关/风控的 HTML 页），
  // 不留原文就只能看到一个状态码，排障等于瞎猜。
  return { ok: r.ok, status: r.status, body: b, text: text.slice(0, 200) };
}

/** minimax 业务码在 `base_resp.status_code`（不是 `code`），且无效时区也是 HTTP 200。 */
const brStatus = b => (b && b.base_resp ? Number(b.base_resp.status_code) : undefined);

const num = v => (typeof v === 'number' && Number.isFinite(v)) ? v : undefined;

/**
 * 解析金额：同时接受数字与字符串。
 * `Number('') === 0`，会把空串误读成「0 积分」—— 先挡掉，读不出返回 undefined。
 */
function looseAmount(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  if (t === '') return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * minimax 响应信封兼容：`{data:{...}}` 与平铺 `{...}` 两种都吃。
 * 与 OFM 的 `unwrapEnvelopeData` 语义一致 —— 签到面板/claim/余额三个端点
 * 在不同版本下嵌套方式不一致，只认一种就会静默读不到。
 */
function unwrapData(b) {
  if (!b || typeof b !== 'object') return {};
  const d = b.data;
  return (d && typeof d === 'object' && !Array.isArray(d)) ? d : b;
}

/** 统一出口：签到结果 → 网关路由/cron 都吃的形状。 */
const out = (ok, msg, extra = {}) => ({ ok, msg, ...extra });

// ──────────────────────────── MiniMax ────────────────────────────
/**
 * minimax 的「上游认到第几天」记忆：`accId → { dayNo, at }`。
 *
 * ## 为什么需要它（2026-11-04 用户报「今天依然没自动签到，手动点才 +400」）
 *
 * 上游换天**不是在北京 0 点**，而网关按 `bjDay()`（北京 00:00）算「今天」，
 * 于是在「已过北京 0 点、上游还没换天」的这段窗口里，旧代码把「面板上没有
 * 可领项」直接判成「今天已完成」并写进 `checkinDay`，当天再也不重试。
 *
 * 日志证据（全部是线上真实记录，北京时区）：
 *
 * | 时刻 | 面板 | 网关动作 | 后果 |
 * |---|---|---|---|
 * | 11-03 08:17 | 可领 | 签上 → `2:3*` | 正常 |
 * | 11-03 08:26 / 08:42 | `2:3*` | 判"已完成" | 正常（同一天不重复签） |
 * | 11-04 00:24 | — | 401（token 到期） | 00:24:42 保活才刷新 |
 * | 11-04 00:54 | `2:3*`，scene=2 | 判"无可领取=已完成"→ 记 11-04 已签 | ⛔ 当天全部跳过 |
 * | 11-04 08:35 | — | 用户手动点 | **+400**（证明自动确实没签） |
 * | 11-04 08:36 | `3:3*` | 被「今日已完成」跳过 | ⛔ |
 *
 * ⚠️ **能证明的与不能证明的**：只能证明「换天发生在 00:54 之后、08:35 之前」，
 * **无法证明具体钟点**（没有任何一轮 tick 命中换天瞬间；官方文档也没写）。
 * 另一条实证：11-03 签到成功后 `is_today` 仍停在 `2:3*` —— **领取本身不会
 * 推进 day_no**，只有真正换天才推进。
 *
 * ## 判据（2026-11-04 简化版 —— 用户指出的关键点）
 *
 * 真正的问题**不是"几点换天"**，而是**"在换天之前就去试"**：上游还没换天时，
 * 面板会把昨天那条已领的标成 `is_today`（实测 `2:3*`、scene=2），旧代码把
 * 「没有可领项」判成「今天已完成」并写进 `checkinDay` → 当天不再重试。
 *
 * 用户的原话点破了关键：「如果签到一天只有北京 8:05 和 21:25 两次，那实际上
 * 并不存在你说的会误认为没有到第二天」。也就是说，**只要不在换天前试**，
 * 这个误判根本不会发生。两条修法各自都够，一起用最稳：
 *
 * 1. **日界线门禁**（`index_turso.js` 的 `checkinGateHour`）：供应商只有
 *    CN / UTC 两类时区，折成北京时间就是 0 点与 8 点。按归属设门禁，
 *    换天前的那几轮直接不发请求 —— 误判的土壤没了。
 * 2. **「无 claimable」不再直接判已签**：能走到本函数这一步说明门禁已过、
 *    上游已换天，`is_today` 的状态这时才可信 ——`Claimed(3)` 或 `scene=3`
 *    才算签完；其余返回 `settled:false`，下个 tick 再试，绝不记账。
 *
 * 于是「一天只在北京 8:05 / 21:25 试两次」也自然正确：8:05 已换天，看到
 * Claimed 就记账；21:25 因为已记账直接跳过。**不需要记 day_no、不需要猜钟点。**
 */
/**
 * `GET {apiHost}/signin/status?timezone_id=` → 当前可领的那天。
 *
 * 返回 `{scene, day, todayStatus, summary}`。`day` 为 undefined 表示面板上
 * 没有 claimable 的日子，此时**必须再看 `todayStatus` 才能判断是不是"今天
 * 真的签完了"** —— 见 minimaxCheckin 里 settled 的注释（2026-11-04 用户
 * 报「手动点才 +400」的真因）。
 */
async function minimaxStatus(acc) {
  const { MINIMAX } = await products();
  const base = override('MINIMAX_API_HOST', MINIMAX.apiHost);
  const tz = timezoneId();
  const { ok, status, body } = await getJson(
    `${base}${MINIMAX_SIGNIN_STATUS_PATH}?timezone_id=${encodeURIComponent(tz)}`,
    { Authorization: `Bearer ${acc.access_token}`, Accept: 'application/json' });
  if (!ok) return { error: `signin/status HTTP ${status}` };
  const sc = brStatus(body);
  // ⚠️ 无效时区/参数错误是 **HTTP 200**，必须看 base_resp 而不是 status
  if (sc !== undefined && sc !== 0) return { error: `signin/status: ${(body.base_resp && body.base_resp.status_msg) || 'status=' + sc}` };
  const data = unwrapData(body);
  const days = Array.isArray(data.days) ? data.days : [];
  const scene = num(data.scene);
  const day = days.find(d => d && num(d.day_no) !== undefined && num(d.status) === SIGNIN_STATUS.Claimable);
  // 诊断摘要：没有可领项时，光说「无可领取」无法判断是已签完、还没开始，
  // 还是**字段读错了**（用户就撞上过后者）。把面板的真实状态一并带出。
  const summary = days.length
    ? days.map(d => `${num(d.day_no) ?? '?'}:${num(d.status) ?? '?'}${d && d.is_today ? '*' : ''}`).join(' ')
    : `days=${data.days === undefined ? '缺失' : '非数组'} 顶层键=${Object.keys(body || {}).join(',')}`;
  // `is_today` 只有一条（asar 硬约束）。它的 day_no 才是"上游认为今天是第几天"
  // 的唯一指针 —— 换天时它会前进；**光看 status 分不清「今天签完了」与
  // 「is_today 还停在昨天那条已签的」**（11-04 线上事故就是这个形状）。
  const today = days.find(d => d && d.is_today === true);
  const todayNo = today ? num(today.day_no) : undefined;
  const todayStatus = today ? num(today.status) : undefined;
  return { scene, day, todayNo, todayStatus, summary };
}

/**
 * `POST {apiHost}/signin/claim?timezone_id=`，body `{}`。
 * ⚠️ 幂等判据是 **`claim_result`**（`1` = 本次真领取，`2` = 已领过），
 * **不是** `result`、也不是 HTTP 状态码（重复领取同样 200）。
 * 我初版写成 `data.result` —— 字段名错，取到 undefined，于是永远判成
 * 「响应 result=undefined」，签到静默不生效（用户：「minimax 和有道不是
 * 自动签到？」）。
 */
async function minimaxClaim(acc) {
  const { MINIMAX } = await products();
  const base = override('MINIMAX_API_HOST', MINIMAX.apiHost);
  const tz = timezoneId();
  const r = await fetch(`${base}${MINIMAX_SIGNIN_CLAIM_PATH}?timezone_id=${encodeURIComponent(tz)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${acc.access_token}`, Accept: 'application/json', 'Content-Type': 'application/json' },
    body: '{}',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = await r.json().catch(() => undefined);
  const sc = brStatus(body);
  if (sc !== undefined && sc !== 0 && sc !== 10001)
    return { error: `signin/claim: ${(body && body.base_resp && body.base_resp.status_msg) || 'status=' + sc}` };
  // claim 响应也可能嵌套在 data 里，两种形状都认（与 credit/details 同款兼容）
  const d = unwrapData(body);
  const claimResult = num(d.claim_result);
  return { claimResult, points: num(d.points) };
}

/**
 * ⚠️ 2026-11-04 用户报「今天 minimax 依然没有自动签到，我登录后手动签到才 +400」。
 *
 * 真因**不是** tick 没跑，而是**记账口径错**：上游的「今天」换天点在北京
 * **08:00**（UTC 00:00），而网关按 `bjDay()`（北京 00:00）记账。00:54 那轮
 * 面板还是 `2:3*`（昨天的 Day2 已领、is_today 仍指向它），网关就把 11-04
 * 写进了 `checkinDay` 判成"今天已完成"，于是 08:00 上游真换天后，所有 tick
 * 与补签都因"今日已完成"被跳过 —— 直到用户 08:35 手动点了才拿到 +400。
 *
 * 判据（证据链）：08:35 手动 +400 之后，面板才变成 `3:3*`。若上游当时
 * 就已换天，00:54 就该看到 `3:2*`（可领）而签上。
 *
 * 修法：**「没有可领项」≠「今天已签完」**。必须看 `is_today` 那一天的
 * `status`：只有 `Claimed(3)` / `scene=3` 才算真签完（返回 ok:true 可记账）；
 * 其余一律返回 **ok:false**（未换天/未开放），由 checkinTick 下个 tick 重试，
 * 绝不写进 `checkinDay`。over-claim 的代价只是每 tick 一次只读 GET。
 */
async function minimaxCheckin(acc) {
  const st = await minimaxStatus(acc);
  if (st.error) return out(false, `minimax ${st.error}`);
  const day = st.day;
  if (!day) {
    const scene = st.scene;
    const detail = `（scene=${scene ?? '?'} today=${st.todayStatus ?? '?'} day#=${st.todayNo ?? '?'} ${st.summary || ''}）`.trim();
    // 门禁已过 ⇒ 上游已换天，此时 is_today 的状态才可信（见本函数上方注释）
    const settled = st.scene === 3 || st.todayStatus === SIGNIN_STATUS.Claimed;
    if (settled) return out(true, `minimax 签到已完成${detail}`, { claimed: false, settled: true });
    // 未换天/未开放：ok:true（不是错误，别污染失败日志），但 settled:false
    // —— checkinTick 看到后不写 checkinDay，下个 tick 再来。
    return out(true, `minimax 今日尚未开放领取（稍后重试）${detail}`, { claimed: false, settled: false });
  }
  const claim = await minimaxClaim(acc);
  if (claim.error) return out(false, `minimax ${claim.error}`);
  if (claim.claimResult === CLAIM_RESULT.Claimed) {
    // ⚠️ points 是总数，不要加 bonus_points（相加虚高一倍）；
    // claim 响应的 points 优先（那才是本次真到账的），缺失才退回面板值
    const credit = claim.points !== undefined ? claim.points : (num(day.points) ?? 0);
    return out(true, `minimax 签到成功 +${credit} 分`, { claimed: true, settled: true, credit });
  }
  if (claim.claimResult === CLAIM_RESULT.AlreadyClaimed) {
    return out(true, 'minimax 今天已签到', { claimed: false, settled: true });
  }
  return out(false, `minimax 签到响应 claim_result=${claim.claimResult}`);
}

// ──────────────────────────── LobsterAI ────────────────────────────
/** clientVersion 带缓存 —— 签到必填参数，每次现取会多打一个请求。 */
let _lobVer = { at: 0, version: null };
/** 供外部（如 lobsterai backend）复用的动态版本号解析。 */
export async function resolveLobsteraiVersion(LOBSTERAI) {
  const now = Date.now();
  if (_lobVer.version && now - _lobVer.at < 6 * 3600 * 1000) return _lobVer.version;
  try {
    const { ok, body } = await getJson(LOBSTERAI.clientVersionApi,
      { Accept: 'application/json', 'User-Agent': LOBSTERAI.userAgent });
    const v = ok && body && body.data && body.data.value && body.data.value.version;
    if (typeof v === 'string' && v) { _lobVer = { at: now, version: v }; return v; }
  } catch { /* 取不到就走兜底，不缓存兜底值（源码同款处理） */ }
  return LOBSTERAI.fallbackClientVersion;
}

/** lob信封：`{code, msg|message, data}`；code!==0 或 data 非对象都是失败。 */
function lobEnvelope(body) {
  if (!body || typeof body !== 'object') return { ok: false, message: '响应不是 JSON 对象' };
  const code = num(body.code) ?? -1;
  if (code !== 0) return { ok: false, code, message: body.msg || body.message || `code=${code}` };
  const d = body.data;
  if (!d || typeof d !== 'object' || Array.isArray(d)) return { ok: false, code, message: body.msg || body.message || 'data 为空' };
  return { ok: true, code, data: d };
}

const lobHeaders = (acc, LOBSTERAI, accept = 'application/json') => ({
  Authorization: `Bearer ${acc.access_token}`, Accept: accept,
  'Content-Type': 'application/json', 'User-Agent': LOBSTERAI.userAgent,
});

/**
 * 三步签到（照抄 `claimLobsteraiDailyCheckin` 的判定顺序）：
 * 槽位 → 上下文（claimedToday / actions）→ check_in。
 * LobsterAI 是**客户端幂等**：请求带 `idempotencyKey`（UUID4），服务端据此去重。
 */
async function lobsteraiCheckin(acc) {
  const { LOBSTERAI } = await products();
  const api = override('LOBSTERAI_API_BASE', LOBSTERAI.apiBase);
  const ver = await resolveLobsteraiVersion(LOBSTERAI);

  // 1) 活动槽位
  const q = new URLSearchParams({
    placement: SLOT_PLACEMENT, clientVersion: ver,
    containerApiVersion: SLOT_CONTAINER_API_VERSION, platform: SLOT_PLATFORM,
  });
  const slotRes = await getJson(`${api}${LOBSTERAI_SLOT_PATH}?${q}`, lobHeaders(acc, LOBSTERAI));
  // 403 常见于「clientVersion 不被接受」或「该账号无此活动」—— 光报状态码
  // 无法区分，把上游给的原因带上（截断，避免把整页 HTML 塞进日志）。
  if (!slotRes.ok) {
    const why = (() => {
      const b = slotRes.body;
      if (b && typeof b === 'object') return typeof b.msg === 'string' ? b.msg : (typeof b.message === 'string' ? b.message : '');
      return String(slotRes.text || '').replace(/\s+/g, ' ').trim();
    })();
    return out(false, `lobsterai 槽位查询 HTTP ${slotRes.status}（clientVersion=${ver}）${why ? ': ' + why.slice(0, 80) : ''}`);
  }
  const slotEnv = lobEnvelope(slotRes.body);
  if (!slotEnv.ok) return out(false, `lobsterai 槽位: ${slotEnv.message}`);
  const act = (slotEnv.data.activity && typeof slotEnv.data.activity === 'object') ? slotEnv.data.activity : {};
  const activityCode = typeof act.activityCode === 'string' ? act.activityCode : '';
  const slotState = typeof slotEnv.data.slotState === 'string' ? slotEnv.data.slotState : '';
  if (slotState !== 'available' || !activityCode)
    return out(true, `lobsterai 无可用活动（slotState=${slotState}）`, { claimed: false });
  const configRevision = num(act.configRevision);

  // 2) 活动上下文（今天领了没 / 有哪些动作）
  // ⚠️ 路径**必须带 `/context`**：`GET /api/client-activities/{code}/context`。
  // 2026-11-04 之前这里少拼了 `/context`，直接打成 `/{code}` → 上游 404，
  // 日志里天天是「lobsterai 上下文 HTTP 404」，签到一次没成过。
  // 权威实现见 OFM `lobsterai-credits.ts:205`（`${BASE}/{code}/context?configRevision=`）。
  const ctxQuery = new URLSearchParams({ configRevision: String(configRevision ?? '') });
  const ctxUrl = `${api}${LOBSTERAI_ACTIVITY_PATH}/${encodeURIComponent(activityCode)}/context?${ctxQuery}`;
  const ctxRes = await getJson(ctxUrl, lobHeaders(acc, LOBSTERAI));
  if (!ctxRes.ok) {
    const why = ctxRes.body && typeof ctxRes.body === 'object'
      ? String(ctxRes.body.msg || ctxRes.body.message || '')
      : String(ctxRes.text || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    return out(false, `lobsterai 上下文 HTTP ${ctxRes.status}${why ? ': ' + why.slice(0, 80) : ''}`);
  }
  const ctxEnv = lobEnvelope(ctxRes.body);
  if (!ctxEnv.ok) return out(false, `lobsterai 上下文: ${ctxEnv.message}`);
  const state = (ctxEnv.data.state && typeof ctxEnv.data.state === 'object') ? ctxEnv.data.state : {};
  if (state.claimedToday === true) return out(true, 'lobsterai 今天已签到', { claimed: false });
  const actions = Array.isArray(ctxEnv.data.actions) ? ctxEnv.data.actions : [];
  if (!actions.includes('check_in')) return out(true, 'lobsterai 当前不可签到', { claimed: false });

  // 3) 领取
  const claimUrl = `${api}${LOBSTERAI_ACTIVITY_PATH}/${encodeURIComponent(activityCode)}/actions/check_in`;
  const r = await fetch(claimUrl, {
    method: 'POST', headers: lobHeaders(acc, LOBSTERAI),
    body: JSON.stringify({ configRevision, idempotencyKey: randomUUID(), payload: {} }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = await r.json().catch(() => undefined);
  if (!r.ok) return out(false, `lobsterai 签到 HTTP ${r.status}`);
  const env = lobEnvelope(body);
  if (!env.ok) return out(false, `lobsterai 签到: ${env.message}`);
  const res = (env.data.result && typeof env.data.result === 'object') ? env.data.result : {};
  // 积分三级回退（对齐 sigin.py:65-66）：不同活动/版本字段名不同
  const credit = ['creditsGranted', 'rewardCredits', 'credits']
    .map(k => res[k]).find(v => typeof v === 'number' && Number.isFinite(v)) ?? 0;
  return out(true, `lobsterai 签到成功 +${credit} 分`, { claimed: true, credit });
}

// ──────────────────────────── Raccoon ────────────────────────────
/** 「登录信号」路径 —— web 端登录后即拉它，issue #430 实测打它就触发当日发放。 */
const RACCOON_SETTING_INFO_PATH = '/api/web/office/v3/setting_info';

/**
 * raccoon 的「登录」信号 = `GET /api/web/office/v3/setting_info`。
 *
 * ## 为什么它算签到（2026-11-06 实测）
 * 官方规则：每日 300 于 00:00 自动发放，但**当天未登录则当日 24:00 清零**，
 * 登录过 → 延长 7 天。推理/额度的纯 API 流量不算登录 —— 4 个号三天来
 * 「发一笔清一笔」（账单 daily_grant/daily_expire 成对、daily_points 恒 0）。
 * 打一发 setting_info 后 3 秒内 balance +300、账单落下当天 daily_grant（实测）。
 * 所以本函数**语义上是「代替人登录一次」**，天然幂等（重复打只是重复登录，
 * 官方规则④明说「当天多次登录不重复发放」），失败重试无害。
 *
 * ## 判据
 * - HTTP 200 + `code:0` 即算成功。上游不会因为「打了 setting_info」返回
 *   「今天发了多少」，**拿不到 credit 就不编造**（claimed=true 但 credit 缺省，
 *   面板日志只记「已登录领取」）；
 * - 401/403 → ok:false（token 死了，checkinTick 不记账，下 tick 重试，
 *   保活 cron 会顺手把 token 续上）。
 *
 * ⚠️ host 走 `RACCOON_CHECKIN_BASE` 而不是续期/额度那套 `RACCOON_API_BASE` ——
 * 独立变量有两个既成事实撑腰：① test-refresh-lock 把 `RACCOON_API_BASE` 指到
 * 它的**续期计数器**，chat 共用它都曾把 hits 1→6 误报成锁失效（§7.18 的教训），
 * 签到同理绝不能共用；② 不设该变量时请求打真实商汤 —— 所有带 raccoon 账号
 * 且会触发 checkinTick 的测试**必须显式设它**，否则就是拿真号打卡。
 *
 * ⚠️ 可用 `RACCOON_CHECKIN_ENABLED=0` 整体关闭（测试默认关掉 —— 有测试会真实
 * 触发 checkinTick，如 e2e-channels 的 /api/models/agg 走 lazyCheckin）。
 * 线上不设 = 开启。
 */
const checkinEnabled = () => String(process.env.RACCOON_CHECKIN_ENABLED ?? '1') !== '0';

async function raccoonCheckin(acc) {
  if (!checkinEnabled()) return out(true, 'raccoon 签到已关闭（RACCOON_CHECKIN_ENABLED=0）', { claimed: false, settled: true, disabled: true });
  const { RACCOON } = await products();
  const base = override('RACCOON_CHECKIN_BASE', RACCOON.apiBase);
  const r = await fetch(`${base}${RACCOON_SETTING_INFO_PATH}`, {
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${acc.access_token}`,
      'X-Org-Code': acc.office_identity || '',
      'X-Raccoon-Language': 'zh',
      // 官方发放按 web 登录语义走；带 desktop-* 反而依赖桌面端设备身份
      'X-Client-Platform': 'web',
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = await r.json().catch(() => undefined);
  if (!r.ok) return out(false, `raccoon 登录信号 HTTP ${r.status}`);
  const code = num(body && body.code);
  if (code !== 0) return out(false, `raccoon 登录信号 code=${code ?? '?'} ${(body && (body.message || body.msg)) || ''}`.trim());
  // credit 读得到就报（上游 data 里若有 points 类字段），读不到不编造
  const credit = num(body && body.data && body.data.daily_points);
  return out(true, 'raccoon 已登录（当日 300 发放/延期生效）', { claimed: true, settled: true, ...(credit !== undefined ? { credit } : {}) });
}

// ──────────────────────────── 调度 ────────────────────────────
const CHECKERS = { minimax: minimaxCheckin, lobsterai: lobsteraiCheckin, raccoon: raccoonCheckin };

/**
 * 渠道签到入口。
 *
 * @param {{provider:string, access_token:string}} acc
 * @returns {Promise<{ok:boolean, msg:string, claimed?:boolean, credit?:number}>}
 *         `ok:false` = 真失败（网络/信封/参数）；`ok:true` 且 `claimed:false`
 *         = 今天已领或不可领，**两者都要能区分**，cron 才不会每轮重试打 4xx。
 */
export async function chanCheckin(acc) {
  const fn = CHECKERS[acc && acc.provider];
  if (!fn) return out(false, `渠道 ${acc && acc.provider} 不支持签到（仅 ${CHECKINABLE.join('/')}）`);
  try {
    return await fn(acc);
  } catch (e) {
    return out(false, `${acc.provider} 签到失败: ${String(e.message || e).slice(0, 160)}`);
  }
}

/** 该渠道是否支持签到（UI 决定是否渲染按钮）。 */
export const supportsCheckin = provider => CHECKINABLE.includes(provider);
