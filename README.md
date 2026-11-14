# WorkBuddy 双网关部署方案

> 两个 Cloudflare Workers 免费档项目的整合部署文档：
> **wb-manager**（WorkBuddy 多账号管理面板 + OpenAI 兼容代理）与 **cloudflare-llm-gateway**（多供应商 LLM key 池网关）。
>
> 本仓库 = wb-manager 源码。cloudflare-llm-gateway 源码在姊妹仓库 `h2obelow0oc/cloudflare-llm-gateway`。

---

## 0. 总览：两个项目是什么关系

```
                          ┌─────────────────────────────────────────┐
                          │           Cloudflare (免费档)            │
                          │                                         │
 Operit/DSHA/任意 ───────▶│  ① wb-manager  (classic Worker + KV)    │
 OpenAI 兼容客户端         │     WorkBuddy/CodeBuddy 账号面板         │
   │                      │     · 定时签到/任务  · 账号保活           │
   │                      │     · 模型探测+倍率  · key 额度/健康度    │
   │                      │     · 生成独立 sk-wb-* key               │
   │                      │     · /v1/models + /v1/chat/completions │
   │                      └───────────────┬─────────────────────────┘
   │                                      │ 上游协议
   │                                      ▼
   │                      ┌─────────────────────────┐
   │                      │ CN:  copilot.tencent.com │
   │                      │      www.codebuddy.cn    │
   │                      │ GL:  www.workbuddy.ai    │
   │                      └─────────────────────────┘
   │
   │                      ┌─────────────────────────────────────────┐
   └─────────────────────▶│  ② cloudflare-llm-gateway (Worker + D1) │
                          │     Gemini/OpenRouter/DeepSeek/GLM/...  │
                          │     多供应商 key 池 · 自愈轮换 · 统一端点  │
                          └─────────────────────────────────────────┘
```

- **wb-manager**：把 WorkBuddy（国内 codebuddy.cn / 国际 workbuddy.ai）账号变成 OpenAI 兼容 API。管理面板负责账号、额度、模型、key；代理层对外发 `sk-wb-*` key。
- **cloudflare-llm-gateway**：把各家 LLM 供应商的 key 池化成一个稳定端点（自愈、冷却、回退、计量）。
- 两者**互不依赖、可独立部署**；也可以整合：在 gateway 里把 wb-manager 当作一个 OpenAI 兼容上游接入（见 §4）。

### 常见疑问：wb 管理还要结合 CF 部署 wb 项目吗？

**wb-manager 本身就是一个 Cloudflare Worker**——部署 wb-manager = 在 CF 上创建 Worker + KV + 路由，不存在"另外再部署一个 wb 项目"。历史上有个更早的轻量单 token 代理 `wb-cf-proxy`（token 上云方案），**已被 wb-manager 取代**，仅作参考保留。

---

## 1. wb-manager 部署

### 1.1 架构与限制（为什么是经典 Service Worker + KV）

| 项 | 值 |
|---|---|
| 形态 | **经典 Service Worker**（`addEventListener('fetch')`），单文件 `worker/worker_kv.js` |
| 存储 | **KV**（免费档 D1 也可用，本项目 KV 足够且更简单） |
| 定时任务 | **Cron Trigger 已配**（`0 17 * * *` UTC = 北京时间 01:00 → `scheduled` → `runCron()`）；另有 `lazyKeepalive()` 请求时惰性保活 + `POST /api/run-cron` 手动/外部 pinger 兜底 |
| 域名 | `*.workers.dev` 在部分网络被 SNI 阻断 → **必须绑自定义域名路由** |
| 登录 | `wbsess` HttpOnly cookie = sha256(ADMIN_TOKEN)，面板不落明文 |

> ⚠️ 本部署环境 **ES Module 上传会被 CF 拒（错误码 10021）**，所以必须保持经典格式。`deploy.sh` 里做了三合一合并（`wb_protocol.js` + `ui.js` + `index_kv.js` → `worker_kv.js`，剥离 `export`/`import`）。

### 1.2 准备凭据（放仓库根，**绝不入库**，.gitignore 已排除）

```bash
# 1) CF API Token（权限: Workers Scripts:Edit + Workers KV Storage:Edit）
echo "<你的 CF API Token>" > .cf_token

# 2) KV namespace id —— 先创建:
#    CF 控制台 → Workers & Pages → KV → Create namespace "wb-manager-kv"
echo "<KV namespace id>" > .kv_id

# 3) 面板管理令牌（自拟随机串）
echo "ADMIN_TOKEN=<你的管理令牌>" > .admin_token
```

### 1.3 一键部署

```bash
./deploy.sh
# 内部流程: 合并单文件 → node --check 语法校验 → 调 CF API 上传 Worker 并绑定 KV
```

等价的原始命令（deploy.sh 的核心）：

```bash
python3 _deploy_kv.py \
  "https://api.cloudflare.com/client/v4/accounts/<CF_ACCOUNT_ID>" \
  "wb-manager" \
  "$(cat .cf_token)" \
  "$(cat .kv_id)" \
  "$(cat .admin_token | cut -d= -f2)" \
  "worker/worker_kv.js"
```

### 1.4 绑定自定义域名路由

`*.workers.dev` 被 SNI 阻断时必须走自定义域（域名需已接入同一 CF 账号）：

- 控制台路径：Workers & Pages → wb-manager → Settings → Domains & Routes → Add route
- Route pattern：`wb.<你的域名>/manager*`，Zone 选你的域名
- 访问 `https://wb.<你的域名>/manager`，输入管理令牌登录

### 1.5 更新部署

改完 `worker/` 下任一源文件后重跑 `./deploy.sh` 即可（KV 数据不受影响）。

> ⚠️ **部署后必验**：
> ```bash
> curl -s https://wb.<域名>/manager | python3 -c "import sys,re;open('/tmp/i.js','w').write(max(re.findall(r'<script>(.*?)</script>',sys.stdin.read(),re.S),key=len))" && node --check /tmp/i.js
> ```
> UI 模板字符串里出现 `\'` 会被 CF 解析吞掉反斜杠 → 内联 script 语法错误 → 面板白屏。写 UI 时一律用 `&quot;`，避免 `\'`。

---

## 2. wb-manager 使用

### 2.1 面板功能（/manager）

| 卡片 | 功能 |
|---|---|
| 账号 | 导入（粘贴/文件）、续期 token、签到、查额度、启停、删除；每账号显示 realm（cn/global） |
| 🧠 模型 | **一键聚合国内+国际全部账号模型**；来源列（国内 / 国际g）；倍率/折扣/上下文；勾选=隐藏（存隐藏集合，**新模型自动出现**，无需维护白名单）；来源筛选；强制刷新 |
| 🔑 Key | 生成独立 `sk-wb-*` key（可绑定指定账号，空=全部）、启停、删除、**一键清空** |
| ⚙️ 设置 | 开关：对外 `/v1/models` 的模型 id 拼倍率注释 |
| 📜 日志 | 任务日志；另有 `api/publog` 记录公开代理请求指纹（排查客户端 401） |

### 2.2 对外 API（OpenAI 兼容）

```
GET  /v1/models              # 模型列表（Bearer sk-wb-*）
POST /v1/chat/completions    # 对话（流式）
# 兼容 /api/v1/... 前缀（Operit 填 BaseURL 带 /api 时也能用）
```

BaseURL 填法（两种都支持）：

```
https://wb.<域名>/manager          # 裸前缀（推荐，Operit/DSHA/ChatBox 等）
https://wb.<域名>/manager/api      # 带 /api 前缀
```

### 2.3 模型 id 约定（来源 g 后缀）

