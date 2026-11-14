/**
 * 渠道额度查询 —— 移植 OFM `channel-pack/src/{raccoon,minimax,cline,lobsterai}-credits.ts`。
 *
 * 与续期同一条铁律：**形状不对就报错，绝不编造 0**。上游把字段改名时，
 * 返回 0 会让面板显示"额度用尽"，比报错危险得多（OFM 源码里三处
 * `不编造数字/不编造 0` 的注释都是这个教训）。
 *
 * 所有 host 走 `override()`，测试可换成本地 mock —— 与 chan-refresh.js 共用同一份实现，
 * 故 products()/override() 从那边 export 而非各写一份（两份会漂移）。
 */
import { products, override } from './chan-refresh.js';

const TIMEOUT_MS = 15000;

/** 与 chan-refresh.js 同款内联路径：这些常量所在文件 vendor 侧加载不了。 */
const RACCOON_POINTS_PREFIX = '/api/web/points/v1';   // raccoon-credits.ts
const MINIMAX_CREDIT_DETAILS_PATH = '/minimax-cloud/api/v1/credit/details';  // minimax-product.ts:198
const LOBSTERAI_PROFILE_SUMMARY_PATH = '/api/user/profile-summary';          // lobsterai-credits.ts:40
const CLINE_BALANCE_SCALE = 100_000;  // cline-credits.ts:74 —— 1e-5 USD → 元

async function getJson(url, headers) {
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  const b = await r.json().catch(() => undefined);
  return { ok: r.ok, status: r.status, body: b };
}
const num = v => (typeof v === 'number' && Number.isFinite(v)) ? v : undefined;
/**
 * 取对象里第一个能读成数的键；读不到返回 undefined（不猜）。
 *
 * ⚠️ **必须同时接受字符串** —— 这不是洁癖：minimax 的 `remaining_amount`
 * 实测就是 `"800.00"`（字符串，OFM 源码 `minimax-credits.ts` 明确记录）。
 * 原实现 `num` 只认 `typeof === 'number'`，于是每个包都被读成 undefined、
 * 求和恒为 0 —— 用户报「minimax 额度不显示」的**真正根因**。
 * 这与签到毫无关系：签到只改变额度数值，不影响查询能否读到。
 */
function toNum(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  // `Number('') === 0` —— 空串会被误读成「0 额度」，先挡掉
  if (t === '') return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
}
const readNum = (o, ...keys) => {
  if (!o || typeof o !== 'object') return undefined;
  for (const k of keys) { const n = toNum(o[k]); if (n !== undefined) return n; }
  return undefined;
};
/** 信封兼容：`{data:{...}}` 与平铺 `{...}` 两种都吃（minimax 是平铺的）。 */
const unwrap = b => (b && typeof b === 'object' && b.data !== undefined && typeof b.data === 'object'
  && !Array.isArray(b.data)) ? b.data : b;

// ──────────────────────────── Raccoon ────────────────────────────
/**
 * `GET {apiBase}/api/web/points/v1/balance`，`Authorization: Bearer`。
 * 语义在 OFM：各池分开列（每日/充值有效期不同），但对外只需 total。
 */
async function raccoonCredits(acc) {
  const { RACCOON } = await products();
  const { ok, status, body } = await getJson(
    `${override('RACCOON_API_BASE', RACCOON.apiBase)}${RACCOON_POINTS_PREFIX}/balance`,
    {
      Accept: 'application/json', 'Content-Type': 'application/json',
      Authorization: `Bearer ${acc.access_token}`,
      'X-Org-Code': acc.office_identity || '',   // 个人账号为空串，但客户端总是发
      'X-Raccoon-Language': 'zh',
    });
  if (!ok) return { ok: false, msg: `raccoon 额度 HTTP ${status}` };
  const d = unwrap(body);
  const available = readNum(d, 'available_points', 'availablePoints');
  // available_points 是核心字段 —— 没它说明形状变了，报错而不是返回 0
  if (available === undefined) return { ok: false, msg: 'raccoon 响应缺 available_points' };
  const packages = [];
  const push = (name, v) => { if (v !== undefined && v > 0) packages.push({ name, remaining: v }); };
  push('奖励积分', readNum(d, 'reward_points'));
  push('每日积分', readNum(d, 'daily_points'));
  push('会员积分', readNum(d, 'monthly_points'));
  push('充值积分', readNum(d, 'topup_points'));
  return { ok: true, credits: available, packages: packages.length ? packages : undefined };
}

