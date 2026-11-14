/**
 * 端到端：多账号轮转是否真的把请求发到了不同账号。
 *
 * ## 为什么需要这条 e2e（2026-11-04）
 *
 * 用户加 3 个 raccoon 号后 429 没解决。定位到「渠道固定取第 0 位」+「429 不换号」
 * 两条缺陷后，单测只能证到**纯函数层**（`account-pick.js` 22 条：6 次请求的首选
 * 覆盖 3 个账号）。但「**网关真的换了 token 发出去**」需要看上游收到了什么 ——
 * 这必须有 mock 上游。
 *
 * 而此前做不到：`worker/backends/raccoon.js` 的 chat URL 写死 `RACCOON.apiBase`
 * （vendor 常量），只有续期/额度读了 `RACCOON_API_BASE` 覆盖。把网关指向本地 mock，
 * 请求仍打到真实商汤（实测 mock 一次没收到、返回真实 401）。
 *
 * 本次给 chat URL 补了同一个 `override()` 钩子，这条 e2e 才成立。
 *
 * ## 钉住什么
 *   1. 6 次同模型请求 → 上游至少见到 2 个不同 token（轮转真发生）；
 *   2. 低积分账号（100 分 vs 6000）**不应**出现在首选序列里（分层生效）；
 *   3. 429 时**真的换号**（旧实现是 return Response 不 throw → 从不换号）。
 *
 * ⚠️ 每次请求间隔 1.2s，避开网关自身的「6 次/120s」循环熔断（LOOP_REPEAT_LIMIT），
 *    否则第 6 次会被闸 2 拦成 `loop_detected`，那条路径与轮转无关。
 */
import { startMock } from './mock-turso.mjs';
import { spawn } from 'node:child_process';
import http from 'node:http';
import https from 'node:https';

const { K } = await import('../worker/turso.js');
const KEY_INDEX = String(K.idK);

const MOCK_PORT = 19001, GW_PORT = 19002, UP_PORT = 19003;
let pass = 0, fail = 0;
const ok = (n, c, e = '') => { c ? pass++ : fail++; console.log((c ? '✅ ' : '❌ ') + n + (e ? '  ' + e : '')); };

/** mock 上游：记录每个请求的 Bearer token；可切换成「第一次 429、之后 200」。 */
let seenTokens = [];
let fail429Once = false;
let hitCount = 0;
const up = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => b += c); req.on('end', () => {
    const tok = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    seenTokens.push(tok);
    hitCount++;
    if (fail429Once && hitCount === 1) {
      res.writeHead(429, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 429, message: '您的模型请求频率超限，请稍后重试' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'x', object: 'chat.completion', created: 0, model: 'sn-glm-5-3',
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
    }));
  });
});
await new Promise((r) => up.listen(UP_PORT, '127.0.0.1', r));

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const mock = await startMock(MOCK_PORT);
const seed = async (k, v) => {
  const r = await fetch(`https://127.0.0.1:${MOCK_PORT}/v2/pipeline`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ requests: [{ type: 'execute', stmt: {
      sql: 'INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v',
      args: [{ type: 'text', value: k }, { type: 'text', value: JSON.stringify(v) }] } }] }),
  });
  return (await r.text()).includes('"rows_affected":1');
};

const TOKENS = ['tok-A', 'tok-B', 'tok-C', 'tok-D'];
const NOW = Math.floor(Date.now() / 1000);
await seed(KEY_INDEX, ['k1']);
await seed('key:k1', { id: 'k1', apikey: 'sk-rot', enabled: 1, account_ids: [] });
await seed('idx_accounts', TOKENS.map((_, i) => 'rc' + i));
for (let i = 0; i < TOKENS.length; i++) {
  await seed('acc:rc' + i, {
    id: 'rc' + i, provider: 'raccoon', nickname: '号' + i, enabled: 1,
    access_token: TOKENS[i], refresh_token: 'r' + i,
    expires_at: NOW + 86400, models: [], created_at: NOW,
  });
  // A/B/C 都是 6000（富余层）；D 只有 100 → 应被降级、不进首选
  await seed('snap:rc' + i, { at: NOW, credits: i === 3 ? 100 : 6000 });
}

