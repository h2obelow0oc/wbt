// ===== WorkBuddy/CodeBuddy 请求体序列化 =====
// 移植自 dsh-our-free-model/vendor/channel-pack/src/buddy-adapter.ts (MIT)
// 上游来源: https://gitee.com/iJetLi/deepseek-harness-codearts
//
// 作用: 把 OpenAI 兼容客户端发来的消息序列化为 CodeBuddy/WorkBuddy 上游
// 能接受的 wire 格式, 修复以下导致 400 INVALID_REQUEST (no body) 的根因:
//
//   1. 孤儿工具调用 — assistant 带 tool_calls 但无对应 role:'tool' 结果
//      (或反过来), 上游按配对完整性校验, 缺一侧即 400, 会话从此每轮报废.
//   2. assistant 消息缺 reasoning_content 字段 — deepseek 系推理模型
//      要求该字段始终存在 (哪怕空串), 缺失即 400.
//   3. content 为空 + 有 tool_calls 时 content 必须是 null 而非空串.
//   4. content 是 parts 数组时展平为字符串 (部分上游静默丢 parts).
//   5. tool_calls 的 arguments 必须是合法 JSON 对象串.
//
// 不含图片/多模态处理 (wb-manager 客户端走纯文本) 与 course 泄漏清洗
// (dsh 插件特有的防污染逻辑, 此处无关).

/** harness 消息形状归一化 (移植自 message-shape.ts). */
function detectMessageShape(messages) {
  let sawLegacy = false;
  for (const m of messages) {
    if (m.role === "tool") return "tool-role";
    const c = m.content;
    if (Array.isArray(c) && c.some(b => b && typeof b === "object" && b.type === "tool-result")) sawLegacy = true;
  }
  return sawLegacy ? "legacy" : "none";
}

/**
 * 把 0.1.7 的一等 `role:'tool'` 消息降级为 legacy 包裹形状 (user 内嵌 tool-result 块).
 * 没有 tool 角色且无 developer 角色时零成本透传原数组.
 */
export function normalizeHarnessMessages(messages) {
  const shape = detectMessageShape(messages);
  const hasDev = messages.some(m => m.role === "developer");
  if (shape !== "tool-role" && !hasDev) return messages;
  const out = [];
  for (const m of messages) {
    if (m.role === "developer") continue;
    if (m.role !== "tool") { out.push(m); continue; }
    const source = m.source;
    const sourceCallId = typeof source === "object" && source !== null ? source.callId : undefined;
    const toolCallId = m.toolCallId ?? m.tool_call_id ?? sourceCallId;
    const block = { type: "tool-result", toolCallId, content: m.content };
    if (m.isError !== undefined) block.isError = m.isError;
    out.push({ role: "user", content: [block] });
  }
  return out;
}

/** 工具名非空才算可用 (移植自 sse.ts:81). */
function hasUsableToolName(name) {
  return typeof name === "string" && name.trim().length > 0;
}

/**
 * 归一化: 把 OpenAI 顶层字段 (assistant.tool_calls / tool.tool_call_id) 合并进
 * content 数组的 tool-call / tool-result 块. harness/pi-ai 发来的 assistant 消息
 * 工具调用在顶层 tool_calls, 不在 content 数组里; 旧版序列化器只认 content 块 →
 * 配对全失败 → tool_calls 和 tool 结果被丢弃 → 上游重新发起 → 空转.
 * 此函数在 normalizeHarnessMessages 之后运行, 让 resolveToolPairing 和
 * serializeBuddyMessages 的 content 块逻辑同时覆盖两种来源.
 */
function mergeTopLevelToolFields(messages) {
  return messages.map(m => {
    if (m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      const content = Array.isArray(m.content) ? m.content : [];
      const existing = new Set(content.filter(b => b && b.type === "tool-call").map(b => String(b.id)));
      const extra = m.tool_calls
        .filter(tc => tc && tc.id && !existing.has(String(tc.id)))
        .map(tc => ({
          type: "tool-call",
          id: String(tc.id),
          name: tc.function?.name ?? "",
          arguments: typeof tc.function?.arguments === "string" ? tc.function.arguments : JSON.stringify(tc.function?.arguments ?? {}),
        }));
      return { ...m, content: [...content, ...extra] };
    }
    if (m.role === "tool" && m.tool_call_id && !Array.isArray(m.content)) {
      // 顶层 tool 消息: content 是字符串, 包成 tool-result 块让配对逻辑识别.
      return { ...m, content: [{ type: "tool-result", toolCallId: String(m.tool_call_id), content: m.content }] };
    }
    return m;
  });
}

