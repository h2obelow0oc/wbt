// 导入端点测试: 真实 ofm 导出文件 → POST /api/accounts/import → 校验落库与 skipped 回报
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { startMock } from './mock-turso.mjs';

// turso.js 的 endpoint() 写死 https://, mock 是自签证书 → 关闭校验(仅测试)
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const ADMIN='test-admin-token';
const mock = await startMock(18941);
const seed = (sql,args)=>fetch('https://127.0.0.1:18941/',{method:'POST',
  headers:{'content-type':'application/json','x-turso-token':'mock'},
  body:JSON.stringify({requests:[{type:'execute',stmt:{sql,args}}]})})
  .then(r=>r.json());

await seed('INSERT INTO kv (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', [{type:'text',value:'idx_keys'},{type:'text',value:JSON.stringify([])}]);

const gw = spawn('node',['--import','./worker/backends/hook.mjs','worker/index_turso.js'],
  {cwd:process.cwd(),env:{...process.env,TURSO_URL:'127.0.0.1:18941',TURSO_TOKEN:'mock',
    PORT:'18942',ADMIN_TOKEN:ADMIN,CRON_INTERVAL_MS:'0',CHECKIN_TICK_MS:'0',RACCOON_CHECKIN_ENABLED:'0',NODE_TLS_REJECT_UNAUTHORIZED:'0'}});
let gwLog=''; gw.stdout.on('data',d=>gwLog+=d); gw.stderr.on('data',d=>gwLog+=d);
for(let i=0;i<40;i++){try{await fetch('http://127.0.0.1:18942/healthz');break}catch{await new Promise(r=>setTimeout(r,250))}}await new Promise(r=>setTimeout(r,600));

let pass=0, fail=0;
const ok=(n,c,extra='')=>{c?pass++:fail++;console.log((c?'✅':'❌')+' '+n+(extra?'  '+extra:''))};

// --- 1) ofm 导出格式导入 ---
// ⚠️ 用**静态夹具**, 不用 /sdcard/deep/ourfree-gateway-accounts-*.json ——
// 那个文件每次重新导出内容都会变(实测某次只剩 trae+minimax), 会让 4 渠道断言随机红。
const file = fs.readFileSync(new URL('./fixtures/export-4ch.json', import.meta.url), 'utf8');
const r1 = await fetch('http://127.0.0.1:18942/api/accounts/import',{
  method:'POST',headers:{'content-type':'application/json',Authorization:'Bearer '+ADMIN},
  body:JSON.stringify({json:file})}).then(r=>r.json());
console.log('响应:', JSON.stringify({ok:r1.ok,imported:r1.imported,skipped:r1.skipped}));
ok('1a 导入成功 ok=true', r1.ok===true);
ok('1b imported=4 (minimax/raccoon/cline/lobsterai)', r1.imported===4, '实际='+r1.imported);
ok('1c skipped 回报含 trae (zcode 在导出阶段已被技能跳过)', Array.isArray(r1.skipped)&&r1.skipped.some(s=>s.provider==='trae'), JSON.stringify((r1.skipped||[]).map(s=>s.provider)));
ok('1d skipped 有原因字段', (r1.skipped||[]).every(s=>s.reason), JSON.stringify((r1.skipped||[])[0]||null));

// --- 2) 落库核验 ---
const rows = JSON.parse((await seed('SELECT v FROM kv WHERE k = ?',[{type:'text',value:'idx_accounts'}]))
  .results[0].response.result.rows[0][0].value);
const accs=[];
for(const id of rows){
  const rr = JSON.parse((await seed('SELECT v FROM kv WHERE k = ?',[{type:'text',value:'acc:'+id}]))
    .results[0].response.result.rows[0][0].value);
  accs.push(rr);
}
ok('2a 落库 4 条', accs.length===4, '实际='+accs.length);
const byP = Object.fromEntries(accs.map(a=>[a.provider,a]));
ok('2b 4 个 provider 都在', ['minimax','raccoon','cline','lobsterai'].every(p=>byP[p]), Object.keys(byP).join(','));
ok('2c 都有非空 access_token', accs.every(a=>a.access_token&&a.access_token.length>10));
ok('2d 都是 enabled=1', accs.every(a=>a.enabled===1));
ok('2e provider 字段正确(非 wb)', accs.every(a=>a.provider!=='wb'));
const cl = byP['cline'];
ok('2f cline expire_time 被识别(过期时间非默认值)', cl && cl.expires_at && cl.expires_at !== Math.floor(Date.now()/1000)+3600, 'expires_at='+cl?.expires_at);
const rc = byP['raccoon'];
ok('2g raccoon phone/user_id 透传', !!(rc && rc.phone && rc.user_id));
const mm = byP['minimax'];
ok('2h minimax expires_at 已归一为秒', mm && mm.expires_at < 1e12, '值='+mm?.expires_at);

// --- 3) 回归: WB 账号导入仍逐字节不变 ---
const wbJson = JSON.stringify({accounts:[{domain:'www.codebuddy.cn',uid:'u123',
  access_token:'wb-tok',refresh_token:'wb-rt',nickname:'WB用户'}]});
const r3 = await fetch('http://127.0.0.1:18942/api/accounts/import',{
  method:'POST',headers:{'content-type':'application/json',Authorization:'Bearer '+ADMIN},
  body:JSON.stringify({json:wbJson})}).then(r=>r.json());
const wbRow = accs.concat([]); // 复查
const rows2 = JSON.parse((await seed('SELECT v FROM kv WHERE k = ?',[{type:'text',value:'idx_accounts'}]))
  .results[0].response.result.rows[0][0].value);
const wbAcc = JSON.parse((await seed('SELECT v FROM kv WHERE k = ?',[{type:'text',value:'acc:'+rows2[rows2.length-1]}]))
  .results[0].response.result.rows[0][0].value);
ok('3a WB 导入 imported=1', r3.imported===1, JSON.stringify({ok:r3.ok,imported:r3.imported}));
ok('3b WB realm 由 domain 推出=cn', wbAcc.realm==='cn', 'realm='+wbAcc.realm);
ok('3c WB domain/uid 保留', wbAcc.domain==='www.codebuddy.cn'&&wbAcc.uid==='u123');
ok('3d WB provider=wb', wbAcc.provider==='wb');

// --- 4) 纯 WB 老格式(数组裸传) 回归 ---
const r4 = await fetch('http://127.0.0.1:18942/api/accounts/import',{
  method:'POST',headers:{'content-type':'application/json',Authorization:'Bearer '+ADMIN},
  body:JSON.stringify({json:JSON.stringify([{domain:'www.workbuddy.ai',access_token:'g-tok'}])})})
  .then(r=>r.json());
ok('4a 裸数组格式仍可导入', r4.imported===1, JSON.stringify({ok:r4.ok,imported:r4.imported,msg:r4.msg}));
const rows3 = JSON.parse((await seed('SELECT v FROM kv WHERE k = ?',[{type:'text',value:'idx_accounts'}]))
  .results[0].response.result.rows[0][0].value);
const wbAcc2 = JSON.parse((await seed('SELECT v FROM kv WHERE k = ?',[{type:'text',value:'acc:'+rows3[rows3.length-1]}]))
  .results[0].response.result.rows[0][0].value);
ok('4b 国际域名 realm=global', wbAcc2.realm==='global', 'realm='+wbAcc2.realm);

gw.kill('SIGTERM');
console.log('\n=== PASS '+pass+' / FAIL '+fail+' ===');
if(fail){console.log('--- GW LOG ---');console.log(gwLog.slice(-1500));}
process.exit(fail?1:0);