const gw = spawn('node', ['--import', './worker/backends/hook.mjs', 'worker/index_turso.js'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    TURSO_URL: `127.0.0.1:${MOCK_PORT}`, TURSO_TOKEN: 'mock',
    PORT: String(GW_PORT), ADMIN_TOKEN: 'ra',
    CRON_INTERVAL_MS: '0', CHECKIN_TICK_MS: '0', CREDITS_TICK_MS: '0',
    // ★ 本次新增的钩子：让推理链路也走 mock 上游
    RACCOON_CHAT_BASE: `http://127.0.0.1:${UP_PORT}`,
    NODE_TLS_REJECT_UNAUTHORIZED: '0',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = ''; gw.stdout.on('data', (d) => log += d); gw.stderr.on('data', (d) => log += d);
for (let i = 0; i < 60; i++) { try { await fetch(`http://127.0.0.1:${GW_PORT}/healthz`); break; } catch { await new Promise((r) => setTimeout(r, 200)); } }

const chat = (ctx = { model: 'raccoon/sn-glm-5-3', msg: 'hi' }) => fetch(`http://127.0.0.1:${GW_PORT}/v1/chat/completions`, {
  method: 'POST',
  headers: { Authorization: 'Bearer sk-rot', 'content-type': 'application/json' },
  body: JSON.stringify({ model: ctx.model, messages: [{ role: 'user', content: ctx.msg }], stream: false }),
});

// ── ① 轮转 ──
seenTokens = [];
for (let i = 0; i < 6; i++) { await chat(); await new Promise((r) => setTimeout(r, 1200)); }
const uniq = new Set(seenTokens.filter(Boolean));
ok('1a 上游收到了请求（钩子生效，不再打真实商汤）', seenTokens.length >= 1, `收到 ${seenTokens.length} 次`);
ok('1b 6 次请求用到 ≥2 个不同账号（轮转真的发生）', uniq.size >= 2, `实际 ${uniq.size} 个: ${[...uniq].join(',')}`);
ok('1c 低积分账号 D(tok-D, 100分) 未被使用（分层生效）', !uniq.has('tok-D'), `用到: ${[...uniq].join(',')}`);

// ── ② 429 换号 ──
// ⚠️ 换一个模型：① 已经用同一指纹打了 6 次，再打会被闸 2（6次/120s）先拦成
//    loop_detected，根本到不了上游 —— 那条路径测的是熔断，不是换号。
//    指纹含 model 字段（见 context-guard.js cgFingerprint），换模型即换指纹。
seenTokens = [];
hitCount = 0;
fail429Once = true;
const r429 = await chat({ model: 'raccoon/sn-kimi-k3', msg: 'hi-429' });
const body429 = await r429.text();
ok('2a 第一个号 429 后最终仍返回 200（换号成功）', r429.status === 200, `status=${r429.status} body=${body429.slice(0, 80)}`);
ok('2b 上游确实收到了 2 次（第一次 429、第二次换号重发）', seenTokens.length === 2,
   `收到 ${seenTokens.length} 次: ${seenTokens.join(',')}`);
ok('2c 两次用的是**不同** token（真的换号，不是原号重试）',
   seenTokens.length === 2 && seenTokens[0] !== seenTokens[1], seenTokens.join(' vs '));

gw.kill('SIGTERM'); up.close(); mock.close?.();
console.log(`\n${fail === 0 ? '=== 轮转端到端全部通过 ===' : `=== FAIL ${fail} ===`}`);
if (fail) { console.log('--- GW LOG ---'); console.log(log.slice(-700)); }
process.exit(fail === 0 ? 0 : 1);
