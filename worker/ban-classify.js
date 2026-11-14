/**
 * 上游「账号级封禁」判定（移植自 workbuddy2api-hub v2.1.0/v2.1.1 语义，2026-11-12）。
 *
 * ## hub 的核心教训
 * 11140 = 账号已被上游限制使用（见 /sdcard/deep/wb国际版11140诊断_20261024.md：
 * 绕开网关直连同样 403/11140 —— 纯账号侧状态，网关改不动）。hub v2.1.0 把它从
 * 「可自动恢复的风控冷却」升格为**持久封禁**：命中即
 *   1. 停用 API 派发与自动任务（**停止换号重试**）；
 *   2. 持久化 accountBanned，重启/刷新凭证/重新导入/成功探测都不自动恢复；
 *   3. 只有面板手动启用才清除。
 * 理由原话：「避免同设备账号继续连坐」—— 上游封禁按设备指纹连坐，
 * 封了还拿同池其他号打，会把剩下的号一起带走。v2.1.1 进一步把
 * 「失败换模型不放大风控」钉死：11140/401 一律立即停止。
 *
 * ## 本模块的边界
 * 纯函数、无 I/O：判定与 ban 标记的「为什么」在这里，
 * 落库（enabled=0 / banned 字段 / cooldown 永久项）由调用方执行。
 */

import { upstreamCodeOf } from './model-marks.js';

/** 11140 = 账号被上游限制使用（chat 被拒、token/refresh/config 仍 200 的形态）。 */
export const BAN_CODE = 11140;

/**
 * 从上游错误体判定「这是账号级封禁」。
 *
 * 判据**宁窄勿宽**：误冻一个号只是多一次人工解禁，漏判才可怕 ——
 * 漏判会继续换号打，而那正是连坐路径。
 *   - `code === 11140`：铁证，冻；
 *   - 其余 403（旧版风控临时拦截）：不按封禁处理，保持 wbr 原有 24h 冷却语义。
 *
 * @param {object|null} errBody 已 JSON.parse 的上游错误体
 * @returns {boolean}
 */
export function isBannedError(errBody) {
  return upstreamCodeOf(errBody) === BAN_CODE;
}

/**
 * 签到结果是否命中封禁（checkin() 返回 `{status, code, msg}`，非 Response）。
 * @param {{status?:number, code?:number}|null} res
 */
export function isBannedCheckin(res) {
  if (!res) return false;
  return Number(res.code) === BAN_CODE;
}

/**
 * 冷却 reason 沿用既有口径：'429'=10min、'ban'=24h 风控、'auth'=永久。
 * 封禁落 'auth'（永久冷却）+ 账号对象上的 `banned` 字段，两者互为冗余：
 * cooldown 表可能被「清理全部数据」抹掉，`banned` 跟着账号走，
 * 解禁必须显式（面板启用按钮，见 accounts/enable）。
 */
export const BAN_COOLDOWN_REASON = 'auth';

/**
 * 冻结落库（就地修改账号对象字段；KV 写盘由调用方 saveAccount 完成）。
 *
 * @param {object} acc 账号对象
 * @param {string} evidence 上游证据摘要（code/msg），进面板与日志
 * @returns {object} acc（同一引用）
 */
export function markBanned(acc, evidence) {
  acc.enabled = 0;
  acc.banned = 1;
  acc.bannedAt = Math.floor(Date.now() / 1000);
  acc.bannedEvidence = String(evidence || '').slice(0, 300);
  return acc;
}

/** 显式解禁（面板唯一入口）：清标记、恢复启用。 */
export function clearBanned(acc) {
  acc.banned = 0;
  acc.enabled = 1;
  delete acc.bannedAt;
  delete acc.bannedEvidence;
  return acc;
}
