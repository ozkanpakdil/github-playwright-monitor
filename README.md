# Playwright Resource Monitor

A **two-layer resource guard** for Playwright CI runs with **zero user-side dependencies**:

| Layer | Source | What it watches | Live during run |
| --- | --- | --- | --- |
| **Machine** | This action's built-in /proc sampler (Linux); [monocart-reporter](https://github.com/cenfun/monocart-reporter) JSON used automatically when configured | Machine-wide CPU % (all cores) and memory % of the effective RAM limit | Yes — grouped `::warning::` alerts from the built-in sampler |
| **Tab** | This action's own sampler | **Worst single tab** (renderer process): CPU as % of one core, memory as % of the effective RAM limit | Yes — grouped `::warning::` alerts as the tests run |

Fails the step when **any configured threshold** is exceeded. Machine metrics come from the action's own `/proc` sampler on Linux runners (zero config); if a monocart report is present, its ticks become the machine source of record and add an HTML timeline. Tab thresholds are evaluated live by the action's `/proc` scanner (zero config on Linux) or an optional Chrome DevTools Protocol attach. Runs without Playwright activity pass through silently.

## Quick start (add to your workflow)

Paste this into any workflow with Playwright configured. Define your percentages, and the build passes or fails accordingly — with every run's peaks recorded in the run logs, the job summary, and a cross-run history file:

```yaml
      - uses: actions/checkout@v4
      - run: npm ci
      - run: npx playwright install chromium
      - uses: ozkanpakdil/github-playwright-monitor@v1
        with:
          machine-cpu-threshold: 80   # % of all cores (machine-wide)
          machine-memory-threshold: 70# % of effective RAM limit
          tab-cpu-threshold: 70       # % of one core, worst single tab
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: resource-reports
          path: resource-monitor/
```

That's it — no reporter changes, no new devDependencies. Everything below is optional enrichment.

Every run writes into the **job summary** (and step logs):

- a peaks-vs-thresholds table for both layers,
- a **Run history** table — the last 10 runs with machine/tab peaks and outcomes, each linking back to its workflow run.

To keep history across runs (runners are ephemeral), persist the history file with `actions/cache`:

```yaml
      - uses: actions/cache@v4
        with:
          path: resource-monitor/history.json
          key: resource-monitor-history-${{ github.run_id }}
          restore-keys: resource-monitor-history-
      - uses: ozkanpakdil/github-playwright-monitor@v1
```

`restore-keys` restores the latest saved history; each run appends its record and saves a new cache entry. On the Marketplace listing, the same snippets apply — search for **Playwright Resource Monitor** under [github.com/marketplace?type=actions](https://github.com/marketplace?type=actions) or call it directly with `uses: ozkanpakdil/github-playwright-monitor@v1`.

> Bonus: configure monocart's `trend: './monocart-report/index.json'` reporter option and cache `monocart-report/` instead of (or in addition to) the history file — its report gains a Trend Chart of past runs (tests/duration focus; the CPU/memory peak history lives in this action's history table).

## Setup

### 1. Machine layer: built-in on Linux — optional monocart timeline

On Linux runners the machine sampler works with zero config: the action samples `/proc/stat` (CPU deltas across all cores) and `/proc/meminfo` (memory, cgroup-aware) at `polling-interval` cadence, logs live breach alerts, and enforces the `machine-*` thresholds.

