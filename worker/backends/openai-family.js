/**
 * OpenAI 系渠道的共享执行骨架 —— raccoon / cline / lobsterai 三家共用。
 *
 * ## 为什么三家能共用
 * 实测三家的推理端点都是**标准 OpenAI 兼容 + 标准 SSE**：
 *   - raccoon:   `POST {apiBase}/api/web/llm/v2/chat/completions`
 *   - cline:     `POST {apiBase}/api/v1/chat/completions`
 *   - lobsterai: `POST {apiBase}/api/proxy/v1/chat/completions`
 * 故差异只在 URL 与请求头，消息序列化与 SSE 消费完全一致。
 *
 * ## 请求方向（客户端 → 上游）
 * OpenAI 入参 → `openaiToDsh` → `serializeMessages` → OpenAI wire。
 * 看似绕了一圈，实际是为了拿到 DSH 序列化层里**默认开启**的修复
 * （工具孤儿配对、course-leak 清理等，见 openai-to-dsh.js 头注）。
 *
 * ## 响应方向（上游 → 客户端）
 * `consumeOpenAiSse` → StreamChunk → `chunksToOpenAiSse`/`chunksToCompletion`。
 * ⚠️ 不能透传：透传会绕过 `isCourseLeakStripEnabled()`（默认 true）等修复。
 */
import { serializeMessages, consumeOpenAiSse, errorMessage, errorDetail, httpErrorCode } from '../vendor/channel-pack/src/openai-compat.ts';
import { openaiToDsh } from './openai-to-dsh.js';
import { chunksToOpenAiSse, chunksToCompletion } from './dsh-to-openai-sse.js';

/** 等待首 token / chunk 间隔的空闲超时（毫秒）。免费渠道偶发长排队，给足余量。 */
const FIRST_TOKEN_TIMEOUT_MS = 90_000;
const CHUNK_TIMEOUT_MS = 120_000;

/** 只透传客户端请求体里上游认识的采样/工具字段，其余（含 model/messages/stream）本层接管。 */
const PASSTHROUGH_FIELDS = [
  'temperature', 'top_p', 'max_tokens', 'max_completion_tokens', 'n',
  'tools', 'tool_choice', 'stop', 'presence_penalty', 'frequency_penalty',
  'seed', 'response_format', 'stream_options', 'user',
];

function buildUpstreamBody({ clientBody, model, wireMessages, stream }) {
  const out = { model, messages: wireMessages, stream };
  for (const k of PASSTHROUGH_FIELDS) {
    if (clientBody[k] !== undefined && clientBody[k] !== null) out[k] = clientBody[k];
  }
  // ⚠️ tools 必须真的在请求体**顶层**：Qoder/TRAE 都因漏发而让模型在正文里
  // 臆造 XML 工具调用，harness 认不出 → 任务终止（见 raccoon-adapter.ts:406）。
  return out;
}

function jsonError(message, status, code) {
  return new Response(JSON.stringify({ error: { message: String(message).slice(0, 600), type: 'server_error', code } }), {
    status, headers: { 'content-type': 'application/json' },
  });
}

/**
 * 造一个 OpenAI 系渠道后端。
 *
 * @param {object} cfg
 * @param {string} cfg.id 渠道 id（同时是模型 ID 前缀）
 * @param {string} cfg.label 展示名（错误消息前缀）
 * @param {(account: object) => string} cfg.url 由账号拼出推理端点
 * @param {(account: object) => Promise<Record<string,string>> | Record<string,string>} cfg.headers 由账号拼出请求头（支持 async）
 * @returns {{id:string,label:string,models:()=>Array,chat:Function}}
 */
export function makeOpenAiBackend({ id, label, url, headers, models }) {
  return {
    id,
    label,
    models,

    /**
     * @param {{account:object, model:string, body:object, signal?:AbortSignal}} p
     * @returns {Promise<Response>} OpenAI 格式（SSE 或 JSON）
     */
    async chat({ account, model, body, signal }) {
      // OpenAI 语义: `stream` 缺省为 **false**。此处读的是客户端原始 body
      // (index_turso 只在 WB 分支才强制 stream=true), 故按标准判 `=== true`。
      const stream = body?.stream === true;
      const { messages: dshMessages, images } = openaiToDsh(body?.messages ?? []);
      const wireMessages = serializeMessages(dshMessages, images);

      // 支持 async headers（如 lobsterai 的动态 clientVersion）
      const h = await headers(account);
      
      let res;
      try {
        res = await fetch(url(account), {
          method: 'POST',
          // ⚠️ `Accept` 必须**放在展开之后**: raccoonHeaders/clineHeaders 自带
          // `Accept: application/json`(它们还要服务 JSON 端点), 放前面会被覆盖掉,
          // SSE 请求拿到 JSON 头。原适配器也是这样显式覆盖的。
          headers: { ...h, Accept: stream ? 'text/event-stream' : 'application/json' },
          body: JSON.stringify(buildUpstreamBody({ clientBody: body ?? {}, model, wireMessages, stream })),
          signal,
        });
      } catch (e) {
        if (signal?.aborted) throw e;
        return jsonError(`${label}: transport error: ${String(e?.message || e)}`, 502, 'TRANSPORT');
      }

      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        // ⚠️ 必须用 `errorDetail`（它专门解析**错误体 JSON**），不能把
        // `JSON.parse` 的结果丢给 `errorMessage`：后者只认 `instanceof Error`，
        // 普通对象会被 `String()` 成字面量 **`[object Object]`** ——
        // 用户实测 cline 所有失败都显示 `Cline: [object Object]`，等于没给原因。
        // `errorDetail` 认 `{code/message/msg/error}` 四种键，且 `error` 可能是
        // 字符串也可能是嵌套对象（cline 地域限制那种）。
        const msg = detail ? errorDetail(detail) : '';
        const code = httpErrorCode(res.status, undefined);
        return new Response(JSON.stringify({
          error: { message: `${label}: ${String(msg || res.statusText).slice(0, 600)}`,
            type: 'upstream_error', code, status: res.status },
        }), { status: res.status >= 500 ? 502 : res.status, headers: { 'content-type': 'application/json' } });
      }

      const chunks = consumeOpenAiSse(res, { signal }, {
        label: id,
        firstTokenTimeoutMs: FIRST_TOKEN_TIMEOUT_MS,
        chunkTimeoutMs: CHUNK_TIMEOUT_MS,
        ...(Number.isFinite(body?.max_tokens) ? { maxTokens: body.max_tokens } : {}),
      });

      if (stream) {
        const includeUsage = !!body?.stream_options?.include_usage;
        return new Response(chunksToOpenAiSse(chunks, { model: `${id}/${model}`, includeUsage }), {
          status: 200,
          headers: {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-cache',
            connection: 'keep-alive',
            'x-accel-buffering': 'no',
          },
        });
      }
      const completion = await chunksToCompletion(chunks, { model: `${id}/${model}` });
      return new Response(JSON.stringify(completion), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  };
}
