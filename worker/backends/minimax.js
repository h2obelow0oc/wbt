/**
 * MiniMax Code 渠道后端 —— **Anthropic Messages 协议**，与另外三家不同路。
 *
 * 端点 `POST {apiHost}/mavis/api/v1/llm/v1/messages`，请求体与响应流都是
 * Anthropic 形状（`messages` + `system` + `tools[].input_schema`，
 * SSE 事件 `message_start` / `content_block_delta` / `message_delta`）。
 * 故这里不能走 openai-family 骨架，需自己构造 payload 并消费 `consumeMinimaxSse`。
 *
 * ## 三个易错点（都来自线上实测，勿"简化"）
 * 1. **402 必须原样透出为 `QUOTA_EXCEEDED`**：余额不足是最常见的真实失败，
 *    归成 SERVER/AUTH 会让用户看不到"去充值"这个唯一有效动作
 *    （见 minimax-adapter.ts:420-422）。
 * 2. **只有 `MiniMax-M3.1*` 必须 adaptive thinking**：实测传 `disabled` 会被拒
 *    （`400 ... requires adaptive thinking ... (2013)`）；`MiniMax-M3` 反而不发即 200。
 *    判据按**前缀**而非全等（正式版可能叫 `M3.1`），但**不能**放宽到 `M3`
 *    —— `M3` 不需要，发了反而可能被拒。
 * 3. **图片缺失必须抛错而非静默丢弃**：`serializeMinimaxMessages` 遇到拿不到
 *    内联图的 image 块会抛错，这是**刻意的**（minimax-messages.ts:295），
 *    避免用户以为模型看到了其实没发的图。故 `images` map 必须始终传入。
 */
import { MINIMAX, MINIMAX_INFER_PATH } from '../vendor/channel-pack/src/minimax-product.ts';
import { buildMinimaxMessagesPayload, consumeMinimaxSse } from '../vendor/channel-pack/src/minimax-messages.ts';
import { httpErrorCode } from '../vendor/channel-pack/src/openai-compat.ts';
import { openaiToDsh, imagesToInline } from './openai-to-dsh.js';
import { chunksToOpenAiSse, chunksToCompletion } from './dsh-to-openai-sse.js';

/** 与 vendor `minimaxInferHeaders` 同源（该文件含其余非必要内容，未整体 vendor）。 */
function inferHeaders(acc) {
  return {
    Authorization: `Bearer ${acc.access_token}`,
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
  };
}

/** 只有这个前缀的模型必须发 adaptive thinking（见头注第 2 点）。 */
const ADAPTIVE_ONLY_PREFIX = 'MiniMax-M3.1';

/** OpenAI `tools[]` → Anthropic `input_schema` 形状。不转换会让服务端拒掉工具。 */
function toAnthropicTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  const out = [];
  for (const t of tools) {
    const f = t?.function ?? t;   // 容忍已转换过的裸形状
    if (!f || typeof f.name !== 'string') continue;
    out.push({
      name: f.name,
      ...(f.description ? { description: f.description } : {}),
      ...(f.parameters ? { parameters: f.parameters } : {}),
    });
  }
  return out.length ? out : undefined;
}

/** 把数组里的 system 消息摘出来 —— Anthropic 把 system 放顶层，不放 messages。 */
function splitSystem(messages) {
  const sys = [];
  const rest = [];
  for (const m of messages ?? []) {
    if (m?.role === 'system') sys.push(typeof m.content === 'string' ? m.content : JSON.stringify(m.content));
    else rest.push(m);
  }
  return { system: sys.length ? sys.join('\n\n') : undefined, rest };
}

