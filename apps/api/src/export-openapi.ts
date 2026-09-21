import { writeFileSync } from "node:fs";
import path from "node:path";
import { buildApp } from "./app.js";
import { testConfig, testDb } from "./test-harness.js";

const { config, cleanup } = testConfig();
const db = testDb(config);
const app = await buildApp({ config, db });
const spec = app.swagger();
const out = path.resolve(process.cwd().endsWith("api") ? "../../docs/openapi.json" : "docs/openapi.json");
writeFileSync(out, JSON.stringify(spec, null, 2));
await app.close();
cleanup();
console.log(`wrote ${out}`);
