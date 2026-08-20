#!/usr/bin/env node
/**
 * scripts/ops/lowvalue-observation-delete.mjs
 *
 * 一次性运维脚本(ops batch, 2026-08-20):按预先扫描好的低价值 observation 命中清单
 * 执行删除。不注册任何 iii-sdk function、不进 dist、不被产品代码 import——与
 * scripts/ops/insight-dedup.mjs 同类。
 *
 * 判重/判低价值口径**不在本脚本重算**:输入清单(--hits-file,格式见 scan.mjs 产出的
 * lowvalue_hits_full.json,数组元素至少含 {sessionId, id})是唯一事实源,本脚本只负责
 * "清单里的这些 id 存不存在、删不删得掉、删完验不验证",不重新判断 quality<30。
 *
 * 服务端没有按 id 删除单条 observation 的专用端点,但 POST /agentmemory/forget
 * (mem::forget, src/functions/remember.ts)支持 {sessionId, observationIds:[...]}
 * 批量删除——这正是本脚本要调用的端点。mem::forget 对不存在的 id 也会把 deleted
 * 计数 +1(kv.delete 对不存在的 key 是无操作,函数体没有先判存在性),所以响应体的
 * deleted 计数**不可信**,本脚本删除后会重新拉一次每个受影响 session 的 observations
 * 列表,用"目标 id 是否还在"做真删除的独立验证,而不是只看响应体。
 *
 * 流程:
 *   1. 读清单,按 sessionId 分组
 *   2. 对每个 session:GET /agentmemory/observations?sessionId=X&agentId=* 拉当前
 *      完整记录,与清单 id 交叉——清单里已经不存在的 id 记 alreadyGone,不算失败
 *   3. 把即将删除的完整 observation 对象(不是清单里的截断字段)写入
 *      ~/.agentmemory/backup/lowvalue-obs-delete-<date>.json —— 在任何删除调用之前
 *   4. 默认 dry-run,只打印计划、不调用 /agentmemory/forget;显式 --apply 才真删
 *   5. --apply 下,对每个 session 调一次 POST /agentmemory/forget;单个 session 失败
 *      不中止整批(记录失败原因,继续下一个 session),最后汇总
 *   6. 删除后对每个动过的 session 重新 GET 一次,确认目标 id 都不在了(独立于步骤 5
 *      响应体的 deleted 计数);连同结果报告一起落盘
 *
 * 用法:
 *   dry-run(默认,不删):
 *     node scripts/ops/lowvalue-observation-delete.mjs --hits-file <path>
 *   真删:
 *     node scripts/ops/lowvalue-observation-delete.mjs --hits-file <path> --apply
 *
 * 认证:AGENTMEMORY_SECRET 从 ~/.config/agentmemory/service.env / ~/.agentmemory/.env
 *      读取(同 insight-dedup.mjs 的 loadEnv 顺序),process.env 已有同名变量优先。
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const DEFAULTS = {
  baseUrl: "http://localhost:3111",
  backupDir: path.join(os.homedir(), ".agentmemory", "backup"),
  fetchTimeoutMs: 30000,
  maxRetries: 2,
};

function parseArgs(argv) {
  const args = { apply: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--hits-file":
        args.hitsFile = argv[++i];
        break;
      case "--base-url":
        args.baseUrl = argv[++i];
        break;
      case "--backup-dir":
        args.backupDir = argv[++i];
        break;
      case "--apply":
        args.apply = true;
        break;
      default:
        throw new Error(`未知参数: ${a}`);
    }
  }
  if (!args.hitsFile) {
    throw new Error("必须传 --hits-file <低价值 observation 命中清单路径>");
  }
  return args;
}

async function loadEnvFile(filePath) {
  const out = {};
  let text;
  try {
    text = await readFile(filePath, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return out;
    throw err;
  }
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

async function loadEnv() {
  const home = os.homedir();
  const base = await loadEnvFile(path.join(home, ".agentmemory", ".env"));
  const service = await loadEnvFile(
    path.join(home, ".config", "agentmemory", "service.env"),
  );
  const merged = { ...base, ...service };
  for (const [k, v] of Object.entries(merged)) {
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJSON(url, options, { timeoutMs, retries = 0, label }) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        ...options,
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await res.text();
      let body;
      try {
        body = text ? JSON.parse(text) : {};
      } catch {
        throw new Error(
          `${label ?? url} 返回非 JSON(HTTP ${res.status}): ${text.slice(0, 300)}`,
        );
      }
      if (!res.ok) {
        throw new Error(
          `${label ?? url} HTTP ${res.status}: ${JSON.stringify(body).slice(0, 300)}`,
        );
      }
      return body;
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        console.error(
          `[warn] ${label ?? url} 第 ${attempt + 1} 次失败(${err.message}),重试...`,
        );
        await sleep(1000 * (attempt + 1));
        continue;
      }
    }
  }
  throw new Error(`${label ?? url} 重试 ${retries} 次后仍失败: ${lastErr.message}`);
}

function todayStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

async function fetchSessionObservations(baseUrl, secret, sessionId, timeoutMs) {
  const body = await fetchJSON(
    `${baseUrl}/agentmemory/observations?sessionId=${encodeURIComponent(sessionId)}&agentId=*`,
    { headers: { Authorization: `Bearer ${secret}` } },
    { timeoutMs, retries: 2, label: `GET /agentmemory/observations (${sessionId})` },
  );
  if (!Array.isArray(body.observations)) {
    throw new Error(
      `GET /agentmemory/observations?sessionId=${sessionId} 返回体不含 observations 数组: ${JSON.stringify(body).slice(0, 300)}`,
    );
  }
  return body.observations;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cfg = { ...DEFAULTS, ...args };
  await loadEnv();
  const secret = process.env.AGENTMEMORY_SECRET;
  if (!secret) {
    throw new Error(
      "AGENTMEMORY_SECRET 未设置(应来自 ~/.config/agentmemory/service.env)",
    );
  }

  console.error(`[1/6] 读取命中清单: ${cfg.hitsFile}`);
  const raw = await readFile(cfg.hitsFile, "utf8");
  const hits = JSON.parse(raw);
  if (!Array.isArray(hits) || hits.length === 0) {
    throw new Error("命中清单为空或不是数组,拒绝执行");
  }
  for (const h of hits) {
    if (!h || typeof h.sessionId !== "string" || typeof h.id !== "string") {
      throw new Error(`命中清单条目缺 sessionId/id: ${JSON.stringify(h).slice(0, 200)}`);
    }
  }
  console.error(`[1/6] 命中清单 ${hits.length} 条,按 sessionId 分组...`);

  const bySession = new Map(); // sessionId -> Set<obsId>
  for (const h of hits) {
    if (!bySession.has(h.sessionId)) bySession.set(h.sessionId, new Set());
    bySession.get(h.sessionId).add(h.id);
  }
  console.error(`[1/6] 涉及 ${bySession.size} 个 session`);

  console.error(`[2/6] 逐 session 拉当前完整记录,与清单交叉核对存在性...`);
  const toDelete = []; // { sessionId, observation: <完整对象> }
  const alreadyGone = []; // { sessionId, id } —— 清单里有,现在拉不到了
  const sessionCurrentIds = new Map(); // sessionId -> Set<所有当前 id>(用于删后校验)

  for (const [sessionId, wantedIds] of bySession) {
    const observations = await fetchSessionObservations(
      cfg.baseUrl,
      secret,
      sessionId,
      cfg.fetchTimeoutMs,
    );
    const currentMap = new Map(observations.map((o) => [o.id, o]));
    sessionCurrentIds.set(sessionId, new Set(currentMap.keys()));
    for (const id of wantedIds) {
      const obs = currentMap.get(id);
      if (obs) {
        toDelete.push({ sessionId, observation: obs });
      } else {
        alreadyGone.push({ sessionId, id });
      }
    }
  }
  console.error(
    `[2/6] 待删 ${toDelete.length} 条,清单里已不存在(跳过,不算失败) ${alreadyGone.length} 条`,
  );

  console.error(`[3/6] 写备份(在任何删除调用之前)...`);
  await mkdir(cfg.backupDir, { recursive: true });
  const backupFile = path.join(
    cfg.backupDir,
    `lowvalue-obs-delete-${todayStamp()}.json`,
  );
  const backupPayload = {
    createdAt: new Date().toISOString(),
    tool: "scripts/ops/lowvalue-observation-delete.mjs",
    hitsFile: path.resolve(cfg.hitsFile),
    count: toDelete.length,
    alreadyGoneCount: alreadyGone.length,
    alreadyGone,
    // 完整 observation 对象(含 concepts/files/agentId/project 等清单里没有的字段),
    // 足以整条 kv.set 写回恢复(scope: mem:obs:<sessionId>)。
    observations: toDelete,
  };
  await writeFile(backupFile, JSON.stringify(backupPayload, null, 2), "utf8");
  console.error(`[3/6] 备份已写: ${backupFile}`);

  if (!cfg.apply) {
    console.error(
      `[4/6] dry-run(默认,未加 --apply):不调用 /agentmemory/forget。` +
        `计划删除 ${toDelete.length} 条,涉及 ${bySession.size} 个 session。`,
    );
    console.log(
      JSON.stringify(
        {
          mode: "dry-run",
          plannedDelete: toDelete.length,
          alreadyGone: alreadyGone.length,
          sessions: bySession.size,
          backupFile,
        },
        null,
        2,
      ),
    );
    return;
  }

  console.error(`[4/6] --apply 已给出,逐 session 调用 POST /agentmemory/forget...`);
  const deletePlanBySession = new Map(); // sessionId -> [id,...]
  for (const { sessionId, observation } of toDelete) {
    if (!deletePlanBySession.has(sessionId)) deletePlanBySession.set(sessionId, []);
    deletePlanBySession.get(sessionId).push(observation.id);
  }

  const perSessionResult = [];
  for (const [sessionId, ids] of deletePlanBySession) {
    try {
      const body = await fetchJSON(
        `${cfg.baseUrl}/agentmemory/forget`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${secret}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ sessionId, observationIds: ids }),
        },
        { timeoutMs: cfg.fetchTimeoutMs, retries: 0, label: `POST /agentmemory/forget (${sessionId})` },
      );
      perSessionResult.push({ sessionId, requested: ids.length, responseDeleted: body.deleted, error: null });
    } catch (err) {
      // 单 session 失败不中止整批;记录原因,继续下一个 session(错误不吞)。
      perSessionResult.push({ sessionId, requested: ids.length, responseDeleted: null, error: err.message });
      console.error(`[warn] session ${sessionId} 删除调用失败: ${err.message}`);
    }
  }

  console.error(`[5/6] 删除调用完成,逐 session 重新拉取验证真实删除结果(不信响应体计数)...`);
  const stillPresent = [];
  let confirmedDeleted = 0;
  for (const [sessionId, ids] of deletePlanBySession) {
    const after = await fetchSessionObservations(cfg.baseUrl, secret, sessionId, cfg.fetchTimeoutMs);
    const afterIds = new Set(after.map((o) => o.id));
    for (const id of ids) {
      if (afterIds.has(id)) {
        stillPresent.push({ sessionId, id });
      } else {
        confirmedDeleted++;
      }
    }
  }

  const resultReport = {
    createdAt: new Date().toISOString(),
    tool: "scripts/ops/lowvalue-observation-delete.mjs",
    hitsFile: path.resolve(cfg.hitsFile),
    backupFile,
    requested: toDelete.length,
    alreadyGone: alreadyGone.length,
    confirmedDeleted,
    stillPresentCount: stillPresent.length,
    stillPresent,
    perSessionResult,
  };
  const reportFile = path.join(
    cfg.backupDir,
    `lowvalue-obs-delete-${todayStamp()}-report.json`,
  );
  await writeFile(reportFile, JSON.stringify(resultReport, null, 2), "utf8");

  console.error(
    `[6/6] 完成。requested=${toDelete.length} confirmedDeleted=${confirmedDeleted} ` +
      `stillPresent=${stillPresent.length} alreadyGone=${alreadyGone.length}`,
  );
  console.log(JSON.stringify(resultReport, null, 2));

  if (stillPresent.length > 0) {
    console.error(
      `[ERROR] ${stillPresent.length} 条目标 id 删除调用后仍能拉到,需要人工核查(见 stillPresent 字段)。`,
    );
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
