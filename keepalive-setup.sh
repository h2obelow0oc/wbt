#!/usr/bin/env bash
# Cloud Studio 容器内保活安装器（幂等，可重复跑）
# 目标：进程崩了 5 分钟内自愈；容器重启后尽量自启。
set -u
WBT=/workspace/wbt
LOG=/workspace/.keepalive.log
HEAL='pgrep -f "worker/index_turso.js" >/dev/null 2>&1 || { pkill -f "node.*start.sh" 2>/dev/null; cd /workspace/wbt && nohup bash start.sh >>/tmp/wbt.log 2>&1 & }'

echo "== keepalive-setup $(date)" | tee -a "$LOG"

# 1) 先立即拉起（若已死）
bash -c "$HEAL"; sleep 2
pgrep -f "worker/index_turso.js" >/dev/null && echo "  process: up" | tee -a "$LOG" || echo "  process: FAILED to start" | tee -a "$LOG"

# 2) cron 通道
if command -v crontab >/dev/null 2>&1; then
  ( crontab -l 2>/dev/null | grep -v "index_turso" ; \
    echo "*/5 * * * * $HEAL" ; \
    echo "@reboot sleep 20 && $HEAL" ) | crontab -
  echo "  crontab installed (*/5 + @reboot)" | tee -a "$LOG"
  # crond 没在跑就拉起来
  pgrep -x "cron\|crond" >/dev/null 2>&1 || { service cron start 2>/dev/null || cron 2>/dev/null || /usr/sbin/crond 2>/dev/null; }
  pgrep -x "cron\|crond" >/dev/null 2>&1 && echo "  cron daemon: running" | tee -a "$LOG" || echo "  cron daemon: NOT RUNNING (需 root 环境自启验证)" | tee -a "$LOG"
else
  echo "  no crontab binary" | tee -a "$LOG"
fi

# 3) rc.local 兜底（部分镜像 init 会执行）
if [ -d /etc/rc.local ] || [ -f /etc/rc.local ] || [ -w /etc ]; then
  grep -q keepalive /etc/rc.local 2>/dev/null || \
    printf '#!/bin/sh\n%s\nexit 0\n' "$HEAL" > /etc/rc.local 2>/dev/null && chmod +x /etc/rc.local 2>/dev/null && echo "  /etc/rc.local: written" | tee -a "$LOG"
fi

# 4) .bashrc 兜底：人一进终端就顺手自愈
grep -q keepalive-heal "$HOME/.bashrc" 2>/dev/null || \
  printf '\n# keepalive-heal\nbash -c "%s" 2>/dev/null &\n' "$HEAL" >> "$HOME/.bashrc" && echo "  .bashrc guard: added" | tee -a "$LOG"

echo "== done. 自检:" | tee -a "$LOG"
crontab -l 2>/dev/null | head -3 | tee -a "$LOG"
curl -s -m 5 http://127.0.0.1:7860/healthz && echo " (local healthz ok)" | tee -a "$LOG"
