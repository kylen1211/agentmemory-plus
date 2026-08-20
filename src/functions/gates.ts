import type { Checkpoint, Sentinel } from "../types.js";

/**
 * `gated_by` 边的 `targetActionId` 是隐式多态外键:创建时可能写入 Checkpoint.id
 * (checkpoints.ts:mem::checkpoint-create)或 Sentinel.id(sentinels.ts:mem::sentinel-create),
 * 类型系统里两者都只是 string,调用点必须自己判断该去哪张表查。
 *
 * 曾经三处各自实现过一份判断逻辑(frontier.ts 的阻塞面计算、checkpoints.ts 的
 * mem::checkpoint-resolve 解闸、sentinels.ts 的 unblockLinkedActions),其中前两处只建了
 * checkpointMap,完全没有 sentinel 分支——被 sentinel 挂闸的 action 在 sentinel
 * resolved/expired 后仍会被判定为"未过闸"甚至永久卡在 blocked 状态(2026-08-20 修复)。
 * 现在统一收敛到这里,任何需要判定"某个 gated_by 目标是否已放行"的地方都必须调用
 * resolveGate,不要再各自 new Map 判断。
 */
export interface GateResolution {
  kind: "checkpoint" | "sentinel";
  id: string;
  name: string;
  passed: boolean;
}

export function buildCheckpointMap(
  checkpoints: Checkpoint[],
): Map<string, Checkpoint> {
  return new Map(checkpoints.map((c) => [c.id, c]));
}

export function buildSentinelMap(sentinels: Sentinel[]): Map<string, Sentinel> {
  return new Map(sentinels.map((s) => [s.id, s]));
}

/**
 * 判定单个 gate 是否已放行。
 * - checkpoint:仅 status === "passed" 视为放行(failed/expired/pending 均继续阻塞——
 *   checkpoint 是成败判定型闸,失败或过期不应放行下游)。
 * - sentinel:status === "triggered"(等到了目标事件)或 "expired"(等待窗口结束)均视为
 *   放行;"watching" 是唯一未放行状态。sentinel 是"等事件或超时"型闸而非成败判定型闸,
 *   过期只代表不再等待,不应让下游 action 永久卡死(这正是本次要修的 bug 的效果);
 *   "cancelled" 维持不放行,与改造前 sentinels.ts 内原有的隐式约定一致,未在本次判据
 *   范围内改变。
 * - gate 目标在 checkpoint 与 sentinel 两张表里都找不到(悬空引用/数据损坏):视为未放行
 *   (fail-closed)。改造前 frontier.ts 对"查不到"的处理是隐式放行(Map.get 返回
 *   undefined 时的 `cp && ...` 短路即为 false,不计入 blockers)——这其实就是 sentinel
 *   漏判 bug 的成因本身,不是刻意设计,这里改为显式 fail-closed 更安全,不吞掉损坏引用。
 */
export function resolveGate(
  targetId: string,
  checkpointMap: Map<string, Checkpoint>,
  sentinelMap: Map<string, Sentinel>,
): GateResolution | null {
  const cp = checkpointMap.get(targetId);
  if (cp) {
    return {
      kind: "checkpoint",
      id: cp.id,
      name: cp.name,
      passed: cp.status === "passed",
    };
  }

  const sn = sentinelMap.get(targetId);
  if (sn) {
    return {
      kind: "sentinel",
      id: sn.id,
      name: sn.name,
      passed: sn.status === "triggered" || sn.status === "expired",
    };
  }

  return null;
}
