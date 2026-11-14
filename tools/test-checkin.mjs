/**
 * 渠道签到测试（本地 mock，**绝不打真实上游** —— 与 OFM 插件共用凭据，
 * 谁先签谁把对方的幂等状态用掉）。
 *
 * 覆盖 OFM 源码里标注的坑：
 *   - minimax: `timezone_id` 必填；业务码在 `base_resp.status_code`（不是 code），
 *     且无效时区是 **HTTP 200**；`points` 是总数，不得加 bonus_points。
 *   - lobsterai: 三步（slot → context → check_in）；`claimedToday` 与
 *     `actions 含 check_in` 两道预检；积分三级回退。
 *   - 不支持的渠道（raccoon/cline）必须回 ok:false+原因，不许落到 WB 链路。
 */
// TS 解析钩子（vendor NodeNext 内部 `./x.js` 说明符 → 磁盘 `.ts`）。
// 必须在任何业务 import 之前注册，否则渠道协议模块报 ERR_MODULE_NOT_FOUND
// 且文案形似「缺文件」——2026-11-12 的 6 条红全因于此。生产由 index_turso.js
// 的 ensureTsHook() 兜底，测试入口必须自带。
import '../worker/backends/ts-hook.mjs';
import http from 'node:http';

const { chanCheckin, supportsCheckin, CHECKINABLE } = await import('../worker/chan-checkin.js');

let pass = 0, fail = 0;
const ok = (n, c, extra = '') => { c ? pass++ : fail++; console.log((c ? '✅ ' : '❌ ') + n + (extra ? '  ' + extra : '')); };
const acc = provider => ({ id: 'a1', provider, access_token: 'tok-' + provider });

// ── mock 上游 ──
// 每个 case 通过 routes 一次性配置，请求落在 log 里供断言（如"没发起 claim"）。
let routes = {}, log = [];
const srv = http.createServer((req, res) => {
  let body = '';
  req.on('data', d => body += d);
  req.on('end', () => {
    const path = req.url.split('?')[0];
    const key = `${req.method} ${path}`;
    log.push({ key, url: req.url, body });
    const h = routes[key];
    if (!h) { res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"code":404,"msg":"no route"}'); return; }
    res.writeHead(h.status ?? 200, { 'content-type': 'application/json' });
    res.end(typeof h.body === 'string' ? h.body : JSON.stringify(h.body));
  });
});
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const PORT = srv.address().port;
const BASE = `http://127.0.0.1:${PORT}`;
process.env.MINIMAX_API_HOST = BASE;
process.env.LOBSTERAI_API_BASE = BASE;
// lob 的 clientVersionApi 取自 vendor 常量（打不到就走 fallback，不阻塞）

const reset = () => { routes = {}; log = []; };
const claimCalls = () => log.filter(l => l.key.includes('signin/claim') || l.key.includes('check_in'));

// ── 1) minimax 正常签到 ──
// ⚠️ **字段名必须是 OFM 源码里的真名 `claim_result`**（1=真领取/2=已领过）。
// 我初版把它写成 `result`，结果代码与用例「同错」，19 条全绿而线上签到静默
// 不生效 —— 用户一句「minimax 和有道不是自动签到？」才暴露。用例的价值
// 在于复刻**上游真实形状**，不是复刻自己以为的形状。
reset();
routes['GET /minimax-cloud/api/v1/signin/status'] = { body: {
  base_resp: { status_code: 0, status_msg: '' },
  data: { scene: 1, days: [
    { day_no: 1, points: 800, bonus_points: 400, status: 3, is_today: false },
    { day_no: 2, points: 800, bonus_points: 0, status: 2, is_today: true },
  ] } } };
routes['POST /minimax-cloud/api/v1/signin/claim'] = { body: {
  base_resp: { status_code: 0, status_msg: '' }, data: { claim_result: 1, points: 800 } } };
{
  const r = await chanCheckin(acc('minimax'));
  ok('1a minimax 签到成功', r.ok === true && r.claimed === true, JSON.stringify(r));
  // ⚠️ points 总数 800，bonus 400 —— 相加会变 1200（OFM 明确禁止）
  ok('1b credit 取 points 总数(不加 bonus)', r.credit === 800, 'credit=' + r.credit);
  const claim = log.find(l => l.key.startsWith('POST') && l.key.includes('/signin/claim'));
  ok('1c claim 带 timezone_id', !!claim && /timezone_id=[^&]+/.test(claim.url), claim ? claim.url : '无');
  ok('1d claim body 是空对象', !!claim && claim.body === '{}', claim ? claim.body : '无');
}

// 1e) 幂等: claim_result=2(已领过) 必须判成功且 claimed=false，不能报失败
reset();
routes['GET /minimax-cloud/api/v1/signin/status'] = { body: {
  base_resp: { status_code: 0 },
  data: { scene: 1, days: [{ day_no: 1, points: 800, bonus_points: 0, status: 2, is_today: true }] } } };
