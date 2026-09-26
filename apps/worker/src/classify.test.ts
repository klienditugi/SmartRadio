import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "@subwave-ai/shared";
import { createRequest, enqueueJob, getRequest, listRequestEvents, openDatabase } from "@subwave-ai/db";
import { OllamaProvider, type ProviderBundle } from "@subwave-ai/providers";
import { claimAndRun } from "./dispatch.js";
import type { WorkerContext } from "./context.js";

const classification = {
  artist: "Artist",
  title: "Track",
  genre: "techno",
  subgenres: ["minimal"],
  electronic: true,
  station_match: true,
  confidence: 0.95,
  reason: "fits the station",
};

function fixture() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "subwave-worker-"));
  const secrets = path.join(dir, "secrets");
  mkdirSync(secrets);
  writeFileSync(path.join(secrets, "admin_password"), "x");
  const cfgPath = path.join(dir, "subwave.yaml");
  writeFileSync(
    cfgPath,
    `
server:
  host: "127.0.0.1"
  port: 8788
database:
  path: ":memory:"
paths:
  secrets_dir: "${secrets}"
  downloads: "${path.join(dir, "downloads")}"
  staging: "${path.join(dir, "staging")}"
  library: "${path.join(dir, "library")}"
policy:
  require_electronic: true
  require_station_match: true
  min_confidence: 0.5
  allowed_genres: []
  blocked_artists: []
  blocked_terms: []
llm:
  base_url: "http://ollama.test"
  model: "test-model"
library:
  base_url: "http://navidrome.test"
  username: "nd"
radio:
  base_url: "http://radio.test/api"
  admin_user: "dj"
acquisition:
  provider: slskd
  base_url: "http://slskd.test"
worker:
  id: "worker-test"
  lease_ms: 5000
`,
  );
  const config = loadConfig({ configPath: cfgPath });
  const db = openDatabase(":memory:");
  return { dir, config, db, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("worker classify", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()?.();
  });

  it("claims a classify job and advances RECEIVED → CLASSIFYING → APPROVED with a mocked LLM", async () => {
    const { config, db, cleanup } = fixture();
    cleanups.push(cleanup);
    const llm = new OllamaProvider({
      baseUrl: "http://ollama.test",
      model: "test-model",
      verifyStatus: "verified",
      fetch: async () =>
        new Response(JSON.stringify({ message: { content: JSON.stringify(classification) } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    });
    const providers = {
      llm,
      library: {} as ProviderBundle["library"],
      radio: {} as ProviderBundle["radio"],
      acquisition: {} as ProviderBundle["acquisition"],
    };
    const request = createRequest(db, { rawQuery: "play that techno track" });
    enqueueJob(db, { type: "classify", requestId: request.id });
    const ctx: WorkerContext = { db, config, providers, workerId: "worker-test" };
    const ran = await claimAndRun(ctx);
    expect(ran).toBe(true);
    const updated = getRequest(db, request.id);
    expect(updated?.status).toBe("APPROVED");
    const events = listRequestEvents(db, request.id).map((e) => `${e.from_status}->${e.to_status}`);
    expect(events).toContain("RECEIVED->CLASSIFYING");
    expect(events).toContain("CLASSIFYING->APPROVED");
  });

  it("rejects via station policy after valid classification JSON", async () => {
    const { config, db, cleanup } = fixture();
    cleanups.push(cleanup);
    const llm = new OllamaProvider({
      baseUrl: "http://ollama.test",
      model: "test-model",
      verifyStatus: "verified",
      fetch: async () =>
        new Response(
          JSON.stringify({
            message: {
              content: JSON.stringify({ ...classification, electronic: false, station_match: false }),
            },
          }),
          { status: 200 },
        ),
    });
    const request = createRequest(db, { rawQuery: "play a country ballad" });
    enqueueJob(db, { type: "classify", requestId: request.id });
    await claimAndRun({
      db,
      config,
      providers: {
        llm,
        library: {} as ProviderBundle["library"],
        radio: {} as ProviderBundle["radio"],
        acquisition: {} as ProviderBundle["acquisition"],
      },
      workerId: "worker-test",
    });
    expect(getRequest(db, request.id)?.status).toBe("REJECTED");
  });
});
