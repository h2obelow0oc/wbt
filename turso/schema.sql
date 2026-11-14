-- wb-manager · Turso/libSQL schema（通用键值表版）
--
-- 设计取舍：**保留原 KV 的字符串键语义**，用一张 kv 表存 JSON blob。
--   理由：index_kv.js 里 32 处 kvGet/kvPut/kvDel 全部按字符串键读写
--        （"idx_accounts" / "acc:<id>" / "key:<id>" / "snap:<id>" / "logs" / "pubreq" / "setting" / "model_hidden" / "agg_models_v4"），
--        保留这套签名 ⇒ **业务代码 0 改动**，只替换 KV 层实现。
--   代价：放弃关系型查询/LIKE 检索；收益：验证阶段风险最低。
--   后续优化（可选）：把 accounts/apikeys 拆成关系表，用 SELECT 替代 id 数组扫描。
--        这一步等 Render 版跑通、数据量上来再做，避免一开始同时改两层。

CREATE TABLE IF NOT EXISTS kv (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);

-- 可选：把「id 集合」这类小键单独建索引（当前数据量小，可不加）
-- CREATE INDEX IF NOT EXISTS idx_kv_k ON kv(k);
