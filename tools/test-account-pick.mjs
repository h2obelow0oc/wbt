/**
 * 统一挑号 —— 用户报「加了 3 个 raccoon 号，429 还是没解决」的回归测试。
 *
 * ## 钉住的不变量
 *   1. **真的会轮转**：富余层内每条请求的起点右移一位（旧实现固定取第 0 位，
 *      加 N 个号也只打第 1 个 —— 这正是多账号无效的直接原因）；
 *   2. **积分分层**：积分塌了的号降级到后面，不与富余号抢流量；
 *   3. **积分未知不惩罚**：新导入号 `credits=null` 时**参与轮转**，
 *      而不是旧行为里「按 0 分永远垫底」（那样加号等于没加）；
 *   4. **冷却过滤**：冷却中的账号不进入候选；
 *   5. **快照新鲜度**：过期即视为需补查；从未查过也算过期。
 *
 * 全部是纯函数，无需启动网关。
 */
const { orderAccounts, isSnapStale, accountsNeedingCredits, DEFAULT_TIER_RATIO } =
  await import('../worker/account-pick.js');

let pass = 0, fail = 0;
const ok = (n, c, extra = '') => {
  if (c) { pass++; console.log(`  ✅ ${n}`); }
  else { fail++; console.log(`  ❌ ${n}${extra ? '  ' + extra : ''}`); }
};

const accs = (...ids) => ids.map((id) => ({ id }));
const NOW = 1_793_800_000;

console.log('── ① 富余层内轮转（旧实现固定取第 0 位）──');
{
  const pool = accs('a', 'b', 'c');
  const snaps = { a: { at: NOW, credits: 6000 }, b: { at: NOW, credits: 6000 }, c: { at: NOW, credits: 6000 } };
  const seen = [];
  let cursor = 0;
  for (let i = 0; i < 6; i++) {
    const r = orderAccounts(pool, (id) => snaps[id], { cursor });
    seen.push(r.ordered[0].id);
    cursor = r.cursor;
  }
  const uniq = new Set(seen);
  ok('6 次请求的「首选」覆盖了全部 3 个账号', uniq.size === 3, `实际 ${seen.join(',')}`);
  ok('轮转是确定性的循环（不是随机）', seen.join('') === 'abcabc', seen.join(''));
}
{
  // 回归反例：如果实现退回「固定取第 0 位」，上面两条必红
  const pool = accs('a', 'b', 'c', 'd');
  const r1 = orderAccounts(pool, () => ({ at: NOW, credits: 6000 }), { cursor: 0 });
  const r2 = orderAccounts(pool, () => ({ at: NOW, credits: 6000 }), { cursor: 1 });
  ok('不同游标给出不同的首选（证明游标真的生效）', r1.ordered[0].id !== r2.ordered[0].id,
    `${r1.ordered[0].id} vs ${r2.ordered[0].id}`);
}

console.log('── ② 积分分层 ──');
{
  const pool = accs('rich1', 'rich2', 'poor');
  const snaps = { rich1: { at: NOW, credits: 6000 }, rich2: { at: NOW, credits: 5500 }, poor: { at: NOW, credits: 100 } };
  const r = orderAccounts(pool, (id) => snaps[id], { cursor: 0 });
  ok('低积分账号被降级到富余层之后', r.ordered[r.ordered.length - 1].id === 'poor', r.ordered.map(x => x.id).join(','));
  ok('富余层 = 2（6000 与 5500 都 ≥ 6000×0.5）', r.tiers.rich === 2, JSON.stringify(r.tiers));
}
{
  // 分层阈值可调：把 ratio 拉到 0.99，5500 就掉出富余层
  const pool = accs('a', 'b');
  const snaps = { a: { at: NOW, credits: 6000 }, b: { at: NOW, credits: 5500 } };
  const r = orderAccounts(pool, (id) => snaps[id], { cursor: 0, tierRatio: 0.99 });
  ok('tierRatio=0.99 时只有最高分在富余层', r.tiers.rich === 1, JSON.stringify(r.tiers));
}

