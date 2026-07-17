import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

test("uses a local Vite entry instead of external hosting", async () => {
  const [html, packageJson, viteConfig] = await Promise.all([
    readFile(new URL("../index.html", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../vite.config.ts", import.meta.url), "utf8"),
  ]);

  assert.match(html, /<div id="root"><\/div>/);
  assert.match(html, /\/src\/main\.tsx/);
  assert.ok(packageJson.includes('"dev": "vite --host 127.0.0.1 --open /"'));
  assert.match(packageJson, /"build": "vite build"/);
  assert.doesNotMatch(viteConfig, /remote|deploy|hosting/i);

  await assert.rejects(access(new URL("../worker", import.meta.url)));
});
