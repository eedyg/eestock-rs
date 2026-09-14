# 250_multiperiod_route_probe — evidence index

Read-only probes for the route-①/② decision. Runtime: klinecharts 10.0.3 UMD + Playwright Chromium, `file://` local pages, synthetic OHLCV (no network, 0 requests).

| file | what |
|------|------|
| `p7.html` / `p7.js` / `run.mjs` | P7a hidden candle pane, P7b first pass, P7c cost/free, P7d contracts. Run: `node run.mjs` → `p7_result.json`, `p7_full.png` |
| `p7b2.html` / `p7b2.js` / `runb2.mjs` | P7b focused: configurable `barSpaceLimit`, same-period exact align, cross-period ts-only vs scaled barSpace, 1m vs 1w, 20-round drift, feedback edge, perf. Run: `node runb2.mjs` → `p7b2_result.json`, `p7b2.png` |
| `p7view.html` / `runview.mjs` | Visual artifacts: chart with hidden candle + 3 indicator panes; route② 1m/15m pair. Run: `node runview.mjs` → `p7view_result.json`, `p7a_hidden_candle.png`, `route2_1m.png`, `route2_15m.png`, `p7_view_full.png` |
| `ma.html` / `runma.mjs` | MA + `paneId:'candle_pane'` quirk repro (3 runs). Run: `node runma.mjs` |

Key raw result files: `p7_result.json`, `p7b2_result.json`, `p7view_result.json`.
Screenshots are real renders (non-blank; e.g. `p7a_hidden_candle.png` 820×520 with 741 distinct colors).

Reports:
- Design: `tester/design/250_multiperiod_route_probe_design.md`
- Execution: `tester/test/250_multiperiod_route_probe_execution.md`
