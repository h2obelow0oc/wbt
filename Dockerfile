# Cloud Studio 载体 —— wbt 网关（wbr 移植实验分支）
# 教训照搬（qom/trm 实测）：
#   1) ENV 行**不许写带空格的值**（GATEWAY_TITLE 之类一律走运行环境注入，
#      docker build 见空格就 Syntax error → BuildFailed）
#   2) 监听 7860（Cloud Studio 预览端口 = <SpaceKey>--7860.app.cloudstudio.work）
#   3) 平台占用 Authorization ⇒ MS_MODE=1 走 X-Api-Key
# 端口插件对 7860 设「公开」由部署脚本/人工确认一次。
FROM ccr.ccs.tencentyun.com/library/node:22-alpine
WORKDIR /app
COPY . /app
ENV NODE_ENV=production \
    MS_MODE=1 \
    PORT=7860
EXPOSE 7860
CMD ["node", "--import", "./worker/backends/hook.mjs", "worker/index_turso.js"]