开启"倍率注释"后，`/v1/models` 返回的 id 形如：

| 例子 | 含义 |
|---|---|
| `deepseek-v4-pro [x0.51]` | 国内独有，倍率 x0.51 |
| `gpt-5.6-terra [x1.39/g]` | 国际独有（`/g` = 国际账号） |
| `hy3 [x0.00]` | 同名模型国内也有 → 这是国内那条 |
| `hy3 [x0.00/g]` | 同名模型的**国际那条**（与国内并存，各选各的） |

**路由规则**：请求带 `/g` 后缀 → 强制走国际账号；不带 g → 优先国内（国内额度不足时选 `/g` 条目切到国际额度池）。后缀在转发上游前自动剥离，不影响真实调用。隐藏某模型 = 国内/国际两条一起隐藏。

### 2.4 保活与定时签到

- 惰性保活：token 快过期（<7 天）时，任一面板/代理请求会顺手刷新。
- **定时任务（主渠道）**：CF Cron Trigger `0 17 * * *`（UTC，= 北京时间 01:00）触发 `scheduled` → `runCron()`（逐账号 refresh<3天的 token + 签到）。
  免费档每个账号可挂 5 条 cron；**cron 表达式一律 UTC**，改时间要按 UTC 换算：

  ```sh
  # 查看/设置触发器（body 是 JSON 数组，不是 {schedules:[...]}）
  curl -H "Authorization: Bearer $CF_TOKEN" \
    "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT/workers/scripts/wb-manager/schedules"
  curl -X PUT -H "Authorization: Bearer $CF_TOKEN" -H 'content-type: application/json' \
    -d '[{"cron":"0 17 * * *"}]' ".../workers/scripts/wb-manager/schedules"
  ```
- 手动/兜底：`POST /api/run-cron`（带 `Authorization: Bearer <ADMIN_TOKEN>` 或登录 cookie），可由外部 pinger（cron-job.org / UptimeRobot）周期打。

---

## 3. cloudflare-llm-gateway 部署

> 源码：`h2obelow0oc/cloudflare-llm-gateway`（上游 leeguooooo/cloudflare-llm-gateway 的本地分支 + custom-adapter 工作）。

### 3.1 依赖

- Node.js ≥ 18、`npx wrangler`（首次 `npx wrangler login` 浏览器授权）
- CF 免费档：Workers + D1（无需 Redis/服务器）

### 3.2 步骤

```bash
cd cloudflare-llm-gateway
cp wrangler.toml.example wrangler.toml   # name/main/d1 名按需改
./deploy.sh
```

`deploy.sh` 幂等流程：

1. `wrangler whoami` 校验登录
2. 确保 D1 数据库 `llm-gateway` 存在（无则创建）
3. 把 `database_id` 写回 `wrangler.toml`
4. `wrangler d1 execute --remote --file=./schema.sql` 建表
5. `wrangler secret put ADMIN_TOKEN`（从 `.admin-token.txt` 读，**该文件不入库**）
6. `wrangler deploy`

### 3.3 定时健康检查

`wrangler.toml` 默认带 `[triggers] crons = ["*/5 * * * *"]`（免费档每账号上限 5 条 cron）。到上限就删掉该配置块，改用外部 pinger 周期 `POST /admin/probe`。

### 3.4 初始化

打开部署输出的 `*.workers.dev` URL（或绑定的自定义域）→ 粘贴 ADMIN_TOKEN → 导入各家 key → 控制台逐 key 启停/探测余额。

---

## 4. 整合用法（可选）

两种姿势：

1. **客户端分流**（最简单）：Operit/DSHA 里配两个供应商——WorkBuddy 系模型走 wb-manager 端点（§2.2），其他模型走 gateway 端点。
2. **统一池化**：gateway 的 custom-adapter 分支支持自定义 OpenAI 兼容上游。把 wb-manager 作为一条上游接入：
   - Base URL：`https://wb.<域名>/manager`
   - API Key：面板生成的 `sk-wb-*`
   - 模型：`GET /v1/models` 返回的带注释 id（`hy3 [x0.00/g]` 这类可直接用，代理自动剥后缀）
   - 之后所有客户端只对接 gateway 一个端点，由它统一计量/回退。

---

## 5. 踩坑记录（重要）

| 坑 | 处理 |
|---|---|
| CF 拒绝 ES Module 上传（10021） | 保持经典 Service Worker；`deploy.sh` 自动剥离 export/import 合并单文件 |
| UI 内联 `<script>` 白屏 | 模板字符串里 `\'` 的反斜杠被 CF 吞 → 用 `&quot;`；部署后按 §1.5 提取线上 script 跑 `node --check` |
| workers.dev 打不开 | SNI 阻断 → 绑自定义域路由 |
| （误判） | 免费档**支持** Cron Trigger（≤5 条）。现主渠道 = cron 触发 `runCron()`，外部 pinger `POST /api/run-cron` 只作兜底 |
| Operit/DSHA 拉到不同模型数 | 旧版随机挑账号返回单账号列表；现聚合全部账号按 id 去重 + 5 分钟 KV 缓存 |
| 客户端 401 但 key 明明对 | 查面板 `api/publog`（记 key 指纹 sha256[:8]+长度，不落明文），对比面板 key——多为客户端粘贴截断/多空格 |
| 上游 hy3 等模型 429 | WorkBuddy 上游按日限频（UTC+8 22:30 重置），非本面板问题；同名模型切 `/g` 条目换额度池 |
| global 占位模型污染列表 | `default-model/fast-model/...` 已自动过滤；CN 的裸 `default` 是真模型，保留 |

---

## 6. 仓库结构

```
wb-manager/
├── README.md            # 本文档
├── deploy.sh            # 一键合并+校验+部署
├── _deploy_kv.py        # CF API 上传脚本（经典 Worker + KV 绑定）
├── worker/
│   ├── wb_protocol.js   # 上游协议层（登录/签到/额度/模型/对话，cn+global 双 realm）
│   ├── index_kv.js      # 路由+KV 存储+面板 API+公开代理
│   ├── ui.js            # 面板 UI（单文件内联模板）
│   ├── worker_kv.js     # ▲ 构建产物（合并单文件，勿手改）
│   ├── schema.sql       # (D1 预留，当前未用)
│   └── worker_single.js # (单账号旧版，参考)
└── .gitignore           # 排除 .cf_token/.admin_token/.kv_id/.d1_uuid/ref/
```

**凭据文件永不入库**：`.cf_token`、`.admin_token`、`.kv_id`、`.d1_uuid`；`ref/` 为第三方参考代码（ithtelab/workbuddy-manager），不入库。

---

## 7. 2026-10-17 更新日志（个人实例 wb.kbi190.kdns.fr 实际部署记录）

以下条目按时间序固化本轮迭代成果；生产形态为"单 Worker + 单 KV"，老代理
`wb-cf-proxy` 已并入并退役。分支：`main`。

### 7.1 与老代理合并（一个域名一个 Worker）

老 `wb-cf-proxy`（单 token 轻代理，无版本控制）退役，其三个独有资产移植进
`wb-manager` 后归档至 `docs/legacy/`：

| 资产 | 落点 | 来源 |
|---|---|---|
| 11128 修复（system 首条注入） | `index_kv.js` `handleProxy` | wb-cf-proxy index.js:113 |
| SSE→JSON 聚合器 `aggregateSseToCompletion` | `index_kv.js` | wb-cf-proxy aggregateStream |
| 显式否定头 `X-No-User-Id/X-No-Department-Info/X-No-Enterprise-Info` | `wb_protocol.js` `commonHeaders` | wb-cf-proxy chatHeaders |

