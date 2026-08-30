/**
 * 新建模型向导「存放位置」纯逻辑（阶段 4 D1）：命名空间与文件夹彻底解耦后，
 * 向导第 3 步需要独立选一个磁盘目录（可为 models 根，即空串），不再从
 * 命名空间推导——判定与 lib/wizard-steps.ts、lib/files-view.ts 一样下沉到
 * 这里配 .test.ts，vitest 是 environment: "node"，组件渲染测不了。
 */

/**
 * 目录 + 文件名安全拼接：dir 为空串代表 models 根，此时不能拼出带前导 "/"
 * 的路径（`${""}/x.gguf` = "/x.gguf"，会让 resolveModelFiles 按"根下文件
 * rel 就是裸文件名"的约定查不到任何命中）。与 server/filesApi.ts 的私有
 * 函数 joinRel 同一职责、同一写法，但那是服务端私有函数，客户端组件不能
 * import server 模块，这里单独放一份纯函数。
 */
export function joinDirPath(dir: string, name: string): string {
  return dir === "" ? name : `${dir}/${name}`;
}

/**
 * 目录清单补上"根目录"选项：GET /api/v1/folders 直接透传 scanTree 的
 * folder 字段，而 scanTree 只在 models 根确有直接文件时才会产出 folder: ""
 * 这一条（见 fsScanner.walkTree 注释）——根目录本身永远是合法的存放位置，
 * 不能因为它当前空手就从下拉里消失，否则一个全新安装、models 根下还没有
 * 任何散落文件的面板，用户将永远选不到"存到根目录"这个选项。
 */
export function withRootFolder(folders: readonly string[]): string[] {
  return folders.includes("") ? [...folders] : ["", ...folders];
}

/**
 * 默认存放位置：优先 "main"（历史上多数真机安装的主目录，即使现在与命名
 * 空间已经无关，仍是最常见的落点），否则取列表第一项；folders 为空数组
 * （全新安装，models 根下什么都还没有）兜底到 ""——根目录永远存在，不是
 * 异常状态。
 */
export function pickDefaultFolder(folders: readonly string[]): string {
  if (folders.includes("main")) return "main";
  return folders[0] ?? "";
}

/**
 * 解析初始存放位置：`?dir=` 深链优先，但只在它确实命中一个已知目录时采纳；
 * 缺失或指向不存在的目录一律静默落回默认值（不要报错——一个失效的深链
 * 不该把用户挡在向导之外，见阶段 4 简报 E）。
 *
 * `dirParam === ""` 单独判断、不经过 `folders.includes("")`：与
 * lib/files-view.ts 的 resolveFilesView 同样的理由——根目录是否出现在
 * folders 里取决于它当前有没有散落文件，但"跳到根目录"这个意图本身永远
 * 合法，不能因为根目录当前空手就被当成"不存在的目录"打回默认值。
 */
export function resolveInitialFolder(dirParam: string | null, folders: readonly string[]): string {
  if (dirParam === "") return "";
  if (dirParam !== null && folders.includes(dirParam)) return dirParam;
  return pickDefaultFolder(folders);
}

/** Base UI Select 需要非空 item value（空串在那里有歧义，见 lib/model-form.ts
 * 的 DEFAULT_OPTION 同款注释），根目录（""）在下拉里改用这个哨兵表达 */
export const ROOT_DIR_OPTION = "__root__";

/** 真实目录 → Select item value（根目录换成哨兵，其余原样） */
export function toSelectValue(dir: string): string {
  return dir === "" ? ROOT_DIR_OPTION : dir;
}

/** Select item value → 真实目录（toSelectValue 的逆操作） */
export function fromSelectValue(value: string): string {
  return value === ROOT_DIR_OPTION ? "" : value;
}
