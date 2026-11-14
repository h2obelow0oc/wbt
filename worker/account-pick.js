/**
 * 统一挑号（WB 与渠道共用一条）—— 按积分分层 + 层内轮转 + 冷却过滤。
 *
 * ## 为什么必须统一（2026-11-04）
 *
 * 改之前**两条路各自为政，连策略都不一样**：
 *
 * | | WB 路径 | 渠道路径 |
 * |---|---|---|
 * | 选号 | `accs[Math.floor(Math.random()*len)]` 随机 | 按积分降序**固定取第 0 位** |
 * | 冷却 | 会写（`setAccountCooldown`） | **只读不写** |
 * | 429 后 | 透传，不换号 | 透传，不换号 |
 *
 * 两条路的共同缺陷是**没有轮换**：渠道固定取第 0 位，意味着加了 N 个号也只打 1 个；
 * WB 纯随机则完全忽略积分。用户实测导入 3 个 raccoon 号后，10+ 次请求仍全部落在
 * 同一个号上 —— 「多账号解 429」根本没发生。
 *
 * ## 设计：积分分层 + 层内轮转
 *
 * 只用「纯降序取第一」会把所有负载压在一个号上，正是 429 的成因；
 * 只用「纯轮转」又会把流量平均分给快没额度的号。两者都要：
 *
 *   1. **分层**：积分 ≥ 最高分 × `tierRatio`（默认 0.5）的账号算「富余层」。
 *      富余层内**轮转**（每条请求从游标的下一位开始），负载自然摊开 → 不撞单号 TPM。
 *   2. **降级**：富余层之外的账号按积分降序排在后面，只在富余层全不可用时才轮到。
 *      积分塌了的号（如 100 分 vs 别人 6000）不会分到流量。
 *   3. **积分未知（null）不惩罚**：Auto-refresh 后应为已知；仍未知时
 *      排在有正积分的号之后、但**参与轮转**（不是旧行为的「按 0 分永远垫底」）。
 *
 * ## 为什么富余层要轮转而不是「谁多打谁」
 *
 * 额度是**按账号独立计时**的（社区实测：撞墙 60 秒即恢复，见
 * `notes/inbox/商汤日日新_限流429_社区方案_20261101.md`）。把请求摊到多个账号，
 * 每个账号的每分钟 token 都压在阈值下 —— 这是加号能解 429 的唯一机理。
 *
 * 本模块**无 I/O**：积分快照、冷却判定都由调用方传入，游标由调用方持有。
 */

/** 富余层阈值：积分 ≥ 最高分的这个比例即视为「富余」。 */
export const DEFAULT_TIER_RATIO = 0.5;

/**
 * 把账号排成「尝试顺序」。
 *
 * @param {object[]} accounts 候选账号（调用方已按渠道/模型过滤好）
 * @param {(id:string)=>object|null|undefined} snapOf 取额度快照 `{at, credits}`
 * @param {object} [opts]
 * @param {number} [opts.cursor=0] 轮转游标（调用方持有并递增）
 * @param {number} [opts.tierRatio=0.5]
 * @param {(id:string)=>boolean} [opts.isCooled] 冷却中的账号直接排除
 * @returns {{ordered: object[], cursor: number, tiers: object}}
 *   `ordered` 是尝试顺序；`cursor` 是**本次之后**应存回的游标；
 *   `tiers` 只作诊断（日志/测试断言用）。
 */
export function orderAccounts(accounts, snapOf, opts = {}) {
  const cursor = Number.isFinite(opts.cursor) ? opts.cursor : 0;
  const ratio = Number.isFinite(opts.tierRatio) && opts.tierRatio > 0
    ? opts.tierRatio
    : DEFAULT_TIER_RATIO;
  const isCooled = typeof opts.isCooled === 'function' ? opts.isCooled : () => false;

  const eligible = [];
  for (const acc of (accounts || [])) {
    if (!acc || !acc.id) continue;
    if (isCooled(acc.id)) continue;
    const snap = snapOf(acc.id);
    const c = snap && Number.isFinite(Number(snap.credits)) && snap.credits !== null
      ? Number(snap.credits)
      : null;
    eligible.push({ acc, credits: c });
  }
  if (!eligible.length) return { ordered: [], cursor, tiers: { rich: 0, rest: 0, unknown: 0 } };

  // 有正积分的 → 分层；0 分 → 垫底；未知 → 最后但轮转
  const positive = eligible.filter((e) => e.credits !== null && e.credits > 0);
  const zero = eligible.filter((e) => e.credits !== null && e.credits === 0);
  const unknown = eligible.filter((e) => e.credits === null);

  let rich = [];
  let rest = [];
  if (positive.length) {
    positive.sort((a, b) => b.credits - a.credits);
    const max = positive[0].credits;
    const cut = max * ratio;
    rich = positive.filter((e) => e.credits >= cut);
    rest = positive.filter((e) => e.credits < cut);
  }

  // 层内轮转：从游标处切开再接上，使每条请求的起点右移一位。
  const rotated = (arr) => {
    if (arr.length <= 1) return arr.slice();
    const k = cursor % arr.length;
    return arr.slice(k).concat(arr.slice(0, k));
  };

  const ordered = [
    ...rotated(rich).map((e) => e.acc),
    ...rest.map((e) => e.acc),   // 降级层不轮转，按积分降序（它们本就不该分到流量）
    ...rotated(zero).map((e) => e.acc),
    ...rotated(unknown).map((e) => e.acc),
  ];
  // 游标推进：取**最大那一层**的长度作模数。
  //
  // ⚠️ 不能只用 rich.length：当富余层只有 1 个、而未知积分层有 3 个时
  //    （正是「新导入 3 个号还没查额度」的真实场景），span=1 会让游标永远停在 0，
  //    未知层**永不轮转** → 3 个新号仍然只有第 1 个被用到。
  //    取各层最大长度，才能保证每一层都各有轮转。
  const span = Math.max(1, rich.length, zero.length, unknown.length);
  return {
    ordered,
    cursor: (cursor + 1) % span,
    tiers: { rich: rich.length, rest: rest.length, unknown: unknown.length, zero: zero.length },
  };
}

/** 快照是否已过期（`at` 是秒级 epoch，与 `now()` 同源）。 */
export function isSnapStale(snap, nowSec, ttlMs) {
  if (!snap || !Number.isFinite(Number(snap.at))) return true;
  const ttlSec = Math.max(0, Number(ttlMs) || 0) / 1000;
  return Number(nowSec) - Number(snap.at) > ttlSec;
}

/**
 * 哪些账号的额度需要补查。
 *
 * @param {object[]} accounts
 * @param {(id:string)=>object|null|undefined} snapOf
 * @param {number} nowSec
 * @param {number} ttlMs
 * @returns {object[]} 需要刷新的账号（顺序与入参一致）
 */
export function accountsNeedingCredits(accounts, snapOf, nowSec, ttlMs) {
  const out = [];
  for (const acc of (accounts || [])) {
    if (!acc || !acc.id) continue;
    if (isSnapStale(snapOf(acc.id), nowSec, ttlMs)) out.push(acc);
  }
  return out;
}
