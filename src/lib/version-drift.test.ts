import { describe, expect, it } from "vitest";
import { compareToRemote } from "./version-drift";

const OID_A = "a".repeat(64);
const OID_B = "b".repeat(64);

describe("compareToRemote", () => {
  it("两边 oid 都有且相等 → same", () => {
    expect(compareToRemote({ size: 100, oid: OID_A }, { size: 100, oid: OID_A })).toBe("same");
  });

  it("两边 oid 都有且不等 → different（哪怕 size 相同）", () => {
    expect(compareToRemote({ size: 100, oid: OID_A }, { size: 100, oid: OID_B })).toBe("different");
  });

  it("size 不等 → different（不必看 oid，内容必然不同）", () => {
    expect(compareToRemote({ size: 100, oid: null }, { size: 200 })).toBe("different");
    expect(compareToRemote({ size: 100, oid: OID_A }, { size: 200, oid: OID_A })).toBe("different");
  });

  it("size 相等但本地缺 oid → unknown", () => {
    expect(compareToRemote({ size: 100, oid: null }, { size: 100, oid: OID_A })).toBe("unknown");
  });

  it("size 相等但远端缺 oid → unknown", () => {
    expect(compareToRemote({ size: 100, oid: OID_A }, { size: 100 })).toBe("unknown");
  });

  it("oid 格式非法视同没有 → unknown", () => {
    expect(compareToRemote({ size: 100, oid: "NOTAHASH" }, { size: 100, oid: OID_A })).toBe("unknown");
    expect(compareToRemote({ size: 100, oid: OID_A }, { size: 100, oid: OID_A.toUpperCase() })).toBe(
      "unknown",
    );
  });

  it("远端 size 为 0 或负数 → unknown（清单本身不可信，不据此判 different）", () => {
    expect(compareToRemote({ size: 100, oid: OID_A }, { size: 0, oid: OID_B })).toBe("unknown");
  });
});
