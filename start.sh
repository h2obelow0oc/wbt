#!/usr/bin/env bash
# Cloud Studio 启动包装：镜像/nvm 的 node 只有 v18（不支持 --import），
# 直接从 npmmirror 拉 node22 二进制到持久盘 /workspace/.node22，一次到位。
cd "$(dirname "$0")"
ok() { node -e 'process.exit(+process.versions.node.split(".")[0]>=24?0:1)' 2>/dev/null; }
ND=/workspace/.node24
[ -x "$ND/bin/node" ] && export PATH="$ND/bin:$PATH"
if ! ok; then
  echo "node<24, downloading v24.19.0 ..."
  arch=$(uname -m)
  case "$arch" in x86_64) a=linux-x64;; aarch64) a=linux-arm64;; *) echo "unknown arch $arch"; exit 1;; esac
  mkdir -p "$ND"
  curl -fsSL "https://npmmirror.com/mirrors/node/v24.19.0/node-v24.19.0-$a.tar.gz" -o /tmp/n22.tar.gz || { echo "download failed"; exit 1; }
  tar -xzf /tmp/n22.tar.gz -C "$ND" --strip-components=1 || { echo "extract failed"; exit 1; }
  export PATH="$ND/bin:$PATH"
fi
echo "node=$(node -v) at $(command -v node)"
ok || { echo "FATAL: node still too old (need >=24 for registerHooks)"; exit 1; }
exec node --import ./worker/backends/hook.mjs worker/index_turso.js
