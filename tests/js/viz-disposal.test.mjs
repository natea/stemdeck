// Disposal is a feature (openspec change add-stem-visualizers): any
// visualization, and the whole Visualizer, can be removed the documented way
// and leave nothing behind. This proves it on every run, for every
// visualization in the registry, on temporary copies of the project.
//
//   node scripts/viz-remove.mjs <id>     one visualization
//   node scripts/viz-remove.mjs --all    everything
//
// It names no visualization: it removes whatever the registry lists.
//
// Run:  node tests/js/viz-disposal.test.mjs

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SCENES } from "../../static/js/viz/registry.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
let pass = 0,
  fail = 0;
const check = (name, cond, detail = "") => {
  if (cond) pass++;
  else {
    fail++;
    console.log(`FAIL  ${name}${detail ? "  -- " + detail : ""}`);
  }
};

const scratch = mkdtempSync(join(tmpdir(), "viz-disposal-"));
let copies = 0;

/** A fresh copy of the parts of the project the Visualizer lives in. */
function copy() {
  const dir = join(scratch, `copy-${copies++}`);
  const skip = (src) => !/(__pycache__|node_modules|test-results)$/.test(src);
  for (const part of ["static", "scripts", "docs", "tests/js", "tests/e2e", "README.md", "package.json"]) {
    if (existsSync(join(ROOT, part))) cpSync(join(ROOT, part), join(dir, part), { recursive: true, filter: skip });
  }
  return dir;
}

const run = (dir, ...args) => spawnSync(process.execPath, args, { cwd: dir, encoding: "utf8" });
const remove = (dir, what) => run(dir, join(dir, "scripts", "viz-remove.mjs"), what, "--root", dir);
const said = (r) => `${(r.stdout || "").trim()} ${(r.stderr || "").trim()}`.trim().slice(0, 600);

function* files(path) {
  if (!existsSync(path)) return;
  if (statSync(path).isFile()) {
    if (/\.(js|mjs|json|html|css|md|txt)$/.test(path)) yield path;
    return;
  }
  for (const name of readdirSync(path)) yield* files(join(path, name));
}

/** Every "file:line" in a copy whose line matches. */
function mentions(dir, test) {
  const out = [];
  for (const file of files(dir)) {
    readFileSync(file, "utf8").split("\n").forEach((line, i) => {
      if (test(line)) out.push(`${file.slice(dir.length + 1)}:${i + 1}`);
    });
  }
  return out;
}

const registryOf = async (dir) => (await import(`${pathToFileURL(join(dir, "static/js/viz/registry.js")).href}?${copies}-${Math.random()}`)).SCENES;
const ids = SCENES.map((s) => s.id);

// -- one at a time: each visualization, removed from a fresh copy ---------------------

for (const id of ids) {
  const dir = copy();
  const r = remove(dir, id);
  check(`${id}: the documented command succeeds`, r.status === 0, said(r));
  check(`${id}: its folder is gone`, !existsSync(join(dir, "static/js/viz/scenes", id)));

  let left = null;
  try {
    left = await registryOf(dir);
  } catch (e) {
    check(`${id}: the registry still parses`, false, String(e));
  }
  if (left) {
    check(`${id}: the registry still parses, without it`, !left.some((s) => s.id === id) && left.length === ids.length - 1, left.map((s) => s.id).join(","));
    check(`${id}: every other visualization is still listed, in order`, JSON.stringify(left.map((s) => s.id)) === JSON.stringify(ids.filter((x) => x !== id)));
  }
  check(`${id}: the others' folders are untouched`, ids.filter((x) => x !== id).every((x) => existsSync(join(dir, "static/js/viz/scenes", x, "index.js"))));

  // A search of the project for its name finds nothing.
  const token = new RegExp(`(^|[^A-Za-z0-9_-])${id}([^A-Za-z0-9_-]|$)`);
  const found = mentions(dir, (line) => token.test(line));
  check(`${id}: no file mentions it`, found.length === 0, found.slice(0, 8).join(" "));

  // The shared parts and the remaining visualizations still pass their tests there.
  for (const test of ["viz-data.test.mjs", "viz-clock.test.mjs", "viz-scenes.test.mjs"]) {
    const t = run(dir, join(dir, "tests/js", test));
    check(`${id}: ${test} passes without it`, t.status === 0, said(t));
  }
  const syntax = run(dir, "--check", join(dir, "static/js/viz/host.js"));
  check(`${id}: the host still parses`, syntax.status === 0, said(syntax));
  rmSync(dir, { recursive: true, force: true });
}

// -- all of them, one after another: the Visualizer is left with nothing to offer -------

{
  const dir = copy();
  let ok = true;
  for (const id of ids) ok = remove(dir, id).status === 0 && ok;
  check("removing every visualization in turn succeeds each time", ok);
  const left = await registryOf(dir).catch(() => null);
  check("the registry is then empty and still parses: the button is not offered", Array.isArray(left) && left.length === 0);
  const t = run(dir, join(dir, "tests/js/viz-scenes.test.mjs"));
  check("and the runner passes with nothing to run", t.status === 0, said(t));
  check("the folder of visualizations is empty", !existsSync(join(dir, "static/js/viz/scenes")) || readdirSync(join(dir, "static/js/viz/scenes")).length === 0);
  rmSync(dir, { recursive: true, force: true });
}

