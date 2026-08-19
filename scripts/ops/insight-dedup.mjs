#!/usr/bin/env node
/**
 * scripts/ops/insight-dedup.mjs
 *
 * 一次性运维脚本(FR-9 / ADR-11):清理 KV.insights 存量语义近义重复记录。
 * 不注册任何 iii-sdk function、不进 dist、不被产品代码 import。
 *
 * 判重口径(PRD v4 D-2 裁决,已定案,不接受脚本参数覆盖):
 *   embedding 粗筛成簇(保守的 complete-link,不用传递闭包/单链聚类)
 *   + LLM 逐簇精判(每簇调用两次,结果不一致则整簇保守剔除,不进待删清单)
 *
 * 流程分两个独立命令,不合并成一次调用(理由见下方"两阶段设计"):
 *
 * 【阶段一:全量重跑,只能 dry-run,产出待人工过目的清单】
 *   1. GET /agentmemory/insights?limit=<limit> 拉全量
 *   2. 每条 content 算一次 embedding(bge-m3, 1024 维),两两算余弦相似度
 *   3. 相似度 >= --threshold 的观测先用并查集圈出连通分量(粗筛上界),
 *      再在分量内做 complete-link 凝聚聚类,只有分量内两两相似度都
 *      达标才合并进同一候选簇 —— 避免"A~B~C 但 A 与 C 矛盾"被链式误并
 *   4. 候选簇(size>=2)逐个交给 LLM 精判是否语义重复(而非表面相似但矛盾);
 *      每簇调用两次交叉验证,两次结果不一致时整簇不进最终待删清单
 *   5. 确认重复的子簇内:保留 reinforcements 最高的一条;并列保留
 *      createdAt 最早的一条;其余进待删清单
 *   6. 待删清单对应的完整 insight 对象写 JSON 备份 + 判重过程 report(JSON)
 *      + 人可读清单(md);此阶段**不接受 --apply**(见下方两阶段设计)
 *
 * 【阶段二:--from-report,复用已过目清单执行删除,不重新计算任何东西】
 *   7. 从阶段一产出的 report JSON 原样读出 keepId/dropIds,做四项强制校验
 *      (dropIds 此刻仍存在于服务端 / dropIds 与 keepIds 无交集 / 备份文件
 *      id 集合与 dropIds 集合完全相等 / 待删条数三方一致),任一不过即中止;
 *      默认只打印校验结果与计划,显式 --apply 才调
 *      DELETE /agentmemory/insights 批量删除,删除后复核总数降幅
 *
 * 【两阶段设计的理由(FR-9 红线的实际踩坑)】:若 dry-run 与 --apply 合并成
 * 一次"重跑即删"的调用,两次运行之间只要 insight 表发生任何变化(哪怕只是
 * 一次真实的 reflect 触发新产生了几条记录),第二次重跑算出的候选簇/清单就
 * 会与人工刚看过的那份不同——此时 --apply 删除的实质是一份**没人看过**的
 * 新清单,直接打穿"重新跑出的判重清单必须人工过目"这条红线。因此本脚本
 * 结构性地不允许阶段一直接 --apply(顶层会抛错拒绝),必须先落盘 report/
 * 备份、人工过目后,再用 --from-report 指向那份被过目过的 report 文件执行
 * 删除;--from-report 从不重新计算聚类或调用 embedding/LLM,只做字节级的
 * "清单没变"校验 + 调删除端点,保证被删的就是被看过的。
 *
 * 用法(阶段一,全量重跑,产出待过目清单,不接受 --apply):
 *   node scripts/ops/insight-dedup.mjs [--limit 2000] [--threshold 0.90]
 *        [--backup-dir ~/.agentmemory/backup] [--review-out <path>]
 *        [--report-out <path>] [--base-url http://localhost:3111]
 *
 * 用法(阶段二,复用已过目清单;不带 --apply 时只校验+打印计划,不删):
 *   node scripts/ops/insight-dedup.mjs --from-report <report.json路径>
 *        [--backup-file <path,默认从 report 路径推导>] [--apply]
 *
 * 认证:AGENTMEMORY_SECRET 从 ~/.config/agentmemory/service.env 读取
 *      (该文件是 systemd EnvironmentFile,会覆盖 ~/.agentmemory/.env 同名变量);
 *      ANTHROPIC_API_KEY 从 ~/.agentmemory/.env 读取。
 *      两个文件本脚本会自行解析(等价于运行前 `source` 过),
 *      process.env 已有同名变量时优先生效,不覆盖调用方显式设置。
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

// ---------------------------------------------------------------------------
// 0. 参数与环境
// ---------------------------------------------------------------------------

const DEFAULTS = {
  baseUrl: "http://localhost:3111",
  limit: 2000,
  embedUrl: "http://localhost:9121/v1/embeddings",
  embedModel: "bge-m3:latest",
  embedApiKey: "ollama",
  llmUrl: "http://127.0.0.1:8045/v1/messages",
  llmModel: "gemini-3.6-flash-high",
  llmAnthropicVersion: "2023-06-01",
  // 粗筛阈值:实测 703 条真实 insight 全量两两余弦相似度分布后取值(2026-08-19)。
  // 全量 246753 对里,分布是 min=0.315 / p50=0.520 / p90=0.692 / p99=0.860 /
  // p99.9=0.905 / max=0.959——本项目此前踩坑的"~0.82 相似但内容矛盾"样本正落在
  // p99 附近,说明 0.82~0.88 这一档仍有相当比例是主题相似但非真复述;0.90 卡在
  // 分布的极右尾(仅 340/246753 对达标,约 0.14%),配合下面的 complete-link
  // 精炼(而非传递闭包)实测产出 66 个候选簇、覆盖 150 条记录,抽样确认簇内
  // 内容确系同一结论的不同措辞改写(如"动态配置校验+惰性依赖导入"这一模式被
  // 反复以不同句式记录),候选簇再交给 LLM 精判兜底误判。阈值偏保守是有意的:
  // LLM 精判成本不是约束,漏检候选簇比误判候选簇代价更低,可调低阈值换更高召回率。
  threshold: 0.9,
  embedBatchSize: 32,
  // 实测本机 embedding 服务(bge-m3 本地推理)对并发请求是排队而非并行处理:
  // concurrency=4 时同批次互相排队导致单批耗时超过 60s 超时线、触发大量重试,
  // 反而比顺序请求更慢。默认改回 1(顺序请求),仍可通过参数按需调大。
  embedConcurrency: 1,
  backupDir: path.join(os.homedir(), ".agentmemory", "backup"),
  fetchTimeoutMs: 30000,
  embedTimeoutMs: 60000,
  llmTimeoutMs: 60000,
  maxRetries: 2,
};

function parseArgs(argv) {
  const args = { apply: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--apply":
        args.apply = true;
        break;
      case "--limit":
        args.limit = Number(argv[++i]);
        break;
      case "--threshold":
        args.threshold = Number(argv[++i]);
        break;
      case "--base-url":
        args.baseUrl = argv[++i];
        break;
      case "--embed-url":
        args.embedUrl = argv[++i];
        break;
      case "--embed-model":
        args.embedModel = argv[++i];
        break;
      case "--llm-url":
        args.llmUrl = argv[++i];
        break;
      case "--llm-model":
        args.llmModel = argv[++i];
        break;
      case "--backup-dir":
        args.backupDir = argv[++i];
        break;
      case "--review-out":
        args.reviewOut = argv[++i];
        break;
      case "--report-out":
        args.reportOut = argv[++i];
        break;
      case "--from-report":
        args.fromReport = argv[++i];
        break;
      case "--backup-file":
        args.backupFile = argv[++i];
        break;
      case "--help":
      case "-h":
        args.help = true;
        break;
      default:
        throw new Error(`未知参数: ${a}`);
    }
  }
  return args;
}

/** 极简 KEY=VALUE 环境文件解析,等价于 `source` 该文件后读 process.env。 */
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
  // 顺序与生产运行时一致:~/.agentmemory/.env 先加载,
  // ~/.config/agentmemory/service.env 后加载并覆盖同名键,
  // process.env 已有的值始终优先(调用方显式 export 的优先级最高)。
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

