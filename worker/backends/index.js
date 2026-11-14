/**
 * 后端注册表与模型 ID 路由 —— wb 网关多后端的第一层。
 *
 * ## 设计约束
 * 1. **WB 路径零风险**：本文件不静态 import 任何 vendor TS。渠道模块全部
 *    **懒加载**（`import('./minimax.js')`），钩子没生效或渠道有 bug 时，
 *    只有渠道请求报错，WB 推理照常 —— 不让新功能拖垮在跑的服务。
 * 2. **模型 ID 命名空间**：`provider/model`。WB 现有模型**无前缀、保持不变**，
 *    客户端已有配置不受影响。
 *    ⚠️ 必须有前缀：`MiniMax-M3` / `MiniMax-M2.7` 同时存在于 minimax 与
 *    lobsterai 两家（P0 实测），不加前缀必然撞车。
 * 3. 既有 `' [g]'` 后缀（国际 realm 标记）继续生效，可与前缀叠加：
 *    `minimax/MiniMax-M3 [g]`。
 */

/** 已接入的渠道 id（静态声明，不触发模块加载）。 */
export const CHANNEL_IDS = ['minimax', 'raccoon', 'cline', 'lobsterai'];

/** 渠道 → 懒加载器。新增渠道只需在这里加一行。 */
const LOADERS = {
  minimax: () => import('./minimax.js'),
  raccoon: () => import('./raccoon.js'),
  cline: () => import('./cline.js'),
  lobsterai: () => import('./lobsterai.js'),
};

const _cache = new Map();

/**
 * 取渠道后端模块（带缓存）。
 * @param {string} id CHANNEL_IDS 之一
 * @returns {Promise<object>} 后端模块（需导出 `backend`）
 */
export async function loadChannel(id) {
  const load = LOADERS[id];
  if (!load) throw new Error(`未知渠道后端: ${id}`);
  if (_cache.has(id)) return _cache.get(id);
  if (!globalThis.__WB_TS_HOOK__) {
    throw new Error(
      `渠道 ${id} 需要 TS 解析钩子，但当前进程未注册。` +
      `启动命令必须是: node --import ./worker/backends/hook.mjs worker/index_turso.js` +
      `（见 render.yaml startCommand）`,
    );
  }
  try {
    const mod = await load();
    _cache.set(id, mod);
    return mod;
  } catch (e) {
    const msg = String(e?.message || e);
    throw new Error(`加载渠道 ${id} 失败: ${msg.slice(0, 300)}`);
  }
}

/**
 * 解析客户端发来的模型 ID → 后端归属。
 *
 * 顺序：先剥 `' [...]'` 后缀（既有 realm 标记），再看首段是否为已知渠道前缀。
 * 未知前缀一律当 WB 模型（WB 模型名不含 `/`，而 cline 模型自带 `/`，
 * 如 `cline/stealth/space-bunny-alpha` → provider=cline, model=stealth/space-bunny-alpha）。
 *
 * @param {string} raw 客户端 model 字段
 * @returns {{provider: string, model: string, srcTag: string}}
 *   provider ∈ 'wb' | CHANNEL_IDS；model 为剥掉前缀与后缀的真身；srcTag 'g'|''
 */
export function parseModelId(raw) {
  const s = String(raw ?? '');
  const i = s.indexOf(' [');
  const base = i >= 0 ? s.slice(0, i) : s;
  const srcTag = (i >= 0 && /\[[^\]]*\bg\b[^\]]*\]/.test(s)) ? 'g' : '';

  const slash = base.indexOf('/');
  if (slash > 0) {
    const prov = base.slice(0, slash);
    if (CHANNEL_IDS.includes(prov)) {
      const model = base.slice(slash + 1);
      if (model) return { provider: prov, model, srcTag };
    }
    // WB 自己的前缀 workbuddy/：列表对外带它，便于将来国际版(workbuddy.ai)与
    // 渠道模型同框时一眼分辨来源。裸 id（无前缀）仍按 WB 处理，老配置不断。
    if (prov === 'workbuddy') {
      const model = base.slice(slash + 1);
      if (model) return { provider: 'wb', model, srcTag };
    }
  }
  return { provider: 'wb', model: base, srcTag };
}

/** 反向：给模型加来源前缀（/v1/models 列表用）。WB → workbuddy/，渠道 → <provider>/。 */
export function qualifyModelId(provider, model) {
  const prov = provider === 'wb' ? 'workbuddy' : provider;
  return `${prov}/${model}`;
}

/**
 * 对话前还原真实模型 id：剥 `' [...]'` 后缀（realm 标记）+ 剥 `workbuddy/` 前缀。
 * 与 parseModelId 的分工：那个判**归属**(provider)，这个只要**裸 id** 给 WB 上游。
 * 渠道前缀(minimax/ 等)在此**不剥** —— 走到这里的一定是 WB 链路。
 */
export function stripModelId(id) {
  const i = id.indexOf(' [');
  const base = i >= 0 ? id.slice(0, i) : id;
  const srcTag = (i >= 0 && /\[[^\]]*\bg\b[^\]]*\]/.test(id)) ? 'g' : '';
  const bare = base.startsWith('workbuddy/') ? base.slice('workbuddy/'.length) : base;
  return { id: bare, srcTag };
}
