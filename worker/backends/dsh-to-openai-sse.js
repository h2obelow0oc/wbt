/**
 * DSH `StreamChunk` → OpenAI `chat.completion.chunk` 流 / 完整 completion。
 *
 * ## 为什么不能直接透传上游 SSE
 * 3 个 OpenAI 系渠道（raccoon/cline/lobsterai）的上游**本来就返回 OpenAI SSE**，
 * 看似可以原样转发。但 `consumeOpenAiSse` 里有两个**默认开启**的线上修复，
 * 透传等于把它们关掉：
 *
 *   - `isCourseLeakStripEnabled()` —— `undefined → true`（见 sse.ts:977）。
 *     中文课程广告行首泄漏，实测单会话 75 处（session-d0ec32df）；
 *   - `isReasoningLoopGuardEnabled()` —— 同样 `undefined → true`。
 *
 * 故统一走「消费 → 重发」，与 minimax（Anthropic 上游，必须转换）行为一致。
 *
 * ## 工具名必须在**任何**协议形状下都上得了网线（2026-11-03 定位）
 *
 * 原实现只从 `tool-call-delta.name` 取工具名。这条对 OpenAI 系渠道成立
 * （openai-compat.ts 首片就带 name），但对 **minimax（Anthropic Messages）不成立**：
 * `input_json_delta` 产出的 delta **从不带 name**，名字只存在于
 * `content_block_start`（vendor 存进内部 state）和 `content_block_stop` 的
 * `block-end.block.name` 里。于是网线上发出的是
 *
 * ```json
 * {"index":0,"function":{},"id":"call_01a1…","type":"function"}
 * ```
 *
 * —— 名字一次都没出现过。客户端（DSH harness）只能组装出 `{name:""}`，
 * 随即在派发前抛
 * `DSHA_INVALID_TOOL_CALL: missing name/id; this step was not dispatched.`
 * 整步的工具一个都不执行（会话里被渲染成一行 `[DSHA_INVALID_TOOL_CALL]` 文本）。
 *
 * 修法见 `ToolCallTracker`：**名字未到就不发帧**，名字一到（delta 或 block-end）
 * 一次性补齐 id + name + 已累积的全部参数；全程拿不到名字的调用**整条丢弃**
 * 并把 finish 降级为 `stop`。宁可少一个调用，也不能往会话里塞无名调用
 * （无名块会被持久化、下一轮原样重放，正是 11133 那类会话报废的前置条件）。
 *
 * ## StreamChunk 契约（来自 dsh-llm typert.host.js，勿凭想象改）
 * ```
 * | { type:'block-start';      index; blockType }
 * | { type:'text-delta';       index; text }
 * | { type:'reasoning-delta';  index; text }
 * | { type:'tool-call-delta';  index; id; name?; argumentsDelta }
 * | { type:'block-end';        index; block }
 * | { type:'usage';            usage: TokenUsage }
 * | { type:'finish';           reason: FinishReason }
 * ```
 * `FinishReason = {kind:'stop'|'tool-calls'|'max-tokens'|'aborted'|'error'}`
 */

