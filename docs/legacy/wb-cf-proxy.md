# wb-cf-proxy 归档 (已退役 2026-10-17)

原独立 Worker `wb-cf-proxy` 的源码见同目录 `wb-cf-proxy-index.js`。
其域名路由 `wb.kbi190.kdns.fr/*` 已切至 wb-manager; 本目录仅保留知识, 不再部署。

## 从它移植进 wb-manager 的三个资产
1. **11128 修复**: 腾讯网关强制 messages 首条为 system, 否则 code:11128
   "request illegal" 渠道校验拦截 → `handleProxy` 里自动注入默认 system。
2. **SSE→JSON 聚合器**: 上游只支持流式, 客户端 stream:false 时聚合回
   chat.completion → `aggregateSseToCompletion`。
3. **显式否定头**: uid/domain/enterprise 缺失时发 X-No-User-Id /
   X-No-Department-Info / X-No-Enterprise-Info → `commonHeaders`。

## 独有事实 (合并决策依据)
- 国际版端点 (codebuddy.ai/workbuddy.ai) 11128 无解: 官方客户端校验,
  UA/头/uid/prompt_cache_key 全对齐仍被拦; hy3 等模型国内端点即可调。
- KV 外部 API 写入与 Worker 读取存在超长不一致: 面板/API (Worker 写)
  立刻生效, CF REST API 直写可能长期读不到 → 管理 KV 一律走面板。
- GATEWAY_API_KEY `sk-wb-d4b3...` 已导入 wb-manager keys 列表
  (id: legacy-wb-cf-proxy-key-0001), keypool 无需改配置。

---

# 附录：国际端点 11128 实验矩阵与血缘鉴定 (2026-10-17 第二轮)

## 一、项目血缘 (ref/ 目录鉴定)

`ref/` 的 11 个 .py (wb2api/realm/tencent/accounts/credits/dailyplan/keyexport/
keyimport/modelcatalog/renew/taskrun) 全部来自 **ithtelab/workbuddy-manager**
(18/18 文件名匹配其 `server/services/` 结构), 不是
`ardeyouxipianyi/workbuddy2api-hub` (仅 3/246 匹配)。

但两者同源协议生态: ithtelab 注释自述"镜像上游 workbuddy2api 的 Go 源码"
—— hub 是逆向协议的上游源头 (Go), ithtelab 是其管理面板 (Python)。
wb-manager 借鉴了 ithtelab 的面板功能设计 (多账号/签到/积分/key),
代理协议独立实现自 wb-cf-proxy (UA/11128 system-first/SSE 聚合自研踩坑)。
铁证: hub 的 deriveAccountStableID 指纹算法
(sha256("wb2a:"+purpose+":"+uid)[:36]) wb-manager 从未移植。

## 二、"账号风控论"证伪 (交叉实验矩阵)

背景: 社区说法"国际 key 请求非法是账号风控了, 他们的反代还能正常用"。

| token        | 端点                 | 全套风控头 | 结果                  |
|--------------|----------------------|-----------|-----------------------|
| CN 账号      | copilot.tencent.com  | ✅        | ✅ 流式出字            |
| 国际账号     | www.workbuddy.ai     | ✅        | ❌ 11128               |
| 国际账号     | copilot.tencent.com  | ✅        | 401 openresty (realm 锁定) |
| CN 账号      | www.workbuddy.ai     | ✅        | 401 openresty (realm 锁定) |

判读:
- 若是账号风控, 国际 token 打 CN 端点 (同账号身份) 也应被 11128 拦;
  实际它正常做了认证 (只是 token 域不匹配 401 openresty)。
- token 本身 realm 锁定: 国际账号 token 在 CN 端点 / CN 账号 token 在
  国际端点都直接 401 认证失败, 根本走不到渠道校验层。
- **真因: 国际端点 (www.workbuddy.ai) 对非官方客户端形态的请求一律
  code:11128, 是端点侧客户端校验 (疑似 TLS/流式指纹层), 与账号无关。**

## 三、全套风控头复刻仍被拦 (国际端点无效, CN 端点有效)

复刻 ref/realm.py + tencent.py 揭示的 hub 系完整出站形状
(UA 5.5.4 CLI/2.137.1、X-CodeBuddy-Request:1、Accept-Language 按域切、
X-Agent-Purpose/X-IDE-Name/X-IDE-Type/X-IDE-Version 归因四头、
X-Machine-ID/X-Session-ID 派生设备指纹、X-No-Enterprise-Id):

