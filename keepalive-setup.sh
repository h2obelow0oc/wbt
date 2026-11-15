#!/usr/bin/env bash
# Cloud Studio 容器内自愈：起一个脱离终端会话的守门循环。
# 治「前台 bash start.sh 被 WS 断线的 SIGHUP 杀掉」——进程没了 60s 内自动拉起。
# 不依赖 cron（容器里 cron 未必在跑），只依赖一个 setsid 常驻循环。
WBT=/workspace/wbt
GUARD=/workspace/.guard.sh
cat > "$GUARD" <<'INNER'
#!/usr/bin/env bash
cd /workspace/wbt || exit 1
while true; do
  if ! pgrep -f "worker/index_turso.js" >/dev/null 2>&1; then
    nohup bash start.sh >>/tmp/wbt.log 2>&1
  fi
  sleep 60
done
INNER
chmod +x "$GUARD"
# setsid 彻底脱离当前终端会话：浏览器/WS 断开不再波及
pgrep -f "\.guard.sh" >/dev/null 2>&1 || setsid bash "$GUARD" >/tmp/guard.log 2>&1 < /dev/null &
sleep 2
echo "guard pid: $(pgrep -f '\.guard.sh' | head -1)"
echo "proc pid:  $(pgrep -f 'worker/index_turso.js' | head -1)"
curl -s -m 5 http://127.0.0.1:7860/healthz && echo " <- local healthz" || echo "(healthz 还没起，等 60s 内守门拉起)"
