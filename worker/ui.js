// 登录门禁页 (未输令牌前只看到这个, 不暴露真实界面)
export const LOGIN = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><meta name="robots" content="noindex,nofollow"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>WorkBuddy 管理面板 · 登录</title>
<style>*{box-sizing:border-box}body{margin:0;background:#fdf6e3;color:#1a1a1a;font-family:'Comic Sans MS',system-ui,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center}
.card{border:3px solid #1a1a1a;border-radius:14px;background:#fff;box-shadow:6px 6px 0 #1a1a1a;padding:28px 30px;width:340px;transform:rotate(-.6deg)}
h1{font-size:22px;margin:0 0 16px;transform:rotate(-1deg)}input{width:100%;border:2.5px solid #1a1a1a;border-radius:8px;padding:10px;font-size:15px;margin-bottom:12px;font-family:inherit}
button{cursor:pointer;width:100%;border:2.5px solid #1a1a1a;border-radius:10px;background:#ff6b35;color:#fff;padding:10px;font-weight:700;font-size:15px;font-family:inherit;box-shadow:3px 3px 0 #1a1a1a}
button:hover{background:#e85a2a}.muted{color:#666;font-size:12px;margin-top:8px;text-align:center}</style></head>
<body><div class="card"><h1>🔐 WorkBuddy 管理面板</h1>
<input id="t" type="password" placeholder="请输入管理令牌" autofocus>
<button onclick="go()">进 入</button>
<div class="muted">令牌由管理员下发, 错误无法进入</div></div>
<script>function go(){const v=document.getElementById('t').value;fetch('__BASE__/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token:v})}).then(r=>r.json().then(j=>({s:r.status,j}))).then(({s,j})=>{if(s===200&&j.ok){try{localStorage.setItem('wbt_token',v)}catch(e){}location.reload()}else{alert('令牌错误')}}).catch(e=>alert('网络错误'))}
document.getElementById('t').addEventListener('keydown',e=>{if(e.key==='Enter')go()})</script></body></html>`;
// 手绘风管理面板 UI (neo-brutalist sketchbook)
export const UI = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="robots" content="noindex,nofollow">
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
.box{border:2px dashed var(--line);border-radius:10px;background:#fffdf5;padding:10px 12px;margin:8px 0}
code{background:#1a1a1a;color:#9fe;padding:1px 5px;border-radius:4px;font-size:12px;font-family:monospace}
pre{background:#1a1a1a;color:#9fe;padding:10px;border-radius:8px;overflow:auto;font-size:12px;max-height:260px}
.hide{display:none}
</style>
</head>
<body><div class="wrap">
<h1>🐱 WorkBuddy 管理面板</h1>
<div class="card">
  <div class="bar">
    <button onclick="loadAll()">🔄 刷新</button>
    <button class="g" onclick="document.getElementById('imp').classList.toggle('hide')">📥 导入账号 (粘贴/上传)</button>
    <button class="b" onclick="creditsAll()">💰 一键拉取全部额度</button>
    <button onclick="showKeys()">🔑 API Key 管理</button>
    <button onclick="showModels()">🧠 模型</button><button onclick="showSetting()">⚙️ 设置</button>
    <button onclick="showLogs()">📜 任务日志</button>
    <button class="r sm" onclick="logout()">退出</button>
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
    <div class="row" style="margin-top:10px;padding-top:8px;border-top:1px dashed #d9c9a3">
      <button class="r sm" onclick="resetAll()">🧹 清理全部数据</button>
      <span class="muted">清空已导入的<b>全部账号</b>、任务日志、隐藏模型集合、模型缓存（保留 API Key 与面板设置）</span>
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
  <div class="box">
    <b>下游调用方式（OpenAI 兼容）</b>
    <div class="muted">在任意 OpenAI 客户端 / 代码里使用：</div>
    <table style="margin:6px 0">
      <tr><td style="padding:2px 8px 2px 0;vertical-align:top"><b>BaseURL</b></td><td><code id="baseUrlCell">加载中…</code></td></tr>
      <tr><td style="padding:2px 8px 2px 0;vertical-align:top"><b>API Key</b></td><td>上面生成的 <code>sk-wb-...</code></td></tr>
      <tr><td style="padding:2px 8px 2px 0;vertical-align:top"><b>对话</b></td><td><code>POST /v1/chat/completions</code>（OpenAI 协议，支持 stream）</td></tr>
      <tr><td style="padding:2px 8px 2px 0;vertical-align:top"><b>模型列表</b></td><td><code>GET /v1/models</code></td></tr>
    </table>
    <div class="muted">请求头带 <code>Authorization: Bearer &lt;sk-wb-...&gt;</code> 即可；未绑定账号的 key 会在所有启用账号间随机负载，绑定后仅走指定账号。模型名用本面板「模型」里列出的 id（如 <code>hy3</code>、<code>deepseek-v4-pro</code>）。</div>
  </div>
  <div id="keys"></div>
</div>

<div id="setCard" class="card hide">
  <b>⚙️ 接入设置</b>
  <div class="box">
    <label class="row" style="gap:8px">
      <input type="checkbox" id="setRate" onchange="saveSetting()">
      <span>在对外 <code>/v1/models</code> 的模型 id 上拼倍率注释</span>
    </label>
    <div class="muted">Operit / DSHA 等客户端只渲染模型 id、不显示倍率字段时，开启后模型名会变成 <code>hy4-preview [x0.29]</code>、<code>hy3 [免费]</code> 这样带注释的形式（对话时代理会自动剥掉后缀，不影响实际调用）。关闭则恢复纯净 id。</div>
  </div>
</div>

<div id="logCard" class="card hide">
  <b>📜 任务日志</b>
  <pre id="logs"></pre>
</div>

<div id="modelCard" class="card hide">
  <b>🧠 模型管理 (全局, 国内+国际)</b>
  <div class="muted" id="modelHdr"></div>
  <div id="models"></div>
</div>

</div>
<script>
const $=s=>document.querySelector(s);
function wbtToken(){try{return localStorage.getItem('wbt_token')||''}catch(e){return''}}
function hdr(){const h={'content-type':'application/json'};const t=wbtToken();if(t)h['X-Api-Key']=t;return h}  // cookie 被平台改写 Partitioned 不可靠，令牌走 X-Api-Key
async function api(p,body,m='POST'){const opt={method:m,headers:hdr()};if(m!=='GET'&&body)opt.body=JSON.stringify(body);const r=await fetch('__BASE__/api/'+p,opt);if(r.status===401&&wbtToken()){try{localStorage.removeItem('wbt_token')}catch(e){}}return r.json()}
async function logout(){await fetch('__BASE__/api/logout',{method:'POST'}).catch(()=>{});location.reload()}
async function loadAll(){
  const r=await api('accounts',null,'GET').catch(e=>({error:String(e)}));
  if(r.error){$('#accs').innerHTML='<span class="bad tag">'+r.error+'</span>';return}
  let h='<table><tr><th>账号</th><th>渠道 / 域</th><th>额度</th><th>token到期</th><th>状态</th><th>操作</th></tr>';
  for(const a of (r.accounts||[])){
    const isWb=(a.provider||'wb')==='wb';
    const exp=new Date(a.expires_at*1000).toLocaleString();
    const st=a.token_expired?'<span class="tag bad">token过期</span>':'<span class="tag ok">正常</span>';
    // 11140 封禁显示（hub v2.1.0）：banned 是终态标记，与普通「禁用」区分；
    // 悬停给上游证据，解禁唯一入口 = 「启用」按钮（accounts/enable 清标记）。
    const en=a.banned?'<span class="tag bad" title="'+String(a.bannedEvidence||'上游 11140').replace(/"/g,'&quot;')+'">已封禁</span>':(a.enabled?'<span class="tag ok">启用</span>':'<span class="tag warn">禁用</span>');
    let creditCell='<span class="muted">未查</span>';
    if(a.credits!=null){creditCell=a.credits;if(a.expiries&&a.expiries[0]){creditCell+='<br><span class="muted">最早到期 '+new Date(a.expiries[0].at*1000).toLocaleDateString()+'</span>'}}
    // 渠道账号没有 uid/realm/domain (导入时只有 provider/nickname/...),
    // 直接渲染 a.uid 会得到字面量 "undefined" —— 首列改取 nickname 兜底 id,
    // 次列按渠道/WB 分别渲染。
    // 签到按钮: WB 全给；渠道 minimax/lobsterai/raccoon 支持（与 chan-checkin.js
    // 的 CHECKINABLE 一致 —— raccoon 走 setting_info「登录信号」, 2026-11-06 实测；
    // cline 签到不存在，点了必失败）。
    const canCheckin = isWb || ['minimax','lobsterai','raccoon'].includes(a.provider);
    const nameCol = a.nickname || a.uid || a.id;
    const chCol = isWb
      ? (a.realm||'')+'<br><span class="muted">'+(a.domain||'')+'</span>'
      : '<span class="tag">'+(a.provider||'?')+'</span>'+(a.nickname?'<br><span class="muted">'+a.nickname+'</span>':'');
    h+='<tr><td>'+nameCol+'</td><td>'+chCol+'</td>'+
       '<td>'+creditCell+'</td>'+
       '<td>'+exp+'</td><td>'+st+en+'</td><td class="row">'+
       '<button class="sm" onclick="doRefresh(&quot;'+a.id+'&quot;)">续期</button>'+
       (canCheckin?'<label title="勾选=每日自动签到(tick 处理该号)；取消=只留手动按钮" style="margin:0 4px"><input type="checkbox" '+(a.auto_checkin!==0?'checked ':'')+'onchange="setAutoCheckin(&quot;'+a.id+'&quot;,this.checked)">自动签</label>'+
         '<button class="sm g" onclick="doCheckin(&quot;'+a.id+'&quot;)">签到</button>':'')+
       '<button class="sm b" onclick="doCredits(&quot;'+a.id+'&quot;)">额度</button>'+
       '<button class="sm" onclick="toggleAcc(&quot;'+a.id+'&quot;,'+(!a.enabled)+')">'+(a.enabled?'禁用':'启用')+'</button>'+
       '<button class="sm r" onclick="delAcc(&quot;'+a.id+'&quot;)">删除</button></td></tr>';
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
// 清理全部数据: 用户要求「重复和无用的数据要删干净, 不能只是不显示」。
// 与后端 POST /api/reset 一一对应 —— 删的是外接储存里真实的数据, 不是前端隐藏。
async function resetAll(){
  // ⚠️ 必须写两个反斜杠转义(HTML 里是 \\n)：整个页面是外层 JS 模板字面量，
  // 单写一个反斜杠加 n 会在**服务端**就被吃成真换行，注入到浏览器后字符串
  // 字面量断开，整段脚本 SyntaxError ⇒ 连 showKeys 等全部函数都不存在，
  // 表现为「点 API Key 管理没反应 / 网页不显示 key」（2026-11-03 实际报障）。
  if(!confirm('🧹 清理全部数据？\\n\\n将删除（不可恢复）：\\n  · 全部已导入账号（含已禁用的残留）\\n  · 任务日志 / 公开请求日志\\n  · 隐藏模型集合\\n  · 模型聚合缓存\\n\\n保留：API Key、面板设置'))return;
  const r=await api('reset',{});
  if(r.ok){alert('已清理 '+r.cleared.accounts+' 个账号及其日志/缓存');loadAll()}
  else alert('失败: '+(r.error||''));
}
async function doRefresh(id){const r=await api('accounts/refresh',{id});alert(r.ok?'续期成功':'失败: '+r.msg)}
async function doCheckin(id){const r=await api('accounts/checkin',{id});alert('签到: '+(r.msg||r.code))}
async function doCredits(id){const r=await api('accounts/credits',{id});alert(r.ok?('额度 '+r.credits):('失败 '+r.msg));loadAll()}
async function creditsAll(){const r=await api('accounts/credits-all',{});if(r.ok)alert('总计额度: '+r.total+'\\n'+r.results.map(x=>x.uid+':'+(x.credits??'x')).join('\\n'));loadAll()}
async function toggleAcc(id,en){await api('accounts/enable',{id,enabled:en});loadAll()}
async function setAutoCheckin(id,on){try{await api('accounts/auto-checkin',{id,auto:on})}catch(e){alert('切换失败: '+e.message);loadAll()}}
async function delAcc(id){if(!confirm('确认删除该账号?'))return;await api('accounts/delete',{id});loadAll()}
// ---- 全局模型管理: 按「分组 + 免费/付费」筛选, 勾选=隐藏 ----
// 存的是**隐藏集合**（黑名单）: 上游新出模型自动出现, 无需维护白名单。
let MODELS_CACHE=null, HIDDEN_SET={};
/** 当前分组过滤: ''=全部 | 'wb-cn' | 'wb-g' | 'ch:<provider>' */
let MODEL_FILTER='';
/** 当前免费过滤: ''=全部 | 'free'=仅免费 | 'paid'=仅付费 */
let MODEL_FREE='';
/** 当前**可见**列表（批量操作用），由 renderModels 写入 */
let MODEL_VISIBLE=[];

async function showModels(force){
  $('#modelCard').classList.remove('hide');
  $('#modelHdr').textContent='加载中…';
  if(!HIDDEN_SET._loaded){const hr=await api('models/hidden-get',null,'GET');if(hr.ok){HIDDEN_SET=hr.hidden||{}}HIDDEN_SET._loaded=1}
  const r=await api('models/agg',{force:force?1:0});
  if(!r.ok){$('#modelHdr').textContent='拉取失败: '+(r.error||'');return}
  MODELS_CACHE=r.models||[];
  renderModels();
}

/**
 * 模型所属分组。
 *
 * 渠道按**前缀**分成独立分组（cline 一家就有 400+ 条, 混在一起根本没法看）:
 * 'cline/cline-free/solar-mini4' → 'ch:cline'。
 */
function modelGroup(m){
  if(m.realm==='channel') return 'ch:'+String(m.id||'').split('/')[0];
  return m.srcTag==='g' ? 'wb-g' : 'wb-cn';
}
/**
 * 模型是否免费。
 *
 * 三个来源都要认（缺一个就会把免费模型标成付费）:
 *   1. 渠道模型: 倍率展示串直接是 '免费'（vendor 展示名解析出来的, 见 chanRate）
 *   2. WB 模型: 倍率是 'x0.00'（如 hy3）
 *   3. 促销: 'discounted === '免费''
 *
 * ⚠️ '—'(无倍率信息) **不算免费** —— 那是"不知道", 不是"不要钱"。
 *    计入付费侧, 这样「仅免费」筛选不会混进未知计费的模型。
 */
function modelIsFree(m){
  const mult=String((m&&m.multiplier)||'');
  if(mult==='免费') return true;
  const mm=/^x([\d.]+)$/.exec(mult);
  if(mm && parseFloat(mm[1])===0) return true;
  if(String((m&&m.discounted)||'')==='免费') return true;
  return false;
}
/** 分组下拉的选项（带计数, 让用户一眼看出哪家占了几百行）。 */
function modelGroupOptions(ms){
  const opts=[];
  const cnt=g=>ms.filter(m=>modelGroup(m)===g).length;
  const cn=cnt('wb-cn'), g=cnt('wb-g');
  if(cn) opts.push({v:'wb-cn',label:'WB 国内版'});
  if(g) opts.push({v:'wb-g',label:'WB 国际版'});
  const provs=[...new Set(ms.filter(m=>m.realm==='channel').map(m=>String(m.id||'').split('/')[0]))];
  // 顺序固定成 4 家的常用顺序; 未知渠道排最后（保持稳定, 不随接口顺序抖动）
  const ord=['raccoon','minimax','lobsterai','cline'];
  provs.sort((a,b)=>{const ia=ord.indexOf(a),ib=ord.indexOf(b);return (ia<0?99:ia)-(ib<0?99:ib)});
  // 渠道只显示名字，不加「渠道 · 」前缀 —— 用户嫌难看。
  // 组内顺序仍按固定表，未知渠道排最后（保持稳定, 不随接口顺序抖动）。
  for(const p of provs) opts.push({v:'ch:'+p,label:p});
  return opts.map(o=>({...o,n:cnt(o.v)}));
}

function renderModels(){
  const ms=MODELS_CACHE||[];const hidden=HIDDEN_SET;
  const opts=modelGroupOptions(ms);
  // 分组过滤
  let base=ms;
  if(MODEL_FILTER) base=ms.filter(m=>modelGroup(m)===MODEL_FILTER);
  // 免费过滤
  let list=base;
  if(MODEL_FREE==='free') list=base.filter(modelIsFree);
  else if(MODEL_FREE==='paid') list=base.filter(m=>!modelIsFree(m));
  MODEL_VISIBLE=list;

  const hiddenInView=list.filter(m=>hidden[m.id]).length;
  const freeInView=list.filter(modelIsFree).length;

  // 分组下拉: 全部 + 各分组(带条数)
  let sel='<select id="mf" onchange="setModelFilter(this.value)"><option value="">全部分组 ('+ms.length+')</option>';
  for(const o of opts) sel+='<option value="'+o.v+'"'+(MODEL_FILTER===o.v?' selected':'')+'>'+o.label+' ('+o.n+')</option>';
  sel+='</select>';
  // 免费/付费下拉
  let selFree='<select id="mfree" onchange="setModelFree(this.value)">'+
    '<option value=""'+(MODEL_FREE===''?' selected':'')+'>免费+付费</option>'+
    '<option value="free"'+(MODEL_FREE==='free'?' selected':'')+'>仅免费 ('+freeInView+')</option>'+
    '<option value="paid"'+(MODEL_FREE==='paid'?' selected':'')+'>仅付费 ('+(list.length-freeInView)+')</option></select>';

  let h='<div class="row" style="margin:6px 0">'+sel+selFree+
    '<span class="muted">显示 <b>'+list.length+'</b> 条，其中已隐藏 <b>'+hiddenInView+'</b> 条</span></div>';

  // 批量挂钩: 作用于**当前可见列表**（与两个筛选器组合使用）
  h+='<div class="row" style="margin:6px 0;padding:6px 0;border-top:1px dashed #d9c9a3;border-bottom:1px dashed #d9c9a3">'+
    '<button class="sm r" onclick="bulkHide(1)">隐藏当前列表全部 ('+list.length+')</button>'+
    '<button class="sm g" onclick="bulkHide(0)">显示当前列表全部 ('+list.length+')</button>'+
    '<span class="muted">先选分组 → 一键全隐 → 再切「仅免费」把免费的单独取消隐藏</span></div>';

  h+='<div class="row" style="margin:6px 0">'+
    '<button class="sm g" onclick="saveHidden()">保存勾选结果</button>'+
    '<button class="sm" onclick="showModels(true)">强制刷新</button>'+
    '<button class="sm b" onclick="probeWindows()">🔎 探测窗口</button></div>';

  h+='<table><tr><th>模型 id</th><th>来源</th><th>倍率</th><th>折扣</th><th>上下文</th><th>隐藏</th></tr>';
  list.forEach(m=>{
    const src=m.realm==='channel'
      ? '<span class="tag">'+String(m.id||'').split('/')[0]+'</span>'
      : (m.srcTag==='g'?'<span class="tag warn">国际g</span>':'<span class="tag ok">国内</span>');
    const free=modelIsFree(m);
    const mult=free?'<span class="tag bad">免费</span>'
      :(m.multiplier?'<span class="tag ok">'+m.multiplier+'</span>':'<span class="muted">—</span>');
    const disc=m.discounted?'<span class="tag warn">'+m.discounted+'</span>':'<span class="muted">—</span>';
    const ctx=m.context?Math.round(m.context/1000)+'k':'<span class="muted">—</span>';
    h+='<tr><td>'+m.id+'</td><td>'+src+'</td><td>'+mult+'</td><td>'+disc+'</td><td>'+ctx+'</td>'+
    '<td><input type="checkbox" data-h="'+m.id+'"'+(hidden[m.id]?' checked':'')+'></td></tr>'});
  h+='</table>';
  h+='<div class="muted">勾选「隐藏」并保存后，该模型不再出现在对外 <code>/v1/models</code>（同名模型国内/国际两条一起隐藏），DSH 的模型选择器里也就选不到。<br>'+
    '存的是隐藏集合（黑名单）—— 上游新出模型自动出现，无需维护白名单。<br>'+
    '倍率来自上游 <code>credits</code>；渠道倍率来自 vendor 展示名。「—」= 上游没给计费信息（<b>不等于免费</b>，按付费计）。</div>';
  $('#models').innerHTML=h;
}

/** 分组筛选（下拉 onchange）。 */
function setModelFilter(v){ MODEL_FILTER=v||''; renderModels(); }
/** 免费筛选（下拉 onchange）。 */
function setModelFree(v){ MODEL_FREE=v||''; renderModels(); }

/**
 * 保存**当前可见行**的勾选状态。
 *
 * ⚠️ **必须与已有隐藏集合合并，不能整体替换**：筛选后只有一部分行在 DOM 里，
 * 整体替换会把其它分组的隐藏状态全部抹掉（如筛到 cline、隐藏它几百个、
 * 保存 → WB 那边之前隐藏的模型全被放出来）。这是加筛选器后新出现的坑。
 */
async function saveHidden(){
  const next={};
  for(const k of Object.keys(HIDDEN_SET)) if(k!=='_loaded') next[k]=1;
  let n=0;
  document.querySelectorAll('#models [data-h]').forEach(c=>{
    if(c.checked){ next[c.dataset.h]=1; n++; } else delete next[c.dataset.h];
  });
  const keys=Object.keys(next);
  const r=await api('models/hidden-save',{hidden:keys});
  if(r.ok){ HIDDEN_SET={...next,_loaded:1}; alert('已保存：当前隐藏 '+keys.length+' 个模型（本次可见 '+n+' 个）'); renderModels(); }
  else alert('保存失败: '+(r.error||''));
}

/**
 * 批量隐藏/显示**当前可见列表**。
 *
 * 与两个筛选器组合使用正是用户要的流程:
 *   选「渠道 · cline」→ 隐藏当前列表全部(453) → 切「仅免费」→
 *   取消勾选想要的 → 保存。于是只留免费的那几个。
 */
async function bulkHide(hide){
  const ids=MODEL_VISIBLE.map(m=>m.id);
  if(!ids.length){ alert('当前列表为空'); return; }
  const verb=hide?'隐藏':'显示';
  if(!confirm(verb+'当前列表全部 '+ids.length+' 个模型？')) return;
  const next={};
  for(const k of Object.keys(HIDDEN_SET)) if(k!=='_loaded') next[k]=1;
  for(const id of ids){ if(hide) next[id]=1; else delete next[id]; }
  const r=await api('models/hidden-save',{hidden:Object.keys(next)});
  if(r.ok){ HIDDEN_SET={...next,_loaded:1}; renderModels(); }
  else alert(verb+'失败: '+(r.error||''));
}
// 一键探测各模型真实上游上下文窗口 + 护栏有效上限(基于网关 /v3/config)。
// 也把网关 REASONABLE_CAP 兜底值显示出来, 让用户看清"无窗口声明模型"的护栏。
async function probeWindows(){
  const btn=document.querySelector('[onclick="probeWindows()"]'); if(btn)btn.disabled=true;
  const r=await api('models/windows',{}).catch(e=>({error:String(e)}));
  if(btn)btn.disabled=false;
  if(!r.ok){alert('探测失败: '+(r.error||''));return}
  const w=r.windows||{}, capped=r.capped||{}, cap=r.reasonableCap||262144;
  let known=0, unknown=0, cnt=0;
  const keys=Object.keys(w).sort();
  let h='<div class="row" style="margin:6px 0"><b>🔎 上下文窗口探测</b> '+
    '<span class="muted">兜底护栏 REASONABLE_CAP='+Math.round(cap/1000)+'k tokens（无窗口声明的模型按此限）</span></div>';
  h+='<table><tr><th>模型 id</th><th>上游窗口</th><th>护栏有效上限(min)</th><th>来源</th></tr>';
  for(const id of keys){
    const info=w[id]; const ceil=capped[id]!=null?capped[id]:cap;
    if(info.context){known++}else{unknown++}
    cnt++;
    // 来源: v3/config=WB 自己报的; 渠道名=渠道目录; models.dev=社区目录补的
    const srcTag=info.source==='models.dev'?'<span class="tag warn">models.dev</span>':info.source;
    h+='<tr><td>'+id+'</td>'+
      '<td>'+(info.context?Math.round(info.context/1000)+'k':('<span class="tag bad">未知</span>'))+'</td>'+
      '<td>'+Math.round(ceil/1000)+'k</td>'+
      '<td>'+srcTag+' / '+(info.realm||'')+'</td></tr>';
  }
  h+='</table><div class="muted">共 '+cnt+' 个模型：有窗口 '+known+'，未知 '+unknown+'（按兜底 '+Math.round(cap/1000)+'k 限流）。'+
    (r.devFilled?'其中 <b>'+r.devFilled+'</b> 条由 models.dev 社区目录补齐。':'')+'<br>'+
    '⚠️ cline 的两个远端端点（<code>recommended-models</code> / <code>/models</code>）只下发 id/名字，<b>不带上下文窗口</b> —— '+
    '所以它的窗口只能靠 models.dev 补。补不到的一律显示「未知」并走兜底限流，<b>不猜</b>（猜大了烧额度、猜小了截断对话）。<br>'+
    '护栏 = min(REASONABLE_CAP, 上游真实窗口)。</div>';
  $('#models').innerHTML=h;
}
async function showKeys(){const r=await api('keys',null,'GET');$('#keyCard').classList.remove('hide');
  let h='<table><tr><th>Key</th><th>备注</th><th>绑定账号</th><th>状态</th><th>创建</th><th>操作</th></tr>';
  (r.keys||[]).forEach(k=>{h+='<tr><td style="font-family:monospace">'+k.apikey+'</td><td>'+k.name+'</td><td>'+
    ((k.account_ids||[]).length||'全部')+'</td><td>'+(k.enabled?'<span class="tag ok">启用</span>':'<span class="tag warn">禁用</span>')+
    '</td><td>'+new Date(k.created_at*1000).toLocaleDateString()+'</td><td class="row">'+
    '<button class="sm" onclick="toggleKey(&quot;'+k.id+'&quot;,'+(!k.enabled)+')">'+(k.enabled?'禁用':'启用')+'</button>'+
    '<button class="sm r" onclick="delKey(&quot;'+k.id+'&quot;)">删除</button></td></tr>'});
  h+='</table>';$('#keys').innerHTML=h;
}
async function showSetting(){const r=await api('setting/get',null,'GET');$('#setCard').classList.remove('hide');
  $('#setRate').checked=!!(r.setting&&r.setting.modelWithRate)}
async function saveSetting(){const en=$('#setRate').checked?1:0;const r=await api('setting/save',{modelWithRate:en});
  if(r.ok){alert(en?'已开启：模型 id 已带倍率注释（如 hy4-preview [x0.29]）':'已关闭：恢复纯净模型 id')}else{alert('保存失败')}}
async function createKey(){const r=await api('keys/create',{name:$('#kName').value});if(r.ok){alert('新 Key: '+r.key.apikey);showKeys()}}
async function toggleKey(id,en){await api('keys/update',{id,enabled:en});showKeys()}
async function delKey(id){if(!confirm('删除该 Key?'))return;await api('keys/delete',{id});showKeys()}
async function clearKeys(){if(!confirm('清空所有 Key?'))return;await api('keys/clear',{});showKeys()}
async function showLogs(){const r=await api('logs',null,'GET');$('#logCard').classList.remove('hide');
  $('#logs').textContent=JSON.stringify(r.logs||[],null,1)}
// 页面就绪即自动加载账号列表 (无需手动点刷新, 也不要求输入令牌)
window.addEventListener('load',()=>{loadAll();fillBaseUrl()});

// BaseURL 必须按「当前实际访问的域名」生成, 不能硬编码:
//   - CF 版挂在 wb.kbi190.kdns.fr/manager/api
//   - Render 版在 xxx.onrender.com(根路径, 无 /manager 前缀)
// 硬编码会让 Render 部署的面板显示 CF 域名, 用户照着填必然 401。
// 自动探测: 若当前页面路径含 /manager, 说明挂在子路径下, 补回该前缀。
function fillBaseUrl(){
  try{
    // ⚠️ 本行原来是 replace("正则字面量" ,'') 写法; 模板字符串会把其中的反斜杠吃掉,
    //    结果变成两个斜杠开头的行注释, 整段内联 script 语法错误 ->
    //    面板所有按钮失效、账号列表与 BaseURL 永久停在"加载中…"。
    //    修法: 用 RegExp 构造器, 彻底避开模板串转义。改动前先 node --check 渲染产物。
    const p=location.pathname.replace(new RegExp('/+$'),'');
    // 当前页可能本身就是 /manager 或 /manager/, 也可能是根 /
    const basePrefix = p.indexOf('/manager')===0 ? '/manager' : '';
    const url=location.origin+basePrefix+'/api';
    const cell=document.getElementById('baseUrlCell');
    if(cell){
      cell.textContent=url;
      cell.style.cursor='pointer';
      cell.title='点击复制';
      cell.onclick=()=>{
        (navigator.clipboard?navigator.clipboard.writeText(url):Promise.reject())
          .then(()=>{const t=cell.textContent;cell.textContent='已复制';setTimeout(()=>cell.textContent=t,900)})
          .catch(()=>{});
      };
    }
  }catch(e){}
}
</script>
</body></html>`;
