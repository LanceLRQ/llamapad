import { describe, expect, it } from "vitest";
import { findPortPeers, formatPeerNames } from "./port-peers";

const peers = [
  { name: "a", hostPort: 18080 },
  { name: "b", hostPort: 18080 },
  { name: "c", hostPort: 19000 },
];

describe("findPortPeers", () => {
  it("返回端口相同的其他模型名，排除自己", () => {
    expect(findPortPeers(18080, "a", peers)).toEqual(["b"]);
  });

  it("新建/克隆场景 selfName 为 null → 全部同端口模型", () => {
    expect(findPortPeers(18080, null, peers)).toEqual(["a", "b"]);
  });

  it("端口为 null（草稿非法）或无人相同 → 空数组", () => {
    expect(findPortPeers(null, null, peers)).toEqual([]);
    expect(findPortPeers(20000, null, peers)).toEqual([]);
  });
});

describe("formatPeerNames", () => {
  it("不超过 3 个 → 用调用方给的分隔符连接，more 为 0", () => {
    expect(formatPeerNames(["a", "b"], "、")).toEqual({ names: "a、b", more: 0 });
    expect(formatPeerNames(["a", "b"], ", ")).toEqual({ names: "a, b", more: 0 });
  });

  it("超过 3 个 → 只列前 3 个，more 为剩余数量", () => {
    expect(formatPeerNames(["a", "b", "c", "d", "e"], "、")).toEqual({ names: "a、b、c", more: 2 });
  });
});
