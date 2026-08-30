import { describe, expect, test } from 'bun:test';
import { appendEntry, historyTableRows, loadHistory, type HistoryEntry } from '../src/history';

function entry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    date: 1_750_000_000_000,
    dateH: '2025-06-15 10:00:00',
    outcome: 'passed',
    machineSource: 'action',
    machine: { peakCpuPercent: 40, peakMemoryPercent: 30, samples: 5 },
    tab: { peakCpuPercent: 55, peakMemoryPercent: 12, samples: 5 },
    tabSource: 'proc',
    breached: { machineCpu: false, machineMemory: false, tabCpu: false, tabMemory: false },
    thresholds: { machineCpu: 70, machineMemory: 70, tabCpu: 70, tabMemory: 70 },
    command: 'npx playwright test',
    runId: '123',
    runUrl: 'https://github.com/o/r/actions/runs/123',
    ...overrides,
  };
}

describe('appendEntry', () => {
  test('appends and keeps only the newest max entries', () => {
    const base = [entry({ date: 1 }), entry({ date: 2 })];
    const next = appendEntry(base, entry({ date: 3 }), 2);
    expect(next.map((e) => e.date)).toEqual([2, 3]);
    expect(appendEntry(next, entry({ date: 4 }), 50).length).toBe(3);
  });
});

describe('historyTableRows', () => {
  test('renders newest first with formatted percentages', () => {
    const rows = historyTableRows([entry({ date: 1, outcome: 'failed' }), entry({ date: 2, outcome: 'passed', runUrl: '' })]);
    expect(rows.length).toBe(3);
    const header = rows[0] as { data: string; header?: boolean }[];
    expect(header[0]?.data).toBe('Run');
    const first = rows[1] as string[]; // newest (date 2) first
    expect(first[0]).toContain('2025-06-15 10:00');
    expect(first[1]).toBe('passed');
    expect(first[2]).toBe('40.0%');
    expect(first[4]).toBe('55.0%');
  });

  test('links run URLs and shows - for missing layers', () => {
    const rows = historyTableRows([entry({ machine: null, outcome: 'passed' })]);
    const row = rows[1] as string[];
    expect(row[0]).toBe('[2025-06-15 10:00:00](https://github.com/o/r/actions/runs/123)');
    expect(row[2]).toBe('-');
    expect(row[4]).toBe('55.0%');
  });

  test('limits rows', () => {
    const many = Array.from({ length: 25 }, (_, i) => entry({ date: i }));
    expect(historyTableRows(many).length).toBe(11); // header + 10
  });
});