routes['POST /minimax-cloud/api/v1/signin/claim'] = { body: {
  base_resp: { status_code: 0 }, data: { claim_result: 2 } } };
{
  const r = await chanCheckin(acc('minimax'));
  ok('1e claim_result=2 → 已签(不是失败)', r.ok === true && r.claimed === false && /已签到/.test(r.msg), JSON.stringify(r));
}

// 1f) claim 响应平铺(无 data 信封) 也要认 —— 两种形状都出现过
reset();
routes['GET /minimax-cloud/api/v1/signin/status'] = { body: {
  base_resp: { status_code: 0 }, scene: 1,
  days: [{ day_no: 1, points: 400, bonus_points: 0, status: 2, is_today: true }] } };
routes['POST /minimax-cloud/api/v1/signin/claim'] = { body: {
  base_resp: { status_code: 0 }, claim_result: 1, points: 400 } };
{
  const r = await chanCheckin(acc('minimax'));
  ok('1f 平铺 claim_result 也能签', r.ok === true && r.claimed === true && r.credit === 400, JSON.stringify(r));
}

// ── 1g) 【2026-11-04 线上真事故】换天前实测形状：`is_today` 指在昨天那条已领
// （`2:3*`、scene=2），面板没有 claimable。旧代码把「无可领取」判成功并写进
// checkinDay → 当天 08:00 后所有 tick/补签全被跳过，直到用户手动点才 +400。
// 现在两道防线：① 日界线门禁让它根本不在换天前发请求（见 index_turso.js）；
// ② 即便发出了，只要 `is_today` 不是 Claimed/`scene≠3` 就返回 settled:false。
reset();
routes['GET /minimax-cloud/api/v1/signin/status'] = { body: {
  base_resp: { status_code: 0, status_msg: '' },
  data: { scene: 2, days: [
    { day_no: 1, points: 400, bonus_points: 0, status: 3, is_today: false },
    { day_no: 2, points: 400, bonus_points: 0, status: 3, is_today: true },
    { day_no: 3, points: 400, bonus_points: 0, status: 1, is_today: false },
  ] } } };
{
  const r = await chanCheckin(acc('minimax'));
  // 注意: 本形状下 is_today 是 Claimed(3) 且 scene=2（真实上游客态），
  // 单看状态无法区分"未换天"与"今天真签完" —— 这正是必须靠门禁的理由。
  ok('1g1 该形状不判失败', r.ok === true, JSON.stringify(r));
  ok('1g2 未换天不发 claim', claimCalls().length === 0, 'claim 次数=' + claimCalls().length);
}

// ── 1h) 上游已换天、今天可领 → 正常领取
reset();
routes['GET /minimax-cloud/api/v1/signin/status'] = { body: {
  base_resp: { status_code: 0 },
  data: { scene: 2, days: [
    { day_no: 2, points: 400, bonus_points: 0, status: 3, is_today: false },
    { day_no: 3, points: 400, bonus_points: 0, status: 2, is_today: true },
  ] } } };
routes['POST /minimax-cloud/api/v1/signin/claim'] = { body: {
  base_resp: { status_code: 0 }, data: { claim_result: 1, points: 400 } } };
{
  const r = await chanCheckin(acc('minimax'));
  ok('1h1 换天后能签', r.ok === true && r.claimed === true && r.settled === true, JSON.stringify(r));
  ok('1h2 加 400 分', r.credit === 400, 'credit=' + r.credit);
}

// ── 2) minimax 今天已领 → 不发起 claim ──
reset();
routes['GET /minimax-cloud/api/v1/signin/status'] = { body: {
  base_resp: { status_code: 0, status_msg: '' },
  data: { scene: 3, days: [
    { day_no: 1, points: 800, bonus_points: 0, status: 3, is_today: true },
  ] } } };
{
  const r = await chanCheckin(acc('minimax'));
  ok('2a 已领返回 ok(不是失败)', r.ok === true, JSON.stringify(r));
  ok('2b claimed=false', r.claimed === false, 'claimed=' + r.claimed);
  ok('2c 未发起 claim 请求', claimCalls().length === 0, 'claim 次数=' + claimCalls().length);
  ok('2d 真签完要 settled=true(才可记账)', r.settled === true, 'settled=' + r.settled);
  ok('2e scene=3 认作已签', /完成|已签到/.test(r.msg), r.msg);
}

// ── 3) minimax 无效时区: HTTP 200 但 base_resp.status_code != 0 → 必须算失败 ──
reset();
routes['GET /minimax-cloud/api/v1/signin/status'] = { status: 200, body: {
  base_resp: { status_code: 100011, status_msg: 'invalid timezone_id' }, data: {} } };
{
  const r = await chanCheckin(acc('minimax'));
  ok('3a 无效时区(HTTP200)判为失败', r.ok === false, JSON.stringify(r));
  ok('3b 错误信息带原因', /timezone/i.test(r.msg || ''), r.msg);
}

// ── 4) lob 正常三步签到 ──
reset();
routes['GET /api/client-activities/slot'] = { body: {
  code: 0, data: { slotState: 'available', activity: { activityCode: 'daily_checkin', configRevision: 7 } } } };
routes['GET /api/client-activities/daily_checkin/context'] = { body: {
  code: 0, data: { state: { claimedToday: false }, actions: ['check_in'] } } };
