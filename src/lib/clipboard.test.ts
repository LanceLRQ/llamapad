import { afterEach, describe, expect, it, vi } from "vitest";
import { copyTextToClipboard } from "./clipboard";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("copyTextToClipboard（HTTP 局域网回退）", () => {
  it("Async Clipboard API 可用时走 writeText 并返回 true", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    await expect(copyTextToClipboard("lp_abc")).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith("lp_abc");
  });

  it("writeText 拒绝（Firefox HTTP 形态）时回退 execCommand，成功则 true", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("not allowed"));
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    const textarea = {
      value: "",
      setAttribute: vi.fn(),
      style: {} as Record<string, string>,
      focus: vi.fn(),
      select: vi.fn(),
      remove: vi.fn(),
    };
    const execCommand = vi.fn().mockReturnValue(true);
    vi.stubGlobal("document", {
      createElement: () => textarea,
      body: { appendChild: vi.fn() },
      execCommand,
    });

    await expect(copyTextToClipboard("lp_abc")).resolves.toBe(true);
    expect(textarea.value).toBe("lp_abc"); // 回退路径携带完整文本
    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(textarea.remove).toHaveBeenCalled(); // 用后即删，不留 DOM 残留
  });

  it("navigator.clipboard 为 undefined（Chrome/Safari HTTP 形态）且无 document 回退时返回 false", async () => {
    vi.stubGlobal("navigator", {});
    await expect(copyTextToClipboard("lp_abc")).resolves.toBe(false);
  });

  it("writeText 拒绝且无 document 回退时返回 false 而非抛异常", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("not allowed"));
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    await expect(copyTextToClipboard("lp_abc")).resolves.toBe(false);
  });
});
