// WorkBuddy Manager (classic worker, single file)

//=== wb_protocol ===
// ===== WorkBuddy 上游协议层 (基于 ithtelab/workbuddy-manager tencent.py 验证过的端点) =====
// 国内 CN: chat=copilot.tencent.com, billing=www.codebuddy.cn
// 国际 GLOBAL: chat=billing=www.workbuddy.ai

const UA = "CLI/2.63.2 CodeBuddy/2.63.2";
const ORIGIN = { cn: "https://www.codebuddy.cn", global: "https://www.workbuddy.ai" };
const CHAT_BASE = { cn: "https://copilot.tencent.com", global: "https://www.workbuddy.ai" };
const BILLING_BASE = { cn: "https://www.codebuddy.cn", global: "https://www.workbuddy.ai" };

function realmOf(acc) {
  const d = (acc.domain || "").toLowerCase();
  if (d.includes("workbuddy.ai")) return "global";
  return "cn";
}
function chatBase(acc) { return CHAT_BASE[realmOf(acc)]; }
function billingBase(acc) { return BILLING_BASE[realmOf(acc)]; }
function originOf(acc) { return ORIGIN[realmOf(acc)]; }

function commonHeaders(acc, token) {
  const h = {
    "User-Agent": UA,
    "X-Requested-With": "XMLHttpRequest",
    "Origin": originOf(acc),
    "Referer": originOf(acc) + "/",
    "Accept": "application/json",
    "Content-Type": "application/json",
  };
  if (acc.uid) h["X-User-Id"] = acc.uid;
  if (acc.domain) h["X-Domain"] = acc.domain;
  if (token) h["Authorization"] = "Bearer " + token;
  return h;
}
// billing 域额外需要 X-User-Id 身份头
function billingHeaders(acc, token) {
  const h = commonHeaders(acc, token);
  if (acc.uid) h["X-User-Id"] = acc.uid;
  return h;
}

// 把毫秒 expiresAt 规范化为秒
function normExpires(v) {
  v = Number(v);
  if (!v) return 0;
  return v > 1e12 ? Math.floor(v / 1000) : Math.floor(v);
}

// ---- 刷新 token (保活核心) ----
async function refreshToken(acc) {
  const url = chatBase(acc) + "/v2/plugin/auth/token/refresh";
  const headers = {
    "User-Agent": UA, "X-Requested-With": "XMLHttpRequest",
    "Origin": originOf(acc), "Referer": originOf(acc) + "/",
    "Content-Type": "application/json",
    "X-Refresh-Token": acc.refresh_token,
    "X-Auth-Refresh-Source": "workbuddy",
  };
  if (acc.uid) headers["X-User-Id"] = acc.uid;
  if (acc.domain) headers["X-Domain"] = acc.domain;
  const r = await fetch(url, { method: "POST", headers });
  if (!r.ok) throw new Error("refresh HTTP " + r.status + ": " + (await r.text()).slice(0, 160));
  const d = await r.json().catch(() => null);
  if (!d || !d.accessToken) throw new Error("refresh 回包无 accessToken");
  return {
    access_token: d.accessToken,
    refresh_token: d.refreshToken || acc.refresh_token,
    expires_at: d.expiresIn ? Math.floor(Date.now() / 1000) + Number(d.expiresIn) : acc.expires_at,
  };
}

// ---- 签到 ----
async function checkin(acc) {
  const suffix = "/billing/meter/daily-checkin";
  const paths = realmOf(acc) === "global"
    ? ["/billing/meter/daily-checkin", "/v2/billing/meter/daily-checkin"]
    : ["/v2/billing/meter/daily-checkin"];
  for (const p of paths) {
    const r = await fetch(billingBase(acc) + p, {
      method: "POST", headers: billingHeaders(acc, acc.access_token), body: "{}",
    });
    if (r.status === 404) continue;
    const d = await r.json().catch(() => ({}));
    // 重复签到回 10001 / 已签 视为成功
    return { status: r.status, code: d.code, msg: d.msg || ("HTTP " + r.status) };
  }
  return { status: 404, code: 404, msg: "endpoint 404" };
}

