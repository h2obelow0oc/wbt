/**
 * 工具调用 **name 丢失** 回归 —— minimax（Anthropic 上游）实测缺陷。
 *
 * 现象: 用 wbr 网关的 `minimax/*` 模型，一旦模型要调工具，当前步直接抛
 * `DSHA_INVALID_TOOL_CALL: missing name/id; this step was not dispatched.`
 * 会话里留下的 tool-call 块是 `{name: ""}`，这一步的工具一个都没执行。
 *
 * 根因: 网关 SSE 编码器只从 `tool-call-delta` 上取 name。而 minimax 走的是
 * Anthropic `content_block_*` 协议，`input_json_delta` 产出的 delta **从不带
 * name**；真正的 name 只在 `content_block_start`（vendor 存进 state）与
 * `content_block_stop` 的 `block-end` 里。于是 wire 上的 tool_calls 帧是
 * `{"index":0,"function":{},"id":"call_x","type":"function"}` —— **name 根本
 * 没上过网线**，客户端只能组装出空名字。
 * （OpenAI 系三家没这问题: openai-compat.ts 首片就带 name，且名字为空时一帧不发。）
 *
 * 本测试钉住三条:
 *   1) 只在 `block-end` 才拿到 name 时，SSE 必须把它补发出去；
 *   2) 名字未到之前**不许发空帧**（`"function":{}` 会让上游组装出 name:''）；
 *   3) 上游确实不给 name 时，宁可不发这个调用，也不能发出无名调用污染会话。
 */
// TS 解析钩子：必须在业务 import 前注册。本测试动态 import minimax-messages.ts，
// 它内部 `import '@deepseek-ai/dsh-llm'`（真实包名不存在），靠钩子映射到本地
// stub；没钩子则 ERR_MODULE_NOT_FOUND 且文案形似「缺包」。（2026-11-12 七红之一）
import '../worker/backends/ts-hook.mjs';
const { chunksToOpenAiSse, chunksToCompletion } = await import('../worker/backends/dsh-to-openai-sse.js');

let pass = 0, fail = 0;
const ok = (n, c, extra = '') => { c ? pass++ : fail++; console.log((c ? '✅ ' : '❌ ') + n + (extra ? '  ' + extra : '')); };

// ⚠️ ReadableStream 的每个 piece 是 Uint8Array，必须 TextDecoder 解码；
// 直接 join('') 会得到逗号分隔的字节码（本测试第一版就踩了这坑）。
const sseOf = async gen => {
  const dec = new TextDecoder();
  let out = '';
  for await (const piece of chunksToOpenAiSse(gen(), { model: 'minimax/MiniMax-M2.7-highspeed' })) {
    out += typeof piece === 'string' ? piece : dec.decode(piece, { stream: true });
  }
  return out + dec.decode();
};
const toolFrames = sse => sse.split('\n\n')
  .filter(l => l.startsWith('data: {'))
  .map(l => { try { return JSON.parse(l.slice(6)); } catch { return null; } })
  .filter(Boolean)
  .flatMap(p => (p.choices?.[0]?.delta?.tool_calls ?? []).map(tc => ({ ...tc, finish: p.choices[0].finish_reason })));

// ── 用例 1: minimax 真实形状（name 只在 block-end）─────────────────────────
async function* minimaxShape() {
  yield { type: 'block-start', index: 0, blockType: 'reasoning' };
  yield { type: 'reasoning-delta', index: 0, text: '想一下' };
  yield { type: 'block-start', index: 1, blockType: 'tool-call' };
  yield { type: 'tool-call-delta', index: 1, id: 'call_01a19f7e9b1f', argumentsDelta: '' };
  yield { type: 'tool-call-delta', index: 1, id: 'call_01a19f7e9b1f', argumentsDelta: '{"todos":[{"content":"测试"}]}' };
  yield { type: 'block-end', index: 1, block: { type: 'tool-call', id: 'call_01a19f7e9b1f', name: 'todo_write', arguments: '{"todos":[{"content":"测试"}]}' } };
  yield { type: 'finish', reason: { kind: 'tool-calls' } };
}
{
  const sse = await sseOf(minimaxShape);
  const tcs = toolFrames(sse);
  ok('1a wire 上出现 tool 名', sse.includes('"name":"todo_write"'), tcs.map(t => JSON.stringify(t.function)).join(' '));
  ok('1b 只有一帧 tool_calls（不重复发 name）', tcs.length === 1, '实际 ' + tcs.length);
  ok('1c 首帧同时带 id/name/arguments',
     tcs[0]?.id === 'call_01a19f7e9b1f' && tcs[0]?.function?.name === 'todo_write'
     && tcs[0]?.function?.arguments === '{"todos":[{"content":"测试"}]}',
     JSON.stringify(tcs[0]));
  ok('1d 没有空 function 帧', !/"function":\{\}/.test(sse), '');
  // ⚠️ 终帧的 delta 是空对象、不带 tool_calls，必须整条流里找 finish_reason。
  const finishFrames = sse.split('\n\n')
    .filter(l => l.startsWith('data: {'))
    .map(l => { try { return JSON.parse(l.slice(6)).choices?.[0]?.finish_reason; } catch { return null; } })
    .filter(v => v !== null && v !== undefined);
  ok('1e finish_reason=tool_calls', finishFrames.join(',') === 'tool_calls', JSON.stringify(finishFrames));
}
{
  const c = await chunksToCompletion(minimaxShape(), { model: 'm' });
  const m = c.choices[0].message;
  ok('1f 非流式 name 正确', m.tool_calls?.[0]?.function?.name === 'todo_write', JSON.stringify(m.tool_calls));
  ok('1g 非流式 arguments 完整',
     m.tool_calls?.[0]?.function?.arguments === '{"todos":[{"content":"测试"}]}', '');
  ok('1h 非流式 finish=tool_calls', c.choices[0].finish_reason === 'tool_calls', c.choices[0].finish_reason);
}