// ---------------------------------------------------------------------------
// 1. 通用 fetch 封装(超时 + 有限重试,幂等 GET/embedding 调用可重试)
// ---------------------------------------------------------------------------

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
      } catch (parseErr) {
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

// ---------------------------------------------------------------------------
// 2. Step 1 — 拉全量 insights
// ---------------------------------------------------------------------------

async function fetchAllInsights(baseUrl, secret, limit, timeoutMs) {
  if (!secret) {
    throw new Error(
      "AGENTMEMORY_SECRET 未设置(应来自 ~/.config/agentmemory/service.env)",
    );
  }
  const body = await fetchJSON(
    `${baseUrl}/agentmemory/insights?limit=${limit}`,
    { headers: { Authorization: `Bearer ${secret}` } },
    { timeoutMs, retries: 2, label: "GET /agentmemory/insights" },
  );
  if (!body.success || !Array.isArray(body.insights)) {
    throw new Error(
      `GET /agentmemory/insights 返回体不含 insights 数组: ${JSON.stringify(body).slice(0, 300)}`,
    );
  }
  return body.insights;
}

// ---------------------------------------------------------------------------
// 3. Step 2 — embedding 粗筛:批量算向量 + 余弦相似度矩阵
// ---------------------------------------------------------------------------

async function embedBatch(texts, cfg) {
  const body = await fetchJSON(
    cfg.embedUrl,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.embedApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: cfg.embedModel, input: texts }),
    },
    { timeoutMs: cfg.embedTimeoutMs, retries: cfg.maxRetries, label: "embeddings" },
  );
  if (!Array.isArray(body.data)) {
    throw new Error(`embeddings 响应缺 data 数组: ${JSON.stringify(body).slice(0, 300)}`);
  }
  return body.data
    .slice()
    .sort((a, b) => a.index - b.index)
    .map((d) => d.embedding);
}

