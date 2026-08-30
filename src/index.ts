import * as core from '@actions/core';
import { killTree, spawnShellCommand, waitForExit } from './spawn';
import { readActionInputs, resolveWorkPath } from './inputs';
import { evaluateThresholds, loadReadings, type BreachTick, type SystemReading } from './monocart';

class SettledError extends Error {}

function setFailure(exception: Error): never {
  core.setFailed(exception.message); // emits an ::error:: annotation itself
  throw new SettledError(exception.message);
}

async function run(): Promise<void> {
  const inputs = readActionInputs();

  core.startGroup('Playwright Resource Monitor — configuration');
  core.info(`run-command:      ${inputs.runCommand}`);
  core.info(`cpu-threshold:    ${inputs.cpuThreshold}% (machine-wide, all cores)`);
  core.info(`memory-threshold: ${inputs.memoryThreshold}% of total RAM`);
  core.info(`fail-on-breach:   ${inputs.failOnBreach}`);
  core.info(`monocart-json:    ${inputs.monocartJson}`);
  core.endGroup();

  const child = spawnShellCommand(inputs.runCommand, { ...process.env });

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
  const commandFailed = exitInfo.error !== null || exitInfo.code !== 0;

  // Enforcement reads monocart's own sampler output after the run.
  const jsonPath = resolveWorkPath(inputs.monocartJson);
  const { reportFound, readings, memTotalBytes } = loadReadings(jsonPath);
  const cfg = { cpuThreshold: inputs.cpuThreshold, memoryThreshold: inputs.memoryThreshold };
  const { peakCpuPercent, peakMemoryPercent, breachTicks } = evaluateThresholds(readings, cfg);
  const breached = breachTicks.length > 0;

  setOutputs(peakCpuPercent, peakMemoryPercent, breachTicks.length, readings.length, reportFound);
  printSummary(inputs, { reportFound, readings, memTotalBytes, peakCpuPercent, peakMemoryPercent, breachTicks, jsonPath, commandFailed });

  if (exitInfo.error !== null) {
    setFailure(new Error(`Failed to start run-command: ${exitInfo.error.message}`));
    return;
  }
  if (commandFailed) {
    const breachNote = breached ? ' Threshold breaches were also recorded (see the report).' : '';
    setFailure(new Error(`run-command failed with exit code ${exitInfo.code ?? '?'}, signal ${exitInfo.signal ?? 'none'}.${breachNote}`));
    return;
  }
  if (breached) {
    const message =
      `Resource threshold breach: peak machine CPU ${peakCpuPercent.toFixed(1)}% ` +
      `(threshold ${inputs.cpuThreshold}%), peak memory ${peakMemoryPercent.toFixed(1)}% ` +
      `of total RAM (threshold ${inputs.memoryThreshold}%). ${breachTicks.length} breaching sample(s). ` +
      `Full timeline in the monocart report.`;
    if (inputs.failOnBreach) {
      setFailure(new Error(message));
      return;
    }
    core.warning(message);
    return;
  }
  if (!reportFound && readings.length === 0) {
    core.warning(
      `No monocart report data found at "${inputs.monocartJson}" — threshold enforcement was skipped. ` +
        'Add monocart-reporter to playwright.config with { outputFile: "./monocart-report/index.html", json: true } (see README).',
    );
  } else {
    core.info(`No threshold breach detected (${readings.length} samples). All good.`);
  }
}

function setOutputs(
  peakCpuPercent: number,
  peakMemoryPercent: number,
  breachCount: number,
  sampleCount: number,
  reportFound: boolean,
): void {
  core.setOutput('peak-cpu-percent', peakCpuPercent.toFixed(2));
  core.setOutput('peak-memory-percent', peakMemoryPercent.toFixed(2));
  core.setOutput('breach-count', String(breachCount));
  core.setOutput('sample-count', String(sampleCount));
  core.setOutput('report-found', String(reportFound));
}

interface Evaluation {
  reportFound: boolean;
  readings: SystemReading[];
  memTotalBytes: number;
  peakCpuPercent: number;
  peakMemoryPercent: number;
  breachTicks: BreachTick[];
  jsonPath: string;
  commandFailed: boolean;
}

function printSummary(
  inputs: { cpuThreshold: number; memoryThreshold: number },
  ev: Evaluation,
): void {
  if (!ev.reportFound) return;

  // The write() promise rejects when $GITHUB_STEP_SUMMARY is absent; swallow
  // every failure — summary writing must never break the action.
  core.summary
    .addHeading('Playwright Resource Monitor')
    .addTable([
      [{ data: 'Metric', header: true }, { data: 'Peak', header: true }, { data: 'Threshold', header: true }],
      ['Machine CPU (all cores)', `${ev.peakCpuPercent.toFixed(1)}%`, `${inputs.cpuThreshold}%`],
      ['Machine memory (% of RAM)', `${ev.peakMemoryPercent.toFixed(1)}%`, `${inputs.memoryThreshold}%`],
    ])
    .addRaw(
      `<p>${ev.breachTicks.length} breaching sample(s); ${ev.readings.length} samples total. ` +
      `Timeline: <code>${ev.jsonPath}</code>.</p>`,
    )
    .write()
    .catch((): void => {});
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