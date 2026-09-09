# Deploy Report 056 — G4 fix `99990ea` (B/S 标记跨周期 On-Screen)

**Report file:** `coder/report/056_deploy_99990ea_bs_marker_onscreen.md`

## Summary
Deployed commit `99990ea6784fa922d57cf24a489c190391f20c6c` (fix(web): B/S标记跨周期On-Screen 吸附+钳位) to the `eestock-app` service. Only the app container/image was rebuilt and recreated. No source/DB/SQL/Rust changes, no commit.

## What changed
| Item | Before | After |
|------|--------|-------|
| App image ID | `b7465e83caf72c28…` | `7c191c43c613dbad…` |
| App container ID | `44d693e3d9034869…` (removed as orphan) | `073c7787c812…` |
| SPA JS bundle | `index-Diecmm3C.js` | `index-ClPhQAKK.js` |
| SPA JS md5 | `7f630a0f7c0557bbfd0ec1cd6d3083a0` | `9e77b622b66837ce628b32e230d3123a` |
| SPA JS size | 562844 B | 563187 B |
| App Status | running (old) → helper-removed orphan → recreated | Up (healthy), restarts=0 |
| /healthz | `{"status":"ok"}` | `{"status":"ok"}` |

- Rust layer **fully cached** in the build (steps `cargo fetch` / `cargo build --release --bin eestock-app` all `Using cache`). Only the `COPY --from=frontend /web/dist /app/dist` layer changed → new image.
- CSS bundle `index-CA9E95tC.css` unchanged (no CSS change in this commit).

## Architecture alignment
- Multi-stage `Dockerfile.app`: frontend(node:22 → vite `tsc -b && vite build`) → builder(rust) → runtime. Build consumed source at HEAD=`99990ea`.
- No interface, layer-boundary, or dependency changes. Deploy only — runtime image `b7465e83caf7` → `7c191c43c613` via `docker-compose build app` + `up -d app`.

## Problem solved / feature added
Deployed the G4 fix that snaps/clamps B/S marker overlay ts to the loaded bar set so markers remain On-Screen across period switches. Confirmed present in the deployed bundle (see Verification).

## Implementation approach
1. `docker-compose build app` → build RC=0, 5s. Rust cached; only frontend dist changed.
2. `docker-compose up -d app` → **crashed** with `KeyError: 'ContainerConfig'` (compose v1.29.2 on Docker Engine 29.1.3), leaving orphan container `44d693e3d903_eestock-app` (Exited 137).
3. Per mitigation: `docker rm -f 44d693e3d903_eestock-app`, then `docker-compose up -d app` → RC=0, 1s. New container `073c7787c812` created.
4. Health became `healthy` ~6s later (healthcheck start_period=15s, interval=30s).

## Compose pitfall (documented)
- Root cause: compose v1 `get_container_data_volumes` reads `container.image_config['ContainerConfig']`; Docker Engine 29.1.3 image config no longer exposes `ContainerConfig` → `KeyError` during recreate.
- Workaround (used): remove the recreate-leftover orphan container, then re-run `up -d app`. Only the app service was rebuilt/recreated; `timescaledb`/`data` untouched (both still Up healthy).

## Test coverage
- No tests added/modified by this deploy (deploy-only). The G4 commit itself added `web/src/features/backtest/markerSnap.test.ts` and updated `web/src/features/backtest/TradeDetailModal.test.tsx` (these source tests are part of the committed fix, not this deploy).
- Build ran `tsc -b && vite build` (type-check passed during docker build). Vitest suites are not run in the Docker image.

## Verification
- `docker ps`: `eestock-app` Up (healthy), image `eestock-rs_app`→`7c191c43c613`; no orphan/duplicate app container.
- `/healthz` HTTP `200`, body `{"status":"ok"}`.
- Bundle hash changed (filename + md5 above), confirming new frontend bytes are served.
- **G4 logic presence (minified, identifiers mangled):** compared old/new drawn bundles:
  - OLD: `else if(e.type==="marker")n.createOverlay({name:"simpleAnnotation",…,points:[{timestamp:e.ts,…}]` → raw overlay ts, no snap.
  - NEW: `function kw(n,t,e){for(const a of t){if(a.type!=="marker")continue;const o=Cw(e,a.ts);o&&n.createOverlay({name:"simpleAnnotation",…,points:[{timestamp:o.ts,…}]}` ; `Cw` = `function Cw(n,t){if(n.length===0)return null;let e=0,a=Date.parse(n[0].ts),o=Math.abs(a-t);for(let s=1;s<n.length;s++){const u=Date.parse(n[s].ts),c=Math.abs(u-t);c<o&&(o=c,e=s,a=u)}return{index:e,ts:a}}`; call site `u.loadInitial().then(()=>{e.current===v&&kw(v,n.overlays??[],u.bars)})`.
  - `kw`=createMarkerOverlays, `Cw`=snapTsToBars, `o.ts`=snapped ts, `e.current===v`=chartRef guard, deferred after `loadInitial()`. Matches the G4 fix exactly.

## Residual risks
- Literal identifiers `snapTsToBars`/`createMarkerOverlays` are **not** string-searchable in the production bundle (esbuild mangles top-level names); presence verified structurally via the minified `Cw`/`kw`/`o.ts` pattern above. If a reviewer wants name-preserving output, build with `minify:false` or enable sourcemaps (not done; would change bundle).
- `docker-compose` is v1.29.2 on Docker 29.1.3 — any future `up`/recreate of `app` may re-trigger `KeyError: 'ContainerConfig'`; the orphan-removal workaround is required each time. Consider migrating to compose v2 or removing the `ContainerConfig` dependency.
- Canvas rendering of the B/S marker on-screen behavior is not exercised by this deploy (needs real-browser visual check; commit notes "canvas真绘需真机目验").
- Deploy was done with `docker-compose up -d app`; a manual `docker rm -f` of the orphan was required (recreate isn't fully automated under compose v1).
