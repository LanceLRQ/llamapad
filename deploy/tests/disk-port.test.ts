import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { pathWith, sh, stubBin, tempDir } from "./sh";

describe("端口占用", () => {
  it("listen_table_has_port 识别 ss / netstat 监听表里的端口（含 IPv6 与 *）", () => {
    const ss = [
      "State  Recv-Q Send-Q Local Address:Port Peer Address:Port",
      "LISTEN 0      4096   0.0.0.0:22         0.0.0.0:*",
      "LISTEN 0      4096   [::]:28960         [::]:*",
      "LISTEN 0      4096   *:8080             *:*",
    ].join("\n");
    const has = (p: number) => sh(`listen_table_has_port ${p}`, { input: ss }).code;
    expect(has(28960)).toBe(0);
    expect(has(8080)).toBe(0);
    expect(has(2896)).toBe(1);
    const netstat = "Active Internet connections (only servers)\nProto Recv-Q Send-Q Local Address Foreign Address State\ntcp 0 0 127.0.0.1:5432 0.0.0.0:* LISTEN\n";
    expect(sh("listen_table_has_port 5432", { input: netstat }).code).toBe(0);
  });

  it("proc_tcp_has_port 只认 LISTEN(0A) 状态的本地端口", () => {
    const dir = tempDir();
    const tcp = path.join(dir, "tcp");
    const tcp6 = path.join(dir, "tcp6");
    writeFileSync(
      tcp,
      "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n" +
        "   0: 00000000:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 1\n" +
        "   1: 0100007F:0050 0100007F:9C40 01 00000000:00000000 00:00000000 00000000     0        0 2\n",
    );
    writeFileSync(
      tcp6,
      "  sl  local_address rem_address st\n   0: 00000000000000000000000000000000:70E0 00000000000000000000000000000000:0000 0A x\n",
    );
    expect(sh(`proc_tcp_has_port 8080 "${tcp}" "${tcp6}"`).code).toBe(0); // 0x1F90
    expect(sh(`proc_tcp_has_port 28896 "${tcp}" "${tcp6}"`).code).toBe(0); // 0x70E0 在 tcp6
    expect(sh(`proc_tcp_has_port 80 "${tcp}" "${tcp6}"`).code).toBe(1); // 0x0050 是 ESTABLISHED
  });

  it("port_in_use 有 ss 时用 ss", () => {
    const bin = stubBin("ss");
    const env = { PATH: pathWith(bin), STUB_SS: "State Recv-Q Send-Q Local Address:Port Peer\\nLISTEN 0 1 0.0.0.0:28960 0.0.0.0:*\\n" };
    expect(sh("port_in_use 28960", { env }).code).toBe(0);
    expect(sh("port_in_use 28961", { env }).code).toBe(1);
  });
});

/** 构造一棵假 sysfs：块设备名 → { rotational?, slaves?, dmName? } */
function fakeSysfs(spec: Record<string, { rotational?: 0 | 1; slaves?: string[]; dmName?: string }>): string {
  const root = tempDir("lp-sys-");
  for (const [name, s] of Object.entries(spec)) {
    const dev = path.join(root, "block", name);
    mkdirSync(path.join(dev, "queue"), { recursive: true });
    if (s.rotational !== undefined) writeFileSync(path.join(dev, "queue/rotational"), `${s.rotational}\n`);
    if (s.dmName) {
      mkdirSync(path.join(dev, "dm"), { recursive: true });
      writeFileSync(path.join(dev, "dm/name"), `${s.dmName}\n`);
    }
    if (s.slaves) {
      mkdirSync(path.join(dev, "slaves"), { recursive: true });
      for (const sl of s.slaves) symlinkSync("/dev/null", path.join(dev, "slaves", sl));
    }
  }
  return root;
}

