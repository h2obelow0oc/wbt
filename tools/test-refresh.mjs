// 渠道续期协议测试: 本地 HTTPS mock 冒充 4 家上游, 逐条核对 URL/方法/头/请求体。
// **绝不打真实上游** —— 与 OFM 插件共用 refresh_token, 谁后刷新谁作废对方。
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';   // 自签证书, 仅测试

const DIR = fileURLToPath(new URL('.', import.meta.url));
function ensureCert(dir){
  const key=path.join(dir,'selfsigned.key.pem'), crt=path.join(dir,'selfsigned.cert.pem');
  if(!(fs.existsSync(key)&&fs.existsSync(crt))){
    execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-keyout',key,'-out',crt,
      '-days','-2'.replace('-','2'),'-nodes','-subj','/CN=127.0.0.1'],{stdio:'ignore'});
  }
  return {key:fs.readFileSync(key),cert:fs.readFileSync(crt)};
}

// ── 假 JWT (带 exp) ──
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = exp => `${b64({alg:'none'})}.${b64({exp, sub:'u1'})}.sig`;

const seen = [];                 // 记录收到的请求
const PORT = 18950;

const handler = (req,res) => {
  let b=''; req.on('data',c=>b+=c); req.on('end',()=>{
    seen.push({ path:req.url, method:req.method, ct:req.headers['content-type']||'',
                ua:req.headers['user-agent']||'', body:b,
                referer:req.headers['http-referer']||'', title:req.headers['x-title']||'' });
    const j = o => { res.writeHead(200,{'content-type':'application/json'}); res.end(JSON.stringify(o)); };
    if (req.url === '/api/web/auth/v1/refresh')                       // raccoon
      return j({code:0,data:{access_token:jwt(Math.floor(Date.now()/1000)+7200),refresh_token:'rc-new'}});
    if (req.url === '/api/v1/auth/refresh')                           // cline
      // ⚠️ 套 `{success, data}` 信封 —— OFM 的 parseClineTokenPayload 先解 data
      // 再取字段(cline.ts:127)。早期 mock 写成扁平结构, 等于照着有 bug 的实现
      // 写测试, 36/36 全绿却在线上错杀账号。这里必须用真实信封形态。
      return j({success:true,data:{accessToken:jwt(Math.floor(Date.now()/1000)+3600),
                refreshToken:'cl-new',expiresAt:Date.now()+3600_000,
                accountId:'acc_1',email:'a@b.c'}});
    if (req.url === '/oauth2/token')                                  // minimax
      return j({access_token:'mmoat_newtoken',refresh_token:'mm-new',token_type:'Bearer',
                expires_in:3600,scope:'agent.default'});
    if (req.url === '/api/auth/refresh')                              // lobsterai
      return j({code:0,data:{accessToken:'lb-new-at',refreshToken:'lb-new-rt',expiresIn:86400}});
    res.writeHead(404); res.end('{"code":404}');
  });
};
const srv = https.createServer(ensureCert(DIR), handler);
await new Promise(r=>srv.listen(PORT,'127.0.0.1',r));

// ── 注册 .ts→.js 解析钩子: 下面直接 import 的 vendor *.ts 都静态引用 ./raccoon.js 这类
//    真身文件, 没有钩子会在 ESM 链接阶段 ERR_MODULE_NOT_FOUND (与 Render 同一个坑) ──
await import('../worker/backends/ts-hook.mjs');

// ── 把 vendor 常量指向本地 mock ──
const { RACCOON } = await import('../worker/vendor/channel-pack/src/raccoon-product.ts');
const { CLINE }   = await import('../worker/vendor/channel-pack/src/cline-product.ts');
const { MINIMAX } = await import('../worker/vendor/channel-pack/src/minimax-product.ts');
const { LOBSTERAI } = await import('../worker/vendor/channel-pack/src/lobsterai-product.ts');
const BASE = `https://127.0.0.1:${PORT}`;
const SAVED = { rc:RACCOON.apiBase, cl:CLINE.apiBase, mm:MINIMAX.accountHost, lb:LOBSTERAI.apiBase,
               lbv:LOBSTERAI.clientVersionApi };
RACCOON.apiBase = BASE; CLINE.apiBase = BASE; MINIMAX.accountBase = BASE; MINIMAX.accountHost = BASE;
LOBSTERAI.apiBase = BASE;
// 版本号端点也指向 mock（它不提供该路由 → 404 → 走兜底版本号）。
// 不覆盖的话这里会**真的打一次有道 update 接口**，违反「绝不外访」的约定。
LOBSTERAI.clientVersionApi = BASE + '/openapi/get/luna/hardware/lobsterai/prod/update';

const { chanRefresh, isTerminal, REFRESHABLE } = await import('../worker/chan-refresh.js');

let pass=0, fail=0;
const ok=(n,c,x='')=>{c?pass++:fail++;console.log((c?'✅':'❌')+' '+n+(x?'  '+x:''))};
const last=()=>seen[seen.length-1];
const secs = v => typeof v==='number' && v>1e9 && v<1e12;   // 秒级时间戳

ok('0a 可续期渠道 = 4 家', REFRESHABLE.length===4, REFRESHABLE.join(','));
ok('0b isTerminal 识别 TERMINAL 前缀', isTerminal(new Error('TERMINAL: x'))===true && isTerminal(new Error('x'))===false);

// ── raccoon ──
seen.length=0;
const rc = await chanRefresh({provider:'raccoon', refresh_token:'rc-old', expires_at:1});
ok('r1 请求路径', last()?.path==='/api/web/auth/v1/refresh', last()?.path);
ok('r2 POST + JSON 头', last()?.method==='POST' && /application\/json/.test(last()?.ct));
const rcb = JSON.parse(last().body);
ok('r3 body 只有 refresh_token', JSON.stringify(rcb)==='{"refresh_token":"rc-old"}', last().body);
ok('r4 返回新 token', rc.access_token.length>10 && rc.refresh_token==='rc-new');
ok('r5 expires_at 是秒', secs(rc.expires_at), String(rc.expires_at));

