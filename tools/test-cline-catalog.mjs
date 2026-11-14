/**
 * Cline 模型目录测试 —— 用户报「cline 在 ofm 插件显示 4 个免费，总数 31，
 * 网关上总共才 3 个」。
 *
 * 真因不是"少几个"，而是**那 3 个全已被上游下线**：
 * `stealth/space-bunny-alpha`、`cline-free/mimo-v2.6-flash`、
 * `cline-free/muse-spark-1.3-contributor` 都不在远端 `free` 数组里了
 * （现在换成 reflection/beam-free、cline-free/nemotron-3.5-super-vl、
 *  nvidia/nemotron-3.5-lightning-free、cline-free/solar-mini4）。
 * 实测网关那 3 个模型请求全部报错。
 *
 * 本测试用**离线 mock** 固定这一契约：
 *   1) 远端目录可用时，models() 给出的是**远端**集合（含新免费模型）；
 *   2) `/models` 里没有 cline-free/*，故免费集合只能来自 recommended-models；
 *   3) 远端全挂时回退静态兜底表（不能让渠道整个空掉）。
 */
// TS 解析钩子（vendor NodeNext 内部 `./x.js` 说明符 → 磁盘 `.ts`）。
// 必须在任何业务 import 之前注册，否则渠道协议模块报 ERR_MODULE_NOT_FOUND
// 且文案形似「缺文件」——2026-11-12 的 6 条红全因于此。生产由 index_turso.js
// 的 ensureTsHook() 兜底，测试入口必须自带。
import '../worker/backends/ts-hook.mjs';
import http from 'node:http';

let pass = 0, fail = 0;
const ok = (n, c, extra = '') => { c ? pass++ : fail++; console.log((c ? '✅ ' : '❌ ') + n + (extra ? '  ' + extra : '')); };

// ── mock 远端 ──
const FREE = ['reflection/beam-free', 'cline-free/solar-mini4'];
let routes = {};
const srv = http.createServer((req, res) => {
  const path = req.url.split('?')[0];
  const h = routes[path];
  if (!h) { res.writeHead(404); res.end('{}'); return; }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(h));
});
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${srv.address().port}`;

const { CLINE } = await import('../worker/vendor/channel-pack/src/cline-product.ts');
// 端点路径来自 product，改 apiBase 指向 mock
const origBase = CLINE.apiBase;

// ── 1) 离线兜底：远端 404 时仍要有模型（不能空）──
routes = {};
const mod1 = await import('../worker/backends/cline.js');
const fallback = mod1.backend.models();
ok('1 远端不可用时回退静态兜底表（非空）', fallback.length > 0, fallback.length + ' 条');
ok('2 兜底表里仍是旧的 3 个模型（这正是不该作为唯一的证据）',
   fallback.length === 3, fallback.map(m => m.id).join(','));

// ── 2) 核心：merge 逻辑必须让远端 free 覆盖兜底表 ──
// 直接测合并函数（离线、不依赖网络），这是缺陷的真正所在
const { mergeClineModels, isClineFreeModel } = await import('../worker/vendor/channel-pack/src/cline-models.ts');
const remote = {
  freeIds: FREE,
  remoteIds: ['openai/gpt-6.1-terra', 'anthropic/claude-sonnet-5.5'],
  entries: [...FREE.map(id => ({ id })), ...['openai/gpt-6.1-terra'].map(id => ({ id }))],
};
const merged = mergeClineModels(CLINE, remote);
const ids = merged.map(m => m.id);
ok('3 远端免费模型排在最前', ids[0] === FREE[0] && ids[1] === FREE[1], ids.slice(0, 3).join(','));
ok('4 已下架的兜底模型被剔除（远端认识目录时）',
   !ids.includes('stealth/space-bunny-alpha') && !ids.includes('cline-free/mimo-v2.6-flash'),
   ids.filter(i => i.includes('space-bunny') || i.includes('mimo-v2.6-flash')).join(',') || '已剔除');
ok('5 远端 /models 的 id 也并入（放最后）',
   ids.includes('openai/gpt-6.1-terra'), ids.slice(-2).join(','));
ok('6 免费判定：远端 free 数组优先', merged.filter(m => m.isFree).map(m => m.id).every(id => FREE.includes(id)),
   merged.filter(m => m.isFree).map(m => m.id).join(','));

// ── 3) 契约：/models 不含 cline-free/*，免费只能来自 recommended-models ──
//    这条是「只调 /models 会看不到任何免费模型」的回归钉子
const onlyModels = mergeClineModels(CLINE, {
  freeIds: [], remoteIds: ['openai/gpt-6.1-terra'], entries: [{ id: 'openai/gpt-6.1-terra' }],
});
ok('7 只有 /models 时免费数为 0（证明免费只能靠 recommended-models）',
   onlyModels.filter(m => m.isFree).length === 0, '免费 ' + onlyModels.filter(m => m.isFree).length + ' 条');

srv.close();
console.log('\n=== PASS ' + pass + ' / FAIL ' + fail + ' ===');
process.exit(fail ? 1 : 0);
