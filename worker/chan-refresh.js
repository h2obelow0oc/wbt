/**
 * 渠道账号 token 续期（minimax / raccoon / cline / lobsterai）。
 *
 * ## 为什么单独一个文件
 * `wb_protocol.js` 的 `refreshToken()` 是 **WB 专属**（打 copilot.tencent.com，
 * 读 `X-Refresh-Token`），对渠道账号完全不适用。渠道各家协议不同，故平行实现。
 *
 * ## 协议事实来源
 * 全部照抄 OFM 插件 `vendor/channel-pack/src/*-oauth.ts` 的权威实现，
 * 未做任何"简化" —— 源码注释里标了坑的地方逐条对齐（见各函数注释）。
 *
 * ## 返回约定
 * 统一返回 `{access_token, refresh_token, expires_at}`，**`expires_at` 是秒**
 * （网关 `now()` / `parseAccountFile` 的 `normExpires` 都是秒）。
 * 注意 OFM 自己存的可能是毫秒字符串（如 minimax），这里一律归一成秒，
 * 否则 `expires_at < now() + 阈值` 的比较会静默失效。
 *
 * ## 终态 vs 可重试
 * 抛出的 Error 若含 `TERMINAL` 标记，表示 refresh_token 已死（需重新登录），
 * 调用方应记录并禁用账号，而不是无限重试。
 */
/**
 * vendor product 常量 —— **必须动态加载，不能写成静态 import**。
 *
 * 本文件被 `index_turso.js` 静态引入（line 19），而 ESM 是先解析**整个静态图**
 * 再求值：一旦这里写 `import ... from '.../raccoon-product.ts'`，`.ts` 就进了
 * 启动期依赖，Node 必须在进程起来的那一刻就能加载 TS。
 * `index_turso.js:15` 的注释正是为此而写 —— 「只静态导入纯 JS 的注册表，
 * 渠道模块走动态 import」。`backends/index.js` 守着同一条规矩。
 *
 * 实测后果: 违反后 Render **部署失败**（服务起不来），而本地 Node 24 能原生
 * 剥离类型，测试全绿 —— 典型的"本地过、线上崩"。
 *
 * 改成动态 import 后，`.ts` 只在**真正发起第一次续期**时才被解析，
 * 启动期静态图恢复为纯 JS。
 */
let _products = null;
export async function products() {
  if (!_products) {
    const [rc, cl, mm, lb] = await Promise.all([
      import('./vendor/channel-pack/src/raccoon-product.ts'),
      import('./vendor/channel-pack/src/cline-product.ts'),
      import('./vendor/channel-pack/src/minimax-product.ts'),
      import('./vendor/channel-pack/src/lobsterai-product.ts'),
    ]);
    _products = {
      RACCOON: rc.RACCOON,
      CLINE: cl.CLINE, CLINE_REFRESH_PATH: cl.CLINE_REFRESH_PATH,
      MINIMAX: mm.MINIMAX,
      LOBSTERAI: lb.LOBSTERAI,
    };
  }
  return _products;
}

/** 这两个路径所在文件 vendor 加载不了（lobsterai.ts 有参数属性 / minimax-oauth.ts 依赖 cordis），故内联。 */
const MINIMAX_TOKEN_PATH = '/oauth2/token';
const LOBSTERAI_REFRESH_PATH = '/api/auth/refresh';
// ⚠️ 同一 `worker/` 目录内的兄弟模块，路径必须是 `./`。
// 曾误写成 `../chan-checkin.js`（指向仓库根，不存在）→ 进程启动即
// `ERR_MODULE_NOT_FOUND`，整个服务起不来。ESM 允许这种环状引用
// （chan-checkin 也 import 本文件的 products/override），因为两边引用的
// 都是函数导出、求值时已提升。
import { resolveLobsteraiVersion } from './chan-checkin.js';

/**
 * 续期端点覆盖（仅用于测试/代理）。
 *
 * 默认取 vendor 常量，**不设任何环境变量时行为与改动前逐字节一致**。
 * 存在的理由: 4 家的续期端点写死在 vendor 常量里，测试无法把它们指向
 * 本地 mock —— 而"绝不打真实上游"是硬约束（与 OFM 插件共用 refresh_token，
 * 谁后刷新谁作废对方）。没有这个钩子，并发锁之类的集成行为就只能靠推断。
 */
/** 测试/预发用的环境变量覆盖 —— 导出给 chan-credits.js 复用，避免两份实现漂移。 */
export const override = (env, def) => process.env[env] || def;

