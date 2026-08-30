import * as core from '@actions/core';
import { killTree, spawnShellCommand, waitForExit, allocateFreePort, CDP_PORT_ENV_VAR } from './spawn';
import { readActionInputs, resolveWorkPath } from './inputs';
import { createProcSampler, probeClockTicks } from './procSampler';
import { createCdpSampler } from './cdpSampler';
import { TabMonitor } from './tabMonitor';
import type { MonitorSummary } from './types';
import { resolveRamLimitBytes } from './limit';
import { writeReports } from './report';
import { evaluateThresholds as evaluateMachine, loadReadings } from './monocart';
import { formatBytes } from './evaluate';

const FINISH_DELAY_MS = 800;

class SettledError extends Error {}

function setFailure(exception: Error): never {
  core.setFailed(exception.message); // emits an ::error:: annotation itself
  throw new SettledError(exception.message);
}

async function resolveCdpPort(): Promise<number> {
  const envPort = Number(process.env[CDP_PORT_ENV_VAR] ?? '');
  return Number.isInteger(envPort) && envPort > 0 ? envPort : allocateFreePort();
}

async function run(): Promise<void> {
  const inputs = readActionInputs();
  await probeClockTicks();
  const ramLimitBytes = await resolveRamLimitBytes();
  const startedAt = Date.now();

  const cdpPort: number = inputs.cdpPort ?? (await resolveCdpPort());

  core.startGroup('Playwright Resource Monitor — configuration');
  core.info(`run-command:              ${inputs.runCommand}`);
  core.info(`machine-cpu-threshold:    ${inputs.machineCpuThreshold}% (all cores, monocart sampler)`);
  core.info(`machine-memory-threshold: ${inputs.machineMemoryThreshold}% of total RAM`);
  core.info(`tab-cpu-threshold:        ${inputs.tabCpuThreshold}% of one core (worst single tab)`);
  core.info(`tab-memory-threshold:     ${inputs.tabMemoryThreshold}% of ${formatBytes(ramLimitBytes)}`);
  core.info(`polling-interval:         ${inputs.pollingIntervalSeconds}s`);
  core.info(`fail-on-breach:           ${inputs.failOnBreach}`);
  core.info(`monocart-json:            ${inputs.monocartJson}`);
  core.info(`CDP port (injected as ${CDP_PORT_ENV_VAR}): ${cdpPort}`);
  core.endGroup();

  // ---- Layer 2: per-tab sampling during the run -------------------------
  const samplers = [createProcSampler()];
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
    thresholds: { cpuThreshold: inputs.tabCpuThreshold, memoryThreshold: inputs.tabMemoryThreshold },
    ramLimitBytes,
    samplers,
  });
  monitor.start();

  const child = spawnShellCommand(inputs.runCommand, {
    ...process.env,
    [CDP_PORT_ENV_VAR]: String(cdpPort),
  });

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

  const exitInfo = await waitForExit(child);

  // Stop CDP probing once the command is done, then finish tab sampling.
  cdpAbort.abort();
  await cdpAttempt;
  await new Promise((resolve) => setTimeout(resolve, FINISH_DELAY_MS));
  await monitor.tickOnce();
  const tabSummary: MonitorSummary = await monitor.stop();

  // Per-tab report artifact (the detail monocart's report lacks).
  const tabReport = writeReports(resolveWorkPath(inputs.reportDir), tabSummary, {
    runCommand: inputs.runCommand,
    cpuThreshold: inputs.tabCpuThreshold,
    memoryThreshold: inputs.tabMemoryThreshold,
    pollingIntervalSeconds: inputs.pollingIntervalSeconds,
    ramLimitBytes,
    cdpPort,
    startedAt,
    finishedAt: Date.now(),
    commandExitCode: exitInfo.code,
    commandSignal: exitInfo.signal,
  });

  // ---- Layer 1: machine-wide evaluation from monocart's report ----------
  const monocartPath = resolveWorkPath(inputs.monocartJson);
  const { reportFound: monocartFound, readings } = loadReadings(monocartPath);
  const machine = evaluateMachine(readings, {
    cpuThreshold: inputs.machineCpuThreshold,
    memoryThreshold: inputs.machineMemoryThreshold,
  });

  setOutputs(tabSummary, machine, monocartFound, tabReport.jsonPath);
  printSummary(inputs, tabSummary, machine, monocartFound, monocartPath, tabReport.jsonPath);

  // ---- Verdicts ---------------------------------------------------------
  const commandFailed = exitInfo.error !== null || exitInfo.code !== 0;
  const machineBreached = machine.breachTicks.length > 0;
  const tabBreached = tabSummary.breaches.length > 0;

  if (exitInfo.error !== null) {
    setFailure(new Error(`Failed to start run-command: ${exitInfo.error.message}`));
    return;
  }
  if (commandFailed) {
    const breachNote = machineBreached || tabBreached ? ' Threshold breaches were also recorded (see reports).' : '';
    setFailure(new Error(`run-command failed with exit code ${exitInfo.code ?? '?'}, signal ${exitInfo.signal ?? 'none'}.${breachNote}`));
    return;
  }
  if (machineBreached || tabBreached) {
    const message = buildBreachMessage(inputs, machine, machineBreached, tabSummary, tabBreached);
    if (inputs.failOnBreach) {
      setFailure(new Error(message));
      return;
    }
    core.warning(message);
    return;
  }
  if (!monocartFound && tabSummary.readings.length === 0) {
    core.warning(
      'Neither monitoring layer produced data: no monocart JSON found at ' +
        `"${inputs.monocartJson}" (add monocart-reporter with json:true — see README) and no browser ` +
        'processes were observed by the tab sampler (proc scanner is Linux-only; enable CDP mode elsewhere).',
    );
  } else {
    core.info(
      `No threshold breach detected (machine: ${readings.length} samples, tab: ${tabSummary.readings.length} samples). All good.`,
    );
  }
}

