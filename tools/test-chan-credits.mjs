/**
 * 渠道额度查询单测 —— 用本地 http 服务 mock 上游，四个 base 全走 override()。
 *
 * 重点验三件容易出错的事：
 *  1. cline 必须带 `Bearer workos:` 前缀（丢了上游 401）
 *  2. minimax 是**平铺**响应（无 data 信封），且余额是 details 求和
 *  3. 形状变了必须报错，**绝不能返回 0** —— 返回 0 会被面板读成"额度用尽"
 */
import http from 'node:http';
import assert from 'node:assert';
await import('../worker/backends/ts-hook.mjs');
const { chanCredits } = await import('../worker/chan-credits.js');

let pass = 0, fail = 0;
const ok = (c, name, extra = '') => { c ? (pass++, console.log(`  ✅ ${name}`)) : (fail++, console.log(`  ❌ ${name} ${extra}`)); };

// ── mock 上游 ─────────────────────────────────────────────
const seen = {};           // 记录收到的请求，供断言鉴权头
let responder = null;      // 每个用例换一次响应
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    seen[req.url] = { method: req.method, headers: req.headers };
    const body = responder ? responder(req) : {};
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  });
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;
process.env.RACCOON_API_BASE = BASE;
process.env.MINIMAX_API_HOST = BASE;
process.env.CLINE_API_BASE = BASE;
process.env.LOBSTERAI_API_BASE = BASE;

const AT = 'tok-for-test';
// 线上 cline 的 access_token **存储时就带** workos: 前缀(buildClineCredential 已归一)
const CLINE_AT = 'workos:eyJhbGciOiJIUzI1NiJ9.test-payload';

console.log('════ raccoon ════');
responder = () => ({ code: 0, data: { available_points: 3000, reward_points: 500, daily_points: 100, topup_points: 2400 } });
let r = await chanCredits({ provider: 'raccoon', access_token: AT });
ok(r.ok && r.credits === 3000, 'available_points 取值', JSON.stringify(r));
ok(r.packages?.length === 3, '分项包 3 个（每日<0 不计？）', JSON.stringify(r.packages));
ok(seen['/api/web/points/v1/balance']?.headers?.authorization === `Bearer ${AT}`,
   'Authorization: Bearer 头', JSON.stringify(seen['/api/web/points/v1/balance']?.headers));
ok(seen['/api/web/points/v1/balance']?.headers?.['x-raccoon-language'] === 'zh', 'X-Raccoon-Language 头');

// 形状坏了 → 报错而非 0
responder = () => ({ code: 0, data: { foo: 1 } });
r = await chanCredits({ provider: 'raccoon', access_token: AT });
ok(r.ok === false && /available_points/.test(r.msg), '缺 available_points → 报错不返回 0', JSON.stringify(r));

console.log('════ minimax ════');
// ⚠️ **实测原始形状**（OFM 源码 minimax-credits.ts 记录的真实响应）：
//   {"details":[{"remaining_amount":"800.00","granted_amount":"800.00",...}],
//    "total_count":1,"base_resp":{"status_code":0,"status_msg":"ok"}}
// remaining_amount 是**字符串**！只认 number 会让求和恒为 0 ——
// 这正是用户报「minimax 额度不显示」的根因，与签到无关。
responder = () => ({ base_resp: { status_code: 0, status_msg: 'ok' }, total_count: 1,
  details: [{ remaining_amount: '400.00', consumed_amount: '0.00', granted_amount: '400.00', credit_type: 2 }] });
r = await chanCredits({ provider: 'minimax', access_token: AT });
ok(r.ok && r.credits === 400, '字符串 "400.00" 能读出 400', JSON.stringify(r));

// 多个包，字符串相加
responder = () => ({ base_resp: { status_code: 0 }, total_count: 2,
  details: [{ remaining_amount: '12.50' }, { remaining_amount: '7.50' }] });
r = await chanCredits({ provider: 'minimax', access_token: AT });
ok(r.ok && r.credits === 20, '字符串求和 12.50+7.50 = 20', JSON.stringify(r));

// 平铺响应: details 与 base_resp 同级, 无 data（数字型也照旧支持）
responder = () => ({ base_resp: { status_code: 0 }, total_count: 2,
  details: [{ remaining_amount: 12.5 }, { remaining_amount: 7.5 }] });
r = await chanCredits({ provider: 'minimax', access_token: AT });
ok(r.ok && r.credits === 20, '平铺 details 求和 = 20', JSON.stringify(r));
ok(seen['/minimax-cloud/api/v1/credit/details']?.headers?.authorization === `Bearer ${AT}`, 'minimax Bearer 头');

responder = () => ({ base_resp: { status_code: 0 } });
r = await chanCredits({ provider: 'minimax', access_token: AT });
ok(r.ok === false, '缺 details/total_count → 报错', JSON.stringify(r));

