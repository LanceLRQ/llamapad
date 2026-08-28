/**
 * 写模型时的错误 → HTTP 响应映射（规格 §6.1）。
 *
 * 为什么是独立模块而不是写在 route 里：全库没有 route handler 测试基建
 * （src/app/api 下零测试文件），既有做法一贯是「route 是薄壳、逻辑在
 * src/server/ 模块」。放这里才测得到。
 *
 * 重名用 409 而非 400：主键冲突是资源状态冲突，不是请求体格式错误
 * （请求体本身完全合法）。issues 沿用既有的 `{ path, message }` 结构，
 * 前端 PATH_TO_FIELD 已能按 path 把错误挂到对应输入框上。
 */

/** 模型 id（主键）已被占用 */
export class ModelNameConflictError extends Error {
  constructor(readonly modelName: string) {
    super(`模型 id 已存在: ${modelName}`);
    // 继承内建类后修正原型链（TS 编译到 ES5 目标时 instanceof 会失效）
    Object.setPrototypeOf(this, ModelNameConflictError.prototype);
  }
}

export interface ModelWriteErrorResponse {
  status: number;
  body: { error: string; issues?: { path: string; message: string }[] };
}

/** better-sqlite3 主键冲突的错误码（重名时 insert 抛出） */
const SQLITE_PRIMARY_KEY_CONFLICT = "SQLITE_CONSTRAINT_PRIMARYKEY";

/** 判定 better-sqlite3 的主键冲突（repo 层用它把裸 SqliteError 收敛成业务错误） */
export function isPrimaryKeyConflict(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === SQLITE_PRIMARY_KEY_CONFLICT
  );
}

export function modelWriteErrorResponse(error: unknown): ModelWriteErrorResponse {
  if (error instanceof ModelNameConflictError) {
    return {
      status: 409,
      body: {
        error: "duplicate_name",
        issues: [{ path: "name", message: error.message }],
      },
    };
  }
  return { status: 400, body: { error: String(error instanceof Error ? error.message : error) } };
}
