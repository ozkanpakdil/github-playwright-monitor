import type { ProcessSample, Sample, TabReading, ThresholdConfig } from './types';

/**
 * Pure threshold/evaluation helpers — kept free of I/O so they are unit
 * testable with `bun test`.
 */

/** Memory usage as a percentage of the effective RAM limit. */
export function memoryPercentOf(bytes: number, limitBytes: number): number {
  if (!Number.isFinite(bytes) || !Number.isFinite(limitBytes) || limitBytes <= 0) {
    return 0;
  }
  return (bytes / limitBytes) * 100;
}

/** Non-negative CPU conversion: cpuSeconds consumed over elapsedSeconds. */
export function cpuPercent(cpuSecondsDelta: number, intervalSeconds: number): number {
  if (!Number.isFinite(cpuSecondsDelta) || !Number.isFinite(intervalSeconds) || intervalSeconds <= 0) {
    return 0;
  }
  return Math.max(0, (cpuSecondsDelta / intervalSeconds) * 100);
}

/** Select users can exceed 100% of one core; keep values sane anyway. */
export function sanitizeCpuPercent(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(value, 100000);
}

/**
 * The "worst single tab": the renderer process with the highest CPU usage in
 * the sample. Falls back to the renderer with the highest memory when CPU
 * deltas are not yet available (first sample of a new process).
 */
export function worstTab(sample: Sample | null | undefined): ProcessSample | null {
  if (!sample) return null;
  const renderers = sample.processes.filter((p) => p.type === 'renderer');
  if (renderers.length === 0) return null;
  let winner: ProcessSample | null = null;
  for (const candidate of renderers) {
    if (winner === null) {
      winner = candidate;
      continue;
    }
    const candidateLoad = candidate.cpuPercent * 1e6 + candidate.memoryBytes / 1e6;
    const winnerLoad = winner.cpuPercent * 1e6 + winner.memoryBytes / 1e6;
    if (candidateLoad > winnerLoad + Number.EPSILON) {
      winner = candidate;
    }
  }
  return winner;
}

/** Build the evaluated reading for one tick. */
export function toReading(sample: Sample, ramLimitBytes: number): TabReading {
  const tab = worstTab(sample);
  return {
    timestamp: sample.timestamp,
    intervalSeconds: sample.intervalSeconds,
    source: sample.source,
    worst: tab,
    memoryPercent: tab ? memoryPercentOf(tab.memoryBytes, ramLimitBytes) : 0,
  };
}

/** True when a reading breaches either threshold on the worst tab. */
export function breachesThreshold(reading: TabReading, cfg: ThresholdConfig): boolean {
  if (!reading.worst) return false;
  if (reading.worst.cpuPercent > cfg.cpuThreshold) return true;
  if (reading.memoryPercent > cfg.memoryThreshold) return true;
  return false;
}

/** Which threshold(s) did this reading exceed? */
export function breachReasons(reading: TabReading, cfg: ThresholdConfig): string[] {
  if (!reading.worst) return [];
  const reasons: string[] = [];
  if (reading.worst.cpuPercent > cfg.cpuThreshold) {
    reasons.push(
      `CPU ${reading.worst.cpuPercent.toFixed(1)}% of one core > ${cfg.cpuThreshold.toFixed(1)}% threshold`,
    );
  }
  if (reading.memoryPercent > cfg.memoryThreshold) {
    reasons.push(
      `memory ${formatBytes(reading.worst.memoryBytes)} (${reading.memoryPercent.toFixed(1)}% of limit) > ${cfg.memoryThreshold.toFixed(1)}% threshold`,
    );
  }
  return reasons;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

/** Renders the top N processes of a sample, worst CPU first. */
export function formatTopProcesses(sample: Sample, ramLimitBytes: number, top = 5): string {
  const rows = [...sample.processes]
    .sort(
      (a, b) =>
        b.cpuPercent - a.cpuPercent ||
        b.memoryBytes - a.memoryBytes,
    )
    .slice(0, top);
  if (rows.length === 0) return '  (no browser processes observed)';
  const lines = rows.map((p) => {
    const mem = `${formatBytes(p.memoryBytes)} (${memoryPercentOf(p.memoryBytes, ramLimitBytes).toFixed(1)}%)`;
    const pid = String(p.pid ?? '-').padEnd(7);
    const cpu = `${p.cpuPercent.toFixed(1)}%`.padStart(7);
    return `  pid ${pid} ${p.type.padEnd(8)} cpu ${cpu}  mem ${mem}`;
  });
  return lines.join('\n');
}