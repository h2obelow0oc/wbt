/**
 * 端到端：11102/11103 记账后从 /v1/models 消失、11150 自愈重试。
 *
 * 用本地 mock 上游（TLS，账号 domain 指过去）真实走一遍 handleProxy：
 *   1) glm-4.6v  → 上游 11102 → 请求仍返回 400 原样，但 /v1/models 里不见了
 *   2) glm-5.0-turbo → 上游第一次 11150、补档后 200 → 客户端只看到成功
 *   3) 客户端自己带了 reasoning_effort → 网关不许覆盖
 *   4) TTL 过期的 dead 标记不生效
 */
import { startMock } from './mock-turso.mjs';
import https from 'node:https';
import fs from 'node:fs';
import { spawn } from 'node:child_process';

const { K } = await import('../worker/turso.js');
const KEY_INDEX = String(K.idK);

let fail = 0; const ok = (n, c, e = '') => { if (!c) { fail++; console.log('❌', n, e); } else console.log('✅', n, e); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const MOCK_PORT = 18897, UP_PORT = 18896, GW_PORT = 18903;
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

// ── 假上游：按 model 决定行为，并记录收到的 reasoning_effort ──────────────
const seenEffort = [];
const upstream = https.createServer(
  { key: fs.readFileSync('/sdcard/deep/wb-manager/tools/selfsigned.key.pem'), cert: fs.readFileSync('/sdcard/deep/wb-manager/tools/selfsigned.cert.pem') },
  (req, res) => {
    let b = ''; req.on('data', c => b += c); req.on('end', () => {
      let body = {}; try { body = JSON.parse(b || '{}'); } catch {}
      const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (req.url.endsWith('/v3/config')) {
        return send(200, { data: { models: [
          { id: 'glm-4.6v', name: 'GLM-4.6V', maxInputTokens: 128000, maxOutputTokens: 32000, credits: 'x0.11 credits' },
          { id: 'glm-5.0-turbo', name: 'GLM-5.0-Turbo', maxInputTokens: 200000, maxOutputTokens: 48000, credits: 'x0.95 credits', reasoning: { effort: 'medium', summary: 'auto' } },
          { id: 'hy3', name: 'hy3', maxInputTokens: 192000, maxOutputTokens: 32000, credits: 'x0.00 credits' },
        ] } });
      }
      if (req.url.endsWith('/v2/chat/completions')) {
        const m = body.model;
        seenEffort.push({ model: m, effort: body.reasoning_effort ?? null });
        if (m === 'glm-4.6v') {
          return send(400, { code: 11102, msg: `model [${m}] service info not found`, requestId: 'mock-1', retry_policy: { retry: false },
            displayMsg: { zh: '当前模型不可用，请切换模型' } });
        }
        if (m === 'glm-5.0-turbo' && !body.reasoning_effort) {
          return send(400, { code: 11150, msg: 'the reasoning effort value is not supported by the current model', requestId: 'mock-2' });
        }
        // 成功：回一个最小 SSE（网关对非流式会聚合，这里直接给非流式 JSON 亦可）
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":null}]}\n\n');
        res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}}\n\n');
        res.write('data: [DONE]\n\n');
        return res.end();
      }
      send(404, { error: 'no route ' + req.url });
    });
  });
await new Promise(r => upstream.listen(UP_PORT, '127.0.0.1', r));

const mock = await startMock(MOCK_PORT);
const NOW = Math.floor(Date.now() / 1000);
const seed = [
  [KEY_INDEX, ['k1']],
  ['key:k1', { id: 'k1', apikey: 'sk-marks', enabled: 1, account_ids: [] }],
  ['idx_accounts', ['a-wb']],
  ['acc:a-wb', { id: 'a-wb', provider: 'wb', enabled: 1, realm: 'cn', domain: `127.0.0.1:${UP_PORT}`, access_token: 'tok' }],
];
for (const [k, v] of seed) {
  await fetch(`https://127.0.0.1:${MOCK_PORT}/v2/pipeline`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ requests: [{ type: 'execute', stmt: { sql: 'INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', args: [{ type: 'text', value: k }, { type: 'text', value: JSON.stringify(v) }] } }] }),
  });
}

const ADMIN = 'marks-admin';
const gw = spawn('node', ['--import', './worker/backends/hook.mjs', 'worker/index_turso.js'], {
  cwd: '/sdcard/deep/wb-manager',
  env: { ...process.env, TURSO_URL: `127.0.0.1:${MOCK_PORT}`, TURSO_TOKEN: 'mock', PORT: String(GW_PORT),
    CRON_INTERVAL_MS: '0', CHECKIN_TICK_MS: '0', NODE_TLS_REJECT_UNAUTHORIZED: '0', ADMIN_TOKEN: ADMIN,
    LOOP_REPEAT_LIMIT: '0' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let gwLog = ''; gw.stdout.on('data', d => gwLog += d); gw.stderr.on('data', d => gwLog += d);
for (let i = 0; i < 60; i++) { try { await fetch(`http://127.0.0.1:${GW_PORT}/v1/models`, { headers: { Authorization: 'Bearer sk-marks' } }); break; } catch { await sleep(250); } }

const H = { Authorization: 'Bearer sk-marks', 'content-type': 'application/json' };
const chat = async (model, extra = {}) => {
  const r = await fetch(`http://127.0.0.1:${GW_PORT}/v1/chat/completions`, { method: 'POST', headers: H,
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }], stream: false, ...extra }) });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, j };
};
const modelIds = async () => {
  const r = await fetch(`http://127.0.0.1:${GW_PORT}/v1/models`, { headers: H });
  const j = await r.json(); return (j.data || []).map(m => m.id);
};

