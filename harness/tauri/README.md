# nanoMuse Desktop on Tauri (spike, Linux first)

A second shell for the same desktop: the dsh Host from `../desktop/dsh/` as a
sidecar, its web app in the system's WebView instead of a bundled Chromium.
Nothing of the Electron shell moves here yet — this is the spike that proves the
shape on a 2-CPU / 4 GB box before any migration.

Why it matters on Linux: the WebView is WebKitGTK from the system (`Depends:
libwebkit2gtk-4.1-0`, already on most GNOME desktops) instead of ~180 MB of
Chromium per install. With the same staged `dsh/` and the same runtime story
(bundled or `NANOMUSE_PY`), the `.deb` should land near 90-120 MB full and
40-60 MB `-min`, against 244 MB today.

## What works

- Spawns the Host (`node dsh/node_modules/@deepseek-ai/dsh/lib/bin.js nanomuse
  --no-open --port <port>`), reads its `dsh web: http://127.0.0.1:…` line and
  loads that URL in the main window.
- Single instance: a second launch focuses the running window.
- The operator is a loopback HTTP server with the same contract as
  `../desktop/src/operator-server.ts` (`GET /info`, `POST /screenshot`, `POST
  /execute`, per-launch token in `NANOMUSE_OPERATOR_URL` /
  `NANOMUSE_OPERATOR_TOKEN`); the screenshot/input backends are still to port
  (`xcap` + `enigo` are the planned crates, mirroring `mac/computer-use/`).

## What does not (the parity list)

Tray icon, glow/capsule overlays, global shortcut, update feed, proxy env
wiring (`src/proxy.ts`), login-shell PATH sniffing — all still Electron-only.
Each row of `../desktop/src/main.ts` needs its Tauri counterpart before this
ships.

## Build it (Debian/Ubuntu)

```sh
sudo apt install libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev patchelf
cd harness/desktop && node scripts/prepare-dsh.mjs --out ../tauri/dsh-stub  # stage dsh/ once
cd ../tauri && CARGO_BUILD_JOBS=2 cargo build --release   # 2 jobs: the 4 GB box survives
```

`CARGO_BUILD_JOBS=2` and `RUSTFLAGS="-C debuginfo=0"` are deliberate: a
parallel release link of `webkit2gtk-sys` is what OOM-kills 4 GB machines.
