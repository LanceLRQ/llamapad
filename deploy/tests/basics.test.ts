import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { REPO_ROOT, SCRIPT, runScript, sh } from "./sh";

// 每条用例都会 fork bash 并 source 整个脚本，全量并行跑多个测试文件时进程调度可能让
// 单条用例超过 vitest 默认的 5s，故本文件整体调宽超时（不改 vitest.config.ts）
vi.setConfig({ testTimeout: 30_000 });

const source = () => readFileSync(SCRIPT, "utf8");

function msgKeys(lang: "zh" | "en"): string[] {
  return [...source().matchAll(new RegExp(`^MSG_${lang}_([a-z0-9_]+)=`, "gm"))].map((m) => m[1]!).sort();
}

describe("脚本基础", () => {
  it("bash -n 语法检查通过", () => {
    expect(spawnSync("bash", ["-n", SCRIPT]).status).toBe(0);
  });

  it("脚本版本号与 package.json 一致", () => {
    const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as { version: string };
    expect(sh('printf %s "$LLAMAPAD_SCRIPT_VERSION"').stdout).toBe(pkg.version);
  });

  it("中英文案键集合一致且非空", () => {
    expect(msgKeys("zh").length).toBeGreaterThan(0);
    expect(msgKeys("zh")).toEqual(msgKeys("en"));
  });

  it("脚本里以字面量调用的文案键都已定义", () => {
    const defined = new Set(msgKeys("en"));
    const code = source()
      .split("\n")
      .filter((l) => !/^\s*#/.test(l) && !/^MSG_/.test(l))
      .join("\n");
    const used = [...code.matchAll(/(?:\$\(|^\s*|[;&|]\s*)t ([a-z][a-z0-9_]*)/gm)].map((m) => m[1]!);
    expect(used.length).toBeGreaterThan(0);
    expect(used.filter((k) => !defined.has(k))).toEqual([]);
  });

  it("detect_lang 优先级：--lang > LLAMAPAD_LANG > LC_ALL > LANG，zh 开头为中文", () => {
    const run = (body: string, env: Record<string, string>) =>
      sh(`${body}\ndetect_lang\nprintf %s "$LP_LANG"`, { env: { LLAMAPAD_LANG: "", LC_ALL: "", LANG: "", ...env } }).stdout;
    expect(run("OPT_LANG=en", { LLAMAPAD_LANG: "zh" })).toBe("en");
    expect(run("", { LLAMAPAD_LANG: "zh", LANG: "en_US.UTF-8" })).toBe("zh");
    expect(run("", { LC_ALL: "zh_CN.UTF-8", LANG: "en_US.UTF-8" })).toBe("zh");
    expect(run("", { LANG: "zh_TW.UTF-8" })).toBe("zh");
    expect(run("", { LANG: "C.UTF-8" })).toBe("en");
  });

  it("t 按当前语言取文案并做 printf 替换；未定义的键原样输出键名", () => {
    expect(sh("LP_LANG=zh; t unknown_option --bad").stdout).toContain("--bad");
    expect(sh("LP_LANG=en; t no_such_key_xyz").stdout).toBe("no_such_key_xyz");
  });

  it("help 与 version 可直接执行，中文环境输出中文用法", () => {
    expect(runScript(["help"], { env: { LLAMAPAD_LANG: "zh" } }).stdout).toContain("用法");
    expect(runScript(["version"]).stdout.trim()).toBe(
      (JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as { version: string }).version,
    );
  });

  it("未知选项返回退出码 2", () => {
    expect(runScript(["--bogus"]).code).toBe(2);
  });

  it("以 sh 调用时自动改用 bash 执行", () => {
    const r = spawnSync("sh", [SCRIPT, "version"], { encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });
});
