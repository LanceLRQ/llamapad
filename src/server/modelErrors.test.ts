import { describe, expect, it } from "vitest";
import { ModelNameConflictError, modelWriteErrorResponse } from "./modelErrors";

/**
 * 写模型时的错误 → HTTP 响应的映射。抽成纯函数是因为全库没有 route handler
 * 测试基建（src/app/api/** 下零测试文件），route 保持薄壳、逻辑在此可测。
 */

describe("modelWriteErrorResponse", () => {
  it("重名 → 409 + duplicate_name + 定位到 name 字段", () => {
    const res = modelWriteErrorResponse(new ModelNameConflictError("qwen3-8b"));
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("duplicate_name");
    expect(res.body.issues).toEqual([{ path: "name", message: "模型 id 已存在: qwen3-8b" }]);
  });

  it("其他业务错误（命名空间不存在等）→ 400 + 原始 message，无 issues", () => {
    const res = modelWriteErrorResponse(new Error("命名空间不存在: nope"));
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "命名空间不存在: nope" });
  });

  it("非 Error 抛出物也能收敛成 400，不泄漏 undefined", () => {
    const res = modelWriteErrorResponse("boom");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("boom");
  });
});

describe("ModelNameConflictError", () => {
  it("携带冲突的模型 id，且 instanceof 可判（跨 bundle 前提是同一模块实例）", () => {
    const err = new ModelNameConflictError("dup-id");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ModelNameConflictError);
    expect(err.modelName).toBe("dup-id");
  });
});
