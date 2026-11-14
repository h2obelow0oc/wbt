/**
 * Node 原生 TypeScript 解析钩子 —— wb 网关**零构建**的核心。
 *
 * ## 它解决什么
 * vendored 的 channel-pack 协议层是 TS（NodeNext 风格：内部互相 `import './x.js'`，
 * 磁盘上却是 `x.ts`）。Node 24 能原生剥离类型跑 TS，但**不会**把 `.js` 说明符
 * 自动映射到 `.ts`（实测 ERR_MODULE_NOT_FOUND）。本钩子补上这一步，
 * 并把 `@deepseek-ai/dsh-llm` 指向本地最小替身。
 *
 * ## 两种注册时机，都要支持
 *
 * 1. **启动标志**（`node --import ./worker/backends/hook.mjs ...`）
 *    在主模块静态图解析**之前**生效 —— 只有这条能救「静态 import 了 TS」的场景。
 *
 * 2. **进程内兜底**（`index_turso.js` 顶部调 `ensureTsHook()`）
 *    ESM 先解析完整静态图再求值，所以静态图解析完之后注册的钩子，
 *    对**已经**解析过的静态导入无效 —— 但对之后发生的**动态** `import()`
 *    完全有效。
 *
 *    ⚠️ 为什么需要兜底: `render.yaml` 里的 startCommand 带 `--import`，
 *    但该服务是在 Render Dashboard 手动创建的，**蓝图文件不一定生效**
 *    （实测 `x-ts-hook: false` —— 钩子没注册，渠道模块全部
 *    `Cannot find module '.../raccoon.js'`）。代码侧必须能自愈，
 *    不能依赖部署配置。
 *
 *    前提: **静态图里不许出现 TS**（`index_turso.js:15` 的既有约束，
 *    「只静态导入纯 JS 的注册表」）。只要守住这条，进程内注册就够用。
 *
 * ## 作用域限制
 * `.js` → `.ts` 只在 **vendor/channel-pack 内部**生效。网关自己的 `*.js`
 * 保持原样，避免钩子外溢改变既有模块的解析行为。
 */
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DSH_LLM = '@deepseek-ai/dsh-llm';
const STUB_URL = new URL('./dsh-llm-stub.mjs', import.meta.url).href;
// 只在 vendored 协议层内做 .js→.ts 映射
const VENDOR_MARK = '/vendor/channel-pack/';

/** 幂等注册；返回本次是否真的注册了。 */
export function ensureTsHook() {
  if (globalThis.__WB_TS_HOOK__) return false;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === DSH_LLM) return { url: STUB_URL, shortCircuit: true };

      if (specifier.endsWith('.js') && context.parentURL?.startsWith('file:')) {
        const parent = context.parentURL;
        if (parent.includes(VENDOR_MARK)) {
          const abs = fileURLToPath(new URL(specifier, parent));
          if (!existsSync(abs) && existsSync(abs.slice(0, -3) + '.ts')) {
            return nextResolve(specifier.slice(0, -3) + '.ts', context);
          }
        }
      }
      return nextResolve(specifier, context);
    },
  });
  globalThis.__WB_TS_HOOK__ = true;
  return true;
}

// 被 --import 加载时自动注册（时机最早，能覆盖静态图）
ensureTsHook();
