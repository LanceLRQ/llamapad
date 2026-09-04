import { SHA256_PATTERN } from "./acquire-match";

/**
 * 本地文件与远端声明的版本关系（规格 §4）。
 *
 * 「配对」（谁对应谁）与「判定」（配上的这一对是什么关系）是两件事：配对在
 * acquire-match.matchLocalCandidate 里按 basename/oid 做，size 只在这里参与判定。
 * 旧实现把两者糅在一起（size 不等就当没配上），于是「本机有同名文件但版本不同」
 * 这件事在界面上完全沉默——那正是本设计要治的病。
 */
export type DriftState = "same" | "different" | "unknown";

/** 合法的内容 sha256 才算证据；格式不合法一律视同没有 */
function usableOid(oid: string | null | undefined): string | null {
  return typeof oid === "string" && SHA256_PATTERN.test(oid) ? oid : null;
}

export function compareToRemote(
  local: { size: number; oid: string | null },
  remote: { size: number; oid?: string },
): DriftState {
  // 远端 size 不可用时整条判定失去基准：不能因为「本地 100 ≠ 远端 0」就说版本不同，
  // 那只说明清单本身没给出大小。与 matchLocalCandidate 对 remote.size <= 0 的既有
  // 保守取向一致
  if (remote.size <= 0) return "unknown";

  // size 不等时内容必然不同，无论 oid 如何
  if (local.size !== remote.size) return "different";

  const localOid = usableOid(local.oid);
  const remoteOid = usableOid(remote.oid);
  if (localOid !== null && remoteOid !== null) {
    return localOid === remoteOid ? "same" : "different";
  }

  // size 相等但缺 oid 时，只能说「很可能相同」，证实不了
  return "unknown";
}