// -- refusals --------------------------------------------------------------------------

{
  const dir = copy();
  check("an id that is not installed is refused", remove(dir, "no-such-picture").status !== 0);
  check("a one-word id is refused: it could not be searched for", remove(dir, "drive").status !== 0);
  check("a refusal changes nothing", (await registryOf(dir)).length === ids.length);
  rmSync(dir, { recursive: true, force: true });
}

// -- everything --------------------------------------------------------------------------

{
  const dir = copy();
  const before = {
    html: readFileSync(join(dir, "static/index.html"), "utf8"),
    i18n: (await import(`${pathToFileURL(join(dir, "static/js/i18n.js")).href}?before`)).TRANSLATIONS,
  };
  const r = remove(dir, "--all");
  check("--all: the documented command succeeds", r.status === 0, said(r));

  for (const gone of ["static/js/viz", "static/css/viz.css", "static/vendor/three", "docs/visualizers.md", "scripts/viz-remove.mjs", "scripts/vendor-three.mjs"]) {
    check(`--all: ${gone} is gone`, !existsSync(join(dir, gone)));
  }
  for (const d of ["tests/js", "tests/e2e"]) {
    const left = readdirSync(join(dir, d)).filter((n) => n.startsWith("viz-"));
    check(`--all: no Visualizer test is left in ${d}`, left.length === 0, left.join(","));
  }
  check("--all: the other vendored libraries are untouched", existsSync(join(dir, "static/vendor/multitrack.js")));

  // No `viz` and no `three` reference remains, anywhere.
  const residue = [/viz:(begin|end)/, /(^|[^A-Za-z0-9])viz([-./:"'`]|\b)/, /vendor\/three/, /three\.module/, /Visuali[sz]er/];
  const found = mentions(dir, (line) => residue.some((x) => x.test(line)));
  check("--all: no viz or three reference remains", found.length === 0, found.slice(0, 10).join(" "));

  // index.html still parses: every element that was opened is closed, and only
  // the Visualizer's own lines went.
  const html = readFileSync(join(dir, "static/index.html"), "utf8");
  const count = (s, re) => (s.match(re) || []).length;
  const balanced = ["div", "button", "section", "span", "footer", "nav", "aside", "svg", "label", "select", "ul", "li", "p", "head", "body", "html"].filter(
    (tag) => count(html, new RegExp(`<${tag}[\\s>]`, "g")) !== count(html, new RegExp(`</${tag}>`, "g")),
  );
  check("--all: index.html still parses (every element opened is closed)", balanced.length === 0, balanced.join(","));
  check("--all: its comments are closed", count(html, /<!--/g) === count(html, /-->/g));
  check("--all: it lost one stylesheet link and one button, nothing else", count(before.html, /<link /g) - count(html, /<link /g) === 1 && count(before.html, /<button[\s>]/g) - count(html, /<button[\s>]/g) === 1);
  check("--all: the rest of the page is line for line what it was", (() => {
    // The page as it was, less its marked blocks, taken out here by hand.
    const kept = [];
    let inside = false;
    for (const line of before.html.split("\n")) {
      if (line.includes("viz:begin")) inside = true;
      else if (line.includes("viz:end")) inside = false;
      else if (!inside) kept.push(line);
    }
    return kept.join("\n") === html;
  })());

  // The scripts still parse, and the string tables lost exactly the view's keys.
  for (const js of ["static/js/main.js", "static/js/i18n.js", "static/js/helpMode.js"]) {
    const syntax = run(dir, "--check", join(dir, js));
    check(`--all: ${js} still parses`, syntax.status === 0, said(syntax));
  }
  const after = (await import(`${pathToFileURL(join(dir, "static/js/i18n.js")).href}?after`)).TRANSLATIONS;
  const lostKeys = (lang) => Object.keys(before.i18n[lang]).filter((k) => !(k in after[lang]));
  check("--all: every language table lost only the view's own strings", Object.keys(before.i18n).every((lang) => lostKeys(lang).every((k) => k.startsWith("viz.") || k === "help.vizButton")));
  check("--all: and every other string is unchanged", Object.keys(after).every((lang) => Object.keys(after[lang]).every((k) => after[lang][k] === before.i18n[lang][k])));
  check("--all: no table has a view string left", Object.keys(after).every((lang) => !Object.keys(after[lang]).some((k) => k.startsWith("viz.") || k === "help.vizButton")));
  check("--all: main.js no longer starts the view", !readFileSync(join(dir, "static/js/main.js"), "utf8").includes("initVisualizer"));

  // Running it again on what is left has nothing to do and nothing to break.
  rmSync(dir, { recursive: true, force: true });
}

rmSync(scratch, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
