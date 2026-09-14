import { readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { sh, tempDir } from "./sh";

describe("通用工具", () => {
  it("sh_quote 生成可安全嵌入 sh 的单引号串", () => {
    const r = sh(`q=$(sh_quote "it's a b"); eval "set -- $q"; printf '%s' "$1"`);
    expect(r.stdout).toBe("it's a b");
  });

  it("abs_path：相对路径拼 PWD、展开 ~、去掉 /./ 与末尾斜杠，根目录保持 /", () => {
    const dir = tempDir();
    expect(sh('abs_path rel/x', { cwd: dir }).stdout).toBe(`${dir}/rel/x`);
    expect(sh('HOME=/home/u; abs_path "~/m"').stdout).toBe("/home/u/m");
    expect(sh("abs_path /a/./b/").stdout).toBe("/a/b");
    expect(sh("abs_path /").stdout).toBe("/");
  });

  it("gen_password 输出指定长度的字母数字", () => {
    const out = sh("gen_password 20").stdout;
    expect(out).toMatch(/^[A-Za-z0-9]{20}$/);
    expect(sh("gen_password 20").stdout).not.toBe(out);
  });

  it("fmt_kb 输出人类可读大小", () => {
    expect(sh(`fmt_kb ${38 * 1024 * 1024}`).stdout).toBe("38G");
    expect(sh(`fmt_kb ${Math.round(1.2 * 1024 * 1024 * 1024)}`).stdout).toBe("1.2T");
    expect(sh("fmt_kb 512").stdout).toBe("512K");
  });

  it("sha256_file 与 node 计算一致", () => {
    const f = path.join(tempDir(), "a.txt");
    writeFileSync(f, "hello\n");
    expect(sh(`sha256_file "${f}"`).stdout.trim()).toBe(
      "5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03",
    );
  });

  it("stat_owner 输出 uid:gid", () => {
    const f = tempDir();
    const st = statSync(f);
    expect(sh(`stat_owner "${f}"`).stdout.trim()).toBe(`${st.uid}:${st.gid}`);
  });
});

describe(".env 读写", () => {
  it("env_quote：安全字符不加引号，其余单引号包裹，空串为空", () => {
    expect(sh("env_quote abc-1.2:3@x").stdout).toBe("abc-1.2:3@x");
    expect(sh("env_quote 'a b$c'").stdout).toBe("'a b$c'");
    expect(sh('env_quote "{\\"k\\":1}"').stdout).toBe(`'{"k":1}'`);
    expect(sh('env_quote ""').stdout).toBe("");
  });

  it("env_set 原地替换已有键、追加缺失键，保留注释与其他变量，去掉同键重复行", () => {
    const f = path.join(tempDir(), ".env");
    writeFileSync(f, "# 我的注释\nFOO=bar\nPORT=1\nPORT=2\nOTHER=x");
    const r = sh(`env_set "${f}" PORT 28960 && env_set "${f}" NEW 'a b'`);
    expect(r.code).toBe(0);
    expect(readFileSync(f, "utf8")).toBe("# 我的注释\nFOO=bar\nPORT=28960\nOTHER=x\nNEW='a b'\n");
  });

  it("env_set 保留文件权限", () => {
    const f = path.join(tempDir(), ".env");
    writeFileSync(f, "A=1\n", { mode: 0o600 });
    sh(`env_set "${f}" A 2`);
    expect(statSync(f).mode & 0o777).toBe(0o600);
  });

  it("env_set 拒绝含单引号或换行的值（返回 2 且不改文件）", () => {
    const f = path.join(tempDir(), ".env");
    writeFileSync(f, "A=1\n");
    expect(sh(`env_set "${f}" A "it's"`).code).toBe(2);
    expect(sh(`env_set "${f}" A "$(printf 'a\\nb')"`).code).toBe(2);
    expect(readFileSync(f, "utf8")).toBe("A=1\n");
  });

  it("env_set 文件不存在时创建", () => {
    const f = path.join(tempDir(), "new.env");
    sh(`env_set "${f}" K v`);
    expect(readFileSync(f, "utf8")).toBe("K=v\n");
  });

  it("env_get 去引号、去行尾注释、取最后一次出现；缺键返回 1", () => {
    const f = path.join(tempDir(), ".env");
    writeFileSync(f, "A='x y'\nB=\"q\"\nC=plain # note\nD=1\nD=2\nE=\n");
    expect(sh(`env_get "${f}" A`).stdout).toBe("x y\n");
    expect(sh(`env_get "${f}" B`).stdout).toBe("q\n");
    expect(sh(`env_get "${f}" C`).stdout).toBe("plain\n");
    expect(sh(`env_get "${f}" D`).stdout).toBe("2\n");
    expect(sh(`env_get "${f}" E`)).toMatchObject({ code: 0, stdout: "\n" });
    expect(sh(`env_get "${f}" MISSING`).code).toBe(1);
  });

  it("env_get 引号值闭合引号后带空白与行尾注释时仍正确去引号", () => {
    const f = path.join(tempDir(), ".env");
    writeFileSync(f, 'A="hello" # trailing comment\nB=\'world\' # another\nC="{\\"a\\":1}"\n');
    expect(sh(`env_get "${f}" A`).stdout).toBe("hello\n");
    expect(sh(`env_get "${f}" B`).stdout).toBe("world\n");
    expect(sh(`env_get "${f}" C`).stdout).toBe('{\\"a\\":1}\n');
  });

  it("env_set 写入后 env_get 读回原值（含 $、空格、JSON）", () => {
    const f = path.join(tempDir(), ".env");
    const r = sh(`env_set "${f}" V '{"thinking":{"type":"disabled"}} $HOME' && env_get "${f}" V`);
    expect(r.stdout).toBe('{"thinking":{"type":"disabled"}} $HOME\n');
  });

  it("state_set / state_get 读写 $LP_HOME/.llamapad-state", () => {
    const home = tempDir();
    const r = sh(`LP_HOME="${home}"; state_set template_version 1 && state_get template_version`);
    expect(r.stdout).toBe("1\n");
    expect(readFileSync(path.join(home, ".llamapad-state"), "utf8")).toBe("template_version=1\n");
  });
});

describe("版本", () => {
  it("ver_cmp 比较语义版本，预发布低于正式版，容忍 v 前缀", () => {
    const cmp = (a: string, b: string) => sh(`ver_cmp ${a} ${b}`).stdout.trim();
    expect(cmp("0.2.0", "0.1.9")).toBe("1");
    expect(cmp("0.1.0", "0.1.0")).toBe("0");
    expect(cmp("v0.1.10", "0.1.9")).toBe("1");
    expect(cmp("1.0.0", "1.0.0-rc.1")).toBe("1");
    expect(cmp("1.0.0-rc.1", "1.0.0")).toBe("-1");
    expect(cmp("1.0.0-rc.1", "1.0.0-rc.2")).toBe("-1");
    expect(cmp("0.9.0", "1.0.0")).toBe("-1");
  });

  it("ver_latest_stable 取最大的正式版本，忽略预发布与 latest", () => {
    expect(sh("printf '%s\\n' latest 0.1.0 0.3.0-rc.1 0.2.0 v0.1.5 | ver_latest_stable").stdout).toBe("0.2.0\n");
    expect(sh("printf '%s\\n' latest | ver_latest_stable").code).toBe(1);
  });

  it("hub_tags_parse 从 Docker Hub tags JSON 取出 tag 名", () => {
    const json = '{"count":3,"results":[{"name":"latest","images":[{"os":"linux"}]},{"name": "0.2.0"},{"name":"0.1.0"}]}';
    expect(sh(`printf '%s' '${json}' | hub_tags_parse`).stdout).toBe("latest\n0.2.0\n0.1.0\n");
  });
});
