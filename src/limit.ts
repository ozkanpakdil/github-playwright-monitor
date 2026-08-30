import { readFileSync } from 'node:fs';
import os from 'node:os';

/**
 * Resolves the *effective* memory limit of the runner:
 * 1. cgroup v2 memory.max (containers / self-hosted runners with limits)
 * 2. cgroup v1 memory.limit_in_bytes
 * 3. os.totalmem() fallback (GitHub-hosted runners are effectively unbounded)
 *
 * The effective limit is the denominator for "memory % of runner" so the
 * threshold behaves the same on hosted runners, Docker containers and
 * self-hosted machines with configured caps.
 */
export async function resolveRamLimitBytes(): Promise<number> {
  const total = os.totalmem();

  // cgroup v2
  try {
    const raw = readFileSync('/sys/fs/cgroup/memory.max', 'utf8').trim();
    if (raw !== 'max') {
      const parsed = Number(raw);
      if (Number.isFinite(parsed) && parsed > 0) {
        return Math.min(parsed, total);
      }
    }
  } catch {
    // not on Linux / no cgroup v2 — fall through
  }

  // cgroup v1
  try {
    const raw = readFileSync('/sys/fs/cgroup/memory/memory.limit_in_bytes', 'utf8').trim();
    const parsed = Number(raw);
    // v1 reports absurdly large numbers when unlimited
    if (Number.isFinite(parsed) && parsed > 0 && parsed < Number.MAX_SAFE_INTEGER) {
      return Math.min(parsed, total);
    }
  } catch {
    // fall through
  }

  return total;
}

export function formatRamLimit(limitBytes: number): string {
  return limitBytes >= os.totalmem() ? `${(limitBytes / 1024 ** 3).toFixed(1)} GB (host total)` : `${formatGib(limitBytes)} (cgroup limit)`;
}

function formatGib(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}