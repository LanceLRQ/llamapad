/**
 * 文件移动 / 改名的纯逻辑（T2，设计 `docs/_internal/features/
 * 2026-08-28-文件管理与镜像管理-design.md` §2.3/§2.4）。
 *
 * 不含任何 IO：目录扫描、DB 查询、实际 renameSync 均由调用方
 * （`server/filesApi.ts` 的 planFileMove / planFileRename）完成，本模块只对
 * "已知的文件名集合 / 引用值字符串"做字符串层面的推导，便于单测。
 *
 * 覆盖三件事（对应任务范围 A.1/A.2/A.3）：
 * - 分片组整组升级（shardGroupMembers）：选中任一分片自动升级为整组
 * - 引用值重写：移动只换命名空间段（rewriteRefNamespace），改名只换文件名
 *   前缀（rewriteRefBasename）——引用值可能是精确路径也可能是 glob，两个函数
 *   对两种形态都要给出正确结果
 * - 改名分支：单文件可改整个文件名，分片组只能改前缀、序号段系统保留
 *   （renameShardGroupFiles / planRename）
 */

import { shardGroup } from "@/core/files";

/**
 * 分片组整组升级（决策 7）：selected 命中分片命名时，从 namesInDir（同目录
 * 全部文件名，含 selected 自身）里筛出前缀与 total 都相同的成员，按名称
 * 排序返回；非分片命名（shardGroup 为 null）原样返回 [selected]。
 *
 * 理由见设计 §1.4：gguf_file 对分片组存的是 glob，只挪/改一个分片会让 glob
 * 在新位置只匹配到孤立的一片，llama.cpp 找不到同组其余片、启动失败。
 */
export function shardGroupMembers(namesInDir: readonly string[], selected: string): string[] {
  const group = shardGroup(selected);
  if (group === null) return [selected];
  return namesInDir
    .filter((name) => {
      const g = shardGroup(name);
      return g !== null && g.prefix === group.prefix && g.total === group.total;
    })
    .sort();
}

/**
 * 移动场景的引用值重写：把配置路径值（精确路径或 glob）的命名空间段（首段）
 * 换成 toNamespace，文件名部分（含通配符）原样保留。
 *
 * 与 `namespaces.ts` 内部的 `retarget` 是同款逻辑，但那是未导出的闭包函数——
 * 三行字符串操作，各自维护的重复成本低于为复用它而跨模块耦合的成本。
 */
export function rewriteRefNamespace(value: string, toNamespace: string): string {
  const slash = value.indexOf("/");
  return slash === -1 ? `${toNamespace}/${value}` : `${toNamespace}/${value.slice(slash + 1)}`;
}

/**
 * 改名场景的引用值重写：把 value 的 basename 前缀部分替换掉，目录段与前缀
 * 之后的剩余部分（含 glob 通配尾缀）原样保留。同一个函数吃两种引用形态：
 * - 精确路径：oldPrefix 传完整旧文件名，剩余部分为空串，等价于整串替换
 * - glob（分片组前缀改名）：oldPrefix 传分片组前缀，剩余部分是 `-*.gguf`
 *   这类通配尾缀，替换后新 glob 仍能匹配到改名后的全部分片
 *
 * basename 不以 oldPrefix 开头时原样返回（防御性兜底，调用方应保证匹配）。
 */
export function rewriteRefBasename(value: string, oldPrefix: string, newPrefix: string): string {
  const slash = value.lastIndexOf("/");
  const dir = slash === -1 ? "" : value.slice(0, slash + 1);
  const base = slash === -1 ? value : value.slice(slash + 1);
  if (!base.startsWith(oldPrefix)) return value;
  return `${dir}${newPrefix}${base.slice(oldPrefix.length)}`;
}

/** 组内一个物理文件的改名映射 */
export interface ShardRename {
  oldName: string;
  newName: string;
}

/**
 * 分片组改名（决策 7）：只改前缀，序号段（含可能夹带的量化后缀，如
 * `-00001-of-00005.Q8_0.gguf`）原样保留——照抄各成员原名去掉前缀后的剩余部分。
 * groupNames 应为 shardGroupMembers 展开好的组内全部文件名。
 *
 * 组内出现不满足分片命名的异常项（理论不可达，shardGroupMembers 已按
 * shardGroup 过滤）时原样不改名，不让一条坏数据搞崩整组改名。
 */
export function renameShardGroupFiles(
  groupNames: readonly string[],
  newPrefix: string,
): ShardRename[] {
  return groupNames.map((name) => {
    const group = shardGroup(name);
    if (group === null) return { oldName: name, newName: name };
    return { oldName: name, newName: `${newPrefix}${name.slice(group.prefix.length)}` };
  });
}

/** 改名计划：物理文件改名映射 + 喂给 rewriteRefBasename 的替换对 */
export interface RenamePlan {
  files: ShardRename[];
  refRewrite: { oldPrefix: string; newPrefix: string };
}

/**
 * 改名分支判定（决策 7）：
 * - 单文件（shardGroup(selected) === null）：newValue 是完整新文件名（含 .gguf 后缀）
 * - 分片组：newValue 是新前缀（不含序号段），序号段照抄各成员原名
 *
 * groupNames 应为 shardGroupMembers(namesInDir, selected) 展开好的组内全部
 * 文件名（单文件时长度为 1，等于 [selected]）。
 */
export function planRename(
  groupNames: readonly string[],
  selected: string,
  newValue: string,
): RenamePlan {
  const group = shardGroup(selected);
  if (group === null) {
    return {
      files: [{ oldName: selected, newName: newValue }],
      refRewrite: { oldPrefix: selected, newPrefix: newValue },
    };
  }
  return {
    files: renameShardGroupFiles(groupNames, newValue),
    refRewrite: { oldPrefix: group.prefix, newPrefix: newValue },
  };
}
