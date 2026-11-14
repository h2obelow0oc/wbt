/**
 * 签到日界线测试 —— 用户报「minimax 还是没自动签到」的真因之一。
 *
 * 网关部署在 Render，容器 TZ = **UTC**。OFM 插件跑在用户自己机器上，
 * `Intl...resolvedOptions().timeZone` 给出的是 Asia/Shanghai，故它正确；
 * 网关照抄那一行就错了：UTC 00:00 换日 = 北京 **08:00** 换日。
 *
 * 后果：用户在北京 07:59 看仍是"昨天"（已签、无可领），08:17 手动点却能签
 * —— 看起来就是「自动签到失效」。再叠加 cron 每 6h 一轮，跨过北京 08:00
 * 的那轮可能落在 10:45，于是 08:00–10:45 之间用户永远看不到自动签到。
 */
// TS 解析钩子（vendor NodeNext 内部 `./x.js` 说明符 → 磁盘 `.ts`）。
// 必须在任何业务 import 之前注册，否则渠道协议模块报 ERR_MODULE_NOT_FOUND
// 且文案形似「缺文件」——2026-11-12 的 6 条红全因于此。生产由 index_turso.js
// 的 ensureTsHook() 兜底，测试入口必须自带。
import '../worker/backends/ts-hook.mjs';
import http from 'node:http';

let pass = 0, fail = 0;
const ok = (n, c, extra = '') => { c ? pass++ : fail++; console.log((c ? '✅ ' : '❌ ') + n + (extra ? '  ' + extra : '')); };

// ── 1) 时区必须是 Asia/Shanghai（而不是服务器默认的 UTC）──
const srv = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({
    base_resp: { status_code: 0 },
    data: { scene: 1, days: [{ day_no: 1, points: 800, bonus_points: 0, status: 2, is_today: true }] },
  }));
});
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${srv.address().port}`;
process.env.MINIMAX_API_HOST = BASE;
process.env.MINIMAX_SIGNIN_CLAIM_PATH = '/minimax-cloud/api/v1/signin/claim';

const seen = [];
srv.removeAllListeners('request');
srv.on('request', (req, res) => {
  seen.push(req.url);
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ base_resp: { status_code: 0 }, data: { scene: 1, days: [] } }));
});

const { chanCheckin } = await import('../worker/chan-checkin.js');
await chanCheckin({ provider: 'minimax', access_token: 't' });

const url = seen[0] || '';
const tz = new URL(url, BASE).searchParams.get('timezone_id');
ok('1 signin/status 带 timezone_id', !!tz, url.slice(0, 90));
// ⚠️ 这条是本缺陷的靶心：不等于 Asia/Shanghai 就说明又跟服务器 TZ 走了
ok('2 时区是 Asia/Shanghai（不是 UTC）', tz === 'Asia/Shanghai', 'timezone_id=' + tz);

// ── 3) 环境变量可覆盖（给非北京用户留口子）──
seen.length = 0;
process.env.CHECKIN_TIMEZONE = 'America/New_York';
// 模块内已读的 env 是运行时读的，无需重新 import
await chanCheckin({ provider: 'minimax', access_token: 't' });
const tz2 = new URL(seen[0] || '', BASE).searchParams.get('timezone_id');
ok('3 CHECKIN_TIMEZONE 可覆盖', tz2 === 'America/New_York', 'timezone_id=' + tz2);
delete process.env.CHECKIN_TIMEZONE;

// ── 4) UTC 与上海确实会给出不同的"今天"（证明这不是理论问题）──
const nowMs = Date.parse('2026-11-02T23:30:00Z');   // UTC 还是 11-02，北京已是 11-03
const utcDay = new Date(nowMs).toISOString().slice(0, 10);
const bjDay = new Date(nowMs + 8 * 3600 * 1000).toISOString().slice(0, 10);
ok('4 UTC 23:30 时北京已是次日（日界线真的不同）', utcDay === '2026-11-02' && bjDay === '2026-11-03',
   `${utcDay} vs ${bjDay}`);

srv.close();
console.log('\n=== PASS ' + pass + ' / FAIL ' + fail + ' ===');
process.exit(fail ? 1 : 0);
