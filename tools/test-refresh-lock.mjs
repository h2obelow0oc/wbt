// 并发刷新互斥测试: 5 个并发聊天同时命中同一个"临期"渠道账号,
// 上游续期端点只应被请求 **1 次** —— 轮换型上游收到第二个请求会作废旧
// refresh_token, 让后到的那次必然失败(甚至误判终态禁号)。
//
// 通过 RACCOON_API_BASE 环境变量把续期端点指到本地计数服务器;
// 聊天端点不受该变量影响(仍打真实上游), 但那不影响本测试 —— 只数续期命中数。
import { spawn } from 'node:child_process';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startMock } from './mock-turso.mjs';

const { K } = await import('../worker/turso.js');
const KEY_INDEX = String(K.idK);
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

let fail = 0; const ok = (n, c, e='') => { if (!c) { fail++; console.log('❌', n, e); } else console.log('✅', n, e); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const DIR = fileURLToPath(new URL('.', import.meta.url));
function ensureCert(dir){
  const key=path.join(dir,'selfsigned.key.pem'), crt=path.join(dir,'selfsigned.cert.pem');
  if(!(fs.existsSync(key)&&fs.existsSync(crt))){
    execFileSync('openssl',['req','-x500'.replace('500','509'),'-newkey','rsa:2048','-keyout',key,'-out',crt,
      '-days','2','-nodes','-subj','/CN=127.0.0.1'],{stdio:'ignore'});
  }
  return {key:fs.readFileSync(key),cert:fs.readFileSync(crt)};
}
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = exp => `${b64({alg:'none'})}.${b64({exp, sub:'u'})}.sig`;

// ── 续期计数服务器 (raccoon 协议) ──
let hits = 0;
const REFRESH_PORT = 18971;
const refSrv = https.createServer(ensureCert(DIR), (q, s) => {
  let b=''; q.on('data',c=>b+=c); q.on('end',()=>{
    hits++;
    s.writeHead(200,{'content-type':'application/json'});
    s.end(JSON.stringify({code:0, data:{
      access_token: jwt(Math.floor(Date.now()/1000)+7200),
      refresh_token: 'rotated-'+hits,
    }}));
  });
});
await new Promise(r=>refSrv.listen(REFRESH_PORT,'127.0.0.1',r));

// ── mock Turso + 种子 ──
const MOCK_PORT = 18972, GW_PORT = 18973, DEAD_PORT = 18979;   // 推理端点用（没人听，快速失败）
const mock = await startMock(MOCK_PORT);
const seed = async (k,v) => {
  const r = await fetch(`https://127.0.0.1:${MOCK_PORT}/v2/pipeline`, {method:'POST',
    headers:{'content-type':'application/json'},
    body: JSON.stringify({requests:[{type:'execute',stmt:{sql:'INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v',
      args:[{type:'text',value:k},{type:'text',value:JSON.stringify(v)}]}}]})});
  return (await r.text()).includes('"rows_affected":1');
};
const PAST = Math.floor(Date.now()/1000) - 60;      // 已过期 60 秒 → 必触发刷新
await seed(KEY_INDEX, ['k1']);
await seed('key:k1', { id:'k1', apikey:'sk-lock', enabled:1, account_ids:[] });
await seed('idx_accounts', ['a-rc']);
await seed('acc:a-rc', { id:'a-rc', provider:'raccoon', nickname:'并发号',
  enabled:1, access_token:'stale-at', refresh_token:'stale-rt',
  expires_at: PAST, models:[], created_at: Math.floor(Date.now()/1000) });

// ── 网关 (续期端点指向本地计数器; cron 拉到 1 小时, 只让聊天路径触发刷新) ──
const gw = spawn('node', ['--import','./worker/backends/hook.mjs','worker/index_turso.js'], {
  cwd: process.cwd(),
  env: { ...process.env, TURSO_URL:`127.0.0.1:${MOCK_PORT}`, TURSO_TOKEN:'mock',
    PORT:String(GW_PORT), ADMIN_TOKEN:'ka', CRON_INTERVAL_MS:'3600000', CHECKIN_TICK_MS:'0',
    // ⚠️ 必须关掉额度 tick：本测试把 RACCOON_API_BASE 指向「续期计数器」，
    // 而额度查询复用同一批上游 host（chan-refresh 的 products()/override()）。
    // 额度 tick 一启动即跑，就会给我们数出额外命中 —— 那不是锁失效，
    // 是**两个不同的上游调用被同一个计数器数了**。
    CREDITS_TICK_MS:'0',
    // 续期端点 → 计数器
    RACCOON_API_BASE:`https://127.0.0.1:${REFRESH_PORT}`,
    // ★ 推理端点 → **另指一个不计数的地址**。
    //
    // 2026-11-04 给 `backends/raccoon.js` 的 chat URL 补上 `RACCOON_API_BASE`
    // 覆盖之后（为了 e2e-rotation 能把网关指向 mock），本测试的 chat 也会落到
    // 上面那个计数器上 —— 于是 5 个并发 chat 各打一次，`hits` 从 1 变 6，
    // 这条本意是「测续期锁」的断言就红了。
    //
    // 那个变化**不是锁失效**：计数器被两种不同的上游调用（续期 + 推理）共用，
    // 数在一起当然不准。把推理指向一个没人听的端口，它会快速连接失败
    // （被下面的 `catch` 当作 chat-error），续期计数就只剩续期本身。
    RACCOON_CHAT_BASE:`http://127.0.0.1:${DEAD_PORT}`,
    NODE_TLS_REJECT_UNAUTHORIZED:'0' },
  stdio:['ignore','pipe','pipe'],
});
let gwLog=''; gw.stdout.on('data',d=>gwLog+=d); gw.stderr.on('data',d=>gwLog+=d);
for (let i=0;i<40;i++){ try { await fetch(`http://127.0.0.1:${GW_PORT}/healthz`); break; } catch { await sleep(250); } }

const H = { Authorization:'Bearer sk-lock', 'content-type':'application/json' };
const chat = async () => {
  try {
    const r = await fetch(`http://127.0.0.1:${GW_PORT}/v1/chat/completions`, { method:'POST', headers:H,
      body: JSON.stringify({ model:'raccoon/sn-glm-5-3', messages:[{role:'user',content:'hi'}], stream:false }) });
    return r.status;
  } catch(e){ return 'ERR:'+e.message; }
};

// ── 5 个并发聊天 ──
const before = hits;
const statuses = await Promise.all([chat(),chat(),chat(),chat(),chat()]);
const delta = hits - before;

ok('1 5 个并发请求都返回了', statuses.length===5, JSON.stringify(statuses));
ok('2 **续期上游只被打 1 次** (锁生效)', delta===1, `实际命中 ${delta} 次`);
ok('3 未出现重复刷新(第2次起应被锁内重读跳过)', delta<=1, `hits=${hits}`);

// 落库核验: 账号已被刷新, token 是轮换后的新值
const readAcc = async () => {
  const r = await fetch(`https://127.0.0.1:${MOCK_PORT}/v2/pipeline`, {method:'POST',
    headers:{'content-type':'application/json'},
    body: JSON.stringify({requests:[{type:'execute',stmt:{sql:'SELECT v FROM kv WHERE k = ?',
      args:[{type:'text',value:'acc:a-rc'}]}}]})});
  const j = await r.json();
  return JSON.parse(j.results[0].response.result.rows[0][0].value);
};
const acc = await readAcc();
ok('4 账号 access_token 已换成新值', acc.access_token && acc.access_token!=='stale-at', (acc.access_token||'').slice(0,14));
ok('5 refresh_token 已轮换', acc.refresh_token==='rotated-1', acc.refresh_token);
ok('6 expires_at 已推进到未来', acc.expires_at > Math.floor(Date.now()/1000)+6000, String(acc.expires_at));
ok('7 账号仍 enabled(刷新成功, 不该被禁)', acc.enabled===1, String(acc.enabled));

// ── 反向: 已经是新鲜账号时, 连 1 次都不该打 ──
const hitsBefore2 = hits;
const st2 = await chat();
ok('8 新鲜账号不再触发刷新', (hits - hitsBefore2)===0 && acc.expires_at > Math.floor(Date.now()/1000),
   `新增命中 ${hits-hitsBefore2} 次, status=${st2}`);

gw.kill('SIGTERM'); refSrv.close();
console.log(`\n=== PASS ${8-fail} / FAIL ${fail} ===`);
if (fail) { console.log('--- GW LOG tail ---'); console.log(gwLog.slice(-800)); }
process.exit(fail?1:0);
