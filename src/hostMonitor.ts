import * as core from '@actions/core';
import type { ThresholdConfig } from './types';
import { formatBytes } from './evaluate';
import { createHostSampler, type HostSample } from './hostSampler';

export interface HostMonitorOptions {
  intervalSeconds: number;
  /** Machine-wide CPU % ceiling (0–100 across all cores). */
  cpuThreshold: number;
  /** Machine memory % ceiling of the effective limit. */
  memoryThreshold: number;
  /** Cap live breach log groups so huge runs do not flood the log. */
  maxBreachLogs?: number;
}

export interface HostMachineSummary {
  samples: HostSample[];
  breaches: { at: number; reason: string; cpuPercent: number; memoryPercent: number }[];
  peakCpuPercent: number;
  peakMemoryPercent: number;
  peakMemoryBytes: number;
  source: 'action' | null;
}

/**
 * Action-native machine-wide monitor (Linux): samples /proc/stat and
 * /proc/meminfo every tick, keeps peaks and breach ticks, and logs live
 * warnings — the machine-layer counterpart of TabMonitor, with zero
 * user-side configuration.
 */
export class HostMonitor {
  private readonly sampler: ReturnType<typeof createHostSampler>;
  private readonly options: HostMonitorOptions;
  private readonly samples: HostSample[] = [];
  private readonly breaches: HostMachineSummary['breaches'] = [];
  private peakCpuPercent = 0;
  private peakMemoryPercent = 0;
  private peakMemoryBytes = 0;
  private timer: NodeJS.Timeout | null = null;
  private tickInFlight = false;
  private stopped = false;
  private breachLogCount = 0;
  private overflowLogged = false;

  constructor(options: HostMonitorOptions) {
    this.options = options;
    this.sampler = createHostSampler(null);
  }

  static async create(options: HostMonitorOptions): Promise<HostMonitor | null> {
    // Host sampling needs Linux; nothing to do elsewhere (tab layer and/or
    // monocart still apply).
    if (process.platform !== 'linux') return null;
    const monitor = new HostMonitor(options);
    return monitor;
  }

  start(): void {
    if (this.stopped || this.timer !== null) return;
    const ms = Math.max(500, this.options.intervalSeconds * 1000);
    this.timer = setInterval(() => {
      void this.tickOnce();
    }, ms);
    this.timer.unref?.();
    void this.tickOnce();
  }

  /** One sampling + evaluation pass. Re-entrancy guarded. */
  async tickOnce(): Promise<void> {
    if (this.stopped || this.tickInFlight) return;
    this.tickInFlight = true;
    try {
      const sample = this.sampler.sample();
      if (!sample) return;
      this.samples.push(sample);
      if (sample.cpuPercent > this.peakCpuPercent) this.peakCpuPercent = sample.cpuPercent;
      if (sample.memoryPercent > this.peakMemoryPercent) {
        this.peakMemoryPercent = sample.memoryPercent;
        this.peakMemoryBytes = sample.memoryBytes;
      }
      const breaches: string[] = [];
      if (sample.cpuPercent > this.options.cpuThreshold) {
        breaches.push(
          `machine CPU ${sample.cpuPercent.toFixed(1)}% > ${this.options.cpuThreshold}% (all cores)`,
        );
      }
      if (sample.memoryPercent > this.options.memoryThreshold) {
        breaches.push(
          `machine memory ${sample.memoryPercent.toFixed(1)}% > ${this.options.memoryThreshold}% ` +
            `(${formatBytes(sample.memoryBytes)} used)`,
        );
      }
      if (breaches.length > 0) {
        this.breaches.push({
          at: sample.timestamp,
          reason: breaches.join('; '),
          cpuPercent: sample.cpuPercent,
          memoryPercent: sample.memoryPercent,
        });
        this.logBreach(sample, breaches);
      }
    } finally {
      this.tickInFlight = false;
    }
  }

  private logBreach(sample: HostSample, reasons: string[]): void {
    const max = this.options.maxBreachLogs ?? 10;
    if (this.breachLogCount < max) {
      const when = new Date(sample.timestamp).toISOString().slice(11, 19);
      core.startGroup(`RESOURCE ALERT (machine) at ${when}`);
      core.warning(`Machine threshold breach: ${reasons.join('; ')}`);
      core.endGroup();
      this.breachLogCount++;
    } else if (!this.overflowLogged) {
      this.overflowLogged = true;
      core.warning(
        `Further machine threshold breaches are recorded but no longer logged individually (cap ${max}).`,
      );
    }
  }

  finish(): HostMachineSummary {
    if (this.samples.length === 0) {
      core.debug('Host machine layer collected no samples.');
    }
    return {
      samples: this.samples,
      breaches: this.breaches,
      peakCpuPercent: this.peakCpuPercent,
      peakMemoryPercent: this.peakMemoryPercent,
      peakMemoryBytes: this.peakMemoryBytes,
      source: this.samples.length > 0 ? 'action' : null,
    };
  }

  stop(): HostMachineSummary {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.stopped = true;
    this.sampler.stop();
    return this.finish();
  }
}