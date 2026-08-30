import * as core from '@actions/core';
import { CDP_PORT_ENV_VAR, allocateFreePort, killTree, spawnShellCommand, waitForExit, workspaceReportDir } from './spawn';
import type { ExitInfo } from './spawn';
import { readActionInputs } from './inputs';
import { createProcSampler, probeClockTicks } from './procSampler';
import { createCdpSampler } from './cdpSampler';
import { TabMonitor } from './tabMonitor';
import { resolveRamLimitBytes } from './limit';
import { writeReports, type ReportMeta } from './report';
import { formatBytes } from './evaluate';

const FINAL_SAMPLE_DELAY_MS = 800;

function output(value: number | string | null | undefined): string {
  if (value === null || value === undefined) return '';
  return typeof value === 'number' ? value.toFixed(2) : String(value);
}

/** Sentinel so main() does not call setFailed twice for the same problem. */
class SettledError extends Error {}

function setFailure(exception: Error): never {
  core.setFailed(exception.message); // emits an ::error:: annotation itself
  throw new SettledError(exception.message);
}

async function run(): Promise<void> {
  const inputs = readActionInputs();
  await probeClockTicks();
  const ramLimitBytes = await resolveRamLimitBytes();

  // CDP port precedence: explicit input > pre-existing env > auto-allocated.
  let cdpPort = inputs.cdpPort;
  if (cdpPort === null) {
    const envPort = Number(process.env[CDP_PORT_ENV_VAR] ?? '');
    cdpPort = Number.isInteger(envPort) && envPort > 0 ? envPort : await allocateFreePort();
  }

  core.startGroup('Playwright Resource Monitor — configuration');
  core.info(`run-command:        ${inputs.runCommand}`);
  core.info(`cpu-threshold:      ${inputs.cpuThreshold}% of one core (worst single tab)`);
  core.info(`memory-threshold:   ${inputs.memoryThreshold}% of ${formatBytes(ramLimitBytes)} (effective RAM limit)`);
  core.info(`polling-interval:   ${inputs.pollingIntervalSeconds}s`);
  core.info(`fail-on-breach:     ${inputs.failOnBreach}`);
  core.info(`CDP port (injected as ${CDP_PORT_ENV_VAR} for the run-command): ${cdpPort}`);
  if (process.platform !== 'linux' && inputs.cdpPort === null) {
    core.warning('The /proc scanner only works on Linux. On this OS, enable CDP mode: set the cdp-port input and follow the README playwright.config.ts snippet.');
  }
  core.endGroup();

  // The /proc sampler self-guards on non-Linux (sample() no-ops there).
  const samplers = [createProcSampler()];

  // Attach CDP in the background while the command boots; it only succeeds
  // if the user's Playwright config opened the debugging port. Probing stops
  // as soon as the command exits so short runs are not delayed.
  const cdpAbort = new AbortController();
  const cdpAttempt = createCdpSampler('127.0.0.1', cdpPort, cdpAbort.signal)
    .then((sampler) => {
      if (sampler !== null) {
        monitor.addSampler(sampler);
        core.info('CDP endpoint detected — using precise per-tab metrics.');
      }
      return sampler;
    })
    .catch((err: Error) => {
      core.debug(`CDP attach failed: ${err.message}`);
      return null;
    });

  const monitor = new TabMonitor({
    intervalSeconds: inputs.pollingIntervalSeconds,
    thresholds: { cpuThreshold: inputs.cpuThreshold, memoryThreshold: inputs.memoryThreshold },
    ramLimitBytes,
    samplers,
  });
  monitor.start();

  const startedAt = Date.now();
  const child = spawnShellCommand(inputs.runCommand, {
    ...process.env,
    [CDP_PORT_ENV_VAR]: String(cdpPort),
  });

  let exitInfo: ExitInfo = { code: null, signal: null, error: null };
  let interrupted = false;
  const onSignal = (signal: NodeJS.Signals): void => {
    if (interrupted || child.pid === undefined) return;
    interrupted = true;
    core.warning(`Received ${signal}; terminating the run-command tree.`);
    void killTree(child).then(() => {
      process.exit(128 + (signal === 'SIGINT' ? 2 : 15));
    });
  };
  process.once('SIGINT', () => onSignal('SIGINT'));
  process.once('SIGTERM', () => onSignal('SIGTERM'));

  exitInfo = await waitForExit(child);
  cdpAbort.abort(); // no point probing for a CDP endpoint after teardown
  await cdpAttempt; // settle attach promise (sampler already added on success)

  // One last sample catches the tail of the run before browsers exit.
  await new Promise((r) => setTimeout(r, FINAL_SAMPLE_DELAY_MS));
  await monitor.tickOnce();
  const summary = await monitor.stop();

  const finishedAt = Date.now();
  const commandFailed = exitInfo.error !== null || exitInfo.code !== 0;

  const reportDir = workspaceReportDir(inputs.reportDir);
  const reportMeta: ReportMeta = {
    runCommand: inputs.runCommand,
    cpuThreshold: inputs.cpuThreshold,
    memoryThreshold: inputs.memoryThreshold,
    pollingIntervalSeconds: inputs.pollingIntervalSeconds,
    ramLimitBytes,
    cdpPort,
    startedAt,
    finishedAt,
    commandExitCode: exitInfo.code,
    commandSignal: exitInfo.signal,
  };
  const reports = writeReports(reportDir, summary, reportMeta);

  setOutputs(summary, reports.jsonPath, reports.csvPath);
  printSummaryLine(summary, reportDir, commandFailed, inputs.cpuThreshold, inputs.memoryThreshold);

  if (exitInfo.error !== null) {
    setFailure(new Error(`Failed to start run-command: ${exitInfo.error.message}`));
    return;
  }
  if (commandFailed) {
    const breachNote = summary.breaches.length > 0 ? ' Threshold breaches were also recorded (see the report).' : '';
    setFailure(new Error(`run-command failed with exit code ${exitInfo.code ?? '?'}, signal ${exitInfo.signal ?? 'none'}.${breachNote}`));
    return;
  }
  if (summary.breaches.length > 0) {
    const peakMemBytes = memoryBytesOf(summary);
    const message =
      `Resource threshold breach during the run: ` +
      `peak tab CPU ${summary.peakCpu?.cpuPercent.toFixed(1) ?? '?'}% of one core ` +
      `(threshold ${inputs.cpuThreshold}%), ` +
      `peak tab memory ${formatBytes(peakMemBytes)} ` +
      `(${summary.peakMem?.memoryPercent.toFixed(1) ?? '?'}% of limit, threshold ${inputs.memoryThreshold}%). ` +
      `${summary.breaches.length} breaching sample(s); full data in ${reports.jsonPath}`;
    if (inputs.failOnBreach) {
      setFailure(new Error(message));
      return;
    }
    core.warning(message);
  } else {
    core.info('No threshold breach detected. All good.');
  }
}

