/**
 * 镜像拉取进度聚合（UX P1 U14）
 *
 * dockerode 的 `modem.followProgress` 逐帧回调是"逐层"的（{status, id,
 * progressDetail:{current,total}}），没有全局百分比——面板要的是一条总进度条，
 * 需要自己按层聚合。风险簿明确的两条边界：
 * - total 在层拉取开始前可能是 0 或缺失，此时该层不计入分母（否则会把
 *   尚未汇报体积的层当成 0 字节，拉低总进度）；全部层都没有 total 时
 *   百分比应为 null（前端据此切换到"不确定态"），不是 NaN/0。
 * - 分母会随着更多层汇报体积而变大（每层的 total 只在该层开始下载时才出现），
 *   裸算的百分比因此会倒退。此处对外报的 percent 取全局单调值。
 *
 *   这一条推翻了最初"不做钳制、倒退是真实行为"的判断：当时假设倒退只是
 *   数字抖一下，2026-08-27 真机拉 python:3.12-slim 实测是 49% → 15%、
 *   随后 29% → 12%，两次各掉三十多个百分点，用户读到的是"重新开始下载"。
 *   代价是分母跳增期间进度条会卡住直到真实进度追上——但 UI 同时展示
 *   "N/M 层已完成"与状态文本，两者仍在动，不会读成卡死。
 *
 * completedLayers 独立于百分比计算：只看状态文本是否为终态（"Already
 * exists" 等），供 UI 展示"N/M 层已完成"这类粗粒度反馈。
 */

export interface PullFrame {
  status: string;
  id?: string;
  progressDetail?: { current?: number; total?: number };
}

export interface PullSnapshot {
  percent: number | null;
  status: string;
  layers: number;
  completedLayers: number;
}

/** 单层内部状态：current/total 缺失即表示该层尚未汇报体积 */
interface LayerState {
  current?: number;
  total?: number;
  completed: boolean;
}

/** dockerode pull 进度帧里表示"该层已完成"的状态文案（跳过体积未知的层也算完成） */
const COMPLETE_STATUSES = new Set(["Already exists", "Pull complete", "Download complete"]);

export function createPullProgress(): { feed(frame: PullFrame): void; snapshot(): PullSnapshot } {
  const layers = new Map<string, LayerState>();
  let lastStatus = "";
  // 对外已报出的最高百分比：分母跳增时用它兜住，不让进度条倒退
  let reportedPercent: number | null = null;

  return {
    feed(frame) {
      lastStatus = frame.status;
      // 无 id 的帧（如 "Digest: …" / "Status: …" 整体提示）不参与分层聚合
      if (frame.id === undefined) return;

      const layer = layers.get(frame.id) ?? { completed: false };
      // 层进入终态后冻结其进度。docker 的解压阶段会复用同一层 id 重新计数
      // （实测 alpine:3.19：Downloading cur=2097152/tot=3359301 → Download
      // complete cur 缺失 → Extracting cur=1 且 tot 缺失），若继续吸收，
      // current 会被打回 1 而 total 仍是下载量，总进度直接从 60%+ 掉到 0。
      if (!layer.completed) {
        const detail = frame.progressDetail;
        if (detail?.current !== undefined) layer.current = detail.current;
        // total<=0 视同缺失：拉取刚开始时 daemon 常先给一个 0 占位
        if (detail?.total !== undefined && detail.total > 0) layer.total = detail.total;
      }
      if (COMPLETE_STATUSES.has(frame.status)) {
        layer.completed = true;
        // 完成帧不带 progressDetail，需显式补满——否则该层永远停在最后一次
        // Downloading 汇报的字节数上，总进度到不了 100%
        if (layer.total !== undefined) layer.current = layer.total;
      }
      layers.set(frame.id, layer);
    },

    snapshot() {
      let sumCurrent = 0;
      let sumTotal = 0;
      let completedLayers = 0;
      for (const layer of layers.values()) {
        if (layer.total !== undefined) {
          sumCurrent += layer.current ?? 0;
          sumTotal += layer.total;
        }
        if (layer.completed) completedLayers += 1;
      }
      const computed = sumTotal > 0 ? Math.round((sumCurrent / sumTotal) * 100) : null;
      // 幂等：computed 只随 feed 变化，重复 snapshot 取 max 结果不变
      if (computed !== null) {
        reportedPercent = reportedPercent === null ? computed : Math.max(reportedPercent, computed);
      }
      return { percent: reportedPercent, status: lastStatus, layers: layers.size, completedLayers };
    },
  };
}
