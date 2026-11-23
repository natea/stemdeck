// Runs every visualization's own test (static/js/viz/scenes/<id>/scene.test.mjs).
//
// A visualization's tests live in its folder, so that deleting the folder
// deletes them too. This file names none of them: it runs whatever is there,
// and checks that the registry and the folders agree.
//
// Run:  node tests/js/viz-scenes.test.mjs

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SCENES } from "../../static/js/viz/registry.js";

const DIR = fileURLToPath(new URL("../../static/js/viz/scenes/", import.meta.url));
let pass = 0,
  fail = 0;
const check = (name, cond, detail = "") => {
  if (cond) pass++;
  else {
    fail++;
    console.log(`FAIL  ${name}${detail ? "  -- " + detail : ""}`);
  }
};

const folders = existsSync(DIR) ? readdirSync(DIR).filter((n) => statSync(join(DIR, n)).isDirectory()).sort() : [];
const listed = SCENES.map((s) => s.id).sort();
check("every folder is listed in the registry, and every listed one has a folder", JSON.stringify(folders) === JSON.stringify(listed), `folders ${folders} / registry ${listed}`);
check("no id is listed twice", new Set(listed).size === listed.length);

for (const id of folders) {
  for (const file of ["index.js", "map.js", "strings.js", "scene.test.mjs", "scene.e2e.mjs", "LOOK.md"]) {
    check(`${id} has ${file}`, existsSync(join(DIR, id, file)));
  }
  const def = (await import(new URL(`../../static/js/viz/scenes/${id}/index.js`, import.meta.url))).default;
  check(`${id}: the folder, the registry line and the module agree on the id`, def?.id === id, String(def?.id));
  check(`${id}: says whether it needs notes`, typeof def?.needs?.notes === "boolean");
  const test = join(DIR, id, "scene.test.mjs");
  if (!existsSync(test)) continue;
  const run = spawnSync(process.execPath, [test], { encoding: "utf8" });
  check(`${id}: its own tests pass`, run.status === 0, `\n${(run.stdout || "").trim()}\n${(run.stderr || "").trim()}`);
  const tally = /(\d+) passed, (\d+) failed/.exec(run.stdout || "");
  if (tally) console.log(`      ${id}: ${tally[0]}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
