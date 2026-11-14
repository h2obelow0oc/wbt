/**
 * `@deepseek-ai/dsh-llm` 的最小忠实替身。
 *
 * ## 为什么是替身而不是真包
 * 真包 `lib/index.js` 还 import 了 dsh-brand / dsh-timeout / dsh-typert-protocol /
 * dsh-util-crypto / dsh-util-values / schemastery 六个包，整体打包会拖进大树。
 * 而本网关的协议闭包（vendor/channel-pack/src）**只用到 3 个符号**：
 *
 *   - `LlmError`      —— 协议层抛错用，带 `.code` / `.failure`
 *   - `ToolCallId`    —— 品牌化字符串，运行时就是恒等转换
 *   - `EMPTY_RESPONSE_CODE` —— 常量 'EMPTY_RESPONSE'
 *
 * ## 忠实性依据（照抄真包实现，勿"优化"）
 * - `ToolCallId(id)` = `brandString(id)`：品牌只做标识，**值不变** → `String(id)` 等价
 *   （真包见 dsh-llm/lib/index.js:906 `return brandString(id)`）
 * - `LlmError` 继承 `HarnessError` 继承 `Error`，构造时校验 message/code 非空、
 *   status 必须 100-599，然后 `this.name='LlmError'` 并冻结 `.failure`
 *   （真包见 dsh-llm/lib/types/index.js:66 起）
 *
 * ⚠️ 若上游协议层新增对 dsh-llm 的符号引用，这里会直接抛
 * `SyntaxError: does not provide an export named ...` —— 那是**信号不是故障**，
 * 说明需要补 stub，不要改成 `export *` 通配（会静默吞掉缺失符号）。
 */

export const EMPTY_RESPONSE_CODE = 'EMPTY_RESPONSE';

export class HarnessError extends Error {
  constructor(message, code, options) {
    if (typeof message !== 'string' || message.length === 0) {
      throw new Error('HarnessError message must be a non-empty string');
    }
    if (typeof code !== 'string' || code.length === 0) {
      throw new Error('HarnessError code must be a non-empty string');
    }
    if (options?.status !== undefined
      && (!Number.isInteger(options.status) || options.status < 100 || options.status > 599)) {
      throw new Error('HarnessError status must be an integer from 100 through 599');
    }
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'HarnessError';
    this.code = code;
    this.failure = Object.freeze({
      message,
      code,
      ...(options?.status !== undefined ? { status: options.status } : {}),
      ...(options?.providerRetryAfterMs !== undefined ? { providerRetryAfterMs: options.providerRetryAfterMs } : {}),
      ...(options?.requestId !== undefined ? { requestId: options.requestId } : {}),
    });
  }
}

export class LlmError extends HarnessError {
  constructor(message, code, options) {
    super(message, code, options);
    this.name = 'LlmError';
  }
}

/** 品牌化字符串：运行时恒等（真包返回 brandString(id)，值不变）。 */
export function ToolCallId(id) {
  return String(id);
}
