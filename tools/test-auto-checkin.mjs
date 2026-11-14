// 「自动签到」勾选测试：路由存在性、数字 1/0 落库、导入保留、与 enabled 两维度。
// 骨架照抄 test-import.mjs（mock turso + 起真实 index_turso.js）。
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { startMock } from './mock-turso.mjs';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const ADMIN = 'test-admin-token';
const mock = await startMock(18961);
const seed = (sql, args) => fetch('https://127.0.0.1:18961/', { method: 'POST',
  headers: { 'content-type': 'application/json', 'x-turso-token': 'mock' },
  body: JSON.stringify({ requests: [{ type: 'execute', stmt: { sql, args } }] }) })
  .then(r => r.json());
await seed('INSERT INTO kv (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v = excluded.v',
  [{ type: 'text', value: 'idx_keys' }, { type: 'text', value: JSON.stringify([]) }]);

const gw = spawn('node', ['--import', './worker/backends/hook.mjs', 'worker/index_turso.js'],
  { cwd: process.cwd(), env: { ...process.env, TURSO_URL: '127.0.0.1:18961', TURSO_TOKEN: 'mock',
    PORT: '18962', ADMIN_TOKEN: ADMIN, CRON_INTERVAL_MS: '0', CHECKIN_TICK_MS: '0',
    RACCOON_CHECKIN_ENABLED: '0', NODE_TLS_REJECT_UNAUTHORIZED: '0' } });
let gwLog = ''; gw.stdout.on('data', d => gwLog += d); gw.stderr.on('data', d => gwLog += d);
for (let i = 0; i < 40; i++) { try { await fetch('http://127.0.0.1:18962/healthz'); break } catch { await new Promise(r => setTimeout(r, 250)) } }
await new Promise(r => setTimeout(r, 600));

let pass = 0, fail = 0;
const ok = (n, c, extra = '') => { c ? pass++ : fail++; console.log((c ? '✅' : '❌') + ' ' + n + (extra ? '  ' + extra : '')) };
const api = async (path, body) => (await fetch('http://127.0.0.1:18962/api/' + path, {
  method: 'POST', headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + ADMIN },
  body: JSON.stringify(body) })).json();

const file = fs.readFileSync(new URL('./fixtures/export-4ch.json', import.meta.url), 'utf8');
const r1 = await api('accounts/import', { json: file });
ok('0a 导入成功', r1.ok === true, JSON.stringify({ imported: r1.imported }));

const ids = JSON.parse((await seed('SELECT v FROM kv WHERE k = ?', [{ type: 'text', value: 'idx_accounts' }]))
  .results[0].response.result.rows[0][0].value);
const accs = [];
for (const id of ids) accs.push(JSON.parse((await seed('SELECT v FROM kv WHERE k = ?', [{ type: 'text', value: 'acc:' + id }]))
  .results[0].response.result.rows[0][0].value));
const mm = accs.find(a => a.provider === 'minimax');
ok('0b 有 minimax 号', !!mm);

// 1) 新导入号默认视为勾选（老数据无字段 → tick 判 ===0，undefined 即勾选）
ok('1a 导入后无 auto_checkin 字段（缺省=勾选语义由 tick 判 ===0 保证）', mm.auto_checkin === undefined);

// 2) PATCH 关掉 → 落库数字 0
const r2 = await api('accounts/auto-checkin', { id: mm.id, auto: false });
ok('2a 路由存在且 ok', r2.ok === true, JSON.stringify(r2).slice(0, 80));
const mm2 = JSON.parse((await seed('SELECT v FROM kv WHERE k = ?', [{ type: 'text', value: 'acc:' + mm.id }]))
  .results[0].response.result.rows[0][0].value);
ok('2b 落库为数字 0（不是 "0" / false）', mm2.auto_checkin === 0, '实际=' + JSON.stringify(mm2.auto_checkin));

// 3) 重新导入 → 手工取消的勾选必须保留（幂等）
const r3 = await api('accounts/import', { json: file });
const mm3 = JSON.parse((await seed('SELECT v FROM kv WHERE k = ?', [{ type: 'text', value: 'acc:' + mm.id }]))
  .results[0].response.result.rows[0][0].value);
ok('3a 重导入是更新而非新建', r3.updated >= 1, JSON.stringify({ u: r3.updated, c: r3.created }));
ok('3b 重导入后勾选仍是 0（手工取消不被悄悄勾回）', mm3.auto_checkin === 0, '实际=' + JSON.stringify(mm3.auto_checkin));

// 4) 勾回来 → 数字 1；enabled 不受牵连（两维度独立）
await api('accounts/auto-checkin', { id: mm.id, auto: true });
const mm4 = JSON.parse((await seed('SELECT v FROM kv WHERE k = ?', [{ type: 'text', value: 'acc:' + mm.id }]))
  .results[0].response.result.rows[0][0].value);
ok('4a 勾回=数字 1', mm4.auto_checkin === 1);
ok('4b enabled 未被牵连（仍 1）', mm4.enabled === 1);

// 5) 启用 + 取消自动签 可共存
await api('accounts/auto-checkin', { id: mm.id, auto: false });
await api('accounts/enable', { id: mm.id, enabled: true });
const mm5 = JSON.parse((await seed('SELECT v FROM kv WHERE k = ?', [{ type: 'text', value: 'acc:' + mm.id }]))
  .results[0].response.result.rows[0][0].value);
ok('5a 启用+取消自动签 可共存', mm5.enabled === 1 && mm5.auto_checkin === 0);

gw.kill("SIGTERM"); mock.close();
console.log(`\n${fail === 0 ? '✅' : '❌'} 自动签到勾选 — ${pass} 通过 / ${fail} 失败`);
if (fail) { console.log(gwLog.slice(-800)); process.exit(1) }
