import * as core from '@actions/core';
import { resolve } from 'node:path';

export interface ActionInputs {
  runCommand: string;
  cpuThreshold: number;
  memoryThreshold: number;
  failOnBreach: boolean;
  monocartJson: string;
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

  const cpuThreshold = readNumber('cpu-threshold', 70, 1, 100);
  const memoryThreshold = readNumber('memory-threshold', 70, 1, 100);

  const failRaw = core.getInput('fail-on-breach') || 'true';
  if (!/^(true|false)$/i.test(failRaw.trim())) {
    throw new Error(`Input "fail-on-breach" must be "true" or "false"; received "${failRaw}".`);
  }

  const monocartJson = (core.getInput('monocart-json') || 'monocart-report/index.json').trim();

  return {
    runCommand,
    cpuThreshold,
    memoryThreshold,
    failOnBreach: /^true$/i.test(failRaw.trim()),
    monocartJson,
  };
}

export function resolveWorkPath(p: string): string {
  const workspace = process.env.GITHUB_WORKSPACE || process.cwd();
  return resolve(workspace, p);
}