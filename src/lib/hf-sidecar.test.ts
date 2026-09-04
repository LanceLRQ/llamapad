import { describe, expect, it } from "vitest";
import { parseHfSidecar } from "./hf-sidecar";

const OID = "cbb841a9ee0636b2ec172f5bb8df2ea8dfeb01e90fe7c6126581d662a0b4e43e";
const GOOD = `f1bfb127c64f7072bdd2cad55f258b9c8b2910fe\n${OID}\n1786945907.547407\n`;

describe("parseHfSidecar", () => {
  it("标准三行边车 → 取出第二行的 oid", () => {
    expect(parseHfSidecar(GOOD, { fileMtimeMs: 1000, sidecarMtimeMs: 2000 })).toBe(OID);
  });

  it("行数不是 3 → null", () => {
    expect(parseHfSidecar(`${OID}\n`, { fileMtimeMs: 1000, sidecarMtimeMs: 2000 })).toBeNull();
    expect(
      parseHfSidecar(`a\n${OID}\nb\nc\n`, { fileMtimeMs: 1000, sidecarMtimeMs: 2000 }),
    ).toBeNull();
  });

  it("第二行不是 64 位小写十六进制 → null", () => {
    const bad = GOOD.replace(OID, OID.toUpperCase());
    expect(parseHfSidecar(bad, { fileMtimeMs: 1000, sidecarMtimeMs: 2000 })).toBeNull();
    expect(
      parseHfSidecar(GOOD.replace(OID, "deadbeef"), { fileMtimeMs: 1000, sidecarMtimeMs: 2000 }),
    ).toBeNull();
  });

  it("文件 mtime 晚于边车 → null（下载完之后文件被改过，边车已不代表当前内容）", () => {
    expect(parseHfSidecar(GOOD, { fileMtimeMs: 3000, sidecarMtimeMs: 2000 })).toBeNull();
  });

  it("文件 mtime 与边车相等 → 可信（同一次下载写入，允许同毫秒）", () => {
    expect(parseHfSidecar(GOOD, { fileMtimeMs: 2000, sidecarMtimeMs: 2000 })).toBe(OID);
  });

  it("空串 → null", () => {
    expect(parseHfSidecar("", { fileMtimeMs: 1000, sidecarMtimeMs: 2000 })).toBeNull();
  });

  it("CRLF 换行的三行边车 → 规范化后仍能取出 oid", () => {
    const crlf = GOOD.replace(/\n/g, "\r\n");
    expect(parseHfSidecar(crlf, { fileMtimeMs: 1000, sidecarMtimeMs: 2000 })).toBe(OID);
  });
});
