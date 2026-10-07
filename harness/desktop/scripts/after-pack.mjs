#!/usr/bin/env node
// electron-builder afterPack: slim the unpacked app before the installers are made.
// Today this only drops the Electron locales nobody selected on Linux — Chromium
// requires en-US.pak, and the app is translated into English and Chinese (zh-CN),
// so every other locales/*.pak goes. Saves roughly 8-15 MB unpacked on Linux, a few
// MB inside the .deb. Runs on every platform but only finds locales on Linux/macOS.
//
// electron-builder calls the default export with its context; also runnable by hand:
//   node scripts/after-pack.mjs /path/to/linux-unpacked

import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

const KEEP = new Set(["en-US.pak", "zh-CN.pak"]);

export function slimLocales(root) {
  const dir = join(root, "locales");
  if (!existsSync(dir)) return 0;
  let saved = 0;
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".pak") || KEEP.has(entry)) continue;
    const p = join(dir, entry);
    try {
      saved += statSync(p).size;
      rmSync(p, { force: true });
    } catch {
      /* a locale that cannot be removed ships; never fail the build over it */
    }
  }
  return saved;
}

export default async function afterPack(context) {
  const root = context?.appOutDir;
  if (!root) return;
  const saved = slimLocales(root);
  if (saved > 0) console.log(`after-pack: dropped locales (${(saved / 1024 / 1024).toFixed(1)} MB)`);
}

const roots = process.argv.slice(2).filter((a) => !a.startsWith("-"));
if (roots.length > 0) {
  let saved = 0;
  for (const root of roots) saved += slimLocales(root);
  console.log(`after-pack: dropped locales (${(saved / 1024 / 1024).toFixed(1)} MB)`);
}