function memoryBytesOf(
  summary: { readings: { worst?: { memoryBytes?: number } | null }[] },
): number {
  let maxBytes = 0;
  for (const reading of summary.readings) {
    const bytes = reading.worst?.memoryBytes ?? 0;
    if (bytes > maxBytes) maxBytes = bytes;
  }
  return maxBytes;
}

function setOutputs(
  summary: {
    peakCpu: { cpuPercent: number; label: string } | null;
    peakMem: { memoryPercent: number; label: string } | null;
    breaches: unknown[];
    readings: unknown[];
    source: string | null;
  },
  jsonPath: string,
  csvPath: string,
): void {
  core.setOutput('peak-tab-cpu-percent', output(summary.peakCpu?.cpuPercent ?? null));
  core.setOutput('peak-tab-memory-percent', output(summary.peakMem?.memoryPercent ?? null));
  core.setOutput('peak-tab-label', output(summary.peakCpu?.label ?? null));
  core.setOutput('breach-count', String(summary.breaches.length));
  core.setOutput('sample-count', String(summary.readings.length));
  core.setOutput('cdp-attached', String(summary.source === 'cdp'));
  core.setOutput('report-json-path', jsonPath);
  core.setOutput('report-csv-path', csvPath);
}

function printSummaryLine(
  summary: {
    peakCpu: { cpuPercent: number; label: string } | null;
    peakMem: { memoryPercent: number } | null;
    readings: unknown[];
  },
  reportDir: string,
  commandFailed: boolean,
  cpuThreshold: number,
  memoryThreshold: number,
): void {
  try {
    if (summary.readings.length === 0) return;
    core.summary
      .addHeading('Playwright Resource Monitor')
      .addTable([
        [{ data: 'Metric', header: true }, { data: 'Peak', header: true }, { data: 'Threshold', header: true }],
        [
          'Worst tab CPU (% of one core)',
          { data: `${summary.peakCpu?.cpuPercent.toFixed(1) ?? 'n/a'}% (${summary.peakCpu?.label ?? ''})` },
          `${cpuThreshold}%`,
        ],
        [
          'Worst tab memory (% of RAM limit)',
          { data: `${((summary.peakMem?.memoryPercent ?? 0)).toFixed(1)}%` },
          `${memoryThreshold}%`,
        ],
      ])
      .addRaw(`<p>Reports: <code>${reportDir}/report.json</code>, <code>${reportDir}/report.csv</code>. Command ${commandFailed ? 'failed' : 'succeeded'}.</p>`)
      .write();
  } catch {
    // summary writing must never break the action
  }
}

async function main(): Promise<void> {
  try {
    await run();
  } catch (err) {
    // setFailure() already reported the failure; this is for unexpected crashes only
    if (!(err instanceof SettledError)) {
      core.setFailed(`Unexpected failure in playwright-resource-monitor: ${(err as Error).message}`);
    }
  }
}

void main();