// ---- 额度/积分 (ProductCode=p_tcaca) ----
async function fetchCredits(acc) {
  const paths = realmOf(acc) === "global"
    ? ["/billing/meter/get-user-resource", "/v2/billing/meter/get-user-resource"]
    : ["/v2/billing/meter/get-user-resource"];
  const now = new Date();
  const body = {
    PageNumber: 1, PageSize: 100, ProductCode: "p_tcaca", Status: [0, 3],
    PackageEndTimeRangeBegin: fmt(now),
    PackageEndTimeRangeEnd: fmt(new Date(now.getTime() + 365 * 101 * 864e5)),
  };
  for (const p of paths) {
    const r = await fetch(billingBase(acc) + p, {
      method: "POST", headers: billingHeaders(acc, acc.access_token),
      body: JSON.stringify(body),
    });
    if (r.status === 404) continue;
    const d = await r.json().catch(() => null);
    if (!d || d.code !== 0) return { ok: false, msg: "查询失败 code=" + (d && d.code) };
    return parseCredits(d.data);
  }
  return { ok: false, msg: "endpoint 404" };
}
function fmt(dt) {
  const p = (n) => String(n).padStart(2, "0");
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())} ${p(dt.getHours())}:${p(dt.getMinutes())}:${p(dt.getSeconds())}`;
}
function parseCredits(data) {
  // data 结构随版本; 兼容 accounts / records / list
  let items = [];
  if (Array.isArray(data)) items = data;
  else if (Array.isArray(data.accounts)) items = data.accounts;
  else if (Array.isArray(data.records)) items = data.records;
  else if (Array.isArray(data.list)) items = data.list;
  else if (Array.isArray(data.data)) items = data.data;
  let total = 0, expiries = [];
  for (const it of items) {
    if (!it || typeof it !== "object") continue;
    const remain = Math.max(0, Number(it.CycleCapacityRemain ?? it.CapacityRemain ?? it.remain ?? it.Remain ?? 0));
    total += remain;
    const end = it.CycleEndTime ?? it.PackageEndTime ?? it.endTime;
    if (remain > 0 && end) {
      const at = typeof end === "number" ? end : Date.parse(end) / 1000;
      if (at) expiries.push({ at, amount: Math.round(remain) });
    }
  }
  expiries.sort((a, b) => a.at - b.at);
  return { ok: true, credits: Math.round(total), expiries };
}

// ---- 模型探测 (含倍率注释) ----
async function fetchModels(acc) {
  // 1) 企业端点
  const entPaths = realmOf(acc) === "global"
    ? ["/v2/enterprises/personal/models", "/console/enterprises/personal/models"]
    : ["/console/enterprises/personal/models"];
  let models = [], v3 = null, entErr = null;
  for (const p of entPaths) {
    try {
      const r = await fetch(chatBase(acc) + p, { headers: commonHeaders(acc, acc.access_token) });
      if (!r.ok) { entErr = "HTTP " + r.status; continue; }
      const d = await r.json().catch(() => null);
      if (d && d.data && Array.isArray(d.data)) {
        collectModels(d.data, models);
        entErr = null; break;
      }
    } catch (e) { entErr = String(e); }
  }
  // 2) /v3/config (倍率常在此)
  try {
    const r3 = await fetch(chatBase(acc) + "/v3/config", { headers: commonHeaders(acc, acc.access_token) });
    if (r3.ok) v3 = await r3.json().catch(() => null);
  } catch (e) {}
  if (v3) collectModels(v3, models, true);
  // 去重
  const seen = new Set(); const uniq = [];
  for (const m of models) { if (!seen.has(m.id)) { seen.add(m.id); uniq.push(m); } }
  return { ok: uniq.length > 0, models: uniq, v3: v3, entErr };
}
// 从各种结构抽取模型; 倍率字段名多样(multiplier/price/ratio/倍率/costMultiplier)
function collectModels(data, out, fromV3) {
  let arr = [];
  if (Array.isArray(data)) arr = data;
  else if (Array.isArray(data.data)) arr = data.data;
  else if (Array.isArray(data.models)) arr = data.models;
  else if (Array.isArray(data.agents)) { for (const a of data.agents) if (Array.isArray(a.models)) arr.push(...a.models.map(x => ({ id: x }))); }
  for (const it of arr) {
    if (typeof it === "string") { out.push({ id: it }); continue; }
    if (!it || !it.id) continue;
    out.push({
      id: it.id,
      multiplier: it.multiplier ?? it.price ?? it.ratio ?? it.costMultiplier ?? it.Multiplier ?? null,
      context: it.context ?? it.contextWindow ?? null,
      maxOutput: it.maxOutput ?? it.max_output_tokens ?? null,
      reasoning: it.reasoning ?? it.thinking ?? null,
      source: fromV3 ? "v3/config" : "enterprise",
    });
  }
}



//=== ui ===
// 手绘风管理面板 UI (neo-brutalist sketchbook)
export const UI = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>WorkBuddy 管理面板</title>
<style>
:root{--ink:#1a1a1a;--paper:#fdf6e3;--accent:#ff6b35;--blue:#3b82f6;--green:#16a34a;--red:#dc2626;--line:#1a1a1a}
*{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink);font-family:'Comic Sans MS','Segoe UI',system-ui,sans-serif;padding:18px}
h1{font-size:26px;transform:rotate(-1deg)}
.wrap{max-width:1080px;margin:0 auto}
.card{border:3px solid var(--line);border-radius:14px;background:#fff;box-shadow:5px 5px 0 var(--line);padding:16px;margin:14px 0;transform:rotate(.3deg)}
.card:nth-child(even){transform:rotate(-.4deg)}
.bar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:10px}
button{cursor:pointer;border:2.5px solid var(--line);border-radius:10px;background:#fff;padding:7px 13px;font-weight:700;font-family:inherit;box-shadow:3px 3px 0 var(--line);transform:rotate(-.6deg)}
button:hover{background:var(--accent);color:#fff}
button.sm{padding:4px 9px;font-size:12px;box-shadow:2px 2px 0 var(--line)}
button.b{background:var(--blue);color:#fff} button.g{background:var(--green);color:#fff} button.r{background:var(--red);color:#fff}
input,textarea,select{border:2.5px solid var(--line);border-radius:8px;padding:6px 9px;font-family:inherit;font-size:13px;background:#fffdf5}
.token{width:260px}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{border:2px solid var(--line);padding:6px 8px;text-align:left}
th{background:#fff3d6}
.tag{display:inline-block;border:2px solid var(--line);border-radius:6px;padding:1px 6px;font-size:11px}
.ok{background:#dcfce7}.bad{background:#fee2e2}.warn{background:#fef9c3}
.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
.muted{color:#666;font-size:12px}
pre{background:#1a1a1a;color:#9fe;padding:10px;border-radius:8px;overflow:auto;font-size:12px;max-height:260px}
.hide{display:none}
</style>
</head>
<body><div class="wrap">
<h1>🐱 WorkBuddy 管理面板</h1>
<div class="card">
  <div class="bar">
    <span>管理令牌:</span>
    <input id="tok" class="token" placeholder="粘贴 ADMIN_TOKEN">
    <button class="b sm" onclick="saveTok()">保存</button>
    <span class="muted" id="who"></span>
  </div>
  <div class="bar">
    <button onclick="loadAll()">🔄 刷新</button>
    <button class="g" onclick="document.getElementById('imp').classList.toggle('hide')">📥 导入账号 (粘贴/上传)</button>
    <button class="b" onclick="creditsAll()">💰 一键拉取全部额度</button>
    <button onclick="showKeys()">🔑 API Key 管理</button>
    <button onclick="showLogs()">📜 任务日志</button>
  </div>
  <div id="imp" class="hide card" style="background:#fff8e7">
    <b>导入账号</b><div class="muted">支持粘贴 JSON，或上传 APK 导出的 .json 文件（避免字数限制）</div>
    <div class="row" style="margin-top:8px">
      <textarea id="impTxt" rows="5" style="width:100%" placeholder='粘贴授权 JSON (含 access_token)...'></textarea>
    </div>
    <div class="row" style="margin-top:8px">
      <input type="file" id="impFile" accept=".json,application/json">
      <button class="g" onclick="importAcc()">导入</button>
      <span id="impMsg" class="muted"></span>
    </div>
  </div>
</div>

<div class="card">
  <b>📋 账号列表</b>
  <div id="accs" style="margin-top:10px">加载中…</div>
</div>

<div id="keyCard" class="card hide">
  <b>🔑 API Key 管理</b><div class="muted">生成独立下游 key，替代直接暴露 CF 令牌。可绑定账号 / 禁用 / 删除 / 一键清空。</div>
  <div class="row" style="margin:10px 0">
    <input id="kName" placeholder="备注名">
    <button class="g" onclick="createKey()">＋ 生成 Key</button>
    <button class="r" onclick="clearKeys()">🗑 一键清空</button>
  </div>
  <div id="keys"></div>
</div>

<div id="logCard" class="card hide">
  <b>📜 任务日志</b>
  <pre id="logs"></pre>
</div>

<div id="modelCard" class="card hide">
  <b>🧠 模型探测 (注释消耗倍率)</b>
  <div class="muted" id="modelHdr"></div>
  <div id="models"></div>
</div>

</div>
<script>
const $=s=>document.querySelector(s);
function tok(){return localStorage.getItem('wbtok')||''}
function saveTok(){$('#tok').value&&localStorage.setItem('wbtok',$('#tok').value);$('#who').textContent='已保存';loadAll()}
function hdr(){return{'content-type':'application/json','Authorization':'Bearer '+tok()}}
async function api(p,body,m='POST'){const r=await fetch('/api/'+p,{method:m,headers:hdr(),body:body?JSON.stringify(body):undefined});return r.json()}
async function loadAll(){if(!tok()){$('#who').textContent='请先填令牌';return}
  const r=await api('accounts','{}','GET').catch(e=>({error:String(e)}));
  if(r.error){$('#accs').innerHTML='<span class="bad tag">'+r.error+'</span>';return}
  let h='<table><tr><th>uid</th><th>域</th><th>额度</th><th>token到期</th><th>状态</th><th>操作</th></tr>';
  for(const a of (r.accounts||[])){
    const exp=new Date(a.expires_at*1000).toLocaleString();
    const st=a.token_expired?'<span class="tag bad">token过期</span>':'<span class="tag ok">正常</span>';
    const en=a.enabled?'<span class="tag ok">启用</span>':'<span class="tag warn">禁用</span>';
    h+='<tr><td>'+a.uid+'</td><td>'+a.realm+'<br><span class="muted">'+a.domain+'</span></td>'+
       '<td>'+(a.credits!=null?a.credits+'<br><span class="muted">'+(a.expiries[0]?('最早到期 '+new Date(a.expiries[0].at*1000).toLocaleDateString()):'')+'</span>'):'<span class="muted">未查</span>')+'</td>'+
       '<td>'+exp+'</td><td>'+st+en+'</td><td class="row">'+
       '<button class="sm" onclick="doRefresh(\''+a.id+'\')">续期</button>'+
       '<button class="sm g" onclick="doCheckin(\''+a.id+'\')">签到</button>'+
       '<button class="sm b" onclick="doCredits(\''+a.id+'\')">额度</button>'+
       '<button class="sm" onclick="doModels(\''+a.id+'\')">模型</button>'+
       '<button class="sm" onclick="toggleAcc(\''+a.id+'\','+(!a.enabled)+')">'+(a.enabled?'禁用':'启用')+'</button>'+
       '<button class="sm r" onclick="delAcc(\''+a.id+'\')">删除</button></td></tr>';
  }
  h+='</table>';
  $('#accs').innerHTML=h;
}
async function importAcc(){const f=$('#impFile').files[0];let txt=$('#impTxt').value;
  if(f){txt=await f.text()}
  if(!txt){$('#impMsg').textContent='请粘贴或选择文件';return}
  const r=await api('accounts/import',{json:txt});
  $('#impMsg').textContent=r.ok?('导入 '+r.imported+' 个'):('失败: '+(r.error||''));
  if(r.ok)loadAll();
}
async function doRefresh(id){const r=await api('accounts/refresh',{id});alert(r.ok?'续期成功':'失败: '+r.msg)}
async function doCheckin(id){const r=await api('accounts/checkin',{id});alert('签到: '+(r.msg||r.code))}
async function doCredits(id){const r=await api('accounts/credits',{id});alert(r.ok?('额度 '+r.credits):('失败 '+r.msg));loadAll()}
async function creditsAll(){const r=await api('accounts/credits-all',{});if(r.ok)alert('总计额度: '+r.total+'\\n'+r.results.map(x=>x.uid+':'+(x.credits??'x')).join('\\n'));loadAll()}
async function toggleAcc(id,en){await api('accounts/enable',{id,enabled:en});loadAll()}
async function delAcc(id){if(!confirm('确认删除该账号?'))return;await api('accounts/delete',{id});loadAll()}
async function doModels(id){const r=await api('accounts/models',{id});$('#modelCard').classList.remove('hide');
  $('#modelHdr').textContent='账号 '+id+(r.entErr?(' | 企业端点: '+r.entErr):'');
  let h='<table><tr><th>模型 id</th><th>消耗倍率*</th><th>上下文</th><th>最大输出</th><th>启用</th></tr>';
  (r.models||[]).forEach(m=>{h+='<tr><td>'+m.id+'</td><td>'+(m.multiplier!=null?('<b>'+m.multiplier+'×</b>'):'<span class="muted">—</span>')+
    '</td><td>'+(m.context||'-')+'</td><td>'+(m.maxOutput||'-')+'</td><td><input type="checkbox" data-m="'+m.id+'"></td></tr>'});
  h+='</table><div class="muted">*消耗倍率 = 该模型每 token 消耗你套餐额度的倍乘（倍率越高越费额度）。字段来自上游 /v3/config 或企业端点，缺失表示上游未返回。</div>'+
     '<button class="g" onclick="saveModels(\''+id+'\')">保存勾选的模型</button>';
  $('#models').innerHTML=h;
}
async function saveModels(id){const sel=[...document.querySelectorAll('#models [data-m]:checked')].map(c=>c.dataset.m);
  await api('accounts/models-save',{id,models:sel});alert('已保存 '+sel.length+' 个')}
async function showKeys(){const r=await api('keys','{}','GET');$('#keyCard').classList.remove('hide');
  let h='<table><tr><th>Key</th><th>备注</th><th>绑定账号</th><th>状态</th><th>创建</th><th>操作</th></tr>';
  (r.keys||[]).forEach(k=>{h+='<tr><td style="font-family:monospace">'+k.apikey+'</td><td>'+k.name+'</td><td>'+
    (JSON.parse(k.account_ids||'[]').length||'全部')+'</td><td>'+(k.enabled?'<span class="tag ok">启用</span>':'<span class="tag warn">禁用</span>')+
    '</td><td>'+new Date(k.created_at*1000).toLocaleDateString()+'</td><td class="row">'+
    '<button class="sm" onclick="toggleKey(\''+k.id+'\','+(!k.enabled)+')">'+(k.enabled?'禁用':'启用')+'</button>'+
    '<button class="sm r" onclick="delKey(\''+k.id+'\')">删除</button></td></tr>'});
  h+='</table>';$('#keys').innerHTML=h;
}
async function createKey(){const r=await api('keys/create',{name:$('#kName').value});if(r.ok){alert('新 Key: '+r.key.apikey);showKeys()}}
async function toggleKey(id,en){await api('keys/update',{id,enabled:en,name:'',account_ids:[],note:''});showKeys()}
async function delKey(id){if(!confirm('删除该 Key?'))return;await api('keys/delete',{id});showKeys()}
async function clearKeys(){if(!confirm('清空所有 Key?'))return;await api('keys/clear',{});showKeys()}
async function showLogs(){const r=await api('logs','{}','GET');$('#logCard').classList.remove('hide');
  $('#logs').textContent=JSON.stringify(r.logs||[],null,1)}
window.addEventListener('load',()=>{$('#tok').value=tok()});
</script>
</body></html>`;
//=== index ===


