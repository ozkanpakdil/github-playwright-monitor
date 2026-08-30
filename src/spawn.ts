import { spawn, type ChildProcess } from 'node:child_process';

/**
 * Spawns the run-command through a shell so users can write "npx playwright test"
 * exactly like in their terminal. Detached so the whole process group can be
 * signalled for clean teardown.
 */
export function spawnShellCommand(command: string, env: NodeJS.ProcessEnv): ChildProcess {
  if (process.platform === 'win32') {
    return spawn('cmd.exe', ['/d', '/s', '/c', command], {
      env,
      stdio: 'inherit',
      detached: false,
      windowsHide: true,
    });
  }
  return spawn('/bin/bash', ['-e', '-o', 'pipefail', '-c', command], {
    env,
    stdio: 'inherit',
    detached: true,
  });
}

export interface ExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
  error: Error | null;
}

export function waitForExit(child: ChildProcess): Promise<ExitInfo> {
  return new Promise((resolve) => {
    child.once('error', (err) => resolve({ code: null, signal: null, error: err }));
    child.once('exit', (code, signal) => resolve({ code, signal, error: null }));
  });
}

/** Terminates the command's whole process tree (POSIX group kill / taskkill). */
export async function killTree(child: ChildProcess, graceMs = 5000): Promise<void> {
  if (child.pid === undefined) return;
  if (process.platform === 'win32') {
    await new Promise<void>((resolve) => {
      const t = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      t.once('exit', () => resolve());
      t.once('error', () => resolve());
    });
    return;
  }
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    return;
  }
  const done = new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
  });
  const timer = new Promise<void>((resolve) => setTimeout(resolve, graceMs));
  await Promise.race([done, timer]);
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    // already gone
  }
}