// ── 用例 2: OpenAI 真实形状（首片就带 name，后续只给参数增量）──────────────
async function* openaiShape() {
  yield { type: 'block-start', index: 0, blockType: 'tool-call' };
  yield { type: 'tool-call-delta', index: 0, id: 'call_A', name: 'bash', argumentsDelta: '{"command":' };
  yield { type: 'tool-call-delta', index: 0, id: 'call_A', name: 'bash', argumentsDelta: '"ls"}' };
  yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'call_A', name: 'bash', arguments: '{"command":"ls"}' } };
  yield { type: 'finish', reason: { kind: 'tool-calls' } };
}
{
  const sse = await sseOf(openaiShape);
  const tcs = toolFrames(sse);
  const names = [...sse.matchAll(/"name":"([^"]*)"/g)].map(m => m[1]);
  ok('2a name 只发一次', names.length === 1 && names[0] === 'bash', JSON.stringify(names));
  ok('2b 参数按增量拼好', tcs.length === 2 && tcs.map(t => t.function.arguments ?? '').join('') === '{"command":"ls"}',
     JSON.stringify(tcs.map(t => t.function)));
  const c = await chunksToCompletion(openaiShape(), { model: 'm' });
  ok('2c 非流式 name/args 正确',
     c.choices[0].message.tool_calls?.[0]?.function?.name === 'bash'
     && c.choices[0].message.tool_calls[0].function.arguments === '{"command":"ls"}', '');
}

// ── 用例 3: 多个工具调用，index 必须是连续下标 ────────────────────────────
async function* twoCalls() {
  yield { type: 'block-start', index: 0, blockType: 'tool-call' };
  yield { type: 'tool-call-delta', index: 0, id: 'call_1', name: 'read', argumentsDelta: '{"p":"a"}' };
  yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'call_1', name: 'read', arguments: '{"p":"a"}' } };
  yield { type: 'block-start', index: 1, blockType: 'tool-call' };
  yield { type: 'tool-call-delta', index: 1, id: 'call_2', argumentsDelta: '{"p":"b"}' };
  yield { type: 'block-end', index: 1, block: { type: 'tool-call', id: 'call_2', name: 'grep', arguments: '{"p":"b"}' } };
  yield { type: 'finish', reason: { kind: 'tool-calls' } };
}
{
  const sse = await sseOf(twoCalls);
  const tcs = toolFrames(sse);
  ok('3a 两个调用都带上名字', tcs.map(t => t.function.name).join(',') === 'read,grep', JSON.stringify(tcs.map(t => t.function)));
  ok('3b index 连续 0/1', tcs.map(t => t.index).join(',') === '0,1', JSON.stringify(tcs.map(t => t.index)));
}