// ---------- 工具 ----------
const uuid = () => crypto.randomUUID();
const now = () => Math.floor(Date.now() / 1000);
function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}
function authOk(req, env) {
  const az = req.headers.get("Authorization") || "";
  const key = az.startsWith("Bearer ") ? az.slice(7) : "";
  return env.ADMIN_TOKEN && key === env.ADMIN_TOKEN;
}
function apiKeyOk(req, env) {
  const az = req.headers.get("Authorization") || "";
  const key = az.startsWith("Bearer ") ? az.slice(7) : "";
  if (!key) return null;
  return key; // 下游 key，查库校验在调用处
}

// ---------- 账号存储 ----------
async function getAccounts(db) {
  const { results } = await db.prepare("SELECT * FROM accounts").all();
  return results.map(rowToAccount);
}
function rowToAccount(r) {
  return { id: r.id, uid: r.uid, realm: r.realm, domain: r.domain, nickname: r.nickname,
    access_token: r.access_token, refresh_token: r.refresh_token, expires_at: r.expires_at,
    enabled: !!r.enabled, models: JSON.parse(r.models || "[]"), created_at: r.created_at };
}
async function saveAccount(db, acc) {
  await db.prepare(
    `INSERT OR REPLACE INTO accounts (id,uid,realm,domain,nickname,access_token,refresh_token,expires_at,enabled,models,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(acc.id, acc.uid, acc.realm, acc.domain, acc.nickname, acc.access_token,
    acc.refresh_token, acc.expires_at, acc.enabled ? 1 : 0, JSON.stringify(acc.models), acc.created_at).run();
}
async function getAccount(db, id) {
  const r = await db.prepare("SELECT * FROM accounts WHERE id=?").bind(id).first();
  return r ? rowToAccount(r) : null;
}

// 从导入的 json 提取账号(s)
function parseAccountFile(text) {
  let data;
  try { data = JSON.parse(text); } catch (e) { throw new Error("JSON 解析失败"); }
  // 支持数组 / 单对象 / {accounts:[...]}
  let arr = [];
  if (Array.isArray(data)) arr = data;
  else if (Array.isArray(data.accounts)) arr = data.accounts;
  else arr = [data];
  const out = [];
  for (const x of arr) {
    const at = x.access_token || x.accessToken || (x.auth && (x.auth.access_token || x.auth.accessToken));
    const rt = x.refresh_token || x.refreshToken || (x.auth && (x.auth.refresh_token || x.auth.refreshToken));
    const domain = x.domain || (x.auth && x.auth.domain) || (realmOf({ domain: x.domain }) === "global" ? "www.workbuddy.ai" : "www.codebuddy.cn");
    const uid = x.uid || (x.auth && x.auth.uid) || "";
    const exp = x.expires_at || x.expiresAt || (x.auth && (x.auth.expires_at || x.auth.expiresAt));
    if (!at) continue;
    out.push({
      id: uuid(), uid, realm: realmOf({ domain }), domain, nickname: x.nickname || x.name || "",
      access_token: at, refresh_token: rt || "", expires_at: normExpires(exp) || now() + 3600,
      enabled: 1, models: [], created_at: now(),
    });
  }
  if (!out.length) throw new Error("未找到任何含 access_token 的账号");
  return out;
}

// ---------- API key ----------
function genApiKey() {
  const rnd = (n) => Array.from(crypto.getRandomValues(new Uint8Array(n))).map(b => b.toString(16).padStart(2, "0")).join("");
  return "sk-wb-" + rnd(24);
}
async function getKeys(db) {
  const { results } = await db.prepare("SELECT * FROM apikeys ORDER BY created_at DESC").all();
  return results.map(r => ({ ...r, account_ids: JSON.parse(r.account_ids || "[]") }));
}

// ---------- 任务日志 / 额度快照 ----------
async function logTask(db, type, account_id, ok, msg) {
  await db.prepare("INSERT INTO task_log (type,account_id,at,ok,msg) VALUES (?,?,?,?,?)")
    .bind(type, account_id, now(), ok ? 1 : 0, String(msg || "").slice(0, 500)).run();
}

// ---------- 路由 ----------
async function handleApi(request, env, url) {
  const db = env.DB;
  const p = url.pathname.replace(/^\/api\//, "").replace(/\/$/, "");
  const method = request.method;

  if (!authOk(request, env) && p !== "v1/models" && p !== "v1/chat/completions" && !p.startsWith("v1/")) {
    return json({ error: "unauthorized" }, 401);
  }

  // 公开代理面 (下游 key)
  if (p === "v1/models" || p === "v1/chat/completions") {
    return handleProxy(request, env, p);
  }

  // 导入账号 (粘贴 or 文件上传)
  if (p === "accounts/import" && method === "POST") {
    const ct = request.headers.get("content-type") || "";
    let text = "";
    if (ct.includes("multipart/form-data")) {
      const form = await request.formData();
      const file = form.get("file");
      text = file ? await file.text() : (form.get("json") || "");
    } else {
      const body = await request.json().catch(() => ({}));
      text = body.json || body.text || "";
    }
    const accs = parseAccountFile(text);
    for (const a of accs) await saveAccount(db, a);
    return json({ ok: true, imported: accs.length, ids: accs.map(a => a.id) });
  }

  if (p === "accounts" && method === "GET") {
    const accs = await getAccounts(db);
    // 附额度快照
    for (const a of accs) {
      const sn = await db.prepare("SELECT * FROM credits_snap WHERE account_id=?").bind(a.id).first();
      a.credits = sn ? sn.credits : null; a.credits_at = sn ? sn.at : null;
      a.expiries = sn ? JSON.parse(sn.expiries || "[]") : [];
      a.token_expired = a.expires_at < now();
    }
    return json({ ok: true, accounts: accs });
  }

  if (p === "accounts/refresh" && method === "POST") {
    const { id } = await request.json();
    const acc = await getAccount(db, id); if (!acc) return json({ error: "no account" }, 404);
    try {
      const upd = await refreshToken(acc);
      acc.access_token = upd.access_token; acc.refresh_token = upd.refresh_token; acc.expires_at = upd.expires_at;
      await saveAccount(db, acc);
      return json({ ok: true, expires_at: acc.expires_at });
    } catch (e) { return json({ ok: false, msg: String(e) }, 500); }
  }

  if (p === "accounts/checkin" && method === "POST") {
    const { id } = await request.json();
    const acc = await getAccount(db, id); if (!acc) return json({ error: "no account" }, 404);
    const r = await checkin(acc);
    await logTask(db, "checkin", id, r.code === 0 || r.code === 10001 || r.status === 200, r.msg);
    return json({ ok: r.code === 0 || r.code === 10001 || r.status === 200, ...r });
  }

  if (p === "accounts/credits" && method === "POST") {
    const { id } = await request.json();
    const acc = await getAccount(db, id); if (!acc) return json({ error: "no account" }, 404);
    const r = await fetchCredits(acc);
    if (r.ok) {
      await db.prepare("INSERT OR REPLACE INTO credits_snap VALUES (?,?,?,?)")
        .bind(id, now(), r.credits, JSON.stringify(r.expiries)).run();
    }
    await logTask(db, "credits", id, r.ok, r.msg);
    return json({ ok: r.ok, credits: r.credits, expiries: r.expiries, msg: r.msg });
  }

  if (p === "accounts/credits-all" && method === "POST") {
    const accs = await getAccounts(db);
    const out = [];
    for (const acc of accs) {
      const r = await fetchCredits(acc);
      if (r.ok) await db.prepare("INSERT OR REPLACE INTO credits_snap VALUES (?,?,?,?)")
        .bind(acc.id, now(), r.credits, JSON.stringify(r.expiries)).run();
      await logTask(db, "credits", acc.id, r.ok, r.msg);
      out.push({ id: acc.id, uid: acc.uid, ok: r.ok, credits: r.credits, msg: r.msg });
    }
    const sum = out.filter(o => o.ok).reduce((s, o) => s + (o.credits || 0), 0);
    return json({ ok: true, results: out, total: sum });
  }

  if (p === "accounts/models" && method === "POST") {
    const { id } = await request.json();
    const acc = await getAccount(db, id); if (!acc) return json({ error: "no account" }, 404);
    const r = await fetchModels(acc);
    return json(r);
  }

  if (p === "accounts/models-save" && method === "POST") {
    const { id, models } = await request.json();
    const acc = await getAccount(db, id); if (!acc) return json({ error: "no account" }, 404);
    acc.models = models || [];
    await saveAccount(db, acc);
    return json({ ok: true });
  }

  if (p === "accounts/enable" && method === "POST") {
    const { id, enabled } = await request.json();
    await db.prepare("UPDATE accounts SET enabled=? WHERE id=?").bind(enabled ? 1 : 0, id).run();
    return json({ ok: true });
  }

  if (p === "accounts/delete" && method === "POST") {
    const { id } = await request.json();
    await db.prepare("DELETE FROM accounts WHERE id=?").bind(id).run();
    return json({ ok: true });
  }

  // ---- API key 管理 ----
  if (p === "keys" && method === "GET") {
    return json({ ok: true, keys: await getKeys(db) });
  }
  if (p === "keys/create" && method === "POST") {
    const b = await request.json().catch(() => ({}));
    const k = { id: uuid(), apikey: genApiKey(), name: b.name || "", account_ids: b.account_ids || [], enabled: 1, created_at: now(), note: b.note || "" };
    await db.prepare("INSERT INTO apikeys VALUES (?,?,?,?,?,?,?)")
      .bind(k.id, k.apikey, k.name, JSON.stringify(k.account_ids), 1, k.created_at, k.note).run();
    return json({ ok: true, key: k });
  }
  if (p === "keys/update" && method === "POST") {
    const b = await request.json();
    await db.prepare("UPDATE apikeys SET name=?,account_ids=?,enabled=?,note=? WHERE id=?")
      .bind(b.name || "", JSON.stringify(b.account_ids || []), b.enabled ? 1 : 0, b.note || "", b.id).run();
    return json({ ok: true });
  }
  if (p === "keys/delete" && method === "POST") {
    const { id } = await request.json();
    await db.prepare("DELETE FROM apikeys WHERE id=?").bind(id).run();
    return json({ ok: true });
  }
  if (p === "keys/clear" && method === "POST") {
    await db.prepare("DELETE FROM apikeys").run();
    return json({ ok: true });
  }

  if (p === "logs" && method === "GET") {
    const { results } = await db.prepare("SELECT * FROM task_log ORDER BY at DESC LIMIT 200").all();
    return json({ ok: true, logs: results });
  }

  return json({ error: "not found" }, 404);
}

// ---------- 下游代理 (v1) ----------
async function handleProxy(request, env, p) {
  const db = env.DB;
  const key = apiKeyOk(request, env);
  const krow = key ? await db.prepare("SELECT * FROM apikeys WHERE apikey=?").bind(key).first() : null;
  if (!krow || !krow.enabled) return json({ error: "invalid or disabled api key" }, 401);
  // 选账号: key 指定 or 全部启用
  const allowed = JSON.parse(krow.account_ids || "[]");
  const accs = (await getAccounts(db)).filter(a => a.enabled && (allowed.length === 0 || allowed.includes(a.id)));
  if (!accs.length) return json({ error: "no available account" }, 503);
  const acc = accs[Math.floor(Math.random() * accs.length)];
  if (p === "v1/models") {
    const r = await fetchModels(acc);
    return json({ object: "list", data: r.models.map(m => ({ id: m.id, object: "model", owned_by: "workbuddy", multiplier: m.multiplier })) });
  }
  // chat: 转发上游
  let body = await request.json().catch(() => ({}));
  body.stream = true;
  const r = await fetch(chatBase(acc) + "/v2/chat/completions", {
    method: "POST", headers: commonHeaders(acc, acc.access_token), body: JSON.stringify(body),
  });
  return new Response(r.body, { status: r.status, headers: { "content-type": r.headers.get("content-type") || "text/event-stream" } });
}

// ---------- cron ----------
async function runCron(env) {
  const db = env.DB;
  const accs = await getAccounts(db);
  const log = [];
  for (const acc of accs) {
    if (!acc.enabled) continue;
    // 保活: 过期前 3 天刷新
    if (acc.expires_at < now() + 3 * 86400) {
      try { const u = await refreshToken(acc); acc.access_token = u.access_token; acc.refresh_token = u.refresh_token; acc.expires_at = u.expires_at; await saveAccount(db, acc); await logTask(db, "keepalive", acc.id, true, "refreshed"); log.push(acc.uid + ":keepalive ok"); }
      catch (e) { await logTask(db, "keepalive", acc.id, false, String(e).slice(0, 200)); }
    }
    // 签到
    try { const r = await checkin(acc); await logTask(db, "checkin", acc.id, r.code === 0 || r.code === 10001, r.msg); log.push(acc.uid + ":checkin " + r.msg); }
    catch (e) { await logTask(db, "checkin", acc.id, false, String(e).slice(0, 200)); }
  }
  return log;
}

// ---------- 入口 ----------
addEventListener('fetch', event => {
  event.respondWith(handleFetch(event.request, wbEnv()));
});
async function handleFetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/healthz") return new Response("ok");
    if (url.pathname.startsWith("/api/")) return handleApi(request, env, url);
    if (url.pathname === "/") return new Response(UI, { headers: { "content-type": "text/html; charset=utf-8" } });
    return new Response("WorkBuddy Manager", { status: 404 });
  },
addEventListener('scheduled', event => {
  event.waitUntil(runCron(wbEnv()));
});
async function wbEnv(){ return { DB: DB, ADMIN_TOKEN: ADMIN_TOKEN }; }


