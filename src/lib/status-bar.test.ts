import { describe, expect, it } from "vitest";

import {
  BASE_TITLE,
  type DownloadTaskSnapshot,
  deriveDownloadState,
  formatCpuGauge,
  formatDiskGauge,
  formatGpuGauge,
  formatMemGauge,
  formatPort,
  gaugeTone,
} from "./status-bar";
import { METRIC_IDS } from "@/server/metrics/ids";

const LABELS = { waiting: "队列中", failed: "有失败", indeterminate: "下载中" };
const CPU_LABELS = { cores: "核", load: "负载" };
const GPU_LABELS = { vram: "显存", util: "利用率" };

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

describe("formatCpuGauge（状态栏 CPU 条目）", () => {
  it("正常值：百分比进条，明细拼 \"16 核 · 负载 1.42\"", () => {
    const samples = {
      [METRIC_IDS.hostCpuPercent]: { value: 41.2, ts: 0 },
      [METRIC_IDS.hostLoad1]: { value: 1.42, ts: 0 },
    };
    expect(formatCpuGauge(samples, 16, CPU_LABELS)).toEqual({
      percent: 41.2,
      text: "41%",
      detail: "16 核 · 负载 1.42",
    });
  });

  it("核数为 null 时明细只出负载", () => {
    const samples = {
      [METRIC_IDS.hostCpuPercent]: { value: 41.2, ts: 0 },
      [METRIC_IDS.hostLoad1]: { value: 1.42, ts: 0 },
    };
    expect(formatCpuGauge(samples, null, CPU_LABELS)).toEqual({
      percent: 41.2,
      text: "41%",
      detail: "负载 1.42",
    });
  });

  it("负载样本缺失时明细只出核数", () => {
    const samples = { [METRIC_IDS.hostCpuPercent]: { value: 41.2, ts: 0 } };
    expect(formatCpuGauge(samples, 16, CPU_LABELS)).toEqual({
      percent: 41.2,
      text: "41%",
      detail: "16 核",
    });
  });

  it("核数与负载都缺时 detail 为 null", () => {
    const samples = { [METRIC_IDS.hostCpuPercent]: { value: 41.2, ts: 0 } };
    expect(formatCpuGauge(samples, null, CPU_LABELS)).toEqual({
      percent: 41.2,
      text: "41%",
      detail: null,
    });
  });

  it("host.cpu_percent 缺失时整体退化为 —", () => {
    expect(formatCpuGauge({}, 16, CPU_LABELS)).toEqual({
      percent: null,
      text: "—",
      detail: null,
    });
  });
});

describe("formatMemGauge（状态栏内存条目）", () => {
  it("正常值：百分比进条，明细为 GiB 用量/总量", () => {
    const samples = {
      [METRIC_IDS.hostMemPercent]: { value: 62.5, ts: 0 },
      [METRIC_IDS.hostMemUsedBytes]: { value: 15360 * 1024 ** 2, ts: 0 },
    };
    expect(formatMemGauge(samples, 24576 * 1024 ** 2)).toEqual({
      percent: 62.5,
      text: "63%",
      detail: "15.0 / 24.0 GiB",
    });
  });

  it("totalBytes 为 null 时 detail 为 null，percent 仍正常", () => {
    const samples = {
      [METRIC_IDS.hostMemPercent]: { value: 62.5, ts: 0 },
      [METRIC_IDS.hostMemUsedBytes]: { value: 15360 * 1024 ** 2, ts: 0 },
    };
    expect(formatMemGauge(samples, null)).toEqual({
      percent: 62.5,
      text: "63%",
      detail: null,
    });
  });

  it("host.mem_percent 样本缺失时整体退化为 —", () => {
    expect(formatMemGauge({}, 24576 * 1024 ** 2)).toEqual({
      percent: null,
      text: "—",
      detail: null,
    });
  });
});