console.log('── ③ 积分未知（新导入号）不惩罚 ──');
{
  // 用户实测场景：新导入 3 个号 credits=null，老号 5525
  const pool = accs('old', 'new1', 'new2', 'new3');
  const snaps = { old: { at: NOW, credits: 5525 } };   // 新号没有 snap
  const r = orderAccounts(pool, (id) => snaps[id], { cursor: 0 });
  ok('有积分的老号优先', r.ordered[0].id === 'old', r.ordered.map(x => x.id).join(','));
  ok('未知积分的 3 个新号仍在候选里（不是被丢弃）',
    ['new1', 'new2', 'new3'].every((id) => r.ordered.some((o) => o.id === id)));
  ok('未知积分的号参与轮转（连续两次起点不同）',
    (() => {
      const a = orderAccounts(pool, (id) => snaps[id], { cursor: 0 });
      const b = orderAccounts(pool, (id) => snaps[id], { cursor: a.cursor });
      return a.ordered.findIndex((o) => o.id === 'new1') !== b.ordered.findIndex((o) => o.id === 'new1');
    })());
}
{
  // 全部未知（导入后一个都没查过）→ 必须仍然能挑出一个
  const pool = accs('n1', 'n2', 'n3');
  const r = orderAccounts(pool, () => null, { cursor: 0 });
  ok('全部未知时仍返回非空候选（不会 503）', r.ordered.length === 3);
  ok('全部未知时也轮转', (() => {
    const a = orderAccounts(pool, () => null, { cursor: 0 });
    const b = orderAccounts(pool, () => null, { cursor: a.cursor });
    return a.ordered[0].id !== b.ordered[0].id;
  })());
}

console.log('── ④ 冷却过滤 ──');
{
  const pool = accs('a', 'b');
  const r = orderAccounts(pool, () => ({ at: NOW, credits: 100 }), { cursor: 0, isCooled: (id) => id === 'a' });
  ok('冷却中的账号被排除', r.ordered.map(x => x.id).join(',') === 'b', r.ordered.map(x => x.id).join(','));
}
{
  const r = orderAccounts(accs('a', 'b'), () => ({ at: NOW, credits: 100 }), { cursor: 0, isCooled: () => true });
  ok('全部冷却 → 返回空（调用方据此 503，不静默送死）', r.ordered.length === 0);
}

console.log('── ⑤ 快照新鲜度 ──');
{
  ok('从未查过 → 过期', isSnapStale(null, NOW, 3600000));
  ok('刚查过 → 新鲜', isSnapStale({ at: NOW, credits: 1 }, NOW, 3600000) === false);
  ok('超过 TTL → 过期', isSnapStale({ at: NOW - 3700, credits: 1 }, NOW, 3600000));
  ok('at 非法 → 过期', isSnapStale({ credits: 1 }, NOW, 3600000));
}
{
  const pool = accs('fresh', 'stale', 'never');
  const snaps = { fresh: { at: NOW, credits: 1 }, stale: { at: NOW - 7200, credits: 1 } };
  const need = accountsNeedingCredits(pool, (id) => snaps[id], NOW, 3600000);
  ok('只补查过期/从未查过的（fresh 跳过）',
    need.map(x => x.id).join(',') === 'stale,never', need.map(x => x.id).join(','));
}

console.log('── ⑥ 边界 ──');
{
  ok('空候选 → 空顺序（调用方走 503）', orderAccounts([], () => null).ordered.length === 0);
  ok('单账号 → 每轮都选它', (() => {
    const r1 = orderAccounts(accs('x'), () => ({ at: NOW, credits: 5 }), { cursor: 0 });
    const r2 = orderAccounts(accs('x'), () => ({ at: NOW, credits: 5 }), { cursor: r1.cursor });
    return r1.ordered[0].id === 'x' && r2.ordered[0].id === 'x';
  })());
  ok('默认分层比例是 0.5', DEFAULT_TIER_RATIO === 0.5);
  ok('非法 tierRatio 回落默认', (() => {
    // ratio<=0 视为非法 → 回落默认 0.5；50 >= 100*0.5，故两个都在富余层。
    const r = orderAccounts(accs('a', 'b'), (id) => ({ at: NOW, credits: id === 'a' ? 100 : 50 }), { tierRatio: -1 });
    return r.tiers.rich === 2;
  })());
}

console.log(`\n${fail === 0 ? '✅ 全绿' : '❌ 有红'}  pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
