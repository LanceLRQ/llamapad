/**
 * 镜像拉取进度聚合（UX P1 U14）
 *
 * dockerode 的 `modem.followProgress` 逐帧回调是"逐层"的（{status, id,
 * progressDetail:{current,total}}），没有全局百分比——面板要的是一条总进度条，
 * 需要自己按层聚合。风险簿明确的几条边界：
 * - "Pulling from xxx" 是拉取开始时的第一帧，它的 id 是镜像 tag（如
 *   "8.4"）而不是层 id，不能计入分层聚合，否则分母会永远多算一层
 *   （2026-08-29 真机实测 mysql:8.4 拉完显示 12/13、llama.cpp:full-cuda
 *   显示 5/6，都是这一层多出来的）。
 * - total 在层拉取开始前可能是 0 或缺失，此时该层不能直接从分母里剔除。
 *   最初的实现是"不计入分母"，但真机 mysql:8.4 暴露了这个假设的代价：
 *   12 个层里只有 6 个汇报过体积，第 13 帧时唯一揭晓 total 的是个 883
 *   字节的小层，它一下完 sumCurrent/sumTotal 就是 1 → 100%，随后 293
 *   帧（254MB 真实下载）全程卡在 100% 不动。现在改为把未汇报体积的层
 *   按"已知层的算术平均体积"估进分母：未完成时贡献 (0, est)，已完成
 *   时贡献 (est, est)（它确实下完了，只是从没汇报过体积）。一个已知
 *   total 的层都没有时无法估算，percent 仍为 null（前端据此切换到
 *   "不确定态"），不是 NaN/0。这个估算会偏保守（一个大层混进均值会
 *   把分母抬高、进度显得更慢），这是刻意的取舍：偏保守远好过谎报
 *   100% 然后卡死一整个拉取过程。
 * - 分母会随着更多层汇报体积而变大（每层的 total 只在该层开始下载时才出现），
 *   裸算的百分比因此会倒退。此处对外报的 percent 取全局单调值。
 *
 *   这一条推翻了最初"不做钳制、倒退是真实行为"的判断：当时假设倒退只是
 *   数字抖一下，2026-08-27 真机拉 python:3.12-slim 实测是 49% → 15%、
 *   随后 29% → 12%，两次各掉三十多个百分点，用户读到的是"重新开始下载"。
 * - percent 与 completedLayers 必须严格对齐：只要还有层没收到完成状态帧
 *   （即 completedLayers < layers.size），裸算触达的 100 会被封顶到 99。
 *   此前设想"分母跳增期间进度条会卡住，但 UI 同时展示 N/M 层已完成与
 *   状态文本，两者仍在动，不会读成卡死"——2026-08-29 真机拉 llama.cpp:
 *   full-cuda（10.3GB）证伪了这个说法：进度在全程 8.5% 处顶到 100% 后
 *   卡死约 8 分钟，completedLayers 同一时间也冻结在 4/6 不动，没有任何
 *   数字在走。加这条封顶后，UI 上不会再出现"100% 配 11/12 层已完成"这
 *   种自相矛盾——但封顶保证的只是"所有层的字节都已下完"，不代表整个
 *   拉取流程结束：docker 在最后一层 Download complete 之后通常还有一段
 *   Extracting/Pull complete 的解压阶段（实测 mysql:8.4 有 52 帧），这段
 *   由 status 文本继续承载，不再体现在 percent 里。
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
      // "Pulling from xxx" 的 id 是镜像 tag 而非层 id，不参与分层聚合
      // （lastStatus 上面已经更新，仍会照常透传给 UI 做兜底显示）
      if (frame.status.startsWith("Pulling from ")) return;
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
      // 第一趟：算已知层的均值（供未汇报体积的层估进分母），并判断是否
      // 全部层都已到终态。终态口径严格等于"收到过完成状态帧"（layer.
      // completed），不认"current 追平 total 但状态帧还没到"——放宽到
      // 后者会让 percent 提前几帧到 100，而这几帧里 completedLayers 还
      // 没跟上，UI 上就会同时出现"100%"和"11/12 层已完成"，正是这一轮
      // 要消除的自相矛盾。严格口径下 allTerminal 等价于
      // completedLayers === layers.size，封顶规则与 UI 的层计数严格对齐。
      let knownTotalSum = 0;
      let knownTotalCount = 0;
      let allTerminal = true;
      for (const layer of layers.values()) {
        if (layer.total !== undefined) {
          knownTotalSum += layer.total;
          knownTotalCount += 1;
        }
        if (!layer.completed) allTerminal = false;
      }
      const est = knownTotalCount > 0 ? knownTotalSum / knownTotalCount : undefined;

      let sumCurrent = 0;
      let sumTotal = 0;
      let completedLayers = 0;
      for (const layer of layers.values()) {
        if (layer.total !== undefined) {
          sumCurrent += layer.current ?? 0;
          sumTotal += layer.total;
        } else if (est !== undefined) {
          // 未汇报体积的层按已知层均值估进分母：未完成按 0 字节算，
          // 已完成按估算体积全部算完（它确实下完了，只是没汇报过体积）
          sumTotal += est;
          if (layer.completed) sumCurrent += est;
        }
        if (layer.completed) completedLayers += 1;
      }

      let computed = sumTotal > 0 ? Math.round((sumCurrent / sumTotal) * 100) : null;
      // 还有层没收到完成状态帧时不允许报 100：避免 percent 先于
      // completedLayers 到顶，UI 上出现"100% 配 N/M 层已完成"的矛盾
      if (computed !== null && computed >= 100 && !allTerminal) computed = 99;
      // 幂等：computed 只随 feed 变化，重复 snapshot 取 max 结果不变
      if (computed !== null) {
        reportedPercent = reportedPercent === null ? computed : Math.max(reportedPercent, computed);
      }
      return { percent: reportedPercent, status: lastStatus, layers: layers.size, completedLayers };
    },
  };
}
