import { describe, expect, it } from "vitest";

import {
  BASE_TITLE,
  type DownloadTaskSnapshot,
  deriveDownloadState,
  formatDiskReadout,
  formatGpuReadout,
  formatPort,
} from "./status-bar";
import { METRIC_IDS } from "@/server/metrics/ids";

const LABELS = { waiting: "队列中", failed: "有失败", indeterminate: "下载中" };

function task(overrides: Partial<DownloadTaskSnapshot>): DownloadTaskSnapshot {
  return {
    id: 1,
    model: "qwen2.5-7b",
    status: "downloading",
    downloadedBytes: 0,
    expectedSize: null,
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("formatGpuReadout（状态栏 GPU 条目）", () => {
  it("有值时返回利用率百分比（strong）与显存 used/total（dim，GiB 单位）", () => {
    const samples = { [METRIC_IDS.gpuUtilPercent]: { value: 78.4, ts: 0 } };
    const totals = { memUsedMib: 18636, memTotalMib: 24576 };
    expect(formatGpuReadout(samples, totals)).toEqual({
      strong: "78%",
      dim: "18.2 / 24.0 GiB",
    });
  });

  it("samples 为 null（但 totals 在）时利用率退化为 —，显存正常显示", () => {
    const totals = { memUsedMib: 18636, memTotalMib: 24576 };
    expect(formatGpuReadout(null, totals)).toEqual({ strong: "—", dim: "18.2 / 24.0 GiB" });
  });

  it("totals 为 null（但 samples 在）时显存退化为 —，利用率正常显示", () => {
    const samples = { [METRIC_IDS.gpuUtilPercent]: { value: 12, ts: 0 } };
    expect(formatGpuReadout(samples, null)).toEqual({ strong: "12%", dim: "—" });
  });

  it("samples 与 totals 都缺时整体退化为单个 —（不渲染 dim，避免 — — 并排）", () => {
    expect(formatGpuReadout(null, null)).toEqual({ strong: "—", dim: null });
    expect(formatGpuReadout({}, null)).toEqual({ strong: "—", dim: null });
  });
});

describe("formatDiskReadout（状态栏磁盘条目）", () => {
  it("正常计算已用 = 总量 − 剩余，strong 是已用、dim 是 \"/ 总量 GB\"", () => {
    const GB = 1024 ** 3;
    expect(formatDiskReadout(1251 * GB, 1863 * GB)).toEqual({ strong: "612", dim: "/ 1863 GB" });
  });

  it("剩余为 null 时整体退化为单个 —", () => {
    expect(formatDiskReadout(null, 1863 * 1024 ** 3)).toEqual({ strong: "—", dim: null });
  });

  it("总量为 null 时整体退化为单个 —", () => {
    expect(formatDiskReadout(1251 * 1024 ** 3, null)).toEqual({ strong: "—", dim: null });
  });
});

describe("formatPort（运行模型 chip 端口后缀）", () => {
  it("有端口时返回冒号前缀", () => {
    expect(formatPort(18080)).toBe(":18080");
  });

  it("端口未知（模型行已删）时返回空串", () => {
    expect(formatPort(null)).toBe("");
  });
});

describe("deriveDownloadState（下载条目派生，从旧顶栏徽标原样抽出）", () => {
  const NOW = Date.parse("2026-08-29T12:00:00.000Z");

  it("下载中：已知大小按百分比出 label，modelName 是该任务模型名", () => {
    const state = deriveDownloadState(
      [task({ downloadedBytes: 43, expectedSize: 100, updatedAt: new Date(NOW).toISOString() })],
      NOW,
      LABELS,
    );
    expect(state).toEqual({
      label: "43%",
      title: "qwen2.5-7b",
      modelName: "qwen2.5-7b",
      docTitle: "43% · qwen2.5-7b — llamapad",
      failed: false,
    });
  });

  it("下载中：未知大小（expectedSize=null）出「下载中」文案，document.title 不带百分比", () => {
    const state = deriveDownloadState([task({ expectedSize: null })], NOW, LABELS);
    expect(state).toEqual({
      label: "下载中",
      title: "qwen2.5-7b",
      modelName: "qwen2.5-7b",
      docTitle: "qwen2.5-7b — llamapad",
      failed: false,
    });
  });

  it("排队：只有 pending 任务时 label 带 +N 后缀，非下载中 modelName 为 null", () => {
    const tasks = [1, 2, 3].map((id) => task({ id, status: "pending" }));
    const state = deriveDownloadState(tasks, NOW, LABELS);
    expect(state).toEqual({
      label: "队列中 +3",
      title: "队列中",
      modelName: null,
      docTitle: BASE_TITLE,
      failed: false,
    });
  });

  it("5 分钟内的 failed 判定为新鲜失败：label 变失败文案，failed=true，modelName 为 null", () => {
    const updatedAt = new Date(NOW - 60_000).toISOString(); // 1 分钟前
    const state = deriveDownloadState([task({ status: "failed", updatedAt })], NOW, LABELS);
    expect(state).toEqual({
      label: "有失败",
      title: "队列中",
      modelName: null,
      docTitle: BASE_TITLE,
      failed: true,
    });
  });

  it("陈年 failed（超过 5 分钟）不判红：与其他 active 任务共存时 failed=false", () => {
    const staleUpdatedAt = new Date(NOW - 6 * 60_000).toISOString(); // 6 分钟前
    const tasks = [
      task({ id: 1, status: "pending" }),
      task({ id: 2, status: "failed", updatedAt: staleUpdatedAt }),
    ];
    const state = deriveDownloadState(tasks, NOW, LABELS);
    expect(state?.failed).toBe(false);
    expect(state?.label).toBe("队列中 +1");
    expect(state?.modelName).toBeNull();
  });

  it("陈年 failed 单独存在（无其他任务）时整体不算 active，返回 null", () => {
    const staleUpdatedAt = new Date(NOW - 6 * 60_000).toISOString();
    const state = deriveDownloadState(
      [task({ status: "failed", updatedAt: staleUpdatedAt })],
      NOW,
      LABELS,
    );
    expect(state).toBeNull();
  });

  it("无任务返回 null（组件据此把 document.title 恢复为 BASE_TITLE）", () => {
    expect(deriveDownloadState([], NOW, LABELS)).toBeNull();
    expect(BASE_TITLE).toBe("llamapad");
  });
});
