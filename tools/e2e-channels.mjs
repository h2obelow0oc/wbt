/** 端到端: mock Turso → 启动网关 → 打真实 HTTP 请求, 验证渠道分派与模型列表。 */
import { startMock } from './mock-turso.mjs';
// ⚠️ key 索引的 KV 键必须取自真实 K 对象: index_turso 全程用 K.idK(该字段不存在,
//    值为 undefined → kvGet/put 落在字面键 "undefined" 上, 写读自洽)。
//    按 turso.js 里 idxK 的字面值 seed 会写进没人读的键, 表现为"永远 401"。
const { K } = await import('../worker/turso.js');
const KEY_INDEX = String(K.idK);   // 与 turso.js kvGet 的 String(k) 完全一致 → 'undefined'
import { spawn } from 'node:child_process';

let fail = 0; const ok = (n, c, e='') => { if (!c) { fail++; console.log('❌', n, e); } else console.log('✅', n, e); };
const MOCK_PORT = 18899, GW_PORT = 18901;

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';  // mock 是自签 TLS
const mock = await startMock(MOCK_PORT);
// 灌数据: 1 个 WB 账号 + minimax/raccoon 各 1 个渠道账号 + 1 把 key
const seed = [
  [KEY_INDEX, ['k1']], ['key:k1', { id:'k1', apikey:'sk-e2e', enabled:1, account_ids:[] }],
  ['idx_accounts', ['a-wb','a-mm','a-rc']],
  ['acc:a-wb', { id:'a-wb', provider:'wb', enabled:1, realm:'cn', domain:'www.codebuddy.cn', access_token:'wb-tok' }],
  ['acc:a-mm', { id:'a-mm', provider:'minimax', enabled:1, access_token:'mm-dummy' }],
  ['acc:a-rc', { id:'a-rc', provider:'raccoon', enabled:1, access_token:'rc-dummy' }],
];
// WB 模型由 aggModels 从实时上游抓取, mock 环境拿不到 → 灌 5 分钟内有效的缓存,
// 才能验证「WB 模型 + 渠道模型」真实共存 (缓存形状见 index_turso.js aggModels)。
const NOW = Math.floor(Date.now()/1000);
seed.push(['agg_models_v4', { at: NOW, map: [
  { id:'deepseek-v4.1-flash', maxOutput:8192, supportsImages:true, realms:['cn'], owners:['a-wb'],
    byRealm:{ cn:{ multiplier:'x0.11', discounted:'', name:'DeepSeek V4.1 Flash', context:200000 } } },
  { id:'gpt-5.1', maxOutput:4096, supportsImages:false, realms:['cn'], owners:['a-wb'],
    byRealm:{ cn:{ multiplier:'x1.0', discounted:'', name:'GPT-5.1', context:128000 } } },
], owner: { 'deepseek-v4.1-flash':['a-wb'], 'gpt-5.1':['a-wb'] } }]);
for (const [k,v] of seed) {
  const r = await fetch(`https://127.0.0.1:${MOCK_PORT}/v2/pipeline`, {method:'POST',
    headers:{'content-type':'application/json'},
    body: JSON.stringify({requests:[{type:'execute',stmt:{sql:'INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', args:[{type:'text',value:k},{type:'text',value:JSON.stringify(v)}]}}]})});
  const t = await r.text();
  if (!t.includes('"rows_affected":1')) console.log('SEED FAIL', k, r.status, t.slice(0,120));
}
// 读回验证
{
  const r = await fetch(`https://127.0.0.1:${MOCK_PORT}/v2/pipeline`, {method:'POST',
    headers:{'content-type':'application/json'},
    body: JSON.stringify({requests:[{type:'execute',stmt:{sql:'SELECT v FROM kv WHERE k = ?', args:[{type:'text',value:KEY_INDEX}]}}]})});
  console.log('SEED VERIFY key-index('+KEY_INDEX+') =', (await r.text()).slice(0,160));
}

