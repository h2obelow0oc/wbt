/**
 * Cline 渠道后端。
 *
 * 实测 `POST {apiBase}/api/v1/chat/completions` 是标准 OpenAI 兼容 + 标准 SSE
 * （见 cline-adapter.ts:6-9），故走共享骨架。两点差异已由协议层吸收：
 *   1. 鉴权头是 `Bearer workos:<jwt>` —— `clineBearerValue` 自动补前缀，
 *      **前缀不可剥**（见 cline.ts:178）；
 *   2. 思考字段是 `delta.reasoning` 而非 `delta.reasoning_content`
 *      —— `consumeOpenAiSse` 已同时兼容两者。
 *
 * `Accept` 必须覆盖成 `text/event-stream`：`clineHeaders` 默认给
 * `application/json`（它还要服务余额查询等 JSON 端点）。
 *
 * ## ⚠️ 模型目录必须**动态拉取**（2026-11-03 用户报障）
 * 用户：「cline 在 ofm 插件显示 4 个免费，总数 31，网关上总共才 3 个」。
 * 原来这里只用 `CLINE.fallbackModels`（**静态兜底表**），而那张表里的
 * `stealth/space-bunny-alpha`、`cline-free/mimo-v2.6-flash`、
 * `cline-free/muse-spark-1.3-contributor` **全部已被上游下线**
 * （实测远端 `recommended-models` 的 `free` 现在是
 *  `reflection/beam-free`、`cline-free/nemotron-3.5-super-vl`、
 *  `nvidia/nemotron-3.5-lightning-free`、`cline-free/solar-mini4`）。
 * 后果不只是"少"，而是**列出来的三个全用不了**（实测三个都报错）。
 *
 * 故这里接 `cline-models.ts` 的远端目录（与 OFM 同一份实现）：
 *   - `recommended-models` 是**免费集合的唯一权威**（`/models` 的 434 个 id
 *     里根本没有 `cline-free/*`，只调 `/models` 会看不到任何免费模型）；
 *   - `/models` 给全量 id；
 *   - 两者独立容错，任一挂掉仍能出列表。
 * 拉取失败（网络/无凭据）时自动回退静态兜底表 —— 与 OFM 的契约一致。
 */
import { makeOpenAiBackend } from './openai-family.js';
import { CLINE, CLINE_CHAT_PATH } from '../vendor/channel-pack/src/cline-product.ts';
import { clineHeaders } from '../vendor/channel-pack/src/cline.ts';
import { loadClineModels, clineDisplayName } from '../vendor/channel-pack/src/cline-models.ts';

/** 目录缓存 TTL：远端模型上下架不频繁，但也不能缓存一整天。 */
const CATALOG_TTL_MS = 30 * 60 * 1000;
/** 缓存随账号 token 一起失效 —— 不同账号看到的可见模型可能不同。 */
let _cat = { at: 0, key: '', models: null };

/** 静态兜底（远端拉不到时用；与 OFM 的 fallbackCatalog 同语义）。 */
function fallbackCatalog() {
  return CLINE.fallbackModels.map(m => ({
    id: m.id, name: m.isFree ? `${m.name} · 免费` : m.name,
    context: m.contextWindow, maxTokens: m.maxTokens, supportsImage: !!m.supportsImage,
  }));
}

/**
 * 取 cline 模型目录（远端优先，失败回退静态表）。
 *
 * ⚠️ **不抛错**：目录服务抖动不该让整个渠道 500 —— 模型列表是建议性的，
 * 真正的可用性由上游 chat 决定。拉不到就退回兜底表并留给上层日志。
 *
 * @param {object} [account] 有凭据时才能拉 `/models`（它需要认证）
 */
export async function clineCatalog(account) {
  const key = account ? `${account.id || ''}:${String(account.access_token || '').slice(-12)}` : '';
  if (_cat.models && _cat.key === key && Date.now() - _cat.at < CATALOG_TTL_MS) return _cat.models;
  let models;
  try {
    const credential = account ? { access_token: account.access_token } : undefined;
    const r = await loadClineModels(CLINE, credential === undefined ? {} : { credential });
    models = r.models.map(m => ({
      id: m.id, name: clineDisplayName(m),
      context: m.contextWindow, maxTokens: m.maxTokens, supportsImage: !!m.supportsImage,
    }));
  } catch {
    return fallbackCatalog();
  }
  if (!models.length) return fallbackCatalog();
  _cat = { at: Date.now(), key, models };
  return models;
}

export const backend = makeOpenAiBackend({
  id: 'cline',
  label: 'Cline',
  url: () => `${CLINE.apiBase}${CLINE_CHAT_PATH}`,
  headers: (acc) => clineHeaders({ access_token: acc.access_token }, CLINE, { Accept: 'text/event-stream' }),
  // ⚠️ 同步返回：骨架的三处调用点都是同步 `models()`。远端目录由
  // `warmCatalog()` 在请求入口预热并写入缓存，这里只读缓存/兜底。
  models: () => (_cat.models && Date.now() - _cat.at < CATALOG_TTL_MS ? _cat.models : fallbackCatalog()),
});
// ⚠️ 必须**模块级导出**：骨架 makeOpenAiBackend 只返回
// {id,label,models,chat}，挂在 backend 上的额外字段会被丢掉（实测 undefined）。
// index_turso 在列模型前调它预热远端目录（异步），之后 models() 读到缓存。