Optionally, add [monocart-reporter](https://github.com/cenfun/monocart-reporter) for an HTML timeline of machine + tests; the action then sources machine metrics from its report instead:

```bash
npm i -D monocart-reporter
```

```js
// playwright.config.js
module.exports = {
  reporter: [
    ['monocart-reporter', {
      name: 'My Test Report',
      outputFile: './monocart-report/index.html',
      json: true, // writes ./monocart-report/index.json (also the default in recent versions)
    }]
  ]
};
```

### 2. Tab layer: nothing (Linux) — optional CDP for exact labeling

On Linux runners the tab sampler works with zero config: it discovers the Playwright browser process tree under `~/.cache/ms-playwright` via `/proc/<pid>/{cmdline,stat,status}` and treats `--type=renderer` processes as tabs.

For macOS/Windows runners — or precise per-tab labels — opt in to CDP. The action exports the debug port as `RESOURCE_MONITOR_CDP_PORT`; point Chromium at it:

```js
// playwright.config.js — CDP mode (opt-in)
const cdpPort = process.env.RESOURCE_MONITOR_CDP_PORT;

use: {
  launchOptions: {
    args: cdpPort
      ? [`--remote-debugging-port=${cdpPort}`, '--remote-debugging-address=127.0.0.1']
      : [],
  },
},
```

> CDP mode shares one debug port across all browser instances, so it fits single-browser runs best. For parallel worker suites on Linux, stick with the `/proc` layer (every browser process is covered, no port conflicts).

## Inputs

| Input | Layer | Description | Default |
| --- | --- | --- | --- |
| `run-command` | both | Test command to execute and monitor (`bash -e -o pipefail -c`). | `npx playwright test` |
| `machine-cpu-threshold` | machine | Max machine CPU, % of all cores combined (1–100). Sourced from the built-in /proc sampler (Linux) or the monocart report when present. | `70` |
| `machine-memory-threshold` | machine | Max machine memory, % of effective RAM limit (1–100). Same sourcing. | `70` |
| `tab-cpu-threshold` | tab | Max CPU for the worst single tab, % of one core (1–999). | `70` |
| `tab-memory-threshold` | tab | Max memory for the worst single tab, % of effective RAM limit (1–100). | `70` |
| `polling-interval` | both | Sampler cadence in seconds (0.5–60) for the built-in machine + tab layers; monocart's cadence is its own `tickTime` (default 1 s). | `2` |
| `cdp-port` | tab | Opt-in CDP debug port for per-tab labeling. | *(empty)* |
| `monocart-json` | machine | Path to the monocart JSON data file; when found, monoticks become the machine source of record. | `monocart-report/index.json` |
| `report-dir` | tab | Directory for the per-tab JSON/CSV reports. | `resource-monitor` |
| `history-file` | both | File where every run's peak/outcome record is kept (rendered in the job summary as the Run history table). | `resource-monitor/history.json` |
| `history-max-entries` | both | Max records kept in the history file (1–1000). | `50` |
| `fail-on-breach` | both | `true` fails the step on any breach; `false` only warns. | `true` |

## Outputs

| Output | Description |
| --- | --- |
| `peak-machine-cpu-percent` / `peak-machine-memory-percent` | Machine-wide peaks (% of all cores / % of effective RAM limit). |
| `machine-breach-count` | Breaching machine samples. |
| `peak-tab-cpu-percent` / `peak-tab-memory-percent` | Worst-tab peaks (empty when no tab samples were collected). |
| `tab-breach-count` / `tab-sample-count` | Tab-layer breach count and sample count. |
| `tab-source` | `cdp`, `proc`, or `none`. |
| `machine-source` | `action` (built-in /proc sampler), `monocart` (report JSON), or `none`. |
| `monocart-found` | `true` when the monocart JSON was found and parsed. |
| `report-json-path` | Path to the per-tab JSON report. |

## Usage

```yaml
name: e2e
on: [push]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm ci
      - run: npx playwright install --with-deps chromium
      - uses: ozkanpakdil/github-playwright-monitor@v1
        id: monitor
        with:
          machine-cpu-threshold: 80   # % of all cores
          tab-cpu-threshold: 70       # % of one core, worst single tab
      - name: Upload reports
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: resource-reports
          path: |
            monocart-report/
            resource-monitor/
```

The monitored step replaces your normal `npx playwright test` step — it runs your command *and* enforces both layers.

### Fail behavior

- **run-command fails** → the action fails with the exit code (test result is authoritative).
- **Any threshold breach** (machine or tab, `fail-on-breach: true` default) → the action fails naming each breached layer with peak values vs thresholds.
- **`fail-on-breach: false`** → breaches log a `::warning::` only; the step stays green.
- **Missing monocart JSON / no browsers** → the matching layer is skipped with an informational note; the run is never blocked by missing data. On Linux the machine layer always has data via the built-in sampler.

## Metric definitions

- **Machine CPU %** — aggregate across all cores, from `os.cpus()` deltas (`100 − idle%`); 100% = every core saturated.
- **Machine memory %** — `(total − free) / total` from `os.totalmem()` / `os.freemem()`.
- **Tab CPU %** — CPU time of the renderer process during the interval as % of **one core**; a multithreaded tab can exceed 100%.
- **Tab memory %** — renderer RSS ÷ *effective RAM limit* (cgroup limit if present, else total RAM).

Pinpoint the culprit: machine breaches → monocart report timeline (when configured) or the machine alert groups in the log; tab breaches → `resource-monitor/report.{json,csv}` (per-process rows with timestamps) plus the live alert groups in the log.

## Testing before publishing

No release is required to test the action — a Marketplace release only adds the listing. Test ladder, cheapest first:

1. **Every push** — this repo's CI (`.github/workflows/ci.yml`) runs two validation jobs:
   - `build-test`: typecheck + unit tests + a pass-through run proving the action stays silent and green when no Playwright activity exists.
   - `smoke-real`: installs a minimal real Playwright project (`test/smoke/`) and runs **the action around a real browser test**, then **asserts both layers produced data** (`tab-source=proc`, sample counts > 0). This is the /proc tab layer's true Linux validation and runs on every push — before you ever tag a release.
2. **From any other repo** — reference it directly by branch; no release needed:
   ```yaml
   - uses: ozkanpakdil/github-playwright-monitor@main
   ```
   (TrendCast's `ci.yml` does exactly this. Switch to `@v1` after publishing.)
3. **Tag + release** only when you are ready for the Marketplace listing: `git tag v1 && git push origin v1` → Releases → *Draft a new release* → check **Publish to the GitHub Marketplace**.

## Publishing to the Marketplace

This repository (`[ozkanpakdil/github-playwright-monitor](https://github.com/ozkanpakdil/github-playwright-monitor)`) is the publishing home:

1. Push the repo (public) — it already has `dist/index.js` committed, and CI enforces the bundle stays fresh:
   ```bash
   git remote add origin https://github.com/ozkanpakdil/github-playwright-monitor.git
   git push -u origin main
   ```
2. Tag the action: `git tag v1 && git push origin v1` (use `v1.0.x` patches afterward).
3. Repo → **Releases** → *Draft a new release* → pick the `v1` tag → check **Publish to the GitHub Marketplace**.
4. Set the repo **About** description/website on the repo page — it becomes the listing tagline.
5. Move the `v1` tag to the latest patch for future fixes so `uses: ozkanpakdil/github-playwright-monitor@v1` keeps working for users.

## Development

Bun is the toolchain (installs, bundling, tests) — the published `dist/` runs on GitHub's native `node20` runtime.

```bash
bun install          # deps
bun run build        # src/ -> dist/index.js (single-file CJS bundle)
bun test             # machine-layer (monocart) + tab-layer (evaluate) unit tests
bunx tsc --noEmit    # strict typecheck
```

### Repo layout

```
action.yml            # action metadata + inputs/outputs
src/index.ts          # orchestrator: spawn, tab monitoring, monocart eval, verdicts, history
src/inputs.ts         # input parsing + validation
src/history.ts        # cross-run history file + job-summary history table (unit tested)
src/monocart.ts       # machine layer: monocart JSON parsing + thresholds (unit tested)
src/evaluate.ts       # tab layer: pure threshold math (unit tested)
src/tabMonitor.ts     # tab layer: polling engine, live grouped alerts, peaks
src/procSampler.ts    # tab layer: /proc scanner (Linux, zero config)
src/cdpSampler.ts     # tab layer: CDP attach via SystemInfo.getProcessInfo
src/limit.ts          # effective RAM limit (cgroup aware)
src/report.ts         # per-tab JSON/CSV writers
src/spawn.ts          # shell spawn + process-group teardown
src/types.ts          # shared domain types
test/                 # bun tests for both layers
dist/index.js         # committed bundle required by Marketplace
.github/workflows/    # CI (build + test + dist freshness check + smoke run)
```

## Limitations & FAQ

- **No per-tab metrics without browsers:** the tab layer reports nothing if the run-command doesn't launch a browser; machine layer still enforces on Linux via the built-in sampler. The whole action also passes cleanly (informational note only) when a wrapped command has nothing to monitor.
- **Live machine alerts:** the built-in sampler logs breaches live. With monocart configured instead, monocart writes its report at run end, so live alerts come only from the tab layer (advisory /proc alerts still appear in the log).
- **CDP + multiple workers share one debug port:** for parallel suites on Linux, prefer the `/proc` tab layer.
- **Sharded runs:** point `monocart-json` at the shard to enforce, or merge shard zips with monocart's merge CLI first.
- **Windows runners:** machine layer works (Node APIs); tab layer needs CDP mode.
- **Machine memory on a shared/dev machine:** machine memory % = `(total − free) / total` for the entire host, so a laptop with other apps open reads high (macOS especially). Size machine-memory thresholds for the dedicated CI runner, or use `fail-on-breach: false` locally.

## Example look

[Here](https://github.com/ozkanpakdil/TrendCast/actions/runs/33332258603) is archived link https://archive.ph/wip/epNVo

<img width="2427" height="2425" alt="image" src="https://github.com/user-attachments/assets/3f8d5254-18a5-4dad-a50b-4390627ccb6f" />


## License

[MIT](./LICENSE)
