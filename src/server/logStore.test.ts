import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLogStore } from "./logStore";

let dir: string;
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), "llamapad-logstore-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("createLogStore", () => {
  it("追加写入并能回读", async () => {
    const s = createLogStore(dir);
    await s.append("llamapad-model", ["line 1", "line 2"]);
    await s.flush();
    expect(await s.tail("llamapad-model", 10)).toEqual(["line 1", "line 2"]);
  });
  it("超过上限时裁剪保留后半段", async () => {
    const s = createLogStore(dir, { maxBytes: 200 });
    for (let i = 0; i < 100; i++) await s.append("c", [`line-${i}`]);
    await s.flush();
    const lines = await s.tail("c", 1000);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.at(-1)).toBe("line-99");           // 最新的一定在
    expect(lines[0]).not.toBe("line-0");             // 最旧的已被裁掉
    expect(readFileSync(path.join(dir, "c.log")).length).toBeLessThanOrEqual(400);
  });
  it("tail(n) 只返回最后 n 行", async () => {
    const s = createLogStore(dir);
    await s.append("c", ["a", "b", "c", "d"]);
    await s.flush();
    expect(await s.tail("c", 2)).toEqual(["c", "d"]);
  });
  it("容器名含路径分隔符时拒绝写入（防目录穿越）", async () => {
    const s = createLogStore(dir);
    await expect(s.append("../../etc/passwd", ["x"])).rejects.toThrow(/容器名/);
  });
  it("读不存在的容器返回空数组不抛", async () => {
    expect(await createLogStore(dir).tail("never-existed", 10)).toEqual([]);
  });
  it("写目录不可用时静默降级不抛（日志落盘不能拖垮日志流）", async () => {
    // 拿一个已存在的普通文件当目录路径：mkdir 必失败（ENOTDIR），逼出真实的写盘错误。
    // 断言必须落在 flush 上——append 只入内存缓冲，永远不会碰盘，断言它不抛测不到任何东西。
    const blocker = path.join(dir, "blocker");
    writeFileSync(blocker, "x");
    const s = createLogStore(path.join(blocker, "logs"), { failSilently: true });
    await s.append("c", ["x"]);
    await expect(s.flush()).resolves.toBeUndefined();
  });
  it("failSilently 关闭时写盘失败照常抛给调用方", async () => {
    const blocker = path.join(dir, "blocker2");
    writeFileSync(blocker, "x");
    const s = createLogStore(path.join(blocker, "logs"));
    await s.append("c", ["x"]);
    await expect(s.flush()).rejects.toThrow();
  });
});
