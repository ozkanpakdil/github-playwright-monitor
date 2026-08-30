import { describe, expect, test } from 'bun:test';
import { parseMeminfo, parseProcStatLine } from '../src/hostSampler';

const GB = 1024 ** 3;

describe('parseProcStatLine', () => {
  test('computes idle and total from /proc/stat first line', () => {
    // cpu  user nice system idle iowait irq softirq steal
    const line = 'cpu  1000 0 500 4000 200 0 100 50 0 0 0';
    const stat = parseProcStatLine(line);
    expect(stat).not.toBeNull();
    // idleAll = idle(4000) + iowait(200) = 4200
    // nonIdle = 1000 + 0 + 500 + 0 + 100 + 50 = 1650
    expect(stat!.idle).toBe(4200);
    expect(stat!.total).toBe(5850);
  });

  test('rejects malformed lines', () => {
    expect(parseProcStatLine('cpu bogus values here')).toBeNull();
    expect(parseProcStatLine('')).toBeNull();
  });

  test('idle-only means zero usage delta', () => {
    const a = parseProcStatLine('cpu  0 0 0 1000 0 0 0 0')!;
    const b = parseProcStatLine('cpu  0 0 0 2000 0 0 0 0')!;
    const usage = (1 - (b.idle - a.idle) / Math.max(1, b.total - a.total)) * 100;
    expect(usage).toBeCloseTo(0, 5);
  });

  test('fully busy interval means 100% usage', () => {
    const a = parseProcStatLine('cpu  0 0 0 1000 0 0 0 0')!;
    const b = parseProcStatLine('cpu  1000 0 0 1000 0 0 0 0')!;
    const usage = (1 - (b.idle - a.idle) / Math.max(1, b.total - a.total)) * 100;
    expect(usage).toBeCloseTo(100, 5);
  });
});

describe('parseMeminfo', () => {
  const meminfo = ['MemTotal:       16384000 kB', 'MemFree:         1048576 kB', 'MemAvailable:    4194304 kB'].join('\n');

  test('uses MemAvailable, not MemFree, for host memory', () => {
    const stat = parseMeminfo(meminfo, null);
    expect(stat.total).toBe(16_384_000 * 1024);
    // used = total - available (in kB, converted to bytes); NOT MemFree
    expect(stat.usedBytes).toBe((16_384_000 - 4_194_304) * 1024);
  });

  test('ignores cgroup limit wider than host RAM', () => {
    const stat = parseMeminfo(meminfo, 32 * GB);
    expect(stat.limitBytes).toBeNull();
  });

  test('adopts cgroup limit tighter than host RAM', () => {
    const stat = parseMeminfo(meminfo, 8 * GB);
    expect(stat.limitBytes).toBe(8 * GB);
  });
});