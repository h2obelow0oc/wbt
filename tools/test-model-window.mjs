/**
 * 护栏窗口取值 —— 用户报「模型只有 131k / 说了 1M 却不让用」的回归测试。
 *
 * ## 钉住的不变量
 *   1. **渠道模型的窗口必须取得到**（旧实现在这里 100% 失败，回落 262144）：
 *      `stripModelId` 不剥渠道前缀 + `accs` 只有 WB 账号，两个原因叠加；
 *   2. **WB 模型不再额外打 /v3/config**（agg 缓存行里本来就有 context）；
 *   3. **取不到就返回 null，绝不猜**（猜大等于关掉护栏，见 models-dev 头注同款口径）；
 *   4. **任何协作方故障都只降级、不抛错**（护栏取不到窗口不该让对话失败）。
 *
 * ## 与真实请求同口径
 * 第 5 组用 `context-guard.js` 的**真实现**跑一遍「同一份 30 万 CJK 报文」：
 * 1M 模型应放行、96k 模型应 413 —— 证明修窗口是把闸装准，不是把闸拆掉。
 *
 * 依赖全部注入（`resolveModelWindow` 的设计），因此本测试**不需要启动网关**。
 */
const { parseModelId, qualifyModelId } = await import('../worker/backends/index.js');
const { resolveModelWindow } = await import('../worker/model-window.js');
const guard = await import('../worker/context-guard.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${extra ? '  ' + extra : ''}`); }
};

// ── 可复用的假依赖 ──
const CHANNEL_CATALOG = {
  raccoon: [ { id: 'sn-glm-5-3', context: 1000000 }, { id: 'sn-sensenova-6-8-flash', context: 256000 } ],
  minimax: [ { id: 'MiniMax-M3', context: 1000000 }, { id: 'MiniMax-M2.7', context: 200000 } ],
  lobsterai: [ { id: 'deepseek-v4-flash', context: 131072 } ],
  cline: [ { id: 'stealth/space-bunny-alpha' } ],   // 无窗口 → 必须 null
};
const WB_ROWS = [
  { id: 'deepseek-v4.1-flash', byRealm: { cn: { context: 1000000 }, global: { context: 1000000 } } },
  { id: 'deepseek-v3-2-volc', byRealm: { cn: { context: 96000 } } },
  { id: 'hy3', byRealm: { cn: { context: 200000 }, global: { context: 200000 } } },
];
const WB_ONLY = [ { id: 'wb-acc', provider: 'wb' } ];      // 渠道账号不在这个集合里 —— 复刻真实 accs

function deps(over = {}) {
  return {
    parseModelId,
    qualifyModelId,
    loadChannel: async (pid) => ({ backend: { models: () => CHANNEL_CATALOG[pid] || [] } }),
    warmChannelCatalog: async () => undefined,
    channelAccounts: (pid) => (pid === 'raccoon' ? [{ id: 'rc', provider: 'raccoon' }] : []),
    aggModels: async () => ({ rows: WB_ROWS, owner: {} }),
    ...over,
  };
}

console.log('── ① 渠道窗口：旧实现 100% 取不到的那条路径 ──');
{
  const r = await resolveModelWindow('raccoon/sn-glm-5-3', deps());
  ok('raccoon/sn-glm-5-3 → 1000000（不是 262144 兜底）', r.window === 1000000, JSON.stringify(r));
}
{
  const r = await resolveModelWindow('raccoon/sn-sensenova-6-8-flash', deps());
  ok('raccoon 256k 模型 → 256000', r.window === 256000, JSON.stringify(r));
}
{
  const r = await resolveModelWindow('minimax/MiniMax-M3', deps());
  ok('minimax/MiniMax-M3 → 1000000', r.window === 1000000, JSON.stringify(r));
}
{
  const r = await resolveModelWindow('cline/stealth/space-bunny-alpha', deps());
  ok('cline 自带斜杠 + 无窗口 → null（不猜）', r.window === null, JSON.stringify(r));
}
{
  const r = await resolveModelWindow('raccoon/sn-not-exist', deps());
  ok('渠道目录里没有该模型 → null', r.window === null, JSON.stringify(r));
}

console.log('── ② WB 窗口：走 agg 缓存，不打上游 ──');
{
  let tookUpstream = 0;
  const d = deps({
    loadChannel: async () => { throw new Error('WB 请求不该加载渠道模块'); },
    aggModels: async () => ({ rows: WB_ROWS }),
  });
  const r = await resolveModelWindow('deepseek-v4.1-flash', d);
  ok('裸 id → 取 agg 的 cn 窗口 1000000', r.window === 1000000, JSON.stringify(r));
}
{
  const r = await resolveModelWindow('workbuddy/deepseek-v4.1-flash [x0.11]', deps());
  ok('workbuddy/ 前缀 + [x0.11] 后缀 → 仍取到 1000000', r.window === 1000000, JSON.stringify(r));
}
{
  const r = await resolveModelWindow('deepseek-v3-2-volc', deps());
  ok('96k 模型 → 96000（该收紧的照样收紧）', r.window === 96000, JSON.stringify(r));
}
{
  const r = await resolveModelWindow('workbuddy/hy3 [g]', deps());
  ok('[g] 后缀 → 取 global realm', r.window === 200000, JSON.stringify(r));
}

console.log('── ③ 故障只降级，不抛 ──');
{
  const r = await resolveModelWindow('raccoon/sn-glm-5-3', deps({
    loadChannel: async () => { throw new Error('hook 缺失'); },
  }));
  ok('渠道模块加载失败 → null 且不抛', r.window === null && r.source.startsWith('channel-load-failed'), JSON.stringify(r));
}
{
  const r = await resolveModelWindow('deepseek-v4.1-flash', deps({
    aggModels: async () => { throw new Error('turso 抖了'); },
  }));
  ok('agg 聚合失败 → null 且不抛', r.window === null, JSON.stringify(r));
}
{
  const r = await resolveModelWindow('', deps());
  ok('空 model → null', r.window === null && r.source === 'no-model', JSON.stringify(r));
}

console.log('── ④ 闸没被拆掉：真护栏实现 + 真窗口 ──');
{
  const cfg = guard.cgConfig();
  const msgsOf = (n) => [{ role: 'user', content: '甲'.repeat(n) }];
  const oneMillion = await resolveModelWindow('raccoon/sn-glm-5-3', deps());
  const allow = await guard.cgCheckAsync(
    { model: 'raccoon/sn-glm-5-3', messages: msgsOf(300000) }, cfg, 'key:t', Date.now(), oneMillion.window);
  ok('1M 模型 + 30 万 CJK → 放行（修复前会被 262144 拦）', allow === null);

  const small = await resolveModelWindow('deepseek-v3-2-volc', deps());
  const reject = await guard.cgCheckAsync(
    { model: 'deepseek-v3-2-volc', messages: msgsOf(120000) }, cfg, 'key:t', Date.now(), small.window);
  ok('96k 模型 + 12 万 CJK → 仍然 413（防护未削弱）',
    reject !== null && reject.status === 413, reject ? String(reject.status) : '放行(异常)');
}
{
  // 取不到窗口时仍必须有兜底护栏（不能变成"无限制"）
  const cfg = guard.cgConfig();
  const r = await guard.cgCheckAsync(
    { model: 'unknown/whatever', messages: [{ role: 'user', content: '甲'.repeat(300000) }] },
    cfg, 'key:t', Date.now(), null);
  ok('窗口未知 + 30 万 CJK → 262144 兜底仍然拦', r !== null && r.status === 413);
}

console.log(`\n${fail === 0 ? '✅ 全绿' : '❌ 有红'}  pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
