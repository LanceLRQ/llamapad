import { describe, expect, it } from "vitest";

import { buildApiBaseUrl, buildCurlCommand } from "./curl-snippet";

describe("curl-snippet（UX P0 Task 6）", () => {
  it("base URL：hostname + 模型端口", () => {
    expect(buildApiBaseUrl("192.168.1.10", 18080)).toBe("http://192.168.1.10:18080");
    expect(buildApiBaseUrl("localhost", 8080)).toBe("http://localhost:8080");
  });

  it("curl 示例：OpenAI 兼容端点 + JSON 体，shell 续行合法", () => {
    const cmd = buildCurlCommand("10.0.0.2", 18080);
    const lines = cmd.split("\n");
    // 除最后一行外每行以续行符结尾（粘贴即用）
    expect(lines.slice(0, -1).every((line) => line.endsWith("\\"))).toBe(true);
    expect(lines[0]).toBe("curl http://10.0.0.2:18080/v1/chat/completions \\");
    expect(cmd).toContain('"Content-Type: application/json"');
    expect(cmd).toContain('"messages"');
  });
});