/** 提取顶层采样参数（Anthropic 字段名在 payload 里已由 vendor 映射）。 */
function pickSampling(body) {
  const out = {};
  if (Number.isFinite(body?.temperature)) out.temperature = body.temperature;
  if (Number.isFinite(body?.max_tokens)) out.maxTokens = body.max_tokens;
  else if (Number.isFinite(body?.max_completion_tokens)) out.maxTokens = body.max_completion_tokens;
  if (Array.isArray(body?.stop) && body.stop.length) out.stop = body.stop;
  else if (typeof body?.stop === 'string' && body.stop) out.stop = [body.stop];
  return out;
}

function jsonError(message, status, code) {
  return new Response(JSON.stringify({ error: { message: String(message).slice(0, 600), type: 'server_error', code } }),
    { status, headers: { 'content-type': 'application/json' } });
}

export const backend = {
  id: 'minimax',
  label: 'MiniMax Code',

  models: () => MINIMAX.fallbackModels.map(m => ({
    id: m.id, name: m.name, context: m.contextWindow,
    maxTokens: m.maxTokens, supportsImage: !!m.supportsImage,
  })),

  /**
   * @param {{account:object, model:string, body:object, signal?:AbortSignal}} p
   * @returns {Promise<Response>} OpenAI 格式（SSE 或 JSON）
   */
  async chat({ account, model, body, signal }) {
    // OpenAI 语义: `stream` 缺省 false。上游恒为流式(buildMinimaxMessagesPayload
    // 写死 stream:true), 此处只决定**给客户端的形态**: true=SSE, false=聚合后 JSON。
    const stream = body?.stream === true;
    const { messages: dshMessages, images } = openaiToDsh(body?.messages ?? []);
    const { system, rest } = splitSystem(dshMessages);
    const tools = toAnthropicTools(body?.tools);

    const payload = buildMinimaxMessagesPayload({
      model,
      messages: rest,
      ...(system !== undefined ? { system } : {}),
      ...(tools !== undefined ? { tools } : {}),
      ...pickSampling(body),
      // 不传 effort → 服务端用默认档（我们没有远端 effortOptions 时宁可不发，
      // 发了非法档位会被拒；"关闭思考"这类语义未接线前不臆造）。
      requiresAdaptiveThinking: model.startsWith(ADAPTIVE_ONLY_PREFIX),
      images: imagesToInline(images),   // 必传：见头注第 3 点
    });

    let res;
    try {
      res = await fetch(`${MINIMAX.apiHost}${MINIMAX_INFER_PATH}`, {
        method: 'POST', headers: inferHeaders(account),
        body: JSON.stringify(payload), signal,
      });
    } catch (e) {
      if (signal?.aborted) throw e;
      return jsonError(`minimax: transport error: ${String(e?.message || e)}`, 502, 'TRANSPORT');
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      // ⚠️ 402 → QUOTA_EXCEEDED 原样透出（头注第 1 点）。
      const code = res.status === 402 ? 'QUOTA_EXCEEDED' : httpErrorCode(res.status, undefined);
      return new Response(JSON.stringify({
        error: { message: `minimax: HTTP ${res.status}${text ? ` — ${text.slice(0, 500)}` : ''}`,
          type: res.status === 402 ? 'insufficient_quota' : 'upstream_error',
          code, status: res.status },
      }), { status: res.status === 402 ? 402 : (res.status >= 500 ? 502 : res.status),
        headers: { 'content-type': 'application/json' } });
    }

    const chunks = consumeMinimaxSse(res, { signal }, {
      label: 'minimax',
      firstTokenTimeoutMs: 90_000,
      chunkTimeoutMs: 120_000,
      ...(Number.isFinite(body?.max_tokens) ? { maxTokens: body.max_tokens } : {}),
    });

    const qname = `minimax/${model}`;
    if (stream) {
      const includeUsage = !!body?.stream_options?.include_usage;
      return new Response(chunksToOpenAiSse(chunks, { model: qname, includeUsage }), {
        status: 200,
        headers: {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no',
        },
      });
    }
    return new Response(JSON.stringify(await chunksToCompletion(chunks, { model: qname })),
      { status: 200, headers: { 'content-type': 'application/json' } });
  },
};
