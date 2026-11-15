#!/usr/bin/env bash
# Cloud Studio 启动包装：node 在 nvm 里，非交互 shell 不会自动加载
export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
command -v node >/dev/null || { echo "no node" >&2; exit 1; }
cd "$(dirname "$0")"
exec node --import ./worker/backends/hook.mjs worker/index_turso.js
