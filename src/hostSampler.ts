import { readFileSync } from 'node:fs';
import { memoryPercentOf, sanitizeCpuPercent } from './evaluate';

/**
 * Action-native machine sampler (Linux): deltas from /proc/stat for CPU and
 * /proc/meminfo (or the cgroup limit, when present) for memory. Zero
 * dependencies on the user's project — this runs entirely in the action.
 */
export interface HostSample {
  timestamp: number;
  intervalSeconds: number;
  /** Machine-wide CPU usage %, 0–100 across all cores. */
  cpuPercent: number;
  /** Machine memory in use, % of the effective limit. */
  memoryPercent: number;
  memoryBytes: number;
}

interface CpuStat {
  idle: number;
  total: number;
}

interface MemStat {
  total: number;
  available: number;
  /** Bytes actually in use right now (cgroup-aware when applicable). */
  usedBytes: number;
  limitBytes: number | null;
}

export function parseProcStatLine(line: string): CpuStat | null {
  const fields = line.trim().split(/\s+/).slice(1).map(Number);
  if (fields.length < 4 || fields.some((v) => !Number.isFinite(v))) return null;
  // user nice system idle(3) iowait(4) irq(5) softirq(6) steal(7) ...
  const user = fields[0] ?? 0;
  const nice = fields[1] ?? 0;
  const system = fields[2] ?? 0;
  const idle = fields[3] ?? 0;
  const iowait = fields[4] ?? 0;
  const irq = fields[5] ?? 0;
  const softirq = fields[6] ?? 0;
  const steal = fields[7] ?? 0;
  const idleAll = idle + iowait;
  const nonIdle = user + nice + system + irq + softirq + steal;
  return { idle: idleAll, total: idleAll + nonIdle };
}

export function parseMeminfo(raw: string, cgroupLimitBytes: number | null): MemStat {
  const get = (key: string): number => {
    const match = new RegExp(`^${key}:\\s+(\\d+)\\s*kB`, 'm').exec(raw);
    return match ? Number(match[1]) * 1024 : 0;
  };
  const total = get('MemTotal');
  const available = get('MemAvailable') || get('MemFree');
  let limitBytes: number | null = null;
  let usedBytes = Math.max(0, total - available);

  // Inside a container the cgroup limit can be tighter than host RAM.
  if (cgroupLimitBytes !== null && cgroupLimitBytes > 0 && cgroupLimitBytes < total) {
    limitBytes = cgroupLimitBytes;
    try {
      const current = Number(readFileSync('/sys/fs/cgroup/memory.current', 'utf8').trim());
      if (Number.isFinite(current) && current > 0) usedBytes = current;
    } catch {
      // keep meminfo-derived usage
    }
  }

  return { total, available, usedBytes, limitBytes };
}

export function createHostSampler(cgroupLimitBytes: number | null) {
  let prevCpu: CpuStat | null = null;
  let prevAt: number | null = null;

  return {
    available: process.platform === 'linux',

    sample(): HostSample | null {
      if (process.platform !== 'linux') return null;
      let cpuLine: string;
      let memRaw: string;
      try {
        cpuLine = readFileSync('/proc/stat', 'utf8');
        memRaw = readFileSync('/proc/meminfo', 'utf8');
      } catch {
        return null;
      }
      const firstLine = cpuLine.split('\n')[0] ?? '';
      const cpu = parseProcStatLine(firstLine);
      if (!cpu) return null;

      const now = Date.now();
      const intervalSeconds = prevAt === null ? 0 : Math.max(0.1, (now - prevAt) / 1000);
      const idleDelta = prevCpu ? Math.max(0, cpu.idle - prevCpu.idle) : 0;
      const totalDelta = prevCpu ? Math.max(1, cpu.total - prevCpu.total) : 0;
      const cpuUsage =
        prevCpu && intervalSeconds >= 0.1
          ? sanitizeCpuPercent((1 - idleDelta / totalDelta) * 100)
          : 0;

      const mem = parseMeminfo(memRaw, cgroupLimitBytes);
      const effectiveTotal = mem.limitBytes ?? mem.total;

      const sample: HostSample = {
        timestamp: now,
        intervalSeconds,
        cpuPercent: cpuUsage,
        memoryPercent: memoryPercentOf(mem.usedBytes, effectiveTotal),
        memoryBytes: mem.usedBytes,
      };
      prevCpu = cpu;
      prevAt = now;
      return sample;
    },

    stop(): void {
      prevCpu = null;
      prevAt = null;
    },
  };
}