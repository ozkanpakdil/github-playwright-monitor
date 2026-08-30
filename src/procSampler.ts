import { readdirSync, readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { basename } from 'node:path';
import type { ProcType, ProcessSample, Sample, Sampler } from './types';
import { cpuPercent, sanitizeCpuPercent } from './evaluate';

const execFileAsync = promisify(execFile);

/** Linux defines CLK_TCK=100 universally, but asking beats assuming. */
let clockTicksPerSecond = 100;
export async function probeClockTicks(): Promise<void> {
  try {
    const { stdout } = await execFileAsync('getconf', ['CLK_TCK'], { timeout: 2000 });
    const value = Number(stdout.trim());
    if (Number.isFinite(value) && value > 0) clockTicksPerSecond = value;
  } catch {
    // keep the POSIX default
  }
}

interface ProcRow {
  pid: number;
  command: string; // argv joined with spaces
  argv0: string;
  type: ProcType;
  totalTicks: number;
  rssBytes: number;
}

const BROWSER_NAMES = new Set([
  'chrome',
  'chromium',
  'headless_shell',
  'chrome-headless-shell',
  'chrome-wrapper',
  'firefox',
]);

function classify(argv0: string, command: string): ProcType | null {
  const looksLikePlaywright = /ms-playwright|playwright/i.test(command);
  const name = basename(argv0);
  const isKnownBrowser = BROWSER_NAMES.has(name);
  const hasBrowserFlags =
    command.includes('--remote-debugging-pipe') ||
    command.includes('--headless') ||
    command.includes('-headless') ||
    command.includes('--user-data-dir');

  if (!looksLikePlaywright && !(isKnownBrowser && hasBrowserFlags)) {
    return null;
  }
  if (command.includes('--type=renderer')) return 'renderer';
  if (command.includes('--type=gpu-process')) return 'gpu';
  if (command.includes('--type=utility')) return 'utility';
  if (command.includes('--type=zygote')) return 'other';
  return 'browser';
}

function readRow(pid: number): ProcRow | null {
  let argv: string[];
  try {
    const cmdlineRaw = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    argv = cmdlineRaw.split('\0').filter((a) => a.length > 0);
    if (argv.length === 0) return null; // kernel thread
  } catch {
    return null; // permission or vanished
  }

  let statRaw: string;
  try {
    statRaw = readFileSync(`/proc/${pid}/stat`, 'utf8');
  } catch {
    return null; // stat unreadable, process vanished
  }
  // comm may contain spaces and parens: cut at the LAST ')'
  const closeParen = statRaw.lastIndexOf(')');
  if (closeParen < 0) return null;
  const rest = statRaw.slice(closeParen + 2).split(' ');
  // rest[0]=state(field 3) rest[1]=ppid(4) ... utime=field14 => rest[11], stime=field15 => rest[12]
  const utimeTicks = Number(rest[11]);
  const stimeTicks = Number(rest[12]);
  if (!Number.isFinite(utimeTicks) || !Number.isFinite(stimeTicks)) return null;

  let rssBytes = 0;
  try {
    const status = readFileSync(`/proc/${pid}/status`, 'utf8');
    const match = /VmRSS:\s+(\d+)\s+kB/.exec(status);
    if (match && match[1]) rssBytes = Number(match[1]) * 1024;
  } catch {
    // status unreadable for this process; keep rss 0
  }

  const argv0 = argv[0] ?? '';
  return {
    pid,
    command: argv.join(' '),
    argv0,
    type: classify(argv0, argv.join(' ')) ?? 'other',
    totalTicks: utimeTicks + stimeTicks,
    rssBytes,
  };
}

/**
 * Sampler that discovers Playwright-launched browser processes by scanning
 * /proc and tracks per-pid CPU time deltas. Tabs are the processes whose
 * command line contains `--type=renderer`.
 */
export function createProcSampler(): Sampler {
  const previousTicks = new Map<number, number>();
  let previousAt: number | null = null;
  let stopped = false;

  return {
    kind: 'proc',

    async sample(): Promise<Sample | null> {
      if (stopped || process.platform !== 'linux') return null;

      let pids: number[];
      try {
        pids = readdirSync('/proc')
          .filter((entry) => /^\d+$/.test(entry))
          .map((entry) => Number(entry));
      } catch {
        return null; // /proc unavailable — non-Linux or restricted container
      }

      const rows: ProcRow[] = [];
      for (const pid of pids) {
        const row = readRow(pid);
        if (row) rows.push(row);
      }
      if (rows.length === 0) return null;

      const now = Date.now();
      const intervalSeconds =
        previousAt === null ? 0 : Math.max(0.1, (now - previousAt) / 1000);
      previousAt = now;

      const processes: ProcessSample[] = rows.map((row) => {
        const prevTicks = previousTicks.get(row.pid);
        const cpuPct =
          prevTicks !== undefined && intervalSeconds > 0
            ? cpuPercent((row.totalTicks - prevTicks) / clockTicksPerSecond, intervalSeconds)
            : 0;
        previousTicks.set(row.pid, row.totalTicks);
        return {
          key: `proc:${row.pid}`,
          pid: row.pid,
          type: row.type,
          label: `${row.type} pid ${row.pid}`,
          cpuPercent: sanitizeCpuPercent(cpuPct),
          memoryBytes: row.rssBytes,
        };
      });

      // Prune vanished processes from tick history.
      const alive = new Set(rows.map((row) => row.pid));
      for (const pid of previousTicks.keys()) {
        if (!alive.has(pid)) previousTicks.delete(pid);
      }

      return {
        timestamp: now,
        intervalSeconds: intervalSeconds || 0.1,
        source: 'proc',
        processes,
      };
    },

    async stop(): Promise<void> {
      stopped = true;
      previousTicks.clear();
      previousAt = null;
    },
  };
}