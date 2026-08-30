/**
 * 下载落盘目录推导（阶段 2 / B3 修复）：从 gguf_file 取目录段，而不是从
 * model.namespace 取——后者是模型配置的分组标签，早就可以与文件实际所在
 * 目录不一致（真机 11 个模型里 9 个不一致，分组 main、文件却在
 * gemma4/qwen3.6/qwen3.8 三个目录下）。用 namespace 拼路径会把重新下载的
 * 文件落到错误目录，配置指向的路径永远对不上。
 *
 * gguf_file 可能是 glob（如 "qwen3.6/model-*.gguf"），但只取第一个 "/"
 * 之前的部分，通配符落在文件名段不影响判定。没有目录段（如 "model.gguf"，
 * 直接挂 models 根）返回空串——空串是合法值，代表"落 models 根"，调用方
 * 不能把它当异常处理，也不能拼出前导 "/" 或 "./"。
 */
export function defaultTargetDir(ggufFile: string): string {
  const slash = ggufFile.indexOf("/");
  return slash === -1 ? "" : ggufFile.slice(0, slash);
}
