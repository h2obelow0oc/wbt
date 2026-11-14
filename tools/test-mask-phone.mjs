// 手机号打码测试 (2026-11-04): parseAccountFile 入口改写 + GET /api/accounts 出口兜底
// 背景: wb 账号 nickname=完整手机号曾原样从 /api/accounts 泄出; 4 渠道在 OFM
// 导出侧已打码。修法=入口改写(库不进明文) + 出口兜底(存量昵称出面板前再打)。
import { spawn } from 'node:child_process';
import { startMock } from './mock-turso.mjs';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const ADMIN = 'test-admin-token';
const mock = await startMock(18981);
const seed = (sql, args) => fetch('https://127.0.0.1:18981/', { method: 'POST',
  headers: { 'content-type': 'application/json', 'x-turso-token': 'mock' },
  body: JSON.stringify({ requests: [{ type: 'execute', stmt: { sql, args } }] }) })
  .then(r => r.json());

await seed('INSERT INTO kv (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v = excluded.v',
  [{ type: 'text', value: 'idx_accounts' }, { type: 'text', value: '[]' }]);
await seed('INSERT INTO kv (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v = excluded.v',
  [{ type: 'text', value: 'idx_keys' }, { type: 'text', value: '[]' }]);

const gw = spawn('node', ['--import', './worker/backends/hook.mjs', 'worker/index_turso.js'],
  { cwd: process.cwd(), env: { ...process.env, TURSO_URL: '127.0.0.1:18981', TURSO_TOKEN: 'mock',
    PORT: '18982', ADMIN_TOKEN: ADMIN, CRON_INTERVAL_MS: '0', CHECKIN_TICK_MS: '0', RACCOON_CHECKIN_ENABLED: '0', NODE_TLS_REJECT_UNAUTHORIZED: '0' } });
let gwLog = ''; gw.stdout.on('data', d => gwLog += d); gw.stderr.on('data', d => gwLog += d);
for (let i = 0; i < 40; i++) { try { await fetch('http://127.0.0.1:18982/healthz'); break } catch { await new Promise(r => setTimeout(r, 250)) } }
await new Promise(r => setTimeout(r, 600));

let pass = 0, fail = 0;
const ok = (n, c, extra = '') => { c ? pass++ : fail++; console.log((c ? '✅' : '❌') + ' ' + n + (extra ? '  ' + extra : '')) };
const api = (path, payload) => fetch('http://127.0.0.1:18982/api/' + path, {
  method: payload ? 'POST' : 'GET',
  headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + ADMIN },
  body: payload ? JSON.stringify(payload) : undefined }).then(r => r.json());

// --- 1) 导入: wb 明文手机号 nickname 应被改写入库 ---
const r1 = await api('accounts/import', { json: JSON.stringify({ accounts: [
  { domain: 'www.codebuddy.cn', uid: 'u-plain', access_token: 't1', refresh_token: 'r1', nickname: '18154241890' },
  { domain: 'www.workbuddy.ai', uid: 'u-masked', access_token: 't2', refresh_token: 'r2', nickname: '139****1234' },
  { domain: 'www.codebuddy.cn', uid: 'u-email', access_token: 't3', refresh_token: 'r3', nickname: 'someone@example.com' },
  { domain: 'www.codebuddy.cn', uid: 'u-nonstd', access_token: 't4', refresh_token: 'r4', nickname: 'RaccoonNatalie (1890)' },
] }) });
ok('1a 导入 4 条 ok', r1.ok === true && r1.imported === 4, JSON.stringify({ ok: r1.ok, imported: r1.imported }));

const rows = JSON.parse((await seed('SELECT v FROM kv WHERE k = ?', [{ type: 'text', value: 'idx_accounts' }]))
  .results[0].response.result.rows[0][0].value);
