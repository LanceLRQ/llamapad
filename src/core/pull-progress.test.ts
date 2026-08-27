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
    expect(first).toBe(100);
    // 新层揭晓 total，分母从 100 涨到 1000，裸算应为 10%
    p.feed({ status: "Downloading", id: "b2", progressDetail: { current: 0, total: 900 } });
    expect(p.snapshot().percent).toBe(first);
  });
  it("真机帧序列：大层后揭晓 total 不再把进度打回（python:3.12-slim 实测量级）", () => {
    // 2026-08-27 真机拉取 python:3.12-slim 观测到 49% → 15%。倒流是否出现取决于
    // 各层揭晓 total 的先后（同一镜像第二次拉取因大层先揭晓就没复现），故此处不
    // 回放某一次原始帧，而用实测的真实层体积 + 复现该顺序的固定序列钉死机制。
    const SMALL = 12_115_893; // 真实层 b79f58b3 体积
    const LARGE = 29_792_658; // 真实层 6310eb16 体积
    const p = createPullProgress();
    p.feed({ status: "Downloading", id: "b79f58b3", progressDetail: { current: 6_291_456, total: SMALL } });
    expect(p.snapshot().percent).toBe(52);
    // 大层此刻才汇报体积：分母 12.1MB → 41.9MB，裸算掉到 18%（实测同量级 34 个百分点）
    p.feed({ status: "Downloading", id: "6310eb16", progressDetail: { current: 1_048_576, total: LARGE } });
    expect(p.snapshot().percent).toBe(52);
    // 卡住期间真实进度追上后照常继续上涨
    p.feed({ status: "Downloading", id: "6310eb16", progressDetail: { current: 20_971_520, total: LARGE } });
    expect(p.snapshot().percent).toBe(65);
  });
  it("单调化不阻碍最终到达 100%", () => {
    const p = createPullProgress();
    p.feed({ status: "Downloading", id: "a1", progressDetail: { current: 50, total: 100 } });
    p.feed({ status: "Downloading", id: "b2", progressDetail: { current: 0, total: 400 } });
    p.feed({ status: "Download complete", id: "a1" });
    p.feed({ status: "Download complete", id: "b2" });
    expect(p.snapshot().percent).toBe(100);
  });
  it("snapshot 可重复调用且结果幂等（内部单调基准不被自身调用推高）", () => {
    const p = createPullProgress();
    p.feed({ status: "Downloading", id: "a1", progressDetail: { current: 30, total: 100 } });
    expect(p.snapshot().percent).toBe(30);
    expect(p.snapshot().percent).toBe(30);
    expect(p.snapshot().percent).toBe(30);
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
