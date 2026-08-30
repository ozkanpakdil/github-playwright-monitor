# Playwright Resource Monitor

A GitHub Action that watches the **per-tab CPU and memory usage** of the browser processes your Playwright run launches — and fails the step when the **worst single tab** crosses your thresholds.

While `npx playwright test` (or any command) runs, the action samples every browser child process, classifies tabs (`renderer` processes), evaluates them against your thresholds on every tick, logs live alerts, and writes a JSON/CSV report plus a job summary.

## What you get

- ✅ **Per-tab thresholds** — the worst single tab is measured, not the whole machine. A header-busy spinner that pegs one core for 30 seconds gets caught; idle parallel workers do not create noise.
- 🔁 **Continuous polling** — configurable 0.5–60 s sampling loop runs in parallel with your test command.
- 🚨 **Live alerts** — every breaching sample logs a `::warning::` inside an collapsible log group with the top-5 processes at that moment.
- ⛔ **Configurable failure** — fail the step on breach (`fail-on-breach: true`, default) or only warn.
- 📊 **Diagnostics** — `report.json` (full samples, breaches, peaks, metadata) and `report.csv` (one row per process per sample), plus 8 action outputs you can gate later steps on.
- 🧹 **Clean teardown** — the polling loop, CDP socket, and the test process tree (group-kill) are shut down on command exit, timeout, or Ctrl+C.

## How it works

Two samplers run against the workers Playwright spawns:

| Sampler | When | Precision |
| --- | --- | --- |
| **`/proc` scanner** (default) | Linux runners (ubuntu-latest, self-hosted Linux, containers). Zero config — it discovers browser processes under `~/.cache/ms-playwright` (or any `chrome`/`firefox` with headless/pipe flags) by scanning `/proc/<pid>/{cmdline,stat,status}`. | Per-pid CPU deltas from kernel tick counters, RSS from the kernel. Tabs detected via `--type=renderer`. |
| **CDP attach** (opt-in) | Any OS, incl. macOS/Windows runners. The action polls an injected debug port for a Chromium DevTools endpoint and reads `SystemInfo.getProcessInfo`. | Chromium reports each child process with cumulative CPU time and private working set, labeled by type (`renderer` = tab). |

**CDP mode** needs Chromium launched with a remote debugging port. The action exports the port as `RESOURCE_MONITOR_CDP_PORT` before running your command; add this to `playwright.config.ts` to opt in:

```ts
// playwright.config.ts
const cdpPort = process.env.RESOURCE_MONITOR_CDP_PORT;

export default defineConfig({
  use: {
    launchOptions: {
      args: cdpPort
        ? [`--remote-debugging-port=${cdpPort}`, '--remote-debugging-address=127.0.0.1']
        : [],
    },
  },
});
```

> **Note:** all Chromium instances open the same port. CDP mode is most reliable with one browser instance per run (e.g. `workers: 1`, custom scripts). With multiple workers, prefer the zero-config `/proc` path (Linux) — it sees every browser process regardless of worker count.

If both sources produce data, CDP wins (precise labels); otherwise the scanner's per-pid data is used. If neither produces data (e.g. no browser launched), the action warns and never blocks your run.

## Metric definitions (important)

- **CPU %** = CPU time consumed by the tab during the polling interval as a percentage of **one core**. One fully-busy core = 100%. A multithreaded tab can exceed 100% momentarily.
- **Memory %** = tab resident/private memory ÷ *effective RAM limit*, where the effective limit is the runner's **cgroup limit if one exists** (containers, self-hosted runners with caps), otherwise total host RAM. On a 16 GB GitHub-hosted runner, a 4 GB tab ≈ 25%.

Tune `memory-threshold` for the environment you run in — a fixed percentage means different absolute sizes on a 16 GB hosted runner vs a 4 GB container.

## Inputs

| Input | Description | Default |
| --- | --- | --- |
| `run-command` | Test command to execute and monitor, run through a shell (`bash -e -o pipefail -c`). | `npx playwright test` |
| `cpu-threshold` | Max CPU for the worst single tab, % of one core (1–999). | `70` |
| `memory-threshold` | Max RAM for the worst single tab, % of the effective RAM limit (1–100). | `70` |
| `polling-interval` | Sampling cadence in seconds (0.5–60). | `2` |
| `fail-on-breach` | `true` fails the step on any breach; `false` only warns. | `true` |
| `cdp-port` | Opt-in port the action polls for `--remote-debugging-port`. Empty = the zero-config `/proc` scanner (Linux). | *(empty)* |
| `report-dir` | Report output directory, relative to the workspace. | `resource-monitor` |

## Outputs

