import { describe, expect, it } from "vitest";

import {
  DEFAULT_DOWNLOADS_VIEW,
  DOWNLOADS_VIEWS,
  computeDownloadsNavCounts,
  describeHistoryFiles,
  downloadsBlocks,
  queueRowsForView,
  resolveDownloadsView,
  type DownloadTaskLike,
} from "./downloads-view";

describe("resolveDownloadsView", () => {
  it("六个合法值原样返回", () => {
    for (const view of DOWNLOADS_VIEWS) {
      expect(resolveDownloadsView(view)).toBe(view);
    }
  });

  it("缺省（undefined）落到 queue", () => {
    expect(resolveDownloadsView(undefined)).toBe(DEFAULT_DOWNLOADS_VIEW);
  });

  it("非法字符串落到 queue", () => {
    expect(resolveDownloadsView("nope")).toBe(DEFAULT_DOWNLOADS_VIEW);
  });

  it("设计稿脚本用的缩写（dl/pend/pause/fail）不是合法值，同样落到 queue", () => {
    // URL 契约用 status 字面量，不用设计稿 demo 图省事的缩写——这几个缩写
    // 一旦被当成合法值放行，会让 `task.status === view` 的过滤永远匹配不上
    expect(resolveDownloadsView("dl")).toBe(DEFAULT_DOWNLOADS_VIEW);
    expect(resolveDownloadsView("pend")).toBe(DEFAULT_DOWNLOADS_VIEW);
    expect(resolveDownloadsView("pause")).toBe(DEFAULT_DOWNLOADS_VIEW);
    expect(resolveDownloadsView("fail")).toBe(DEFAULT_DOWNLOADS_VIEW);
  });

  it("空字符串落到 queue", () => {
    expect(resolveDownloadsView("")).toBe(DEFAULT_DOWNLOADS_VIEW);
  });
});

describe("DOWNLOADS_VIEWS", () => {
  it("六格且不含 completed / cancelled：二级栏是任务生命周期，不是 status 全集", () => {
    expect(DOWNLOADS_VIEWS).toEqual(["queue", "downloading", "pending", "paused", "failed", "history"]);
  });
});

describe("downloadsBlocks", () => {
  it("queue 视图：告警 + 当前卡 + 队列表都显示，历史卡收起", () => {
    expect(downloadsBlocks("queue")).toEqual({ warn: true, current: true, queue: true, history: false });
  });

  it("downloading 视图：只有当前卡（那条记录已由大卡承担，队列表收起）", () => {
    expect(downloadsBlocks("downloading")).toEqual({
      warn: false,
      current: true,
      queue: false,
      history: false,
    });
  });

  it("pending 视图：只有队列表（当前卡不含 pending 记录）", () => {
    expect(downloadsBlocks("pending")).toEqual({ warn: false, current: false, queue: true, history: false });
  });

  it("paused 视图：只有队列表", () => {
    expect(downloadsBlocks("paused")).toEqual({ warn: false, current: false, queue: true, history: false });
  });

  it("failed 视图：告警 + 队列表——停摆是失败堆积的后果，这里正是处理它的地方", () => {
    expect(downloadsBlocks("failed")).toEqual({ warn: true, current: false, queue: true, history: false });
  });

  it("history 视图：只有历史卡", () => {
    expect(downloadsBlocks("history")).toEqual({ warn: false, current: false, queue: false, history: true });
  });
});

describe("queueRowsForView", () => {
  const rows = [
    { id: 1, status: "pending" },
    { id: 2, status: "paused" },
    { id: 3, status: "failed" },
    { id: 4, status: "pending" },
  ];

  it("queue 视图给全部行，且不改变顺序", () => {
    expect(queueRowsForView("queue", rows)).toEqual(rows);
  });

  it("pending 视图只给 pending 行", () => {
    expect(queueRowsForView("pending", rows)).toEqual([rows[0], rows[3]]);
  });

  it("paused 视图只给 paused 行", () => {
    expect(queueRowsForView("paused", rows)).toEqual([rows[1]]);
  });

  it("failed 视图只给 failed 行", () => {
    expect(queueRowsForView("failed", rows)).toEqual([rows[2]]);
  });

  it("downloading / history 视图：队列表本就收起（downloadsBlocks().queue 为 false），给空数组", () => {
    expect(queueRowsForView("downloading", rows)).toEqual([]);
    expect(queueRowsForView("history", rows)).toEqual([]);
  });

  it("空行输入不报错，各视图都给空数组", () => {
    expect(queueRowsForView("queue", [])).toEqual([]);
    expect(queueRowsForView("failed", [])).toEqual([]);
  });
});

