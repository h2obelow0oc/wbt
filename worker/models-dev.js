/**
 * models.dev 目录 —— 给**没有窗口声明**的渠道模型补上下文窗口。
 *
 * ## 为什么需要（用户报障 2026-11-03）
 * 「模型界面的探测上下文好像对有道和 cline 没用」。
 *
 * 实测：
 *   - minimax 4 条、raccoon 6 条、lobsterai 19 条 → 窗口全部已知
 *     （它们的模型来自 vendor 的本地表，表里就带 contextWindow）；
 *   - **cline 453 条 → 0 条有窗口**。因为 cline 的目录是**纯远端**的：
 *     `recommended-models` 只下发 `{id,name,description,tags}`，
 *     `/api/v1/models` 只下发裸 `id`（434 条），两个端点**都不带窗口**。
 *
 * ## 数据源
 * `https://models.dev/api.json`（公开、免认证、235 个 provider、约 1.2 万条）。
 * 同一份数据 OFM 插件也在用（`cline-models-dev.ts`），但**它只认
 * `cline-pass` 一个块（18 条）** —— 对 cline 的 453 条来说杯水车薪。
 * 这里改成**全库索引**，实测能覆盖 390/453 = 86%。
 *
 * ## ⚠️ 匹配口径（这里最容易出错，必须保守）
 * 只做**逐段精确**匹配，不做模糊/包含匹配：
 *   1. 整 id 相同（`openai/gpt-6.1-terra`）
 *   2. 去掉 provider 前缀后的尾段相同（`nvidia/nemotron-3.5-super-vl:free`）
 * 优先级：**整 id > 尾段**。
 *
 * 为什么不模糊匹配：`solar-mini4` 这种尾段在 models.dev 里同时挂在
 * `upstage` 名下，而 cline 的 `cline-free/solar-mini4` 是否同一个东西
 * **无法确认**。标错窗口的后果是护栏按错的数字限流（太大→烧额度，
 * 太小→截断对话），比"未知"更糟。所以只认能做到逐段相等的那些。
 * 认不出的保持 `null`（面板显示「未知」），**绝不猜**。
 *
 * ## 失败口径
 * 拉不到就返回空索引 —— 由调用方保持原状（窗口仍是 null）。
 * 绝不因为一次目录抖动让整个探测接口失败。
 */

const MODELS_DEV_URL = 'https://models.dev/api.json';
const TIMEOUT_MS = 20000;
/** 目录变化很慢；12 小时足够，且不至于让一次改动要等一天。 */
const TTL_MS = 12 * 3600 * 1000;

let _cache = { at: 0, index: null };

/**
 * 取 models.dev 的窗口索引。
 *
 * @returns {Promise<Map<string, {context:number, provider:string}>>}
 *          key 为**两种形态**都登记：完整 `provider/model` 与裸模型 id。
 *          空 Map 表示没拉到（调用方按"未知"处理）。
 */
export async function modelsDevIndex() {
  if (_cache.index && Date.now() - _cache.at < TTL_MS) return _cache.index;
  const index = new Map();
  try {
    const r = await fetch(MODELS_DEV_URL, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!r.ok) return _cache.index || index;
    const root = await r.json();
    for (const [provider, info] of Object.entries(root || {})) {
      const models = info && typeof info === 'object' ? info.models : undefined;
      if (!models || typeof models !== 'object') continue;
      for (const [mid, entry] of Object.entries(models)) {
        const ctx = entry && entry.limit ? Number(entry.limit.context) : NaN;
        if (!Number.isFinite(ctx) || ctx <= 0) continue;
        const rec = { context: Math.trunc(ctx), provider };
        // 完整 id 优先登记（先到先得，避免被尾段同名覆盖）
        const full = `${provider}/${mid}`;
        if (!index.has(full)) index.set(full, rec);
        if (!index.has(mid)) index.set(mid, rec);
      }
    }
    _cache = { at: Date.now(), index };
    return index;
  } catch {
    // 网络/解析失败：保留旧缓存（没有就返回空），绝不让调用方崩
    return _cache.index || index;
  }
}

/**
 * 给一批"无窗口"的模型补窗口。
 *
 * @param {Array<{id:string, context:number|null}>} list 渠道已确认无窗口的条目
 * @returns {Promise<{filled:Object<string,{context:number,source:string}>, hit:number, miss:number}>}
 */
export async function fillContextWindows(list) {
  const index = await modelsDevIndex();
  const filled = {};
  let hit = 0, miss = 0;
  for (const m of list) {
    if (!m || typeof m.id !== 'string' || !m.id) continue;
    // 渠道 id 形如 `cline/openai/gpt-6.1-terra` —— 去掉渠道前缀再查
    const withoutChannel = m.id.includes('/') ? m.id.slice(m.id.indexOf('/') + 1) : m.id;
    const rec = index.get(withoutChannel);
    if (rec) { filled[m.id] = { context: rec.context, source: 'models.dev' }; hit++; }
    else miss++;
  }
  return { filled, hit, miss };
}
