/**
 * 档案详情页「批量创建配置」的纯逻辑（任务 11）：从合并好的 {@link RepoRow}
 * 列表挑出可批量建配置的候选行、算出预填值，以及把逐条提交的 HTTP 结果
 * 归到「继续」还是「停下」——这些判定 vitest（无 jsdom）测得到，组件只管
 * 渲染与串行发请求。
 */

import { pathForGroup } from "./model-file-picker";
import type { RepoRow } from "./repo-files-view";
import { suggestDisplayName, suggestModelName } from "./repo-path";

/** 一条候选：已下载完整、还没有任何配置引用的量化。mmproj 分组不出现在
 *  候选里——它是别的模型的挂件，不是一个独立可创建的模型 */
export interface BatchCandidate {
  /** React key：量化 + 文件列表拼接，同一次打开弹层内足够稳定唯一 */
  key: string;
  quant: string | null;
  totalSize: number;
  /** 写入 gguf_file 的值（分片组会算成 glob，逻辑与 wizard 深链一致） */
  ggufFile: string;
  /** 预填的模型名 / 显示名，用户在弹层里仍可编辑 */
  name: string;
  displayName: string;
}

/** 未识别量化（quant 为 null）时按空串处理——suggestModelName/
 *  suggestDisplayName 本身就把空串当作「只取仓库基名」处理 */
function quantOrEmpty(quant: string | null): string {
  return quant ?? "";
}

export function batchCreateCandidates(repo: string, rows: readonly RepoRow[]): BatchCandidate[] {
  return rows
    .filter((row) => row.kind === "model" && row.state === "present" && row.models.length === 0)
    .filter((row) => row.localRels.length > 0)
    .map((row) => {
      const quant = quantOrEmpty(row.quant);
      return {
        key: `${quant}:${row.files.join(",")}`,
        quant: row.quant,
        totalSize: row.totalSize,
        ggufFile: pathForGroup([{ path: row.localRels[0]! }]),
        name: suggestModelName(repo, quant),
        displayName: suggestDisplayName(repo, quant),
      };
    });
}

/**
 * 档案内已下载的 mmproj 投影文件路径；没有则 null。「附加 mmproj」勾选框
 * 的默认值与实际写入的 mmproj_file 都来自这里——同一份档案里 mmproj 与
 * 具体选哪个量化无关，是全局唯一的一份挂件。
 */
export function archiveMmprojFile(rows: readonly RepoRow[]): string | null {
  const row = rows.find(
    (r) => r.kind === "mmproj" && r.state === "present" && r.localRels.length > 0,
  );
  return row === undefined ? null : pathForGroup([{ path: row.localRels[0]! }]);
}

export interface CreateModelBody {
  name: string;
  display_name: string;
  namespace: string;
  gguf_file: string;
  mmproj_file?: string;
}

/**
 * 候选行 + 用户编辑值 → POST /api/v1/models 请求体。不传 overrides，让
 * schema 的 `prefault({})` 生效——批量创建统一走全局默认参数（简报明示）。
 */
export function buildCreateModelBody(
  candidate: Pick<BatchCandidate, "ggufFile">,
  input: { name: string; displayName: string; namespace: string; mmprojFile: string | null },
): CreateModelBody {
  const name = input.name.trim();
  const displayName = input.displayName.trim();
  return {
    name,
    display_name: displayName === "" ? name : displayName,
    namespace: input.namespace,
    gguf_file: candidate.ggufFile,
    ...(input.mmprojFile !== null ? { mmproj_file: input.mmprojFile } : {}),
  };
}

export type CreateOutcome = "success" | "conflict" | "stop";

/**
 * HTTP 响应状态 → 批量提交该走哪条分支（主进程补充裁定 2）：201 成功后
 * 继续跑下一条；409 是这一行自己的输入问题（名字冲突，改个名字就能重试），
 * 该行标红但不中断其余行；其余任何失败（400/500，或网络中断传 null）
 * 判定为系统性问题，整批停下——继续跑大概率也是同样的失败。
 */
export function classifyCreateResult(status: number | null): CreateOutcome {
  if (status === 201) return "success";
  if (status === 409) return "conflict";
  return "stop";
}
