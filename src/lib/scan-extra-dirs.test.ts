import { describe, expect, it } from "vitest";
import { formatScanExtraDirs, parseScanExtraDirs } from "./scan-extra-dirs";

describe("parseScanExtraDirs", () => {
  it("按逗号拆分并去除每项首尾空白", () => {
    expect(parseScanExtraDirs("/mnt/a, /mnt/b ,/mnt/c")).toEqual(["/mnt/a", "/mnt/b", "/mnt/c"]);
  });

  it("空字符串给出空数组", () => {
    expect(parseScanExtraDirs("")).toEqual([]);
  });

  it("只有空白/逗号时给出空数组，不留空字符串项", () => {
    expect(parseScanExtraDirs("  , , ")).toEqual([]);
  });

  it("单个路径不加逗号也能解析", () => {
    expect(parseScanExtraDirs("/mnt/models")).toEqual(["/mnt/models"]);
  });

  it("保留浏览选中的带逗号、引号或尾随空格的实际目录名", () => {
    const dirs = ["/mnt/普通目录", '/mnt/models, "new"', "/mnt/folder "];
    expect(parseScanExtraDirs(formatScanExtraDirs(dirs))).toEqual(dirs);
  });
});
