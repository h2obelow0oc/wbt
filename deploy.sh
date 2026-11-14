#!/usr/bin/env bash
# 部署 wb-manager (classic Service Worker + KV)
# 注意: 本环境 ES module 上传被 CF 拒绝, 必须用经典格式 + KV
set -e
cd "$(dirname "$0")/worker"
API="https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT:-311e04de245d0ccc75c8ebc6fbf96b4d}"
TOKEN="${CLOUDFLARE_API_TOKEN:-$(cat /sdcard/deep/.cf_token)}"
KVID="$(cat ../.kv_id)"
ADMIN_TOKEN="$(cat ../.admin_token | cut -d= -f2)"
NAME="wb-manager"
# 1) 合并单文件 (剥离 export, 经典格式)
python3 - <<'PY'
import re
proto=open('wb_protocol.js').read(); ui=open('ui.js').read(); idx=open('index_kv.js').read()
ser=open('serialize-buddy.mjs').read(); cg=open('context-guard.js').read()
proto=re.sub(r'^export async function','async function',proto,flags=re.M)
proto=re.sub(r'^export function','function',proto,flags=re.M)
proto=re.sub(r'^export \{[^}]*\};?','',proto,flags=re.M)
ui=re.sub(r'^export const (UI|LOGIN)','const \\1',ui,flags=re.M)
ser=re.sub(r'^export function','function',ser,flags=re.M)
ser=re.sub(r'^export \{[^}]*\};?','',ser,flags=re.M)
cg=re.sub(r'^export function','function',cg,flags=re.M)
cg=re.sub(r'^export \{[^}]*\};?','',cg,flags=re.M)
idx=re.sub(r'^import .*$','',idx,flags=re.M)
open('worker_kv.js','w').write("// WorkBuddy Manager (classic + KV)\n\n//=== wb_protocol ===\n"+proto+"\n\n//=== serialize-buddy ===\n"+ser+"\n\n//=== context-guard ===\n"+cg+"\n\n//=== ui ===\n"+ui.strip()+"\n\n//=== index ===\n"+idx)
PY
python3 -c "import ast,sys; open('worker_kv.js').read() and 0" 2>/dev/null || true
grep -c '^export ' worker_kv.js || true
node --check worker_kv.js
# 2) 部署
python3 ../_deploy_kv.py "$API" "$NAME" "$TOKEN" "$KVID" "$ADMIN_TOKEN" "worker_kv.js"
echo "deploy done"
