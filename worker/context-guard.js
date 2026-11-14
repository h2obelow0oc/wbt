// === 上下文护栏 (context guard) ===
// 防"空转/历史无限膨胀"把账号额度烧穿:
//   1) 硬性上限: 估算 prompt token 超阈值直接 413, 无状态, 永不漏。
//   2) 循环熔断: 同(模型+末条消息+消息数)在窗口内重复 N 次 -> 429。
//      Worker isolate 内存实现 (KV 有 1 次/秒写限制, 不适合做高频计数);
//      真实兜底是第 1 条无状态上限。
// 不做任何消息改写/压缩: 网关是代理, 静默改动用户对话会让人意外。
//
// 护栏取值 = min(合理上限 REASONABLE_CAP, 模型真实上游窗口)。
//   - 模型有真实窗口(来自上游 /v3/config 的 maxInputTokens)时, 取两者更小:
//     上游 200k -> 护栏 200k; 上游 32k -> 护栏 32k。
//   - 模型无窗口声明(完全不设上下文限制)时, 回落到 REASONABLE_CAP 兜底,
//     防止"无限制"模型把巨 prompt 放给上游烧穿额度。
// 护栏取值 = min(真实窗口, CG_REASONABLE_CAP)。
// 真实窗口来自上游 /v3/config 的 maxInputTokens，是权威值，1M 模型就是 1M。
// CG_REASONABLE_CAP 只在「模型未声明窗口」时兜底 —— 那种情况宁可保守(262144)，
// 因为无声明等于不知道该防多少，给 1M 就等于没护栏。
const CG_DEFAULT_MAX_CONTEXT_TOKENS = 150000; // 仅作 deprecated 回退
const CG_REASONABLE_CAP = 1048576;   // 有真实窗口时的封顶(1M)，不限制 1M 模型
const CG_UNKNOWN_WINDOW_CAP = 262144; // 无窗口声明模型的保守兜底
const CG_DEFAULT_LOOP_REPEAT_LIMIT = 6;
const CG_DEFAULT_LOOP_WINDOW_MS = 120000;

function cgNum(v) { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : null; }

// 计算有效护栏上限: min(真实窗口, CG_REASONABLE_CAP=1M)。
//  - 有真实窗口 -> 取 min(真实, 1M)：1M 模型得 1M，200k 模型得 200k。
//  - 无窗口声明 / 异常值 -> CG_UNKNOWN_WINDOW_CAP(262144) 保守兜底。
function cgEffectiveCeiling(realWindow) {
  const w = cgNum(realWindow);
  if (w == null || w <= 0) return CG_UNKNOWN_WINDOW_CAP;
  return Math.min(w, CG_REASONABLE_CAP);
}
// 环境变量取值:
//   - CF Workers 经典 Service Worker: 环境变量是全局绑定, 用 typeof globalThis 取;
//   - Node (Render): 走 process.env —— 与 index_turso.js 的读取口径保持一致。
// 两路都试, 任一命中即可, 都用不到才回落默认值。
function cgGlobalNum(name) {
  try { if (typeof globalThis !== "undefined" && globalThis[name] != null) return cgNum(globalThis[name]); } catch (e) { /* ignore */ }
  try { if (typeof process !== "undefined" && process.env && process.env[name] != null) return cgNum(process.env[name]); } catch (e) { /* ignore */ }
  return null;
}
function cgConfig() {
  const maxCtx = cgGlobalNum("MAX_CONTEXT_TOKENS");
  const loopN = cgGlobalNum("LOOP_REPEAT_LIMIT");
  const loopW = cgGlobalNum("LOOP_WINDOW_MS");
  return {
    // 0/未设 = 自动模式(按 min(REASONABLE_CAP, 模型真实窗口)); >0 = 手动硬顶(仍不放大到超过 REASONABLE_CAP)。
    maxContextTokens: maxCtx != null ? maxCtx : 0,
    loopRepeatLimit: loopN != null ? loopN : CG_DEFAULT_LOOP_REPEAT_LIMIT,
    loopWindowMs: loopW != null ? loopW : CG_DEFAULT_LOOP_WINDOW_MS,
  };
}

