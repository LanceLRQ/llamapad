import { describe, expect, it } from "vitest";
import { createPullProgress } from "./pull-progress";

describe("createPullProgress", () => {
  it("按层聚合 current/total 求百分比", () => {
    const p = createPullProgress();
    p.feed({ status: "Downloading", id: "a1", progressDetail: { current: 50, total: 100 } });
    p.feed({ status: "Downloading", id: "b2", progressDetail: { current: 0, total: 100 } });
    expect(p.snapshot()).toMatchObject({ percent: 25, layers: 2 });
  });
  it("total 缺失的层按已知层均值估进分母，不再直接排除在分母外", () => {
    // 旧实现里 total 缺失的层完全不计入分母：a1 没有 total 就被当成"不存在"，
    // 分母只剩 b2 的 60，算出 30/60=50%。这个前提正是缺陷②的根因——真机里
    // 一堆从未汇报体积的层如果被当成 0 分母，极小的已知层一下完就把总进度
    // 顶到 100%。新规则把 a1 按已知层均值（这里只有 b2 一个已知层，均值
    // 就是 60）估进分母：a1 未完成贡献 (0,60)，b2 贡献 (30,60)，结果是
    // 30/120=25%，比原先更保守，但不会谎报 100%。
    const p = createPullProgress();
    p.feed({ status: "Waiting", id: "a1", progressDetail: {} });
    p.feed({ status: "Downloading", id: "b2", progressDetail: { current: 30, total: 60 } });
    expect(p.snapshot().percent).toBe(25);
  });
  it("完全没有 total 时 percent 为 null 而非 NaN", () => {
    const p = createPullProgress();
    p.feed({ status: "Pulling fs layer", id: "a1" });
    expect(p.snapshot().percent).toBeNull();
  });
  it("百分比单调不回退（层 total 后到导致分母变大也不倒退）", () => {
    const p = createPullProgress();
    p.feed({ status: "Downloading", id: "a1", progressDetail: { current: 100, total: 100 } });
    // a1 只是 current 追平了 total，但状态帧仍是 "Downloading"、没收到
    // 完成状态帧，按终态封顶规则只能报 99（不是 100）
    const first = p.snapshot().percent;
    expect(first).toBe(99);
    // 新层揭晓 total，分母从 100 涨到 1000，裸算应为 10%；这里验证的是
    // 单调不回退本身，不受上面 99 的具体数值影响
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

  // 以下几条对应 U14 缺陷②③：2026-08-29 真机拉取 mysql:8.4（层 id 与体积
  // 都是那次 docker.sock 原始帧里的实测值）与 llama.cpp:full-cuda 暴露的两个问题——
  // 镜像 tag 帧被当成层计入分母、以及进度条极早顶到 100% 后卡死整个拉取。
  it("Pulling from 镜像 tag 帧的 id 是 tag 版本号不是层 id，不计入分层聚合", () => {
    const p = createPullProgress();
    p.feed({ status: "Pulling from library/mysql", id: "8.4" });
    // lastStatus 仍照常透传给 UI 兜底显示，只是不参与分层聚合
    expect(p.snapshot()).toMatchObject({ layers: 0, completedLayers: 0, status: "Pulling from library/mysql" });
  });

  it("真机帧序列：mysql:8.4 实测量级——tag 不计入分母，唯一揭晓 total 的小层不会把总进度顶到 100%", () => {
    // 12 个真实层里只有 6 个曾汇报过 total，且揭晓顺序分散在整条 306 帧的拉取
    // 过程中；这里钉死最危险的一刻——第 13 帧（全程仅 4.2% 处），只有一个
    // 883 字节的小层刚揭晓 total 且已经下完，其余 11 层都还没汇报体积。
    // 旧实现的分母只算已知 total 的层，此刻就是 883/883=100%，随后 293 帧
    // （254MB 真实下载）全程显示 100%。新实现按已知层均值把未知层估进分母，
    // 12 层均分到同一个 883 字节的均值，算出来正好是 1/12。
    const p = createPullProgress();
    p.feed({ status: "Pulling from library/mysql", id: "8.4" }); // 镜像 tag，非层
    const neverReportedTotal = [
      "e31ea7613c63",
      "30627cea5424",
      "289dbe2b4aa0",
      "3efae9596a0b",
      "80a9fe861429",
      "9bebc71cfb90",
      "860b7bc67210",
      "d0f44f87b588",
      "01cb8e5472ee",
      "a5cddd18da97",
      "32ca1b8d1938",
    ];
    for (const id of neverReportedTotal) {
      p.feed({ status: "Pulling fs layer", id });
    }
    // 第 13 帧：真实体积 883 字节的小层，揭晓 total 的同时已经下完
    p.feed({ status: "Downloading", id: "a8ca58bc6ea9", progressDetail: { current: 883, total: 883 } });
    const snap = p.snapshot();
    expect(snap.layers).toBe(12); // tag 不计入（缺陷③）
    expect(snap.percent).toBe(8); // 883 / (12 * 883)，远低于旧实现的 100%（缺陷②）
  });

  it("还有层未到终态时进度封顶 99，全部到终态才允许 100", () => {
    // 裸算 999/1000=99.9% 四舍五入会变成 100，但该层的 current 还没追平
    // total（也没收到完成状态帧），不能算到终态——对应 llama.cpp:full-cuda
    // 实测里进度卡在 100% 长达 8 分钟、completedLayers 却冻结不动的情形。
    const p = createPullProgress();
    p.feed({ status: "Downloading", id: "a1", progressDetail: { current: 999, total: 1000 } });
    expect(p.snapshot().percent).toBe(99);
    p.feed({ status: "Download complete", id: "a1" });
    expect(p.snapshot().percent).toBe(100);
  });

  it("从未汇报 total 但已完成的层按均值补满分母，最终仍能到 100", () => {
    // 真机 12 层里有 6 层从头到尾都没汇报过体积，只有终态帧（Already exists /
    // Pull complete）。这些层必须能按均值补满分母，否则总进度永远到不了 100。
    const p = createPullProgress();
    p.feed({ status: "Downloading", id: "a1", progressDetail: { current: 50, total: 100 } });
    p.feed({ status: "Pulling fs layer", id: "b2" }); // 从不汇报体积
    expect(p.snapshot().percent).toBe(25); // est=100（仅 a1 已知），b2 未完成贡献 (0,100)
    p.feed({ status: "Download complete", id: "a1" });
    p.feed({ status: "Already exists", id: "b2" }); // 从未汇报 total，但确实拉完了
    expect(p.snapshot().percent).toBe(100);
  });
});
