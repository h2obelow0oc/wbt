// 模型 id 前缀/后缀解析单元测试 —— 覆盖 workbuddy/ 前缀上线的三条不变量:
//   1. 列表对外带前缀: WB → workbuddy/<model>, 渠道 → <provider>/<model>
//   2. 入站能剥前缀:   workbuddy/default → provider=wb, model=default
//   3. 向后兼容:       裸 default (老配置) 仍按 WB 处理, 不 404
import { parseModelId, qualifyModelId, stripModelId } from '../worker/backends/index.js';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name} ${extra}`); }
};

console.log('── qualifyModelId (出站加前缀) ──');
ok('wb → workbuddy/', qualifyModelId('wb', 'default') === 'workbuddy/default', qualifyModelId('wb', 'default'));
ok('wb 带倍率后缀不被破坏', qualifyModelId('wb', 'default [x2.00]') === 'workbuddy/default [x2.00]', qualifyModelId('wb', 'default [x2.00]'));
ok('渠道原样', qualifyModelId('minimax', 'MiniMax-M3') === 'minimax/MiniMax-M3');
ok('cline 自带斜杠的模型', qualifyModelId('cline', 'stealth/space-bunny-alpha') === 'cline/stealth/space-bunny-alpha');

console.log('── parseModelId (入站剥前缀) ──');
{
  const r = parseModelId('workbuddy/default');
  ok('workbuddy/default → wb/default', r.provider === 'wb' && r.model === 'default', JSON.stringify(r));
}
{
  const r = parseModelId('workbuddy/default [x2.00]');
  ok('workbuddy/default [x2.00] → wb/default', r.provider === 'wb' && r.model === 'default', JSON.stringify(r));
}
{
  const r = parseModelId('default');
  ok('裸 default 仍 → wb/default (向后兼容)', r.provider === 'wb' && r.model === 'default', JSON.stringify(r));
}
{
  const r = parseModelId('default [x2.00]');
  ok('裸 default [x2.00] → wb/default', r.provider === 'wb' && r.model === 'default', JSON.stringify(r));
}
{
  const r = parseModelId('minimax/MiniMax-M3');
  ok('渠道前缀不受影响', r.provider === 'minimax' && r.model === 'MiniMax-M3', JSON.stringify(r));
}
{
  const r = parseModelId('cline/stealth/space-bunny-alpha');
  ok('cline 模型自带斜杠', r.provider === 'cline' && r.model === 'stealth/space-bunny-alpha', JSON.stringify(r));
}
{
  const r = parseModelId('workbuddy/default [g]');
  ok('workbuddy + g 标记', r.provider === 'wb' && r.model === 'default' && r.srcTag === 'g', JSON.stringify(r));
}

console.log('── 往返一致性 (出站 id 必须能被入站还原) ──');
for (const [prov, model] of [['wb', 'default'], ['wb', 'deepseek-v4-pro'], ['minimax', 'MiniMax-M3'], ['cline', 'stealth/space-bunny-alpha']]) {
  const out = qualifyModelId(prov, model);
  const back = parseModelId(out);
  ok(`${out} → ${prov}/${model}`, back.provider === prov && back.model === model, JSON.stringify(back));
}


console.log('── stripModelId (对话前还原裸 id 给 WB 上游) ──');
{
  const r = stripModelId('workbuddy/deepseek-v4.1-flash');
  ok('workbuddy/ 前缀被剥', r.id === 'deepseek-v4.1-flash', JSON.stringify(r));
}
{
  const r = stripModelId('workbuddy/default [x2.00]');
  ok('前缀+倍率后缀都剥', r.id === 'default', JSON.stringify(r));
}
{
  const r = stripModelId('workbuddy/default [g]');
  ok('前缀剥掉且保留 g 标记', r.id === 'default' && r.srcTag === 'g', JSON.stringify(r));
}
{
  const r = stripModelId('default [x2.00]');   // 老配置
  ok('裸 id 原样通过(向后兼容)', r.id === 'default', JSON.stringify(r));
}
{
  const r = stripModelId('default');
  ok('完全裸的 id', r.id === 'default' && r.srcTag === '', JSON.stringify(r));
}
{
  const r = stripModelId('minimax/MiniMax-M3');
  ok('渠道前缀不剥(WB 链路专用)', r.id === 'minimax/MiniMax-M3', JSON.stringify(r));
}

console.log('── parseModelId × stripModelId 双函数一致 ──');
for (const raw of ['workbuddy/default', 'workbuddy/default [x2.00]', 'default', 'default [g]']) {
  const a = parseModelId(raw), b = stripModelId(raw);
  ok(`同入参同裸 id: ${raw}`, a.model === b.id && a.srcTag === b.srcTag, JSON.stringify({a,b}));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