// ── 0) 初始：三个模型都在 ─────────────────────────────────────────────
{
  const ids = await modelIds();
  ok('0a 初始列表含三个模型', ['workbuddy/glm-4.6v', 'workbuddy/glm-5.0-turbo', 'workbuddy/hy3'].every(i => ids.includes(i)),
     ids.join(','));
}

// ── 1) 11102 → 原样返回 + 记账 → 从列表消失 ────────────────────────────
{
  const { status, j } = await chat('workbuddy/glm-4.6v');
  ok('1a 11102 原样透出给客户端', status === 400 && j?.code === 11102, `status=${status} code=${j?.code}`);
  ok('1b 错误体保留上游 msg', typeof j?.msg === 'string' && j.msg.includes('service info not found'), j?.msg);
  ok('1c 错误体保留 displayMsg（客户端可展示）', j?.displayMsg?.zh === '当前模型不可用，请切换模型', JSON.stringify(j?.displayMsg));
  const ids = await modelIds();
  ok('1d 记账后从 /v1/models 消失', !ids.includes('workbuddy/glm-4.6v'), ids.join(','));
  ok('1e 其它模型不受影响', ids.includes('workbuddy/hy3') && ids.includes('workbuddy/glm-5.0-turbo'), ids.join(','));
}

// ── 2) 11150 → 补档重试 → 客户端只看到成功 ─────────────────────────────
{
  seenEffort.length = 0;
  const { status, j } = await chat('workbuddy/glm-5.0-turbo');
  ok('2a 11150 自愈后返回 200', status === 200, `status=${status} ${JSON.stringify(j).slice(0, 120)}`);
  const tries = seenEffort.filter(s => s.model === 'glm-5.0-turbo');
  ok('2b 上游被打了两次(先失败后补档)', tries.length === 2, JSON.stringify(tries));
  ok('2c 第二次带上了默认档 medium', tries[1]?.effort === 'medium', JSON.stringify(tries));
  ok('2d 模型仍在列表里(11150 不算下线)', (await modelIds()).includes('workbuddy/glm-5.0-turbo'));
}

// ── 3) 已记账后：下一次直接带档，不再浪费一次失败往返 ───────────────────
{
  seenEffort.length = 0;
  const { status } = await chat('workbuddy/glm-5.0-turbo');
  const tries = seenEffort.filter(s => s.model === 'glm-5.0-turbo');
  ok('3a 第二次请求 200', status === 200, `status=${status}`);
  ok('3b 只打一次上游(记账生效)', tries.length === 1, JSON.stringify(tries));
  ok('3c 首打就带档', tries[0]?.effort === 'medium', JSON.stringify(tries));
}

// ── 4) 客户端自己指定档位 → 网关不许覆盖 ───────────────────────────────
{
  seenEffort.length = 0;
  await chat('workbuddy/glm-5.0-turbo', { reasoning_effort: 'high' });
  const tries = seenEffort.filter(s => s.model === 'glm-5.0-turbo');
  ok('4a 客户端档位被原样透传', tries[0]?.effort === 'high', JSON.stringify(tries));
}

// ── 5) TTL 到期后模型自动回到列表 ──────────────────────────────────────
{
  // 直接把 marks 改成一个过期的 dead
  const stale = { 'glm-4.6v': { dead: NOW - 13 * 3600, code: 11102 } };
  await fetch(`https://127.0.0.1:${MOCK_PORT}/v2/pipeline`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ requests: [{ type: 'execute', stmt: { sql: 'INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', args: [{ type: 'text', value: 'model_marks' }, { type: 'text', value: JSON.stringify(stale) }] } }] }),
  });
  const ids = await modelIds();
  ok('5a 过期标记不再隐藏模型', ids.includes('workbuddy/glm-4.6v'), ids.join(','));
}

// ── 6) 记账失败不能把对话打挂（marks 键被写成非法 JSON 也不行）────────
{
  await fetch(`https://127.0.0.1:${MOCK_PORT}/v2/pipeline`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ requests: [{ type: 'execute', stmt: { sql: 'INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', args: [{ type: 'text', value: 'model_marks' }, { type: 'text', value: 'not-json{{{' }] } }] }),
  });
  const { status } = await chat('workbuddy/hy3');
  ok('6a 坏掉的 marks 不影响正常对话', status === 200, `status=${status}`);
}

console.log('--- GW LOG (tail) ---'); console.log(gwLog.slice(-800) || '(empty)');
gw.kill('SIGTERM'); mock.close(); upstream.close();
console.log(fail ? `\n=== FAIL ${fail} ===` : '\n=== model-marks 端到端全部通过 ===');
process.exit(fail ? 1 : 0);
