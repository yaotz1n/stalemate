// Downloads the official Stockfish build for this OS into src-tauri/binaries/,
// named the way Tauri expects for a bundled program ("sidecar"):
// stockfish-<target triple>[.exe]. Stockfish grades moves in game review (the
// bot is Stalemate's own engine). The binaries aren't kept in git (they're
// ~100 MB); run this once before `npm run tauri dev` / `tauri build`, and the
// build workflow runs it too.
//
//   node scripts/fetch-stockfish.mjs
//
// Stockfish is GPL-3.0 (https://stockfishchess.org); its license is copied
// next to the binary as stockfish-COPYING.txt.

import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const VERSION = "sf_19";
const BASE = `https://github.com/official-stockfish/Stockfish/releases/download/${VERSION}`;

// Per OS: the release file, and the target triples to install it as. The
// "universal" builds pick the fastest code for the CPU at run time; the Mac
// one holds both Apple Silicon and Intel.
const PLATFORMS = {
  darwin: { file: "stockfish-macos-universal.tar.gz", triples: ["aarch64-apple-darwin", "x86_64-apple-darwin", "universal-apple-darwin"] },
  win32: { file: "stockfish-windows-x86-64-universal.zip", triples: ["x86_64-pc-windows-msvc"], exe: true },
  linux: { file: "stockfish-linux-x86-64-universal.tar.gz", triples: ["x86_64-unknown-linux-gnu"] },
};

const platform = PLATFORMS[process.platform];
if (!platform) {
  console.error(`No Stockfish download set up for ${process.platform}`);
  process.exit(1);
}

const outDir = join(import.meta.dirname, "..", "src-tauri", "binaries");
const names = platform.triples.map((t) => `stockfish-${t}${platform.exe ? ".exe" : ""}`);
if (names.every((n) => existsSync(join(outDir, n))) && !process.argv.includes("--force")) {
  console.log(`Stockfish is already in src-tauri/binaries (${names.join(", ")}); --force to download again.`);
  process.exit(0);
}

const work = mkdtempSync(join(tmpdir(), "stockfish-"));
try {
  const url = `${BASE}/${platform.file}`;
  console.log(`Downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: ${res.status} ${res.statusText}`);
  const archive = join(work, platform.file);
  writeFileSync(archive, Buffer.from(await res.arrayBuffer()));
  // bsdtar (macOS, Windows 10+, most Linux) unpacks both .tar.gz and .zip.
  execFileSync("tar", ["-xf", archive, "-C", work]);

  // The engine is the biggest file named stockfish*; the license is Copying.txt.
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else files.push(p);
    }
  };
  walk(work);
  const engine = files
    .filter((p) => /stockfish[^/\\]*$/i.test(p) && p !== archive && !p.endsWith(".md") && !p.endsWith(".txt"))
    .sort((a, b) => statSync(b).size - statSync(a).size)[0];
  if (!engine) throw new Error("no Stockfish binary in the download");
  const license = files.find((p) => /copying\.txt$/i.test(p));

  mkdirSync(outDir, { recursive: true });
  for (const name of names) {
    copyFileSync(engine, join(outDir, name));
    if (!platform.exe) chmodSync(join(outDir, name), 0o755);
  }
  if (license) copyFileSync(license, join(outDir, "stockfish-COPYING.txt"));
  console.log(`Installed ${names.join(", ")} in src-tauri/binaries`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
