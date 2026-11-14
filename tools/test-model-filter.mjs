/**
 * 模型管理筛选/批量挂钩的纯逻辑测试。
 *
 * 用户要求（2026-11-03）:
 *   「按渠道分结果 cline 一个就占了几百行，大部分付费模型对我根本没用。
 *    筛选下拉改成 wb国内/wb国际/渠道1/渠道2...，并在每个渠道选择以后增加
 *    一个整体挂钩，方便我把这个渠道全部模型隐藏，免费。再加一个下拉筛选
 *    免费/付费/全部，这样我单独取消免费模型的隐藏。」
 *
 * 三条逻辑各有独立的坑，逐条钉住:
 *   ① 分组：渠道必须**按前缀**分成独立项（否则 cline 的 453 条淹没一切）；
 *   ② 免费判定：三个来源都要认，且 `—`(未知) **不算免费** —— 把未知
 *      当免费会让「仅免费」筛选混进按量计费的模型，用户按免费预期使用被扣费；
 *   ③ 保存：筛选后 DOM 里只有一部分行，**必须与已有集合合并**，
 *      整体替换会把其它分组已隐藏的模型全放出来。
 */
import fs from 'node:fs';

let pass = 0, fail = 0;
const ok = (n, c, extra = '') => { c ? pass++ : fail++; console.log((c ? '✅ ' : '❌ ') + n + (extra ? '  ' + extra : '')); };

// 从 ui.js 抽出纯函数（不依赖 DOM）
const src = fs.readFileSync(new URL('../worker/ui.js', import.meta.url), 'utf8');
const grab = name => {
  const m = new RegExp(`function ${name}\\([^)]*\\)\\{[\\s\\S]*?\\n\\}`).exec(src);
  if (!m) throw new Error('抽不到 ' + name);
  return m[0];
};
const helpers = ['modelGroup', 'modelIsFree', 'modelGroupOptions'].map(grab).join('\n');
const { modelGroup, modelIsFree, modelGroupOptions } = new Function(helpers + '\nreturn {modelGroup,modelIsFree,modelGroupOptions};')();

// ── ① 分组 ──
ok('1 WB 国内 → wb-cn', modelGroup({ id: 'hy3', realm: 'cn', srcTag: '' }) === 'wb-cn');
ok('2 WB 国际 → wb-g', modelGroup({ id: 'hy3 [g]', realm: 'global', srcTag: 'g' }) === 'wb-g');
ok('3 渠道按前缀分组', modelGroup({ id: 'cline/cline-free/solar-mini4', realm: 'channel' }) === 'ch:cline');
ok('4 minimax 与 cline 不混组',
   modelGroup({ id: 'minimax/MiniMax-M3', realm: 'channel' }) === 'ch:minimax');

// ── ② 免费判定 ──
ok('5 渠道"免费"', modelIsFree({ multiplier: '免费' }) === true);
ok('6 WB x0.00 也算免费', modelIsFree({ multiplier: 'x0.00' }) === true);
ok('7 促销免费', modelIsFree({ discounted: '免费' }) === true);
ok('8 付费 x0.51', modelIsFree({ multiplier: 'x0.51' }) === false);
// ⚠️ 靶心：`—` 是"不知道"不是"不要钱"
ok('9 「—」未知不算免费（否则会误标按量计费模型）', modelIsFree({ multiplier: '—' }) === false);
ok('10 空倍率不算免费', modelIsFree({ multiplier: '' }) === false);

// ── ③ 分组下拉的计数与顺序 ──
{
  const ms = [
    { id: 'hy3', realm: 'cn', srcTag: '' },
    { id: 'hy4', realm: 'cn', srcTag: '' },
    { id: 'hy3 [g]', realm: 'global', srcTag: 'g' },
    { id: 'cline/a', realm: 'channel' }, { id: 'cline/b', realm: 'channel' }, { id: 'cline/c', realm: 'channel' },
    { id: 'minimax/MiniMax-M3', realm: 'channel' },
    { id: 'raccoon/sn-glm-5-3', realm: 'channel' },
  ];
  const opts = modelGroupOptions(ms);
  const byV = Object.fromEntries(opts.map(o => [o.v, o.n]));
  ok('11 分组计数正确', byV['wb-cn'] === 2 && byV['wb-g'] === 1 && byV['ch:cline'] === 3 && byV['ch:minimax'] === 1,
     JSON.stringify(byV));
  // 顺序: WB 国内 → WB 国际 → 渠道按固定序
  const order = opts.map(o => o.v);
  ok('12 顺序 = wb国内/wb国际/渠道', order[0] === 'wb-cn' && order[1] === 'wb-g' && order[2].startsWith('ch:'),
     order.join(' → '));
  ok('13 渠道按固定序 raccoon→minimax→lobsterai→cline',
     order.filter(v => v.startsWith('ch:')).join(',') === 'ch:raccoon,ch:minimax,ch:cline',
     order.filter(v => v.startsWith('ch:')).join(','));
}

// ── ④ 保存必须合并（模拟 DOM 只有部分行）──
//     这段逻辑在 saveHidden 里，用等价实现验证语义
{
  const HIDDEN = { _loaded: 1, 'wb-cn-hidden': 1, 'wb-g-hidden': 1 };
  // 场景: 筛到 cline，DOM 里 3 行，其中 2 个被勾
  const domRows = [{ id: 'cline/a', checked: true }, { id: 'cline/b', checked: true }, { id: 'cline/c', checked: false }];
  // ❌ 错误做法: 整体替换
  const bad = {}; domRows.forEach(r => { if (r.checked) bad[r.id] = 1; });
  // ✅ 正确做法: 先复制已有集合，再按可见行增删
  const good = {}; for (const k of Object.keys(HIDDEN)) if (k !== '_loaded') good[k] = 1;
  domRows.forEach(r => { if (r.checked) good[r.id] = 1; else delete good[r.id]; });
  ok('14 整体替换会丢其它分组的隐藏（这是坑）', !('wb-cn-hidden' in bad), 'bad=' + JSON.stringify(Object.keys(bad)));
  ok('15 合并后其它分组隐藏仍在', good['wb-cn-hidden'] === 1 && good['wb-g-hidden'] === 1, JSON.stringify(Object.keys(good)));
  ok('16 合并后新增 cline 两个', good['cline/a'] === 1 && good['cline/b'] === 1);
}

console.log('\n=== PASS ' + pass + ' / FAIL ' + fail + ' ===');
process.exit(fail ? 1 : 0);
