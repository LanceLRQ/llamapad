import { describe, expect, it } from "vitest";

import {
  fromSelectValue,
  joinDirPath,
  pickDefaultFolder,
  resolveInitialFolder,
  ROOT_DIR_OPTION,
  toSelectValue,
  withRootFolder,
} from "./wizard-target-dir";

describe("joinDirPath", () => {
  it("根目录（空串）拼接不产生前导斜杠", () => {
    expect(joinDirPath("", "model.gguf")).toBe("model.gguf");
  });

  it("非空目录正常拼接", () => {
    expect(joinDirPath("main", "model.gguf")).toBe("main/model.gguf");
  });

  it("多级目录同样正常拼接", () => {
    expect(joinDirPath("qwen3.6/70b", "model-*.gguf")).toBe("qwen3.6/70b/model-*.gguf");
  });
});

describe("withRootFolder", () => {
  it("列表不含根目录时补一条空串到最前面", () => {
    expect(withRootFolder(["main", "vision"])).toEqual(["", "main", "vision"]);
  });

  it("列表已含根目录时原样返回（不重复添加）", () => {
    expect(withRootFolder(["", "main"])).toEqual(["", "main"]);
  });

  it("空列表返回只含根目录的单元素数组", () => {
    expect(withRootFolder([])).toEqual([""]);
  });

  it("不修改入参数组", () => {
    const input = ["main"];
    withRootFolder(input);
    expect(input).toEqual(["main"]);
  });
});

describe("pickDefaultFolder", () => {
  it("main 存在时优先选 main，即使不是列表第一项", () => {
    expect(pickDefaultFolder(["lab", "main", "vision"])).toBe("main");
  });

  it("main 不存在时取列表第一项", () => {
    expect(pickDefaultFolder(["lab", "vision"])).toBe("lab");
  });

  it("空列表（全新安装）兜底到根目录", () => {
    expect(pickDefaultFolder([])).toBe("");
  });
});

describe("resolveInitialFolder", () => {
  it("dir 深链命中已知目录时采纳", () => {
    expect(resolveInitialFolder("qwen3.6/70b", ["main", "qwen3.6/70b"])).toBe("qwen3.6/70b");
  });

  it("dir 为空串时直接采纳为根目录，即使根目录当前不在列表里（无散落文件）", () => {
    expect(resolveInitialFolder("", ["main"])).toBe("");
  });

  it("dir 缺失（null）落回默认值", () => {
    expect(resolveInitialFolder(null, ["lab", "main"])).toBe("main");
  });

  it("dir 指向不存在的目录（失效深链）静默落回默认值，不报错", () => {
    expect(resolveInitialFolder("deleted/dir", ["main"])).toBe("main");
  });
});

describe("toSelectValue / fromSelectValue", () => {
  it("根目录换成哨兵，往返一致", () => {
    expect(toSelectValue("")).toBe(ROOT_DIR_OPTION);
    expect(fromSelectValue(ROOT_DIR_OPTION)).toBe("");
  });

  it("非根目录原样透传，往返一致", () => {
    expect(toSelectValue("main")).toBe("main");
    expect(fromSelectValue("main")).toBe("main");
  });
});