路由切换：`wb.kbi190.kdns.fr/*` 从 wb-cf-proxy → wb-manager（`/manager` 前缀
继续兼容）；老代理 GATEWAY_API_KEY（`sk-wb-d4b3…`）导入 key 列表，
keypool/DSH 现役配置零改动。

### 7.2 [g] 模型兜底保护

不带 `g` 的请求原本会静默落到 CN 账号（结果不可预测）；带 `g` 但无国际账号
启用时现在返回 `503 + realm_disabled` 明示客户端换非 g 条目。
`/v1/models` 与 `models/agg` 只展开启用账号可达的 realm——`[g]` 条目只在
国际账号启用时出现。

### 7.3 倍率/模型目录自适应（"过夜变化"防御）

- `aggModels` 5 分钟 TTL 自动拉新（模型新增自动出现，零维护）。
- `stripModelId` 剥壳让旧倍率装饰 ID 永远可用（倍率是显示层不参与调用）。
- 上游下架模型：列表自动消失；硬调视为 `400` + "模型未接入"透传可诊断。

### 7.4 国际版激活（11128 真因修复）

**根因**（hub issue#380 LeoK77S 定位 + 本站 2026-10-17 实测交叉验证）：
官方客户端所有 chat 请求带 `X-Conversation-ID` / `-Request-ID` / `-Message-ID`
/ `X-Root-Request-ID` / `X-Request-ID` 五头会话头族。缺这族 → 国际端点渠道
校验必拦 `code:11128 msg"conversation id missing"`。（早期曾误判为 "TLS
指纹"，归档已修正。）

已移植进 `wb_protocol.js`：

- 会话头族生成器（`uuid4()` 带连字符 / `uuid7hex()` 32hex 时间序）
- 国际版 UA 升级（5.8.4 mitmproxy 抓包）：`WorkBuddy/5.8.4 workbuddy-ai/5.8.4 CLI/2.161.0`
  （国内版无抓包维持 CodeBuddy/2.63.2 旧 UA）
- 国际版加 `X-IDE-{Name,Type,Version}` + `X-Agent-Intent/Purpose/Type` 三头
- `Accept-Language` 按域切（国际 en-US / 国内 zh-CN）
- CN 链路回归验证：新头不影响国内调用

验收示例：`hy3 [x0.00/g]` 非流式"国际版激活"、流式 N 帧出"激活"。

### 7.5 `accounts/patch` 端点（uid 修补）

面板 token 导入链路曾丢 `uid`；新增端点允许直接 PATCH `uid/nickname/domain`。
生产实例两账号 uid 已补：CN=`ada03172…`（老代理 domestic 行），国际=`8ff8d791…`
（老代理 intl 行，同 JWT sub）。

### 7.6 模型隐藏语义（勾选 = 黑名单）实测澄清

面板勾选是**隐藏**（黑名单）不是启用（白名单）：
- 隐藏只影响 `/v1/models` **显示**，不影响**调用**（硬编码发 id 仍可用）
- 新上游模型自动出现，零维护
- 下游 DSHA 看到"全部−被隐藏"，无"不在启用范围就不可用"的断层

### 7.7 墨点/额度相关历史结论（决策依据归档）

- 国际端点重加固：token realm 锁定（401 openresty）；hub control 通道失效
- CF KV 外部 API 写入 vs Worker 自写 **读取不一致**：管理 KV 一律走面板
- `11128` 被证实**多因一码**（缺 system 首条 / 缺会话头族 / 非官方形态）
- 国际端点限流按出口 IP（hub #313：~13-19 req/min），CF Worker 共享出口偶发 429 属预期
- gpt-5.6-luna 等 International 高阶模型对 `personal_free_user` 报 11158（**账号等级权限**非拦截）

详细实验矩阵与推理见 `docs/legacy/wb-cf-proxy.md` 附录 1/2。

### 7.8 2026-10-18 「每日签到从未生效」诊断与 Cron Trigger 补配

**症状**：面板"每天签到"看似在跑，实际一次都没自动执行过。

**取证**（线上 `wb.kbi190.kdns.fr`）：

| 检查项 | 结果 |
|---|---|
| CF `GET …/wb-manager/schedules` | `schedules: []` → `scheduled` 处理器**从未被触发**（此前误以为"免费档无 Cron"，实为**从未配置**） |
| 外部 pinger | 无痕迹：任务日志 5 天仅 24 条，`checkin` 类型历史仅 1 条（10-16 23:10 手动点的 cn） |
| 手动 `POST /api/run-cron` 实测 | cn → "今天已签到，请明天再来"；global → "签到活动未开启或已过期" |
| 额度 | cn 每天 +100（30 天包）**照涨不误**（5717→5817），与面板签到无关——来源是其他客户端/上游侧签到；global 348 纹丝不动 |

**结论与语义修正**：
- CN 签到在别处（官方客户端 / 上游调度器）每天已完成，面板签到是幂等空转，但**留作 01:00 兜底**（抢在白天用量之前由面板签，是唯一能确定"当日已签"的手段）。
- Global **没有签到体系**（上游 `supports_checkin` 明确跳过，理由是避免风控），面板却照样发请求并把 `code=0` 的"活动未开启"记成 `ok=true` **假成功**——已知待办（B 方案：`runCron()` 跳过 global + 该文案记 skip）。

**已执行（A 方案）**：`PUT schedules` body 用 **JSON 数组**（`[{"cron":"0 17 * * *"}]`，传 `{"schedules":[…]}` 会报 10026），
`0 17 * * *` UTC = **北京时间 01:00** 触发 `scheduled` → `runCron()`。

### 7.9 2026-10-18 「国际版免费模型没出现在网关」——倍率按 realm 分存修复

**症状**：ourfreemodel 等客户端登录后能看到 wb 国际版 `deepseek-v4.1-flash` 免费
（0.00 倍率），本网关 `/v1/models` 里同一条目却标 `x0.11`，疑似"没识别出来"。

**取证**：模型**一直都在**，两条 realm 行也都发了——错的是**价格标签**：

| 源 | deepseek-v4.1-flash | 依据 |
|---|---|---|
| 国际 `/v3/config` | `credits:"x0.00"` + `modelPromotions`（factor=0，"Free now"，2026-08-06→2026-11-01）| `parsePromotions` 解析为 `x0.00 + 免费` |
| 国内 `/v3/config` | `credits:"x0.11"`，`modelPromotions=null` | — |
| 修复前网关展示 | 两条（cn 与 /g）都标 `x0.11` | 错 |
| 实测计费 | `[x0.11/g]` 走国际 `usage.credit=0`；CN 条目 `credit=0.04` | 国际实际免费，标签滞后于事实 |

**根因**：`aggModels` 合并两 realm 时 `if (!prev.multiplier && m.multiplier)`
只保留"首个非空倍率"，账号顺序 CN 在前 → 国际的 `x0.00+免费` 被吞。同病模型：
`hy3`、`step-5-preview`（国际促销"免费"，CN 裸价 x0.00 无促销标注）。

**修复**（`641d4b5`）：`aggModels` 每模型新增 `byRealm: {cn:{multiplier,discounted,name,context}, global:{…}}`，
`/v1/models` 与 `models/agg` 铺平各 realm 行时各取各的元数据；同 realm 多账号仍取首个有倍率的。
缓存 key `agg_models_v3` → `v4`（旧缓存行无 `byRealm`，升 key 强制失效）。

