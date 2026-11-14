/**
 * OpenAI `chat/completions` 消息形状 → DSH harness 消息形状。
 *
 * ## 为什么需要这一层
 * wb 网关对外是 OpenAI 兼容面，客户端发来的是 OpenAI 形状；而 vendored 的
 * channel-pack 协议层（`serializeMessages` / `serializeMinimaxMessages`）只认
 * DSH 形状。两者**只在工具与图片上有差异**，其余逐字段同名：
 *
 * | 关注点 | OpenAI 入参 | DSH 形状 | 谁负责 |
 * |---|---|---|---|
 * | 工具结果 | `{role:'tool', tool_call_id}` | `{role:'tool', toolCallId}` | **本层改字段名** |
 * | 工具结果→块 | — | `normalizeHarnessMessages` 包成 `tool-result` 块 | 渠道层（免费） |
 * | 工具调用 | assistant.`tool_calls[]` | assistant.content 里 `{type:'tool-call'}` 块 | **本层** |
 * | developer 角色 | — | 渠道层直接丢弃 | 渠道层（免费） |
 * | 图片 | `{type:'image_url', image_url:{url}}` | `{type:'image', attachment:{attachmentId}}` + 映射表 | **本层** |
 *
 * ⚠️ 渠道层的 `normalizeHarnessMessages` 已经把 `role:'tool'` 包成 `tool-result` 块
 * 并丢弃 `developer`，**本层不要重复做**（做了反而多一层嵌套）。
 *
 * ## 本层独立无依赖
 * 不 import 任何 vendor TS —— 纯形状转换，可脱离解析钩子直接单测。
 * 返回的 `images` 是中立的 `Map<attachmentId, dataUrl|httpUrl>`：
 * - OpenAI 系后端直接把这张表传给 `serializeMessages`（它认完整 URL）
 * - Anthropic 系后端自己拆成 `{mediaType, data}`（见 minimax.js）
 */

/** 单调递增，保证 attachmentId 在一次请求内唯一。 */
let _seq = 0;

/**
 * OpenAI content（字符串或 parts 数组）→ DSH content 块数组。
 * @returns {{blocks: object[], images: Map<string,string>}}
 */
function convertContent(content) {
  const images = new Map();
  const blocks = [];
  if (content === null || content === undefined) return { blocks, images };
  if (typeof content === 'string') {
    if (content) blocks.push({ type: 'text', text: content });
    return { blocks, images };
  }
  if (!Array.isArray(content)) {
    blocks.push({ type: 'text', text: String(content) });
    return { blocks, images };
  }
  for (const part of content) {
    if (part === null || part === undefined) continue;
    if (typeof part === 'string') { blocks.push({ type: 'text', text: part }); continue; }
    if (typeof part !== 'object') continue;
    const t = part.type;
    if (t === 'text' || t === 'input_text') {
      const text = String(part.text ?? '');
      if (text) blocks.push({ type: 'text', text });
      continue;
    }
    // OpenAI 形状：{type:'image_url', image_url:{url} | string}
    if (t === 'image_url') {
      const raw = part.image_url;
      const url = typeof raw === 'string' ? raw : String(raw?.url ?? '');
      if (!url) continue;
      const id = `att_${++_seq}`;
      images.set(id, url);
      blocks.push({ type: 'image', attachment: { attachmentId: id } });
      continue;
    }
    // Anthropic 形状：{type:'image', source:{type:'base64', media_type, data} | {url}}
    // （WB 路径 serialize-buddy.mjs 也兼容这一形状，见其 L176）
    if (t === 'image' && part.source && typeof part.source === 'object') {
      const s = part.source;
      const url = s.type === 'base64'
        ? `data:${s.media_type || 'image/png'};base64,${s.data}`
        : String(s.url ?? '');
      if (!url) continue;
      const id = `att_${++_seq}`;
      images.set(id, url);
      blocks.push({ type: 'image', attachment: { attachmentId: id } });
      continue;
    }
    // 已是 DSH 形状（attachment 块原样透传，调用方已备映射）
    if (t === 'image' && part.attachment) { blocks.push(part); continue; }
    // 其余块原样透传，不静默丢弃 —— 让序列化层按其语义处理或报错
    blocks.push(part);
  }
  return { blocks, images };
}

