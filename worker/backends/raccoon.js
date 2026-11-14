/**
 * Raccoon（商汤小浣熊）渠道后端。
 *
 * 实测 `POST ${RACCOON.apiBase}${RACCOON.llmApiPrefix}/chat/completions`
 * 是**标准 OpenAI 兼容 + 标准 SSE**（见 raccoon-adapter.ts:6），故走共享骨架。
 *
 * 请求头由 vendor 的 `raccoonHeaders` 构造（含 X-Org-Code / X-Client-Platform，
 * 漏发会被服务端按错误客户端形态归因）。
 */
import { makeOpenAiBackend } from './openai-family.js';
import { RACCOON } from '../vendor/channel-pack/src/raccoon-product.ts';
import { raccoonHeaders } from '../vendor/channel-pack/src/raccoon.ts';

export const backend = makeOpenAiBackend({
  id: 'raccoon',
  label: 'Raccoon (商汤)',
  // 推理基址：测试/预发可以让网关指向本地 mock 上游。
  //
  // ## 为什么需要这个（2026-11-04）
  // `RACCOON.apiBase` 是 vendor 里**写死**的常量，此前只有续期/额度读了 env 覆盖。
  // 后果是「推理链路的端到端测试完全做不了」—— 想把网关指向 mock，请求仍打到真实
  // 商汤（实测 mock 一次没收到、返回真实 401）。而「多账号轮转」这种跨账号留痕的
  // 行为，纯函数单测只能证到 `account-pick.js` 的排序，证不到
  // 「这次请求真的换了 token 发出去」。
  //
  // ## 为什么用独立的 CHAT_BASE、不与续期共用 API_BASE
  // 两者的上游语义不同。共用一个变量会让 test-refresh-lock（它把
  // `RACCOON_API_BASE` 指向续期计数器）把并发 chat 也数进续期计数 ——
  // 实测 hits 1→6，那条本意是「测续期锁」的断言直接变红，且**误报成锁失效**。
  // 分开之后两条测试各测各的。
  //
  // ## 为什么不 import chan-refresh 的 override()
  // 会建出 `raccoon.js → chan-refresh.js → chan-checkin.js → chan-refresh.js`
  // 循环依赖，改变模块初始化顺序。为一行函数引一条环不值得。
  //
  // 生产：两个变量都不设 → 原样用 vendor 常量，零行为变化。
  url: () => {
    const base = process.env.RACCOON_CHAT_BASE || process.env.RACCOON_API_BASE || RACCOON.apiBase;
    return `${base}${RACCOON.llmApiPrefix}/chat/completions`;
  },
  headers: (acc) => raccoonHeaders(
    { access_token: acc.access_token, office_identity: acc.office_identity ?? '' },
    { platform: RACCOON.clientPlatform, version: RACCOON.clientVersion },
  ),
  models: () => RACCOON.fallbackModels.map(m => ({
    id: m.id, name: m.name, context: m.contextWindow,
    maxTokens: m.maxTokens, supportsImage: !!m.supportsImage,
  })),
});
