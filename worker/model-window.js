/**
 * 取模型「真实上游上下文窗口」—— 护栏（context-guard）的唯一取值来源。
 *
 * ## 为什么单独成模块（2026-11-04）
 *
 * 原实现写在 `index_turso.js` 的护栏块里，用 `stripModelId(body.model)` 去
 * `aggModels` 的 `owner` 里查账号，再对那个账号**额外打一次** `/v3/config`。
 * 这条路径有两个独立缺陷，都会让窗口取不到：
 *
 *   1. **前缀没剥**：`stripModelId` 只剥 `workbuddy/`，**故意**不剥渠道前缀
 *      （它给 WB 上游用，渠道 id 不该走到那里）。于是 `raccoon/sn-glm-5-3`
 *      原样进查找，而 `owner` 的键只有 WB 裸 id；
 *   2. **accs 只有 WB**：`handleProxy` 里 `accs = allAccs.filter(provider==='wb')`，
 *      渠道账号在 `chanAccs`。拿 WB 账号集合去查渠道模型，**必然查不到**。
 *
 * 两者叠加 → `realWindow = null` → 护栏回落 `CG_UNKNOWN_WINDOW_CAP = 262144`。
 * 实测后果：标称 1M 的 `raccoon/sn-glm-5-3` 实际按 256k 拦，
 * 而 `/v1/models` 的 `X-Upstream-Context-Window` 头却写着 1M（它走另一套算法）。
 * **头说能用 1M，闸按 256k 拒** —— 这是用户报「上下文不正常」的直接来源。
 *
 * ## 修法
 *
 *   1. 用 `parseModelId` 判归属（它会剥 `[x0.11]` 这类后缀并认出渠道前缀）；
 *   2. 渠道 → 从该渠道自己的模型目录取 `context`（本地表或远端目录预热），
 *      和 `/v1/models` 列表**同一来源**；
 *   3. WB → 直接从 `aggModels` 的缓存行取 `byRealm[realm].context`，
 *      **不再额外打一次 `/v3/config`**（缓存里本来就有这个字段）。
 *
 * 第 3 条是顺带的收益：原来每个 WB chat 请求都白打一次上游 `/v3/config`，
 * 只为拿一个 agg 缓存里已经存在的数字。
 *
 * ## 口径（与 models-dev.js 一致：认不出比猜错好）
 *
 * 取不到就是 `null`，**绝不猜**。`null` 由 `cgEffectiveCeiling` 回落 262144，
 * 那是「保守但有护栏」的行为；猜一个偏大的值等于把护栏关掉。
 *
 * ## 为什么依赖注入而不是直接 import
 *
 * 本模块要能在**不启动网关服务**的前提下被单测（`index_turso.js` 一被 import
 * 就会真的 `listen` 占端口，见交接文档 §10 硬约束）。故所有协作方由调用方传入。
 */

/**
 * @typedef {object} WindowDeps
 * @property {(raw:string)=>{provider:string, model:string, srcTag:string}} parseModelId
 * @property {(provider:string)=>Promise<any>} loadChannel            渠道懒加载（可能抛）
 * @property {(mod:any, acc:any)=>Promise<any>} warmChannelCatalog    远端目录预热（cline 用）
 * @property {(provider:string)=>object[]} channelAccounts            该渠道的启用账号
 * @property {()=>Promise<{rows:object[]}>} aggModels                 WB 模型聚合（带 5 分钟缓存）
 */

/**
 * 解析某模型的真实上游窗口。
 *
 * @param {string} rawModelId 客户端发来的 `body.model`（含可能的前缀/后缀）
 * @param {WindowDeps} deps
 * @returns {Promise<{window: number|null, source: string}>}
 *   `window` 为上游声明的输入窗口（token）；`source` 只是诊断标签。
 */
export async function resolveModelWindow(rawModelId, deps) {
  const raw = typeof rawModelId === 'string' ? rawModelId : '';
  if (!raw) return { window: null, source: 'no-model' };

  // ① 判归属。parseModelId 会剥 ` [...]` 后缀，并认出 minimax/raccoon/cline/lobsterai。
  const route = deps.parseModelId(raw);
  const provider = route && route.provider ? route.provider : 'wb';
  const model = route && route.model ? route.model : '';

  if (provider !== 'wb') {
    // ② 渠道：与该渠道 /v1/models 列表同源（本地表 or 远端目录）
    return await channelWindow(provider, model, deps);
  }

  // ③ WB：命中 agg 缓存行即可，不再打上游
  return await wbWindow(model, route.srcTag, deps);
}

/** 渠道模型的窗口：走该渠道后端的模型目录。 */
async function channelWindow(provider, model, deps) {
  let chan = null;
  try {
    chan = await deps.loadChannel(provider);
  } catch (e) {
    // hook 缺失 / 模块语法问题 → 取不到窗口，由调用方回落保守值。
    // ⚠️ 这里**不能抛**：护栏取不到窗口只该降级，不该让对话失败。
    return { window: null, source: 'channel-load-failed:' + provider };
  }
  const backend = chan && chan.backend;
  if (!backend || typeof backend.models !== 'function') {
    return { window: null, source: 'channel-no-models:' + provider };
  }

  // 远端目录（cline）要预热才有内容；同步 models() 只读缓存。
  try {
    const accs = deps.channelAccounts(provider) || [];
    if (accs.length && typeof deps.warmChannelCatalog === 'function') {
      await deps.warmChannelCatalog(chan, accs[0]);
    }
  } catch { /* 目录失败不影响窗口判定（只是退化到兜底目录） */ }

  let list = [];
  try { list = backend.models() || []; } catch { list = []; }
  const hit = list.find((m) => m && m.id === model);
  const win = hit && Number.isFinite(Number(hit.context)) && Number(hit.context) > 0
    ? Number(hit.context)
    : null;
  return { window: win, source: 'channel:' + provider };
}

/** WB 模型的窗口：从 agg 缓存行取，key 与 /v1/models 的响应头同源。 */
async function wbWindow(model, srcTag, deps) {
  let rows = [];
  try {
    const agg = await deps.aggModels();
    rows = (agg && agg.rows) || [];
  } catch {
    return { window: null, source: 'wb-agg-failed' };
  }
  const row = rows.find((r) => r && r.id === model);
  if (!row) return { window: null, source: 'wb-not-in-catalog' };

  // 与 /v1/models 的展开口径一致：`[g]` 后缀 = 国际 realm，否则国内。
  const want = srcTag === 'g' ? 'global' : 'cn';
  const byRealm = row.byRealm || {};
  const meta = byRealm[want] || byRealm.cn || byRealm.global || null;
  const win = meta && Number.isFinite(Number(meta.context)) && Number(meta.context) > 0
    ? Number(meta.context)
    : null;
  return { window: win, source: 'wb-agg:' + want };
}
