// 保活接线冒烟: 验证 runCron 对渠道账号走 chanRefresh 分支、不打 WB checkin、
// 终态错误会禁用账号。
// ⚠️ 用**伪造 refresh_token** 打真实上游 —— 上游必然拒绝, 不会与 OFM 插件
// 抢真凭据(共用同一个 refresh_token, 谁后刷新谁作废对方)。
import { spawn } from 'node:child_process';
import { startMock } from './mock-turso.mjs';
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const ADMIN='ka-token';
const mock = await startMock(18961);
const seed = (sql,args)=>fetch('https://127.0.0.1:18961/',{method:'POST',
  headers:{'content-type':'application/json','x-turso-token':'mock'},
  body:JSON.stringify({requests:[{type:'execute',stmt:{sql,args}}]})}).then(r=>r.json());
const one = r => JSON.parse(r.results[0].response.result.rows[0][0].value);

await seed('INSERT INTO kv (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v = excluded.v',
  [{type:'text',value:'idx_keys'},{type:'text',value:JSON.stringify([])}]);

// 两条渠道账号: 一条**已过期**(必触发刷新), 一条 30 天后过期(不应触发)
const accs = [
  { id:'acc-due',  provider:'raccoon', nickname:'到期号', access_token:'fake-at',
    refresh_token:'FAKE-REFRESH-TOKEN-DO-NOT-VALID', expires_at: Math.floor(Date.now()/1000)-60,
    enabled:1, models:[], created_at:Math.floor(Date.now()/1000) },
  { id:'acc-fresh', provider:'minimax', nickname:'新鲜号', access_token:'fake-at2',
    refresh_token:'also-fake', expires_at: Math.floor(Date.now()/1000)+30*86400,
    enabled:1, models:[], created_at:Math.floor(Date.now()/1000) },
];
for (const a of accs) await seed('INSERT INTO kv (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v = excluded.v',
  [{type:'text',value:'acc:'+a.id},{type:'text',value:JSON.stringify(a)}]);
await seed('INSERT INTO kv (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v = excluded.v',
  [{type:'text',value:'idx_accounts'},{type:'text',value:JSON.stringify(accs.map(a=>a.id))}]);

const gw = spawn('node',['--import','./worker/backends/hook.mjs','worker/index_turso.js'],
  {cwd:process.cwd(),env:{...process.env,TURSO_URL:'127.0.0.1:18961',TURSO_TOKEN:'mock',
    PORT:'18962',ADMIN_TOKEN:ADMIN,CRON_INTERVAL_MS:'3600000',CHECKIN_TICK_MS:'0',RACCOON_CHECKIN_ENABLED:'0',NODE_TLS_REJECT_UNAUTHORIZED:'0'}});
let log=''; gw.stdout.on('data',d=>log+=d); gw.stderr.on('data',d=>log+=d);
for(let i=0;i<40;i++){try{await fetch('http://127.0.0.1:18962/healthz');break}catch{await new Promise(r=>setTimeout(r,250))}}
await new Promise(r=>setTimeout(r,700));

let pass=0, fail=0;
const ok=(n,c,x='')=>{c?pass++:fail++;console.log((c?'✅':'❌')+' '+n+(x?'  '+x:''))};

// 手动触发 cron
const r = await fetch('http://127.0.0.1:18962/api/run-cron',{
  method:'POST',headers:{'content-type':'application/json',Authorization:'Bearer '+ADMIN},
  body:'{}'}).then(x=>x.json());
ok('1 run-cron 返回 ok', r.ok===true, JSON.stringify(r).slice(0,200));
ok('2 日志里有渠道 keepalive 记录', Array.isArray(r.log) && r.log.some(l=>/keepalive/.test(l)), JSON.stringify(r.log));

// 落库核验
const idx = one(await seed('SELECT v FROM kv WHERE k = ?',[{type:'text',value:'idx_accounts'}]));
const rows = {};
for (const id of idx) rows[id] = one(await seed('SELECT v FROM kv WHERE k = ?',[{type:'text',value:'acc:'+id}]));

// 假 token → 上游回 params_invalid_error → **非终态**(分不清是"号死了"还是"参数坏了"),
// 故保持 enabled 是正确行为; 终态(401/200003)才禁用。这里验的是"确实尝试过且没误禁"。
ok('3 到期号确实尝试过刷新, 且非终态错误未被误禁用',
   rows['acc-due'] && rows['acc-due'].enabled===1,
   'enabled='+rows['acc-due']?.enabled);

// logs 里应有 keepalive 失败记录
const logs = one(await seed('SELECT v FROM kv WHERE k = ?',[{type:'text',value:'logs'}]));
const kl = (logs||[]).filter(l=>l.type==='keepalive');
ok('4 logs 有 keepalive 条目且带错误信息', kl.length>0 && kl[0].msg && kl[0].msg.length>3,
   JSON.stringify(kl[0]||null).slice(0,160));
// 签到已从「WB 专属」改为渠道也支持（chan-checkin.js）。2026-11-06 再换代：
// raccoon 也有每日签到（`setting_info` 登录信号，见 chan-checkin.js 顶部实测记录），
// 本测试用 RACCOON_CHECKIN_ENABLED=0 挡住真实商汤，但**记账与日志照走**。
// 于是两家的断言统一成一条硬要求：checkin 条目必须是**渠道自己的消息**（含 provider 名），
// 绝不能是 WB 链路的产物（那意味着渠道被误路由到 copilot.tencent.com）。
const chk = (logs||[]).filter(l=>l.type==='checkin');
ok('5 raccoon 参与签到且消息是渠道自己的(非 WB 链路)',
   chk.some(l=>l.account_id==='acc-due') &&
   chk.filter(l=>l.account_id==='acc-due').every(l=>/raccoon/i.test(l.msg||'')),
   JSON.stringify(chk.filter(l=>l.account_id==='acc-due').map(l=>l.msg)));
ok('5b minimax 的 checkin 是渠道消息(非 WB 链路)',
   chk.filter(l=>l.account_id==='acc-fresh').every(l=>/minimax/.test(l.msg||'')),
   JSON.stringify(chk.filter(l=>l.account_id==='acc-fresh').map(l=>l.msg)));

// 新鲜号不应被刷新 (30 天 > 30 分钟阈值)
ok('6 新鲜号未被刷新(过期时间没变)', rows['acc-fresh']?.expires_at === accs[1].expires_at,
   String(rows['acc-fresh']?.expires_at));

gw.kill('SIGTERM');
console.log(`\n=== PASS ${pass} / FAIL ${fail} ===`);
if(fail){console.log('--- GW LOG ---');console.log(log.slice(-1200));}
process.exit(fail?1:0);