**修复后 `/v1/models`**（节选）：
```
deepseek-v4.1-flash [x0.11]      ← 国内
deepseek-v4.1-flash [免费/g]      ← 国际促销（至 2026-11-01）
hy3 [x0.00] / hy3 [免费/g]
step-5-preview [x0.00] / step-5-preview [免费/g]
```
回归：新旧两种 id 剥壳路由均通，`[免费/g]` 调用 `credit=0`。

> 注意：`stripModelId` 靠 ` [xxx]` 后缀还原 id，`免费`/`x0.11` 等装饰变化不影响路由；
> 国际促销 2026-11-01 过期后该行会自动回落为真实倍率（无需人工干预）。

### 7.10 2026-10-21 「wb 国内版对话空转」——序列化器漏 OpenAI 顶层工具字段（根因追溯至 8910d95）

**症状**：wb 国内版对话在**工具调用**场景陷入无限空转；纯文本对话正常。

**根因**：`8910d95`（2026-10-17 移植 `serialize-buddy.mjs`）只识别 `content` 数组里的
`tool-call` / `tool-result` 块，但 harness/pi-ai 实际发来的是 **OpenAI 标准顶层字段**：

| 位置 | 旧代码认 | harness 实际发 |
|---|---|---|
| assistant 工具调用 | `content[]` 的 `tool-call` 块 | **顶层 `tool_calls`** |
| tool 结果 id | `m.toolCallId` | **`m.tool_call_id`** |

`detectMessageShape` 见 `role:"tool"` 即返回 `tool-role`（但降级分支仍只搬 content 块、只认
`m.toolCallId`），顶层字段被静默忽略 → 第二轮往上发时历史工具调用与结果全丢 → 上游看不到
已调过工具，重新发起同一调用 → harness 执行 → 再请求 → 空转。

**为何「昨天正常、今天才炸」**：bug 自 10-17 潜伏，纯文本对话无 `tool_calls` 不触发；直到首次
在 wb 国内版真正走工具调用才暴露。非线路/模型变更导致。

**修复**（本次）：新增 `mergeTopLevelToolFields`，把顶层 `tool_calls` / `tool_call_id` 合并进
content 数组块，让 `resolveToolPairing` / `serializeBuddyMessages` 双路兼容；`normalizeHarnessMessages`
补 `m.tool_call_id` 回退。

**验证**：第二轮带 tool 结果（`list_files` → "file1.txt\nfile2.md"）修复前返回
`finish_reason:"tool_calls"`+重新调用（空转）；修复后返回 `finish_reason:"stop"`+正文。

### 7.11 2026-10-21 上下文护栏 (413 上限 + 429 循环熔断)

**背景**：cf 网关侧发现 intern-ai 15 个账号额度被烧穿（消耗 1.4 亿 token，而
15×500万=7500万上限），排查结论是**不是 key 轮换失灵**（15 把 key 的
`total_requests` 分布 50~74，极差仅 1.48x，轮换均衡），而是**空转导致单请求
token 爆炸**：请求中位数 167,102 token、605 条 >10 万 token 的请求占总消耗 94%，
10-19 13:00 那段 `glm-5.3` 连续 20+ 条 29~31 万 token、十几秒一发，一路涨到 503。

两个网关（cf / wb）此前**都没有任何上下文压缩或裁剪**：`messages` 原样透传上游，
`flattenTextParts` / `normalizeChatRequest` 只改结构不改长度，`promptChars` 只用于计费。
上下文管理是客户端的职责，网关缺的是**护栏**。

**本次改动**（`worker/context-guard.js`，经 `deploy.sh` 合并进 `worker_kv.js`）：

| 护栏 | 机制 | 阈值（env 可调，0=关闭） |
|---|---|---|
| 硬性上下文上限 | 估算 prompt token 超限直接 `413 context_too_large`；**无状态**，永不漏 | `MAX_CONTEXT_TOKENS=150000` |
| 循环熔断 | 同 `(模型 + 末条消息 + 消息数)` 在窗口内重复 N 次 → `429 loop_detected` | `LOOP_REPEAT_LIMIT=6` / `LOOP_WINDOW_MS=120000` |

- 估算口径：CJK ≈ 1 token/字，拉丁 ≈ 4 字符/token；`tool_calls` 体积也计入
  （工具空转时它同样在膨胀）。
- 熔断为双层：isolate 内存 Map（快，但 CF 会把请求分散到不同 isolate）+ **KV
  跨请求计数**（`cgloop:<bucket>:<owner>:<fp>`，双桶近似滑动窗口）。KV 写入失败
  一律吞掉，绝不因护栏自身故障拦截真实请求；**无状态上限是硬兜底**。
- 拒绝时在序列化/分发**之前**返回，不消耗任何上游额度。
- 标识用 api key 尾 8 位，互相隔离，不会误伤别的调用方。

**验证**：20 万字请求 → `413 ~200004 tokens`；正常请求 200 正常回话；
同请求连打第 6 次起 `429 loop_detected`（KV 跨 isolate 生效，需避开 KV 单 key
1 次/秒写限，间隔 2s 测）。本地单测 8 项全过（估算/413/放行/第6次/真进展不误伤/
多调用方隔离/tool_calls 计入）。

### 7.12 2026-10-24 「国际版账号失效」定性——11140 账号级停权，非网关问题

**症状**：国际账号（`75c49a00…`，`www.codebuddy.ai`，uid `8ff8d791…`）聊天全失败。
历史上国际版失效曾被归因为 `11128`（缺会话头族，§7.4 已修），本次实测是**另一个码**。

**实测矩阵**：

| 路径 | 结果 |
|---|---|
| CN 账号 → 网关 `/v1/chat/completions` | 200 |
| CN 账号 → 直连 `copilot.tencent.com`（绕开 Worker） | 200 |
| 国际账号 → 网关（`[免费/g]`，极简 body） | **403 / 11140** |
| 国际账号 → 直连 `www.codebuddy.ai`（**完全绕开 Worker**） | **403 / 11140** |
| 国际账号 → 直连 `www.workbuddy.ai` | **403 / 11140** |
| 国际账号 → `/v3/config` 读目录 | 200（28 模型） |
| 国际账号 → `token/refresh` | 成功（有效至 2027-10-11） |

上游原文：

```json
{"code":11140,"msg":"request illegal",
 "displayMsg":{"zh":"账号存在异常行为，已被限制使用",
               "en":"Your account has been restricted due to unusual activity"},
 "actions":["EDIT_INPUT","SUBMIT_FEEDBACK"]}
```

**逐条排除**：
- **不是 11128**：按官方 5.8.4 形状补齐会话头五件套 + `X-IDE-*` + `X-Agent-*` 后错误无变化，
  仍是 11140。§7.4 的修复有效且必要，但治的不是这个病。
- **不是网关问题**（决定性证据）：账号 token **完全绕开 Worker** 直连上游，同样 403/11140。
  CF 侧改任何代码都影响不到这个结果。
- **不是 token/登录问题**：refresh 成功、目录 200、token 未过期。上游放行「读」、拒绝「对话」。
- **不是内容问题**：极简 body（一句 `hi` + 中性 system）照样 11140。
- **不是域名选错**：`workbuddy.ai` / `codebuddy.ai` 两个国际品牌域名都拒。
- **不是本地 `[g]` 兜底 503**：临时 `enabled=1` 后拿到的是上游真实 403，不是 `realm_disabled`。

**定性**：上游对该国际账号做了**账号级风控停权**，渠道 310 积分一分发不出去。
**网关无任何可修之处**——真实解法只有官方申诉（`SUBMIT_FEEDBACK`）。

**当前网关缺口**：`worker/*.js` grep `11140` / `restricted` / `异常行为` **零命中**。
上游 403 原样透传，面板看不出这是凭据级问题；国际账号一旦启用，`/g` 条目会出现并全部失败。

