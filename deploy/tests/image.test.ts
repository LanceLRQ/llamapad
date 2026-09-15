import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { installEnv, installedHome, pathWith, runScript, sh, stubBin, tempDir } from "./sh";

// 每条用例都会 fork bash 并 source 整个脚本，全量并行跑多个测试文件时进程调度可能让
// 单条用例超过 vitest 默认的 5s，故本文件整体调宽超时（不改 vitest.config.ts）
vi.setConfig({ testTimeout: 30_000 });

const lines = (...xs: string[]) => xs.map((x) => `${x}\n`).join("");

/** 造一个 repo_detect 认得出的仓库目录：含 Dockerfile 与 name=llamapad 的 package.json */
function fakeRepo(): string {
  const dir = tempDir("lp-repo-");
  writeFileSync(path.join(dir, "Dockerfile"), "FROM scratch\n");
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "llamapad", version: "0.1.0" }));
  return dir;
}

/** 给 self_update 用的 raw 下载 fixture：LLAMAPAD_RAW_BASE 指向本地文件树 */
function rawFixture(files: Record<string, string>): string {
  const raw = tempDir("lp-raw-");
  for (const [ref, body] of Object.entries(files)) {
    mkdirSync(path.join(raw, ref, "deploy"), { recursive: true });
    writeFileSync(path.join(raw, ref, "deploy/llamapad.sh"), body);
  }
  return `file://${raw}`;
}

describe("repo_detect / repo_resolve", () => {
  it("repo_detect：含 Dockerfile 且 package.json 的 name 为 llamapad 才算仓库", () => {
    expect(sh(`repo_detect "${fakeRepo()}"`).code).toBe(0);
    expect(sh(`repo_detect "${tempDir()}"`).code).toBe(1);
    const onlyDockerfile = tempDir();
    writeFileSync(path.join(onlyDockerfile, "Dockerfile"), "FROM scratch\n");
    expect(sh(`repo_detect "${onlyDockerfile}"`).code).toBe(1);
    const wrongName = tempDir();
    writeFileSync(path.join(wrongName, "Dockerfile"), "FROM scratch\n");
    writeFileSync(path.join(wrongName, "package.json"), JSON.stringify({ name: "other" }));
    expect(sh(`repo_detect "${wrongName}"`).code).toBe(1);
  });

  it("repo_resolve 优先级：--repo > $PWD > state 记录的 build_repo；找不到返回 1", () => {
    const repoCwd = fakeRepo();
    const repoOpt = fakeRepo();
    const home = tempDir();
    // 只有 state 记录时：用它
    sh(`LP_HOME="${home}"; state_set build_repo "${repoOpt}"`);
    expect(sh(`LP_HOME="${home}"; repo_resolve`, { cwd: tempDir() }).stdout).toBe(repoOpt);
    // $PWD 是仓库时优先于 state 记录
    expect(sh(`LP_HOME="${home}"; repo_resolve`, { cwd: repoCwd }).stdout).toBe(repoCwd);
    // --repo 优先于两者
    expect(sh(`LP_HOME="${home}"; OPT_REPO="${repoOpt}"; repo_resolve`, { cwd: repoCwd }).stdout).toBe(repoOpt);
    // --repo 指向的目录不是仓库：直接失败，不降级去找别的
    expect(sh(`LP_HOME="${home}"; OPT_REPO="${tempDir()}"; repo_resolve`, { cwd: repoCwd }).code).toBe(1);
    // state 记录的目录后来不再是仓库：找不到
    sh(`LP_HOME="${home}"; state_set build_repo "${tempDir()}"`);
    expect(sh(`LP_HOME="${home}"; repo_resolve`, { cwd: tempDir() }).code).toBe(1);
  });
});

describe("image_build", () => {
  it("HTTP_PROXY/HTTPS_PROXY 都设置时分别附加 --build-arg，构建上下文是仓库路径", () => {
    const bin = stubBin("docker");
    const log = path.join(tempDir(), "calls.log");
    writeFileSync(log, "");
    const repo = fakeRepo();
    const r = sh(`image_build "${repo}" llamapad:dev`, {
      env: { PATH: pathWith(bin), STUB_LOG: log, HTTP_PROXY: "http://p:1", HTTPS_PROXY: "http://p2:2" },
    });
    expect(r.code).toBe(0);
    expect(readFileSync(log, "utf8")).toBe(
      `docker build --build-arg HTTP_PROXY=http://p:1 --build-arg HTTPS_PROXY=http://p2:2 -t llamapad:dev ${repo}\n`,
    );
  });

  it("没有代理环境变量时不附加 build-arg", () => {
    const bin = stubBin("docker");
    const log = path.join(tempDir(), "calls.log");
    writeFileSync(log, "");
    const repo = fakeRepo();
    sh(`image_build "${repo}" llamapad:dev`, {
      env: { PATH: pathWith(bin), STUB_LOG: log, http_proxy: "", https_proxy: "", HTTP_PROXY: "", HTTPS_PROXY: "" },
    });
    expect(readFileSync(log, "utf8")).toBe(`docker build -t llamapad:dev ${repo}\n`);
  });

  it("小写 http_proxy/https_proxy 也识别，大写优先", () => {
    const bin = stubBin("docker");
    const log = path.join(tempDir(), "calls.log");
    writeFileSync(log, "");
    const repo = fakeRepo();
    sh(`image_build "${repo}" llamapad:dev`, {
      env: {
        PATH: pathWith(bin),
        STUB_LOG: log,
        http_proxy: "http://lower:1",
        HTTP_PROXY: "http://upper:1",
        https_proxy: "",
        HTTPS_PROXY: "",
      },
    });
    const calls = readFileSync(log, "utf8");
    expect(calls).toContain("--build-arg HTTP_PROXY=http://upper:1");
    expect(calls).not.toContain("lower");
  });

  it("构建失败返回 1 并报错", () => {
    const bin = stubBin("docker");
    const repo = fakeRepo();
    const r = sh(`image_build "${repo}" llamapad:dev`, { env: { PATH: pathWith(bin), STUB_BUILD_EXIT: "1" } });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("llamapad:dev");
  });
});

