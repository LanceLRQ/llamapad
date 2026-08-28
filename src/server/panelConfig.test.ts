import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  getPanelConfig,
  getModelsHost,
  getModelsHostSource,
  setDiscoveredModelsHost,
  _resetPanelConfigForTest,
} from "./panelConfig";

/** 在 tmp 下建独立临时目录，返回 panel.yaml 的绝对路径 */
function tmpConfigPath(label: string): string {
  const dir = path.join(tmpdir(), `llamapad-panelConfig-${label}-${process.pid}`);
  mkdirSync(dir, { recursive: true });
  return path.join(dir, "panel.yaml");
}

/** 写入 yaml 内容（覆盖式），返回文件绝对路径 */
function writeConfig(label: string, content: string): string {
  const file = tmpConfigPath(label);
  writeFileSync(file, content, "utf8");
  return file;
}

/** 每个用例自备 try/finally：还原 PANEL_CONFIG 并清空配置单例 */
describe("getPanelConfig（panel.yaml 读取）", () => {
  it("文件缺失时返回全默认值", () => {
    const envBackup = process.env.PANEL_CONFIG;
    const missing = tmpConfigPath("missing");
    process.env.PANEL_CONFIG = missing;
    try {
      expect(existsSync(missing)).toBe(false); // 前置：文件确实不存在
      const cfg = getPanelConfig();
      expect(cfg.paths.models.host).toBeUndefined();
      expect(cfg.paths.models.panel).toBe("/host-models");
      expect(cfg.listen.host).toBe("0.0.0.0");
      expect(cfg.listen.port).toBe(8080);
      expect(cfg.proxy).toBeUndefined();
    } finally {
      _resetPanelConfigForTest();
      if (envBackup === undefined) delete process.env.PANEL_CONFIG;
      else process.env.PANEL_CONFIG = envBackup;
    }
  });

  it("合法文件读出指定值，其余字段取默认", () => {
    const envBackup = process.env.PANEL_CONFIG;
    const file = writeConfig(
      "valid",
      "paths:\n  models:\n    host: /data/models\n    panel: /mnt/models\n",
    );
    process.env.PANEL_CONFIG = file;
    try {
      const cfg = getPanelConfig();
      expect(cfg.paths.models.host).toBe("/data/models");
      expect(cfg.paths.models.panel).toBe("/mnt/models");
      expect(cfg.listen.host).toBe("0.0.0.0"); // 未写的字段取默认
      expect(cfg.listen.port).toBe(8080);
      expect(cfg.proxy).toBeUndefined();
    } finally {
      _resetPanelConfigForTest();
      if (envBackup === undefined) delete process.env.PANEL_CONFIG;
      else process.env.PANEL_CONFIG = envBackup;
    }
  });

  it("字段值非法时抛错，message 含字段路径与文件路径", () => {
    const envBackup = process.env.PANEL_CONFIG;
    const file = writeConfig("invalid-value", "listen:\n  port: 70000\n");
    process.env.PANEL_CONFIG = file;
    try {
      expect(() => getPanelConfig()).toThrow(Error);
      expect(() => getPanelConfig()).toThrow(/listen\.port/); // 指名到字段
      expect(() => getPanelConfig()).toThrow(file); // 指名到文件
    } finally {
      _resetPanelConfigForTest();
      if (envBackup === undefined) delete process.env.PANEL_CONFIG;
      else process.env.PANEL_CONFIG = envBackup;
    }
  });

  it("yaml 语法错误时抛错，message 含文件路径", () => {
    const envBackup = process.env.PANEL_CONFIG;
    // 制造语法错误：键后紧跟未缩进的映射片段
    const file = writeConfig("invalid-yaml", "listen:\n  port: 8080\n bad indent: [");
    process.env.PANEL_CONFIG = file;
    try {
      expect(() => getPanelConfig()).toThrow(file); // 指名到文件
    } finally {
      _resetPanelConfigForTest();
      if (envBackup === undefined) delete process.env.PANEL_CONFIG;
      else process.env.PANEL_CONFIG = envBackup;
    }
  });

  it("同 env 下缓存单例；_resetPanelConfigForTest 后可读到新文件", () => {
    const envBackup = process.env.PANEL_CONFIG;
    const fileA = writeConfig("singleton-a", "listen:\n  port: 9001\n");
    const fileB = writeConfig("singleton-b", "listen:\n  port: 9002\n");
    process.env.PANEL_CONFIG = fileA;
    try {
      const first = getPanelConfig();
      expect(getPanelConfig()).toBe(first); // 模块级缓存，同一实例

      _resetPanelConfigForTest();
      process.env.PANEL_CONFIG = fileB;
      const second = getPanelConfig();
      expect(second).not.toBe(first);
      expect(second.listen.port).toBe(9002); // 读到新文件的值
    } finally {
      _resetPanelConfigForTest();
      if (envBackup === undefined) delete process.env.PANEL_CONFIG;
      else process.env.PANEL_CONFIG = envBackup;
    }
  });
});

