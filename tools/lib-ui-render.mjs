/**
 * 把 worker/ui.js 渲染成浏览器真正收到的 HTML，并抽出内联脚本。
 *
 * ⚠️ 必须在**独立进程外**模拟：ui.js 导出的是模板字面量 `UI`，其 `\n`
 * 在模块加载时就被解释 —— 这与服务端 `new Response(UI.replaceAll(...))`
 * 完全同一条路径，所以这里读到的就是用户浏览器收到的字节。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export async function safeEvalOfUi() {
  const mod = await import('../worker/ui.js');
  const html = String(mod.UI).replaceAll('__BASE__', '');
  const blocks = [...html.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  const src = blocks.join('\n;\n');
  // 写到临时文件跑 node --check：能查出所有 SyntaxError，含字符串未闭合
  const tmp = path.join(process.env.TMPDIR || '/tmp', `ui-syntax-${process.pid}.js`);
  fs.writeFileSync(tmp, src);
  let syntaxOk = true, syntaxErr = '';
  try { execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' }); }
  catch (e) {
    syntaxOk = false;
    syntaxErr = String(e.stderr || e.message).split('\n').filter(Boolean).slice(0, 4).join(' | ');
  } finally { try { fs.unlinkSync(tmp); } catch {} }
  return { html, script: { src, syntaxOk, syntaxErr } };
}