describe("choose_image 向导三种来源", () => {
  // 汇总页选中「镜像」这行回头重选时，choose_image 会再跑一遍，之前默认项
  // 永远是 UI_DEFAULT=0（Hub），哪怕用户上一轮明明选的是本地镜像。数字菜单模式下
  // UI_DEFAULT 不产生任何可观察的界面效果（只有方向键模式才用它定初始光标位置），没法
  // 通过菜单交互间接验证，这里直接遮蔽 ui_menu 把 choose_image 传进来的 UI_DEFAULT 值
  // 打到 stderr 上核对
  it("重新进入时默认项是当前已选的镜像，不是固定的 Hub", () => {
    const { env } = installEnv({ STUB_IMAGES: "llamapad\\tdev\\t2 minutes ago\\t900MB" });
    const r = sh(
      `wizard_defaults
W_IMAGE=llamapad W_VERSION=dev W_IMAGE_SOURCE=local
ui_menu() { printf 'UI_DEFAULT=%s\\n' "$UI_DEFAULT" >&2; return 1; }
choose_image`,
      { env },
    );
    // refs 数组顺序固定：0=Hub，1=本地镜像列表第一项（这里只有 llamapad:dev 一条）——
    // W_IMAGE/W_VERSION 与 refs[1]/versions[1] 一致，默认项应该落在 1
    expect(r.stderr).toContain("UI_DEFAULT=1");
  });

  it("首次进入（W_IMAGE 还是 wizard_defaults 给的 Hub 默认值）默认项仍是 0", () => {
    const { env } = installEnv();
    const r = sh(
      `wizard_defaults
ui_menu() { printf 'UI_DEFAULT=%s\\n' "$UI_DEFAULT" >&2; return 1; }
choose_image`,
      { env },
    );
    expect(r.stderr).toContain("UI_DEFAULT=0");
  });

  // 只比对名字和版本号不够——上一轮选的是「从仓库构建」，但本地恰好已经有
  // 同名同版本（llamapad:dev）的镜像时，只比名字/版本会误匹配到「本地镜像列表」那一项，
  // 默认项应该落在 build 这一项，不是 local
  it("同名同版本但来源不同（本地已有同名镜像、又选了从仓库构建）时按来源精确匹配默认项", () => {
    const repo = fakeRepo();
    const { env } = installEnv({ STUB_IMAGES: "llamapad\\tdev\\t2 minutes ago\\t900MB" });
    const r = sh(
      `wizard_defaults
W_IMAGE=llamapad W_VERSION=dev W_IMAGE_SOURCE=build
ui_menu() { printf 'UI_DEFAULT=%s\\n' "$UI_DEFAULT" >&2; return 1; }
choose_image`,
      { env, cwd: repo },
    );
    // refs 顺序：0=Hub，1=本地镜像列表（llamapad:dev，source=local），2=从仓库构建
    // （llamapad:dev，source=build）——名字版本号两个都撞了 llamapad:dev，唯一能分辨的
    // 只有 source，默认项必须落在 2，不能落在 1
    expect(r.stderr).toContain("UI_DEFAULT=2");
  });

  it("Docker Hub 选项：本地已有该 tag 时标注「本地已有」，选中后写入 .env", () => {
    const { env, root } = installEnv({ STUB_LOCAL_IMAGES: "lancelrq/llamapad:0.1.0" });
    const target = path.join(root, "hub-cached");
    const r = runScript([], { env, input: lines(target, "1", "1", "2", "", "1", "", "", "", "1", "n") });
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("already local, no download needed");
    const envText = readFileSync(path.join(target, ".env"), "utf8");
    expect(envText).toContain("LLAMAPAD_IMAGE=lancelrq/llamapad\n");
    expect(envText).toContain("LLAMAPAD_VERSION=0.1.0\n");
    expect(readFileSync(path.join(target, ".llamapad-state"), "utf8")).toContain("image_source=hub\n");
  });

  it("本地镜像列表：按仓库名过滤、排除 <none> 与和 Hub 选项相同的 tag，选中后写入 .env 且不问版本", () => {
    const stubImages = [
      "lancelrq/llamapad\\t0.1.0\\t3 hours ago\\t1.2GB", // 与 Hub 选项（1）相同，应被排除
      "llamapad\\tdev\\t2 minutes ago\\t900MB", // 本地构建镜像，应出现
      "llamapad\\t<none>\\t1 day ago\\t800MB", // <none> tag，应排除
      "unrelated/other\\tlatest\\t1 day ago\\t100MB", // 仓库名不匹配，应排除
    ].join("\\n");
    const { env, root } = installEnv({ STUB_IMAGES: stubImages });
    const target = path.join(root, "local-pick");
    const r = runScript([], { env, input: lines(target, "2", "1", "2", "", "1", "", "", "", "1", "n") });
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("llamapad:dev");
    expect(r.stderr).not.toContain("unrelated/other");
    expect(r.stderr).not.toContain("<none>");
    const envText = readFileSync(path.join(target, ".env"), "utf8");
    expect(envText).toContain("LLAMAPAD_IMAGE=llamapad\n");
    expect(envText).toContain("LLAMAPAD_VERSION=dev\n");
    expect(readFileSync(path.join(target, ".llamapad-state"), "utf8")).toContain("image_source=local\n");
  });

  it("从仓库构建成功：写出部署文件，state 记录来源与仓库路径", () => {
    const repo = fakeRepo();
    const { env, root } = installEnv();
    const target = path.join(root, "build-ok");
    const r = runScript([], { env, cwd: repo, input: lines(target, "2", "1", "2", "", "1", "", "", "", "1", "n") });
    expect(r.code).toBe(0);
    const envText = readFileSync(path.join(target, ".env"), "utf8");
    expect(envText).toContain("LLAMAPAD_IMAGE=llamapad\n");
    expect(envText).toContain("LLAMAPAD_VERSION=dev\n");
    const state = readFileSync(path.join(target, ".llamapad-state"), "utf8");
    expect(state).toContain("image_source=build\n");
    expect(state).toContain(`build_repo=${repo}\n`);
  });

  // 原用例只断言「没写部署文件/没留 state」，如果构建根本没被触发
  // （比如「构建镜像」这个选项没出现，wizard 直接用别的来源装完）也会一样不写文件、
  // 不留 state，测不出这条用例真正要测的东西。补断言日志确实调用过 docker build、
  // stderr 含构建失败文案，并且这些都发生在汇总确认页出现之后（构建在确认之后才执行）
  it("从仓库构建失败：不写任何部署文件、不留 state；构建确实在汇总确认之后才执行", () => {
    const repo = fakeRepo();
    const { env, root, log } = installEnv({ STUB_BUILD_EXIT: "1" });
    const target = path.join(root, "build-fail");
    const r = runScript([], { env, cwd: repo, input: lines(target, "2", "1", "2", "", "1", "", "", "", "1", "n") });
    expect(r.code).not.toBe(0);
    expect(existsSync(path.join(target, ".env"))).toBe(false);
    expect(existsSync(path.join(target, ".llamapad-state"))).toBe(false);
    expect(readFileSync(log, "utf8")).toContain("docker build");
    expect(r.stderr).toContain("Failed to build image llamapad:dev");
    const summaryIdx = r.stderr.indexOf("Review the configuration");
    const buildFailIdx = r.stderr.indexOf("Failed to build image");
    expect(summaryIdx).toBeGreaterThan(-1);
    expect(buildFailIdx).toBeGreaterThan(summaryIdx);
  });
});

