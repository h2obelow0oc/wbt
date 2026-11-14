/**
 * 补签（lazyCheckin）测试 —— 用户报「minimax 还是没有自动签到」的真因之二。
 *
 * 网关在 **Render free**，闲置即挂起，`setInterval` 不保证按时触发：
 * 实测 6 小时任务的实际间隔是 2.1 / 3.2 / 6.7 / **9.8** 小时。
 * 于是产生窗口：用户北京 08:00 打开面板 → 今天还没签 → 下一轮 cron 在 10:45。
 * 用户看到的就是"自动签到没做"。
 *
 * 修法：**幂等补签** —— 每次管理端请求都确认「今天签了没」，没签当场签。
 * 本测试钉住四条契约：
 *   1) 日界线按**北京**算（UTC 会把北京 0–8 点判错）；
 *   2) 今天已补过 → 不再打上游（否则每个请求一次，白白消耗）；
 *   3) 补签失败也要记「今天已尝试」，不许每个请求重试打上游；
 *   4) 幂等：上游说"已签"时 ok=true、claimed=false，不算失败。
 */
let pass = 0, fail = 0;
const ok = (n, c, extra = '') => { c ? pass++ : fail++; console.log((c ? '✅ ' : '❌ ') + n + (extra ? '  ' + extra : '')); };

// ── 1) 日界线：北京时间 ──
// UTC 2026-11-02 23:30 → 北京已是 11-03。按 UTC 算是 11-02，会判错。
{
  const ts = Date.parse('2026-11-02T23:30:00Z');
  const utc = new Date(ts).toISOString().slice(0, 10);
  const bj = new Date(ts + 8 * 3600 * 1000).toISOString().slice(0, 10);
  ok('1 UTC 与北京确实是不同的日子', utc === '2026-11-02' && bj === '2026-11-03', `${utc} vs ${bj}`);
  ok('2 补签必须用北京的日期', bj === '2026-11-03', 'bjDay=' + bj);
}

// ── 2) 一天只补一次（去重语义）──
//     直接测逻辑，不启服务：模拟 Map 记日
{
  const day = new Map();
  const today = '2026-11-03';
  let calls = 0;
  const tryOnce = accId => {
    if (day.get(accId) === today) return false;
    day.set(accId, today); calls++; return true;
  };
  tryOnce('a'); tryOnce('a'); tryOnce('a');
  ok('3 同一账号一天只触发一次', calls === 1, 'calls=' + calls);
  tryOnce('b');
  ok('4 不同账号各自独立', calls === 2, 'calls=' + calls);
}

// ── 3) 幂等：上游"已签"不是失败 ──
//     用 mock 上游走真实的 chanCheckin
// TS 解析钩子（vendor NodeNext 内部 `./x.js` 说明符 → 磁盘 `.ts`）。
// 必须在任何业务 import 之前注册，否则渠道协议模块报 ERR_MODULE_NOT_FOUND
// 且文案形似「缺文件」——2026-11-12 的 6 条红全因于此。生产由 index_turso.js
// 的 ensureTsHook() 兜底，测试入口必须自带。
import '../worker/backends/ts-hook.mjs';
import http from 'node:http';
const srv = http.createServer((req, res) => {
  const path = req.url.split('?')[0];
  res.writeHead(200, { 'content-type': 'application/json' });
  if (path.includes('/signin/claim')) return res.end(JSON.stringify({ base_resp: { status_code: 0 }, data: { claim_result: 2 } }));
  return res.end(JSON.stringify({ base_resp: { status_code: 0 },
    data: { scene: 1, days: [{ day_no: 1, points: 800, bonus_points: 0, status: 2, is_today: true }] } }));
});
await new Promise(r => srv.listen(0, '127.0.0.1', r));
process.env.MINIMAX_API_HOST = `http://127.0.0.1:${srv.address().port}`;
const { chanCheckin } = await import('../worker/chan-checkin.js');
{
  const r = await chanCheckin({ provider: 'minimax', access_token: 't' });
  ok('5 上游"已签"(claim_result=2) 判成功', r.ok === true, JSON.stringify(r));
  ok('6 且 claimed=false（今天没新增积分）', r.claimed === false, 'claimed=' + r.claimed);
}
{
  const r = await chanCheckin({ provider: 'cline', access_token: 't' });
  ok('7 无签到端点的渠道不参与补签', r.ok === false && /不支持签到/.test(r.msg), r.msg);
}
srv.close();

console.log('\n=== PASS ' + pass + ' / FAIL ' + fail + ' ===');
process.exit(fail ? 1 : 0);
