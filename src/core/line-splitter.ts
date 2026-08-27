/**
 * 字节流按行切分：把流按 \n 切成行逐条回调，不完整的尾行留在缓冲等下一块，
 * 行尾 \r 容错剥掉，flush() 在流结束时把残留尾行作为最后一行补出。
 *
 * 两个消费者都吃「一行可能跨多个 data 事件」的亏：docker 的复用流按帧到达
 * （followLogs / followStats），nvidia-smi 常驻流（-lms）经管道时同理。
 * 直接 JSON.parse(chunk) 或按 chunk 当行处理都会在边界不对齐时炸掉。
 *
 * 放 core 而非 adapters：它是零依赖纯逻辑，留在 dockerode.ts 里会让
 * metrics/nvidiaSmi.ts 为一个行切分器顺带加载整个 dockerode 客户端库。
 *
 * 已知边界（沿用既有行为，未修）：按 chunk 逐块 toString("utf8") 解码，
 * 多字节字符恰好被 chunk 边界切断时那个字符会损坏成替换字符。docker 的
 * JSON 帧与 nvidia-smi 的 CSV 都是 ASCII，不受影响；只有容器日志里的
 * 非 ASCII 文本理论上会踩到，且需要边界恰好落在字符中间。要修得改用
 * StringDecoder 持有跨块解码状态——不在秒级采集的范围内，先用测试钉死现状。
 */
export class LineSplitter {
  private buffer = "";

  constructor(private readonly onLine: (line: string) => void) {}

  push(chunk: Buffer | string): void {
    this.buffer += chunk.toString("utf8");
    let nl = this.buffer.indexOf("\n");
    while (nl >= 0) {
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      this.onLine(line.endsWith("\r") ? line.slice(0, -1) : line);
      nl = this.buffer.indexOf("\n");
    }
  }

  flush(): void {
    if (this.buffer !== "") {
      const line = this.buffer;
      this.buffer = "";
      this.onLine(line.endsWith("\r") ? line.slice(0, -1) : line);
    }
  }
}
