#!/usr/bin/env node
// Stage the harness the desktop app carries: `dsh/` next to this file's parent, with
// `@deepseek-ai/dsh` (the version the bundle's peer dependencies name) and the nanoMuse
// bundle installed side by side by npm — the Loader finds a bundle linked from the profile
// to that copy, so no pnpm runs on the person's machine.
//
//   node scripts/prepare-dsh.mjs                      # packs ../dsh-nanomuse (built first: pnpm build)
//   node scripts/prepare-dsh.mjs --bundle path.tgz    # a tarball already packed (the CI's)
//   node scripts/prepare-dsh.mjs --out dsh            # where to stage (default: ./dsh)
//
// Run on the platform being packaged: npm picks that platform's native prebuilds
// (node-pty, sharp, koffi, the harness's own require-builtin addon). Only the public
// registry is used, whatever ~/.npmrc says.

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(here, "..");
const bundleDir = resolve(appDir, "..", "dsh-nanomuse");
const REGISTRY = "https://registry.npmjs.org";

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const out = resolve(appDir, opt("--out") ?? "dsh");
let bundle = opt("--bundle");

const run = (cmd, cmdArgs, options = {}) => {
  console.log("+", cmd, cmdArgs.join(" "));
  return execFileSync(cmd, cmdArgs, { stdio: "inherit", ...options });
};
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const shell = process.platform === "win32";

// ---------------------------------------------------------------- the versions
const bundleManifest = JSON.parse(readFileSync(join(bundleDir, "package.json"), "utf8"));
const dshVersion = bundleManifest.peerDependencies?.["@deepseek-ai/dsh-agent"];
if (!dshVersion) throw new Error("dsh-nanomuse/package.json names no @deepseek-ai/dsh-agent peer — which dsh is this for?");
console.log(`dsh ${dshVersion} · ${bundleManifest.name} ${bundleManifest.version}`);

// ---------------------------------------------------------------- the bundle
if (!bundle) {
  if (!existsSync(join(bundleDir, "lib", "index.js"))) {
    throw new Error(`${bundleDir}/lib is missing — run 'pnpm install && pnpm build' there first`);
  }
  const packDir = join(tmpdir(), `nanomuse-bundle-${process.pid}`);
  mkdirSync(packDir, { recursive: true });
  run(pnpm, ["pack", "--pack-destination", packDir], { cwd: bundleDir, shell });
  const tgz = readdirSync(packDir).find((f) => f.endsWith(".tgz"));
  if (!tgz) throw new Error("pnpm pack left no tarball");
  bundle = join(packDir, tgz);
}
bundle = resolve(bundle);
if (!existsSync(bundle)) throw new Error(`no bundle at ${bundle}`);

// ---------------------------------------------------------------- the install
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
writeFileSync(
  join(out, "package.json"),
  `${JSON.stringify({ name: "nanomuse-desktop-dsh", private: true, description: "DeepSeek Harness and the nanoMuse bundle, as nanoMuse Desktop carries them" }, null, 2)}\n`,
);
// No install scripts, whatever the npm version's policy (npm 11 blocks them by default,
// npm 10 runs them): the harness's dependencies carry prebuilt binaries and their scripts
// only check for them — except one, which the step after this one does by hand.
run(
  npm,
  ["install", "--omit=dev", "--no-audit", "--no-fund", "--no-package-lock", "--ignore-scripts", `--registry=${REGISTRY}`, `@deepseek-ai/dsh@${dshVersion}`, bundle],
  { cwd: out, shell, env: { ...process.env, npm_config_registry: REGISTRY } },
);
// what @deepseek-ai/dsh-subprocess-local's postinstall does: the executable bit the tarball
// stripped from node-pty's prebuilt spawn-helper (macOS and Linux)
if (process.platform !== "win32") {
  for (const helper of [
    join(out, "node_modules", "node-pty", "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper"),
    join(out, "node_modules", "node-pty", "build", "Release", "spawn-helper"),
  ]) {
    if (existsSync(helper)) chmodSync(helper, 0o755);
  }
}

// ---------------------------------------------------------------- the trim
// prebuilds for the other platforms, and source maps nobody opens in a packaged app.
// Licence files stay: the harness is a dependency carried unmodified, with every
// package's licence file inside it.
const platformTag = `${process.platform}-${process.arch}`;
for (const prebuilds of [
  join(out, "node_modules", "node-pty", "prebuilds"),
  join(out, "node_modules", "koffi", "build"),
]) {
  if (!existsSync(prebuilds)) continue;
  for (const entry of readdirSync(prebuilds)) {
    if (entry !== platformTag) rmSync(join(prebuilds, entry), { recursive: true, force: true });
  }
}
let maps = 0;
let docs = 0;
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      // test fixtures, examples and docs nobody reads in a packaged app
      if (/^(__tests__|test|tests|docs|examples?|coverage)$/.test(entry.name)) {
        rmSync(p, { recursive: true, force: true });
        docs += 1;
        continue;
      }
      walk(p);
    } else if (entry.name.endsWith(".map")) {
      rmSync(p, { force: true });
      maps += 1;
    } else if (/^(README|CHANGELOG|HISTORY)(\..*)?$/i.test(entry.name)) {
      rmSync(p, { force: true });
      docs += 1;
    }
  }
};
walk(join(out, "node_modules"));
rmSync(join(out, "node_modules", ".package-lock.json"), { force: true });

// ---------------------------------------------------------------- the runtime's seat
// electron-builder copies runtime/ as an extra resource; when the hands' runtime was not
// built (scripts/desktop-app/build-runtime.py --target harness/desktop/runtime), the folder
// still has to exist. The app checks for the executable, not the folder.
const runtimeDir = join(appDir, "runtime");
if (!existsSync(runtimeDir)) {
  mkdirSync(runtimeDir, { recursive: true });
}
if (!existsSync(join(runtimeDir, process.platform === "win32" ? "nanomuse.exe" : "nanomuse"))) {
  writeFileSync(
    join(runtimeDir, "README.txt"),
    "No runtime for the hands was built into this copy of nanoMuse Desktop (a -min package). " +
      "The hands work when `nanomuse` is on PATH (pip install \"nanomuse[hands]\", " +
      "scripts/install-runtime-linux.sh, or the nanomuse-server package) or NANOMUSE_PY points at it.\n",
  );
}

// ---------------------------------------------------------------- the record
const installed = JSON.parse(readFileSync(join(out, "node_modules", "@deepseek-ai", "dsh", "package.json"), "utf8"));
const bundled = JSON.parse(readFileSync(join(out, "node_modules", "dsh-nanomuse", "package.json"), "utf8"));
if (installed.version !== dshVersion) throw new Error(`npm installed dsh ${installed.version}, wanted ${dshVersion}`);
let files = 0;
let bytes = 0;
const count = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) count(p);
    else {
      files += 1;
      bytes += statSync(p).size;
    }
  }
};
count(join(out, "node_modules"));
const record = {
  dsh: installed.version,
  bundle: bundled.version,
  platform: process.platform,
  arch: process.arch,
  files,
  megabytes: Math.round(bytes / 1024 / 1024),
  stagedAt: new Date().toISOString(),
};
writeFileSync(join(out, "dsh.json"), `${JSON.stringify(record, null, 2)}\n`);
console.log(`staged ${out}: dsh ${record.dsh}, ${bundled.name} ${record.bundle}, ${files} files, ${record.megabytes} MB (${maps} source maps, ${docs} doc/test dirs dropped)`);