/** 有限并发跑一组异步任务,保持结果与输入顺序一致。 */
async function runWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function runner() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  }
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, runner);
  await Promise.all(runners);
  return results;
}

async function embedAll(insights, cfg) {
  const batches = [];
  for (let i = 0; i < insights.length; i += cfg.embedBatchSize) {
    batches.push(insights.slice(i, i + cfg.embedBatchSize).map((x) => x.content));
  }
  console.error(
    `[embed] ${insights.length} 条 insight,拆成 ${batches.length} 批(每批 <=${cfg.embedBatchSize}),并发 ${cfg.embedConcurrency}`,
  );
  let done = 0;
  const batchVectors = await runWithConcurrency(batches, cfg.embedConcurrency, async (batch) => {
    const vecs = await embedBatch(batch, cfg);
    done += batch.length;
    process.stderr.write(`[embed] 进度 ${done}/${insights.length}\r`);
    return vecs;
  });
  console.error("");
  return batchVectors.flat();
}

function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

function norm(a) {
  return Math.sqrt(dot(a, a));
}

/** 全量两两余弦相似度矩阵。n=703 时 n^2 ~ 4.9e5,内存与耗时可忽略。 */
function buildSimilarityMatrix(vectors) {
  const n = vectors.length;
  const norms = vectors.map(norm);
  const sim = Array.from({ length: n }, () => new Float64Array(n));
  for (let i = 0; i < n; i++) {
    sim[i][i] = 1;
    for (let j = i + 1; j < n; j++) {
      const s = dot(vectors[i], vectors[j]) / (norms[i] * norms[j] || 1);
      sim[i][j] = s;
      sim[j][i] = s;
    }
  }
  return sim;
}

function similarityStats(sim) {
  const n = sim.length;
  const vals = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) vals.push(sim[i][j]);
  }
  vals.sort((a, b) => a - b);
  const pct = (p) => vals[Math.min(vals.length - 1, Math.floor(vals.length * p))];
  return {
    pairs: vals.length,
    min: vals[0],
    max: vals[vals.length - 1],
    p50: pct(0.5),
    p90: pct(0.9),
    p99: pct(0.99),
    p999: pct(0.999),
  };
}

// ---------------------------------------------------------------------------
// 4. Step 3 — 保守成簇:并查集圈连通分量(上界) + 分量内 complete-link 精炼
// ---------------------------------------------------------------------------
//
// 明确不用「传递闭包合并」(即:A~B、B~C 达标就把 A/B/C 全并进一簇,不检查
// A~C)——这正是本项目已踩过的坑:~0.82 相似但内容矛盾的记录会被误并同簇。
// 这里用 complete-link(全连接)凝聚聚类:只有当两个待合并子簇之间【所有】
// 跨子簇的两两相似度都 >= threshold,才允许合并;最终每个候选簇内部任意两条
// 记录的相似度都达标,不存在"靠链条搭桥"进来的成员。
// 为控制计算量,先用并查集在 threshold 下求连通分量作为候选范围的上界
// (分量内才可能存在需要合并的对),分量通常远小于全量,分量内再做
// complete-link 精炼的 O(size^3) 开销可以忽略。

class UnionFind {
  constructor(n) {
    this.parent = Array.from({ length: n }, (_, i) => i);
  }
  find(x) {
    while (this.parent[x] !== x) {
      this.parent[x] = this.parent[this.parent[x]];
      x = this.parent[x];
    }
    return x;
  }
  union(a, b) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[ra] = rb;
  }
}

function connectedComponents(n, sim, threshold) {
  const uf = new UnionFind(n);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (sim[i][j] >= threshold) uf.union(i, j);
    }
  }
  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const root = uf.find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(i);
  }
  return [...groups.values()].filter((g) => g.length >= 2);
}

/** complete-link 凝聚聚类,限定在一个连通分量内部;返回满足"簇内两两 >= threshold"的子簇列表(size>=2 才有意义)。 */
function completeLinkRefine(componentIndices, sim, threshold) {
  let clusters = componentIndices.map((idx) => [idx]);

  function minPairSim(a, b) {
    let m = Infinity;
    for (const i of a) {
      for (const j of b) {
        if (sim[i][j] < m) m = sim[i][j];
      }
    }
    return m;
  }

  while (true) {
    let bestI = -1;
    let bestJ = -1;
    let bestScore = -Infinity;
    for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        const score = minPairSim(clusters[i], clusters[j]);
        if (score >= threshold && score > bestScore) {
          bestScore = score;
          bestI = i;
          bestJ = j;
        }
      }
    }
    if (bestI === -1) break;
    const merged = clusters[bestI].concat(clusters[bestJ]);
    clusters = clusters.filter((_, k) => k !== bestI && k !== bestJ);
    clusters.push(merged);
  }

  return clusters.filter((c) => c.length >= 2);
}

