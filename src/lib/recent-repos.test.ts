import { describe, expect, it } from "vitest";

import { pickRecentRepos } from "./recent-repos";

const mk = (id: number, lastModified: number) => ({ id, lastModified });

describe("pickRecentRepos", () => {
  it("按 lastModified 倒序取前 5 个", () => {
    const rows = [mk(1, 100), mk(2, 900), mk(3, 500), mk(4, 700), mk(5, 300), mk(6, 800)];
    expect(pickRecentRepos(rows).map((r) => r.id)).toEqual([2, 6, 4, 3, 5]);
  });

  it("不足 5 个时原样返回（按顺序排好）", () => {
    expect(pickRecentRepos([mk(1, 100), mk(2, 900)]).map((r) => r.id)).toEqual([2, 1]);
  });

  it("lastModified 并列时按 id 倒序——新建的排前面，且结果稳定", () => {
    expect(pickRecentRepos([mk(1, 500), mk(3, 500), mk(2, 500)]).map((r) => r.id)).toEqual([3, 2, 1]);
  });

  it("不改动入参数组", () => {
    const rows = [mk(1, 100), mk(2, 900)];
    pickRecentRepos(rows);
    expect(rows.map((r) => r.id)).toEqual([1, 2]);
  });

  it("limit 可覆盖", () => {
    const rows = [mk(1, 100), mk(2, 900), mk(3, 500)];
    expect(pickRecentRepos(rows, 2).map((r) => r.id)).toEqual([2, 3]);
  });
});