const TIMEOUT_MS = 15000;
const nowSec = () => Math.floor(Date.now() / 1000);

/** 终态错误（refresh_token 已失效，需重新登录）。 */
class TokenExpired extends Error {
  constructor(msg) { super('TERMINAL: ' + msg); this.name = 'TokenExpired'; this.terminal = true; }
}

/** 从 JWT 取 exp（秒）；非 JWT 返回 undefined。 */
function jwtExpSec(token) {
  try {
    const part = String(token).split('.')[1];
    if (!part) return undefined;
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
    const json = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
    return typeof json.exp === 'number' ? json.exp : undefined;
  } catch { return undefined; }
}

/** 响应里的绝对过期时间（可能是毫秒），归一成秒。 */
function toSec(v) {
  const n = Number(v);
  if (!n || !isFinite(n)) return undefined;
  return n > 1e12 ? Math.floor(n / 1000) : Math.floor(n);
}

// ──────────────────────────── MiniMax ────────────────────────────
/**
 * `POST {accountHost}/oauth2/token`，**form-urlencoded**（不是 JSON）。
 *
 * 源码三个坑（minimax-oauth.ts）：
 *  1. 响应 `token_type` 必须是 Bearer，否则视为无效；
 *  2. 响应 `scope` 必须含 `agent.default` —— 不含即无效凭据；
 *  3. **过期以 `expires_in` 为准**：access_token 是 `mmoat_` 前缀的 60 字符
 *     不透明串，不是 JWT，从 token 里解不出 exp。
 */