// ── 用例 4: 上游全程不给 name —— 宁可不发，也不发无名调用 ──────────────────
async function* noName() {
  yield { type: 'block-start', index: 0, blockType: 'text' };
  yield { type: 'text-delta', index: 0, text: '我来调用工具' };
  yield { type: 'block-start', index: 1, blockType: 'tool-call' };
  yield { type: 'tool-call-delta', index: 1, id: 'call_q', argumentsDelta: '{"x":1}' };
  yield { type: 'block-end', index: 1, block: { type: 'tool-call', id: 'call_q', name: '', arguments: '{"x":1}' } };
  yield { type: 'finish', reason: { kind: 'tool-calls' } };
}
{
  const sse = await sseOf(noName);
  ok('4a 不发无名 tool_calls 帧', toolFrames(sse).length === 0, JSON.stringify(toolFrames(sse)));
  ok('4b 正文不受影响', sse.includes('我来调用工具'), '');
  ok('4c finish 降级为 stop（否则客户端空等到超时）', /"finish_reason":"stop"/.test(sse), '');
  ok('4d 仍以 [DONE] 收尾', sse.trimEnd().endsWith('data: [DONE]'), '');
  const c = await chunksToCompletion(noName(), { model: 'm' });
  ok('4e 非流式不发无名调用', !c.choices[0].message.tool_calls, JSON.stringify(c.choices[0].message.tool_calls));
  ok('4f 非流式 finish=stop', c.choices[0].finish_reason === 'stop', c.choices[0].finish_reason);
}

// ── 用例 5: 空 id 也必须自成一块（不能被合并成同一个调用）─────────────────
async function* emptyIds() {
  yield { type: 'block-start', index: 0, blockType: 'tool-call' };
  yield { type: 'tool-call-delta', index: 0, argumentsDelta: '{"a":1}' };
  yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: '', name: 'read', arguments: '{"a":1}' } };
  yield { type: 'block-start', index: 1, blockType: 'tool-call' };
  yield { type: 'tool-call-delta', index: 1, argumentsDelta: '{"b":2}' };
  yield { type: 'block-end', index: 1, block: { type: 'tool-call', id: '', name: 'grep', arguments: '{"b":2}' } };
  yield { type: 'finish', reason: { kind: 'tool-calls' } };
}
{
  const c = await chunksToCompletion(emptyIds(), { model: 'm' });
  const tcs = c.choices[0].message.tool_calls ?? [];
  ok('5a 两个空 id 调用各自独立', tcs.length === 2 && tcs[0].function.name === 'read' && tcs[1].function.name === 'grep',
     JSON.stringify(tcs));
  ok('5b 都补上了 id', tcs.every(t => typeof t.id === 'string' && t.id !== ''), JSON.stringify(tcs.map(t => t.id)));
}

// ── 用例 6: 端到端 —— Anthropic SSE → consumeMinimaxSse → wire ─────────────
// 这一条钉住 vendor 层本身: 名字只在 content_block_start 出现, 必须以空参数
// 的 tool-call-delta 当场宣布, 否则下游编码器永远等不到名字。
{
  const { consumeMinimaxSse } = await import('../worker/vendor/channel-pack/src/minimax-messages.ts');
  const anth = [
    'event: message_start',
    'data: {"type":"message_start","message":{"usage":{"input_tokens":10,"output_tokens":0}}}',
    '',
    'event: content_block_start',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"call_mini_1","name":"todo_write"}}',
    '',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"todos\\":[]}"}}',
    '',
    'event: content_block_stop',
    'data: {"type":"content_block_stop","index":0}',
    '',
    'event: message_delta',
    'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":5}}',
    '',
    'event: message_stop',
    'data: {"type":"message_stop"}',
    '',
  ].join('\n');
  const cfg = { label: 't', firstTokenTimeoutMs: 5000, chunkTimeoutMs: 5000 };
  const chunks = [];
  for await (const c of consumeMinimaxSse(new Response(anth, { status: 200, headers: { 'content-type': 'text/event-stream' } }), {}, cfg)) chunks.push(c);
  const nameDeltas = chunks.filter(c => c.type === 'tool-call-delta' && c.name);
  ok('6a vendor 层在起始块就发出工具名', nameDeltas.length === 1 && nameDeltas[0].name === 'todo_write',
     JSON.stringify(nameDeltas.map(c => ({ id: c.id, name: c.name, args: c.argumentsDelta }))));
  ok('6b 名字帧不带参数（避免重复计数）', nameDeltas[0]?.argumentsDelta === '', String(nameDeltas[0]?.argumentsDelta));

  const sse = await sseOf(async function* () { yield* chunks; });
  const tcs = toolFrames(sse);
  ok('6c 端到端 wire 上 name/args 都齐', tcs.length >= 1 && tcs[0].function.name === 'todo_write'
     && tcs.map(t => t.function.arguments ?? '').join('') === '{"todos":[]}', JSON.stringify(tcs.map(t => t.function)));
  const c = await chunksToCompletion((async function* () { yield* chunks; })(), { model: 'm' });
  ok('6d 非流式端到端 name 正确', c.choices[0].message.tool_calls?.[0]?.function?.name === 'todo_write',
     JSON.stringify(c.choices[0].message.tool_calls));
}

console.log('\n=== PASS ' + pass + ' / FAIL ' + fail + ' ===');
process.exit(fail ? 1 : 0);
