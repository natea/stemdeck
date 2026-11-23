// Runs every visualization's own browser tests
// (static/js/viz/scenes/<id>/scene.e2e.mjs).
//
// They live in the visualization's folder, so that deleting the folder deletes
// them too. This file names none of them: it defines whatever is there. The
// host's own behaviour is viz-host.spec.mjs, which uses stubs.

import { existsSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test, expect } from "@playwright/test";
import * as h from "./viz-helpers.mjs";

const DIR = new URL("../../static/js/viz/scenes/", import.meta.url);
const root = fileURLToPath(DIR);
const ids = existsSync(root) ? readdirSync(root).filter((n) => statSync(`${root}/${n}`).isDirectory()).sort() : [];

test.use(h.GPU);

for (const id of ids) {
  const file = new URL(`${id}/scene.e2e.mjs`, DIR);
  if (!existsSync(fileURLToPath(file))) continue;
  const define = (await import(file.href)).default;
  test.describe(`Visualizer: ${id}`, () => define({ test, expect, h, id }));
}

test("every installed visualization loads and is offered", async ({ page }) => {
  test.skip(ids.length === 0, "no visualization is installed");
  await page.setViewportSize({ width: 1500, height: 900 });
  await h.openStudio(page);
  await h.openViz(page);
  expect((await h.vizState(page)).installed.slice().sort()).toEqual(ids);
  await expect(page.locator("#viz .viz-pick")).toHaveCount(ids.length);
});