const SSE_HEADERS = { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' };

/** DSH FinishReason → OpenAI finish_reason。 */
function mapFinishReason(reason) {
  switch (reason?.kind) {
    case 'tool-calls': return 'tool_calls';
    case 'max-tokens': return 'length';
    case 'aborted':
    case 'error': return 'stop';   // 通道已在上游报错，此处不编造 filter 语义
    default: return 'stop';
  }
}

/** DSH TokenUsage → OpenAI usage 字段名。 */
function mapUsage(u) {
  if (!u || typeof u !== 'object') return undefined;
  const prompt = u.inputTokens ?? 0;
  const completion = u.outputTokens ?? 0;
  const out = {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: u.totalTokens ?? (prompt + completion),
  };
  if (u.cacheReadTokens) out.prompt_tokens_details = { cached_tokens: u.cacheReadTokens };
  if (u.reasoningTokens) out.completion_tokens_details = { reasoning_tokens: u.reasoningTokens };
  return out;
}

/**
 * 工具调用状态机 —— 流式与非流式共用同一份，保证两种形态口径一致。
 *
 * 每个 DSH block `index` 一份状态：
 *   - `args`  —— 已累积的参数（真相）
 *   - `sent`  —— 已上行给客户端的参数**字符数**
 *   - `announced` —— 是否已在网线上出现过（OpenAI 约定 id/name 只在首帧给一次）
 *
 * 产出统一是「OpenAI `tool_calls[]` 片段」：
 *   `{ index, id?, type?, function:{ name?, arguments? } }`
 */
class ToolCallTracker {
  constructor() {
    /** @type {Map<number, {index:number,id:string,name:string,args:string,sent:number,announced:boolean,skipped:boolean}>} */
    this.blocks = new Map();
    this.nextIndex = 0;
    this.minted = 0;
  }

  _state(dshIndex) {
    let st = this.blocks.get(dshIndex);
    if (st === undefined) {
      st = { index: this.nextIndex++, id: '', name: '', args: '', sent: 0, announced: false, skipped: false };
      this.blocks.set(dshIndex, st);
    }
    return st;
  }

  /**
   * 上游没给 id 时自铸一个。
   * ⚠️ 不能留空：harness 的 `block.id.trim() !== ''` 校验会把空 id 判成
   * INVALID_TOOL_CALL；空 id 还会让「同一批两个无 id 调用」在客户端被按 id
   * 合并成一个。
   */
  _mintId() {
    this.minted += 1;
    return `call_wb_${this.minted}`;
  }

  /** 宣布一个调用：一次性补齐 id + name + 已累积参数。 */
  _announce(st) {
    if (st.announced || !st.name) return [];
    st.announced = true;
    if (!st.id) st.id = this._mintId();
    const part = { index: st.index, id: st.id, type: 'function', function: { name: st.name } };
    if (st.args !== '') part.function.arguments = st.args;
    st.sent = st.args.length;
    return [part];
  }

  /** @param {{index:number,id?:string,name?:string,argumentsDelta?:string}} chunk */
  delta(chunk) {
    const st = this._state(chunk.index);
    const fragment = typeof chunk.argumentsDelta === 'string' ? chunk.argumentsDelta : '';
    if (typeof chunk.id === 'string' && chunk.id !== '') st.id = chunk.id;

    if (st.announced) {
      if (fragment === '') return [];
      st.args += fragment;
      st.sent += fragment.length;
      return [{ index: st.index, function: { arguments: fragment } }];
    }
    if (st.skipped) return [];   // 已判死：不接收后续数据，也不再发帧

    // 未宣布阶段：只累积，等名字
    if (typeof chunk.name === 'string' && chunk.name !== '') st.name = chunk.name;
    st.args += fragment;
    return st.name ? this._announce(st) : [];
  }

  /** @param {number} dshIndex @param {object} block 组装完成的 ContentBlock */
  blockEnd(dshIndex, block) {
    const st = this._state(dshIndex);
    if (typeof block?.id === 'string' && block.id !== '') st.id = block.id;
    if (typeof block?.name === 'string' && block.name.trim() !== '') st.name = block.name;

    // block-end 的 arguments 是权威全文；补齐可能没走 delta 的尾巴。
    let tail = '';
    if (typeof block?.arguments === 'string' && block.arguments !== st.args) {
      if (block.arguments.startsWith(st.args)) {
        tail = block.arguments.slice(st.args.length);
        st.args = block.arguments;
      } else if (!st.announced) {
        st.args = block.arguments;   // 与已累积不一致且尚未上行：以 block-end 为准
      }
    }

    if (!st.announced) {
      if (!st.name) {
        // 全程没有名字 —— 丢弃，且让 finish 降级（见 finishReason）。
        st.skipped = true;
        return [];
      }
      return this._announce(st);
    }
    if (tail !== '') {
      st.sent += tail.length;
      return [{ index: st.index, function: { arguments: tail } }];
    }
    return [];
  }

  /** 流结束时把还没宣布的块做最后一次尝试（名字可能只在 block-end 里）。 */
  finalize() {
    const parts = [];
    for (const st of this.blocks.values()) {
      if (st.announced || st.skipped) continue;
      if (st.name) parts.push(...this._announce(st));
      else st.skipped = true;
    }
    return parts;
  }

  hasAnnounced() {
    for (const st of this.blocks.values()) if (st.announced) return true;
    return false;
  }

  /**
   * 上游声称 `tool-calls` 但一个可用调用都没有（全被丢弃）时降级为 `stop`：
   * 否则客户端会挂着等一个永不到来的工具结果，直到超时。
   */
  finishReason(reason) {
    if (reason?.kind === 'tool-calls' && !this.hasAnnounced()) return { kind: 'stop' };
    return reason;
  }
}

/**
 * 流式编码器：逐 chunk 吐出 OpenAI SSE 帧。
 *
 * 工具调用一侧交给 `ToolCallTracker`（见头注：名字可能只在 block-end 才出现）；
 * 文本/思考/usage 直出。
 */
export class OpenAiSseEncoder {
  constructor({ model, id, created, includeUsage = false }) {
    this.model = String(model ?? 'unknown');
    this.id = id || `chatcmpl-${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
    this.created = created || Math.floor(Date.now() / 1000);
    this.includeUsage = includeUsage;
    this.tracker = new ToolCallTracker();
    this.sentAny = false;
    this._finished = false;
  }

  _frame(payload) {
    this.sentAny = true;
    return `data: ${JSON.stringify(payload)}\n\n`;
  }

  _chunk(delta, finishReason = null, usage) {
    const c = { id: this.id, object: 'chat.completion.chunk', created: this.created, model: this.model,
      choices: [{ index: 0, delta, finish_reason: finishReason }] };
    if (usage) c.usage = usage;
    return c;
  }

  /** 把一个或多个 `tool_calls[]` 片段编成帧（每个片段一帧）。 */
  _toolFrames(parts) {
    let out = '';
    for (const part of parts) out += this._frame(this._chunk({ tool_calls: [part] }));
    return out;
  }

  /** @param {object} chunk StreamChunk @returns {string} SSE 帧（可能为空串） */
  encode(chunk) {
    if (!chunk || typeof chunk !== 'object') return '';
    switch (chunk.type) {
      case 'text-delta':
        return this._frame(this._chunk({ content: String(chunk.text ?? '') }));

      case 'reasoning-delta':
        // reasoning_content 是 OpenAI 扩展字段，DSH 客户端按它回显思考。
        return this._frame(this._chunk({ reasoning_content: String(chunk.text ?? '') }));

      case 'tool-call-delta':
        return this._toolFrames(this.tracker.delta(chunk));

      case 'usage': {
        if (!this.includeUsage) return '';
        const u = mapUsage(chunk.usage);
        return u ? this._frame({ id: this.id, object: 'chat.completion.chunk', created: this.created,
          model: this.model, choices: [], usage: u }) : '';
      }

      case 'finish': {
        // 先把迟到的名字补发，再决定 finish_reason（降级判据依赖「有没有可执行调用」）。
        let out = this._toolFrames(this.tracker.finalize());
        this._finished = true;
        out += this._frame(this._chunk({}, mapFinishReason(this.tracker.finishReason(chunk.reason))));
        return out;
      }

      case 'block-start':
        return '';   // OpenAI 流无对应概念，只作观测用

      case 'block-end':
        if (chunk.block?.type === 'tool-call') return this._toolFrames(this.tracker.blockEnd(chunk.index, chunk.block));
        return '';

      default:
        return '';
    }
  }

  /** 收尾：补一个终帧并发 `[DONE]`。 */
  end() {
    let out = this._toolFrames(this.tracker.finalize());
    // 上游没发 finish（如中途断流）时补一个终帧, 否则客户端会一直等到超时。
    // 若刚补发了工具调用，终帧必须是 tool_calls，客户端才会去执行。
    if (!this._finished) out += this._frame(this._chunk({}, this.tracker.hasAnnounced() ? 'tool_calls' : 'stop'));
    out += 'data: [DONE]\n\n';
    return out;
  }

  markFinished() { this._finished = true; }
}

/**
 * 把 StreamChunk 异步流编码成 OpenAI SSE `ReadableStream`。
 * @param {AsyncIterable<object>} chunks
 * @param {{model:string, includeUsage?:boolean}} opts
 */
export function chunksToOpenAiSse(chunks, opts) {
  const enc = new OpenAiSseEncoder(opts);
  const encoder = new TextEncoder();
  return new ReadableStream({
    async pull(controller) {
      try {
        for await (const c of chunks) {
          if (c?.type === 'finish') enc.markFinished();
          const frame = enc.encode(c);
          if (frame) controller.enqueue(encoder.encode(frame));
        }
        controller.enqueue(encoder.encode(enc.end()));
        controller.close();
      } catch (e) {
        // 中途失败也要让客户端看到终帧, 否则会挂死在等流上。
        try {
          controller.enqueue(encoder.encode(
            `data: ${JSON.stringify({ error: { message: String(e?.message || e).slice(0, 400), type: 'server_error' } })}\n\n`));
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        } catch { /* 控制器已关 */ }
        controller.close();
      }
    },
  });
}

/**
 * 把 StreamChunk 流聚合成**非流式** completion JSON。
 * @param {AsyncIterable<object>} chunks
 * @param {{model:string}} opts
 */
export async function chunksToCompletion(chunks, opts) {
  const tracker = new ToolCallTracker();
  const id = `chatcmpl-${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
  const created = Math.floor(Date.now() / 1000);
  const textParts = [];
  const reasoningParts = [];
  const toolParts = new Map();   // openai index → {id,type,function}
  let finish = 'stop';
  let usage;

  const absorb = (parts) => {
    for (const part of parts) {
      const tc = toolParts.get(part.index)
        ?? { id: part.id ?? '', type: 'function', function: { name: '', arguments: '' } };
      if (part.id) tc.id = part.id;
      if (part.type) tc.type = part.type;
      if (part.function?.name) tc.function.name = part.function.name;
      if (part.function?.arguments) tc.function.arguments += part.function.arguments;
      toolParts.set(part.index, tc);
    }
  };

  for await (const c of chunks) {
    switch (c?.type) {
      case 'text-delta': textParts.push(String(c.text ?? '')); break;
      case 'reasoning-delta': reasoningParts.push(String(c.text ?? '')); break;
      case 'tool-call-delta': absorb(tracker.delta(c)); break;
      case 'block-end':
        if (c.block?.type === 'tool-call') absorb(tracker.blockEnd(c.index, c.block));
        break;
      case 'usage': usage = mapUsage(c.usage); break;
      case 'finish': finish = mapFinishReason(tracker.finishReason(c.reason)); break;
      default: break;
    }
  }
  absorb(tracker.finalize());

  const message = { role: 'assistant', content: textParts.length ? textParts.join('') : null };
  if (reasoningParts.length) message.reasoning_content = reasoningParts.join('');
  if (toolParts.size) {
    message.tool_calls = [...toolParts.keys()].sort((a, b) => a - b).map(i => toolParts.get(i));
    // 有工具调用时 finish_reason 必须是 tool_calls, 否则客户端不会去执行工具。
    if (finish === 'stop') finish = 'tool_calls';
    if (message.content === null) delete message.content;
  }
  return {
    id, object: 'chat.completion', created, model: String(opts?.model ?? 'unknown'),
    choices: [{ index: 0, message, finish_reason: finish }],
    ...(usage ? { usage } : {}),
  };
}

export { SSE_HEADERS, mapFinishReason, mapUsage };
