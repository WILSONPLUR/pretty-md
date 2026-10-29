import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const workerPath = resolve(projectRoot, "dist/server/index.js");
const manifestPath = resolve(projectRoot, "dist/.openai/hosting.json");

const source = await readFile(workerPath, "utf8");
try {
  JSON.parse(await readFile(manifestPath, "utf8"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  // A public source clone intentionally has no publisher deployment binding.
  try {
    await readFile(resolve(projectRoot, ".openai/hosting.json"), "utf8");
  } catch (bindingError) {
    if (bindingError.code !== "ENOENT") throw bindingError;
    console.log("Development build: no Sites deployment binding.");
  }
  // A configured deployment must include its emitted hosting metadata.
  const binding = await readFile(resolve(projectRoot, ".openai/hosting.json"), "utf8").catch(e => { if (e.code === "ENOENT") return null; throw e; });
  if (binding !== null) throw error;
}

// A data URL forces ESM parsing even though the generated output has no package.json.
const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const workerModule = await import(moduleUrl);
assert.equal(
  typeof workerModule.default?.fetch,
  "function",
  `${pathToFileURL(workerPath)} must export default.fetch`,
);

console.log("Artifact is valid ESM and exports default.fetch");
