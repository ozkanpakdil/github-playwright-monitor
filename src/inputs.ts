import * as core from '@actions/core';

export interface ActionInputs {
  runCommand: string;
  cpuThreshold: number;
  memoryThreshold: number;
  pollingIntervalSeconds: number;
  failOnBreach: boolean;
  cdpPort: number | null;
  reportDir: string;
}

function readNumber(name: string, fallback: number, min: number, max: number): number {
  const raw = core.getInput(name);
  if (!raw.trim()) return fallback;
  const value = Number(raw.trim());
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(
      `Input "${name}" must be a number between ${min} and ${max}; received "${raw}".`,
    );
  }
  return value;
}

/**
 * Reads and validates all inputs. Throws a descriptive Error for anything the
 * user cannot recover from on their own.
 */
export function readActionInputs(): ActionInputs {
  const runCommand = core.getInput('run-command', { required: false }) || 'npx playwright test';
  if (!runCommand.trim()) {
    throw new Error('Input "run-command" cannot be empty.');
  }

  const pollingIntervalSeconds = readNumber('polling-interval', 2, 0.5, 60);
  const cpuThreshold = readNumber('cpu-threshold', 70, 1, 999);
  const memoryThreshold = readNumber('memory-threshold', 70, 1, 100);

  const failRaw = core.getInput('fail-on-breach') || 'true';
  if (!/^(true|false)$/i.test(failRaw.trim())) {
    throw new Error(`Input "fail-on-breach" must be "true" or "false"; received "${failRaw}".`);
  }

  const cdpRaw = core.getInput('cdp-port', { required: false })?.trim() ?? '';
  let cdpPort: number | null = null;
  if (cdpRaw) {
    const value = Number(cdpRaw);
    if (!Number.isInteger(value) || value < 1 || value > 65535) {
      throw new Error(`Input "cdp-port" must be an integer between 1 and 65535; received "${cdpRaw}".`);
    }
    cdpPort = value;
  }

  const reportDir = (core.getInput('report-dir', { required: false }) || 'resource-monitor').trim();

  return {
    runCommand,
    cpuThreshold,
    memoryThreshold,
    pollingIntervalSeconds,
    failOnBreach: /^true$/i.test(failRaw.trim()),
    cdpPort,
    reportDir,
  };
}