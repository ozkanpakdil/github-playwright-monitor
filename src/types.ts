/**
 * Shared domain types for playwright-resource-monitor.
 */

/** Chromium/Playwright process classification. Tabs are `renderer` processes. */
export type ProcType = 'renderer' | 'browser' | 'gpu' | 'utility' | 'other';

/** Where a sample came from. */
export type SampleSource = 'cdp' | 'proc';

/** Metrics for one browser-related process at one instant. */
export interface ProcessSample {
  /** Stable identity across samples (pid or CDP type:id key). */
  key: string;
  pid?: number;
  type: ProcType;
  /** Human readable name, e.g. "renderer pid 4242". */
  label: string;
  /**
   * CPU consumed during the elapsed interval, as a percentage of a single
   * core (100% = one core fully busy). Can exceed 100% for multithreaded
   * processes.
   */
  cpuPercent: number;
  /** Resident / private working set memory in bytes. */
  memoryBytes: number;
}

/** One polling snapshot across all observed browser processes. */
export interface Sample {
  /** Epoch ms of the sample. */
  timestamp: number;
  /** Wall-clock seconds this CPU delta was measured over. */
  intervalSeconds: number;
  source: SampleSource;
  processes: ProcessSample[];
}

/** A single sampling backend (CDP or /proc scanner). */
export interface Sampler {
  readonly kind: SampleSource;
  /** Take one sample; resolves null when nothing was observed this tick. */
  sample(): Promise<Sample | null>;
  /** Release every background resource (sockets, timers). Idempotent. */
  stop(): Promise<void>;
}

/** An evaluated "tab" reading used for threshold decisions. */
export interface TabReading {
  timestamp: number;
  intervalSeconds: number;
  source: SampleSource;
  /** Worst tab (renderer) found, or null when no renderer was seen. */
  worst: ProcessSample | null;
  /** Worst tab memory as % of the effective RAM limit. */
  memoryPercent: number;
}

export interface ThresholdConfig {
  /** % of one core allowed for the worst single tab. */
  cpuThreshold: number;
  /** % of effective RAM allowed for the worst single tab. */
  memoryThreshold: number;
}

export interface PeakInfo {
  cpuPercent: number;
  memoryPercent: number;
  label: string;
  source: SampleSource;
  at: number;
}

export interface Breach {
  at: number;
  reason: string;
  cpuPercent: number;
  memoryPercent: number;
  label: string;
}

export interface MonitorSummary {
  samples: Sample[];
  readings: TabReading[];
  breaches: Breach[];
  peakCpu: PeakInfo | null;
  peakMem: PeakInfo | null;
  source: SampleSource | null;
}