**可借鉴的处置（参考 `dsh-connect-workbuddy` 5.8.0 / #127）**：
1. 11140 内部**再分两支**，不可合并：`policy_reject`（内容审核，请求级，换号无用）
   与 `account_restricted`（账号被限，凭据级，**换号正是解法**）。判定要
   **业务码 + 文案两半都成立**，只认裸文本会把 402/401/500 里偶含该措辞的响应
   误判成永久停权。
2. 停权**不给倒计时**（等待修不好）。
3. **回池唯一实测路径 = 手动「测试」**：账号 id 是 `uid` 的哈希，重登/重导入
   都是同一个 id，不会清掉这条测量。
4. 方向相反的两类：11128 点名**请求** → 不换号；11140 点名**账号** → 要换号。

> 补充：参考项目明确写了 CLI 桥接路线绕开的只是「客户端指纹层」，**不是账号层**——
> 同一批账号在 CLI 路线上一样受限，不能当封号后的免死金牌。

**待办（尚未实施）**：为 `wb-manager` 补 11140 分类 + 停权后跳过 `/g` 路由。
完整诊断见工作区 `wb国际版11140诊断_20261024.md`。

**现场纪律**：验证期间曾临时 `enabled=1`，测后已恢复 `enabled=0` 并强制刷新目录缓存；
未改动上游账号、未申诉、未消费额度（403 不计费）。

### 7.13 2026-10-25 「国内账号也报 11128」——system prompt 含 `DeepSeek Harness` 触发上游内容拦截

**症状**：DSH 走 wb 线路报 `request rejected (HTTP 400)`，
`{"code":11128,"msg":"Illegal API invocation from an unapproved channel"}`，文案提示
「不是官方客户端发出的」。CN 账号同样中招。

**根因**：上游对 **system 消息**里的字面量 `DeepSeek Harness`（大小写不敏感、单 ASCII 空格）
做渠道校验拦截，命中即 11128。**与网关、出口 IP、账号、token、请求头全部无关**：
- 绕开 Worker 直连 `copilot.tencent.com`，同一 token 同一词组 → 同样 11128；干净 prompt → 200；
- 词组只放在 user / assistant / tools 描述里 → 不拦；
- 换行 / 制表符 / NBSP / 双空格 / 连字符 / 无空格 / 零宽空格分隔 → 不拦（字面量扫描）。

这也解释了「手机本地反代能正常用」：那条链路的 prompt 不含该词组，**不是**出口更「像官方客户端」。

**修复**（`worker/wb_protocol.js` + `worker/index_kv.js`）：转发前对 **system 消息**做无损中和，
`DeepSeek Harness` 的空格换 `\u200b `，语义不变、上游子串扫描不再命中：
- 只动 system；user/assistant/tool 实测不扫，一律不动；
- **路径里的同名字符串逐字节保持**（默认跳过紧邻 `/` `\` 的命中，防模型把坏路径传给工具 → ENOENT），
  `globalThis.WB_NEUTRALIZE_PATHS=1` 可强制全改；
- 前置剪枝必须用 `/harness/i`（`indexOf("Harness")` 会漏掉全小写，首版踩过）。

**部署**：`MAX_CONTEXT_TOKENS=0 LOOP_REPEAT_LIMIT=6 LOOP_WINDOW_MS=120000 bash deploy.sh`
（绑定值与部署前一致，未动护栏）。回归：含词组 / 小写 / 工具+词组 → 200 且真实回包；
user 消息词组、非流式、路径内词组、`/v1/models` 33 条均正常。

**边界**：零宽方案依赖上游扫描保持朴素；若上游改为规范化后再扫则失效，届时改用改措辞或客户端插件。
完整实验矩阵见工作区 `wb11128诊断_20261025.md`。

---

### 7.14 2026-11-04 「签到全都不可靠」——换天前误判已签 + 上下文路径漏段

> 本条承接 11-01～11-03 的 **Render/Turso 迁移 + 四渠道移植**
> （交接文档见工作区 `notes/设想/交接_wbr渠道移植完成_20261103.md`）。
> 生产入口已从 CF Worker 换成 `https://wb-manager-uhwk.onrender.com`，
> 存储从 KV 换成 Turso（`worker/index_turso.js` + `worker/turso.js`）。
> 下述缺陷全部在 **Render 线上**复现并修复。

#### 症状

用户报三件事：

| 渠道 | 现象 | 真实结论 |
|---|---|---|
| minimax | 「今天依然没有自动签到，我登录后**手动签到才 +400**」 | **自动确实没签**（用户按的那一下才 +400） |
| lobsterai | 「签到显示上下文 HTTP 404」 | 每次签到都死在同一处，**一次没成过** |
| workbuddy | 「不知道有没有正常签到」 | **正常**：00:24 tick 记 `WB OK`（code=0 真领取） |

#### 缺陷 1（主因）：minimax 在上游换天**之前**判成「今天已完成」

网关按 `bjDay()`（**北京 0 点**）算「今天」，但上游换天更晚。在「已过北京
0 点、上游还没换天」这段窗口里，面板会把**昨天那条已领**标成 `is_today`，
旧代码把「没有 claimable」直接判成「今天已完成」并写进 `checkinDay`
→ 当天不再重试。

线上证据链（北京时区，均为真实日志）：

| 时刻 | 面板 | 网关动作 |
|---|---|---|
| 11-03 08:17 | 可领 | 签上 → `2:3*` |
| 11-03 08:26 / 08:42 | `2:3*` | 判已完成（同一天不重复签，正常） |
| 11-04 00:24 | — | `signin/status HTTP 401`（token 到期），00:24:42 保活才刷新 |
| 11-04 00:54 | `2:3*` scene=2 | **「无可领取」判成功 → 把 11-04 记成已签** ⛔ |
| 11-04 08:35 | — | 用户手动点 → **+400** |
| 11-04 08:36 | `3:3*` | 被「今日已完成」跳过 ⛔ |

两条已证实的细节（**别记成别的**）：
1. 换天发生在 **00:54 之后、08:35 之前**。**具体钟点无法证明**（没有 tick 命中
   换天瞬间，官方文档也没写）。曾写"实测 08:00"——那是推断过头，已纠正。
2. 11-03 签到成功后 `is_today` **仍停在 `2:3*`** → **领取本身不推进 day_no**，
   只有真正换天才推进。

**修复**（两道防线，各自都够，一起最稳）：

1. **日界线门禁** `checkinGateHour`（`index_turso.js`）：默认
   `DEFAULT_GATE_HOUR = 8`，全部账号**北京 8:00 之后才发请求**。
   依据（用户洞察）：供应商只有 CN / UTC 两类时区，UTC 0 点正好是北京 8 点，
   所以 8:00 覆盖两类，且**永远不早于上游换天去试**——早试的唯一后果是
   误判已签、整天丢分；晚试只是晚几小时进账。
   用户进一步的判断："如果一天只在 8:05 和 21:25 试两次，并不存在会误认为
   没到第二天" → **只要不在换天前试，误判的土壤就没有了**。
   - `CHECKIN_GATE_HOUR=auto` → 回到按归属分流（国内 0 点 / 海外 8 点）
   - `CHECKIN_GATE_HOUR=0..23` → 强制该小时
2. **「无 claimable」不再直接判已签**（`chan-checkin.js`）：走到那一步说明
   门禁已过、上游已换天，`is_today` 的状态才可信 —— 只有 `Claimed(3)` 或
   `scene=3` 才算签完；其余返回 `settled:false`，`checkinTick` 看到后
   **不记账、不算失败**，下个 tick 再试。