function buildBreachMessage(
  inputs: { machineCpuThreshold: number; machineMemoryThreshold: number; tabCpuThreshold: number; tabMemoryThreshold: number },
  machine: { peakCpuPercent: number; peakMemoryPercent: number; breachTicks: unknown[] },
  machineBreached: boolean,
  tabSummary: MonitorSummary,
  tabBreached: boolean,
): string {
  const parts: string[] = [];
  const counts: string[] = [];
  if (machineBreached) {
    parts.push(
      `machine CPU peaked at ${machine.peakCpuPercent.toFixed(1)}% (threshold ${inputs.machineCpuThreshold}%), ` +
      `machine memory at ${machine.peakMemoryPercent.toFixed(1)}% of total RAM (threshold ${inputs.machineMemoryThreshold}%)`,
    );
    counts.push(`${machine.breachTicks.length} machine sample(s)`);
  }
  if (tabBreached) {
    parts.push(
      `worst tab peaked at ${(tabSummary.peakCpu?.cpuPercent ?? 0).toFixed(1)}% of one core (threshold ${inputs.tabCpuThreshold}%), ` +
      `at ${(tabSummary.peakMem?.memoryPercent ?? 0).toFixed(1)}% of RAM (threshold ${inputs.tabMemoryThreshold}%)`,
    );
    counts.push(`${tabSummary.breaches.length} tab sample(s)`);
  }
  return `Resource threshold breach: ${parts.join('; ')}. Breaching: ${counts.join(' + ')}. See the monocart report and the resource-monitor tab report for the full timeline.`;
}

interface MachineEval {
  peakCpuPercent: number;
  peakMemoryPercent: number;
  breachTicks: unknown[];
}

function setOutputs(
  tabSummary: MonitorSummary,
  machine: MachineEval,
  monocartFound: boolean,
  tabReportJsonPath: string,
): void {
  core.setOutput('peak-machine-cpu-percent', machine.peakCpuPercent.toFixed(2));
  core.setOutput('peak-machine-memory-percent', machine.peakMemoryPercent.toFixed(2));
  core.setOutput('machine-breach-count', String(machine.breachTicks.length));
  core.setOutput('peak-tab-cpu-percent', (tabSummary.peakCpu?.cpuPercent ?? 0).toFixed(2));
  core.setOutput('peak-tab-memory-percent', (tabSummary.peakMem?.memoryPercent ?? 0).toFixed(2));
  core.setOutput('tab-breach-count', String(tabSummary.breaches.length));
  core.setOutput('tab-sample-count', String(tabSummary.readings.length));
  core.setOutput('tab-source', tabSummary.source ?? 'none');
  core.setOutput('monocart-found', String(monocartFound));
  core.setOutput('report-json-path', tabReportJsonPath);
}

function printSummary(
  inputs: { machineCpuThreshold: number; machineMemoryThreshold: number; tabCpuThreshold: number; tabMemoryThreshold: number },
  tabSummary: MonitorSummary,
  machine: MachineEval,
  monocartFound: boolean,
  monocartPath: string,
  tabReportJsonPath: string,
): void {
  const rows: (string | { data: string; header?: boolean })[][] = [
    [{ data: 'Layer', header: true }, { data: 'Metric', header: true }, { data: 'Peak', header: true }, { data: 'Threshold', header: true }],
  ];
  if (monocartFound) {
    rows.push(['machine (monocart)', 'CPU, all cores', `${machine.peakCpuPercent.toFixed(1)}%`, `${inputs.machineCpuThreshold}%`]);
    rows.push(['machine (monocart)', 'Memory, % of RAM', `${machine.peakMemoryPercent.toFixed(1)}%`, `${inputs.machineMemoryThreshold}%`]);
  }
  if (tabSummary.peakCpu !== null) {
    rows.push(['tab', 'CPU, % of one core', `${tabSummary.peakCpu.cpuPercent.toFixed(1)}%`, `${inputs.tabCpuThreshold}%`]);
  }
  if (tabSummary.peakMem !== null) {
    rows.push(['tab', 'Memory, % of RAM limit', `${tabSummary.peakMem.memoryPercent.toFixed(1)}%`, `${inputs.tabMemoryThreshold}%`]);
  }
  if (rows.length === 1) return;

  const extras = [`Monocart timeline: <code>${monocartPath}</code>`];
  if (tabSummary.readings.length > 0) {
    extras.push(`Tab report: <code>${tabReportJsonPath}</code>`);
  }

  core.summary
    .addHeading('Playwright Resource Monitor')
    .addTable(rows)
    .addRaw(`<p>${extras.join(' | ')}.</p>`)
    .write()
    .catch((): void => {});
}

async function main(): Promise<void> {
  try {
    await run();
  } catch (err) {
    if (!(err instanceof SettledError)) {
      core.setFailed(`Unexpected failure in playwright-resource-monitor: ${(err as Error).message}`);
    }
  }
}

void main();