// 11140 封禁冻结单元测试（hub v2.1.0/v2.1.1 语义移植的验收钉）
//   1. ban-classify 纯函数：判定窄（只认 11140，其余 403 不动）、落标全、解禁清干净
//   2. peekBanError 语义（用同样的解析形状复测）：封禁证据 / 非 JSON / 别的码
import { isBannedError, isBannedCheckin, markBanned, clearBanned, BAN_CODE } from '../worker/ban-classify.js';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name} ${extra}`); }
};

console.log('── 判定（宁窄勿宽）──');
ok('code 11140 → 封禁', isBannedError({ code: 11140, msg: 'request illegal' }) === true);
ok('字符串形态 code "11140" 也认', isBannedError({ code: '11140' }) === true);
ok('error.code 嵌套形态也认', isBannedError({ error: { code: 11140 } }) === true);
ok('11128 内容拦截 ≠ 封禁', isBannedError({ code: 11128, msg: 'Illegal API invocation' }) === false);
ok('403 风控文案（无 11140）≠ 封禁（走 24h 冷却老路）', isBannedError({ code: 403, msg: '账号存在异常行为' }) === false);
ok('空体/非对象不炸', isBannedError(null) === false && isBannedError('x') === false);
ok('签到结果 11140 → 封禁', isBannedCheckin({ status: 403, code: 11140 }) === true);
ok('签到幂等码 10001 ≠ 封禁', isBannedCheckin({ status: 200, code: 10001 }) === false);
ok('签到结果空值不炸', isBannedCheckin(null) === false);

console.log('── 落标 / 解禁 ──');
{
  const a = { id: 'x', enabled: 1 };
  markBanned(a, 'code=11140 msg=request illegal');
  ok('冻结三件套 enabled=0 / banned=1 / 证据留存',
    a.enabled === 0 && a.banned === 1 && String(a.bannedEvidence).includes('11140'));
  ok('bannedAt 为秒级 epoch', typeof a.bannedAt === 'number' && a.bannedAt > 1e9);
  clearBanned(a);
  ok('解禁清干净（banned/证据回无、enabled 回 1）',
    a.enabled === 1 && a.banned === 0 && a.bannedAt === undefined && a.bannedEvidence === undefined);
}
{
  const a = { id: 'y', enabled: 1 };
  markBanned(a, 'x'.repeat(1000));
  ok('证据截断 ≤300 防 KV 撑大', a.bannedEvidence.length <= 300);
}
ok('BAN_CODE 常量 = 11140', BAN_CODE === 11140);

console.log(`\nban-freeze: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