const accs = [];
for (const id of rows) {
  const rr = JSON.parse((await seed('SELECT v FROM kv WHERE k = ?', [{ type: 'text', value: 'acc:' + id }]))
    .results[0].response.result.rows[0][0].value);
  accs.push(rr);
}
const byU = Object.fromEntries(accs.map(a => [a.uid, a]));
ok('1b 明文手机号入库已打码', byU['u-plain'] && byU['u-plain'].nickname === '181******90', '值=' + byU['u-plain']?.nickname);
// 只认「3 数字 + 星 + 2 数字」这一种既有约定(181******90); 139****1234 属于
// 另一种打码口径, 不去猜、原样保留 —— 猜错会把别人的展示串改坏。
ok('1c 其他打码口径原样保留', byU['u-masked'] && byU['u-masked'].nickname === '139****1234', '值=' + byU['u-masked']?.nickname);
ok('1d 邮箱昵称原样保留', byU['u-email'] && byU['u-email'].nickname === 'someone@example.com', '值=' + byU['u-email']?.nickname);
ok('1e 非标准串(用户名+括号)不动', byU['u-nonstd'] && byU['u-nonstd'].nickname === 'RaccoonNatalie (1890)', '值=' + byU['u-nonstd']?.nickname);

// --- 2) 同号重导仍幂等(打码后的 nickname 依旧命中去重键) ---
const r2 = await api('accounts/import', { json: JSON.stringify({ accounts: [
  { domain: 'www.codebuddy.cn', uid: 'u-plain', access_token: 't1-new', refresh_token: 'r1-new', nickname: '18154241890' },
] }) });
ok('2a 重导 updated=1 不新建', r2.ok === true && r2.updated === 1 && r2.created === 0, JSON.stringify({ updated: r2.updated, created: r2.created }));
const rows2 = JSON.parse((await seed('SELECT v FROM kv WHERE k = ?', [{ type: 'text', value: 'idx_accounts' }]))
  .results[0].response.result.rows[0][0].value);
ok('2b 账号总数不变(4)', rows2.length === 4, '实际=' + rows2.length);

// --- 3) 出口兜底: 手工 patch 进来的明文手机号, GET 时必须被打码 ---
const wbId = byU['u-plain'].id;
await api('accounts/patch', { id: wbId, nickname: '18912345678' });
const list = await api('accounts');
const got = (list.accounts || []).find(a => a.id === wbId);
ok('3a GET /api/accounts 兜底打码', got && got.nickname === '189******78', '值=' + got?.nickname);
// 库里保持 patch 的原值(展示层打码不回写, 去重键稳定)
const lib = JSON.parse((await seed('SELECT v FROM kv WHERE k = ?', [{ type: 'text', value: 'acc:' + wbId }]))
  .results[0].response.result.rows[0][0].value);
ok('3b 库存值不被展示层改写', lib.nickname === '18912345678', '值=' + lib.nickname);

// --- 4) 11 位但非 1 开头 / 含字母串 不动 ---
const r4 = await api('accounts/import', { json: JSON.stringify({ accounts: [
  { domain: 'www.codebuddy.cn', uid: 'u-edge1', access_token: 't5', refresh_token: 'r5', nickname: '98154241890' },
  { domain: 'www.codebuddy.cn', uid: 'u-edge2', access_token: 't6', refresh_token: 'r6', nickname: '1815424189a' },
] }) });
const rows4 = JSON.parse((await seed('SELECT v FROM kv WHERE k = ?', [{ type: 'text', value: 'idx_accounts' }]))
  .results[0].response.result.rows[0][0].value);
const accs4 = [];
for (const id of rows4) {
  const rr = JSON.parse((await seed('SELECT v FROM kv WHERE k = ?', [{ type: 'text', value: 'acc:' + id }]))
    .results[0].response.result.rows[0][0].value);
  accs4.push(rr);
}
const byU4 = Object.fromEntries(accs4.map(a => [a.uid, a]));
ok('4a 非 1 开头的 11 位数字不动', byU4['u-edge1']?.nickname === '98154241890', '值=' + byU4['u-edge1']?.nickname);
ok('4b 含字母的 11 位串不动', byU4['u-edge2']?.nickname === '1815424189a', '值=' + byU4['u-edge2']?.nickname);

gw.kill('SIGTERM');
console.log('\n=== PASS ' + pass + ' / FAIL ' + fail + ' ===');
if (fail) { console.log('--- GW LOG ---'); console.log(gwLog.slice(-1500)); }
process.exit(fail ? 1 : 0);
