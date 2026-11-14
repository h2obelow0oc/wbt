/**
 * 面板 HTML/JS 语法门禁 —— 「整页 JS 挂掉」这一类缺陷的唯一防线。
 *
 * ## 为什么必须有这条测试（2026-11-03 真实事故）
 * 用户报「网关网页又不显示 key 了」。后端 /api/keys 完全正常（200，返回 2 个 key），
 * 前端 showKeys() 逻辑也正常 —— 但**整段脚本 SyntaxError 了**：
 * `resetAll()` 的 confirm 文案写在 `export const UI = \`...\`` 这个**模板字面量**里，
 * 单写 `\n` 会被外层模板在**服务端**就吃成真换行，注入浏览器后字符串字面量断开。
 * 后果是**所有函数都没定义**，点「API Key 管理」毫无反应。
 *
 * 手工点一遍页面能发现，但它只在**点了那个按钮**时才暴露；而 SyntaxError 是
 * 全局性的。所以这条测试直接抽脚本跑 `node --check`，并在渲染后复查
 * 「函数是否真的可用」。
 */
import { safeEvalOfUi } from './lib-ui-render.mjs';

let pass = 0, fail = 0;
const ok = (n, c, extra = '') => { c ? pass++ : fail++; console.log((c ? '✅ ' : '❌ ') + n + (extra ? '  ' + extra : '')); };

// 1) 取渲染后的页面（服务端 how-to：UI.replaceAll('__BASE__', base)）
const { html, script } = await safeEvalOfUi();

// 2) 脚本必须能通过语法检查
ok('1 页面脚本无语法错误', script.syntaxOk, script.syntaxErr || '');

// 3) confirm/alert 的文案必须是**单行**字面量 —— 裸换行必然把字符串断开。
//    这是「整页 SyntaxError」的最常见成因，单列一条，坏版本下必须红。
const confirmCalls = [...script.src.matchAll(/confirm\('((?:[^'\\]|\\.)*)'/g)].map(m => m[1]);
const badConfirm = confirmCalls.filter(t => t.includes('\n'));
ok('2 confirm 文案内没有真实换行', badConfirm.length === 0,
   badConfirm.length ? '含裸换行: ' + JSON.stringify(badConfirm[0]).slice(0, 60) : '');

// 4) 关键函数必须真的被定义（不只是"文本里出现"）
const names = ['showKeys', 'loadAll', 'doRefresh', 'doCheckin', 'doCredits', 'resetAll', 'importAcc', 'delAcc'];
const missing = names.filter(n => !new RegExp(`(async )?function ${n}\\b`).test(script.src) && !new RegExp(`const ${n} *=`).test(script.src));
ok('3 关键函数都已定义', missing.length === 0, missing.length ? '缺: ' + missing.join(',') : '');

// 5) 上一版事故的直接回归：resetAll 里的 \n 必须是转义形态(双反斜杠)
//    （渲染后应为 `\\n`，即字面量里的两个字符）
//    直接检查 resetAll 的 confirm 实参：合法时它含的是**反斜杠+n 两个字符**，
//    非法时含的是真正的换行符。断言必须能区分这两者（上一版写成 `|| true`，永远绿）。
const raBlock = (script.src.match(/async function resetAll\(\)[\s\S]*?\n\}/) || [''])[0];
const raConfirm = (raBlock.match(/confirm\('((?:[^'\\]|\\.)*)'/) || [])[1] || '';
ok('4 resetAll 文案用转义换行(不是真换行)',
   raBlock.length > 0 && !raConfirm.includes('\n'),
   raConfirm ? '文案含真换行=' + raConfirm.includes('\n') : '未取到 confirm 文案');

// 6) 每个内联事件处理器引用的函数都必须存在（防止按钮指向不存在的函数）
const handlers = [...script.src.matchAll(/onclick="([a-zA-Z_$][\w$]*)\(/g)].map(m => m[1]);
const bad = [...new Set(handlers)].filter(f => !new RegExp(`(async )?function ${f}\\b`).test(script.src) && !new RegExp(`const ${f} *=`).test(script.src));
ok('5 所有 onclick 引用的函数都存在', bad.length === 0, bad.length ? '缺: ' + bad.join(',') : '');

console.log('\n=== PASS ' + pass + ' / FAIL ' + fail + ' ===');
process.exit(fail ? 1 : 0);
