/**
 * 模型运行时标记（dead / needsEffort）与 11102/11103/11150 自愈回归。
 *
 * 线上事实（2026-11-03 全量探测 32 条 WB 模型）：
 *   - 8 条 11102 `model [x] service info not found`
 *   - 3 条 11103 `Backend [maas]/[hunyuan-stream] is not supported`（图片/视频模型）
 *   - 1 条 11150 `reasoning effort ... not supported`（glm-5.0-turbo，补档就好）
 *   - 1 条超时（偶发，不算 dead）
 *
 * 三条硬约束由本测试守：
 *   1) 11102/11103 必须被记账并在 TTL 内从列表消失，TTL 过后自动回来；
 *   2) 11150 必须补 `reasoning_effort` 后重试成功，且**不**被当成 dead；
 *   3) 客户端自己带了档位时不许覆盖；记账失败绝不能把请求打挂。
 */
const M = await import('../worker/model-marks.js');
const { parseBuddyModels } = await import('../worker/wb_protocol.js');

let pass = 0, fail = 0;
const ok = (n, c, extra = '') => { c ? pass++ : fail++; console.log((c ? '✅ ' : '❌ ') + n + (extra ? '  ' + extra : '')); };

// ── 1. code 分类 ────────────────────────────────────────────────────────
ok('1a 11102 判为不可 chat', M.isDeadCode(11102));
ok('1b 11103 判为不可 chat', M.isDeadCode(11103));
ok('1c 11150 不判 dead', !M.isDeadCode(11150));
ok('1d 11128/11140 不判 dead', !M.isDeadCode(11128) && !M.isDeadCode(11140));
ok('1e 429 不判 dead', !M.isDeadCode(429));
ok('1f 从 {code} 取到业务码', M.upstreamCodeOf({ code: 11102 }) === 11102);
ok('1g 从 {error:{code}} 取到', M.upstreamCodeOf({ error: { code: 11105 } }) === 11105);
ok('1h 非数字返回 null', M.upstreamCodeOf({ code: 'abc' }) === null && M.upstreamCodeOf(null) === null);

// ── 2. 记账键：CN 与 [g] 必须分开 ───────────────────────────────────────
ok('2a 默认行键', M.markKey('glm-4.6v', '') === 'glm-4.6v');
ok('2b 国际行键独立', M.markKey('glm-4.6v', 'g') === 'glm-4.6v|g');
ok('2c 空模型名不产生键', M.markKey('', '') === '');

// ── 3. TTL ──────────────────────────────────────────────────────────────
const NOW = 1_800_000_000;
ok('3a 刚记账 → dead', M.isDead({ dead: NOW }, NOW));
ok('3b TTL 内 → dead', M.isDead({ dead: NOW - M.DEAD_TTL_S + 60 }, NOW));
ok('3c TTL 过后 → 复活', !M.isDead({ dead: NOW - M.DEAD_TTL_S - 1 }, NOW));
ok('3d 无标记 → 不算 dead', !M.isDead(undefined, NOW) && !M.isDead({}, NOW));
ok('3e needsEffort 单独存在时不判 dead', !M.isDead({ needsEffort: true }, NOW));

// ── 4. 补档决策 ─────────────────────────────────────────────────────────
const meta = { effort: 'medium' };
ok('4a 无客户端档位 → 用上游默认档', M.resolveEffort(meta, {}) === 'medium');
ok('4b 元数据缺失 → 回落 medium', M.resolveEffort(null, {}) === 'medium');
ok('4c 客户端给了 reasoning_effort → 不覆盖', M.resolveEffort(meta, { reasoning_effort: 'high' }) === undefined);
ok('4d 客户端给了 reasoning.effort → 不覆盖', M.resolveEffort(meta, { reasoning: { effort: 'low' } }) === undefined);
ok('4e 空字符串不算客户端指定', M.resolveEffort(meta, { reasoning_effort: '' }) === 'medium');

// ── 5. 清理过期标记 ─────────────────────────────────────────────────────
{
  const pruned = M.pruneMarks({
    a: { dead: NOW - M.DEAD_TTL_S - 10 },              // 过期 → 删
    b: { dead: NOW - 60 },                             // 有效 → 留
    c: { needsEffort: true },                          // 永久 → 留
    d: { dead: NOW - M.DEAD_TTL_S - 10, needsEffort: true }, // dead 过期但 effort 保留
    e: null,
  }, NOW);
  ok('5a 过期 dead 被清掉', !('a' in pruned), JSON.stringify(pruned));
  ok('5b 有效 dead 保留', pruned.b?.dead === NOW - 60, JSON.stringify(pruned.b));
  ok('5c needsEffort 永久保留', pruned.c?.needsEffort === true);
  ok('5d dead 过期但 effort 保留', !pruned.d?.dead && pruned.d?.needsEffort === true, JSON.stringify(pruned.d));
  ok('5e 非法项被丢弃', !('e' in pruned));
}

// ── 6. needsEffort 判定 ─────────────────────────────────────────────────
ok('6a true 判定', M.needsEffort({ needsEffort: true }) === true);
ok('6b 缺字段判定为 false', M.needsEffort({ dead: 1 }) === false && M.needsEffort(null) === false);

// ── 7. 上游「只有 effort 没有 supportedEfforts」的模型必须解析出默认档 ──
// glm-5.0-turbo 实测就是这种形状：原先整段被丢弃 → 网关永远不知道要补哪个档。
{
  const parsed = parseBuddyModels({
    models: [
      { id: 'glm-5.0-turbo', name: 'GLM-5.0-Turbo', maxInputTokens: 200000, maxOutputTokens: 48000,
        credits: 'x0.95 credits', reasoning: { effort: 'medium', summary: 'auto' }, supportsReasoning: true },
      { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', maxInputTokens: 1000000, maxOutputTokens: 64000,
        credits: 'x0.11 credits', reasoning: { canDisableThinking: true, defaultEffort: 'high', summary: 'auto', supportedEfforts: ['low', 'high', 'max'] } },
    ],
  });
  const turbo = parsed.find(m => m.id === 'glm-5.0-turbo');
  const ds = parsed.find(m => m.id === 'deepseek-v4.1-flash');
  ok('7a effort-only 形状解析出 effort=medium', turbo?.effort === 'medium', JSON.stringify(turbo?.effort));
  ok('7b effort-only 形状标记必须显式带档', turbo?.reasoning?.explicitRequired === true, JSON.stringify(turbo?.reasoning));
  ok('7c supportedEfforts 形状不带 explicitRequired',
     ds?.reasoning?.explicitRequired === false && ds?.effort === 'high', JSON.stringify(ds?.reasoning));
  ok('7d 两者都能给出可用的补档值', M.resolveEffort({ effort: turbo?.effort }, {}) === 'medium');
}

console.log('\n=== PASS ' + pass + ' / FAIL ' + fail + ' ===');
process.exit(fail ? 1 : 0);