| Output | Description |
| --- | --- |
| `peak-tab-cpu-percent` | Highest CPU seen on any tab (% of one core). |
| `peak-tab-memory-percent` | Highest memory seen on any tab (% of RAM limit). |
| `peak-tab-label` | Label of the tab that produced the CPU peak. |
| `breach-count` | Number of samples that breached a threshold. |
| `sample-count` | Number of evaluation samples collected. |
| `cdp-attached` | `true` when metrics came from CDP, `false` from the `/proc` scanner. |
| `report-json-path` / `report-csv-path` | Absolute paths of the written reports. |

## Usage

### Basic: wrap your Playwright step (zero config on Linux)

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
      - uses: your-org/playwright-resource-monitor@v1
        id: monitor
      - name: Upload metrics report
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: resource-metrics
          path: resource-monitor/
```

The monitored step replaces your normal `npx playwright test` step — it runs your command *and* watches it. Reports land in `resource-monitor/`; upload them from that path.

### Strict thresholds + warn-only mode

```yaml
      - uses: your-org/playwright-resource-monitor@v1
        with:
          run-command: npx playwright test --project=chromium
          cpu-threshold: 85        # % of one core, worst single tab
          memory-threshold: 30     # % of effective RAM
          polling-interval: 1
          fail-on-breach: false    # record breaches, do not fail the step
```

### Gate a later step on the results

```yaml
      - uses: your-org/playwright-resource-monitor@v1
        id: monitor
      - name: Flag noisy tests
        if: steps.monitor.outputs.breach-count != '0'
        run: |
          echo "Breaches observed — peak tab CPU: ${{ steps.monitor.outputs.peak-tab-cpu-percent }}%"
          exit 1
```

## Report formats

- **`report.json`** — run metadata (command, thresholds, RAM limit, CDP state, exit code), the breach list with timestamps, per-peak summary, and every sample with per-process rows.
- **`report.csv`** — one row per process per sample: `timestamp, source, pid, type, label, cpu_percent_of_one_core, memory_bytes, memory_percent`. Drop both into `actions/upload-artifact@v4` as shown above.

A job summary table (peaks vs thresholds) is also appended to GitHub's step summary on every run with data.

## Publishing to the Marketplace

1. Push this repository with `dist/index.js` committed (it is already; keep it in sync after every `bun run build`).
2. Tag a release: `git tag v1 && git push --origin v1` (use `v1.0.x` patches afterward).
3. In the repo → **Releases** → *Draft a new release* → pick the tag, title it, and check **Publish to the GitHub Marketplace** (the repo must be public and contain `action.yml` at the root).
4. Bump the major tag (`v1`) to the newest patch so users receive fixes automatically.

## Development

Bun is the toolchain (installs, bundling, tests) — the published `dist/` still runs on GitHub's native `node20` runtime, so users need nothing installed.

```bash
bun install          # deps
bun run build        # src/ -> dist/index.js (single-file CJS bundle)
bun test             # unit tests for threshold/evaluation logic
bunx tsc --noEmit    # strict typecheck
```

CI (`.github/workflows/ci.yml`) builds, tests, and fails if `dist/` is out of date — keep the committed bundle fresh.

### Repo layout

```
action.yml          # action metadata + inputs/outputs
src/index.ts        # orchestrator: spawn, signal handling, failure logic
src/inputs.ts       # input parsing + validation
src/tabMonitor.ts   # polling engine, breach logging, peaks
src/procSampler.ts  # /proc scanner (Linux, zero config)
src/cdpSampler.ts   # CDP attach via SystemInfo.getProcessInfo
src/evaluate.ts     # pure threshold math (unit tested)
src/report.ts       # JSON/CSV writers
src/spawn.ts        # shell spawn, group-kill, free-port helper
test/               # bun tests
dist/index.js       # committed bundle required by Marketplace
```

## Limitations & FAQ

- **Does it monitor the whole machine?** No — this action is tab-focused by design. For host-level stats pair it with any `/proc/stat` tooling; the two complement each other.
- **macOS/Windows runners?** The `/proc` scanner is Linux-only. Enable CDP mode (snippet above) for full support there.
- **What if my command doesn't launch any browser?** You'll get a "No tab metrics" warning and a clean pass. Thresholds only apply to collected data.
- **CPU vs my expectations:** 100% = one full core, not the machine's aggregate. One fully busy tab adds ~25% aggregate load on a 4-core box (check `htop`'s total bar to cross-reference), and a single tab can exceed 100% when it uses worker threads.
- **Multi-worker runs:** the scanner covers all browser processes regardless of worker count. CDP mode with `--remote-debugging-port` is single-port — use the scanner for parallel suites.

## License

[MIT](./LICENSE)