/**
 * 解析工具配对: 只保留 "assistant 的 tool_call id 有对应 tool 结果" 且
 * "tool 结果有对应 tool_call" 的双向配对. 单边的一律剔除.
 * 移植自 sse.ts:244 resolveToolPairing.
 */
export function resolveToolPairing(messages) {
  const normalized = mergeTopLevelToolFields(normalizeHarnessMessages(messages));
  // 收集所有 tool-result 的 id.
  const allResultIds = new Set();
  for (const m of normalized) {
    const c = Array.isArray(m.content) ? m.content : [];
    for (const b of c) {
      if (b && typeof b === "object" && b.type === "tool-result") {
        allResultIds.add(String(b.toolCallId));
      }
    }
  }
  // 一批 tool_calls 里名称可用的 + 全部拿到结果的才保留.
  const keepCallIds = new Set();
  for (const m of normalized) {
    if (m.role !== "assistant") continue;
    const c = Array.isArray(m.content) ? m.content : [];
    const calls = c.filter(b => b && typeof b === "object" && b.type === "tool-call");
    if (calls.length === 0) continue;
    const usable = calls.filter(b => hasUsableToolName(b.name));
    if (usable.length === 0) continue;
    if (usable.every(b => allResultIds.has(String(b.id)))) {
      for (const b of usable) keepCallIds.add(String(b.id));
    }
  }
  const keepResultIds = new Set();
  for (const id of keepCallIds) if (allResultIds.has(id)) keepResultIds.add(id);
  return { keepCallIds, keepResultIds };
}

/** tool arguments 必须是合法 JSON 对象串; 截断/空则回退 '{}' (移植自 sse.ts:291). */
function normalizeToolArguments(raw) {
  const trimmed = String(raw ?? "").trim();
  if (trimmed.length === 0) return "{}";
  let parsed;
  try { parsed = JSON.parse(trimmed); } catch { return "{}"; }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return "{}";
  return trimmed;
}

/** content 块数组展平为纯文本字符串 (移植自 buddy-adapter.ts:233 contentToText). */
function contentToText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(b => b && typeof b === "object" && b.type === "text")
    .map(b => String(b.text ?? ""))
    .join("");
}

/**
 * 检测 content 数组里是否含多模态块 (图片/音频/视频输入)。
 * 上游实测接受 OpenAI 原生 image_url 形状 (data: URL 与 http(s) URL 均可),
 * 命中时保留 parts 数组原样下发, 不能展平成纯文本 —— contentToText 只认
 * type:'text', 展平即等于把图片丢掉 (表现为上游收到无图请求, 模型答"看不到")。
 */
function hasMediaParts(content) {
  if (!Array.isArray(content)) return false;
  return content.some(b => b && typeof b === "object" && (
    b.type === "image_url" || b.type === "image" ||
    b.type === "input_image" || b.type === "input_audio" ||
    b.type === "audio_url" || b.type === "video_url"
  ));
}

/**
 * 把 OpenAI 多模态 parts 归一化成上游接受的形状。
 * - 原样保留 type:'text' 与 type:'image_url';
 * - 兼容 Anthropic 风格 {type:'image', source:{...}} → 转成 image_url data URL;
 * - 其余未知块丢弃 (避免上游 400)。
 */