const ADMIN = 'e2e-admin';
const gw = spawn('node', ['--import','./worker/backends/hook.mjs','worker/index_turso.js'], {
  cwd: '/sdcard/deep/wb-manager',
  env: { ...process.env, TURSO_URL: `127.0.0.1:${MOCK_PORT}`, TURSO_TOKEN: 'mock', PORT: String(GW_PORT), CRON_INTERVAL_MS: '0', CHECKIN_TICK_MS: '0', RACCOON_CHECKIN_ENABLED: '0', NODE_TLS_REJECT_UNAUTHORIZED: '0', ADMIN_TOKEN: ADMIN },
  stdio: ['ignore','pipe','pipe'],
});
let gwLog = '';
gw.stdout.on('data', d => gwLog += d); gw.stderr.on('data', d => gwLog += d);
const sleep = ms => new Promise(r => setTimeout(r, ms));
for (let i=0;i<40;i++) { try { await fetch(`http://127.0.0.1:${GW_PORT}/v1/models`,{headers:{Authorization:'Bearer sk-e2e'}}); break; } catch { await sleep(250); } }

const H = { Authorization: 'Bearer sk-e2e', 'content-type': 'application/json' };

// ---- 1) /v1/models 含渠道模型 ----
{
  const r = await fetch(`http://127.0.0.1:${GW_PORT}/v1/models`, { headers: H });
  const j = await r.json();
  const ids = (j.data||[]).map(m=>m.id);
  ok('1a /v1/models 200', r.status===200, 'status='+r.status);
  // WB 模型带 workbuddy/ 前缀(2026-11-02 上线): 与渠道模型同形, 便于将来国际版区分来源
  const CH_PREF = ['minimax/','raccoon/','cline/','lobsterai/'];
  const isChanId = i => CH_PREF.some(p => i.startsWith(p));
  const isWb = i => i.startsWith('workbuddy/');
  ok('1b WB 模型与渠道模型共存', ids.includes('workbuddy/deepseek-v4.1-flash') && ids.includes('minimax/MiniMax-M3'),
     '共 '+ids.length+' 条 | WB: '+ids.filter(isWb).join(',')+' | 渠道条数: '+ids.filter(isChanId).length);
  ok('1b2 非渠道模型全带 workbuddy/ 前缀', ids.filter(i=>!isChanId(i)).every(isWb) && ids.filter(isWb).length>0,
     '裸 WB id: '+ids.filter(i=>!isChanId(i)&&!isWb(i)).join(','));
  ok('1c minimax 渠道模型', ids.includes('minimax/MiniMax-M3'), '');
  ok('1d raccoon 渠道模型', ids.includes('raccoon/sn-glm-5-3'), '');
  ok('1e 同名 MiniMax-M3 不撞车', ids.includes('minimax/MiniMax-M3') && !ids.includes('MiniMax-M3'), '');
  ok('1h 渠道条数=minimax4+raccoon6', ids.filter(i=>i.startsWith('minimax/')).length===4 && ids.filter(i=>i.startsWith('raccoon/')).length===6,
     'minimax='+ids.filter(i=>i.startsWith('minimax/')).length+' raccoon='+ids.filter(i=>i.startsWith('raccoon/')).length);
  // ⚠️ cline 这里**不该出现**：`/v1/models` 只带有账号的渠道，而 e2e 故意没有
  // cline 账号（见下面 3a 的 channel_no_account 断言）。
  // cline 的**远端目录**（4 免费 / 25 条）由 tools/test-cline-catalog.mjs 用
  // 离线 mock 固定 —— 那里才能复用 merge 逻辑，不该依赖真实网络。
  // 本条只需要确认：给 cline 加了异步预热后，别的渠道一条没少（1h 已证）。
  const mm = (j.data||[]).find(m=>m.id==='minimax/MiniMax-M3');
  ok('1f 渠道行带 realm=channel 与 context', mm?.realm==='channel' && mm?.context===1000000, JSON.stringify(mm));
  ok('1g X-Upstream-Context-Window 含渠道', JSON.stringify(r.headers.get('x-upstream-context-window')||'').includes('minimax/MiniMax-M3'));
  // DSH keypool 的 extractContextTokens 只认 context_length/contextWindow/max_input_tokens,
  // 不认裸 `context` —— 少这个别名它就报「0/60 model answered」= 探测不到上游模型。
  const noAlias = (j.data||[]).filter(m => typeof m.context_length !== 'number');
  ok('1n 每行都带 context_length(keypool 认的字段)', (j.data||[]).length>0 && noAlias.length===0,
     '缺别名 ' + noAlias.length + ' 条: ' + noAlias.slice(0,3).map(m=>m.id).join(','));
  const wbRow = (j.data||[]).find(m=>m.id==='workbuddy/deepseek-v4.1-flash');
  ok('1o context_length 与 context 同值', wbRow && wbRow.context_length===wbRow.context && typeof wbRow.context==='number',
     JSON.stringify(wbRow));
}

