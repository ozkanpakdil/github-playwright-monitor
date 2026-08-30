import http from 'node:http';
import WS from 'ws';
import type { ProcType, ProcessSample, Sample, Sampler } from './types';
import { cpuPercent, sanitizeCpuPercent } from './evaluate';

const CONNECT_TIMEOUT_MS = 20_000;
const PROBE_INTERVAL_MS = 500;

interface CdpProcess {
  type?: string;
  id?: string | number;
  cpuTime?: number;
  memory?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** GET http://host:port/json/version with a hard timeout. */
function fetchVersion(
  host: string,
  port: number,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host, port, path: '/json/version', timeout: timeoutMs }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        data += chunk;
      });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data) as Record<string, unknown>);
        } catch (err) {
          reject(err as Error);
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('request timed out')));
    req.on('error', reject);
  });
}

function mapType(rawType: string | undefined): ProcType {
  const t = (rawType ?? '').toLowerCase();
  if (t.includes('renderer')) return 'renderer';
  if (t === 'browser') return 'browser';
  if (t.includes('gpu')) return 'gpu';
  if (t) return 'utility';
  return 'other';
}

/**
 * Browser-level CDP session sampler.
 *
 * Attaches to an already-running Chromium via its remote debugging endpoint
 * (`--remote-debugging-port`) and polls `SystemInfo.getProcessInfo`, which
 * reports each Chromium child process (tabs are `renderer` entries) with a
 * cumulative CPU time and current working-set memory.
 */
export async function createCdpSampler(
  host: string,
  port: number,
  abort?: AbortSignal,
): Promise<Sampler | null> {
  // 1. Poll /json/version until a browser endpoint answers (or give up).
  const deadline = Date.now() + CONNECT_TIMEOUT_MS;
  let wsUrl: string | null = null;
  while (Date.now() < deadline && wsUrl === null && abort?.aborted !== true) {
    try {
      const version = await fetchVersion(host, port, 1_200);
      const candidate = version?.webSocketDebuggerUrl;
      // Guard against unrelated services occupying the port.
      if (
        typeof candidate === 'string' &&
        candidate.startsWith('ws://') &&
        candidate.includes('/devtools/browser') &&
        typeof version?.Browser === 'string'
      ) {
        wsUrl = candidate;
      }
    } catch {
      // browser not up yet — keep probing
    }
    if (wsUrl === null) await sleep(PROBE_INTERVAL_MS);
  }
  if (wsUrl === null) return null;

  // 2. Open the WebSocket and wire a tiny id -> pending map.
  const ws = new WS(wsUrl, { perMessageDeflate: false });
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  let nextId = 1;
  let alive = true;

  ws.on('message', (data: unknown) => {
    try {
      const msg = JSON.parse(String(data)) as { id?: number; error?: unknown; result?: unknown };
      if (typeof msg.id === 'number' && pending.has(msg.id)) {
        const entry = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) {
          entry?.reject(new Error(`CDP error: ${JSON.stringify(msg.error)}`));
        } else {
          entry?.resolve(msg.result);
        }
      }
    } catch {
      // malformed frame — ignore
    }
  });
  ws.on('close', () => {
    alive = false;
  });
  ws.on('error', () => {
    alive = false;
  });

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error('CDP WebSocket connect timed out'));
    }, 5_000);
    ws.once('open', () => {
      clearTimeout(timer);
      resolve();
    });
    ws.once('error', (err: Error) => {
      clearTimeout(timer);
      reject(err);
    });
  });

  function sendCommand(method: string): Promise<unknown> {
    if (!alive || ws.readyState !== WS.OPEN) {
      return Promise.reject(new Error('CDP session closed'));
    }
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method }), (err) => {
        if (err) {
          pending.delete(id);
          reject(err);
          return;
        }
      });
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`CDP command ${method} timed out`));
        }
      }, 5_000);
    });
  }

  const previousCpuTime = new Map<string, number>();
  let previousAt: number | null = null;

  return {
    kind: 'cdp',

    async sample(): Promise<Sample | null> {
      if (!alive) return null;
      try {
        const result = (await sendCommand('SystemInfo.getProcessInfo')) as {
          processes?: CdpProcess[];
        } | null;
        const list = result?.processes;
        if (!Array.isArray(list) || list.length === 0) return null;

        const now = Date.now();
        const intervalSeconds =
          previousAt === null ? 0 : Math.max(0.05, (now - previousAt) / 1000);
        previousAt = now;

        const processes: ProcessSample[] = [];
        for (let index = 0; index < list.length; index++) {
          const info = list[index];
          if (!info) continue;
          const type = mapType(info.type);
          const memoryBytes = Number(info.memory ?? 0) || 0;
          const cpuSeconds = Number(info.cpuTime ?? 0);
          const key = `${type}:${info.id ?? index}`;
          const prev = previousCpuTime.get(key);

          const cpuPct =
            prev !== undefined && intervalSeconds > 0
              ? cpuPercent(cpuSeconds - prev, intervalSeconds)
              : 0;
          previousCpuTime.set(key, cpuSeconds);

          processes.push({
            key: `cdp:${key}`,
            pid: typeof info.id === 'number' ? info.id : undefined,
            type,
            label: `${type}${info.id ? ` pid ${info.id}` : ` #${index}`}`,
            cpuPercent: sanitizeCpuPercent(cpuPct),
            memoryBytes,
          });
        }

        return {
          timestamp: now,
          intervalSeconds: intervalSeconds || 0.05,
          source: 'cdp',
          processes,
        };
      } catch {
        return null; // transient CDP hiccups are tolerated
      }
    },

    async stop(): Promise<void> {
      alive = false;
      for (const [, entry] of pending) {
        entry.reject(new Error('CDP sampler stopped'));
      }
      pending.clear();
      try {
        ws.close();
      } catch {
        ws.terminate();
      }
    },
  };
}