import { defaultSchema, type Options } from "rehype-sanitize";

/**
 * README 消毒 schema —— 这是本仓库里唯一允许把「不可信 HTML」渲染进 DOM 的地方。
 *
 * 背景：`components/markdown.tsx` 原先刻意不引 `rehype-raw`，因为它同时服务自建
 * Playground（渲染模型输出）——模型输出不可信，直接渲染其中的原始 HTML 就是 XSS。
 * README 视图要展示 HuggingFace README 里的横幅（大段 `<div><p style="…"><h1>…`），
 * 不开 HTML 就只能把标签原样打成文本，所以只给 README 这一条路径开口子，且必须
 * 经过这份 schema 消毒——`rehype-raw` 只负责把字符串变成节点，真正兜底的是这里。
 *
 * **这是本仓库的 XSS 边界**：新增标签或属性前，先想清楚它能不能被用来做视觉欺骗
 * （固定定位覆盖面板 UI、零透明度遮罩、写死配色破坏深色主题）或取数（表单回传、
 * 跨域 iframe/svg 加载外部资源）。想不清楚就不要加。
 *
 * style 属性为什么全剥（这是产品侧已定的决策，不是本文件自己收紧的）：inline style
 * 是视觉欺骗的主要载体——`position:fixed;inset:0` 能盖住面板按钮、零 opacity 的
 * 覆盖层能诱导误点、写死白底黑字在深色主题下会变瞎。`defaultSchema` 本身就不放行
 * `style`（它是纯白名单制，属性不在列表里就不会出现在消毒结果里），下面的
 * `attributes` 只新增了 width/height/align 三个具体属性，没有任何地方提到
 * `style`，所以它始终被剥——这里也不需要额外代码去拦截它。
 *
 * 同理，`on*` 事件处理器（onerror/onload/onclick…）一个都没被放行：不是这里显式
 * 拦截的，而是 `defaultSchema` 从设计上就是白名单制，凡是没有出现在下面
 * `attributes` 里的属性名，消毒时一律被丢弃。新增属性时如果不小心加宽了某个
 * 通配符（比如给 `'*'` 加东西），就会连带放行到所有标签上，务必按标签精确加。
 */
export const README_SANITIZE_SCHEMA: Options = {
  ...defaultSchema,
  // defaultSchema.tagNames 已经含有 GitHub 风格允许的大部分标签（含 div/span/
  // details/summary/kbd/sub/sup/dl/dt/dd/s），这里只是把 README 常见、但
  // defaultSchema 没有的几个也列全，用 Set 去重避免同一个标签在数组里出现两次。
  // 明确不出现在这份名单里、也绝不会被添加的：script/style/iframe/object/embed/
  // form/svg/math/link/meta/base/template/noscript/audio/video/source——
  // 每一个都对应真实的攻击面（脚本执行、跨域取数、伪装表单回传、样式/元信息注入）。
  tagNames: Array.from(
    new Set([
      ...(defaultSchema.tagNames ?? []),
      "div",
      "span",
      "details",
      "summary",
      "figure",
      "figcaption",
      "kbd",
      "sub",
      "sup",
      "small",
      "u",
      "s",
      "mark",
      "dl",
      "dt",
      "dd",
      "abbr",
      "center",
    ]),
  ),
  attributes: {
    // 逐 key 展开而不是整体替换：hast-util-sanitize 对 schema 顶层字段是浅合并，
    // `attributes` 作为一个整体 key 会被这里的对象直接覆盖——不展开 defaultSchema
    // 原有的 code/table/img 等条目会导致它们连带丢失（比如 code 的 language-*
    // class 白名单），代码高亮会跟着失效。
    ...defaultSchema.attributes,
    // width/height 是属性不是 style，unsloth 那类 README 横幅靠它们定形——
    // 剥掉图片会变成原始像素尺寸，版式跑掉但不构成安全问题，仍按决策放行。
    img: [...(defaultSchema.attributes?.img ?? []), "width", "height"],
    // align 用于表格排版（HF README 常见），只放在这四个标签上，不放进 `'*'`
    // 通配符——精确到标签，不给其他元素顺带开口子。
    td: [...(defaultSchema.attributes?.td ?? []), "align"],
    th: [...(defaultSchema.attributes?.th ?? []), "align"],
    table: [...(defaultSchema.attributes?.table ?? []), "align"],
    tr: [...(defaultSchema.attributes?.tr ?? []), "align"],
  },
  // protocols（href 只放 http(s)/mailto 等，src 只放 http(s)）与 clobberPrefix
  // （README 里的 id/name 会被加上 `user-content-` 前缀，防止覆盖页面已有 DOM
  // 属性）都不在上面重新赋值，沿用 defaultSchema 的默认值。
};
