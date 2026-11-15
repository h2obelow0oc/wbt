#!/usr/bin/env bash
# Cloud Studio 启动包装：镜像自带 node 太老（不支持 --import），nvm 里的新版非交互 PATH 不加载
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
ok() { node -e 'process.exit(+process.versions.node>=20?0:1)' 2>/dev/null; }
if ! ok; then
  export NVM_NODEJS_ORG_MIRROR=https://npmmirror.com/mirrors/node/
  nvm install 22 >/dev/null 2>&1 || nvm install 20 >/dev/null 2>&1
  nvm use default >/dev/null 2>&1
fi
echo "node=$(node -v) at $(command -v node)"
ok || { echo "FATAL: node still too old"; exit 1; }
cd "$(dirname "$0")"
exec node --import ./worker/backends/hook.mjs worker/index_turso.js