// ──────────────────────────── MiniMax ────────────────────────────
/**
 * `GET {apiHost}/minimax-cloud/api/v1/credit/details`（注意是 **apiHost** =
 * agent.minimax.cn，不是续期用的 accountHost）。
 * 余额 = 各包 `remaining_amount` 之和。
 *
 * ⚠️ **形状必须走 `unwrap`**（= OFM 的 `unwrapEnvelopeData`）：该端点文档说是
 * 平铺（`details`/`total_count` 与 `base_resp` 同级、没有 `data`），但**两种形状
 * 都要认**。原先这里直接读 `body.details`，一旦上游把数据放进 `data`，就会
 * 走进「缺 details/total_count」分支或算出 0 —— 用户报的「额度不显示」正是它：
 * **额度值与签到无关**，签到只是额度变化的原因，查得到查不到跟签到没关系。
 */
async function minimaxCredits(acc) {
  const { MINIMAX } = await products();
  const { ok, status, body } = await getJson(
    `${override('MINIMAX_API_HOST', MINIMAX.apiHost)}${MINIMAX_CREDIT_DETAILS_PATH}`,
    { Authorization: `Bearer ${acc.access_token}`, Accept: 'application/json' });
  if (!ok) return { ok: false, msg: `minimax 额度 HTTP ${status}` };
  // base_resp.status_code 非 0 也算失败（OFM 由 requestEnvelope 判，这里等价处理）
  const br = body && body.base_resp;
  if (br && Number(br.status_code) !== 0) return { ok: false, msg: `minimax base_resp ${br.status_code}:${br.status_msg || ''}` };
  const d = unwrap(body);
  const details = Array.isArray(d.details) ? d.details : undefined;
  // ⚠️ `total_count` 是 `details[]` 的**记录条数**，**不是余额** —— OFM 源码
  // 专门记录过这个误读（生产数据推翻：领取 800 分后 `remaining_amount:"800.00"`
  // 而 `total_count` 仍是 1）。所以**绝不能**拿它当额度回退。
  // 这里只把它当作「形状是否认识」的第二判据。
  const tc = readNum(d, 'total_count');
  if (details === undefined && tc === undefined) {
    // 形状不认识 —— 报错（并带上真实键名），绝不编造 0。
    // 键名是排障的关键：没有它只能瞎猜上游改成了什么形状。
    const keys = (body && typeof body === 'object') ? Object.keys(body).slice(0, 8).join(',') : typeof body;
    return { ok: false, msg: `minimax 响应缺 details/total_count（顶层键: ${keys}）` };
  }
  // `details` 缺失/非数组 ⇒ 空数组 ⇒ 余额 **0**（「真的为 0」），不是查询失败
  // （OFM 源码同款口径：只有 null 才是失败）。
  let total = 0;
  for (const e of details || []) {
    const n = readNum(e, 'remaining_amount');
    if (n !== undefined) total += n;
  }
  return { ok: true, credits: Math.round(total * 100) / 100, packages: undefined };
}

// ──────────────────────────── Cline ────────────────────────────
/**
 * `GET {apiBase}/api/v1/users/{account_id}/balance`
 * ⚠️ `Authorization: Bearer workos:<jwt>` —— 但**存储值本身已带 `workos:` 前缀**
 *    （`buildClineCredential` 里 `clineBearerValue` 归一过），必须**原样用**；
 *    再拼一次会变成 `workos:workos:…` → 上游 401（本文件初版就踩了）。
 * ⚠️ userId 用凭据里的 `account_id`，**不是 JWT 的 sub**
 * ⚠️ 还要展开 `product.clientHeaders`（HTTP-Referer / X-Title / X-IS-MULTIROOT）
 * 响应 `{data:{userId, balance}}`；balance 是 1e-5 USD 单位。
 */
