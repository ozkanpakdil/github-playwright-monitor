import { describe, expect, test } from 'bun:test';
import {
  evaluateThresholds,
  parseMonocartJson,
  type MonocartReport,
} from '../src/monocart';

const GB = 1024 ** 3;

function report(ticks: MonocartReport['system'], memTotal?: number): string {
  return JSON.stringify({
    name: 'Test Report',
    system: {
      mem: { total: memTotal ?? 16 * GB },
      ...ticks,
    },
  });
}

describe('parseMonocartJson', () => {
  test('extracts machine-wide readings from system.ticks', () => {
    const raw = report(
      {
        ticks: [
          { timestamp: 1000, cpu: { percent: 12.5 }, mem: { free: 12 * GB } },
          { timestamp: 2000, cpu: { percent: 96.1 }, mem: { free: 6 * GB } },
        ],
      },
      16 * GB,
    );
    const { readings, memTotalBytes } = parseMonocartJson(raw);
    expect(readings.length).toBe(2);
    expect(memTotalBytes).toBe(16 * GB);
    expect(readings[1]?.cpuPercent).toBeCloseTo(96.1);
    expect(readings[1]?.memoryPercent).toBeCloseTo((10 / 16) * 100);
  });

  test('handles missing system section and zero ticks', () => {
    expect(parseMonocartJson('{}').readings.length).toBe(0);
    expect(parseMonocartJson('{"system":{"ticks":[]}}').readings.length).toBe(0);
  });

  test('memory percent is 0 without a valid total', () => {
    const { readings } = parseMonocartJson('{"system":{"ticks":[{"mem":{"free":5}}]}}');
    expect(readings.length).toBe(1);
    expect(readings[0]?.memoryPercent).toBe(0);
  });

  test('clamps bad cpu values', () => {
    const { readings } = parseMonocartJson('{"system":{"ticks":[{"cpu":{"percent":-5}},{"cpu":{"percent":180}}]}}');
    expect(readings[0]?.cpuPercent).toBe(0);
    expect(readings[1]?.cpuPercent).toBe(100);
  });
});

describe('evaluateThresholds', () => {
  const cfg = { cpuThreshold: 70, memoryThreshold: 70 };

  test('finds the cpu peak and counts breaching ticks', () => {
    const raw = report(
      {
        ticks: [
          { timestamp: 1, cpu: { percent: 40 }, mem: { free: 12 * GB } },
          { timestamp: 2, cpu: { percent: 88 }, mem: { free: 12 * GB } },
          { timestamp: 3, cpu: { percent: 72 }, mem: { free: 12 * GB } },
        ],
      },
      16 * GB,
    );
    const { readings, memTotalBytes: _ } = parseMonocartJson(raw);
    void _;
    const result = evaluateThresholds(readings, cfg);
    expect(result.peakCpuPercent).toBeCloseTo(88);
    expect(result.breachTicks.length).toBe(2);
    expect(result.breachTicks[0]?.reasons[0]).toContain('CPU 88.0%');
  });

  test('finds memory breaches via (total - free) / total', () => {
    const raw = report(
      {
        ticks: [{ timestamp: 9, cpu: { percent: 5 }, mem: { free: 2 * GB } }],
      },
      16 * GB,
    );
    const { readings } = parseMonocartJson(raw);
    const result = evaluateThresholds(readings, cfg);
    expect(result.peakMemoryPercent).toBeCloseTo((14 / 16) * 100);
    expect(result.breachTicks.length).toBe(1);
    expect(result.breachTicks[0]?.reasons.join(' ')).toContain('memory 87');
  });

  test('no breach at exact threshold values (strictly greater)', () => {
    const raw = report(
      { ticks: [{ timestamp: 1, cpu: { percent: 70 }, mem: { free: 16 * GB - 16 * GB * 0.7 } }] },
      16 * GB,
    );
    const { readings } = parseMonocartJson(raw);
    expect(evaluateThresholds(readings, cfg).breachTicks.length).toBe(0);
  });
});