describe("cmd_build", () => {
  it("构建成功：切换 .env 镜像与版本、记录 state，确认后重建容器", () => {
    const repo = fakeRepo();
    // STUB_LOCAL_IMAGES：桩不会真的因为 "docker build" 就让 image inspect 认得这个镜像，
    // 这里显式声明「构建后本地已有」，否则 cmd_restart 里 preflight_start 新增的本地镜像
    // 存在性检查会（正确地）拒绝启动，测不出 cmd_build 本身该验证的东西
    const { env, log } = installEnv({ STUB_RUNNING: "true", STUB_LOCAL_IMAGES: "llamapad:dev" });
    const home = installedHome(env);
    const r = sh(`LP_HOME="${home}"; docker_probe >/dev/null 2>&1; cmd_build`, { env, cwd: repo, input: "y\n" });
    expect(r.code).toBe(0);
    const envText = readFileSync(path.join(home, ".env"), "utf8");
    expect(envText).toContain("LLAMAPAD_IMAGE=llamapad\n");
    expect(envText).toContain("LLAMAPAD_VERSION=dev\n");
    const state = readFileSync(path.join(home, ".llamapad-state"), "utf8");
    expect(state).toContain("image_source=build\n");
    expect(state).toContain(`build_repo=${repo}\n`);
    const calls = readFileSync(log, "utf8");
    expect(calls).toContain("docker build");
    expect(calls).toContain("docker compose up -d --force-recreate");
  });

  it("找不到仓库时报错返回 1，不改动任何文件", () => {
    const { env } = installEnv();
    const home = installedHome(env);
    const r = sh(`LP_HOME="${home}"; docker_probe >/dev/null 2>&1; cmd_build`, { env, cwd: tempDir() });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("--repo");
    expect(readFileSync(path.join(home, ".env"), "utf8")).toContain("LLAMAPAD_IMAGE=lancelrq/llamapad\n");
  });

  it("--repo 覆盖仓库检测：当前目录不是仓库时也能定位", () => {
    const repo = fakeRepo();
    const { env } = installEnv();
    const home = installedHome(env);
    const r = sh(`LP_HOME="${home}"; OPT_REPO="${repo}"; docker_probe >/dev/null 2>&1; cmd_build`, {
      env,
      cwd: tempDir(),
      input: "n\n",
    });
    expect(r.code).toBe(0);
    expect(readFileSync(path.join(home, ".env"), "utf8")).toContain("LLAMAPAD_IMAGE=llamapad\n");
  });

  // 构建本身成功之后，写 .env/state 这条链子（env_set 两次 + state_set 两次，
  // 用 && 串起来）中途失败之前是静默 return 1，用户看不到任何提示，会以为构建也失败了；
  // 且原文案笼统地说「未切换」，但 state 写失败时 .env 其实已经切过去了，分两段报错
  it("state 写入失败要报错，且文案要说清楚 .env 其实已经切换成功了", () => {
    const repo = fakeRepo();
    const { env } = installEnv();
    const home = installedHome(env);
    // 构建本身（image_build/docker build）照常成功，两次 env_set 也照常成功，只让
    // 写入链后半段的 state_set 失败——验证这种「链子中途断」会报错、且报错文案准确
    const r = sh(
      `LP_HOME="${home}"; docker_probe >/dev/null 2>&1
state_set() { return 1; }
cmd_build`,
      { env, cwd: repo },
    );
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("Switched to the built image");
    expect(readFileSync(path.join(home, ".env"), "utf8")).toContain("LLAMAPAD_IMAGE=llamapad\n");
  });

  it(".env 写入失败要报错，且文案要说清楚构建出的镜像还没切换", () => {
    const repo = fakeRepo();
    const { env } = installEnv();
    const home = installedHome(env);
    const before = readFileSync(path.join(home, ".env"), "utf8");
    const r = sh(
      `LP_HOME="${home}"; docker_probe >/dev/null 2>&1
env_set() { return 1; }
cmd_build`,
      { env, cwd: repo },
    );
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("Failed to write .env");
    expect(r.stderr).not.toContain("Switched to the built image");
    expect(readFileSync(path.join(home, ".env"), "utf8")).toBe(before);
  });
});

describe("未安装时的 build（经 main 入口）", () => {
  // 开发机常带代理变量，image_build 会据此追加 --build-arg；清空后才能精确比对构建命令
  const NO_PROXY_ENV = { HTTP_PROXY: "", HTTPS_PROXY: "", http_proxy: "", https_proxy: "" };

  it("当前目录是仓库：只构建 llamapad:dev，不报未安装，也不在任何位置写配置", () => {
    const repo = fakeRepo();
    const { env, log } = installEnv(NO_PROXY_ENV);
    const r = runScript(["build"], { env, cwd: repo });
    expect(r.code).toBe(0);
    expect(r.stderr).not.toContain("not installed");
    expect(readFileSync(log, "utf8")).toContain(`docker build -t llamapad:dev ${repo}`);
    expect(r.stderr).toContain("llamapad:dev");
    expect(existsSync(path.join(repo, ".env"))).toBe(false);
    expect(existsSync(path.join(repo, ".llamapad-state"))).toBe(false);
    expect(existsSync(path.join(repo, "deploy"))).toBe(false);
  });

  it("--repo 指定仓库：当前目录不是仓库时也能构建", () => {
    const repo = fakeRepo();
    const { env, log } = installEnv(NO_PROXY_ENV);
    const r = runScript(["build", "--repo", repo], { env, cwd: tempDir() });
    expect(r.code).toBe(0);
    expect(readFileSync(log, "utf8")).toContain(`docker build -t llamapad:dev ${repo}`);
  });

  it("找不到仓库：提示在仓库根目录运行或用 --repo，而不是提示先安装", () => {
    const { env, log } = installEnv(NO_PROXY_ENV);
    const r = runScript(["build"], { env, cwd: tempDir() });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("--repo");
    expect(r.stderr).not.toContain("not installed");
    expect(readFileSync(log, "utf8")).not.toContain("docker build");
  });

  it("构建失败返回 1", () => {
    const repo = fakeRepo();
    const { env } = installEnv({ STUB_BUILD_EXIT: "1" });
    const r = runScript(["build"], { env, cwd: repo });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("Failed to build image llamapad:dev");
  });
});

// 原用例只断言「返回 0」与「没有 Build 字样」，选错下标映射到卸载之类
// 有严重副作用的命令也能让这两条断言照样通过——没有验证「选中的那一项确实是它该是的那个
// 命令」。改为断言每一项都有可观察的、该命令特有的副作用/文案，且验证构建镜像之后紧邻
// 的一项确实映射到升级（而不是因为插入构建项、下标算错而落到了别的命令上）
describe("main_menu：构建镜像项", () => {
  it("能找到仓库时插入「构建镜像」（升级之前），选中后触发 cmd_build；紧邻的下一项仍正确映射到升级", () => {
    const repo = fakeRepo();
    const { env, log } = installEnv({ STUB_BUILD_EXIT: "1" });
    const home = installedHome(env);
    const r = runScript([], {
      env: { ...env, LLAMAPAD_HOME: home },
      cwd: repo,
      input: "6\n\n7\n\n10\n", // 6=构建镜像（失败）；7=升级（紧邻构建镜像之后）；10=退出
    });
    expect(r.stderr).toContain("Build image");
    expect(readFileSync(log, "utf8")).toContain("docker build");
    // installEnv 默认的 LLAMAPAD_HUB_TAGS_URL 指向不存在的地址，未指定 --to 时
    // fetch_latest_version 必然失败——这条报错文案是「升级」这条分支特有的，
    // 能证明第 7 项确实映射到了 cmd_upgrade，不是因为下标算错落到了别的命令上
    expect(r.stderr).toContain("Failed to look up the latest version");
  });

  it("找不到仓库时不出现「构建镜像」，9 项菜单里第 3 项映射到状态、第 6 项映射到升级", () => {
    const { env, log } = installEnv({ STUB_PS: "Up 1 hour\\n" });
    const home = installedHome(env);
    const r = runScript([], {
      env: { ...env, LLAMAPAD_HOME: home },
      input: "3\n\n6\n\n9\n", // 3=状态；6=升级；9=退出
    });
    expect(r.code).toBe(0);
    expect(r.stderr).not.toContain("Build image");
    expect(r.stderr).toContain("Up 1 hour"); // 状态项的副作用：确实读到了 docker ps 的结果
    expect(readFileSync(log, "utf8")).toContain("docker ps");
    expect(r.stderr).toContain("Failed to look up the latest version"); // 升级项确实被触发
  });
});

