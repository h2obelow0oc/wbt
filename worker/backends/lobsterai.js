/**
 * LobsterAI（有道）渠道后端。
 *
 * 端点 \`POST {apiBase}/api/proxy/v1/chat/completions\`，标准 OpenAI 兼容 + 标准 SSE
 * （见 lobsterai-adapter.ts:11），故走共享骨架。
 *
 * ## 为什么请求头在这里自己实现，而不 import vendor 的 lobsterai.ts
 * vendor 的 `lobsterai.ts` 含 **TS 参数属性**（`constructor(private readonly ...)`，
 * 见其 L623），那是不可剥离语法 —— Node 原生 strip-only 模式直接
 * `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`。该类只是**客户端版本号缓存**，
 * 而服务端并不强校验版本号（见 lobsterai.ts 注释：Go 侧一直发假值 `0.1.0`
 * 未被拒绝），故这里用 `product.fallbackClientVersion` 即可，
 * 连同两个头函数一并按原实现复刻（同源勿漂移）。
 *
 * ⚠️ `X-LobsterAI-Client-Capabilities` **不是可有可无的元数据**：
 * 服务端按它声明的能力**过滤模型集合** —— 不带时 `kimi-k3` 不返回
 * （2026-09-17 实测，25 vs 26 个模型）。
 *
 * ## clientVersion 动态化（2026-11-03）
 * 复用 chan-checkin.js 的 resolveLobsteraiVersion（6h 缓存、打有道 update 接口），
 * 替代写死的 fallbackClientVersion，防止未来服务端开始校验版本。
 */
import { makeOpenAiBackend } from './openai-family.js';
import { LOBSTERAI } from '../vendor/channel-pack/src/lobsterai-product.ts';
import { resolveLobsteraiVersion } from '../chan-checkin.js';

/** 与 vendor lobsterai.ts 的 `LOBSTERAI_CHAT_PATH` 同值（该文件无法加载，故内联）。 */
const LOBSTERAI_CHAT_PATH = '/api/proxy/v1/chat/completions';

/** 复刻 vendor `lobsteraiChatHeaders`：auth 四头 + 两个 X-LobsterAI-Client-* 头。 */
async function chatHeaders(acc) {
  // 动态获取 clientVersion（6h 缓存），失败回退到兜底值
  const clientVersion = await resolveLobsteraiVersion(LOBSTERAI);
  return {
    Authorization: `Bearer ${acc.access_token}`,
    Accept: 'text/event-stream, application/json',
    'Content-Type': 'application/json',
    'User-Agent': LOBSTERAI.userAgent,
    'X-LobsterAI-Client-Capabilities': LOBSTERAI.clientCapabilities,
    'X-LobsterAI-Client-Version': clientVersion,
  };
}

export const backend = makeOpenAiBackend({
  id: 'lobsterai',
  label: 'LobsterAI (有道)',
  url: () => `${LOBSTERAI.apiBase}${LOBSTERAI_CHAT_PATH}`,
  headers: chatHeaders,
  models: () => LOBSTERAI.fallbackModels.map(m => ({
    id: m.id, name: m.name, context: m.contextWindow,
    maxTokens: m.maxTokens, supportsImage: !!m.supportsImage,
  })),
});
