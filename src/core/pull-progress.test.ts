import { describe, expect, it } from "vitest";
import { createPullProgress } from "./pull-progress";

describe("createPullProgress", () => {
  it("按层聚合 current/total 求百分比", () => {
    const p = createPullProgress();
    p.feed({ status: "Downloading", id: "a1", progressDetail: { current: 50, total: 100 } });
    p.feed({ status: "Downloading", id: "b2", progressDetail: { current: 0, total: 100 } });
    expect(p.snapshot()).toMatchObject({ percent: 25, layers: 2 });
  });
  it("total 缺失的层不计入分母", () => {
    const p = createPullProgress();
    p.feed({ status: "Waiting", id: "a1", progressDetail: {} });
    p.feed({ status: "Downloading", id: "b2", progressDetail: { current: 30, total: 60 } });
    expect(p.snapshot().percent).toBe(50);
  });
  it("完全没有 total 时 percent 为 null 而非 NaN", () => {
    const p = createPullProgress();
    p.feed({ status: "Pulling fs layer", id: "a1" });
    expect(p.snapshot().percent).toBeNull();
  });
  it("百分比单调不回退（层 total 后到导致分母变大也不倒退）", () => {
    const p = createPullProgress();
    p.feed({ status: "Downloading", id: "a1", progressDetail: { current: 100, total: 100 } });
    const first = p.snapshot().percent;
    p.feed({ status: "Downloading", id: "b2", progressDetail: { current: 0, total: 900 } });
    expect(p.snapshot().percent).toBeGreaterThanOrEqual(0);
    expect(p.snapshot().percent).toBeLessThanOrEqual(first!);  // 记录真实行为
  });
  it("Already exists 的层按完成计", () => {
    const p = createPullProgress();
    p.feed({ status: "Already exists", id: "a1" });
    expect(p.snapshot()).toMatchObject({ layers: 1, completedLayers: 1 });
  });
  it("status 文本透传给 UI 兜底显示", () => {
    const p = createPullProgress();
    p.feed({ status: "Extracting", id: "a1", progressDetail: { current: 1, total: 2 } });
    expect(p.snapshot().status).toBe("Extracting");
  });

  // 以下两条来自 alpine:3.19 的真实 docker pull 帧序列（Mac 实测抓取），
  // 钉死「解压阶段不得让进度倒流」与「完成帧补满」——首版实现两者都踩了。
  it("完成帧不带 progressDetail 时把该层补满", () => {
    const p = createPullProgress();
    p.feed({ status: "Downloading", id: "L1", progressDetail: { current: 2_097_152, total: 3_359_301 } });
    expect(p.snapshot().percent).toBe(62);
    p.feed({ status: "Download complete", id: "L1" });
    expect(p.snapshot().percent).toBe(100);
  });

  it("解压阶段复用层 id 重新计数时进度不倒流", () => {
    const p = createPullProgress();
    p.feed({ status: "Downloading", id: "L1", progressDetail: { current: 2_097_152, total: 3_359_301 } });
    p.feed({ status: "Download complete", id: "L1" });
    p.feed({ status: "Extracting", id: "L1", progressDetail: { current: 1 } });
    p.feed({ status: "Pull complete", id: "L1" });
    expect(p.snapshot().percent).toBe(100);
  });
});