function buildCandidateClusters(insights, sim, threshold) {
  const components = connectedComponents(insights.length, sim, threshold);
  const candidates = [];
  for (const comp of components) {
    const refined = completeLinkRefine(comp, sim, threshold);
    for (const cluster of refined) candidates.push(cluster);
  }
  return candidates;
}

// ---------------------------------------------------------------------------
// 5. Step 4 — LLM 逐簇精判(每簇调用两次交叉验证)
// ---------------------------------------------------------------------------

const JUDGE_SYSTEM_PROMPT = `你是数据治理专家,任务是判断给定的一组知识条目(insight)中,
哪些条目彼此属于"同一知识点/结论的重复表达"(语义重复),而不是仅仅主题相似、
或表面相似但结论/场景/参数不同甚至相互矛盾。

判断规则:
1. 只有当两条记录传达的是同一个具体结论、事实或知识点(允许措辞、详略不同)时,才算重复。
2. 内容主题相似但结论矛盾、或描述不同的具体场景/根因/参数,一律不算重复,即使表面用词接近。
3. 输入的一组条目内可能存在 0 个、1 个或多个互不相交的重复子组;不要强行把所有条目并成一组。
4. 不确定时保守判断为"不重复"——宁可漏判,不可错并。
5. 只输出严格 JSON,不要输出任何解释性文字、不要用 markdown 代码块包裹。

输出格式:
{"duplicateGroups": [["id1","id2"], ["id5","id6","id7"]]}
若没有任何重复子组,输出 {"duplicateGroups": []}
数组里的 id 必须原样取自输入给你的 id,不要编造、不要遗漏本该判重的。`;

function buildJudgePrompt(clusterInsights) {
  const lines = clusterInsights.map(
    (ins, i) => `[${i + 1}] id=${ins.id}\ncontent: ${ins.content}`,
  );
  return `候选簇成员如下(编号顺序不代表任何权重或时间先后):\n\n${lines.join("\n\n")}\n\n请按规则输出 JSON。`;
}

function extractJSON(text) {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : trimmed;
  return JSON.parse(candidate);
}

async function callLLMOnce(prompt, cfg) {
  const body = await fetchJSON(
    cfg.llmUrl,
    {
      method: "POST",
      headers: {
        "x-api-key": process.env.ANTHROPIC_API_KEY ?? "",
        "anthropic-version": cfg.llmAnthropicVersion,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: cfg.llmModel,
        max_tokens: 2048,
        system: JUDGE_SYSTEM_PROMPT,
        messages: [{ role: "user", content: prompt }],
      }),
    },
    { timeoutMs: cfg.llmTimeoutMs, retries: cfg.maxRetries, label: "LLM judge" },
  );
  const textBlock = body?.content?.find((c) => c.type === "text");
  if (!textBlock) {
    throw new Error(`LLM 响应无 text 内容块: ${JSON.stringify(body).slice(0, 300)}`);
  }
  let parsed;
  try {
    parsed = extractJSON(textBlock.text);
  } catch (err) {
    throw new Error(`LLM 输出非合法 JSON: ${textBlock.text.slice(0, 300)}`);
  }
  if (!Array.isArray(parsed.duplicateGroups)) {
    throw new Error(`LLM 输出缺 duplicateGroups 数组: ${textBlock.text.slice(0, 300)}`);
  }
  return parsed.duplicateGroups;
}

/** 归一化分组结果用于两次调用的一致性比较:组内 id 排序、组间按首 id 排序。 */
function normalizeGroups(groups) {
  return groups
    .map((g) => [...g].sort())
    .sort((a, b) => a.join(",").localeCompare(b.join(",")));
}

function groupsEqual(a, b) {
  const na = normalizeGroups(a);
  const nb = normalizeGroups(b);
  return JSON.stringify(na) === JSON.stringify(nb);
}

/**
 * 对一个候选簇跑两次 LLM 精判并交叉验证。
 * FR-9 异常路径:两次结果不一致 → 整簇（不是部分子组）不进最终待删清单,保守处理。
 */
async function judgeClusterConsistent(clusterInsights, cfg) {
  const prompt = buildJudgePrompt(clusterInsights);
  const [g1, g2] = await Promise.all([
    callLLMOnce(prompt, cfg),
    callLLMOnce(prompt, cfg),
  ]);
  if (!groupsEqual(g1, g2)) {
    return { consistent: false, groups: [], raw: { g1, g2 } };
  }
  return { consistent: true, groups: g1, raw: { g1, g2 } };
}

// ---------------------------------------------------------------------------
// 6. Step 5 — 簇内保留策略
// ---------------------------------------------------------------------------