describe("computeDownloadsNavCounts", () => {
  it("空任务列表 + 空历史：六格全零", () => {
    const counts = computeDownloadsNavCounts([], [], {});
    expect(counts).toEqual({
      queue: { count: 0, speedBytesPerSec: 0, hasActive: false },
      downloading: { count: 0, bytes: 0 },
      pending: { count: 0, bytes: 0 },
      paused: { count: 0, downloadedBytes: 0, totalBytes: 0 },
      failed: { count: 0, bytes: 0 },
      history: { count: 0, bytes: 0 },
    });
  });

  it("各状态分别计数与累加字节数", () => {
    const tasks: DownloadTaskLike[] = [
      { id: 1, status: "downloading", expectedSize: 2_000_000, downloadedBytes: 500_000 },
      { id: 2, status: "pending", expectedSize: 4_000_000, downloadedBytes: 0 },
      { id: 3, status: "paused", expectedSize: 10_000_000, downloadedBytes: 6_000_000 },
      { id: 4, status: "failed", expectedSize: 600_000, downloadedBytes: 100_000 },
    ];
    const counts = computeDownloadsNavCounts(tasks, [], { 1: 1_000 });

    expect(counts.downloading).toEqual({ count: 1, bytes: 2_000_000 });
    expect(counts.pending).toEqual({ count: 1, bytes: 4_000_000 });
    // paused 给两个数：断点位置（downloadedBytes）与总量（expectedSize 之和）
    expect(counts.paused).toEqual({ count: 1, downloadedBytes: 6_000_000, totalBytes: 10_000_000 });
    expect(counts.failed).toEqual({ count: 1, bytes: 600_000 });
    expect(counts.queue).toEqual({ count: 4, speedBytesPerSec: 1_000, hasActive: true });
  });

  it("expectedSize 为 null 的任务跳过，不计入字节合计（未知大小不能当 0 计入）", () => {
    const tasks: DownloadTaskLike[] = [
      { id: 1, status: "pending", expectedSize: null, downloadedBytes: 0 },
      { id: 2, status: "pending", expectedSize: 1_000, downloadedBytes: 0 },
    ];
    const counts = computeDownloadsNavCounts(tasks, [], {});
    expect(counts.pending).toEqual({ count: 2, bytes: 1_000 });
  });

  it("paused 的 downloadedBytes 即使 expectedSize 为 null 也照常累加（该字段本身不可为 null）", () => {
    const tasks: DownloadTaskLike[] = [{ id: 1, status: "paused", expectedSize: null, downloadedBytes: 3_000 }];
    const counts = computeDownloadsNavCounts(tasks, [], {});
    expect(counts.paused).toEqual({ count: 1, downloadedBytes: 3_000, totalBytes: 0 });
  });

  it("completed / cancelled 不进 queue.count，也不进任何状态格", () => {
    const tasks: DownloadTaskLike[] = [
      { id: 1, status: "completed", expectedSize: 1_000, downloadedBytes: 1_000 },
      { id: 2, status: "cancelled", expectedSize: 1_000, downloadedBytes: 500 },
      { id: 3, status: "pending", expectedSize: 1_000, downloadedBytes: 0 },
    ];
    const counts = computeDownloadsNavCounts(tasks, [], {});
    expect(counts.queue.count).toBe(1);
    expect(counts.downloading.count).toBe(0);
    expect(counts.paused.count).toBe(0);
    expect(counts.failed.count).toBe(0);
  });

  it("speeds 只累加 downloading 任务的：非 downloading 任务即使有 speed 条目也不计入", () => {
    const tasks: DownloadTaskLike[] = [
      { id: 1, status: "downloading", expectedSize: 1_000, downloadedBytes: 0 },
      { id: 2, status: "paused", expectedSize: 1_000, downloadedBytes: 0 },
    ];
    // id 2 是 paused，混进 speeds 里也不该被计入 queue.speedBytesPerSec
    const counts = computeDownloadsNavCounts(tasks, [], { 1: 500, 2: 9_999 });
    expect(counts.queue.speedBytesPerSec).toBe(500);
  });

  it("没有 downloading 任务时 hasActive 为 false，speedBytesPerSec 为 0", () => {
    const tasks: DownloadTaskLike[] = [{ id: 1, status: "pending", expectedSize: 1_000, downloadedBytes: 0 }];
    const counts = computeDownloadsNavCounts(tasks, [], {});
    expect(counts.queue.hasActive).toBe(false);
    expect(counts.queue.speedBytesPerSec).toBe(0);
  });

  it("history 计数与字节合计取自 history 参数，与 tasks 无关", () => {
    const counts = computeDownloadsNavCounts([], [{ totalBytes: 1_000 }, { totalBytes: 2_000 }], {});
    expect(counts.history).toEqual({ count: 2, bytes: 3_000 });
  });
});

describe("describeHistoryFiles", () => {
  const label = (action: string) =>
    ({ move: "移动", link: "链接", copy: "复制" })[action] ?? action;

  it("纯下载批次：原样只有文件名，无箭头（source_path/local_action 两键缺失）", () => {
    const files = [{ file: "a.gguf" }, { file: "b.gguf" }];
    expect(describeHistoryFiles(files, label)).toBe("a.gguf\nb.gguf");
  });

  it("纯 local 批次：每行带手段与源路径", () => {
    const files = [
      { file: "a.gguf", source_path: "/host/old/a.gguf", local_action: "move" },
      { file: "b.gguf", source_path: "/host/old/b.gguf", local_action: "link" },
    ];
    expect(describeHistoryFiles(files, label)).toBe(
      "a.gguf ← 移动 /host/old/a.gguf\nb.gguf ← 链接 /host/old/b.gguf",
    );
  });

  it("混合批次：下载行与 local 行并存，顺序保持输入顺序不变", () => {
    const files = [
      { file: "a.gguf", source_path: "/host/old/a.gguf", local_action: "move" },
      { file: "b.gguf" },
      { file: "c.gguf", source_path: "/host/old/c.gguf", local_action: "copy" },
    ];
    expect(describeHistoryFiles(files, label)).toBe(
      "a.gguf ← 移动 /host/old/a.gguf\nb.gguf\nc.gguf ← 复制 /host/old/c.gguf",
    );
  });
});