describe("formatGpuGauge（状态栏 GPU 条目：条改语义为显存占用率）", () => {
  it("正常值：显存占比进条（15360/24576=62.5% → 63%），明细双段", () => {
    const totals = { memUsedMib: 15360, memTotalMib: 24576 };
    const samples = { [METRIC_IDS.gpuUtilPercent]: { value: 8, ts: 0 } };
    expect(formatGpuGauge(totals, samples, GPU_LABELS)).toEqual({
      percent: 62.5,
      text: "63%",
      detail: "显存 15.0 / 24.0 GiB · 利用率 8%",
    });
  });

  it("totals 为 null 时 percent 为 null、text 为 —，明细只剩利用率", () => {
    const samples = { [METRIC_IDS.gpuUtilPercent]: { value: 8, ts: 0 } };
    expect(formatGpuGauge(null, samples, GPU_LABELS)).toEqual({
      percent: null,
      text: "—",
      detail: "利用率 8%",
    });
  });

  it("利用率样本缺失时明细只剩显存", () => {
    const totals = { memUsedMib: 15360, memTotalMib: 24576 };
    expect(formatGpuGauge(totals, null, GPU_LABELS)).toEqual({
      percent: 62.5,
      text: "63%",
      detail: "显存 15.0 / 24.0 GiB",
    });
  });

  it("两段都缺时 detail 为 null", () => {
    expect(formatGpuGauge(null, null, GPU_LABELS)).toEqual({
      percent: null,
      text: "—",
      detail: null,
    });
  });

  it("memTotalMib 为 0 时不产生 Infinity/NaN，整体退化为 —", () => {
    const totals = { memUsedMib: 0, memTotalMib: 0 };
    expect(formatGpuGauge(totals, null, GPU_LABELS)).toEqual({
      percent: null,
      text: "—",
      detail: null,
    });
  });
});

describe("formatDiskGauge（状态栏磁盘条目）", () => {
  it("正常值：已用 = 总 − 剩余，百分比与明细都对", () => {
    const GB = 1024 ** 3;
    expect(formatDiskGauge(455 * GB, 1300 * GB)).toEqual({
      percent: 65,
      text: "65%",
      detail: "845 / 1300 GB",
    });
  });

  it("剩余为 null 时整体退化为 —", () => {
    expect(formatDiskGauge(null, 1300 * 1024 ** 3)).toEqual({
      percent: null,
      text: "—",
      detail: null,
    });
  });

  it("总量为 null 时整体退化为 —", () => {
    expect(formatDiskGauge(455 * 1024 ** 3, null)).toEqual({
      percent: null,
      text: "—",
      detail: null,
    });
  });

  it("totalBytes 为 0 时不产生 NaN，整体退化为 —", () => {
    expect(formatDiskGauge(0, 0)).toEqual({
      percent: null,
      text: "—",
      detail: null,
    });
  });
});

describe("gaugeTone（条形色阶阈值）", () => {
  it("84.9% 为 normal", () => {
    expect(gaugeTone(84.9)).toBe("normal");
  });

  it("85% 为 warn", () => {
    expect(gaugeTone(85)).toBe("warn");
  });

  it("94.9% 为 warn", () => {
    expect(gaugeTone(94.9)).toBe("warn");
  });

  it("95% 为 critical", () => {
    expect(gaugeTone(95)).toBe("critical");
  });

  it("null 为 normal", () => {
    expect(gaugeTone(null)).toBe("normal");
  });
});

describe("gauge 百分比 clamp（越界夹到 [0, 100]）", () => {
  it("formatCpuGauge：利用率 120% 被夹到 100", () => {
    const samples = { [METRIC_IDS.hostCpuPercent]: { value: 120, ts: 0 } };
    const gauge = formatCpuGauge(samples, null, CPU_LABELS);
    expect(gauge.percent).toBe(100);
    expect(gauge.text).toBe("100%");
  });

  it("formatGpuGauge：memUsedMib 超过 memTotalMib 时占比被夹到 100", () => {
    const totals = { memUsedMib: 30000, memTotalMib: 24576 };
    const gauge = formatGpuGauge(totals, null, GPU_LABELS);
    expect(gauge.percent).toBe(100);
    expect(gauge.text).toBe("100%");
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