/**
 * 一次 OpenAI 请求的 messages → DSH messages + 图片映射表。
 *
 * @param {Array<object>} messages OpenAI `messages` 字段
 * @returns {{messages: Array<object>, images: Map<string,string>}}
 */
export function openaiToDsh(messages) {
  const images = new Map();
  const out = [];
  for (const m of messages ?? []) {
    if (!m || typeof m !== 'object') continue;
    const role = m.role;

    // 1) 工具结果：只改字段名，包块交给渠道层的 normalizeHarnessMessages
    if (role === 'tool') {
      const toolCallId = m.tool_call_id ?? m.toolCallId ?? m.source?.callId;
      const msg = { role: 'tool', toolCallId, content: m.content };
      if (m.isError !== undefined) msg.isError = m.isError;
      out.push(msg);
      continue;
    }

    // 2) assistant：文本 / 思考 / 工具调用三者合并进 content 块数组
    if (role === 'assistant') {
      const blocks = [];
      // reasoning_content（OpenAI 扩展字段）→ reasoning 块。保留它是为了让历史里
      // 的思考不被当成正文重复下发；序列化层对 reasoning 有专门的 leak 清理。
      const reasoning = m.reasoning_content ?? m.reasoning;
      if (typeof reasoning === 'string' && reasoning) {
        blocks.push({ type: 'reasoning', text: reasoning });
      }
      const { blocks: cb, images: ci } = convertContent(m.content);
      for (const b of cb) blocks.push(b);
      for (const [k, v] of ci) images.set(k, v);
      const tcs = Array.isArray(m.tool_calls) ? m.tool_calls : [];
      for (const tc of tcs) {
        if (!tc || typeof tc !== 'object') continue;
        // OpenAI: {id, type:'function', function:{name, arguments}}
        const fn = tc.function ?? {};
        blocks.push({
          type: 'tool-call',
          id: String(tc.id ?? ''),
          name: String(fn.name ?? tc.name ?? ''),
          // arguments 必须是字符串：serializeMessages 会 normalizeToolArguments(String(...))
          arguments: typeof (fn.arguments ?? tc.arguments) === 'string'
            ? (fn.arguments ?? tc.arguments)
            : JSON.stringify(fn.arguments ?? tc.arguments ?? {}),
        });
      }
      // content 为空且无工具调用时给空数组（序列化层会输出 content:null）
      out.push({ role: 'assistant', content: blocks });
      continue;
    }

    // 3) system / user / developer：developer 原样传，由渠道层丢弃
    const { blocks, images: ci } = convertContent(m.content);
    for (const [k, v] of ci) images.set(k, v);
    out.push({ role, content: blocks });
  }
  return { messages: out, images };
}

/**
 * 把中立图片映射表转成 Anthropic 系所需的 `{mediaType, data}`。
 * `serializeMinimaxMessages` 的 `images` 参数要求裸 base64（无 `data:` 前缀）。
 *
 * @param {Map<string,string>} images attachmentId → data:/http URL
 * @returns {Map<string,{mediaType:string,data:string}>}
 */
export function imagesToInline(images) {
  const out = new Map();
  for (const [id, url] of images) {
    const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(String(url));
    if (m && m[2]) { out.set(id, { mediaType: m[1] || 'image/png', data: m[3] }); continue; }
    if (m) { // 非 base64 的 data URL：按 URL 处理，上游若不认会明确报错
      out.set(id, { mediaType: m[1] || 'application/octet-stream', data: m[3] });
      continue;
    }
    // http(s) URL：上游若支持远程取图则透传，否则序列化层会落占位文本
    out.set(id, { mediaType: 'image/url', data: String(url) });
  }
  return out;
}
