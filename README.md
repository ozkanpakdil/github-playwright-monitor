# Playwright Resource Monitor

A thin GitHub Action that **fails your pipeline when machine CPU or memory usage crosses a threshold during Playwright test runs** — powered by the built-in system sampler of [monocart-reporter](https://github.com/cenfun/monocart-reporter).

While your tests run, monocart's 1-second sampler records machine-wide CPU % and memory usage and embeds it in its report data. This action runs your test command, reads monocart's report, compares the **peak** usage against your limits (70%/70% by default — you choose the numbers), prints a step summary, and calls `core.setFailed()` when a limit was exceeded.

## Why this design

We deliberately do **not** re-implement monitoring. monocart-reporter already measures, charts, and stores resource usage as a first-class part of your test report:

- ✅ **Battle-tested sampler** maintained by monocart (default 1 s cadence, `tickTime` configurable)
- ✅ **Beautiful HTML report** with the full CPU/memory timeline — for free
- ✅ **One tiny action** (~1 file of logic): run → parse report → enforce limit → fail or warn
- ✅ **Nothing extra installed by the action** — no `/proc` scanning, no CDP attach, no polling loops

## Setup (one time, in the project using this action)

Add monocart-reporter to your Playwright config with the `json: true` option enabled:

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
      json: true, // writes ./monocart-report/index.json — read by this action
    }]
  ]
};
```

That's all. The action reads `monocart-report/index.json` (configurable via the `monocart-json` input) after your command exits and enforces the thresholds.

## Inputs

| Input | Description | Default |
| --- | --- | --- |
| `run-command` | Test command to execute and monitor, run through a shell (`bash -e -o pipefail -c`). | `npx playwright test` |
| `cpu-threshold` | Max machine-wide CPU usage, % of **all cores combined** (1–100). E.g. 3 of 4 cores busy ≈ 75%. | `70` |
| `memory-threshold` | Max machine memory usage, % of **total RAM** (1–100). | `70` |
| `monocart-json` | Path to the monocart JSON data file, relative to the workspace. | `monocart-report/index.json` |
| `fail-on-breach` | `true` fails the step on any breach; `false` only warns. | `true` |

## Outputs

| Output | Description |
| --- | --- |
| `peak-cpu-percent` | Highest machine-wide CPU observed during the run (% of all cores). |
| `peak-memory-percent` | Highest machine memory usage observed (% of total RAM). |
| `breach-count` | Number of samples that breached a threshold. |
| `sample-count` | Number of samples in the monocart report. |
| `report-found` | `true` when the monocart JSON was found and parsed. |

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
      - uses: your-org/playwright-resource-monitor@v1
        id: monitor
        with:
          cpu-threshold: 80
          memory-threshold: 70
      - name: Upload monocart report (includes the resource timeline)
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: monocart-report
          path: monocart-report/
```

The monitored step replaces your normal `npx playwright test` step — it runs your command *and* enforces the limits.

### Warn-only mode

```yaml
      - uses: your-org/playwright-resource-monitor@v1
        with:
          cpu-threshold: 80
          fail-on-breach: false # record breaches, do not fail the step
```

### Fail behavior

- **run-command fails** → the action fails with the exit code (test result is authoritative).
- **Threshold breach** (default `fail-on-breach: true`) → the action fails with a message showing peak CPU and memory vs your thresholds, plus the count of breaching samples.
- **No monocart JSON found** (reporter not configured) → the action warns and skips enforcement; your test run is never blocked by a missing report.

## Metric definitions (monocart's sampler)

- **CPU %** — machine-wide usage across all cores combined, sampled every `tickTime` (default 1000 ms). `100%` = every core saturated. monocart computes it from `os.cpus()` deltas (`100 − idle%`).
- **Memory %** — machine memory in use = `(total − free) / total`, from `os.totalmem()` / `os.freemem()`.

Both are **system-level** figures: they describe the runner as a whole, not one tab or one process. To pinpoint *which* test or page consumed the resource, use monocart's report timeline alongside the breach timestamps in the step summary.

## Publishing to the Marketplace

1. Push this repository with `dist/index.js` committed (CI enforces it stays fresh).
2. Tag a release: `git tag v1 && git push origin v1` (use `v1.0.x` patches afterward).
3. Repo → **Releases** → *Draft a new release* → pick the tag → check **Publish to the GitHub Marketplace** (public repo, `action.yml` at the root).
4. Keep the `v1` tag on the latest patch so users receive fixes automatically.

## Development

Bun is the toolchain (installs, bundling, tests) — the published `dist/` runs on GitHub's native `node20` runtime.

```bash
bun install          # deps
bun run build        # src/ -> dist/index.js (single-file CJS bundle)
bun test             # unit tests for parsing/threshold logic
bunx tsc --noEmit    # strict typecheck
```

### Repo layout

```
action.yml            # action metadata + inputs/outputs
src/index.ts          # orchestrator: spawn, parse, enforce, summarize
src/inputs.ts         # input parsing + validation
src/monocart.ts       # monocart JSON parsing + threshold evaluation (unit tested)
src/spawn.ts          # shell spawn + process-group teardown
test/                 # bun tests
dist/index.js         # committed bundle required by Marketplace
.github/workflows/    # CI (build + test + dist freshness check)
```

## Limitations & FAQ

- **Machine-level, not per-tab.** Enforced metrics are the machine's aggregate CPU/memory, exactly what monocart charts. Pinpoint the culprit via the monocart report timeline.
- **No live alerts.** monocart writes its report at the end of the run, so breach warnings surface as the final verdict rather than streaming into the log mid-run.
- **`json: true` required.** The HTML report embeds (compressed) data; the standalone JSON file is what this action parses.
- **Sharded runs:** point `monocart-json` at the shard whose report you want enforced, or merge shard zips with monocart's merge CLI first.
- **Windows runners:** monocart's sampler uses Node APIs (`os.cpus/freemem`) — works on every platform the action runs on.

## License

[MIT](./LICENSE)