#!/usr/bin/env node
// Removes a visualization, or the whole Visualizer, leaving nothing behind.
//
//   node scripts/viz-remove.mjs <id>     remove one visualization
//   node scripts/viz-remove.mjs --all    remove the Visualizer and the 3D library
//
//   --root <dir>   work on another copy of the project (the tests use this)
//
// Removing one deletes static/js/viz/scenes/<id>/ and its line in
// static/js/viz/registry.js, then searches the project for the id and fails if
// it is still mentioned anywhere. Everything a visualization has (its strings,
// tests, look notes) is in its folder, so that is all there is to remove.
//
// Removing everything deletes the Visualizer's own files and folders, and
// every block of lines elsewhere that sits between a `viz:begin` and a
// `viz:end` comment (the stylesheet link and the button in index.html, the
// import and the call in main.js, the strings in i18n.js, the README's
// mention). It then searches for anything left and fails if it finds any.
//
// openspec/ is planning history, not the product: it is neither changed nor
// searched. docs/visualizers.md is the guide to all of this.

import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
const rootFlag = argv.indexOf("--root");
const ROOT = resolve(rootFlag >= 0 ? argv[rootFlag + 1] : join(dirname(fileURLToPath(import.meta.url)), ".."));
const args = argv.filter((a, i) => a !== "--root" && i !== rootFlag + 1);

// Where the product lives. Anything else (planning notes, dependencies, build
// output, a user's library) is not the Visualizer's to change or to search.
const SEARCHED = ["static", "tests", "scripts", "docs", "app", "templates", "desktop", "README.md", "package.json", "playwright.config.mjs", ".github"];
const SKIPPED_DIRS = new Set(["node_modules", ".git", "__pycache__", "target", "gen", ".venv", "test-results"]);
const TEXT = /\.(js|mjs|cjs|ts|json|html|css|md|py|rs|toml|yml|yaml|txt|sh|svg)$/i;

// Everything `--all` deletes outright, relative to the project.
const WHOLE = [
  "static/js/viz",
  "static/css/viz.css",
  "static/vendor/three",
  "docs/visualizers.md",
  "scripts/vendor-three.mjs",
  "scripts/viz-remove.mjs",
];
// And every file in these folders whose name starts with "viz-".
const VIZ_FILES_IN = ["tests/js", "tests/e2e"];

