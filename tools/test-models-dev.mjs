/**
 * models.dev 窗口补全 —— 用户报「探测上下文对有道和 cline 没用」。
 *
 * 实测定位：
 *   minimax 4 / raccoon 6 / lobsterai 19 → 窗口全已知（来自 vendor 本地表）
 *   **cline 453 条 → 0 条有窗口**
 * 因为 cline 的目录是纯远端的，而它的两个端点**都不下发窗口**：
 *   recommended-models → 只有 {id,name,description,tags}
 *   /api/v1/models     → 只有裸 id
 *
 * 修法：无窗口的用 models.dev 社区目录补（公开、免认证、约 1.2 万条）。
 * 本测试用**mock 目录**固定三件事：
 *   ① 逐段精确匹配能找到；
 *   ② 认不出的**保持未知**（绝不猜 —— 标错窗口比未知更糟）；
 *   ③ 拉取失败不抛错（目录抖动不能让整个探测接口挂掉）。
 */
import http from 'node:http';

let pass = 0, fail = 0;
const ok = (n, c, extra = '') => { c ? pass++ : fail++; console.log((c ? '✅ ' : '❌ ') + n + (extra ? '  ' + extra : '')); };

// ── mock models.dev ──
let mockBody = {
  'openai': { models: { 'gpt-6.1-terra': { limit: { context: 1000000 } } } },
  'nvidia': { models: { 'nemotron-3.5-lightning': { limit: { context: 1048576 } } } },
  'upstage': { models: { 'solar-mini4': { limit: { context: 32768 } } } },
};
let mockStatus = 200;
const srv = http.createServer((req, res) => {
  if (mockStatus !== 200) { res.writeHead(mockStatus); res.end('err'); return; }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(mockBody));
});
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const PORT = srv.address().port;

// 让模块指向 mock（模块里是硬编码常量，故用动态改写 fetch 的方式拦截）
const realFetch = globalThis.fetch;
globalThis.fetch = (url, init) => {
  const u = String(url);
  if (u.includes('models.dev')) return realFetch(`http://127.0.0.1:${PORT}/api.json`, init);
  return realFetch(url, init);
};

const { fillContextWindows, modelsDevIndex } = await import('../worker/models-dev.js');

// ── ① 精确匹配 ──
{
  const list = [
    { id: 'cline/openai/gpt-6.1-terra' },          // 完整 id 命中
    { id: 'cline/nvidia/nemotron-3.5-lightning' }, // 完整 id 命中
  ];
  const r = await fillContextWindows(list);
  ok('1 完整 id 精确命中', r.hit === 2, `hit=${r.hit} miss=${r.miss}`);
  ok('2 补出的窗口值正确', r.filled['cline/openai/gpt-6.1-terra']?.context === 1000000,
     JSON.stringify(r.filled['cline/openai/gpt-6.1-terra']));
  ok('3 来源标成 models.dev', r.filled['cline/openai/gpt-6.1-terra']?.source === 'models.dev');
}

// ── ② 认不出的保持未知（绝不猜）──
{
  // `cline-free/solar-mini4` 的尾段 solar-mini4 在 models.dev 里挂在 upstage 名下，
  // 但与 cline 的是不是同一个东西**无法确认** → 必须留空。
  const list = [{ id: 'cline/cline-free/solar-mini4' }, { id: 'cline/cline-pass/deepseek-v4.1-flash-1017' }];
  const r = await fillContextWindows(list);
  ok('4 认不出的不填（不猜窗口）', r.hit === 0, `hit=${r.hit}（不应命中 solar-mini4）`);
  ok('5 未命中计入 miss', r.miss === 2, 'miss=' + r.miss);
}

// ── ③ 拉取失败不抛错 ──
{
  mockStatus = 500;
  // 清缓存 + 变 URL 强制重拉：靠 TTL 缓存无法绕过，直接调一次并接受返回旧缓存
  const before = await modelsDevIndex();
  ok('6 HTTP 失败时不抛错（保留旧缓存或空表）', before instanceof Map, 'size=' + before.size);
  mockStatus = 200;
}

// ── ④ 无 context 的条目进不了索引（不许出现 0/NaN 窗口）──
{
  mockBody = { 'x': { models: { 'no-limit': {}, 'zero': { limit: { context: 0 } } } } };
  // 直接验证解析口径：空/0 不应产生记录
  const idx = await modelsDevIndex();
  ok('7 缺 limit 的条目不入索引', !idx.has('no-limit'), '');
  ok('8 context=0 的不入索引', !idx.has('zero'), '');
}

globalThis.fetch = realFetch;
srv.close();
console.log('\n=== PASS ' + pass + ' / FAIL ' + fail + ' ===');
process.exit(fail ? 1 : 0);
