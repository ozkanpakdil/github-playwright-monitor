import { describe, expect, test } from 'bun:test';
import {
  breachReasons,
  breachesThreshold,
  cpuPercent,
  formatBytes,
  memoryPercentOf,
  sanitizeCpuPercent,
  toReading,
  worstTab,
} from '../src/evaluate';
import type { ProcessSample, Sample } from '../src/types';

function proc(overrides: Partial<ProcessSample> = {}): ProcessSample {
  return {
    key: 'test:1',
    pid: 1000,
    type: 'renderer',
    label: 'renderer pid 1000',
    cpuPercent: 0,
    memoryBytes: 0,
    ...overrides,
  };
}

function sample(processes: ProcessSample[]): Sample {
  return { timestamp: 1_700_000_000_000, intervalSeconds: 2, source: 'proc', processes };
}

describe('memoryPercentOf', () => {
  test('computes percentage against a limit', () => {
    expect(memoryPercentOf(2_000_000_000, 16_000_000_000)).toBeCloseTo(12.5);
  });
  test('guards against zero/invalid limits', () => {
    expect(memoryPercentOf(100, 0)).toBe(0);
    expect(memoryPercentOf(Number.NaN, 100)).toBe(0);
  });
});

describe('cpuPercent', () => {
  test('converts cpu-seconds over elapsed wall time', () => {
    expect(cpuPercent(2.5, 5)).toBeCloseTo(50); // 50% of one core
    expect(cpuPercent(8, 4)).toBeCloseTo(200); // can exceed 100%: multithreaded
  });
  test('guards against invalid intervals', () => {
    expect(cpuPercent(5, 0)).toBe(0);
  });
  test('sanitize clamps negatives and absurd values', () => {
    expect(sanitizeCpuPercent(-3)).toBe(0);
    expect(sanitizeCpuPercent(1e8)).toBeLessThanOrEqual(100_000);
  });
});

describe('worstTab', () => {
  test('picks the renderer with the highest load', () => {
    const gpu = proc({ key: 'gpu:1', type: 'gpu', label: 'gpu', cpuPercent: 300, memoryBytes: 5e9 });
    const calm = proc({ key: 'proc:1', cpuPercent: 10, memoryBytes: 2e8 });
    const hot = proc({ key: 'proc:2', pid: 2002, cpuPercent: 95, memoryBytes: 3e8 });
    const s = sample([gpu, calm, hot]);
    expect(worstTab(s)?.pid).toBe(2002);
  });
  test('returns null when no renderer samples exist', () => {
    expect(worstTab(sample([proc({ type: 'gpu', label: 'gpu' })]))).toBeNull();
    expect(worstTab(null)).toBeNull();
  });
});

describe('thresholds', () => {
  const cfg = { cpuThreshold: 70, memoryThreshold: 70 };
  const limit = 8_000_000_000;

  test('no breach for a healthy tab', () => {
    const reading = toReading(sample([proc({ cpuPercent: 40, memoryBytes: 2e9 })]), limit);
    expect(reading.memoryPercent).toBeCloseTo(25);
    expect(breachesThreshold(reading, cfg)).toBeFalse();
  });

  test('breaches on CPU', () => {
    const reading = toReading(sample([proc({ cpuPercent: 71.2, memoryBytes: 1e6 })]), limit);
    expect(breachesThreshold(reading, cfg)).toBeTrue();
    expect(breachReasons(reading, cfg).join(' ')).toContain('CPU 71.2%');
  });

  test('breaches on memory', () => {
    const reading = toReading(sample([proc({ cpuPercent: 1, memoryBytes: 6e9 })]), limit);
    expect(reading.memoryPercent).toBeCloseTo(75);
    expect(breachesThreshold(reading, cfg)).toBeTrue();
    expect(breachReasons(reading, cfg).join(' ')).toContain('memory 5.6 GB');
  });

  test('ignores cpuThreshold exactly equal reading', () => {
    const reading = toReading(sample([proc({ cpuPercent: 70, memoryBytes: 0 })]), limit);
    expect(breachesThreshold(reading, cfg)).toBeFalse();
  });
});

describe('formatBytes', () => {
  test('renders human sizes', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(488 * 1024 * 1024)).toBe('488.0 MB');
    expect(formatBytes(6.8 * 1024 ** 3)).toBe('6.8 GB');
  });
});