describe("getModelsHost / getModelsHostSource（models 宿主机根优先级链）", () => {
  /** 备份/还原 PANEL_CONFIG 与 PANEL_MODELS_HOST，并在 finally 里清空单例与自动发现缓存 */
  function withEnv(fn: () => void) {
    const configBackup = process.env.PANEL_CONFIG;
    const hostBackup = process.env.PANEL_MODELS_HOST;
    try {
      fn();
    } finally {
      _resetPanelConfigForTest();
      if (configBackup === undefined) delete process.env.PANEL_CONFIG;
      else process.env.PANEL_CONFIG = configBackup;
      if (hostBackup === undefined) delete process.env.PANEL_MODELS_HOST;
      else process.env.PANEL_MODELS_HOST = hostBackup;
    }
  }

  it("四级都没提供：未解析，返回空串", () => {
    withEnv(() => {
      delete process.env.PANEL_MODELS_HOST;
      process.env.PANEL_CONFIG = tmpConfigPath("chain-none"); // 不存在的文件 → host 走 schema 默认（undefined）

      expect(getModelsHost()).toBe("");
      expect(getModelsHostSource()).toBe("unresolved");
    });
  });

  it("只有自动发现结果时：discovered 生效", () => {
    withEnv(() => {
      delete process.env.PANEL_MODELS_HOST;
      process.env.PANEL_CONFIG = tmpConfigPath("chain-discovered");
      setDiscoveredModelsHost("/srv/llama/models");

      expect(getModelsHost()).toBe("/srv/llama/models");
      expect(getModelsHostSource()).toBe("discovered");
    });
  });

  it("panel.yaml 配置优先于自动发现结果", () => {
    withEnv(() => {
      delete process.env.PANEL_MODELS_HOST;
      process.env.PANEL_CONFIG = writeConfig(
        "chain-file",
        "paths:\n  models:\n    host: /data/from-file\n",
      );
      setDiscoveredModelsHost("/data/from-discovery"); // 即便先注入，也不应被读到

      expect(getModelsHost()).toBe("/data/from-file");
      expect(getModelsHostSource()).toBe("file");
    });
  });

  it("环境变量优先于 panel.yaml 与自动发现结果", () => {
    withEnv(() => {
      process.env.PANEL_MODELS_HOST = "/data/from-env";
      process.env.PANEL_CONFIG = writeConfig(
        "chain-env",
        "paths:\n  models:\n    host: /data/from-file\n",
      );
      setDiscoveredModelsHost("/data/from-discovery");

      expect(getModelsHost()).toBe("/data/from-env");
      expect(getModelsHostSource()).toBe("env");
    });
  });

  it("PANEL_MODELS_HOST 为空字符串按未设置处理（不会截断成一个空路径）", () => {
    withEnv(() => {
      process.env.PANEL_MODELS_HOST = "";
      process.env.PANEL_CONFIG = writeConfig(
        "chain-env-empty",
        "paths:\n  models:\n    host: /data/from-file\n",
      );

      expect(getModelsHost()).toBe("/data/from-file");
      expect(getModelsHostSource()).toBe("file");
    });
  });
});
