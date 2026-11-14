/**
 * 模型「上游已下线」与「需显式思考档」的**运行时记忆**（纯函数 + 无副作用）。
 *
 * ## 为什么需要它（2026-11-03 线上）
 * `/v3/config` 的 `models[]` 只是**目录**，不等于**可用**。实测 32 条里 12 条
 * 打 `/v2/chat/completions` 直接 400：
 *
 * | code | 上游原文 | 含义 |
 * |---|---|---|
 * | 11102 | `model [glm-4.6v] service info not found` | 该模型**没有注册给 CLI agent** |
 * | 11103 | `Backend [maas] is not supported` | 图片/视频模型，不是 chat 模型 |
 * | 11150 | `the reasoning effort value is not supported` | 只是**缺** `reasoning_effort`，补上就 200 |
 *
 * 11102 的判据实证：`/v3/config` 的 `agents[0].models`（16 条）就是 CLI agent 的
 * **service 白名单** —— 白名单外的模型 11/16 条必挂 11102，白名单内的 15/16 可用。
 * 但白名单**不是**充分条件：仍有 5 条（default / deepseek-v4-flash /
 * deepseek-v3-2-volc / kimi-k2.5 / hunyuan-chat）在白名单外却可用，
 * 所以**不能**用白名单直接过滤（会把好的也藏掉）。→ 只按**真实失败**记账。
 *
 * ## 记账语义
 *   - `dead`：按 `模型id(+|g)` 记，带 TTL。TTL 内从 `/v1/models` 隐藏，
 *     过期自动重新出现（上游把模型接回来时不需要人工清）。
 *   - `needsEffort`：该模型必须显式带 `reasoning_effort` 才能用。首次撞 11150
 *     时补一次并记住，之后直接注入，不再浪费一次往返。
 *
 * ⚠️ 记账是**尽力而为**：KV 写失败绝不能让一次正常对话失败；
 * 记账只是**减少**踩坑次数，不是正确性的前提。
 */

/** 已下线标记的有效期：12 小时。上游接回来时会自动复现，不必人工清理。 */
export const DEAD_TTL_S = 12 * 3600;

/** 11102 = 模型没注册；11103 = 后端不支持（图片/视频）。都算「不可 chat」。 */
export const DEAD_CODES = new Set([11102, 11103]);

/** 11150 = 缺/错 reasoning effort，属于**参数可修**，不是模型不可用。 */
export const EFFORT_CODE = 11150;

/** 该上游 code 是否表示「这个模型根本不能走 chat」。 */
export function isDeadCode(code) {
  return DEAD_CODES.has(Number(code));
}

/** 记账键：默认行与 `[g]` 行分开 —— 同一个模型 CN 挂了国际可能还活着。 */
export function markKey(modelId, srcTag) {
  const id = String(modelId ?? '');
  if (!id) return '';
  return srcTag === 'g' ? `${id}|g` : id;
}

/** 一条 dead 标记是否仍有效（过了 TTL 就当没记过，让模型重新出现在列表里）。 */
export function isDead(mark, nowSec) {
  if (!mark || typeof mark !== 'object') return false;
  if (typeof mark.dead !== 'number') return false;
  return (nowSec - mark.dead) < DEAD_TTL_S;
}

/** 该模型是否被记过「必须显式带思考档」。 */
export function needsEffort(mark) {
  return !!(mark && typeof mark === 'object' && mark.needsEffort);
}

/**
 * 撞 11150 之后要补的思考档。
 *
 * 优先用上游元数据里的默认档（`reasoning.effort` 或 `reasoning.defaultEffort`），
 * 元数据缺失才回落 `medium`。**客户端自己已经指定过档位时返回 undefined** ——
 * 那种情况下再补一个档就是我们跟客户端抢方向盘。
 *
 * @param {{effort?:string}|null} modelMeta aggModels 里带出的模型元数据
 * @param {object} body 客户端原始请求体
 * @returns {string|undefined} 要补的档位；undefined = 不该补
 */
export function resolveEffort(modelMeta, body) {
  if (body && typeof body === 'object') {
    if (typeof body.reasoning_effort === 'string' && body.reasoning_effort !== '') return undefined;
    const r = body.reasoning;
    if (r && typeof r === 'object' && typeof r.effort === 'string' && r.effort !== '') return undefined;
  }
  const meta = modelMeta && typeof modelMeta === 'object' ? modelMeta : null;
  const cand = meta && typeof meta.effort === 'string' ? meta.effort : '';
  return cand || 'medium';
}

/** 从上游错误体里取业务 code（`{code:11102}` 或 `{error:{code:...}}` 两种形状都见过）。 */
export function upstreamCodeOf(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;
  const raw = parsed.code ?? parsed.error?.code ?? parsed.extError?.code ?? null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** 清掉已过期的 dead 标记（避免 KV 里垃圾无限增长）。返回新对象，不改入参。 */
export function pruneMarks(marks, nowSec) {
  const out = {};
  for (const [k, v] of Object.entries(marks && typeof marks === 'object' ? marks : {})) {
    if (!v || typeof v !== 'object') continue;
    const keepDead = isDead(v, nowSec);
    const keepEffort = needsEffort(v);
    if (!keepDead && !keepEffort) continue;
    out[k] = { ...(keepDead ? { dead: v.dead, code: v.code } : {}), ...(keepEffort ? { needsEffort: true } : {}) };
  }
  return out;
}
