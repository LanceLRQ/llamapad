import type Database from "better-sqlite3";
import { join } from "node:path";

import { resolveMtpKind } from "@/lib/mtp-kind";
import type { PickerFile } from "@/lib/model-file-picker";
import { getFilesTree } from "./filesApi";
import { getGgufMeta } from "./ggufMeta";

/**
 * 文件选择弹层候选项的服务端装配（任务 2，编辑页/新建向导/克隆页/设置页
 * 导入卡四处共用同一套装配逻辑，抽成一个函数避免各自实现漂移）：
 * getFilesTree 的扁平结果逐个补上 mtpKind，交给纯函数 buildPickerItems 归并。
 *
 * 只对 `.gguf` 文件调用 getGgufMeta——非 GGUF 文件的失败结果不落缓存
 * （open → 读窗口 → parseGguf 因 magic 不匹配抛错 → 提前 return，见
 * ggufMeta.ts 头注释），不加这道前置过滤的话，每次打开这几个页面，目录里
 * 每一个 README/config.json 等附属文件都会被重新 open 一次，是一条永远不会
 * 命中缓存的隐性 IO。判断口径与 api/v1/repos/[id]/files/route.ts 同款注释、
 * core/quant.ts「仅 .gguf 进入分组」同一条既有约定，不重新发明。
 *
 * 串行 await：getGgufMeta 命中缓存（path+size+mtime 匹配）后是纯读表，
 * 与 files/route.ts 同一条「不必并发」的理由。
 */
export async function buildPickerFiles(db: Database.Database, modelsRoot: string): Promise<PickerFile[]> {
  const flat = getFilesTree(db, modelsRoot).flatMap((ns) => ns.files);
  const result: PickerFile[] = [];
  for (const f of flat) {
    if (!f.rel.toLowerCase().endsWith(".gguf")) {
      result.push({ ...f, mtpKind: "none" });
      continue;
    }
    const meta = await getGgufMeta(db, join(modelsRoot, f.rel));
    result.push({ ...f, mtpKind: meta === null ? "none" : resolveMtpKind(meta) });
  }
  return result;
}
