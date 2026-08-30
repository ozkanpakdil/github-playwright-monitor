import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { MonitorSummary } from './types';
import { memoryPercentOf } from './evaluate';

export interface ReportMeta {
  runCommand: string;
  cpuThreshold: number;
  memoryThreshold: number;
  pollingIntervalSeconds: number;
  ramLimitBytes: number;
  cdpPort: number | null;
  startedAt: number;
  finishedAt: number;
  commandExitCode: number | null;
  commandSignal: string | null;
}

export interface ReportPaths {
  jsonPath: string;
  csvPath: string;
}

function csvEscape(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

/**
 * Writes the detailed JSON report (all samples + summary) and a flat CSV
 * (one row per observed browser process per sample) for spreadsheet/GLM-style
 * post-run analysis.
 */
export function writeReports(dir: string, summary: MonitorSummary, meta: ReportMeta): ReportPaths {
  mkdirSync(dir, { recursive: true });

  const jsonPath = join(dir, 'report.json');
  const payload = {
    meta,
    source: summary.source,
    summary: {
      sampleCount: summary.readings.length,
      breachCount: summary.breaches.length,
      peakCpu: summary.peakCpu,
      peakMem: summary.peakMem,
    },
    breaches: summary.breaches,
    samples: summary.samples,
  };
  writeFileSync(jsonPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

  const csvPath = join(dir, 'report.csv');
  const header = 'timestamp,source,pid,type,label,cpu_percent_of_one_core,memory_bytes,memory_percent';
  const rows: string[] = [header];
  for (const sample of summary.samples) {
    const stamp = new Date(sample.timestamp).toISOString();
    for (const proc of sample.processes) {
      const memPct = memoryPercentOf(proc.memoryBytes, meta.ramLimitBytes).toFixed(2);
      rows.push(
        [
          stamp,
          sample.source,
          String(proc.pid ?? ''),
          proc.type,
          csvEscape(proc.label),
          proc.cpuPercent.toFixed(2),
          String(Math.round(proc.memoryBytes)),
          memPct,
        ].join(','),
      );
    }
  }
  writeFileSync(csvPath, `${rows.join('\n')}\n`, 'utf8');

  return { jsonPath: resolve(jsonPath), csvPath: resolve(csvPath) };
}