// ── cline ──
seen.length=0;
const cl = await chanRefresh({provider:'cline', refresh_token:'cl-old', expires_at:1});
ok('c1 请求路径', last()?.path==='/api/v1/auth/refresh', last()?.path);
ok('c2 POST + JSON', last()?.method==='POST' && /application\/json/.test(last()?.ct));
ok('c3 clientHeaders 透传 (HTTP-Referer)', last()?.referer==='https://cline.bot', last()?.referer);
const clb = JSON.parse(last().body);
ok('c4 body 是驼峰 refreshToken/grantType', clb.refreshToken==='cl-old' && clb.grantType==='refresh_token', last().body);
ok('c5 无 snake_case 泄漏', !('refresh_token' in clb) && !('grant_type' in clb));
ok('c6 access_token 自动补 workos: 前缀', cl.access_token.startsWith('workos:'), cl.access_token.slice(0,10));
ok('c7 不会重复加前缀', !cl.access_token.startsWith('workos:workos:'));
ok('c8 refresh_token 换新', cl.refresh_token==='cl-new');
ok('c9 expires_at 秒级', secs(cl.expires_at), String(cl.expires_at));

// ── minimax ──
seen.length=0;
const mm = await chanRefresh({provider:'minimax', refresh_token:'mm-old', expires_at:1});
ok('m1 请求路径 /oauth2/token', last()?.path==='/oauth2/token', last()?.path);
ok('m2 POST + form 编码', /x-www-form-urlencoded/.test(last()?.ct), last()?.ct);
const mmq = new URLSearchParams(last().body);
ok('m3 grant_type=refresh_token', mmq.get('grant_type')==='refresh_token');
ok('m4 client_id=mcode-public', mmq.get('client_id')==='mcode-public', mmq.get('client_id'));
ok('m5 scope=agent.default', mmq.get('scope')==='agent.default', mmq.get('scope'));
ok('m6 audience=agent-backend', mmq.get('audience')==='agent-backend', mmq.get('audience'));
ok('m7 refresh_token 透传', mmq.get('refresh_token')==='mm-old');
ok('m8 返回新 token', mm.access_token==='mmoat_newtoken' && mm.refresh_token==='mm-new');
ok('m9 expires_at = now+3600 秒', secs(mm.expires_at) && Math.abs(mm.expires_at-(Date.now()/1000|0)-3600)<60, String(mm.expires_at));

// ── lobsterai ──
seen.length=0;
const lb = await chanRefresh({provider:'lobsterai', refresh_token:'lb-old', expires_at:1,
  first_keyfrom:'fk', latest_keyfrom:'lk', uuid:'U-1', user_id:'999'});
ok('l1 请求路径 /api/auth/refresh', last()?.path==='/api/auth/refresh', last()?.path);
ok('l2 POST + JSON + UA', last()?.method==='POST' && /application\/json/.test(last()?.ct) && /LobsterAI/.test(last()?.ua), last()?.ua);
const lbb = JSON.parse(last().body);
ok('l3 body 含驼峰 refreshToken', lbb.refreshToken==='lb-old', last().body);
ok('l4 firstKeyfrom/latestKeyfrom 用**存库原值**', lbb.firstKeyfrom==='fk' && lbb.latestKeyfrom==='lk');
// 版本号是**动态取、失败回退兜底**（不再写死）。mock 不提供 update 路由 → 404
// → 本用例校验回退链路；拿到快照时自然是真版本号，也合理。
ok('l5 版本号取不到时回退兜底', lbb.version===LOBSTERAI.fallbackClientVersion, String(lbb.version));
ok('l6 uuid/userId 条件带上', lbb.uuid==='U-1' && lbb.userId==='999');
ok('l7 返回新 token', lb.access_token==='lb-new-at' && lb.refresh_token==='lb-new-rt');
ok('l8 expires_at=now+86400 秒', secs(lb.expires_at) && Math.abs(lb.expires_at-(Date.now()/1000|0)-86400)<60, String(lb.expires_at));

// ── 终态错误 ──
seen.length=0;
const srvErr = https.createServer(ensureCert(DIR), (q,s)=>{ let b='';q.on('data',c=>b+=c);q.on('end',()=>{
  s.writeHead(401,{'content-type':'application/json'}); s.end('{"code":40100,"message":"会话已过期"}');});});
await new Promise(r=>srvErr.listen(18951,'127.0.0.1',r));
RACCOON.apiBase='https://127.0.0.1:18951';
let term=false, msg='';
try { await chanRefresh({provider:'raccoon', refresh_token:'dead', expires_at:1}); }
catch(e){ term=isTerminal(e); msg=e.message; }
ok('t1 401 判为终态', term===true, msg);
ok('t2 报错带 TERMINAL 标记', msg.startsWith('TERMINAL:'), msg);
srvErr.close();

// ── 未知渠道 ──
let unk=false; try{ await chanRefresh({provider:'gemini', refresh_token:'x'}) }catch(e){ unk=/不支持续期的渠道/.test(e.message) }
ok('t3 未知渠道明确报错', unk);

// 还原常量
RACCOON.apiBase=SAVED.rc; CLINE.apiBase=SAVED.cl; MINIMAX.accountHost=SAVED.mm; LOBSTERAI.apiBase=SAVED.lb;
LOBSTERAI.clientVersionApi=SAVED.lbv;
srv.close();
console.log(`\n=== PASS ${pass} / FAIL ${fail} ===`);
process.exit(fail?1:0);
