/**
 * 非流式回归 —— raccoon 实测缺陷。
 *
 * 现象: `raccoon + stream:true` ✅；`stream:false` ❌ 报
 * 「响应不是 SSE（没有任何 data: 帧）」，而上游其实 HTTP 200、content 正确。
 * 根因: 上游非流式回一整包 JSON，解析器只认 `data:` 行，且 leftover `buffer`
 * 在循环后**从不 flush** → 整包被静默丢弃。
 *
 * 修法: 可识别的 JSON completion 重包成单帧 SSE，复用原解析路径。
 * 三条硬约束由本测试守：
 *   1) 非流式 JSON 整包必须能出正文与 finish；
 *   2) 真 SSE 不受影响；
 *   3) 错误 JSON（无 choices）**仍要报错**，不许被吞成"成功"。
 */
// TS 解析钩子（vendor NodeNext 内部 `./x.js` 说明符 → 磁盘 `.ts`）。
// 必须在任何业务 import 之前注册，否则渠道协议模块报 ERR_MODULE_NOT_FOUND
// 且文案形似「缺文件」——2026-11-12 的 6 条红全因于此。生产由 index_turso.js
// 的 ensureTsHook() 兜底，测试入口必须自带。
import '../worker/backends/ts-hook.mjs';
const { consumeOpenAiSse } = await import('../worker/vendor/channel-pack/src/openai-compat.ts');
const cfg = { label: 't', firstTokenTimeoutMs: 5000, chunkTimeoutMs: 5000 };
const drain = async resp => { const out = []; for await (const c of consumeOpenAiSse(resp, {}, cfg)) out.push(c); return out; };
const textOf = chunks => chunks.filter(c => c.type === 'text-delta').map(c => c.text).join('');

let pass = 0, fail = 0;
const ok = (n, c, extra = '') => { c ? pass++ : fail++; console.log((c ? '✅ ' : '❌ ') + n + (extra ? '  ' + extra : '')); };

const completion = JSON.stringify({
  choices: [{ message: { role: 'assistant', content: '通了' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
});

// 1) 非流式 JSON 整包 → 必须出正文与 finish
try {
  const chunks = await drain(new Response(completion, { status: 200, headers: { 'content-type': 'application/json' } }));
  ok('1a 非流式 JSON 出正文', textOf(chunks) === '通了', JSON.stringify(textOf(chunks)));
  const fin = chunks.find(c => c.type === 'finish');
  ok('1b 非流式 JSON 出 finish:stop', !!fin && fin.reason?.kind === 'stop', fin ? JSON.stringify(fin.reason) : '无 finish');
  ok('1c usage 被带出', chunks.some(c => c.type === 'usage'), '');
} catch (e) {
  ok('1a 非流式 JSON 出正文', false, '抛错: ' + String(e.message).slice(0, 140));
  ok('1b 非流式 JSON 出 finish:stop', false, '抛错');
  ok('1c usage 被带出', false, '抛错');
}

// 2) 真 SSE 不受影响
try {
  const sse = 'data: {"choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n';
  const chunks = await drain(new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } }));
  ok('2a 真 SSE 不受影响', textOf(chunks) === 'hi', JSON.stringify(textOf(chunks)));
} catch (e) {
  ok('2a 真 SSE 不受影响', false, '抛错: ' + String(e.message).slice(0, 140));
}

// 3) 错误 JSON（无 choices）必须仍报错，不许被吞成成功
//    这条同时守住「读过 .text() 后原 body 已锁死」的坑 —— 若不重包回一个新
//    Response，这里会炸 `ReadableStream is locked` 而不是原来的「响应不是 SSE」。
try {
  await drain(new Response(JSON.stringify({ error: { message: 'bad' } }), { status: 200, headers: { 'content-type': 'application/json' } }));
  ok('3a 错误 JSON 仍报错', false, '被吞成了成功');
} catch (e) {
  ok('3a 错误 JSON 仍报错', String(e.message).includes('不是 SSE'), String(e.message).slice(0, 110));
}

// 4) 非 JSON 文本（HTML 错误页）也不能把 body 锁死
try {
  await drain(new Response('<html>502</html>', { status: 200, headers: { 'content-type': 'text/html' } }));
  ok('4a HTML 错误页仍报错', false, '被吞成了成功');
} catch (e) {
  ok('4a HTML 错误页仍报错', String(e.message).includes('不是 SSE') || String(e.message).includes('locked') === false,
     String(e.message).slice(0, 110));
}

// 5) **嵌套 data 信封**（cline 实测形状）—— 只认平铺会让它一直报「不是 SSE」
try {
  const nested = JSON.stringify({ data: { choices: [{ message: { role: 'assistant', content: '嵌套通了' }, finish_reason: 'stop' }], id: 'gen-1' } });
  const chunks = await drain(new Response(nested, { status: 200, headers: { 'content-type': 'application/json' } }));
  ok('5a 嵌套 {data:{choices}} 也能出正文', textOf(chunks) === '嵌套通了', JSON.stringify(textOf(chunks)));
} catch (e) {
  ok('5a 嵌套 {data:{choices}} 也能出正文', false, '抛错: ' + String(e.message).slice(0, 120));
}

console.log('\n=== PASS ' + pass + ' / FAIL ' + fail + ' ===');
process.exit(fail ? 1 : 0);
