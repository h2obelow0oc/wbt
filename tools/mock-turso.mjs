/** 内存版 libSQL pipeline mock —— 只实现 turso.js 用到的三条 KV SQL，带 SQL 日志。 */
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const store = new Map();
export const SQLLOG = [];
function cell(v){ if (v===null||v===undefined) return {type:'null',value:null};
  if (typeof v==='number') return {type:'integer',value:v};
  if (typeof v==='boolean') return {type:'integer',value:v?1:0};
  return {type:'text',value:String(v)}; }
function runStmt(sql, args){
  const s = sql.replace(/\s+/g,' ').trim();
  let r;
  if (/^SELECT 1 AS ok/i.test(s)) r = {cols:[{name:'ok'}], rows:[[1]], rows_affected:0};
  else if (/^SELECT v FROM kv WHERE k = \?/i.test(s)) { const k=args[0]?.value;
    r = {cols:[{name:'v'}], rows: store.has(k)?[[cell(store.get(k))]]:[], rows_affected:0}; }
  else if (/^INSERT INTO kv/i.test(s)) { store.set(args[0]?.value, args[1]?.value); r = {cols:[],rows:[],rows_affected:1}; }
  else if (/^DELETE FROM kv/i.test(s)) { store.delete(args[0]?.value); r = {cols:[],rows:[],rows_affected:1}; }
  else r = {cols:[],rows:[],rows_affected:0};
  SQLLOG.push({ sql: s.slice(0,70), arg: args?.[0]?.value, out: JSON.stringify(r.rows).slice(0,110) });
  return r;
}
// turso.js 的 endpoint() 写死 https://, 故 mock 必须是 TLS。
// 证书运行时自动生成(不入库), 仅测试用。
function ensureCert(dir) {
  const key = path.join(dir, 'selfsigned.key.pem'), crt = path.join(dir, 'selfsigned.cert.pem');
  if (!(fs.existsSync(key) && fs.existsSync(crt))) {
    execFileSync('openssl', ['req','-x509','-newkey','rsa:2048','-keyout',key,'-out',crt,
      '-days','2','-nodes','-subj','/CN=127.0.0.1'], { stdio: 'ignore' });
  }
  return { key: fs.readFileSync(key), cert: fs.readFileSync(crt) };
}
export function startMock(port){
  const h = (req,res)=>{ let b=''; req.on('data',c=>b+=c); req.on('end',()=>{
    let out; try { const p=JSON.parse(b||'{}');
      out={results:(p.requests||[]).map(r=>({response:{result:runStmt(r.stmt?.sql||'', r.stmt?.args||[]), type:'ok'}}))};
    } catch(e){ out={results:[{error:{message:String(e)}}]}; }
    res.writeHead(200,{'content-type':'application/json'}); res.end(JSON.stringify(out)); }); };
  const tls = ensureCert(fileURLToPath(new URL('.', import.meta.url)));
  const srv = https.createServer(tls, h);
  return new Promise(r=>srv.listen(port,'127.0.0.1',()=>r(srv)));
}
export const __store = store;