routes['POST /api/client-activities/daily_checkin/actions/check_in'] = { body: {
  code: 0, data: { result: { creditsGranted: 300, message: 'ok' } } } };
{
  const r = await chanCheckin(acc('lobsterai'));
  ok('4a lob 签到成功', r.ok === true && r.claimed === true, JSON.stringify(r));
  ok('4b credit 取 creditsGranted', r.credit === 300, 'credit=' + r.credit);
  const ci = log.find(l => l.key.startsWith('POST') && l.key.includes('check_in'));
  ok('4c check_in 带 idempotencyKey', !!ci && (() => { try { return !!JSON.parse(ci.body).idempotencyKey; } catch { return false; } })(), ci ? ci.body.slice(0, 90) : '无');
}

// ── 5) lob 今天已领 → 不发起 check_in ──
reset();
routes['GET /api/client-activities/slot'] = { body: {
  code: 0, data: { slotState: 'available', activity: { activityCode: 'daily_checkin', configRevision: 7 } } } };
routes['GET /api/client-activities/daily_checkin/context'] = { body: {
  code: 0, data: { state: { claimedToday: true }, actions: [] } } };
{
  const r = await chanCheckin(acc('lobsterai'));
  ok('5a 已领返回 ok', r.ok === true, JSON.stringify(r));
  ok('5b 未发起 check_in', claimCalls().length === 0, '次数=' + claimCalls().length);
}

// ── 6) lob 有活动但 actions 不含 check_in → inactive(不是失败) ──
reset();
routes['GET /api/client-activities/slot'] = { body: {
  code: 0, data: { slotState: 'available', activity: { activityCode: 'daily_checkin', configRevision: 7 } } } };
routes['GET /api/client-activities/daily_checkin/context'] = { body: {
  code: 0, data: { state: { claimedToday: false }, actions: ['share'] } } };
{
  const r = await chanCheckin(acc('lobsterai'));
  ok('6a 不可签到返回 ok+原因', r.ok === true && /不可签到/.test(r.msg), JSON.stringify(r));
}

// ── 7) 不支持的渠道必须回 ok:false（不许落到 WB 链路） ──
{
  const r = await chanCheckin(acc('cline'));
  ok('7b cline 回 ok:false+原因', r.ok === false && /不支持签到/.test(r.msg), r.msg);
}

// ── 7e) raccoon「登录信号」签到（2026-11-06 实测端点）──
// 每日 300 按「当天是否登录过」定去留, 纯 API 流量不算登录 → 发一笔清一笔。
// 打 GET /api/web/office/v3/setting_info 等价于登录一次, 触发当日发放/延期。
reset();
process.env.RACCOON_CHECKIN_BASE = BASE;
routes['GET /api/web/office/v3/setting_info'] = { body: { code: 0, message: 'success', data: { used_space_mb: 0 } } };
{
  const r = await chanCheckin(acc('raccoon'));
  ok('7e1 raccoon 登录信号成功', r.ok === true && r.claimed === true && r.settled === true, JSON.stringify(r));
  const hit = log.find(l => l.key === 'GET /api/web/office/v3/setting_info');
  ok('7e2 打过 setting_info（走 RACCOON_CHECKIN_BASE）', !!hit, hit ? hit.url : '未发起');
}
// code!=0 是业务失败（形状对但被拒），必须 ok:false 且不记账, 下 tick 重试
reset();
routes['GET /api/web/office/v3/setting_info'] = { body: { code: 40102, message: 'unauthorized' } };
{
  const r = await chanCheckin(acc('raccoon'));
  ok('7e3 code!=0 判失败', r.ok === false && /40102/.test(r.msg), JSON.stringify(r));
}
// HTTP 层错误同样判失败
reset();
routes['GET /api/web/office/v3/setting_info'] = { status: 403, body: { code: 403, message: 'forbidden' } };
{
  const r = await chanCheckin(acc('raccoon'));
  ok('7e4 HTTP 403 判失败', r.ok === false && /HTTP 403/.test(r.msg), JSON.stringify(r));
}
// 可整体关闭（spawn 型测试用它挡住真实上游；关闭时返回成功避免刷失败日志）
reset();
process.env.RACCOON_CHECKIN_ENABLED = '0';
{
  const r = await chanCheckin(acc('raccoon'));
  ok('7e5 ENABLED=0 短路(不打下游)', r.ok === true && r.claimed === false && log.length === 0, JSON.stringify(r));
}
delete process.env.RACCOON_CHECKIN_ENABLED;

ok('7c CHECKINABLE 含 minimax/lobsterai/raccoon',
   JSON.stringify([...CHECKINABLE].sort()) === JSON.stringify(['lobsterai', 'minimax', 'raccoon']), JSON.stringify(CHECKINABLE));
ok('7d supportsCheckin 分派正确',
   supportsCheckin('minimax') && supportsCheckin('lobsterai') && supportsCheckin('raccoon') && !supportsCheckin('cline'), '');

srv.close();
console.log('\n=== PASS ' + pass + ' / FAIL ' + fail + ' ===');
process.exit(fail ? 1 : 0);