describe("cmd_upgrade：当前使用本地镜像", () => {
  const localHome = (env: Record<string, string>) => {
    const home = installedHome(env);
    sh(
      `LP_HOME="${home}"; env_set "${home}/.env" LLAMAPAD_IMAGE llamapad; env_set "${home}/.env" LLAMAPAD_VERSION dev`,
      { env },
    );
    return home;
  };
  const image = (home: string) => readFileSync(path.join(home, ".env"), "utf8");

  it("无仓库时菜单只有「切 Hub / 取消」两项；选取消不改动任何东西", () => {
    const { env } = installEnv();
    const home = localHome(env);
    // UPGRADE_OUTCOME 预置为上一次调用可能留下的值：取消也要清空，不能残留
    const r = sh(
      `LP_HOME="${home}"; docker_probe >/dev/null 2>&1; UPGRADE_OUTCOME=applied
cmd_upgrade
rc=$?
printf 'OUTCOME=[%s]' "$UPGRADE_OUTCOME"
exit "$rc"`,
      { env, input: "2\n" },
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("OUTCOME=[]");
    expect(image(home)).toContain("LLAMAPAD_IMAGE=llamapad\n");
    expect(image(home)).toContain("LLAMAPAD_VERSION=dev\n");
  });

  it("有仓库时菜单第一项是「从仓库重新构建」，选中后走 cmd_build 流程", () => {
    const repo = fakeRepo();
    const { env, log } = installEnv({ STUB_RUNNING: "true", STUB_LOCAL_IMAGES: "llamapad:dev" });
    const home = localHome(env);
    const r = sh(`LP_HOME="${home}"; docker_probe >/dev/null 2>&1; cmd_upgrade`, {
      env,
      cwd: repo,
      input: "1\ny\n",
    });
    expect(r.code).toBe(0);
    expect(readFileSync(log, "utf8")).toContain("docker build");
  });

  // installEnv 默认的 LLAMAPAD_RAW_BASE 指向不存在的本地地址：目标版本 0.2.0 与脚本自身
  // 版本 0.1.0 不同，会先尝试自更新，下载必然失败，还会多问一次「仅升级镜像」——
  // 这与「本地镜像切 Hub」是两件独立的事，这里只是如实把这一步也带上
  it("切换到 Hub 并确认升级：镜像与版本都落到 Hub 目标版本", () => {
    const { env, log } = installEnv({ STUB_RUNNING: "true" });
    const home = localHome(env);
    const r = sh(`LP_HOME="${home}"; OPT_TO=0.2.0; docker_probe >/dev/null 2>&1; cmd_upgrade`, {
      env,
      input: "1\ny\ny\n", // 1=切 Hub；本地 dev 版本号按裁定强制当升级处理；自更新下载失败后确认仅升级镜像
    });
    expect(r.code).toBe(0);
    expect(image(home)).toContain("LLAMAPAD_IMAGE=lancelrq/llamapad\n");
    expect(image(home)).toContain("LLAMAPAD_VERSION=0.2.0\n");
    expect(readFileSync(log, "utf8")).toContain("docker compose pull");
  });

  it("切换到 Hub 后又拒绝升级：LLAMAPAD_IMAGE 与 LLAMAPAD_VERSION 都恢复成本地镜像原值", () => {
    const { env } = installEnv();
    const home = localHome(env);
    const r = sh(`LP_HOME="${home}"; OPT_TO=0.2.0; docker_probe >/dev/null 2>&1; cmd_upgrade`, {
      env,
      input: "1\nn\n",
    });
    expect(r.code).toBe(0);
    expect(image(home)).toContain("LLAMAPAD_IMAGE=llamapad\n");
    expect(image(home)).toContain("LLAMAPAD_VERSION=dev\n");
  });

  it("切换到 Hub 后 pull 失败：镜像与版本都回滚成本地镜像原值", () => {
    const { env, log } = installEnv({ STUB_RUNNING: "true", STUB_PULL_EXIT: "1" });
    const home = localHome(env);
    const r = sh(`LP_HOME="${home}"; OPT_TO=0.2.0; docker_probe >/dev/null 2>&1; cmd_upgrade`, {
      env,
      input: "1\ny\ny\n",
    });
    expect(r.code).not.toBe(0);
    expect(image(home)).toContain("LLAMAPAD_IMAGE=llamapad\n");
    expect(image(home)).toContain("LLAMAPAD_VERSION=dev\n");
    expect(readFileSync(log, "utf8")).toContain("docker compose pull");
  });

  // pull 成功、但 cmd_restart（compose up 或 wait_ready）失败时，之前的实现
  // 会返回 1 却不回滚 VERSION，外层又把 LLAMAPAD_IMAGE 改回本地名，留下 lancelrq/llamapad:0.1.0
  // 这种「镜像名是 Hub、版本号却还是旧的本地版本号」的不一致状态，之后 start 会因为这个
  // 组合镜像不存在而报错。裁定：pull 成功后就不再回滚，镜像名与版本号保持为新值这一对
  it("切换到 Hub、pull 成功但重建失败：镜像名与版本号保持为新值这一致的一对，不回滚", () => {
    const { env, log } = installEnv({ STUB_RUNNING: "true", STUB_COMPOSE_EXIT: "1" });
    const home = localHome(env);
    const r = sh(`LP_HOME="${home}"; OPT_TO=0.2.0; docker_probe >/dev/null 2>&1; cmd_upgrade`, {
      env,
      input: "1\ny\ny\n",
    });
    expect(r.code).not.toBe(0);
    expect(image(home)).toContain("LLAMAPAD_IMAGE=lancelrq/llamapad\n");
    expect(image(home)).toContain("LLAMAPAD_VERSION=0.2.0\n");
    expect(r.stderr).toContain("llamapad start");
    expect(readFileSync(log, "utf8")).toContain("docker compose pull");
  });

  // 之前的实现在「是否升级」问询之前（取最新版本的网络请求之前）就把
  // LLAMAPAD_IMAGE 写成了 Hub 镜像，这一步和用户是否愿意升级完全无关；期间 Ctrl-C／
  // 输入耗尽会留下一个用户从未确认过的镜像名。裁定：镜像名只在确认升级之后才写入。
  // 光看「拒绝后 .env 不变」拦不住「先写再原样恢复」这种实现——写完再复原，文件逐字节
  // 相同，测不出「曾经被改过」——所以这里遮蔽 ui_confirm，在它被调用、也就是「确认
  // 升级」这一刻本身，直接 dump .env 内容，跟调用前的内容比对，而不是等函数返回再看
  it("确认升级那一刻（ui_confirm 被调用时）.env 内容与调用前完全一致，不是先写后又改回来的", () => {
    const { env } = installEnv();
    const home = localHome(env);
    const before = image(home);
    const r = sh(
      // 直接重实现 ui_confirm 数字菜单模式下的行为（读一行、匹配 y/n）——不能 "command
      // ui_confirm" 调用原函数（bash 里函数不是外部命令，command 找不到它），所以这里
      // 只在「是否升级」这句问法（含 "Switch the image"）命中时先 dump .env 再读输入
      `LP_HOME="${home}"; OPT_TO=0.2.0; docker_probe >/dev/null 2>&1
ui_confirm() {
  case "$1" in
    *"Switch the image"*)
      printf '=== DUMP START ===\\n' >&2
      cat "${home}/.env" >&2
      printf '=== DUMP END ===\\n' >&2
      ;;
  esac
  local ans
  IFS= read -r ans <"$LP_TTY" || return 1
  case "$ans" in y | Y | yes | YES | 是) return 0 ;; *) return 1 ;; esac
}
cmd_upgrade`,
      { env, input: "1\nn\n" }, // 1=切 Hub；n=拒绝升级（是否升级那句的问法含 "Switch the image"）
    );
    const startIdx = r.stderr.indexOf("=== DUMP START ===");
    const endIdx = r.stderr.indexOf("=== DUMP END ===");
    expect(startIdx).toBeGreaterThan(-1);
    expect(endIdx).toBeGreaterThan(startIdx);
    const dumped = r.stderr.slice(startIdx + "=== DUMP START ===".length, endIdx);
    expect(dumped.trim()).toBe(before.trim());
    expect(image(home)).toBe(before);
  });

  // 上一轮的修复仍然不完整：走自更新的路径里，第一阶段在 self_update 成功、exec 之前
  // 就已经把镜像名写进 .env 了（版本号要到第二阶段才写）。Ctrl-C、下载卡住被杀、
  // 第二阶段新进程在走到 cmd_upgrade 之前就退出（比如 main() 里的 home_access_ok、
  // require_docker 检查没过；或者这里直接用一个 exit 1 的假脚本模拟）——.env 都会停在
  // 「镜像名是 Hub、版本号还是旧的本地版本号」这种不存在的组合上。第一阶段现在完全不写
  // 镜像名，只导出原镜像名供第二阶段失败时回滚；第二阶段自己决定要不要写、写成什么
  it("自更新成功后 exec 到新进程，新进程在到达 cmd_upgrade 之前就退出：.env 仍是原本地镜像这一对", () => {
    const { env } = installEnv();
    const home = localHome(env); // .env: llamapad:dev
    const body = '#!/usr/bin/env bash\nLLAMAPAD_SCRIPT_VERSION="0.2.0"\nexit 1\n'; // 模拟新进程在到达 cmd_upgrade 之前退出
    const r = sh(`LP_HOME="${home}"; OPT_TO=0.2.0; docker_probe >/dev/null 2>&1; cmd_upgrade`, {
      env: { ...env, LLAMAPAD_RAW_BASE: rawFixture({ "v0.2.0": body }) },
      input: "1\ny\n", // 1=切 Hub；y=确认升级（触发自更新，成功后 exec 到上面的假脚本）
    });
    expect(r.code).toBe(1); // exec 进的新进程以 1 退出
    expect(image(home)).toContain("LLAMAPAD_IMAGE=llamapad\n");
    expect(image(home)).toContain("LLAMAPAD_VERSION=dev\n");
  });

  // 只看返回后的 .env 拦不住「先写镜像名、拒绝后再原样恢复」的实现，所以和上面一样在
  // 「仅升级镜像」问询这一刻 dump .env；同时锁住 cmp≠0 时自更新失败的具体原因会被打印出来
  it("自更新本身下载失败（第一阶段自己就没走到 exec）：.env 同样从未被这次调用改动过", () => {
    const { env } = installEnv(); // 默认 LLAMAPAD_RAW_BASE 指向不存在的本地地址，下载必然失败
    const home = localHome(env);
    const before = image(home);
    const r = sh(
      `LP_HOME="${home}"; OPT_TO=0.2.0; docker_probe >/dev/null 2>&1
ui_confirm() {
  case "$1" in
    *"Upgrade only the image"*)
      printf '=== DUMP START ===\\n' >&2
      cat "${home}/.env" >&2
      printf '=== DUMP END ===\\n' >&2
      ;;
  esac
  local ans
  IFS= read -r ans <"$LP_TTY" || return 1
  case "$ans" in y | Y | yes | YES | 是) return 0 ;; *) return 1 ;; esac
}
cmd_upgrade`,
      { env, input: "1\ny\nn\n" }, // 1=切 Hub；y=确认升级；自更新失败后 n=拒绝仅升级镜像
    );
    expect(r.code).toBe(1);
    const startIdx = r.stderr.indexOf("=== DUMP START ===");
    const endIdx = r.stderr.indexOf("=== DUMP END ===");
    expect(startIdx).toBeGreaterThan(-1);
    expect(endIdx).toBeGreaterThan(startIdx);
    expect(r.stderr.slice(startIdx + "=== DUMP START ===".length, endIdx).trim()).toBe(before.trim());
    expect(r.stderr).toContain("Failed to download the script");
    expect(image(home)).toBe(before);
  });

  // 恢复镜像名时 env_set 的返回值之前被丢弃，失败了也当成功处理。镜像名与版本号现在
  // 一起写入（写 VERSION 那一刻），拒绝「仅升级镜像」这条路径已经不需要回滚了（.env
  // 到那一步还没被这次调用改过）；能触发到回滚的是「镜像名已写入、随后 pull 失败」——
  // 这里用目标版本＝脚本版本自身（不触发自更新）走最短路径到 pull，验证回滚失败会报错
  it("回滚镜像名时 env_set 失败要报错提示手动处理，不能悄悄吞掉", () => {
    const { env } = installEnv({ STUB_RUNNING: "true", STUB_PULL_EXIT: "1" });
    const home = localHome(env);
    const r = sh(
      `LP_HOME="${home}"; OPT_TO=0.1.0; docker_probe >/dev/null 2>&1
ENV_SET_IMAGE_CALLS=0
env_set() {
  [ "\$2" = LLAMAPAD_IMAGE ] || return 0
  ENV_SET_IMAGE_CALLS=\$((ENV_SET_IMAGE_CALLS + 1))
  [ "\$ENV_SET_IMAGE_CALLS" -ge 2 ] && return 1
  return 0
}
cmd_upgrade`,
      { env, input: "1\ny\n" }, // 1=切 Hub；y=确认升级（目标即脚本自身版本，不触发自更新）；随后 pull 失败触发回滚
    );
    expect(r.stderr).toContain("Failed to restore the image name");
  });

  // LLAMAPAD_UPGRADE_REVERT_IMAGE 导出后从不 unset 是根因，但只测「第一次选取消、
  // 第二次…」拦不住这个根因——「选取消」这条路径本来就不会导出 REVERT_IMAGE，改之
  // 前后行为一样，测不出问题。真正有意义的是「第一次真的选了切 Hub」这条路径，再看
  // 第二次调用会不会被第一次留下的痕迹污染。下面两条覆盖「第一次切 Hub 后拒绝升级」与
  // 「第一次切 Hub 且升级成功」这两种第一次调用会实际改变 from_local/REVERT_IMAGE
  // 相关状态的场景
  // 光看最终返回码/最终 .env 拦不住这个 bug：如果残留的 REVERT_IMAGE 让第二次调用误判
  // 成第二阶段，跳过菜单直接走「强制当升级处理」，第二次照样会在没有更多输入时被
  // ui_confirm 读到 EOF 当成「拒绝」，返回码与 .env 最终状态都恰好和「正常出菜单、用户
  // 选取消」一样——单看这两个断言测不出菜单被跳过了。用一个标记把两次调用的 stderr
  // 分开，直接断言第二次调用确实重新打印了本地镜像菜单的文案
  it("同一 shell 连续两次 cmd_upgrade：第一次切 Hub 后拒绝升级，第二次仍出本地镜像菜单且 .env 不变", () => {
    const { env } = installEnv();
    const home = localHome(env);
    const before = image(home);
    const r = sh(
      `LP_HOME="${home}"; OPT_TO=0.2.0; docker_probe >/dev/null 2>&1
cmd_upgrade
echo "FIRST=$?"
printf '=== SECOND CALL ===\\n' >&2
cmd_upgrade
echo "SECOND=$?"`,
      { env, input: "1\nn\n2\n" }, // 第一次：1=切 Hub，n=拒绝升级；第二次：无仓库时菜单只有两项，2=取消
    );
    expect(r.stdout).toContain("FIRST=0");
    expect(r.stdout).toContain("SECOND=0");
    expect(image(home)).toBe(before);
    const markerIdx = r.stderr.indexOf("=== SECOND CALL ===");
    expect(markerIdx).toBeGreaterThan(-1);
    const secondStderr = r.stderr.slice(markerIdx);
    expect(secondStderr).toContain("The panel is running a local image");
  });

  it("同一 shell 连续两次 cmd_upgrade：第一次切 Hub 且升级成功，第二次是正常的 Hub 升级流程（不再要求重新确认）", () => {
    const { env } = installEnv({ STUB_RUNNING: "true" });
    const home = localHome(env);
    const r = sh(
      // 目标版本取脚本自身版本（0.1.0）：不触发自更新，第一次直接走完整个升级流程；
      // 第二次目标版本与当前一致（cmp=0），正确实现会走「已是最新」分支直接返回，不
      // 需要额外输入；如果被残留状态误判成「本地镜像切 Hub」，会强制 cmp=1 跳过这条
      // 快捷路径、重新问一遍「是否升级」，没有更多输入时靠 EOF 兜底返回 0——用一个标记
      // 把两次调用的 stderr 分开，直接断言第二次没有重新问过这句话
      `LP_HOME="${home}"; docker_probe >/dev/null 2>&1
OPT_TO=0.1.0; cmd_upgrade
echo "FIRST=$?"
printf '=== SECOND CALL ===\\n' >&2
OPT_TO=0.1.0; cmd_upgrade
echo "SECOND=$?"`,
      { env, input: "1\ny\n" }, // 1=切 Hub；y=确认升级
    );
    expect(r.stdout).toContain("FIRST=0");
    expect(r.stdout).toContain("SECOND=0");
    expect(image(home)).toContain("LLAMAPAD_IMAGE=lancelrq/llamapad\n");
    expect(image(home)).toContain("LLAMAPAD_VERSION=0.1.0\n");
    const markerIdx = r.stderr.indexOf("=== SECOND CALL ===");
    expect(markerIdx).toBeGreaterThan(-1);
    const secondStderr = r.stderr.slice(markerIdx);
    expect(secondStderr).not.toContain("Switch the image from");
    expect(secondStderr).toContain("is already");
  });

  // 第二阶段进程（自更新 exec 过来）带着 LLAMAPAD_UPGRADE_STAGE=2 与
  // LLAMAPAD_UPGRADE_REVERT_IMAGE 重新进入 cmd_upgrade。第一阶段不写 .env 的镜像名，
  // 所以第二阶段进来时 .env 仍是本地镜像原值这一对（llamapad:dev），fixture 照此构造
  const stage2Env = (env: Record<string, string>) => ({
    ...env,
    LLAMAPAD_UPGRADE_STAGE: "2",
    LLAMAPAD_UPGRADE_CONFIRMED: "1",
    LLAMAPAD_UPGRADE_REVERT_IMAGE: "llamapad",
  });

  // 镜像名由第二阶段自己写成 Hub——第一阶段只导出了原镜像名，这一步没人替它做
  it("第二阶段带 REVERT_IMAGE、升级成功：镜像名由第二阶段写成 Hub，版本号为目标版本", () => {
    const { env, log } = installEnv({ STUB_RUNNING: "true" });
    const home = localHome(env);
    const r = sh(`LP_HOME="${home}"; OPT_TO=0.2.0; docker_probe >/dev/null 2>&1; cmd_upgrade`, {
      env: stage2Env(env),
    });
    expect(r.code).toBe(0);
    expect(image(home)).toContain("LLAMAPAD_IMAGE=lancelrq/llamapad\n");
    expect(image(home)).toContain("LLAMAPAD_VERSION=0.2.0\n");
    expect(readFileSync(log, "utf8")).toContain("docker compose pull");
  });

  // pull 失败时镜像名应该恢复成 REVERT_IMAGE 记录的原值，且该环境变量读取后立即被清空
  // （不会泄漏给同一 shell 里后续的调用）
  it("第二阶段带 REVERT_IMAGE：pull 失败时镜像名恢复为该值，且变量读取后已 unset", () => {
    const { env, log } = installEnv({ STUB_RUNNING: "true", STUB_PULL_EXIT: "1" });
    const home = localHome(env);
    const r = sh(
      `LP_HOME="${home}"; OPT_TO=0.2.0; docker_probe >/dev/null 2>&1
cmd_upgrade
rc=$?
printf 'REVERT=[%s]' "\${LLAMAPAD_UPGRADE_REVERT_IMAGE:-}"
exit "$rc"`,
      { env: stage2Env(env) },
    );
    expect(r.code).not.toBe(0);
    expect(image(home)).toContain("LLAMAPAD_IMAGE=llamapad\n");
    expect(image(home)).toContain("LLAMAPAD_VERSION=dev\n");
    expect(readFileSync(log, "utf8")).toContain("docker compose pull");
    expect(r.stdout).toBe("REVERT=[]");
  });

  // 第二阶段进程里 want_image 之前是空字符串（cmd_upgrade 只在自己发起菜单的
  // 「hub」分支才设置它，第二阶段分支漏了），导致重建失败的提示文案变成
  // "Switched to image :0.2.0"（镜像名缺失）。现在第二阶段分支也会把 want_image 设成
  // Hub 镜像名，提示文案应该完整
  it("第二阶段带 REVERT_IMAGE、重建失败：提示文案里的镜像名是完整的 Hub 镜像引用，不是空的", () => {
    const { env } = installEnv({ STUB_RUNNING: "true", STUB_COMPOSE_EXIT: "1" });
    const home = localHome(env);
    const r = sh(`LP_HOME="${home}"; OPT_TO=0.2.0; docker_probe >/dev/null 2>&1; cmd_upgrade`, {
      env: stage2Env(env),
    });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("Switched to image lancelrq/llamapad:0.2.0");
    expect(r.stderr).not.toContain("Switched to image :");
    // pull 已成功：镜像名与版本号保留新值这一对，与提示文案一致
    expect(image(home)).toContain("LLAMAPAD_IMAGE=lancelrq/llamapad\n");
    expect(image(home)).toContain("LLAMAPAD_VERSION=0.2.0\n");
  });

  // 单独存在 LLAMAPAD_UPGRADE_REVERT_IMAGE、但没有 LLAMAPAD_UPGRADE_STAGE=2 时
  // （比如某种残留），不应该被当成第二阶段——必须两者同时成立才生效
  it("只有 REVERT_IMAGE 没有 STAGE=2 时不生效，仍然走正常的本地镜像菜单", () => {
    const { env } = installEnv();
    const home = localHome(env);
    const r = sh(`LP_HOME="${home}"; docker_probe >/dev/null 2>&1; cmd_upgrade`, {
      env: { ...env, LLAMAPAD_UPGRADE_REVERT_IMAGE: "some-stale-value" },
      input: "2\n", // 若被误判成第二阶段会直接跳过菜单；这里正常出菜单时选「取消」
    });
    expect(r.code).toBe(0);
    expect(image(home)).toContain("LLAMAPAD_IMAGE=llamapad\n");
  });
});

describe("preflight_start：本地镜像缺失", () => {
  it("本地镜像不存在时拒绝启动", () => {
    const { env, log } = installEnv();
    const home = installedHome(env);
    sh(
      `LP_HOME="${home}"; env_set "${home}/.env" LLAMAPAD_IMAGE llamapad; env_set "${home}/.env" LLAMAPAD_VERSION dev`,
      { env },
    );
    const r = sh(`LP_HOME="${home}"; docker_probe >/dev/null 2>&1; cmd_start`, { env });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("llamapad build");
    expect(readFileSync(log, "utf8")).not.toContain("compose up");
  });

  it("本地镜像存在时正常启动", () => {
    const { env } = installEnv({ STUB_LOCAL_IMAGES: "llamapad:dev" });
    const home = installedHome(env);
    sh(
      `LP_HOME="${home}"; env_set "${home}/.env" LLAMAPAD_IMAGE llamapad; env_set "${home}/.env" LLAMAPAD_VERSION dev`,
      { env },
    );
    const r = sh(`LP_HOME="${home}"; docker_probe >/dev/null 2>&1; cmd_start`, { env });
    expect(r.code).toBe(0);
  });
});

describe("cmd_doctor：镜像检查", () => {
  const dockerGid = (env: Record<string, string>) => String(statSync(env.LLAMAPAD_DOCKER_SOCK!).gid);

  it("Hub 镜像本地已拉取：ok", () => {
    const { env } = installEnv({ STUB_LOCAL_IMAGES: "lancelrq/llamapad:0.1.0" });
    const home = installedHome(env, { dockerGid: dockerGid(env) });
    const r = sh(`LP_HOME="${home}"; cmd_doctor`, { env });
    expect(r.stderr).toContain("Image lancelrq/llamapad:0.1.0 is ready");
  });

  it("Hub 镜像尚未拉取：warn，不计入失败", () => {
    const { env } = installEnv();
    const home = installedHome(env, { dockerGid: dockerGid(env) });
    const r = sh(`LP_HOME="${home}"; cmd_doctor`, { env });
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("has not been pulled yet");
  });

  it("本地镜像不存在：fail 并建议 llamapad build", () => {
    const { env } = installEnv();
    const home = installedHome(env, { dockerGid: dockerGid(env) });
    sh(
      `LP_HOME="${home}"; env_set "${home}/.env" LLAMAPAD_IMAGE llamapad; env_set "${home}/.env" LLAMAPAD_VERSION dev`,
      { env },
    );
    const r = sh(`LP_HOME="${home}"; cmd_doctor`, { env });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("Local image llamapad:dev does not exist");
    expect(r.stderr).toContain("llamapad build");
  });

  // docker 不可用时 image_local_exists 根本没法给出可信结果（会把「查不到」误报成
  // 「镜像缺失」，和真的缺失混在一起，掩盖了 docker 本身不可用这个更根本的问题，doctor 已经单独
  // 有一行报告了）；.env 没有 LLAMAPAD_VERSION 时 image_ref 拼出来的引用本就不完整，同样该跳过
  it("docker 不可用时跳过镜像检查这一项，不误报缺失、不额外计入失败", () => {
    const { env } = installEnv();
    const home = installedHome(env, { dockerGid: dockerGid(env) });
    const r = sh(`LP_HOME="${home}"; cmd_doctor`, { env: { ...env, LLAMAPAD_DOCKER_BIN: "/nonexistent/docker" } });
    // docker 本身不可用已经会让 fails 非零（既有的 doc_docker_ok 检查），但输出里不应该
    // 再额外出现「本地镜像不存在」这类由镜像检查产生的文案——那是在无效前提下做的误判
    expect(r.stderr).not.toContain("does not exist");
    expect(r.stderr).not.toContain("has not been pulled yet");
    expect(r.stderr).not.toContain("is ready");
  });

  it(".env 缺 LLAMAPAD_VERSION 时跳过镜像检查这一项", () => {
    const { env } = installEnv();
    const home = installedHome(env, { dockerGid: dockerGid(env) });
    const envFile = path.join(home, ".env");
    writeFileSync(envFile, readFileSync(envFile, "utf8").replace(/^LLAMAPAD_VERSION=.*\n/m, ""));
    const r = sh(`LP_HOME="${home}"; cmd_doctor`, { env });
    expect(r.stderr).not.toContain("does not exist");
    expect(r.stderr).not.toContain("has not been pulled yet");
    expect(r.stderr).not.toContain("is ready");
  });
});

// adopt_run 按第一个冒号拆「名:tag」，host:5000/x:tag 这类带 registry:port 的
// 引用会被拆错（第一个冒号并不是 tag 分隔符）；tag 恰好是 ${LLAMAPAD_VERSION} 插值占位符时
// 会把字面量 "${...}" 写进 .env，接管后镜像名根本不存在，起不来；没有 tag 时「沿用」选项
// 也不出现（应按 Docker 语义补 latest 并出现）。改法：按最后一个冒号拆，要求 tag 不含
// "/"，先去掉 @sha256 digest，tag 是插值占位符时读 .env，无 tag 按 latest。
describe("image_split_ref", () => {
  it("host:5000/x:tag 按最后一个冒号拆，不会把 registry:port 误当 tag", () => {
    expect(sh('image_split_ref "host:5000/x:tag"').stdout).toBe("host:5000/x\ttag\n");
  });

  it("没有 tag（比如 host:5000/x 这种冒号只属于 registry:port）按 Docker 语义补 latest", () => {
    expect(sh('image_split_ref "host:5000/x"').stdout).toBe("host:5000/x\tlatest\n");
  });

  it("完全没有冒号时按 latest", () => {
    expect(sh('image_split_ref "myimage"').stdout).toBe("myimage\tlatest\n");
  });

  it("tag 是插值占位符时原样返回，交给调用方决定怎么解析", () => {
    // 单引号包住参数，防止 bash 在调用 image_split_ref 之前就把 ${LLAMAPAD_VERSION} 展开掉——
    // 真实场景里这段文本来自 grep 出的 compose 原文，同样是没被 shell 解释过的字面量
    expect(sh("image_split_ref 'myimage:${LLAMAPAD_VERSION}'").stdout).toBe("myimage\t${LLAMAPAD_VERSION}\n");
  });

  it("先去掉 @sha256 digest 后缀再拆", () => {
    expect(sh('image_split_ref "myimage:v9@sha256:abcdef0123"').stdout).toBe("myimage\tv9\n");
  });

  // 带修饰符的插值 tag（本脚本自己的 compose 模板就是 ${LLAMAPAD_VERSION:?...} 这种写法）：
  // 按最后一个冒号拆会拆进 ${...} 内部，把 :?/:- 这类修饰符错当成 tag 分隔符
  it("tag 是带 :? 修饰符的插值表达式时整体原样返回，不会被内部的冒号拆坏", () => {
    expect(sh("image_split_ref 'myimage:${LLAMAPAD_VERSION:?set it}'").stdout).toBe(
      "myimage\t${LLAMAPAD_VERSION:?set it}\n",
    );
  });

  it("tag 是带 :- 修饰符的插值表达式时整体原样返回", () => {
    expect(sh("image_split_ref 'fork/llamapad:${LLAMAPAD_VERSION:-0.1.0}'").stdout).toBe(
      "fork/llamapad\t${LLAMAPAD_VERSION:-0.1.0}\n",
    );
  });
});

describe("adopt_run：沿用本地镜像", () => {
  const uid = process.getuid?.() ?? 1000;
  const gid = process.getgid?.() ?? 1000;
  function oldDeployWithImage(image: string, envExtra = ""): string {
    const home = tempDir();
    writeFileSync(
      path.join(home, "docker-compose.yml"),
      `services:\n  llamapad:\n    image: ${image}\n    volumes:\n      - ./models:/host-models\n`,
    );
    writeFileSync(path.join(home, ".env"), `PANEL_ADMIN_PASSWORD=old-pass-123\nPUID=${uid}\nPGID=${gid}\n${envExtra}`);
    mkdirSync(path.join(home, "data"));
    mkdirSync(path.join(home, "models"));
    return home;
  }

  it("旧 compose 的自定义镜像能拆出「名:tag」时，选择沿用会原样写入 .env", () => {
    const home = oldDeployWithImage("myimage:v9");
    const { env } = installEnv();
    const r = sh(`LP_HOME="${home}"; adopt_run`, { env, input: lines("1", "", "n") });
    expect(r.code).toBe(0);
    const envText = readFileSync(path.join(home, ".env"), "utf8");
    expect(envText).toContain("LLAMAPAD_IMAGE=myimage\n");
    expect(envText).toContain("LLAMAPAD_VERSION=v9\n");
    expect(readFileSync(path.join(home, ".llamapad-state"), "utf8")).toContain("image_source=local\n");
  });

  it("host:5000/x:tag 这类带 registry:port 的自定义镜像，沿用后写入正确拆分的一对", () => {
    const home = oldDeployWithImage("host:5000/x:tag");
    const { env } = installEnv();
    const r = sh(`LP_HOME="${home}"; adopt_run`, { env, input: lines("1", "", "n") });
    expect(r.code).toBe(0);
    const envText = readFileSync(path.join(home, ".env"), "utf8");
    expect(envText).toContain("LLAMAPAD_IMAGE=host:5000/x\n");
    expect(envText).toContain("LLAMAPAD_VERSION=tag\n");
  });

  it("没有 tag 的自定义镜像仍然出现「沿用」选项，按 latest 写入", () => {
    const home = oldDeployWithImage("myimage");
    const { env } = installEnv();
    const r = sh(`LP_HOME="${home}"; adopt_run`, { env, input: lines("1", "", "n") });
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("Keep using the local image myimage:latest");
    const envText = readFileSync(path.join(home, ".env"), "utf8");
    expect(envText).toContain("LLAMAPAD_IMAGE=myimage\n");
    expect(envText).toContain("LLAMAPAD_VERSION=latest\n");
  });

  it("tag 是 ${LLAMAPAD_VERSION} 插值占位符时读 .env 的版本号，不会把字面量写进去", () => {
    const home = oldDeployWithImage("myimage:${LLAMAPAD_VERSION}", "LLAMAPAD_VERSION=7.7.7\n");
    const { env } = installEnv();
    const r = sh(`LP_HOME="${home}"; adopt_run`, { env, input: lines("1", "", "n") });
    expect(r.code).toBe(0);
    const envText = readFileSync(path.join(home, ".env"), "utf8");
    expect(envText).toContain("LLAMAPAD_IMAGE=myimage\n");
    expect(envText).toContain("LLAMAPAD_VERSION=7.7.7\n");
  });

  it("tag 是插值占位符但 .env 缺 LLAMAPAD_VERSION 时不出现「沿用」，只能改用 Hub", () => {
    const home = oldDeployWithImage("myimage:${LLAMAPAD_VERSION}"); // 没有 envExtra，.env 没有 LLAMAPAD_VERSION
    const { env } = installEnv();
    // 菜单只剩「改用 Hub」一项，数字菜单模式下空输入不会自动选中唯一项，仍要显式输入 "1"；
    // 选中后走既有的「改用 Hub」分支，会多问一次目标版本
    const r = sh(`LP_HOME="${home}"; adopt_run`, { env, input: lines("1", "", "", "n") });
    expect(r.code).toBe(0);
    expect(r.stderr).not.toContain("Keep using the local image");
  });
});

describe("parse_args --repo", () => {
  it("支持 --repo DIR 与 --repo=DIR 两种写法", () => {
    expect(sh('parse_args --repo /a/b; printf %s "$OPT_REPO"').stdout).toBe("/a/b");
    expect(sh('parse_args --repo=/c/d; printf %s "$OPT_REPO"').stdout).toBe("/c/d");
  });
});