function normalizeMediaParts(content) {
  if (!Array.isArray(content)) return content;
  const out = [];
  for (const b of content) {
    if (!b || typeof b !== "object") continue;
    if (b.type === "text") { out.push({ type: "text", text: String(b.text ?? "") }); continue; }
    if (b.type === "image_url" || b.type === "input_image") {
      const url = b.image_url && b.image_url.url ? b.image_url.url
        : (typeof b.image_url === "string" ? b.image_url : (b.url || ""));
      if (url) out.push({ type: "image_url", image_url: { url: String(url) } });
      continue;
    }
    // Anthropic 风格: {type:'image', source:{type:'base64', media_type, data}}
    if (b.type === "image" && b.source && typeof b.source === "object") {
      const s = b.source;
      if (s.type === "base64" && s.data) {
        out.push({ type: "image_url", image_url: { url: `data:${s.media_type || "image/png"};base64,${s.data}` } });
      } else if (s.type === "url" && s.url) {
        out.push({ type: "image_url", image_url: { url: String(s.url) } });
      }
      continue;
    }
    if (b.type === "audio_url" || b.type === "input_audio" || b.type === "video_url") {
      out.push({ type: b.type === "input_audio" ? "audio_url" : b.type, [b.type === "input_audio" ? "audio_url" : b.type]: b[b.type] || b.audio_url || b.video_url || b });
      continue;
    }
  }
  return out;
}

/**
 * 把 OpenAI 兼容消息序列化为 CodeBuddy/WorkBuddy wire 格式.
 * 核心适配 (移植自 buddy-adapter.ts:258 serializeMessages, 去掉图片分支):
 * - assistant 始终带 reasoning_content (推理模型缺失即 400);
 * - 空正文 + 有 tool_calls 时 content = null;
 * - 孤儿 tool_calls / tool 结果双向剔除;
 * - content 数组展平为字符串;
 * - tool_result 展开为独立 role:'tool' 消息.
 */
export function serializeBuddyMessages(messages) {
  const wire = [];
  const normalized = mergeTopLevelToolFields(normalizeHarnessMessages(messages));
  const { keepCallIds, keepResultIds } = resolveToolPairing(normalized);

  for (const message of normalized) {
    if (message.role === "assistant") {
      const content = Array.isArray(message.content) ? message.content : [];
      const toolCallBlocks = content
        .filter(b => b && typeof b === "object" && b.type === "tool-call")
        .filter(b => keepCallIds.has(String(b.id)));
      const toolCalls = toolCallBlocks.map(b => ({
        id: String(b.id),
        type: "function",
        function: { name: String(b.name), arguments: normalizeToolArguments(b.arguments) },
      }));
      const reasoning = content
        .filter(b => b && typeof b === "object" && b.type === "reasoning")
        .map(b => String(b.text ?? ""))
        .join("");
      // text 取原始 content (字符串直接透传, 数组才展平), 不能用上面被
      // 转成 [] 的 content 变量——否则字符串消息会被吞成空串.
      const text = contentToText(message.content);
      wire.push({
        role: "assistant",
        content: text.length === 0 && toolCalls.length > 0 ? null : text,
        reasoning_content: reasoning,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
      continue;
    }
    if (message.role === "system") {
      wire.push({ role: "system", content: contentToText(message.content) });
      continue;
    }
    if (message.role === "tool") {
      // legacy 形状不会到这里 (已降级); 兜底: 顶层 tool 消息直接转.
      const toolCallId = String(message.toolCallId ?? "");
      if (keepResultIds.has(toolCallId)) {
        wire.push({
          role: "tool",
          tool_call_id: toolCallId,
          content: contentToText(message.content) || "(no output)",
        });
      }
      continue;
    }
    // user: tool-result 块展开为独立 role:'tool', 其余走 user.
    const content = Array.isArray(message.content) ? message.content : [];
    const toolResults = content.filter(b => b && typeof b === "object" && b.type === "tool-result");
    const text = contentToText(message.content);
    // 多模态: 含 image_url / image 等块时保留 parts 数组下发, 否则图片会被
    // contentToText 吃掉 (它只认 type:'text'), 上游收到无图请求。
    if (hasMediaParts(message.content)) {
      const parts = normalizeMediaParts(message.content);
      if (parts.length > 0) wire.push({ role: "user", content: parts });
    } else if (text.length > 0 || toolResults.length === 0) {
      wire.push({ role: "user", content: text });
    }
    for (const result of toolResults) {
      if (!keepResultIds.has(String(result.toolCallId))) continue;
      wire.push({
        role: "tool",
        tool_call_id: String(result.toolCallId),
        content: contentToText(result.content) || "(no output)",
      });
    }
  }
  return wire;
}
