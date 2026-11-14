/**
 * 启动标志入口 —— `node --import ./worker/backends/hook.mjs worker/index_turso.js`
 *
 * 真正的钩子逻辑在 `./ts-hook.mjs`（本文件 import 它即完成注册，时机最早，
 * 能覆盖主模块的**静态**图解析）。
 *
 * 为什么还需要这个入口: 进程内注册（index_turso.js 顶部）只能救**动态**
 * import —— ESM 先解析完静态图再求值。若哪天有人往静态图里塞了 TS，
 * 就必须靠 `--import`。两种都留着，互为兜底。
 *
 * ⚠️ render.yaml 的 startCommand 已带此标志，但 Render 服务是 Dashboard
 * 手动建的、蓝图未必生效（实测 `x-ts-hook: false`）。故 index_turso.js
 * 另有进程内注册，代码不依赖部署配置。
 */
import './ts-hook.mjs';

export const HOOK_ACTIVE = true;

// 供 backends/index.js 判断钩子是否已随 --import 生效。
// 不用它的导出: --import 的模块导出无法被主模块 import 到。
globalThis.__WB_TS_HOOK__ = true;
