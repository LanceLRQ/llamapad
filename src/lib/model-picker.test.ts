import { describe, expect, it } from "vitest";
import {
  buildModelOptions,
  chatHref,
  FOLLOW_DEFAULT,
  isSelectionGone,
  logsHref,
  logsStreamUrl,
  parseModelParam,
  resolveChatModel,
  showLogsPicker,
  summarizeRunningModels,
  type RunningModelSummary,
} from "./model-picker";

const m = (model: string, ready = true): RunningModelSummary => ({ model, displayName: model.toUpperCase(), ready });

describe("parseModelParam", () => {
  it("缺省、空串、纯空白 → null", () => {
    expect(parseModelParam(undefined)).toBeNull();
    expect(parseModelParam("")).toBeNull();
    expect(parseModelParam("  ")).toBeNull();
  });

  it("首尾空白裁掉", () => {
    expect(parseModelParam(" qwen3-8b ")).toBe("qwen3-8b");
  });

  it("重复参数取第一个", () => {
    expect(parseModelParam(["a", "b"])).toBe("a");
  });
});

describe("resolveChatModel", () => {
  const models = [m("a"), m("b"), m("c")];

  it("请求的模型在跑 → 选它，不算回落", () => {
    expect(resolveChatModel(models, "a", "b")).toEqual({ model: "b", fellBackFrom: null });
  });

  it("没请求 → 默认模型，不算回落", () => {
    expect(resolveChatModel(models, "c", null)).toEqual({ model: "c", fellBackFrom: null });
  });

  it("请求的模型没在跑 → 默认模型，并记下回落来源", () => {
    expect(resolveChatModel(models, "c", "gone")).toEqual({ model: "c", fellBackFrom: "gone" });
  });

  it("默认模型为空或不在列表（状态刚变化的窗口）→ 取第一个在跑的", () => {
    expect(resolveChatModel(models, null, null)).toEqual({ model: "a", fellBackFrom: null });
    expect(resolveChatModel(models, "stale", null)).toEqual({ model: "a", fellBackFrom: null });
  });

  it("没有模型在跑 → null；即使请求过某个模型也不报回落（页面显示引导卡）", () => {
    expect(resolveChatModel([], null, "gone")).toEqual({ model: null, fellBackFrom: null });
  });
});

describe("buildModelOptions", () => {
  it("默认模型排第一，其余保持启动顺序；带展示名、默认与加载中标记", () => {
    const options = buildModelOptions([m("a"), m("b", false), m("c")], "b", "a");
    expect(options).toEqual([
      { value: "b", label: "B", isDefault: true, loading: true, stopped: false },
      { value: "a", label: "A", isDefault: false, loading: false, stopped: false },
      { value: "c", label: "C", isDefault: false, loading: false, stopped: false },
    ]);
  });

  it("选中的模型不在运行列表 → 末尾补一项已停止，下拉框不会显示空白", () => {
    const options = buildModelOptions([m("a")], "a", "gone");
    expect(options.at(-1)).toEqual({ value: "gone", label: "gone", isDefault: false, loading: false, stopped: true });
    expect(options).toHaveLength(2);
  });

  it("选中的是「跟随默认模型」或没选 → 不补已停止项", () => {
    expect(buildModelOptions([m("a")], "a", FOLLOW_DEFAULT)).toHaveLength(1);
    expect(buildModelOptions([m("a")], "a", null)).toHaveLength(1);
  });
});

describe("isSelectionGone", () => {
  it("选中的模型不在列表 → true；在列表或没选 → false", () => {
    expect(isSelectionGone("b", [m("a")])).toBe(true);
    expect(isSelectionGone("a", [m("a")])).toBe(false);
    expect(isSelectionGone(null, [m("a")])).toBe(false);
  });

  it("全部停止时选中的模型也算消失", () => {
    expect(isSelectionGone("a", [])).toBe(true);
  });
});

describe("showLogsPicker", () => {
  it("多个模型在跑，或已经固定了某个模型（哪怕它停了）→ 显示", () => {
    expect(showLogsPicker(2, null)).toBe(true);
    expect(showLogsPicker(0, "a")).toBe(true);
  });

  it("零或一个模型且跟随默认 → 不显示", () => {
    expect(showLogsPicker(0, null)).toBe(false);
    expect(showLogsPicker(1, null)).toBe(false);
  });
});

describe("summarizeRunningModels", () => {
  it("只保留下拉框需要的三个字段，不把容器名、端口等多余字段序列化给客户端", () => {
    const full = [{ model: "a", displayName: "A", ready: true, container: "llama-server", hostPort: 18080 }];
    expect(summarizeRunningModels(full)).toEqual([{ model: "a", displayName: "A", ready: true }]);
  });
});

describe("地址拼接", () => {
  it("logsStreamUrl：跟随默认不带参数；指定模型做 URL 编码", () => {
    expect(logsStreamUrl(null)).toBe("/api/v1/logs/stream");
    expect(logsStreamUrl("a b")).toBe("/api/v1/logs/stream?model=a%20b");
  });

  it("chatHref：带 model 参数", () => {
    expect(chatHref("qwen3-8b")).toBe("/chat?model=qwen3-8b");
  });

  it("logsHref：固定在容器日志组；跟随默认时不带 model", () => {
    expect(logsHref(null)).toBe("/logs?tab=logs");
    expect(logsHref("qwen3-8b")).toBe("/logs?tab=logs&model=qwen3-8b");
  });
});