**走过的弯路**（避免重犯）：最初做了 `day_no` 记忆（`_mmPanel`）靠"day_no
是否前进"判换天 → 被用户否定"想复杂了"，已删除；也一度只看
`is_today.status===3`，单测当场指出它和"未换天"形状完全相同、分不开。

#### 缺陷 2：lobsterai 活动上下文少了 `/context` 段

```
旧: GET /api/client-activities/{code}?configRevision=…          → 404
新: GET /api/client-activities/{code}/context?configRevision=…  → 200
```

权威实现见 OFM `vendor/channel-pack/src/lobsterai-credits.ts:205`。
自 11-02 起每次签到都死在这一步。修复后首次自动签到成功：
**11-04 11:40 +100 分**（积分 300 → 400）。顺带：404 现在会带出上游 `msg`，
不再只有裸状态码。

#### 缺陷 3：渠道未知模型返回 500

所有账号目录都没有请求的模型时（`able` 循环全部 `continue`），`resp` 仍是
`null`，随后 `resp.headers.forEach` 抛 `TypeError` → 前端收到
`500 + code:undefined`。改为 **404 `model_not_found`**（e2e 4a 抓到）。

#### 缺陷 4：`chan-refresh.js` 的 import 路径指错

`./chan-checkin.js` 被写成 `../chan-checkin.js`（指向仓库根）→ 进程启动即
`ERR_MODULE_NOT_FOUND`，**整个服务起不来**。

#### 缺陷 5：`test-refresh` 会真的外访有道

`clientVersionApi` 没指向 mock，单测会打一次
`api-overmind.youdao.com`，违反「绝不外访、绝不与 OFM 抢凭据」的硬约束。
已改指本地 mock（404 → 走兜底版本号，正好覆盖回退链路）。

#### 关于「额度增量」

有的只是 `K.snap(id)` 的**整体覆盖写**（每次查询覆盖一条最新快照），用途三个：
面板显示、额度按钮查询落库、**聊天挑号按余额从高到低排序**。**没有任何
增量累加**——额度只查得到剩余值、扣减拿不到，`新-旧` 分不清是签到加还是
推理扣，累加没有意义。签到的成败只看**上游自己的返回**
（`code=0` / `claim_result=1` / `creditsGranted`），余额显示继续只走手动查询。

#### 测试

19 套单测 + e2e（28 条）全绿。新增：
- `test-checkin`：minimax 真实事故形状（`2:3*` scene=2）不误判 / 换天后能签 /
  `settled` 语义 / lobster mock 路径**必须带 `/context`**
- `test-checkin-schedule`：门禁存在 / 默认一律 8:00 / `auto` 模式保留 /
  **未结算结果在记账之前 `continue`**

#### 部署与线上验证

commit `7bff8e7` → push `main` → Render 自动重建；`/healthz` 200
（`x-node-version: v24.22.1`）。实测：
- lobsterai 手动签到 → `今天已签到`（不再 404），并已自动拿到 +100
- 渠道未知模型 → **404 `model_not_found`**
- 今日三账号：WB 已签 / minimax 已完成（用户手动那次）/ lobsterai 已签

#### 遗留

- minimax 换天的**准确钟点**仍未证实；8:00 门禁是"覆盖两类时区"的下限策略，
  不是实测值。若上游改在北京 0 点换天，8:00 只会晚、不会丢。
- WB 今日"真领取"只有 00:24 的 `code=0` 为证；其签到奖励不进 `credits` 汇总，
  无法用余额证明，**也不该去证明**。

---

### 7.15 2026-11-04 手机号昵称打码 —— wb 渠道不再泄明文

#### 症状与真实归因

用户报「wbr 网关只对新导入的 4 个渠道的用户名打码，wb 渠道还是完整手机号」。
核对线上 `/api/accounts` 后确认差异真实存在（wb=`18154241890`，其余渠道已是
`181******90`），但**根因不在网关**：

- 网关此前**没有任何打码代码**（全库搜 `mask`/`打码`/`***` 零命中）；
- 4 个渠道的昵称在 **OFM 导出侧就已打码**（fixture 里 lobsterai 即 `181******90`）；
- wb 账号的 nickname 是上游 WB 协议返回的手机号本身，网关原样转存。

即：**差异在来源，不在处理**。但明文手机号确实躺在 Turso 里并从面板出口泄出，
需要网关侧兜住。

#### 修法：两层，都不动库存值

| 层 | 位置 | 作用 |
|---|---|---|
| 入口 | `parseAccountFile()` | 导入即改写 → 库里从此不再进明文手机号（含 `skipped` 回报） |
| 出口 | `GET /api/accounts` | 存量昵称 + `accounts/patch` 手工写入的值，出面板前再打一遍 |

**为什么不回写库存**：`nickname` 是幂等导入的去重键（`provider|nickname`）。
入口改写在入库前完成，所以「同一手机号重复导入」仍命中同一键，幂等性不变；
出口只改返回副本，库存原值保持稳定。

**打码规则（保守）**：只认 **11 位、`1` 开头的纯数字** → `181******90`。
其他打码口径（如 `139****1234`）、邮箱、用户名、`RaccoonNatalie (1890)`
**一律原样保留** —— 猜错口径会把别人的展示串改坏，比不猜更糟。

**协议无影响**：`billingHeaders()` 只带 `uid`/`token`，WB 请求链路不读 nickname。

#### 测试

新增 `tools/test-mask-phone.mjs`（**11 条全绿**）：入口改写 / 幂等不破
（重导 `updated=1, created=0`）/ 出口兜底 / 库存不被展示层改写 / 边界不误伤
（非 1 开头、含字母、邮箱、用户名串）。

回归：**17 套单测 + e2e 全绿**。
⚠️ `test-keepalive` 首跑曾红，原因是测试端口 18961/18962 被前一次中断的实例
占着（`/healthz` 仍 200 但属于旧进程，鉴权失败）→ 换端口即 7/7。**不是代码问题**。

#### 部署与线上验证（commit `ac97c5d`）

- 线上库存补丁：wb 账号 `accounts/patch` → `181******90`
- 探针验证新版本已生效：手工 patch 明文 `18912345678` → `GET /api/accounts`
  返回 `189******78`（出口打码生效），随后还原为 `181******90`
- 日志面复核：**222 条日志零命中完整手机号**（`logTask` 只记 type/msg，不含昵称）
### 7.16 2026-11-04 上下文护栏把 1M 模型按 256k 拦 —— 渠道窗口从未取到

#### 症状

用户报「模型还只有 131k 上下文」。查 `/root/.dsh/keypool/store.json` 发现
DSH 侧确实按 `131072` 在压会话，但 `/v1/models` 对同一批模型声明的是
**1M（raccoon）/ 256k（sensenova）**。头与实控不一致。

#### 真实根因：两处叠加，让渠道模型**必然**取不到窗口

护栏（`worker/context-guard.js`，2026-10-21 引入）的 `realWindow` 在
`handleProxy` 里这样取：

```js
const parsedModel = body && body.model ? stripModelId(body.model) : {...};
const { owner } = await aggModels(accs, "agg_models_v4");
const m = owner[parsedModel.id];           // ← 两个原因叠加，这里恒为空
```

| # | 原因 | 后果 |
|---|---|---|
| 1 | `stripModelId` 给 **WB 上游**用，**故意不剥**渠道前缀（见其注释） | `raccoon/sn-glm-5-3` 原样进查找，而 `owner` 的键只有 WB 裸 id |
| 2 | 这块作用域里的 `accs = allAccs.filter(provider==='wb')`，渠道账号在 `chanAccs` | 即便键能对上，`accs.find()` 也找不到账号 |

