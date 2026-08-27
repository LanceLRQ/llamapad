import { describe, expect, it } from "vitest";
import { openDb, runMigrations } from "../db";
import {
  getHostNetIfacePreference,
  isVirtualIface,
  listPhysicalIfaces,
  parseNetDev,
  parseNetRoute,
  resolveHostIface,
  saveHostNetIfacePreference,
  selectAutoIface,
  type IfaceTraffic,
} from "./hostNet";

/**
 * 宿主机网卡选择纯函数测试（追加需求 2026-08-27：网络指标允许用户选择监控
 * 哪一块网卡，默认自动选，判据见 hostNet.ts 头注释）。
 *
 * 真机实测 fixture（两条默认路由，metric 与流量两个判据在这台机器上指向
 * 同一块网卡，互相印证）：
 *   enx00e04c6801e4  metric=100  rx=1481.6 MB  tx=919.4 MB
 *   enp5s0           metric=200  rx=   3.5 MB  tx=  0.2 MB
 */

const MB = 1024 * 1024;

/** /proc/net/route 表头 + 数据行；destinationHex 用 "00000000" 代表默认路由，
 * 非默认路由用非零值占位（内容本身不影响判定，只测 filter 逻辑） */
function routeTable(rows: { iface: string; destinationHex: string; metric: number }[]): string {
  const header = "Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT";
  const lines = rows.map(
    (r) => `${r.iface}\t${r.destinationHex}\t0102A8C0\t0003\t0\t0\t${r.metric}\t00000000\t0\t0\t0`,
  );
  return [header, ...lines].join("\n");
}

/** /proc/net/dev 表头两行 + 数据行（rx 字段在冒号后第 1 个数值，tx 在第 9 个） */
function netDevTable(rows: { iface: string; rxBytes: number; txBytes: number }[]): string {
  const header1 = "Inter-|   Receive                                                |  Transmit";
  const header2 =
    " face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed";
  const lines = rows.map(
    (r) =>
      `  ${r.iface}: ${r.rxBytes} 0 0 0 0 0 0 0 ${r.txBytes} 0 0 0 0 0 0 0`,
  );
  return [header1, header2, ...lines].join("\n");
}

describe("parseNetDev", () => {
  it("解析数据行为 iface → {rxBytes, txBytes}，跳过两行表头", () => {
    const text = netDevTable([
      { iface: "lo", rxBytes: 1234, txBytes: 1234 },
      { iface: "eth0", rxBytes: 56789, txBytes: 98765 },
    ]);
    expect(parseNetDev(text)).toEqual({
      lo: { rxBytes: 1234, txBytes: 1234 },
      eth0: { rxBytes: 56789, txBytes: 98765 },
    });
  });

  it("坏行（非数值字段）跳过", () => {
    const text = "Inter-|   Receive\n face |bytes\n  bad: N/A N/A\n";
    expect(parseNetDev(text)).toEqual({});
  });

  it("空文本 → 空对象", () => {
    expect(parseNetDev("")).toEqual({});
  });
});

describe("parseNetRoute", () => {
  it("解析 Metric 列（1-indexed 第 7 列）", () => {
    const text = routeTable([
      { iface: "eth0", destinationHex: "00000000", metric: 100 },
      { iface: "eth1", destinationHex: "0002A8C0", metric: 600 },
    ]);
    const entries = parseNetRoute(text);
    expect(entries).toEqual([
      { iface: "eth0", destinationHex: "00000000", metric: 100 },
      { iface: "eth1", destinationHex: "0002A8C0", metric: 600 },
    ]);
  });

  it("列数不足 / Metric 非数值的行跳过", () => {
    const text = "header\neth0 short\neth1\t00000000\tgw\tflags\t0\t0\tNaN\t0\t0\t0\t0\n";
    expect(parseNetRoute(text)).toEqual([]);
  });
});

describe("isVirtualIface", () => {
  it.each(["lo", "docker0", "br-abcdef", "veth1234", "virbr0", "tun0", "tap0"])(
    "%s 判定为虚拟网卡",
    (name) => {
      expect(isVirtualIface(name)).toBe(true);
    },
  );

  it.each(["eth0", "enp5s0", "enx00e04c6801e4", "wlan0"])("%s 判定为物理网卡", (name) => {
    expect(isVirtualIface(name)).toBe(false);
  });
});