// 粗估 token: CJK 约 1 token/字, 拉丁约 4 字符/token。宁可略高。
function cgEstimateTokens(messages) {
  let tokens = 0;
  for (const m of (messages || [])) {
    const c = m && m.content;
    let chars = 0, cjk = 0;
    if (typeof c === "string") {
      chars = c.length;
      for (let i = 0; i < c.length; i++) { const code = c.charCodeAt(i); if (code >= 0x3000 && code <= 0x9fff) cjk++; }
    } else if (Array.isArray(c)) {
      for (const part of c) {
        const p = part || {};
        if (typeof p.text === "string") chars += p.text.length;
        else if (typeof p.content === "string") chars += p.content.length;
        else { try { chars += JSON.stringify(part || "").length; } catch (e) { /* skip */ } }
      }
    } else if (c != null) {
      try { chars += JSON.stringify(c).length; } catch (e) { /* skip */ }
    }
    const asciiChars = Math.max(0, chars - cjk);
    tokens += cjk + Math.ceil(asciiChars / 4) + 4;
    // tool_calls 也算体积 (工具空转时它们同样在膨胀)
    if (m && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      try { tokens += Math.ceil(JSON.stringify(m.tool_calls).length / 4); } catch (e) { /* skip */ }
    }
  }
  return tokens;
}

function cgFingerprint(body) {
  const msgs = (body && body.messages) || [];
  const last = msgs.length > 0 ? msgs[msgs.length - 1] : null;
  const model = body && typeof body.model === "string" ? body.model : "";
  let lastStr = "";
  try { lastStr = last ? JSON.stringify(last).slice(0, 400) : ""; } catch (e) { lastStr = ""; }
  return model + "|" + msgs.length + "|" + lastStr;
}

const CG_LOOP_HITS = new Map();
function cgLoopHit(key, now, windowMs) {
  let arr = CG_LOOP_HITS.get(key);
  if (!Array.isArray(arr)) arr = [];
  arr = arr.filter(t => now - t < windowMs);
  arr.push(now);
  CG_LOOP_HITS.set(key, arr);
  if (CG_LOOP_HITS.size > 2048) {
    for (const [k, v] of CG_LOOP_HITS) { if (v.every(t => now - t >= windowMs)) CG_LOOP_HITS.delete(k); }
  }
  return arr.length;
}

// KV 跨请求循环计数 (wb 无 D1, KV 是唯一持久存储)。
// KV 有 ~60s 最终一致 + 单 key 1 次/秒写限制, 故这是 best-effort:
// 写失败一律吞掉, 绝不因此拦截或拖慢真实请求。无状态的上下文上限是硬兜底。
function cgBucket(now, windowMs) { return Math.floor(now / windowMs); }

async function cgKvLoopCount(ownerKey, fingerprint, now, windowMs) {
  try {
    if (typeof KV === "undefined" || !KV) return null;
    const bucket = cgBucket(now, windowMs);
    const k = "cgloop:" + bucket + ":" + ownerKey + ":" + fingerprint;
    const cur = Number(await KV.get(k)) || 0;
    const next = cur + 1;
    // 只在计数前进时写, 且失败忽略 (KV 写限流/配额不该影响对话)
    await KV.put(k, String(next), { expirationTtl: Math.max(120, Math.ceil(windowMs / 1000) * 2) });
    // 上一桶也读一下, 得到近似滑动窗口
    const prevK = "cgloop:" + (bucket - 1) + ":" + ownerKey + ":" + fingerprint;
    const prev = Number(await KV.get(prevK)) || 0;
    return next + prev;
  } catch (e) {
    return null;
  }
}

