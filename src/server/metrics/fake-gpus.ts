import type { ExecFileLike } from "./nvidiaSmi";

/**
 * dev-only 假多卡数据源（无 NVIDIA 显卡的开发机上伪造 N 张卡，供多卡 UI 本地
 * 目视验收；接线见 server/locators.ts 的 PANEL_FAKE_GPUS）。
 *
 * 列格式必须与 nvidiaSmi.ts 的 QUERY_ARGS 完全一致（七列：index/memUsed/
 * memTotal/util/temp/power/name，noheader,nounits 风格），否则真实解析器
 * parseGpuCsvLines 会把假数据的某一列当成坏值整行丢弃——配套测试直接跑一遍
 * parseGpuCsvLines 校验这点，不满足于"看起来像"。
 *
 * 数据故意做出差异，这是本文件存在的唯一目的（不是为了逼真，是为了 UI 上
 * 能看出区别）：型号按卡号奇偶在两种间交替，显存占用刻意让"有的接近空、
 * 有的很满"（模拟真实机器上别人正占着一张卡），利用率/温度/功耗各自错开
 * 相位。每次调用数值随内部计数器小幅摆动，占用条才会显得是活的——用三角波
 * 而不是 Math.random()，因为振荡必须是给定调用次数就能推算出确定值的纯
 * 函数，不可测的随机数没法在测试里钉死行为。
 */

/** 两种假型号，按卡号奇偶交替；memTotalMib 取真实型号的显存容量 */
const FAKE_GPU_MODELS = [
  { name: "Tesla V100-SXM2-32GB", memTotalMib: 32510 },
  { name: "NVIDIA A100-SXM4-80GB", memTotalMib: 81920 },
] as const;

/** 振荡周期（拍数）：往返一次 0→1→0，纯粹为了"看起来是活的"，无实际物理含义 */
const WAVE_PERIOD_TICKS = 20;

/**
 * 三角波：给定第几拍（tick）与相位偏移（phase），返回 [0, 1] 区间的比例。
 * 用取模实现往返而不是 Math.sin，避免浮点舍入让相邻两拍在峰值附近算出
 * 相同的四舍五入结果——三角波在非峰谷点是严格线性的，每拍都保证有变化。
 */
function triangleWave(tick: number, phase: number): number {
  const half = WAVE_PERIOD_TICKS / 2;
  // (% + period) % period 防止 phase 或 tick 为负时取模结果为负
  const t = ((tick + phase) % WAVE_PERIOD_TICKS + WAVE_PERIOD_TICKS) % WAVE_PERIOD_TICKS;
  return t < half ? t / half : (WAVE_PERIOD_TICKS - t) / half;
}

/**
 * 工厂函数：造一个假的 nvidia-smi execFile 替身，忽略传入的 command/args，
 * 每次调用产出 count 张卡的 CSV 快照。
 *
 * count 非正整数（0 / 负数 / 小数）一律当作 0 张卡处理——产出空 CSV
 * （parseGpuCsvLines 解析出 []），不抛异常也不做取整/取绝对值之类的隐式
 * 纠正：一个传错的张数应该"看起来没卡"而不是悄悄变成别的张数。
 *
 * 计数器是本函数返回的闭包私有状态，每次调用 createFakeGpuExecFile 都拿到
 * 全新的计数器——不同 collector 实例（如多个测试用例各自创建的假数据源）
 * 互不干扰，也不依赖任何全局/模块级可变状态。
 */
export function createFakeGpuExecFile(count: number): ExecFileLike {
  const gpuCount = Number.isInteger(count) && count > 0 ? count : 0;
  let tick = 0;

  return (_command, _args, callback) => {
    const currentTick = tick++;
    const lines: string[] = [];

    for (let index = 0; index < gpuCount; index++) {
      const model = FAKE_GPU_MODELS[index % FAKE_GPU_MODELS.length]!;
      // 每张卡相位错开 7 拍：任意时刻都能同时看到"接近空"与"很满"的卡，
      // 不会因为振荡走到某一拍就让全部卡一起挤到同一极值
      const phase = index * 7;
      const memRatio = triangleWave(currentTick, phase); // 0 接近空 ~ 1 很满
      const utilRatio = triangleWave(currentTick, phase + 5);
      const tempRatio = triangleWave(currentTick, phase + 10);
      const powerRatio = triangleWave(currentTick, phase + 15);

      const memUsedMib = Math.round(model.memTotalMib * memRatio);
      const utilPercent = Math.round(utilRatio * 100);
      const tempC = Math.round(40 + tempRatio * 40); // 40~80°C，覆盖常见工作温区
      const powerW = (100 + powerRatio * 250).toFixed(2); // 100~350W

      lines.push(
        `${index}, ${memUsedMib}, ${model.memTotalMib}, ${utilPercent}, ${tempC}, ${powerW}, ${model.name}`,
      );
    }

    callback(null, lines.length > 0 ? lines.join("\n") + "\n" : "");
    return undefined;
  };
}