// ⚠️ 嵌套 data 形状 —— 用户报「minimax 额度不显示」的真实形态。
// 端点文档说平铺，但两种都必须认（OFM 用 unwrapEnvelopeData 兼容）。
// 原实现直读 body.details，遇到这种形状就报错 → 额度永远显示不出来，
// 与签到无关（签到只改变额度数值，不影响查询）。
responder = () => ({ base_resp: { status_code: 0 },
  data: { total_count: 400, details: [{ remaining_amount: 400 }] } });
r = await chanCredits({ provider: 'minimax', access_token: AT });
ok(r.ok && r.credits === 400, '嵌套 data 形状也能查到 400', JSON.stringify(r));

// 嵌套 data 但 details 为空 → 余额 **0**（真的为 0），
// ⚠️ 不许拿 total_count 当回退：它是 details[] 的记录条数，不是余额
//    （OFM 源码记过这个误读：领取 800 分后 remaining_amount=800 而 total_count 仍是 1）。
responder = () => ({ base_resp: { status_code: 0 }, data: { total_count: 1, details: [] } });
r = await chanCredits({ provider: 'minimax', access_token: AT });
ok(r.ok && r.credits === 0, 'details 空 → 余额真 0（不用 total_count 顶替）', JSON.stringify(r));

// 形状完全不认识 → 报错且**带顶层键名**（排障靠它，不然只能瞎猜）
responder = () => ({ base_resp: { status_code: 0 }, foo: 1, bar: 2 });
r = await chanCredits({ provider: 'minimax', access_token: AT });
ok(r.ok === false && /foo/.test(r.msg), '形状不认识 → 报错并带键名', JSON.stringify(r));

responder = () => ({ base_resp: { status_code: 2004, status_msg: 'quota' } });
r = await chanCredits({ provider: 'minimax', access_token: AT });
ok(r.ok === false && /2004/.test(r.msg), 'base_resp 非 0 → 报错', JSON.stringify(r));

console.log('════ cline ════');
responder = () => ({ success: true, data: { userId: 'usr-1', balance: 500000 } });
r = await chanCredits({ provider: 'cline', access_token: CLINE_AT, account_id: 'usr-1' });
ok(r.ok && r.credits === 5, 'balance 500000 ÷1e5 = 5', JSON.stringify(r));
const ch = seen['/api/v1/users/usr-1/balance']?.headers;
ok(ch?.authorization === `Bearer ${CLINE_AT}`, '原样透传(存储值已含 workos:)', JSON.stringify(ch?.authorization));
ok(!/workos:\s*workos:|workos:workos:/.test(String(ch?.authorization)), '绝不允许双 workos: 前缀', JSON.stringify(ch?.authorization));
ok(String(ch?.['http-referer']) === 'https://cline.bot' && String(ch?.['x-title']) === 'Cline',
   '带 product.clientHeaders', JSON.stringify({ref: ch?.['http-referer'], t: ch?.['x-title']}));

r = await chanCredits({ provider: 'cline', access_token: CLINE_AT });
ok(r.ok === false && /account_id/.test(r.msg), '缺 account_id → 报错', JSON.stringify(r));

responder = () => ({ success: true, data: {} });
r = await chanCredits({ provider: 'cline', access_token: CLINE_AT, account_id: 'usr-1' });
ok(r.ok === false, '缺 balance → 报错', JSON.stringify(r));

console.log('════ lobsterai ════');
responder = () => ({ data: { creditItems: [
  { label: '每日登录奖励', creditsRemaining: 100.5, expiresAt: '2026-11-05T00:00:00' },
  { type: 'campaign', creditsRemaining: 50 } ] } });
r = await chanCredits({ provider: 'lobsterai', access_token: AT });
ok(r.ok && r.credits === 150.5, 'creditItems 求和 = 150.5', JSON.stringify(r));
ok(r.packages?.[0]?.name === '每日登录奖励', '包名取 label 而非 type', JSON.stringify(r.packages));
ok(seen['/api/user/profile-summary']?.headers?.authorization === `Bearer ${AT}`, 'lobsterai Bearer 头');

responder = () => ({ data: { creditItems: [{ label: 'x' }] } });
r = await chanCredits({ provider: 'lobsterai', access_token: AT });
ok(r.ok === false && /creditsRemaining/.test(r.msg), '读不到数字 → 报错不返回 0', JSON.stringify(r));

responder = () => ({ data: { other: 1 } });
r = await chanCredits({ provider: 'lobsterai', access_token: AT });
ok(r.ok === false, '缺 creditItems → 报错', JSON.stringify(r));

console.log('════ 兜底 ════');
r = await chanCredits({ provider: 'trae', access_token: AT });
ok(r.ok === false && /暂不支持/.test(r.msg), '未知渠道 → 明确拒绝', JSON.stringify(r));
r = await chanCredits({ provider: 'minimax', access_token: AT, access_token: undefined, provider: 'minimax' });
ok(typeof r.ok === 'boolean', '任何入参都不抛异常', JSON.stringify(r));

server.close();
console.log(`\n渠道额度: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