async function refreshMinimax(acc) {
  const { MINIMAX } = await products();
  if (!acc.refresh_token) throw new TokenExpired('minimax 无 refresh_token');
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: acc.refresh_token,
    client_id: MINIMAX.clientId,
    scope: MINIMAX.scope,
    audience: MINIMAX.audience,
  });
  const r = await fetch(`${override('MINIMAX_ACCOUNT_HOST', MINIMAX.accountHost)}${MINIMAX_TOKEN_PATH}`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: String(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const b = await r.json().catch(() => undefined);
  if (!r.ok) {
    const err = (b && (b.error || b.message)) || `HTTP ${r.status}`;
    // 400 invalid_grant = refresh_token 已死
    if (r.status === 400 || r.status === 401) throw new TokenExpired(`minimax 续期失败: ${err}`);
    throw new Error(`minimax 续期失败: ${err}`);
  }
  if (!b || typeof b !== 'object') throw new Error('minimax 续期响应不是对象');
  if (!b.access_token) throw new TokenExpired('minimax 续期响应缺少 access_token');
  if (!b.refresh_token) throw new TokenExpired('minimax 续期响应缺少 refresh_token');
  if (String(b.token_type || '').toLowerCase() !== 'bearer')
    throw new TokenExpired(`minimax token_type 不是 Bearer: ${b.token_type}`);
  const sec = Number(b.expires_in);
  if (!(sec > 0)) throw new Error('minimax 续期响应缺少 expires_in');
  const scope = typeof b.scope === 'string' ? b.scope : '';
  if (!scope.split(/\s+/).filter(Boolean).includes(MINIMAX.scope))
    throw new TokenExpired(`minimax scope 不含 ${MINIMAX.scope}: "${scope}"`);
  return { access_token: b.access_token, refresh_token: b.refresh_token, expires_at: nowSec() + sec };
}

// ──────────────────────────── Raccoon ────────────────────────────
/**
 * `POST {apiBase}{authApiPrefix}/refresh`，JSON，body 只有 `{refresh_token}`。
 * **不带 Authorization 头** —— 凭据本身就躺在 body 里。
 *
 * 源码两个坑（raccoon-oauth.ts）：
 *  1. 信封 `code !== 0` 即失败；`code === 200003` 或 HTTP 401 = 登录态已过期（终态）；
 *  2. 过期时间**从新 access_token 的 JWT exp 解**，响应里不给 expires_at。
 */
async function refreshRaccoon(acc) {
  const { RACCOON } = await products();
  if (!acc.refresh_token) throw new TokenExpired('raccoon 无 refresh_token');
  const r = await fetch(`${override('RACCOON_API_BASE', RACCOON.apiBase)}${RACCOON.authApiPrefix}/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ refresh_token: acc.refresh_token }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const env = await r.json().catch(() => undefined);
  if (r.status === 401 || (env && env.code === 200003))
    throw new TokenExpired('raccoon: 登录态已过期，请重新登录');
  if (!env || env.code !== 0)
    throw new Error(`raccoon 续期失败: ${(env && (env.msg || env.message)) || 'HTTP ' + r.status}`);
  const at = env.data && env.data.access_token;
  if (typeof at !== 'string' || !at) throw new TokenExpired('raccoon 续期响应缺少 access_token');
  const rt = (env.data.refresh_token && String(env.data.refresh_token)) || acc.refresh_token;
  // 响应不带过期时间 → 从 JWT exp 解；解不出就保留旧值（宁可早刷新，不可写错）
  const exp = jwtExpSec(at);
  return { access_token: at, refresh_token: rt, expires_at: exp ?? acc.expires_at };
}

// ──────────────────────────── Cline ────────────────────────────
/**
 * `POST {apiBase}/api/v1/auth/refresh`，JSON + 产品 clientHeaders。
 *
 * 源码两个坑（cline.ts / cline-auth.ts）：
 *  1. body 是**驼峰** `{refreshToken, grantType}`，不是 snake_case 的
 *     `{refresh_token, machine_id}` —— 拼错上游不报错，只是续不上；
 *  2. 响应 `accessToken` 是裸 JWT，**存库时要补 `workos:` 前缀**
 *     （`applyClineRefresh` 走 `clineBearerValue`）。该函数是幂等的
 *     （`startsWith(tokenPrefix)` 判断），重复补不会变成 `workos:workos:`。
 * 过期时间响应给的是**毫秒**（`expire_time`），归一成秒。
 */
async function refreshCline(acc) {
  const { CLINE, CLINE_REFRESH_PATH } = await products();
  if (!acc.refresh_token) throw new TokenExpired('cline 无 refresh_token');
  const r = await fetch(`${override('CLINE_API_BASE', CLINE.apiBase)}${CLINE_REFRESH_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...CLINE.clientHeaders },
    body: JSON.stringify({ refreshToken: acc.refresh_token, grantType: 'refresh_token' }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const b = await r.json().catch(() => undefined);
  if (!r.ok) {
    const err = (b && (b.error || b.message || b.error_description)) || `HTTP ${r.status}`;
    if (r.status === 400 || r.status === 401 || r.status === 403) throw new TokenExpired(`cline 续期失败: ${err}`);
    throw new Error(`cline 续期失败: ${err}`);
  }
  if (!b || typeof b !== 'object') throw new Error('cline 续期响应不是对象');
  // ⚠️ 响应可能套 `{success, data}` 信封 —— OFM 的 parseClineTokenPayload 就是
  // 先解 data 再取字段（cline.ts:127）。只读顶层会把 200 误判成"缺少 accessToken",
  // 进而错杀账号(实测踩过: 账号被 TERMINAL 禁用)。
  const inner = (b.data && typeof b.data === 'object' && !Array.isArray(b.data)) ? b.data : b;
  if (!inner.accessToken && !inner.access_token) {
    // 把响应片段带进错误信息: 下次一眼看出真实结构, 不用再猜信封形态。
    const shape = Object.keys(b).join(',') || String(b).slice(0, 80);
    throw new Error(`cline 续期响应无 accessToken, 顶层键=[${shape}]`);
  }
  const atRaw = inner.accessToken || inner.access_token;
  const bearer = atRaw.startsWith(CLINE.tokenPrefix) ? atRaw : CLINE.tokenPrefix + atRaw;
  const out = { access_token: bearer, refresh_token: acc.refresh_token, expires_at: acc.expires_at };
  if (inner.refreshToken || inner.refresh_token) out.refresh_token = inner.refreshToken || inner.refresh_token;
  const exp = toSec(inner.expiresAt ?? inner.expires_at ?? inner.expire_time);
  if (exp) out.expires_at = exp;
  else {
    // 响应没给过期时间 → 从裸 JWT 解（前缀剥掉再解）
    const bare = atRaw.startsWith(CLINE.tokenPrefix) ? atRaw.slice(CLINE.tokenPrefix.length) : atRaw;
    const fromJwt = jwtExpSec(bare);
    if (fromJwt) out.expires_at = fromJwt;
  }
  if (!out.expires_at) throw new Error('cline 续期响应无法确定过期时间');
  return out;
}

// ──────────────────────────── LobsterAI ────────────────────────────
/**
 * `POST {apiBase}/api/auth/refresh`，JSON + 匿名三头。
 *
 * 源码三个坑（lobsterai.ts / lobsterai-auth.ts）：
 *  1. body = keyfrom 载荷 + `refreshToken`（驼峰）。keyfrom 两个字段必须用
 *     **凭据里存的原值**，不能取当前时刻 —— 对齐 Go `KeyfromBody()` 读
 *     `a.LatestKeyfrom` 而 `RefreshToken()` 从不更新它，即每次发的都是
 *     「登录时的那一刻」；
 *  2. `version` 走客户端版本号，**复用 chan-checkin 的 resolveLobsteraiVersion**（6h 缓存、打有道 update 接口），
 *     替代写死的 fallbackClientVersion，防止未来服务端开始校验版本；
 *  3. 响应可能**不返回新 refreshToken**（沿用旧的），不能覆盖成空串。
 * 过期：`expiresIn` 相对秒 → `now + n`；缺失时用 JWT exp 兜底。
 */
async function refreshLobsterai(acc) {
  const { LOBSTERAI } = await products();
  if (!acc.refresh_token) throw new TokenExpired('lobsterai 无 refresh_token');
  // 动态获取 clientVersion（6h 缓存），失败回退到兜底值
  const clientVersion = await resolveLobsteraiVersion(LOBSTERAI);
  const body = {
    firstKeyfrom: acc.first_keyfrom ?? '',
    latestKeyfrom: acc.latest_keyfrom ?? '',
    version: clientVersion,
    refreshToken: acc.refresh_token,
  };
  if (acc.uuid) body.uuid = acc.uuid;
  if (acc.user_id) body.userId = acc.user_id;
  const r = await fetch(`${override('LOBSTERAI_API_BASE', LOBSTERAI.apiBase)}${LOBSTERAI_REFRESH_PATH}`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': LOBSTERAI.userAgent },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const parsed = await r.json().catch(() => undefined);
  if (r.status === 401 || r.status === 403)
    throw new TokenExpired(`lobsterai 登录态已过期 (HTTP ${r.status})`);
  if (!parsed || typeof parsed !== 'object')
    throw new Error(`lobsterai 续期响应不是 JSON (HTTP ${r.status})`);
  // 信封: {code, message, data} —— code!==0 视为失败
  if (parsed.code !== undefined && parsed.code !== 0 && parsed.code !== 200)
    throw new Error(`lobsterai 续期失败: ${parsed.message || parsed.msg || 'code=' + parsed.code}`);
  const d = parsed.data && typeof parsed.data === 'object' ? parsed.data : parsed;
  const at = d.accessToken || d.access_token;
  if (!at) throw new TokenExpired('lobsterai 续期响应缺少 accessToken');
  const out = { access_token: at, refresh_token: acc.refresh_token, expires_at: acc.expires_at };
  const rt = d.refreshToken || d.refresh_token;
  if (rt) out.refresh_token = rt;   // 可能不返回新 refreshToken → 沿用旧的
  const sec = Number(d.expiresIn ?? d.expires_in);
  if (sec > 0) out.expires_at = nowSec() + sec;
  else {
    const fromJwt = jwtExpSec(at);
    if (fromJwt) out.expires_at = fromJwt;
  }
  if (!out.expires_at) throw new Error('lobsterai 续期响应无法确定过期时间');
  return out;
}

// ──────────────────────────── 调度 ────────────────────────────

const REFRESHERS = {
  minimax: refreshMinimax,
  raccoon: refreshRaccoon,
  cline: refreshCline,
  lobsterai: refreshLobsterai,
};

/**
 * 按账号 provider 续期。
 *
 * @param {object} acc 网关账号行（必须含 provider / refresh_token / expires_at）
 * @returns {Promise<{access_token:string, refresh_token:string, expires_at:number}>}
 * @throws 抛出的错误 message 若以 `TERMINAL:` 开头，表示 refresh_token 已死，
 *         调用方应记录并**禁用**该账号，不要重试。
 */
export async function chanRefresh(acc) {
  const provider = acc && acc.provider;
  const fn = REFRESHERS[provider];
  if (!fn) throw new Error(`不支持续期的渠道: ${provider}`);
  return await fn(acc);
}

/**
 * 是否终态错误（refresh_token 已死，需重新登录）。
 *
 * 两条判据取或: `.terminal` 属性是本模块 `TokenExpired` 自己打的标;
 * 消息前缀 `TERMINAL:` 是**跨模块契约** —— 调用方若把错误包了一层
 * (或日志转手又抛), 属性会丢, 前缀还在。两条都查, 宁可多禁用一个,
 * 也别让死号每轮 cron 都去打注定 401 的请求。
 */
export const isTerminal = e =>
  !!(e && (e.terminal || String(e.message || e).startsWith('TERMINAL:')));

/** 网关支持续期的渠道集合。 */
export const REFRESHABLE = Object.keys(REFRESHERS);