// 返回 null = 放行; 否则返回 { status, body } 拒绝。
// realWindow: 该模型真实上游窗口(tokens), 未知传 null。
async function cgCheckAsync(body, cfg, ownerKey, now, realWindow) {
  const sync = cgCheck(body, cfg, ownerKey, now, realWindow);
  if (sync) return sync;
  // 内存熔断未触发时, 再查一次 KV 跨请求计数 (跨 isolate 才拦得住)
  if (cfg.loopRepeatLimit > 0) {
    const n = now || Date.now();
    const hits = await cgKvLoopCount(String(ownerKey || "anon"), cgFingerprint(body), n, cfg.loopWindowMs);
    if (hits != null && hits >= cfg.loopRepeatLimit) {
      return {
        estimated: cgEstimateTokens((body && body.messages) || []),
        status: 429,
        body: { error: {
          message: "The same request has been submitted " + hits + " times in " + Math.round(cfg.loopWindowMs / 1000) +
            "s (runaway loop detected). Halting to protect upstream quota. If this is intentional, wait and retry.",
          type: "rate_limit_error", code: "loop_detected" } },
      };
    }
  }
  return null;
}

/**
 * 计算指定模型的有效护栏上限(tokens)。
 * 返回 min(REASONABLE_CAP, 真实窗口); 未知/异常窗口按 REASONABLE_CAP 兜底。
 * 供 handleProxy 在调用前取该模型真实窗口后传入。
 */
function cgCeilingFor(realWindow) { return cgEffectiveCeiling(realWindow); }

// 返回 null = 放行; 否则返回 { status, body } 拒绝。
// realWindow: 该模型真实上游窗口(来自 /v3/config maxInputTokens), 未知传 null。
function cgCheck(body, cfg, ownerKey, now, realWindow) {
  now = now || Date.now();
  const messages = (body && body.messages) || [];
  const estimated = cgEstimateTokens(messages);
  // 有效上限 = min( 手动硬顶(若设), REASONABLE_CAP, 模型真实窗口 )。
  // 三者取最小: 手动值只能收紧不能放宽; 无声明模型由 REASONABLE_CAP 兜底。
  let ceiling = cgEffectiveCeiling(realWindow);
  if (cfg.maxContextTokens > 0) ceiling = Math.min(ceiling, cfg.maxContextTokens);

  if (ceiling > 0 && estimated > ceiling) {
    return {
      estimated,
      status: 413,
      body: { error: {
        message: "Prompt is ~" + estimated + " tokens, exceeding the wb gateway's " + ceiling +
          "-token context ceiling. This request looks like an unbounded conversation (a spin) replaying its full history; compact or start a fresh session.",
        type: "context_length_exceeded", code: "context_too_large" } },
    };
  }

  if (cfg.loopRepeatLimit > 0) {
    const key = String(ownerKey || "anon") + "|" + cgFingerprint(body);
    const hits = cgLoopHit(key, now, cfg.loopWindowMs);
    if (hits >= cfg.loopRepeatLimit) {
      return {
        estimated,
        status: 429,
        body: { error: {
          message: "The same request has been submitted " + hits + " times in " + Math.round(cfg.loopWindowMs / 1000) +
            "s (runaway loop detected). Halting to protect upstream quota. If this is intentional, wait and retry.",
          type: "rate_limit_error", code: "loop_detected" } },
      };
    }
  }

  return null;
}

// ===== ESM 导出 (Node / Render 版必需) =====
// CF 版靠 deploy.sh 把本文件内联进 worker_kv.js 单文件, 所以从不需要 export;
// Node 版是真正的 ES module, index_turso.js 必须能 import 到这些符号,
// 否则运行时抛 ReferenceError: cgCheckAsync is not defined。
export {
  cgCheck,
  cgCheckAsync,
  cgConfig,
  cgEffectiveCeiling,
  cgCeilingFor,
  cgEstimateTokens,
  cgFingerprint,
  CG_REASONABLE_CAP,
  CG_UNKNOWN_WINDOW_CAP,
};