describe("盘类型识别", () => {
  const sysfs = fakeSysfs({
    nvme0n1: { rotational: 0 },
    nvme1n1: { rotational: 0 },
    sda: { rotational: 1 },
    sdb: { rotational: 1 },
    sdc: { rotational: 0 },
    vdb: { rotational: 1 },
    "dm-0": { slaves: ["sda2"], dmName: "vg-hdd" },
    "dm-1": { slaves: ["sda3", "nvme0n1p3"], dmName: "vg-mixed" },
    md0: { slaves: ["sdc1"] },
  });
  const env = { LLAMAPAD_SYSFS: sysfs };
  const type = (dev: string, fs = "ext4") => sh(`disk_type "${dev}" ${fs}`, { env }).stdout;

  it("disk_strip_part 去掉分区后缀", () => {
    const strip = (n: string) => sh(`disk_strip_part ${n}`).stdout;
    expect(strip("nvme0n1p2")).toBe("nvme0n1");
    expect(strip("mmcblk0p1")).toBe("mmcblk0");
    expect(strip("sda3")).toBe("sda");
    expect(strip("vda1")).toBe("vda");
    expect(strip("loop0")).toBe("loop0");
    expect(strip("loop0p3")).toBe("loop0");
    expect(strip("nvme0n1")).toBe("nvme0n1");
  });

  it("按设备名与 rotational 判断 NVMe / SSD / HDD，分区先归到整盘", () => {
    expect(type("/dev/nvme1n1p1")).toBe("nvme");
    expect(type("/dev/sdb1")).toBe("hdd");
    expect(type("/dev/sdc")).toBe("ssd");
  });

  it("云 / 虚拟盘（vd*、xvd*）不下结论，标 unknown", () => {
    expect(type("/dev/vdb1")).toBe("unknown");
  });

  it("LVM 沿 slaves 找底层盘；底层类型不一致标 mixed；mdraid 同理", () => {
    expect(type("/dev/mapper/vg-hdd")).toBe("hdd");
    expect(type("/dev/mapper/vg-mixed")).toBe("mixed");
    expect(type("/dev/md0")).toBe("ssd");
  });

  it("网络文件系统标 network；非 /dev 设备与无法解析的标 unknown", () => {
    expect(type("nas:/export", "nfs4")).toBe("network");
    expect(type("//srv/share", "cifs")).toBe("network");
    expect(type("tank/models", "zfs")).toBe("unknown");
    expect(type("/dev/sdz9")).toBe("unknown");
  });
});

describe("模型库候选", () => {
  it("mounts_usable 过滤伪文件系统与系统目录，同设备只留最短挂载点，解码 \\040", () => {
    const mounts = [
      "/dev/nvme0n1p2 / ext4 rw 0 0",
      "/dev/nvme1n1p1 /mnt/data ext4 rw 0 0",
      "/dev/sdb1 /mnt/hdd xfs rw 0 0",
      "/dev/sdb1 /srv/hdd-bind xfs rw 0 0",
      "tmpfs /run tmpfs rw 0 0",
      "/dev/nvme0n1p1 /boot/efi vfat rw 0 0",
      "overlay /var/lib/docker/overlay2/x/merged overlay rw 0 0",
      "/dev/sdc1 /mnt/my\\040disk ext4 rw 0 0",
    ].join("\n");
    const rows = sh("mounts_usable | sort", { input: mounts }).stdout.trim().split("\n");
    expect(rows).toEqual([
      "/dev/nvme0n1p2\t/\text4",
      "/dev/nvme1n1p1\t/mnt/data\text4",
      "/dev/sdb1\t/mnt/hdd\txfs",
      "/dev/sdc1\t/mnt/my\\040disk\text4",
    ]);
    expect(sh('mount_unescape "/mnt/my\\040disk"').stdout).toBe("/mnt/my disk");
  });

  it("disk_candidates：首行默认位置（带所在盘类型与系统盘标记），其余按剩余空间降序、路径拼 /llamapad/models", () => {
    const dir = tempDir();
    const sysfs = fakeSysfs({ nvme0n1: { rotational: 0 }, nvme1n1: { rotational: 0 }, sdb: { rotational: 1 } });
    const proc = path.join(dir, "proc");
    mkdirSync(proc);
    writeFileSync(
      path.join(proc, "mounts"),
      "/dev/nvme0n1p2 / ext4 rw 0 0\n/dev/nvme1n1p1 /mnt/data ext4 rw 0 0\n/dev/sdb1 /mnt/hdd xfs rw 0 0\nnas:/e /mnt/nas nfs4 rw 0 0\n",
    );
    const table = path.join(dir, "df.tsv");
    writeFileSync(table, `/\t40000000\n/mnt/data\t1288490188\n/mnt/hdd\t5476083302\n/mnt/nas\t900\n`);
    const r = sh("disk_candidates /opt/llamapad/models", {
      env: { PATH: pathWith(stubBin("df")), STUB_DF_TABLE: table, LLAMAPAD_SYSFS: sysfs, LLAMAPAD_PROC: proc },
    });
    expect(r.stdout.trim().split("\n")).toEqual([
      "/opt/llamapad/models\tnvme\t40000000\t1",
      "/mnt/hdd/llamapad/models\thdd\t5476083302\t0",
      "/mnt/data/llamapad/models\tnvme\t1288490188\t0",
      "/mnt/nas/llamapad/models\tnetwork\t900\t0",
    ]);
  });
});