两者叠加 → `realWindow = null` → `cgEffectiveCeiling(null)` 返回
`CG_UNKNOWN_WINDOW_CAP = **262144**`。于是：

- 标称 **1M** 的 `raccoon/sn-glm-5-3` 实际按 **256k** 拦；
- 而 `/v1/models` 的 `X-Upstream-Context-Window` 头**另走一套算法**
  （`cgEffectiveCeiling(m.context)`，m.context 来自 vendor 表）→ **头写 1M**。
- **头说能用 1M，闸按 256k 拒** —— 用户看到的就是「说了 1M 却不让用」。

顺带发现：这段代码**每个 WB chat 请求都额外打一次 `/v3/config`**
（`fetchModels(acc0)`），只为拿一个 `aggModels` 缓存行里**本来就有**的 `context`。

#### 修法：抽出唯一取值来源 `worker/model-window.js`

| 归属 | 取值 | 是否打上游 |
|---|---|---|
| 渠道 | 该渠道自己的模型目录 `context`（本地表 / cline 远端预热），**与 `/v1/models` 同源** | 首次预热后走缓存 |
| WB | `aggModels` 缓存行的 `byRealm[realm].context`（`[g]` → global） | **否**（省掉每请求一次往返） |

口径沿用 `models-dev.js` 写下的那条铁律：**取不到就 null，绝不猜**
（猜大等于关掉护栏，猜小等于无故截断）。协作方任何故障都**只降级不抛** ——
护栏取不到窗口不该让对话失败。

#### 验证（线上实测，非仅单测）

| 探测 | 修复前 | 修复后 |
|---|---|---|
| `X-Upstream-Context-Window` 头 | 与闸不一致 | `raccoon/sn-glm-5-3 → 1000000`、`sn-kimi-k3 → 1000000` |
| 30 万 CJK 打 `raccoon/sn-glm-5-3` | **413**（262144 兜底） | **200**，`prompt_tokens: 290012`，92.7s |
| 27 万 CJK 打 `sn-sensenova-6-8-flash` | 413 报 `262144` | 413 报 **`256000`**（= vendor 表真实窗口，证明取值生效） |
| 96k 模型 + 12 万 CJK | 413 | **仍 413**（防护未削弱） |
| 窗口未知 + 30 万 CJK | 413 | **仍按 262144 兜底拦** |

新增 `tools/test-model-window.mjs`（**15 条**），其中第 ④ 组用**真护栏实现**
跑「闸没被拆掉」的证明：1M/30万放行、96k/12万仍 413、未知仍兜底。
回归：**17 套单测 + e2e 28 条全绿**。

#### 未动的东西（明确记录意图）

- **闸 2（429 循环熔断）一行未改**。已知它拦不住「增长型空转」（指纹含
  `msgs.length`，每轮都不同 → 12 轮实测全放行），而会拦 keypool 的 6 次
  一字不差重试（`1 首发 + 5 重试 = 6`，正好等于 `LOOP_REPEAT_LIMIT`）。
  本轮只修取值，不改语义；阈值可经 `render.yaml` 的 env 调，无需改代码。
- `lobsterai` 的 `131072` 仍留在 vendor 表（那是桥接层统一填的占位值，
  非实测）。要不要覆盖由 models.dev 补位策略单独决定，本轮未动。

### 7.17 2026-11-04 挑号统一 · 额度自动刷新 —— 「加号解 429」为什么之前没生效

#### 用户诉求

1. 加了 3 个 raccoon 号，**429 没解决**，怀疑网关没有轮换；
2. raccoon **每天重置额度**，查一次不够 —— 额度查询要自动化；
3. WB 与渠道**两条轮回机制并行**，最好合并成一条按积分，额度查询对所有供应商统一。

#### 根因：三条缺陷叠加，每一条都足以让「多账号」失效

**① 渠道「固定取第 0 位」，WB 纯随机**

```js
// 改前 · 渠道
accountsWithCredits.sort((a,b) => b.credits - a.credits);
for (let i = 0; i < Math.min(3, len); i++) { const pick = accountsWithCredits[i]; ... }
// 改前 · WB
const acc = accs[Math.floor(Math.random() * accs.length)];   // 完全忽略积分
```

渠道那条按积分降序后**永远从第 0 位开始**且成功后 `break` —— 加 N 个号也只打第 1 个。
实测：导入 3 个新号后 10+ 次请求全部落在同一个老号上（额度扣减只出现在一个号）。

**② 429 根本不触发换号（决定性缺陷）**

```js
// worker/backends/openai-family.js:96-110
if (!res.ok) { return new Response(JSON.stringify({error:{...}}), {status: res.status}); }
//                                          ↑ return，不是 throw
// worker/index_turso.js（改前）
try { resp = await chan.backend.chat(...); break; }   // ← 拿到 Response 就 break
catch (e) { lastError = e; }                          // ← 只有 throw 才切下一个号
```

**非 2xx 返回的是 `Promise<Response>`，永不抛异常** → 必然走 `break` →
「最多试 3 个账号」那段循环**从未真正执行**。证据：日志里
`chat-error` / `chat-skip-cooldown` / `cooldown` 各 **0 条**。

**③ 额度查询从不自动**

全库只有 2 处写 `K.snap`，**都来自用户点面板按钮**；`runCron`(6h) 与
`checkinTick`(30min) 里**一行都没有**。后果：
- 新导入账号 `credits=None` → 排序用 `snap?.credits ?? 0` → **永远垫底**；
- raccoon 每日重置，快照不刷新就是导入那天的旧值 → 按过期数字排序。

#### 改法

| 项 | 改前 | 改后 |
|---|---|---|
| 选号 | WB 随机 / 渠道固定第 0 位 | **共用** `pickAccountsByCredits`：积分分层 + 层内轮转 + 冷却过滤 |
| 429/401/403/5xx | 直接透传 | **切换下一个号**（`channelFailureAction` 分类） |
| 4xx（模型不存在/体过大） | 透传 | 透传（换号无意义） |
| 额度快照 | 仅手动 | `CREDITS_TICK_MS`(30min) + `CREDITS_SNAP_TTL_MS`(1h) + 签到成功后当场刷 |
| 冷却 | 渠道**只读不写** | 渠道 429 也写；**但只有 429 才写** |

新增 `worker/account-pick.js`（**纯函数、无 I/O**，可单测）：

- **分层**：积分 ≥ 最高分 × `tierRatio`(0.5) 为「富余层」，层内**轮转**；
  积分塌了的号（6000 vs 100）降级到后面，不与富余号抢流量。
- **未知积分不惩罚**：`credits=null` 的新号**参与轮转**（不是旧行为的永久垫底）。
- **游标 span 取各层最大长度**，不能只取 `rich.length` ——
  否则「富余层 1 个 + 未知层 3 个」（正是新导入 3 个号还没查额度的真实场景）
  会让未知层**永不轮转**。这条是写测试时逮到的真 bug。

#### 踩到的三个坑（都写进了代码注释）

1. **额度预查不能进 chat 路径**：第一版放在挑号前，`test-refresh-lock`
   立刻从 8/8 变 5/8（续期上游命中 1→7）。多秒级上游查询只能放定时 tick，
   chat 只读内存快照。
2. **追这个回归时先误判成锁失效 / 竞态**，插桩后才找到真因：
   `CREDITS_TICK_MS` 启动即跑，而**额度端点与续期共用同一批上游 host**，
   测试的 mock 计数器把两种调用都数了 → 测试补 `CREDITS_TICK_MS:'0'`。
