#!/usr/bin/env node
// Vendors a pinned Three.js release into static/vendor/three/ for the Visualizer.
//
//   node scripts/vendor-three.mjs
//
// It downloads the npm tarball named below, checks it against the pinned
// SHA-512, copies the core module and the add-ons listed in ADDONS (with every
// file they import), and writes VERSION (a SHA-256 per file) and LICENSE.
//
// One change is made to the upstream files: the add-ons import from the bare
// specifier "three", which a browser resolves only through an import map, and
// StemDeck's Content-Security-Policy forbids an inline one. Each such import is
// rewritten to a relative path to the vendored core module. Nothing else is
// touched, so a second run produces byte-identical files.
//
// To upgrade: change VERSION and INTEGRITY (npm view three@<v> dist.integrity),
// run the script, and read the release notes: Three.js changes its API between
// releases.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = "0.187.0";
const INTEGRITY =
  "sha512-Qiu7R+Cmh8CstZsY1uJOSWnVlfo7ZtNLV7mF8Jltk3LB3AtDu9cRZlcnRKkAk8Y4z6KKw35z7Y7Urd7jWY8etA==";
const TARBALL = `https://registry.npmjs.org/three/-/three-${VERSION}.tgz`;

// Upstream path inside the package -> path inside static/vendor/three/.
const CORE = {
  "build/three.module.js": "three.module.js",
  "build/three.core.js": "three.core.js",
};
const CORE_ENTRY = "three.module.js";

// Add-ons the scenes use, relative to examples/jsm/. Their own imports are
// followed, so the shaders and base classes they need come along.
const ADDONS = [
  "postprocessing/EffectComposer.js",
  "postprocessing/RenderPass.js",
  "postprocessing/UnrealBloomPass.js",
  "postprocessing/OutputPass.js",
];

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "static", "vendor", "three");

// Real import and re-export statements only: they start a line, which the
// usage examples inside doc comments (" * import ...") do not.
const IMPORT_RE = /^([ \t]*(?:import|export)\b[^;"']*?)(["'])([^"']+)\2/gm;

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

async function download() {
  const res = await fetch(TARBALL);
  if (!res.ok) throw new Error(`download failed: ${res.status} ${TARBALL}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const got = "sha512-" + createHash("sha512").update(buf).digest("base64");
  if (got !== INTEGRITY) {
    throw new Error(`integrity mismatch for ${TARBALL}\n  expected ${INTEGRITY}\n  got      ${got}`);
  }
  return buf;
}

function collectAddons(pkg) {
  // Breadth-first over relative imports, from the listed add-ons.
  const seen = new Map(); // path under examples/jsm -> rewritten source
  const queue = [...ADDONS];
  while (queue.length) {
    const rel = queue.shift();
    if (seen.has(rel)) continue;
    const src = readFileSync(join(pkg, "examples", "jsm", rel), "utf8");
    const outPath = posix.join("addons", rel);
    const rewritten = src.replace(IMPORT_RE, (whole, head, quote, spec) => {
      if (spec === "three") {
        let to = posix.relative(posix.dirname(outPath), CORE_ENTRY);
        if (!to.startsWith(".")) to = "./" + to;
        return `${head}${quote}${to}${quote}`;
      }
      if (spec.startsWith(".")) {
        queue.push(posix.normalize(posix.join(posix.dirname(rel), spec)));
        return whole;
      }
      throw new Error(`${rel} imports "${spec}", which is neither "three" nor a relative path`);
    });
    seen.set(rel, rewritten);
  }
  return seen;
}

async function main() {
  const tmp = mkdtempSync(join(tmpdir(), "vendor-three-"));
  try {
    const tgz = join(tmp, "three.tgz");
    writeFileSync(tgz, await download());
    execFileSync("tar", ["-xzf", tgz, "-C", tmp]);
    const pkg = join(tmp, "package");

    const files = new Map(); // output path -> Buffer
    for (const [from, to] of Object.entries(CORE)) {
      files.set(to, readFileSync(join(pkg, from)));
    }
    for (const [rel, src] of collectAddons(pkg)) {
      files.set(posix.join("addons", rel), Buffer.from(src, "utf8"));
    }
    files.set("LICENSE", readFileSync(join(pkg, "LICENSE")));

    rmSync(OUT, { recursive: true, force: true });
    const names = [...files.keys()].sort();
    for (const name of names) {
      const dest = join(OUT, ...name.split("/"));
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, files.get(name));
    }

    const lines = [
      `three ${VERSION}`,
      `source ${TARBALL}`,
      `integrity ${INTEGRITY}`,
      `modified add-ons: the bare "three" import is rewritten to a relative path (scripts/vendor-three.mjs)`,
      "",
      ...names.map((n) => `${sha256(files.get(n))}  ${n}`),
      "",
    ];
    writeFileSync(join(OUT, "VERSION"), lines.join("\n"));

    const total = names.reduce((n, f) => n + files.get(f).length, 0);
    console.log(`three ${VERSION}: ${names.length} files, ${(total / 1024).toFixed(0)} KB -> ${relative(ROOT, OUT)}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// --check: verify the files on disk against VERSION without downloading.
function check() {
  const versionFile = join(OUT, "VERSION");
  if (!existsSync(versionFile)) throw new Error("static/vendor/three/VERSION is missing");
  let bad = 0;
  for (const line of readFileSync(versionFile, "utf8").split("\n")) {
    const m = /^([0-9a-f]{64}) {2}(.+)$/.exec(line);
    if (!m) continue;
    const got = sha256(readFileSync(join(OUT, ...m[2].split("/"))));
    if (got !== m[1]) {
      console.error(`changed: ${m[2]}`);
      bad++;
    }
  }
  if (bad) process.exit(1);
  console.log("static/vendor/three matches VERSION");
}

if (process.argv.includes("--check")) check();
else await main();
