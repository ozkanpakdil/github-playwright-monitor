import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface HistoryThresholds {
  machineCpu: number;
  machineMemory: number;
  tabCpu: number;
  tabMemory: number;
}

export interface HistoryLayerStats {
  peakCpuPercent: number | null;
  peakMemoryPercent: number | null;
  samples: number;
}

export interface HistoryEntry {
  /** Epoch ms of the run. */
  date: number;
  /** Human-readable UTC datetime. */
  dateH: string;
  /** "passed" | "warned" | "failed" | "command-failed". */
  outcome: string;
  /** Where machine metrics came from: 'monocart' | 'action' | 'none'. */
  machineSource: string;
  machine: HistoryLayerStats | null;
  tab: HistoryLayerStats | null;
  tabSource: string;
  breached: { machineCpu: boolean; machineMemory: boolean; tabCpu: boolean; tabMemory: boolean };
  thresholds: HistoryThresholds;
  command: string;
  runId: string;
  runUrl: string;
}

const HISTORY_TABLE_LIMIT = 10;

/** Loads the history file; any unreadable/malformed content starts a fresh history. */
export function loadHistory(path: string): HistoryEntry[] {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is HistoryEntry =>
        typeof item === 'object' && item !== null && typeof (item as HistoryEntry).date === 'number',
    );
  } catch {
    return [];
  }
}

/** Appends an entry and keeps only the newest `max` entries. */
export function appendEntry(entries: HistoryEntry[], entry: HistoryEntry, max: number): HistoryEntry[] {
  const next = [...entries, entry];
  if (next.length > max) {
    return next.slice(next.length - max);
  }
  return next;
}

export function saveHistory(path: string, entries: HistoryEntry[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(entries, null, 2)}\n`, 'utf8');
}

function fmt(value: number | null | undefined): string {
  if (value === null || value === undefined) return '-';
  return `${value.toFixed(1)}%`;
}

/**
 * Build the job-summary history rows (header included), newest run first,
 * limited to the last `limit` runs.
 */
export function historyTableRows(
  entries: HistoryEntry[],
  limit: number = HISTORY_TABLE_LIMIT,
): (string | { data: string; header?: boolean })[][] {
  const rows: (string | { data: string; header?: boolean })[][] = [
    [
      { data: 'Run', header: true },
      { data: 'Outcome', header: true },
      { data: 'Machine CPU', header: true },
      { data: 'Machine Mem', header: true },
      { data: 'Tab CPU', header: true },
      { data: 'Tab Mem', header: true },
    ],
  ];
  const recent = [...entries].slice(-limit).reverse();
  for (const entry of recent) {
    let run = entry.dateH;
    if (entry.runUrl) {
      run = `[${entry.dateH}](${entry.runUrl})`;
    }
    rows.push([
      run,
      entry.outcome,
      fmt(entry.machine?.peakCpuPercent),
      fmt(entry.machine?.peakMemoryPercent),
      fmt(entry.tab?.peakCpuPercent),
      fmt(entry.tab?.peakMemoryPercent),
    ]);
  }
  return rows;
}