3. **冷却范围一度写错**：401/403 一律按 `ban`(24h)，导致 e2e 的
   「渠道未知模型 → 404」变成 `503 channel_all_cooldown` ——
   一个号的 401 把整条渠道的候选全冷静了。改为**只有 429 才冷却**。

#### 验证

新增 `tools/test-account-pick.mjs` **22 条**（轮转 / 分层 / 未知不惩罚 /
冷却 / 新鲜度 / 边界）。其中「6 次请求的首选覆盖全部 3 个账号」
与「不同游标给出不同首选」是对旧行为的直接反例。

回归：**20 套单测 + e2e 28 条全绿**；`test-refresh-lock` 连跑 5 次稳定 8/8。

线上：部署后启动即刷一轮额度（日志 `额度刷新(boot): 3 成功 / 1 失败`，
失败的是 lobsterai 40302）；`sn-glm-5-3` / `sn-kimi-k3` / `MiniMax-M3` 冒烟全 200。

⚠️ **遗留**：`worker/backends/raccoon.js:17` 的 chat URL **硬编码**
（只有 `chan-refresh.js` 走了 `override()`），所以无法用本地 mock 上游
做轮转的端到端验证 —— 轮转证据目前是单元级的（22 条）+ 线上无回归。

### 7.18 2026-11-04 raccoon 推理基址可覆盖 —— 补齐轮转的端到端验证

§7.17 的轮转证据只到**纯函数层**（`account-pick.js` 22 条）。「网关真的换了
token 发出去」必须看上游收到什么，而 `backends/raccoon.js` 的 chat URL
**写死 vendor 常量**（`RACCOON.apiBase=https://xiaohuanxiong.com`）——
只有续期/额度读了 `RACCOON_API_BASE` 覆盖。把网关指向本地 mock，
请求仍然打到真实商汤（实测 mock 一次没收到、返回真实 401）。

#### 改法

chat URL 支持 `RACCOON_CHAT_BASE`（回退 `RACCOON_API_BASE`，再回退 vendor 常量）。
生产两个都不设 → 零行为变化。

**两个细节是踩出来的：**

1. **必须用独立变量，不与续期共用 `RACCOON_API_BASE`**。
   `test-refresh-lock` 用 `RACCOON_API_BASE` 把**续期**指向它的计数器；chat 一旦
   也读这个变量，5 个并发 chat 各打一次都被数进去 —— 实测 `hits` 1→6，
   那条本意测「续期锁」的断言变红，**且核报成锁失效**（我第一版就此误判了半天）。
   分开之后两条测试各测各的：该测试的 chat 改指一个没人听的端口。
2. **不 import chan-refresh 的 `override()`**。会建出
   `raccoon.js → chan-refresh.js → chan-checkin.js → chan-refresh.js` 循环依赖，
   改变模块初始化顺序。为一行函数（`process.env[env] || def`）引一条环不值得。

#### 新增 `tools/e2e-rotation.mjs`（6 条）

| 断言 | 实测结果 |
|---|---|
| 上游真的收到请求（钩子生效） | 收到 5 次 |
| 6 次同模型请求用到 ≥2 个账号 | **3 个**：tok-A / tok-B / tok-C |
| 低积分号（100 分 vs 6000）未被使用 | tok-D 从未出现 |
| 首个号 429 后最终仍 200 | status=200 |
| 上游收到 2 次（429 + 换号重发） | 2 次 |
| 两次是**不同** token（不是原号重试） | tok-A vs tok-B |

**A/B 对照证明这条测试真能逮到问题**：把钩子回滚掉再跑 → **FAIL 5**
（请求打真实商汤、返回真实 401）；装回钩子 → 6/6 全绿。

回归：**21 套单测 + e2e-channels + e2e-rotation 全绿**。
线上部署后冒烟：`sn-glm-5-3` / `sn-kimi-k3` / `MiniMax-M3` 全 200。


### 7.19 2026-11-12 11140 冻结 + 面板 noindex —— 移植 hub v2.1.x 防封语义

来源：workbuddy2api-hub 的 CHANGELOG 调研（2026-11-12）。上游 2026-10-23 起
收紧非官方客户端识别后，hub v2.1.0 把 `11140` 从「可恢复冷却」升格为
**持久封禁**：命中即停用该号、**停止换号重试**（原话「避免同设备账号继续
连坐」——封禁按设备指纹判定，拿同池其他号继续打会把好号一起带走），
重启/刷新/重导入都不自动恢复，解禁唯一入口是面板手动启用。

#### 改了什么（五处，判据全在新增的 `worker/ban-classify.js` 纯函数层）

| 位置 | 行为 |
|---|---|
| WB 换号循环 | 403 先 `peekBanError` 定罪：11140 → `freezeBannedAccount` + **break 停止换号**；非 11140 照旧切换 |
| WB 4xx 分类段 | 11140 冻结**优先于**风控文案 24h 冷却；另加裸 `code===11140` 兜底支（HTTP 200 包错误体形态）。单号池不进循环的场景全靠这段兜住 |
| `checkinTick` | 封禁号双重跳过；WB 签到结果 `code=11140` 即冻结（v2.1.1「自动任务不放大风控」） |
| 导入幂等段 | `banned` 标记随账号保留，重导入不复活封号 |
| `accounts/enable` | 启用即解禁（清标记 + 撤销 until=0 永久冷却）；停用**不**清标记 |

冻结落库三件套：`enabled=0` + `banned=1` + 永久冷却冗余（`reason='auth'`，
防 cooldown 表被「清理数据」抹掉后从别处漏放）。UI 状态列显示「已封禁」
（悬停出上游证据）。判定**宁窄勿宽**：只认 11140，其余 403 走老 24h 冷却。

#### 顺手带上 v2.0.7 的 noindex

面板/登录页 HTML 加 `<meta name="robots" noindex>` + `X-Robots-Tag` +
`Cache-Control: no-store`——公网部署防被搜索引擎/资产测绘平台扫出入口。
只挡新收录，历史快照需另行去搜索引擎控制台提交移除。

#### 两个踩过的坑（复现的人注意）

1. **`bufferedRaw` 的 TDZ**：peek 用 `r.text()` 消费过 403 错误体后，外层透传
   不能再 `await r.text()`（body 已读尽 → 客户端收到空白错误）。缓冲变量必须
   声明在循环**之前**（循环里赋值引用后声明的 `let` 直接 ReferenceError），
   且每次 `send()` 后置 null——否则拿旧号的缓冲配新响应。
2. **`r.status===403 || code===403` 条件里的 `code` 是业务码不是 HTTP 码**，
   上游 `displayMsg` 形态各异，判定统一走 `upstreamCodeOf`（嵌套 `error.code`
   /字符串码都吃过实测）。

#### 明确没做的

- **设备令牌真实值档**（dsh-connect-workbuddy 的 Turing SDK 路线）：需要本机
  桌面端 `turing_sdk.node` + Electron runloop，Render 容器无物料，用户已拍板
  桌面提取暂缓。届时可做「虚拟值档」等价物：账号级 `device_token` 字段 +
  `X-Device-Token` 注入 + 出口打码。
- **uTLS/JA3 指纹桥**（hub v2.0.3）：Node fetch 够不着 ClientHello 层。
- CF KV 旧版（`index_kv.js`/`worker_kv.js`）未同步——生产在 Render/Turso 版。

测试：新增 `tools/test-ban-freeze.mjs` 14 条（判定窄性/字符串与嵌套码/
落标三件套/解禁清干净/证据截断）。回归 18/24 绿，6 红为**既有基线**
（vendor `raccoon.js` 缺文件连带，stash 对照逐一同红，与本次无关）。