// What counts as something of the Visualizer's left behind after `--all`.
const RESIDUE = [
  /viz:(begin|end)/,
  /(^|[^A-Za-z0-9])viz([-./:"'`]|\b)/,
  /vendor\/three/,
  /three\.module/,
  /Visuali[sz]er/,
];

const rel = (path) => relative(ROOT, path).split("\\").join("/");

function fail(message) {
  console.error(`viz-remove: ${message}`);
  process.exit(1);
}

function* textFiles(path) {
  if (!existsSync(path)) return;
  const stat = statSync(path);
  if (stat.isFile()) {
    if (TEXT.test(path)) yield path;
    return;
  }
  for (const name of readdirSync(path)) {
    if (SKIPPED_DIRS.has(name)) continue;
    yield* textFiles(join(path, name));
  }
}

function* searched() {
  for (const top of SEARCHED) yield* textFiles(join(ROOT, top));
}

/** Every line under the searched folders that matches: [{ file, line, text }]. */
function find(test) {
  const hits = [];
  for (const file of searched()) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((text, i) => {
      if (test(text)) hits.push({ file: rel(file), line: i + 1, text: text.trim().slice(0, 120) });
    });
  }
  return hits;
}

function report(what, hits) {
  console.error(`viz-remove: ${what}`);
  for (const h of hits.slice(0, 40)) console.error(`  ${h.file}:${h.line}  ${h.text}`);
  if (hits.length > 40) console.error(`  ... and ${hits.length - 40} more`);
  process.exit(1);
}

// ── One visualization ──

function removeOne(id) {
  // Two or more hyphenated words: a name short enough to be an ordinary word
  // ("drive") is already used elsewhere, and its leftovers could not be told
  // from coincidence.
  if (!/^[a-z0-9]+(-[a-z0-9]+)+$/.test(id)) fail(`"${id}" is not a visualization id (lower-case words joined by hyphens, such as rain-of-notes)`);
  const folder = join(ROOT, "static", "js", "viz", "scenes", id);
  const registry = join(ROOT, "static", "js", "viz", "registry.js");
  if (!existsSync(registry)) fail("static/js/viz/registry.js is not there: the Visualizer is not installed");
  const source = readFileSync(registry, "utf8");
  const lines = source.split("\n");
  const mentions = (line) => line.includes(`id: "${id}"`) || line.includes(`scenes/${id}/`);
  const kept = lines.filter((line) => !mentions(line));
  if (kept.length === lines.length && !existsSync(folder)) fail(`there is no visualization "${id}" (no folder and no line in the registry)`);

  rmSync(folder, { recursive: true, force: true });
  writeFileSync(registry, kept.join("\n"));

  const token = new RegExp(`(^|[^A-Za-z0-9_-])${id}([^A-Za-z0-9_-]|$)`);
  const left = find((text) => token.test(text));
  if (left.length) report(`"${id}" is removed, but it is still mentioned:`, left);
  console.log(`removed "${id}": its folder and its registry line. Nothing else mentions it.`);
}

// ── Everything ──

/** Drop every viz:begin .. viz:end block from a file. Returns how many. */
function stripBlocks(file) {
  const source = readFileSync(file, "utf8");
  if (!source.includes("viz:begin")) return 0;
  const out = [];
  let inside = false;
  let blocks = 0;
  for (const line of source.split("\n")) {
    if (!inside && line.includes("viz:begin")) {
      inside = true;
      blocks++;
      continue;
    }
    if (inside) {
      if (line.includes("viz:end")) inside = false;
      continue;
    }
    out.push(line);
  }
  if (inside) fail(`${rel(file)} has a viz:begin with no viz:end after it; nothing was changed in that file`);
  writeFileSync(file, out.join("\n"));
  return blocks;
}

function removeAll() {
  const self = fileURLToPath(import.meta.url);
  let files = 0;
  let blocks = 0;

  // Blocks first, while this script's own text is not yet among the files
  // being read (it mentions the markers, in words).
  for (const file of searched()) {
    if (resolve(file) === resolve(self) || rel(file) === "scripts/viz-remove.mjs") continue;
    if (WHOLE.some((w) => rel(file) === w || rel(file).startsWith(`${w}/`))) continue;
    if (VIZ_FILES_IN.some((d) => rel(file).startsWith(`${d}/viz-`))) continue;
    blocks += stripBlocks(file);
  }
  for (const dir of VIZ_FILES_IN) {
    const path = join(ROOT, dir);
    if (!existsSync(path)) continue;
    for (const name of readdirSync(path)) {
      if (!name.startsWith("viz-")) continue;
      rmSync(join(path, name), { recursive: true, force: true });
      files++;
    }
  }
  for (const w of WHOLE) {
    const path = join(ROOT, w);
    if (!existsSync(path)) continue;
    rmSync(path, { recursive: true, force: true });
    files++;
  }

  const left = find((text) => RESIDUE.some((r) => r.test(text)));
  if (left.length) report("the Visualizer is removed, but something of it is still mentioned:", left);
  console.log(`removed the Visualizer: ${files} files and folders, ${blocks} marked blocks. Nothing of it is left.`);
}

if (args.length !== 1 || args[0] === "--help" || args[0] === "-h") {
  console.log("usage: node scripts/viz-remove.mjs <id> | --all   [--root <dir>]");
  process.exit(args.length === 1 ? 0 : 2);
}
if (args[0] === "--all") removeAll();
else removeOne(args[0]);
