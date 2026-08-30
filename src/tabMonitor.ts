import * as core from '@actions/core';
import type {
  Breach,
  MonitorSummary,
  PeakInfo,
  Sample,
  SampleSource,
  Sampler,
  TabReading,
  ThresholdConfig,
} from './types';
import {
  breachReasons,
  breachesThreshold,
  formatTopProcesses,
  toReading,
} from './evaluate';

export interface TabMonitorOptions {
  intervalSeconds: number;
  thresholds: ThresholdConfig;
  ramLimitBytes: number;
  samplers: Sampler[];
  /** Cap live breach log groups so huge runs do not flood the log. */
  maxBreachLogs?: number;
}

const MAX_KEPT_SAMPLES = 100_000;

/**
 * Polls every attached sampler, evaluates the worst single tab against the
 * thresholds each tick, records peaks and breaches, and logs live warnings
 * inside GitHub Actions groups (throttled to maxBreachLogs groups).
 */
export class TabMonitor {
  readonly samples: Sample[] = [];
  readonly readings: TabReading[] = [];
  readonly breaches: Breach[] = [];
  peakCpu: PeakInfo | null = null;
  peakMem: PeakInfo | null = null;
  evalSource: SampleSource | null = null;

  private readonly lastBySource = new Map<SampleSource, Sample>();
  private readonly samplers: Sampler[] = [];
  private readonly options: TabMonitorOptions;
  private timer: NodeJS.Timeout | null = null;
  private startedAt = 0;
  private tickInFlight = false;
  private stopped = false;
  private breachLogCount = 0;
  private overflowLogged = false;

  constructor(options: TabMonitorOptions) {
    this.options = options;
    for (const sampler of options.samplers) {
      this.addSampler(sampler);
    }
  }

  addSampler(sampler: Sampler): void {
    if (!this.stopped) {
      this.samplers.push(sampler);
    }
  }

  start(): void {
    if (this.stopped || this.timer !== null) return;
    this.startedAt = Date.now();
    const ms = Math.max(500, this.options.intervalSeconds * 1000);
    this.timer = setInterval(() => {
      void this.tickOnce();
    }, ms);
    this.timer.unref?.(); // never hold the event loop open for the poll timer
    void this.tickOnce();
  }

  /** One sampling + evaluation pass. Re-entrancy guarded. */
  async tickOnce(): Promise<void> {
    if (this.stopped || this.tickInFlight || this.samplers.length === 0) return;
    this.tickInFlight = true;
    try {
      for (const sampler of this.samplers) {
        try {
          const sample = await sampler.sample();
          if (sample && sample.processes.length > 0) {
            this.lastBySource.set(sample.source, sample);
          }
        } catch (err) {
          core.debug(`sampler ${sampler.kind} failed: ${(err as Error).message}`);
        }
      }

      // CDP wins once it has ever produced data (precisely labeled tabs).
      const evalSample = this.lastBySource.get('cdp') ?? this.lastBySource.get('proc') ?? null;
      if (!evalSample) return;

      this.evalSource = evalSample.source;
      this.samples.push(evalSample);
      if (this.samples.length > MAX_KEPT_SAMPLES) {
        this.samples.splice(0, this.samples.length - MAX_KEPT_SAMPLES);
      }

      const reading = toReading(evalSample, this.options.ramLimitBytes);
      this.readings.push(reading);
      this.updatePeaks(reading);

      if (breachesThreshold(reading, this.options.thresholds)) {
        const reasons = breachReasons(reading, this.options.thresholds);
        this.breaches.push({
          at: reading.timestamp,
          reason: reasons.join('; '),
          cpuPercent: reading.worst?.cpuPercent ?? 0,
          memoryPercent: reading.memoryPercent,
          label: reading.worst?.label ?? 'unknown tab',
        });
        this.logBreach(evalSample, reading, reasons);
      }
    } finally {
      this.tickInFlight = false;
    }
  }

  private updatePeaks(reading: TabReading): void {
    const worst = reading.worst;
    if (!worst) return;
    if (this.peakCpu === null || worst.cpuPercent > this.peakCpu.cpuPercent) {
      this.peakCpu = {
        cpuPercent: worst.cpuPercent,
        memoryPercent: reading.memoryPercent,
        label: worst.label,
        source: reading.source,
        at: reading.timestamp,
      };
    }
    if (this.peakMem === null || reading.memoryPercent > this.peakMem.memoryPercent) {
      this.peakMem = {
        cpuPercent: worst.cpuPercent,
        memoryPercent: reading.memoryPercent,
        label: worst.label,
        source: reading.source,
        at: reading.timestamp,
      };
    }
  }

  private logBreach(sample: Sample, reading: TabReading, reasons: string[]): void {
    const max = this.options.maxBreachLogs ?? 10;
    if (this.breachLogCount < max) {
      const when = new Date(reading.timestamp).toISOString().slice(11, 19);
      core.startGroup(
        `RESOURCE ALERT #${this.breaches.length} at ${when} — worst tab: ${reading.worst?.label ?? 'unknown'}`,
      );
      core.warning(`Threshold breach: ${reasons.join('; ')}`);
      core.info(formatTopProcesses(sample, this.options.ramLimitBytes, 5));
      core.endGroup();
      this.breachLogCount++;
    } else if (!this.overflowLogged) {
      this.overflowLogged = true;
      core.warning(
        `Further threshold breaches are recorded but no longer logged individually (cap ${max}); totals appear in the report.`,
      );
    }
  }

  finish(): MonitorSummary {
    if (this.readings.length === 0) {
      // Not an error: plenty of run-commands launch no browsers at all.
      core.debug('Tab layer collected no samples (no observed browser processes).');
    }
    return {
      samples: this.samples,
      readings: this.readings,
      breaches: this.breaches,
      peakCpu: this.peakCpu,
      peakMem: this.peakMem,
      source: this.evalSource,
    };
  }

  async stop(): Promise<MonitorSummary> {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.stopped = true;
    await Promise.allSettled(this.samplers.map((sampler) => sampler.stop()));
    return this.finish();
  }
}