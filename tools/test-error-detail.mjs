/**
 * 错误体解析 —— 用户实测「cline 所有失败都显示 `Cline: [object Object]`」。
 *
 * 真因是 `openai-family.js` 把 `JSON.parse(detail)` 的结果丢给 `errorMessage()`，
 * 而后者只认 `instanceof Error`，普通对象被 `String()` 成 `[object Object]`。
 * 后果：**所有渠道的所有上游错误都看不到原因**（不只是 cline）。
 *
 * 本测试钉住三条：
 *   1) 四种错误体形状都能读出人话（含 `data` 信封下钻）；
 *   2) 读不出时原样返回原文，不许变成 `[object Object]`；
 *   3) 非 JSON（HTML 502 页）也照原样返回。
 */
// TS 解析钩子（vendor NodeNext 内部 `./x.js` 说明符 → 磁盘 `.ts`）。
// 必须在任何业务 import 之前注册，否则渠道协议模块报 ERR_MODULE_NOT_FOUND
// 且文案形似「缺文件」——2026-11-12 的 6 条红全因于此。生产由 index_turso.js
// 的 ensureTsHook() 兜底，测试入口必须自带。
import '../worker/backends/ts-hook.mjs';
const { errorDetail } = await import('../worker/vendor/channel-pack/src/openai-compat.ts');

let pass = 0, fail = 0;
const ok = (n, c, extra = '') => { c ? pass++ : fail++; console.log((c ? '✅ ' : '❌ ') + n + (extra ? '  ' + extra : '')); };

const cases = [
  ['{"error":{"message":"quota exceeded"}}', 'quota exceeded', '嵌套 error.message'],
  ['{"error":"access forbidden: not in your region"}', 'access forbidden', 'error 是字符串'],
  ['{"code":500,"msg":"boom"}', 'code=500 boom', 'code+msg'],
  ['{"data":{"error":{"message":"嵌套在 data 里"}}}', '嵌套在 data 里', 'error 嵌在 data 信封里'],
  ['{"data":{"code":401,"message":"token expired"}}', 'code=401 token expired', 'data 平铺'],
];
for (const [body, want, label] of cases) {
  const got = errorDetail(body);
  ok(label, got.includes(want) && !got.includes('[object Object]'), JSON.stringify(got));
}

// 读不出任何已知键时：原样返回，不许出现 [object Object]
{
  const got = errorDetail('{"weird":{"nested":1}}');
  ok('未知形状原样返回(不是 [object Object])', !got.includes('[object Object]') && got.length > 0, got.slice(0, 60));
}
// 非 JSON（HTML 错误页）
{
  const got = errorDetail('<html>502 Bad Gateway</html>');
  ok('HTML 错误页原样返回', got.includes('502') && !got.includes('[object Object]'), got.slice(0, 50));
}

console.log('\n=== PASS ' + pass + ' / FAIL ' + fail + ' ===');
process.exit(fail ? 1 : 0);