async function clineCredits(acc) {
  const { CLINE } = await products();
  const userId = acc.account_id;
  if (!userId || !String(userId).trim()) return { ok: false, msg: 'cline 缺 account_id（需重新导入）' };
  const { ok, status, body } = await getJson(
    `${override('CLINE_API_BASE', CLINE.apiBase)}/api/v1/users/${encodeURIComponent(String(userId).trim())}/balance`,
    {
      Authorization: `Bearer ${acc.access_token}`,   // 已含 workos:，绝不再拼
      Accept: 'application/json',
      ...CLINE.clientHeaders,
    });
  if (!ok) return { ok: false, msg: `cline 额度 HTTP ${status}` };
  const d = unwrap(body);
  const raw = readNum(d, 'balance');
  if (raw === undefined) return { ok: false, msg: 'cline 响应缺 balance' };
  // 原值 500000 = $5.00；面板口径统一为「元量级」，除以 1e-5 单位
  return { ok: true, credits: Math.round(raw / CLINE_BALANCE_SCALE * 100) / 100 };
}

// ──────────────────────────── LobsterAI ────────────────────────────
/**
 * `GET {apiBase}/api/user/profile-summary` —— 用 profile-summary 而非 quota
 * （源码 client.go:282-283 注释；实测某账号 summary 有 5297.72，quota 只有 300）。
 * 余额 = `data.creditItems[].creditsRemaining` 之和。
 */
async function lobsteraiCredits(acc) {
  const { LOBSTERAI } = await products();
  const { ok, status, body } = await getJson(
    `${override('LOBSTERAI_API_BASE', LOBSTERAI.apiBase)}${LOBSTERAI_PROFILE_SUMMARY_PATH}`,
    {
      Authorization: `Bearer ${acc.access_token}`, Accept: 'application/json',
      'Content-Type': 'application/json', 'User-Agent': LOBSTERAI.userAgent,
    });
  if (!ok) return { ok: false, msg: `lobsterai 额度 HTTP ${status}` };
  const d = unwrap(body);
  const items = d && Array.isArray(d.creditItems) ? d.creditItems : undefined;
  if (items === undefined) return { ok: false, msg: 'lobsterai 响应缺 creditItems' };
  const packages = [];
  let total = 0;
  for (const it of items) {
    const rem = readNum(it, 'creditsRemaining');
    if (rem === undefined) continue;
    total += rem;
    const label = typeof it.label === 'string' && it.label ? it.label
      : (typeof it.type === 'string' && it.type ? it.type : '积分包');
    packages.push({ name: label, remaining: rem, expiresAt: typeof it.expiresAt === 'string' ? it.expiresAt : '' });
  }
  // creditItems 存在但一个数都读不出来 ⇒ 形状变了，别报 0
  if (!packages.length) return { ok: false, msg: 'lobsterai creditItems 里读不到 creditsRemaining' };
  return { ok: true, credits: Math.round(total * 100) / 100, packages: packages.length ? packages : undefined };
}

const FETCHERS = {
  raccoon: raccoonCredits,
  minimax: minimaxCredits,
  cline: clineCredits,
  lobsterai: lobsteraiCredits,
};

/**
 * 渠道额度查询入口。查不到返回 `{ok:false,msg}` —— 调用方据此显示原因，不写 0。
 * @param {{provider:string, access_token:string, account_id?:string, office_identity?:string}} acc
 */
export async function chanCredits(acc) {
  const fn = FETCHERS[acc.provider];
  if (!fn) return { ok: false, msg: `渠道 ${acc.provider} 暂不支持额度查询` };
  try {
    return await fn(acc);
  } catch (e) {
    return { ok: false, msg: `${acc.provider} 额度查询失败: ${String(e.message || e).slice(0, 120)}` };
  }
}
