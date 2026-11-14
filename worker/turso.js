/**
 * Turso / libSQL HTTP 客户端 —— 替代 Cloudflare KV，接口 100% 兼容。
 */

const TURSO_URL = () => String(globalThis.TURSO_URL ?? process.env.TURSO_URL ?? '');
const TURSO_TOKEN = () => String(globalThis.TURSO_TOKEN ?? process.env.TURSO_TOKEN ?? '');

function endpoint(path = '/v2/pipeline') {
  const base = TURSO_URL();
  if (!base) throw new Error('缺少 TURSO_URL');
  return `https://${base.replace(/^libsql:\/\//, '').replace(/^https:\/\//, '')}${path}`;
}

/** 把 JS 值转成 libSQL 参数对象 {type, value} */
function toLibSQLArg(v) {
  if (v === null || v === undefined) return { type: 'null', value: null };
  if (typeof v === 'number') return { type: 'integer', value: v };
  if (typeof v === 'boolean') return { type: 'integer', value: v ? 1 : 0 };
  return { type: 'text', value: String(v) };
}

/** 从 libSQL cell 对象提取值 */
function extractCellValue(cell) {
  if (cell && typeof cell === 'object' && 'value' in cell) return cell.value;
  return cell;
}

/** 执行一条 SQL，返回 libSQL 的 result 对象。 */
async function exec(sql, args = []) {
  const token = TURSO_TOKEN();
  if (!token) throw new Error('缺少 TURSO_TOKEN');
  const libArgs = args.map(toLibSQLArg);
  const res = await fetch(endpoint(), {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ requests: [{ type: 'execute', stmt: { sql, args: libArgs } }] }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`turso HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  const first = data?.results?.[0];
  if (first?.error) throw new Error(`turso: ${JSON.stringify(first.error).slice(0, 200)}`);
  return first?.response?.result ?? { cols: [], rows: [] };
}

async function one(sql, args = []) {
  const r = await exec(sql, args);
  const cols = r.cols ?? [];
  const rows = r.rows ?? [];
  if (!rows.length) return null;
  const o = {};
  cols.forEach((c, i) => { 
    const colName = c.name ?? c;
    const cell = rows[0][i];
    o[colName] = extractCellValue(cell);
  });
  return o;
}

async function run(sql, args = []) {
  const r = await exec(sql, args);
  return { rowsAffected: r.rows_affected ?? r.affected_row_count ?? 0 };
}

export async function kvGet(k, d = null) {
  const row = await one('SELECT v FROM kv WHERE k = ?', [String(k)]);
  if (row === null || row.v == null) return d;
  try { return JSON.parse(row.v); } catch { return d; }
}

export async function kvPut(k, v) {
  await run(
    'INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v',
    [String(k), JSON.stringify(v)],
  );
}

export async function kvDel(k) {
  await run('DELETE FROM kv WHERE k = ?', [String(k)]);
}

export const K = {
  idxA: 'idx_accounts', idxK: 'idx_keys', logs: 'logs', pubreq: 'pubreq', setting: 'setting',
  hidden: 'model_hidden', acc: id => 'acc:' + id, key: id => 'key:' + id, snap: id => 'snap:' + id,
  pickCursor: 'account_pick_cursor',
  // 挑号游标：{ '<provider>|<model-or-*>': n } —— 统一挑号（account-pick.js）的
  // 层内轮转位置。按 (渠道, 模型) 分开记，避免一个模型的重负载把另一个模型的
  // 起点也推走（各模型打的是同一批账号的**不同额度池**）。
  pickCursor: 'account_pick_cursor',
  // 签到日记：{accId: 'YYYY-MM-DD'} —— 补签去重靠它（Render free 会挂起，
  // setInterval 不保证按时跑，见 index_turso.js 的 lazyCheckin 注释）
  checkinDay: 'checkin_day',
  // 模型运行时标记：{ '<model>'|'<model>|g': { dead?:ts, code?:n, needsEffort?:true } }
  // 上游「目录里有、chat 打不通」(11102/11103) 与「必须显式带思考档」(11150)
  // 都记在这里，见 model-marks.js 头注。TTL 到期自动失效，无需人工清。
  marks: 'model_marks',
  // 账号级冷却：{accId: {until: ts, reason: '429'|'ban'|'auth'}} —— 聊天挑号/签到时跳过冷却中的账号
  // TTL 自动过期：429→10分钟、403风控/401认证失败→当日停用、401+40100/40101→永久禁用
  cooldown: 'account_cooldown',
};

export async function tursoHealth() {
  try {
    const r = await exec('SELECT 1 AS ok');
    return { ok: true, rows: r.rows?.length ?? 0 };
  } catch (e) {
    return { ok: false, error: String(e.message || e).slice(0, 200) };
  }
}

export { exec, one, run };
