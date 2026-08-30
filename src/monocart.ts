/**
 * monocart-reporter JSON parsing and threshold evaluation.
 *
 * monocart-reporter (with the `json: true` option) writes machine-readable
 * report data whose `system` section contains its built-in, 1s-cadence
 * sampler output:
 *   system.mem.total               — host RAM in bytes
 *   system.ticks[n].cpu.percent    — machine-wide CPU usage % (0–100, all cores)
 *   system.ticks[n].mem.free       — host free RAM in bytes at tick time
 */
import { readFileSync } from 'node:fs';

export interface MonocartTick {
  timestamp?: number;
  cpu?: { percent?: number };
  mem?: { free?: number };
}

export interface MonocartReport {
  name?: string;
  system?: {
    mem?: { total?: number };
    ticks?: MonocartTick[];
    timestampStart?: number;
    timestampEnd?: number;
  };
}

export interface SystemReading {
  timestamp: number;
  /** Machine-wide CPU usage %, 0–100 across all cores. */
  cpuPercent: number;
  /** Machine memory in use, % of total. */
  memoryPercent: number;
  /** Machine memory in use, bytes. */
  memoryBytes: number;
}

export interface ThresholdConfig {
  cpuThreshold: number;
  memoryThreshold: number;
}

export interface BreachTick {
  timestamp: number;
  cpuPercent: number;
  memoryPercent: number;
  reasons: string[];
}

export interface Evaluation {
  readings: SystemReading[];
  memTotalBytes: number;
  peakCpuPercent: number;
  peakMemoryPercent: number;
  breachTicks: BreachTick[];
  reportFound: boolean;
}

export interface ParsedReport {
  readings: SystemReading[];
  memTotalBytes: number;
}

export function parseMonocartJson(raw: string): ParsedReport {
  const report = JSON.parse(raw) as MonocartReport | null;
  const system = report?.system;
  const memTotal = Number(system?.mem?.total ?? 0);
  const ticks = system && Array.isArray(system.ticks) ? system.ticks : [];
  const readings: SystemReading[] = [];
  for (const tick of ticks) {
    if (!tick) continue;
    const cpuPercent = clampPercent(Number(tick.cpu?.percent ?? 0));
    const freeBytes = Number(tick.mem?.free ?? 0);
    // Only translate memory when the machine total is present and sane.
    const memoryBytes =
      memTotal > 0 && freeBytes <= memTotal ? Math.max(0, memTotal - freeBytes) : 0;
    readings.push({
      timestamp: Number(tick.timestamp ?? 0),
      cpuPercent,
      memoryBytes,
      memoryPercent: memTotal > 0 ? (memoryBytes / memTotal) * 100 : 0,
    });
  }
  return { readings, memTotalBytes: memTotal };
}

export function evaluateThresholds(readings: SystemReading[], cfg: ThresholdConfig): {
  peakCpuPercent: number;
  peakMemoryPercent: number;
  breachTicks: BreachTick[];
} {
  let peakCpuPercent = 0;
  let peakMemoryPercent = 0;
  const breachTicks: BreachTick[] = [];
  for (const reading of readings) {
    if (reading.cpuPercent > peakCpuPercent) peakCpuPercent = reading.cpuPercent;
    if (reading.memoryPercent > peakMemoryPercent) peakMemoryPercent = reading.memoryPercent;
    const reasons: string[] = [];
    if (reading.cpuPercent > cfg.cpuThreshold) {
      reasons.push(`CPU ${reading.cpuPercent.toFixed(1)}% > ${cfg.cpuThreshold.toFixed(1)}%`);
    }
    if (reading.memoryPercent > cfg.memoryThreshold) {
      reasons.push(`memory ${reading.memoryPercent.toFixed(1)}% > ${cfg.memoryThreshold.toFixed(1)}%`);
    }
    if (reasons.length > 0) {
      breachTicks.push({
        timestamp: reading.timestamp,
        cpuPercent: reading.cpuPercent,
        memoryPercent: reading.memoryPercent,
        reasons,
      });
    }
  }
  return { peakCpuPercent, peakMemoryPercent, breachTicks };
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(value, 100);
}

export function loadReadings(jsonPath: string): ParsedReport & { reportFound: boolean } {
  try {
    const raw = readFileSync(jsonPath, 'utf8');
    return { reportFound: true, ...parseMonocartJson(raw) };
  } catch {
    return { reportFound: false, readings: [], memTotalBytes: 0 };
  }
}