- 国际端点: 加全 → 仍 11128 (与不加无差别)
- CN 端点:   加全 → 流式出字 (与不加也过, 指纹头非 CN 必需)

结论: hub 的风控头套件主要保护的是**国内版多号关联** (多号同 IP),
对国际端点的客户端校验无解。社区"还能用"的人大概率是:
本机/局域网部署 (家宽出口=官方客户端同场景) + 桌面端凭据导入
(设备指纹一致), 这在 CF Worker 出口上不成立。

## 四、另一线索: 11101 ≠ 11128

国际端点 stream:false + WorkBuddy UA → code:11101
"Non-stream chat request is currently not supported" (过校验, 卡协议)。
11101 恰是 ref/tencent.py:925 写的码 ("上游强制 stream=true, 非流式
返回 11101")。即 stream:false 的请求能到达协议层 → 校验层拦的是
**流式请求的传输形态**, 非请求头。

## 五、决策

- 国际版账号保持禁用; hy3/glm/kimi/deepseek 全部走 CN 端点, 功能不缺。
- hub 的指纹算法 (X-Machine-ID 派生) 若将来 CN 端点也加设备校验,
  按 ref/realm.py:210 的公式移植 (wb-manager 目前未移植)。
- 11128 错误码语义修正: ref/tencent.py:987 注释写 "11-128 'first
  message is not system prompt'"——11128 是**多因一码**的通用渠道
  拦截码 (缺 system / 非官方客户端形态都报它), 排查需矩阵化二分。

---

# 附录 2 修正 (2026-10-17 第三轮): 国际版已激活, 上一轮"TLS 指纹"结论是误判

## 误判纠正

上一轮附录结论"国际端点客户端校验疑似 TLS/流式指纹层, 无解"是**错的**。
正确根因: **请求缺少会话头族**, 与出口 IP / 账号 / TLS 形态统统无关。

证据链 (hub issue#380 LeoK77S 定位 + PR#381 修复, 本站实验交叉验证):

- 官方客户端 (桌面/VSCode/CLI) 所有 chat 请求带:
  - `X-Conversation-ID` — 带连字符 UUID (每会话一个)
  - `X-Conversation-Request-ID` / `X-Conversation-Message-ID` /
    `X-Root-Request-ID` / `X-Request-ID` — 32 位无连字符 hex (UUIDv7 形态)
- 缺这族头 → 国际端点回 400 code:11128, msg 变体 "conversation id missing"
- 补齐后: 家宽 curl 直发 → HTTP 200 流式出字; CF Worker 出口 → 同样通过

## 为什么上一轮会误判

复刻 hub 风控头时复刻了 UA/指纹/归因/X-CodeBuddy-Request, 但 PR#381 是
2026-10-16 才合的**最新改动**, 当时拉下来的 ref/ (ithtelab 镜像) 里没有
会话头族 — 参考代码本身就是旧的。教训: **"参考实现也失败"不等于"无解",
可能是参考实现过时了, 优先去看它的最新 issue/PR。**

## 最终形状 (5.8.4 抓包, 已移植进 wb-manager wb_protocol.js)

UA: WorkBuddy/5.8.4 workbuddy-ai/5.8.4 CLI/2.161.0 (国际版专用,
国内版无抓包维持 CodeBuddy/2.63.2 旧 UA)
头部: X-IDE-{Name,Type,Version}=WorkBuddy/5.8.4
      X-Agent-Intent=craft, X-Agent-Purpose=conversation, X-Agent-Type=main
      X-Conversation-ID 族 (见上), Accept-Language: en-US
      + 原有 uid/domain/否定头

## 已知边界

- gpt-5.6-luna 等国际模型对 free 账号报 11158 "not allowed for user
  type [personal_free_user]" — 这是**账号等级权限**, 不是拦截。
  x0.00 国际免费模型: hy3, step-5-preview。其余国际模型按倍率扣积分。
- 国际版限流按出口 IP 走 (hub #313: 同 IP 12 号, 墙高约 13-19 req/min),
  CF Worker 出口与其他人共享, 偶发 429 属预期。

## 交叉实验矩阵修正版

| token    | 端点        | 会话头族 | 结果                     |
|----------|-------------|----------|--------------------------|
| 任意     | 国际        | ❌ 缺    | 400 11128 "conv id missing" |
| 任意     | 国际        | ✅ 全    | 200 流式出字 ✅           |
| CN 账号  | CN          | 缺亦可   | 200 (CN 校验宽松)         |
| 国际tok  | CN 端点     | -        | 401 openresty (realm 锁定) |