// ---- 1i) 面板聚合接口 /api/models/agg 也必须含渠道模型 ----
// 回归背景: 该接口原先只走 WB 的 cn/global 两行, 渠道上线后面板仍然只有
// 「国内版/国际版/全部」三个 WB 分组, 渠道模型在 UI 上完全不可见。
{
  const r = await fetch(`http://127.0.0.1:${GW_PORT}/api/models/agg`, {
    method: 'POST', headers: { Authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' },
    // 不传 force: force 会绕过缓存去打真实 WB 上游, e2e 里上游不可达 → WB 行被清空
    body: JSON.stringify({}),
  });
  const j = await r.json();
  const ms = j.models || [];
  const chans = ms.filter(m => m.realm === 'channel');
  const wb = ms.filter(m => m.realm !== 'channel');
  ok('1i /api/models/agg 200', r.status === 200 && j.ok, 'status=' + r.status + ' ' + JSON.stringify(j).slice(0,120));
  ok('1j 面板含渠道模型(realm=channel)', chans.length > 0,
     '渠道 ' + chans.length + ' 条 | ' + chans.slice(0,4).map(m=>m.id).join(','));
  ok('1k 面板渠道 id 带前缀(与 /v1/models 同形)',
     chans.length > 0 && chans.every(m => /^(minimax|raccoon)\//.test(m.id)),
     '未带前缀: ' + chans.filter(m=>!/^(minimax|raccoon)\//.test(m.id)).map(m=>m.id).join(','));
  ok('1l WB 分组仍然在(国内/国际没被顶掉)', wb.length > 0 && wb.some(m => m.realm === 'cn'),
     'WB ' + wb.length + ' 条');
  const m1 = ms.find(m => m.id === 'minimax/MiniMax-M3');
  ok('1m 面板渠道行字段齐全', !!m1 && typeof m1.context === 'number' && typeof m1.multiplier === 'string',
     JSON.stringify(m1));
  // 真实倍率内嵌在 vendor 展示名里: raccoon 目录含「· 免费」与「· x0.75」模型。
  // 旧代码对渠道一律写死 x1.00 —— 用户报「除了 workbuddy 你全写成 X1，明明很多不是」。
  const nonOne = chans.filter(m => m.multiplier !== 'x1.00');
  ok('1p 渠道倍率不再全是 x1.00', chans.length > 0 && nonOne.length > 0,
     '非x1.00 ' + nonOne.length + '/' + chans.length + ' | ' +
     nonOne.slice(0,4).map(m => m.id + '=' + m.multiplier).join(', '));
  const freeRow = chans.find(m => /sn-sensenova-6-8-flash$/.test(m.id));
  ok('1q 免费模型标出「免费」而非 x1.00', !!freeRow && freeRow.multiplier === '免费',
     JSON.stringify(freeRow && { id: freeRow.id, multiplier: freeRow.multiplier }));
}

// ---- 2) 渠道路由(上游 dummy token → 应得到渠道错误, 而非 WB 错误) ----
const chat = async (model, extra={}) => {
  const r = await fetch(`http://127.0.0.1:${GW_PORT}/v1/chat/completions`, { method:'POST', headers:H,
    body: JSON.stringify({ model, messages:[{role:'user',content:'hi'}], stream:false, ...extra }) });
  let j=null; try { j = await r.json(); } catch {}
  return { status:r.status, j };
};
{
  const { status, j } = await chat('minimax/MiniMax-M3');
  const msg = j?.error?.message || JSON.stringify(j||'').slice(0,120);
  ok('2a minimax 路由到渠道(报错含 minimax)', status!==200 && /minimax/i.test(msg), 'status='+status+' msg='+msg.slice(0,110));
  ok('2b 不是"no available account"', !/no available account/.test(msg));
}
{
  const { status, j } = await chat('raccoon/sn-glm-5-3');
  const msg = j?.error?.message || '';
  ok('2c raccoon 路由到渠道', status!==200 && /raccoon/i.test(msg), 'status='+status+' msg='+msg.slice(0,110));
}
// ---- 3) 无账号渠道 → 503 ----
{
  const { status, j } = await chat('cline/stealth/space-bunny-alpha');
  ok('3a cline 无账号 → 503 channel_no_account', status===503 && j?.error?.code==='channel_no_account', 'status='+status+' code='+j?.error?.code);
}
// ---- 4) 渠道内未知模型 → 404 ----
{
  const { status, j } = await chat('minimax/NoSuchModel');
  ok('4a 渠道未知模型 → 404 model_not_found', status===404 && j?.error?.code==='model_not_found', 'status='+status+' code='+j?.error?.code);
}
// ---- 5) WB 模型不受影响(仍走 WB 上游) ----
{
  const { status, j } = await chat('deepseek-v4.1-flash');
  const msg = j?.error?.message || JSON.stringify(j||'').slice(0,100);
  ok('5a WB 模型走 WB 链路', !/minimax|raccoon:|cline:/.test(msg), 'status='+status+' msg='+msg.slice(0,110));
}
// ---- 6) 清理全部数据(必须放最后: 它会把账号/日志/缓存全删) ----
{
  const A = p => `http://127.0.0.1:${GW_PORT}/api/${p}`;
  const hdr = { Authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' };
  const before = (await (await fetch(A('accounts'), { headers: hdr })).json()).accounts.length;
  const r = await (await (await fetch(A('reset'), { method: 'POST', headers: hdr, body: '{}' })).json());
  ok('6a 清理端点返回 ok', r.ok === true, JSON.stringify(r));
  const after = (await (await fetch(A('accounts'), { headers: hdr })).json()).accounts.length;
  ok('6b 账号被真正删干净(不是只隐藏)', after === 0 && r.cleared && r.cleared.accounts === before,
     'before=' + before + ' after=' + after + ' cleared=' + JSON.stringify(r && r.cleared));
  ok('6c API Key 与设置被保留', r.kept && r.kept.includes('keys') && r.kept.includes('setting'),
     JSON.stringify(r && r.kept));
  const lg = await (await fetch(A('logs'), { headers: hdr })).json();
  const logs = Array.isArray(lg.logs) ? lg.logs : [];
  ok('6d 日志清空后只留本次清理的审计记录', logs.length <= 1 && logs.every(l => l.type === 'reset'),
     '残留日志 ' + logs.length + ' 条 | ' + logs.slice(0,2).map(l=>l.type).join(','));
}
console.log('--- GW LOG ---'); console.log(gwLog.slice(-1500) || '(empty)');
gw.kill('SIGTERM'); mock.close();
console.log(fail ? `\n=== FAIL ${fail} ===` : '\n=== 端到端全部通过 ===');
process.exit(fail?1:0);