function pickRetained(members) {
  // 保留 reinforcements 最高;并列保留 createdAt 最早
  const sorted = [...members].sort((a, b) => {
    if (b.reinforcements !== a.reinforcements) return b.reinforcements - a.reinforcements;
    return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
  });
  const [keep, ...rest] = sorted;
  return { keep, drop: rest };
}

// ---------------------------------------------------------------------------
// 7. Step 6 — JSON 备份 + 人可读清单
// ---------------------------------------------------------------------------

function todayStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

async function writeBackup(backupDir, dropInsights, meta) {
  await mkdir(backupDir, { recursive: true });
  const file = path.join(backupDir, `insight-dedup-${todayStamp()}.json`);
  const payload = {
    createdAt: new Date().toISOString(),
    tool: "scripts/ops/insight-dedup.mjs",
    meta,
    count: dropInsights.length,
    // 完整 insight 对象,足以整条 kv.set 写回恢复
    insights: dropInsights,
  };
  await writeFile(file, JSON.stringify(payload, null, 2), "utf8");
  return file;
}

function truncate(s, n) {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

function buildReviewMarkdown(finalClusters, params) {
  const lines = [];
  lines.push(`# insight-dedup dry-run 人工过目清单`);
  lines.push("");
  lines.push(`生成时间: ${new Date().toISOString()}`);
  lines.push(
    `参数: limit=${params.limit} threshold=${params.threshold} embedModel=${params.embedModel} llmModel=${params.llmModel}`,
  );
  lines.push(`候选簇(embedding粗筛): ${params.candidateClusterCount}`);
  lines.push(`LLM精判后确认重复的簇: ${finalClusters.length}`);
  lines.push(
    `因两次 LLM 判定不一致被保守剔除的候选簇: ${params.inconsistentCount}`,
  );
  lines.push(`待删记录总数: ${params.totalDrop}`);
  lines.push("");
  finalClusters.forEach((c, idx) => {
    lines.push(`## 簇 ${idx + 1}(${c.members.length} 条)`);
    lines.push("");
    lines.push(`- 簇内最小两两 embedding 相似度: ${c.minSim.toFixed(4)}`);
    lines.push(`- 簇内最大两两 embedding 相似度: ${c.maxSim.toFixed(4)}`);
    lines.push(`- LLM 判定理由: 两次调用一致确认为语义重复子组`);
    lines.push("");
    lines.push(
      `**保留**: \`${c.keep.id}\`(reinforcements=${c.keep.reinforcements}, createdAt=${c.keep.createdAt})`,
    );
    lines.push(`  > ${truncate(c.keep.content, 120)}`);
    lines.push("");
    for (const d of c.drop) {
      lines.push(
        `**待删**: \`${d.id}\`(reinforcements=${d.reinforcements}, createdAt=${d.createdAt})`,
      );
      lines.push(`  > ${truncate(d.content, 120)}`);
    }
    lines.push("");
  });
  if (params.inconsistentClusters?.length) {
    lines.push(`## 因判定不一致被剔除的候选簇(未进待删清单,原样保留)`);
    lines.push("");
    params.inconsistentClusters.forEach((c, idx) => {
      lines.push(`### 不一致簇 ${idx + 1}(${c.members.length} 条)`);
      lines.push(`- 第一次判定: ${JSON.stringify(c.raw.g1)}`);
      lines.push(`- 第二次判定: ${JSON.stringify(c.raw.g2)}`);
      for (const m of c.members) {
        lines.push(`  - \`${m.id}\`: ${truncate(m.content, 120)}`);
      }
      lines.push("");
    });
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// 8. Step 7 — 删除阶段(仅 --apply)与复核
// ---------------------------------------------------------------------------

async function applyDelete(baseUrl, secret, ids, timeoutMs) {
  return fetchJSON(
    `${baseUrl}/agentmemory/insights`,
    {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        insightIds: ids,
        reason: "FR-9 存量语义近义重复清理(scripts/ops/insight-dedup.mjs)",
      }),
    },
    { timeoutMs, retries: 0, label: "DELETE /agentmemory/insights" },
  );
}

// ---------------------------------------------------------------------------
// --from-report 执行路径:复用一份已经人工过目过的 report + 备份,跳过
// embedding/LLM 两个阶段直接进删除前校验。存在的理由(FR-9 红线):
// dry-run → 人工过目 → 重跑并立即 --apply 这个"朴素流程"里,重跑会重新拉
// 全量 + 重新聚类 + 重新过一遍 LLM——只要这段时间内 insight 表有任何变化
// (哪怕只是部署探活时真实调用了一次 reflect),重新算出的清单就不再是人工
// 看过的那份,--apply 删的实质上是一份没人看过的新清单,直接打穿红线
// 「重新跑出的判重清单必须人工过目」。--from-report 保证被删除的 id 集合
// 与已过目文件字节级一致(见下方四项强制校验),不重新计算任何东西。
// ---------------------------------------------------------------------------

async function runFromReport(cfg) {
  const secret = process.env.AGENTMEMORY_SECRET;

  console.error(`[from-report] 读取已过目 report: ${cfg.fromReport}`);
  let reportRaw;
  try {
    reportRaw = await readFile(cfg.fromReport, "utf8");
  } catch (err) {
    throw new Error(`读取 report 文件失败(${cfg.fromReport}): ${err.message}`);
  }
  let report;
  try {
    report = JSON.parse(reportRaw);
  } catch (err) {
    throw new Error(`report 文件不是合法 JSON(${cfg.fromReport}): ${err.message}`);
  }
  if (!Array.isArray(report.finalClusters)) {
    throw new Error(`report 缺 finalClusters 数组,格式不符预期: ${cfg.fromReport}`);
  }

  const keepIds = report.finalClusters.map((c) => c.keepId).filter(Boolean);
  const dropIds = report.finalClusters.flatMap((c) => (Array.isArray(c.dropIds) ? c.dropIds : []));

  if (dropIds.length === 0) {
    console.error("[from-report] report 中待删列表为空,无需执行,退出。");
    return;
  }

  const keepIdSet = new Set(keepIds);
  const dropIdSet = new Set(dropIds);
  if (dropIdSet.size !== dropIds.length) {
    throw new Error(
      `[校验失败] report 的 dropIds 内部存在重复 id(共 ${dropIds.length} 条,去重后 ${dropIdSet.size} 条),清单可能被污染,中止`,
    );
  }
  const reportTotal = dropIds.length;

  // ---- 校验 2:dropIds 与 keepIds 无交集 ----
  const overlap = [...dropIdSet].filter((id) => keepIdSet.has(id));
  if (overlap.length > 0) {
    throw new Error(
      `[校验失败] 有 ${overlap.length} 条 id 同时出现在 keepIds 与 dropIds 中(如 \`${overlap[0]}\`),清单自相矛盾,中止`,
    );
  }
  console.error(`[校验2/4] dropIds(${dropIdSet.size} 条)与 keepIds(${keepIdSet.size} 条)无交集: 通过`);

  // ---- 定位并读取对应备份文件 ----
  const backupFile =
    cfg.backupFile ??
    (cfg.fromReport.endsWith("-report.json")
      ? `${cfg.fromReport.slice(0, -"-report.json".length)}.json`
      : undefined);
  if (!backupFile) {
    throw new Error(
      "无法从 report 路径自动推导备份文件路径(report 文件名不以 -report.json 结尾),请显式传 --backup-file <path>",
    );
  }
  let backupRaw;
  try {
    backupRaw = await readFile(backupFile, "utf8");
  } catch (err) {
    throw new Error(`[校验失败] 读取备份文件失败(${backupFile}): ${err.message}`);
  }
  let backup;
  try {
    backup = JSON.parse(backupRaw);
  } catch (err) {
    throw new Error(`[校验失败] 备份文件不是合法 JSON(${backupFile}): ${err.message}`);
  }
  if (!Array.isArray(backup.insights)) {
    throw new Error(`[校验失败] 备份文件缺 insights 数组: ${backupFile}`);
  }

  // ---- 校验 3:备份文件的 id 集合与 report 的 dropIds 集合完全相等 ----
  const backupIdSet = new Set(backup.insights.map((x) => x.id));
  const missingFromBackup = [...dropIdSet].filter((id) => !backupIdSet.has(id));
  const extraInBackup = [...backupIdSet].filter((id) => !dropIdSet.has(id));
  if (missingFromBackup.length > 0 || extraInBackup.length > 0) {
    throw new Error(
      `[校验失败] 备份文件(${backupFile})id 集合与 report dropIds 集合不一致:` +
        `备份缺 ${missingFromBackup.length} 条(如 \`${missingFromBackup[0] ?? "-"}\`),` +
        `备份多 ${extraInBackup.length} 条(如 \`${extraInBackup[0] ?? "-"}\`)`,
    );
  }
  console.error(
    `[校验3/4] 备份文件(${backupFile})id 集合与 report dropIds 集合完全相等(${backupIdSet.size} 条): 通过`,
  );

  // ---- 校验 1:report 的 dropIds 在服务端此刻仍然全部存在(防止清单过期) ----
  console.error(`[校验1/4] 拉取服务端当前全量 insights(limit=${cfg.limit})核对 dropIds 是否仍存在...`);
  const current = await fetchAllInsights(cfg.baseUrl, secret, cfg.limit, cfg.fetchTimeoutMs);
  const currentIdSet = new Set(current.map((x) => x.id));
  const missingOnServer = [...dropIdSet].filter((id) => !currentIdSet.has(id));
  if (missingOnServer.length > 0) {
    throw new Error(
      `[校验失败] report 的 dropIds 中有 ${missingOnServer.length} 条在服务端当前已不存在(如 \`${missingOnServer[0]}\`),清单已过期,请重新走 dry-run → 人工过目流程`,
    );
  }
  console.error(
    `[校验1/4] dropIds 全部 ${dropIdSet.size} 条在服务端当前 ${current.length} 条记录中均存在: 通过`,
  );

  // ---- 校验 4:即将删除的条数与 report / 备份记录的数字三方一致 ----
  const reportRecordedTotal = typeof report.totalDrop === "number" ? report.totalDrop : reportTotal;
  if (reportRecordedTotal !== reportTotal || reportRecordedTotal !== backupIdSet.size) {
    throw new Error(
      `[校验失败] 待删条数三方不一致: report.totalDrop=${report.totalDrop ?? "(字段缺失)"} ` +
        `finalClusters汇总=${reportTotal} 备份文件条数=${backupIdSet.size},必须三者相等才可继续`,
    );
  }
  console.error(`[校验4/4] 将要删除的条数: ${reportTotal}(与 report.totalDrop 及备份文件条数一致): 通过`);

  console.error("");
  console.error(
    `[PLAN] 服务端当前=${current.length} 条,计划删除=${reportTotal} 条(来自已过目簇 ${report.finalClusters.length} 个),预期删后总数=${current.length - reportTotal}`,
  );

  if (!cfg.apply) {
    console.error(
      "[from-report] dry-run 模式(未传 --apply),四项校验已全部通过,仅打印计划、不调用删除端点。",
    );
    return;
  }

  // ---- 以下仅在四项校验全过 + 显式 --apply 时执行 ----
  console.error(`[from-report] --apply 已给出,调用 DELETE /agentmemory/insights 批量删除 ${reportTotal} 条...`);
  const idsToDelete = [...dropIdSet];
  const delResult = await applyDelete(cfg.baseUrl, secret, idsToDelete, cfg.fetchTimeoutMs);
  console.error(
    `[from-report] 删除结果: deleted=${delResult.deleted} skipped=${delResult.skipped} total=${delResult.total}`,
  );

  const after = await fetchAllInsights(cfg.baseUrl, secret, cfg.limit, cfg.fetchTimeoutMs);
  console.error(
    `[from-report] 复核: 删前=${current.length} 删后=${after.length} 预期降幅=${reportTotal} 实际降幅=${current.length - after.length}`,
  );
  if (current.length - after.length !== delResult.deleted) {
    console.error(
      `[warn] 实际降幅与删除端点返回的 deleted 数不一致,请人工核查(可能是并发写入或部分失败)`,
    );
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(
      "用法(全量重跑,只能 dry-run): node scripts/ops/insight-dedup.mjs [--limit N] [--threshold F] ...\n" +
        "用法(复用已过目清单执行删除): node scripts/ops/insight-dedup.mjs --from-report <report.json路径> [--backup-file <path>] [--apply]",
    );
    return;
  }
  await loadEnv();

  const cfg = {
    ...DEFAULTS,
    ...Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined)),
  };

  if (cfg.fromReport) {
    await runFromReport(cfg);
    return;
  }

  if (cfg.apply) {
    throw new Error(
      "禁止对刚重新计算出的清单直接 --apply:全量重跑(embedding+LLM)每次都可能因 insight 表" +
        "在两次运行之间发生变化(如 reflect 产生新记录)而算出与人工过目版本不同的清单,直接" +
        "--apply 会删掉一份没人看过的清单,违反 FR-9「必须人工过目」红线。正确流程:先不带" +
        "--apply 跑一次生成 report/备份 → 人工过目 → 改用 `--from-report <report路径> --apply` 执行删除。",
    );
  }

  const secret = process.env.AGENTMEMORY_SECRET;
  console.error(`[1/7] 拉取 KV.insights 全量(limit=${cfg.limit})...`);
  const insights = await fetchAllInsights(cfg.baseUrl, secret, cfg.limit, cfg.fetchTimeoutMs);
  console.error(`[1/7] 实际拉到 ${insights.length} 条`);

  console.error(`[2/7] embedding 粗筛:计算 ${insights.length} 条 content 向量...`);
  const vectors = await embedAll(insights, cfg);
  const sim = buildSimilarityMatrix(vectors);
  const stats = similarityStats(sim);
  console.error(
    `[2/7] 相似度分布: pairs=${stats.pairs} min=${stats.min.toFixed(4)} p50=${stats.p50.toFixed(4)} p90=${stats.p90.toFixed(4)} p99=${stats.p99.toFixed(4)} p99.9=${stats.p999.toFixed(4)} max=${stats.max.toFixed(4)}`,
  );

  console.error(`[3/7] 保守成簇(complete-link, threshold=${cfg.threshold})...`);
  const candidateClusters = buildCandidateClusters(insights, sim, cfg.threshold);
  console.error(`[3/7] 候选簇数: ${candidateClusters.length}`);

  console.error(`[4/7] LLM 逐簇精判(每簇调用两次交叉验证)...`);
  const finalClusters = [];
  const inconsistentClusters = [];
  let clusterSeq = 0;
  for (const idxList of candidateClusters) {
    clusterSeq += 1;
    const members = idxList.map((i) => insights[i]);
    process.stderr.write(`[4/7] 精判候选簇 ${clusterSeq}/${candidateClusters.length}\r`);
    const { consistent, groups, raw } = await judgeClusterConsistent(members, cfg);
    if (!consistent) {
      inconsistentClusters.push({ members, raw });
      continue;
    }
    for (const idGroup of groups) {
      if (idGroup.length < 2) continue;
      const groupMembers = idGroup
        .map((id) => members.find((m) => m.id === id))
        .filter(Boolean);
      if (groupMembers.length < 2) continue;
      let minSim = Infinity;
      let maxSim = -Infinity;
      // 用原始候选簇的两两相似度矩阵中,子组成员对应下标计算 min/max,便于人工过目
      const subIdx = idGroup
        .map((id) => insights.findIndex((x) => x.id === id))
        .filter((i) => i !== -1);
      for (let a = 0; a < subIdx.length; a++) {
        for (let b = a + 1; b < subIdx.length; b++) {
          const s = sim[subIdx[a]][subIdx[b]];
          if (s < minSim) minSim = s;
          if (s > maxSim) maxSim = s;
        }
      }
      const { keep, drop } = pickRetained(groupMembers);
      finalClusters.push({ members: groupMembers, keep, drop, minSim, maxSim });
    }
  }
  console.error("");
  console.error(
    `[4/7] LLM 精判后确认重复簇: ${finalClusters.length}(因两次判定不一致被剔除: ${inconsistentClusters.length})`,
  );

  const dropInsights = finalClusters.flatMap((c) => c.drop);
  const totalDrop = dropInsights.length;
  console.error(`[5/7] 簇内保留策略应用完毕,待删记录: ${totalDrop} 条`);

  console.error(`[6/7] 写 JSON 备份...`);
  const backupFile = await writeBackup(cfg.backupDir, dropInsights, {
    sourceCount: insights.length,
    threshold: cfg.threshold,
    candidateClusterCount: candidateClusters.length,
    finalClusterCount: finalClusters.length,
    inconsistentClusterCount: inconsistentClusters.length,
    embedModel: cfg.embedModel,
    llmModel: cfg.llmModel,
  });
  console.error(`[6/7] 备份已写: ${backupFile}`);

  const reviewMd = buildReviewMarkdown(finalClusters, {
    limit: cfg.limit,
    threshold: cfg.threshold,
    embedModel: cfg.embedModel,
    llmModel: cfg.llmModel,
    candidateClusterCount: candidateClusters.length,
    inconsistentCount: inconsistentClusters.length,
    totalDrop,
    inconsistentClusters,
  });
  const reviewPath =
    cfg.reviewOut ?? path.join(cfg.backupDir, `insight-dedup-${todayStamp()}-review.md`);
  await mkdir(path.dirname(reviewPath), { recursive: true });
  await writeFile(reviewPath, reviewMd, "utf8");
  console.error(`[6/7] 人可读清单已写: ${reviewPath}`);

  const reportPath =
    cfg.reportOut ?? path.join(cfg.backupDir, `insight-dedup-${todayStamp()}-report.json`);
  await writeFile(
    reportPath,
    JSON.stringify(
      {
        params: { limit: cfg.limit, threshold: cfg.threshold, embedModel: cfg.embedModel, llmModel: cfg.llmModel },
        similarityStats: stats,
        candidateClusterCount: candidateClusters.length,
        totalDrop,
        finalClusters: finalClusters.map((c) => ({
          keepId: c.keep.id,
          dropIds: c.drop.map((d) => d.id),
          minSim: c.minSim,
          maxSim: c.maxSim,
        })),
        inconsistentClusters: inconsistentClusters.map((c) => ({
          ids: c.members.map((m) => m.id),
          firstJudgement: c.raw.g1,
          secondJudgement: c.raw.g2,
        })),
      },
      null,
      2,
    ),
    "utf8",
  );
  console.error(`[6/7] 判重过程报告已写: ${reportPath}`);

  console.error("");
  console.error(
    `[SUMMARY] 全量=${insights.length} 候选簇=${candidateClusters.length} 精判后确认重复簇=${finalClusters.length} 待删=${totalDrop} 预期删后总数=${insights.length - totalDrop}`,
  );

  // 走到这里 cfg.apply 恒为 false(main() 顶部已拦截全量重跑路径下的 --apply),
  // 本分支只产出 report/备份/清单供人工过目,从不调用删除端点。
  console.error(
    "[7/7] dry-run 完成,不调用删除端点。人工过目上面的备份与清单后," +
      `改用 \`node scripts/ops/insight-dedup.mjs --from-report ${reportPath} --apply\` 执行删除。`,
  );
}

main().catch((err) => {
  console.error(`[FATAL] ${err.stack ?? err.message}`);
  process.exitCode = 1;
});
