/**
 * 自动签到调度 —— 用户明确要求「一个稳定以后我可能一个月不看一次」。
 *
 * 所以「打开页面顺手补」只是兜底，主路径必须自己跑、且要能容忍失败。
 *
 * 本测试钉住四条契约（都是旧实现的实际缺陷）：
 *   ① 周期是**分钟级**（默认 30min），不是 6h —— 跨过北京 0 点后不能等太久；
 *   ② 启动即跑一次（部署/重启后立刻对齐）；
 *   ③ **硬失败不记账**，下个 tick 重试（旧实现先记账，一次抖动就丢掉一整天）；
 *   ④ 日志按「日期+状态」去重，一天不刷几十条，但状态变化必写。
 */
import fs from 'node:fs';

let pass = 0, fail = 0;
const ok = (n, c, extra = '') => { c ? pass++ : fail++; console.log((c ? '✅ ' : '❌ ') + n + (extra ? '  ' + extra : '')); };

const src = fs.readFileSync(new URL('../worker/index_turso.js', import.meta.url), 'utf8');

// ① 周期
ok('1 签到周期不是 6h 而是分钟级',
   /CHECKIN_TICK_MS\s*=\s*Number\(process\.env\.CHECKIN_TICK_MS\s*\?\?\s*30\s*\*\s*60\s*\*\s*1000\)/.test(src),
   '默认应为 30min');
ok('2 CHECKIN_TICK_MS 可配且 <=0 可关',
   /if\s*\(\s*CHECKIN_TICK_MS\s*>\s*0\s*\)/.test(src));

// ② 启动即跑
ok('3 启动立刻跑一次（不等第一个 tick）',
   /setTimeout\(\(\)\s*=>\s*\{\s*checkinTick\(\)/.test(src));

// ③ 失败不记账
//    关键片段: 只有 ok 为真才 _checkinState.set
{
  const body = (src.match(/async function checkinTick\(\)[\s\S]*?\n\}/) || [''])[0];
  ok('4 抽到 checkinTick 实现', body.length > 200, body.length + ' 字符');
  // 「if (ok) { _checkinState.set(...) }」—— 记账必须在 ok 分支内
  const m = /if \(ok\) \{[\s\S]{0,200}?_checkinState\.set/.exec(body);
  ok('5 只有成功才记账（失败会下个 tick 重试）', !!m, m ? '已确认在 ok 分支内' : '记账位置可疑');
  // 反证: 记账不能在 ok 分支之前
  const setPos = body.indexOf('_checkinState.set');
  const okPos = body.indexOf('if (ok)');
  ok('6 记账发生在判定成功之后', setPos > okPos && okPos > 0, `ok@${okPos} set@${setPos}`);
}

// ④ 日志去重
{
  const body = (src.match(/async function checkinTick\(\)[\s\S]*?\n\}/) || [''])[0];
  ok('7 有日期级日志去重表', /_checkinLogged\.get\(acc\.id\)\s*!==\s*tag/.test(body), '');
  ok('8 声明的日子用北京时区', /bjDay\(\)/.test(body));
  ok('9 bjDay 用 +8 小时而不是本地时区',
     /function bjDay\([\s\S]{0,160}\+ 8 \* 3600 \* 1000/.test(src), '');
}

// ⑤ 单一签到入口（runCron 不再重复签，避免双写）
{
  const cron = (src.match(/async function runCron\(\)[\s\S]*?\n\}/) || [''])[0];
  ok('10 runCron 不再重复签到（签到只走 checkinTick）',
     !/chanCheckin\(acc\)/.test(cron) && !/await checkin\(acc\)/.test(cron), '');
}

// ⑥ reset 不触发补签（否则清理完立刻被签回、日志断言红）
ok('11 reset 请求跳过 lazyCheckin', /p !== "reset"\)\s*lazyCheckin\(\)/.test(src), '');

// ⑦ WB 也纳入签到（旧版只覆盖 minimax/lobsterai）
{
  const body = (src.match(/async function checkinTick\(\)[\s\S]*?\n\}/) || [''])[0];
  ok('12 checkinTick 覆盖 WB（不只是渠道）', /isWb/.test(body) && /await checkin\(acc\)/.test(body), '');
}

// ⑧ 日界线门禁（2026-11-04 用户洞察：供应商只有 CN / UTC 两类时区）
//    「都改 8:00 北京时间」= CHECKIN_GATE_HOUR=8 强制覆盖。
{
  const body = (src.match(/async function checkinTick\(\)[\s\S]*?\n\}/) || [''])[0];
  ok('13 checkinTick 有日界线门禁', /const gate = checkinGate\(acc\)/.test(body) && /!gate\.passed/.test(body), '');
  // 11-04 用户决定：默认一律 8:00（宁晚不早）。
  ok('14 默认一律 8:00（不按渠道分流）',
     /const DEFAULT_GATE_HOUR = 8/.test(src) && /return DEFAULT_GATE_HOUR/.test(src), '');
  ok('14b auto 模式仍保留按归属分流口子',
     /isAutodetect/.test(src) && /lobsterai.*?\? 0 : 8/s.test(src), '');
  ok('15 CHECKIN_GATE_HOUR 可强制全局 8 点', /CHECKIN_GATE_HOUR/.test(src) && /GATE_FORCE/.test(src), '');
}

// ⑨ 「未结算」绝不记账（2026-11-04 事故的核心）
{
  const body = (src.match(/async function checkinTick\(\)[\s\S]*?\n\}/) || [''])[0];
  ok('16 未结算结果在记账之前就 continue', /if \(ok && !settled\)[\s\S]{0,400}?continue/.test(body), '');
}

console.log('\n=== PASS ' + pass + ' / FAIL ' + fail + ' ===');
process.exit(fail ? 1 : 0);
