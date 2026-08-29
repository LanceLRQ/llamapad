import { describe, expect, it } from "vitest";

import { buildShardIndex } from "./file-shards";

describe("buildShardIndex", () => {
  it("非分片文件 key=null、size=1", () => {
    const index = buildShardIndex([{ rel: "main/qwen2.5-7b-instruct-q4_k_m.gguf" }]);
    expect(index.get("main/qwen2.5-7b-instruct-q4_k_m.gguf")).toEqual({ key: null, size: 1 });
  });

  it("同组三片共享同一个 key，size=3", () => {
    const files = [
      { rel: "main/model-00001-of-00003.gguf" },
      { rel: "main/model-00002-of-00003.gguf" },
      { rel: "main/model-00003-of-00003.gguf" },
    ];
    const index = buildShardIndex(files);
    const keys = files.map((f) => index.get(f.rel)?.key);
    expect(keys[0]).not.toBeNull();
    expect(keys[0]).toBe(keys[1]);
    expect(keys[1]).toBe(keys[2]);
    for (const f of files) {
      expect(index.get(f.rel)?.size).toBe(3);
    }
  });

  it("与顺序无关：入参乱序时结果与有序时完全一致", () => {
    const ordered = [
      { rel: "main/model-00001-of-00003.gguf" },
      { rel: "main/model-00002-of-00003.gguf" },
      { rel: "main/model-00003-of-00003.gguf" },
      { rel: "main/other.gguf" },
    ];
    const shuffled = [ordered[3], ordered[1], ordered[0], ordered[2]]; // other, 2, 1, 3
    const indexOrdered = buildShardIndex(ordered);
    const indexShuffled = buildShardIndex(shuffled);

    for (const f of ordered) {
      expect(indexShuffled.get(f.rel)).toEqual(indexOrdered.get(f.rel));
    }
  });

  it("跨目录同名前缀不串组", () => {
    const files = [
      { rel: "main/model-00001-of-00002.gguf" },
      { rel: "main/model-00002-of-00002.gguf" },
      { rel: "vision/model-00001-of-00002.gguf" },
      { rel: "vision/model-00002-of-00002.gguf" },
    ];
    const index = buildShardIndex(files);
    expect(index.get("main/model-00001-of-00002.gguf")?.key).not.toBe(
      index.get("vision/model-00001-of-00002.gguf")?.key,
    );
    expect(index.get("main/model-00001-of-00002.gguf")?.size).toBe(2);
    expect(index.get("vision/model-00001-of-00002.gguf")?.size).toBe(2);
  });

  it("声明的分片总数（total）不同不归为一组", () => {
    const files = [
      { rel: "main/model-00001-of-00002.gguf" },
      { rel: "main/model-00002-of-00002.gguf" },
      { rel: "main/model-00001-of-00005.gguf" },
    ];
    const index = buildShardIndex(files);
    expect(index.get("main/model-00001-of-00002.gguf")?.key).not.toBe(
      index.get("main/model-00001-of-00005.gguf")?.key,
    );
    expect(index.get("main/model-00001-of-00005.gguf")?.size).toBe(1);
  });
});
