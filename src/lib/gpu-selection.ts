import { parseDeviceList } from "./gpu-visibility";

/**
 * 显卡勾选框与手动文本框的双向同步判定（多卡支持批次，界面改动的前置纯逻辑）。
 *
 * 界面把「手填 0,1」改成「勾选卡片列表」，但手动文本框同时保留，两者同步。
 * 同步规则定死为四条：
 * 1. 字符串是唯一真源，勾选框只是它的派生视图（不做双向绑定，两份状态一定打架）
 * 2. 打字 → 宽容解析出其中的合法卡号点亮勾选；解析不出就一个都不亮，绝不回写覆盖用户正在打的字
 * 3. 点勾选 → 在宽容解析出的集合上增删后重写字符串，GUI 产出恒为升序
 * 4. 手动写的顺序原样保留，不替用户排序
 *
 * 草稿字符串本身是**裸列表**（不带 `device=` 前缀，如 "0,2"），拼进
 * `docker.gpu` 时才加前缀，那部分不属于本文件职责。
 */

/**
 * 宽容解析：从裸列表字符串里尽力取出卡号集合，用于点亮勾选框（同步规则第 2 条）。
 *
 * 与 `gpu-visibility.ts` 的 `parseDeviceList`（严格解析）刻意不同：那个函数是
 * 「这个配置能不能用」的判定——一处非法就整体 null，绝不猜测。这个函数是
 * 「勾选框该点亮哪几个」的显示判定——按逗号切分，只保留能解析成非负整数的项，
 * 其余项（非数字、负数、空项）一律忽略，不让用户正在打的半截输入把已经合法的
 * 部分也一起隐藏掉；结果去重、升序返回。
 *
 * 例：`"0,x"` → `[0]`；`"0,,2"` → `[0,2]`；`"2,0,2"` → `[0,2]`；`""` / `"abc"` → `[]`。
 */
export function parseSelectedDevices(raw: string): number[] {
  const selected = new Set<number>();
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (/^\d+$/.test(trimmed)) {
      selected.add(Number(trimmed));
    }
  }
  return [...selected].sort((a, b) => a - b);
}

/**
 * 勾选/取消一张卡 → 新的裸列表字符串（同步规则第 3 条）。
 *
 * 在 `parseSelectedDevices(raw)`（宽容解析）的结果上增删 `index`，再升序 join。
 * `on: true` 且已存在、或 `on: false` 且不存在时结果不变（幂等）；删到空返回 `""`，
 * 上层据此报「至少选一张卡」的错误。
 *
 * 因为走的是宽容解析，`raw` 里原本无法解析的项（如 `"0,x"` 里的 `x`）在 toggle
 * 后会被丢弃——这是刻意后果：`x` 本来就是非法值，表单已经在为它报错，toggle
 * 产出的字符串没有义务保留一个非法片段。
 */
export function toggleSelectedDevice(raw: string, index: number, on: boolean): string {
  const selected = new Set(parseSelectedDevices(raw));
  if (on) {
    selected.add(index);
  } else {
    selected.delete(index);
  }
  return [...selected].sort((a, b) => a - b).join(",");
}

/**
 * 手写顺序是否为严格升序（非升序时界面据此给警告，提醒用户 GUI 恒产出升序，
 * 手写的非升序顺序不是 bug 而是刻意保留，见同步规则第 4 条）。
 *
 * 用严格解析（`parseDeviceList`）：解析不出时没有「顺序」这个概念，返回 `true`
 * 而不是 `false`——不该在用户还没打完、或输入本来就非法（表单已经在别处报错）
 * 的情况下再多弹一个顺序警告制造噪音。单项列表恒为 true；相邻项相等
 * （如 `"1,1"`）不算严格升序，算 false。
 */
export function isAscendingDeviceList(raw: string): boolean {
  const parsed = parseDeviceList(raw);
  if (parsed === null) return true;
  for (let i = 1; i < parsed.length; i++) {
    if (parsed[i] <= parsed[i - 1]) return false;
  }
  return true;
}
