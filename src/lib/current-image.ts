/**
 * 设置页「当前启动镜像」读数卡的纯判定（配套 settings/current-image-card.tsx）。
 *
 * 下沉原因与 lib/image-card-form.ts 同源：vitest 是 environment: "node" 且未装
 * jsdom，组件渲染测不了，可测判定一律放在 src/lib 配 .test.ts。
 */

/** 只取本判定用得上的字段，不把 settings/image-types.ts 的 view 类型拖进 lib 层 */
export interface LocalImageLike {
  tags: string[];
  size: number;
}

/**
 * 在本地镜像里按 ref 精确匹配 tag：命中返回体积（读数卡显示「本地已拉取 · N GB」），
 * 未命中返回 null（改显示「本地未拉取」）。
 *
 * 必须精确匹配：docker 的 ref 是 `repo:tag` 字面量，alpine:3 与 alpine:3.20 是两个
 * 不同镜像，任何前缀/模糊匹配都会把「其实没拉」误报成「已拉取」，而这张卡存在的
 * 全部意义就是把这件事说准。
 *
 * 已知假阴性：用户填 `alpine`（docker 认，隐式等价 `alpine:latest`）而本地确实已拉
 * 取 `alpine:latest` 时，这里精确匹配落空，会显示「本地未拉取」。不补 `:latest` 是
 * 有意为之——`localhost:5000/myimage` 这类带 registry 端口的 ref 里同样含冒号，无法
 * 用 `includes(":")` 之类的简单判断区分"已带 tag"与"还没带"，补不对反而会把它误判成
 * 已带 tag 从而不补全，两难之下选择保留假阴性：不阻断保存、运行时也能正常拉起，
 * 唯一代价是这一种输入形式下状态行显示不准。
 */
export function findLocalImage(
  ref: string,
  localImages: readonly LocalImageLike[],
): { sizeBytes: number } | null {
  const target = ref.trim();
  if (target === "") return null;
  const hit = localImages.find((image) => image.tags.includes(target));
  return hit ? { sizeBytes: hit.size } : null;
}

/**
 * 保存按钮可用性：去空白后非空，且与已保存值不同。
 *
 * 用 trim 后的值比较而不是字面比较——用户在末尾多敲一个空格不该让「保存」亮起来，
 * 因为真正写下去的也是 trim 后的值，亮起来等于承诺一次什么都不会变的写入。
 */
export function isCurrentImageSavable(draft: string, saved: string): boolean {
  const next = draft.trim();
  return next !== "" && next !== saved.trim();
}