describe("selectAutoIface：真机判据（route Metric 优先，流量兜底，虚拟网卡过滤）", () => {
  it("单条默认路由 → 选它", () => {
    const routeText = routeTable([{ iface: "eth0", destinationHex: "00000000", metric: 100 }]);
    const traffic: Record<string, IfaceTraffic> = { eth0: { rxBytes: 100, txBytes: 100 } };
    expect(selectAutoIface(routeText, traffic)).toBe("eth0");
  });

  it("两条默认路由 → 取 Metric 最小的（真机 fixture：enx... metric=100 胜出）", () => {
    const routeText = routeTable([
      { iface: "enx00e04c6801e4", destinationHex: "00000000", metric: 100 },
      { iface: "enp5s0", destinationHex: "00000000", metric: 200 },
    ]);
    const traffic: Record<string, IfaceTraffic> = {
      enx00e04c6801e4: { rxBytes: Math.round(1481.6 * MB), txBytes: Math.round(919.4 * MB) },
      enp5s0: { rxBytes: Math.round(3.5 * MB), txBytes: Math.round(0.2 * MB) },
    };
    expect(selectAutoIface(routeText, traffic)).toBe("enx00e04c6801e4");
  });

  it("Metric 相同 → 取累计 rx+tx 最大的", () => {
    const routeText = routeTable([
      { iface: "eth0", destinationHex: "00000000", metric: 100 },
      { iface: "eth1", destinationHex: "00000000", metric: 100 },
    ]);
    const traffic: Record<string, IfaceTraffic> = {
      eth0: { rxBytes: 100, txBytes: 100 },
      eth1: { rxBytes: 500, txBytes: 500 },
    };
    expect(selectAutoIface(routeText, traffic)).toBe("eth1");
  });

  it("无默认路由 → 回落前缀过滤 + 流量最大", () => {
    const routeText = routeTable([{ iface: "eth0", destinationHex: "0002A8C0", metric: 100 }]);
    const traffic: Record<string, IfaceTraffic> = {
      lo: { rxBytes: 999_999, txBytes: 999_999 },
      docker0: { rxBytes: 500_000, txBytes: 500_000 },
      eth0: { rxBytes: 1_000, txBytes: 1_000 },
      eth1: { rxBytes: 2_000, txBytes: 2_000 },
    };
    expect(selectAutoIface(routeText, traffic)).toBe("eth1");
  });

  it("route 表读不到（未挂 /proc）→ 回落前缀过滤 + 流量最大", () => {
    const traffic: Record<string, IfaceTraffic> = {
      lo: { rxBytes: 999_999, txBytes: 999_999 },
      eth0: { rxBytes: 1_000, txBytes: 1_000 },
    };
    expect(selectAutoIface(null, traffic)).toBe("eth0");
  });

  it("只剩虚拟网卡 → 返回 null（不产样本）", () => {
    const traffic: Record<string, IfaceTraffic> = {
      lo: { rxBytes: 999, txBytes: 999 },
      docker0: { rxBytes: 500, txBytes: 500 },
      "veth1234": { rxBytes: 100, txBytes: 100 },
    };
    expect(selectAutoIface(null, traffic)).toBeNull();
  });

  it("traffic 为空对象 → 返回 null", () => {
    expect(selectAutoIface(null, {})).toBeNull();
  });
});

describe("resolveHostIface：用户偏好优先，缺失时回落 auto", () => {
  const traffic: Record<string, IfaceTraffic> = {
    eth0: { rxBytes: 1_000, txBytes: 1_000 },
    eth1: { rxBytes: 5_000, txBytes: 5_000 },
  };

  it("偏好 auto → 走自动选卡", () => {
    expect(resolveHostIface("auto", null, traffic)).toBe("eth1"); // 无路由回落流量最大
  });

  it("用户指定了存在的网卡 → 用它，不走自动", () => {
    expect(resolveHostIface("eth0", null, traffic)).toBe("eth0");
  });

  it("用户指定了不存在的网卡 → 回落 auto", () => {
    expect(resolveHostIface("eth99", null, traffic)).toBe("eth1");
  });
});

describe("listPhysicalIfaces：设置页下拉框用，过滤虚拟网卡并排序", () => {
  it("过滤 lo 与虚拟前缀，按名称排序", () => {
    const traffic: Record<string, IfaceTraffic> = {
      lo: { rxBytes: 0, txBytes: 0 },
      docker0: { rxBytes: 0, txBytes: 0 },
      eth1: { rxBytes: 0, txBytes: 0 },
      eth0: { rxBytes: 0, txBytes: 0 },
    };
    expect(listPhysicalIfaces(traffic)).toEqual(["eth0", "eth1"]);
  });

  it("空输入 → 空数组", () => {
    expect(listPhysicalIfaces({})).toEqual([]);
  });
});

describe("host_net_iface 设置持久化（settings 表，upsert）", () => {
  it("未设置时读出 auto", () => {
    const db = openDb(":memory:");
    runMigrations(db);
    expect(getHostNetIfacePreference(db)).toBe("auto");
    db.close();
  });

  it("写入后可读回；重复写入覆盖旧值（upsert）", () => {
    const db = openDb(":memory:");
    runMigrations(db);
    saveHostNetIfacePreference(db, "eth0");
    expect(getHostNetIfacePreference(db)).toBe("eth0");
    saveHostNetIfacePreference(db, "eth1");
    expect(getHostNetIfacePreference(db)).toBe("eth1");
    db.close();
  });
});
