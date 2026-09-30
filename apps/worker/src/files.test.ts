import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createRequest,
  enqueueJob,
  getRequest,
  listJobsForRequest,
  listRequestEvents,
  openDatabase,
  transitionRequest,
} from "@subwave-ai/db";
import type { ProviderBundle } from "@subwave-ai/providers";
import { loadConfig, type RequestStatus } from "@subwave-ai/shared";
import type { WorkerContext } from "./context.js";
import { setFfprobeRunner, type ProbeInfo } from "./processors/ffprobe.js";
import { handleImportLibrary, handleValidateFile } from "./processors/files.js";

const TO_DOWNLOAD_COMPLETE: RequestStatus[] = [
  "CLASSIFYING",
  "APPROVED",
  "CHECKING_LIBRARY",
  "SEARCHING",
  "QUEUED",
  "DOWNLOADING",
  "DOWNLOAD_COMPLETE",
];

const TO_VALIDATING: RequestStatus[] = [...TO_DOWNLOAD_COMPLETE, "VALIDATING"];

function fixture() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "subwave-move-"));
  const secrets = path.join(dir, "secrets");
  mkdirSync(secrets);
  writeFileSync(path.join(secrets, "admin_password"), "x");
  const downloads = path.join(dir, "downloads");
  const staging = path.join(dir, "staging");
  const library = path.join(dir, "library");
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
  downloads: "${downloads}"
  staging: "${staging}"
  library: "${library}"
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
  verify_status: verified
`,
  );
  const config = loadConfig({ configPath: cfgPath });
  const db = openDatabase(":memory:");
  const calls: string[] = [];
  const boom = async () => {
    calls.push("radio");
    throw new Error("radio should not be called");
  };
  const radio: ProviderBundle["radio"] = {
    kind: "subwave",
    verifyStatus: "verified",
    health: boom,
    nowPlaying: boom,
    state: boom,
    djSearch: boom,
    queueTrack: boom,
    refreshPlaylist: boom,
    say: boom,
    publicRequest: boom,
    publicRequestStatus: boom,
  };
  const libraryProvider: ProviderBundle["library"] = {
    kind: "navidrome",
    verifyStatus: "verified",
    search3: async () => {
      calls.push("library-search");
      return [];
    },
    getSong: async () => null,
    startScan: async () => {
      calls.push("startScan");
      return {};
    },
    getScanStatus: async () => ({}),
    health: async () => ({ ok: true, verifyStatus: "verified", checked_at: "t" }),
  };
  const acquisition: ProviderBundle["acquisition"] = {
    kind: "slskd",
    verifyStatus: "verified",
    search: async () => {
      calls.push("acq-search");
      return {};
    },
    getSearch: async () => {
      calls.push("get-search");
      return {};
    },
    getSearchResponses: async () => {
      calls.push("get-responses");
      return [];
    },
    enqueueDownload: async () => {
      calls.push("enqueue");
      return {};
    },
    listDownloads: async () => {
      calls.push("list");
      return [];
    },
    health: async () => ({ ok: true, verifyStatus: "verified", checked_at: "t" }),
  };
  const ctx: WorkerContext = {
    db,
    config,
    providers: { llm: {} as ProviderBundle["llm"], library: libraryProvider, radio, acquisition },
    workerId: "worker-test",
  };
  return {
    dir,
    downloads,
    staging,
    library,
    config,
    db,
    ctx,
    calls,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function advance(db: ReturnType<typeof openDatabase>, id: string, to: RequestStatus): void {
  const statuses = to === "VALIDATING" ? TO_VALIDATING : TO_DOWNLOAD_COMPLETE;
  for (const status of statuses) {
    transitionRequest(db, { requestId: id, to: status, actor: "test" });
    if (status === to) return;
  }
  throw new Error(`unreachable status ${to}`);
}

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) found.push(...filesUnder(full));
    else found.push(full);
  }
  return found;
}

function relativeFiles(root: string): string[] {
  return filesUnder(root).map((file) => path.relative(root, file)).sort();
}

async function placeInLibrary(ctx: WorkerContext, requestId: string, filename: string) {
  const validate = enqueueJob(ctx.db, {
    type: "validate_file",
    requestId,
    payload: { filename, size: statSync(safeDownload(ctx, filename)).size },
  });
  await handleValidateFile(ctx, validate);
  const imported = listJobsForRequest(ctx.db, requestId).find((job) => job.type === "import_library");
  await handleImportLibrary(ctx, imported!);
}

function safeDownload(ctx: WorkerContext, filename: string): string {
  return path.join(ctx.config.paths.downloads, filename);
}

function matchingProbe(filePath: string): ProbeInfo {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".mp3") return { codecName: "mp3", formatName: "mp3", durationSeconds: 180 };
  if (ext === ".flac") return { codecName: "flac", formatName: "flac", durationSeconds: 180 };
  return { codecName: "unknown", formatName: "unknown" };
}

describe("file moves", () => {
  const cleanups: Array<() => void> = [];
  beforeEach(() => {
    setFfprobeRunner(async (_bin, filePath) => matchingProbe(filePath));
  });
  afterEach(() => {
    setFfprobeRunner(undefined);
    vi.restoreAllMocks();
    while (cleanups.length) cleanups.pop()?.();
  });

  it("moves the validated file on the same filesystem and leaves downloads and staging empty", async () => {
    const { ctx, db, downloads, staging, library, calls, cleanup } = fixture();
    cleanups.push(cleanup);
    const body = Buffer.from("same-fs-audio");
    mkdirSync(downloads, { recursive: true });
    writeFileSync(path.join(downloads, "track.mp3"), body);
    const request = createRequest(db, { rawQuery: "Artist - Track" });
    advance(db, request.id, "DOWNLOAD_COMPLETE");
    await placeInLibrary(ctx, request.id, "track.mp3");
    expect(readFileSync(path.join(library, "track.mp3"))).toEqual(body);
    expect(relativeFiles(downloads)).toEqual([]);
    expect(relativeFiles(staging)).toEqual([]);
    expect(existsSync(downloads)).toBe(true);
    expect(existsSync(staging)).toBe(true);
    expect(getRequest(db, request.id)?.status).toBe("IMPORTING");
    expect(calls).toEqual([]);
    const radio = listJobsForRequest(db, request.id).find((job) => job.type === "queue_radio");
    expect(JSON.parse(radio?.payload_json ?? "{}").track_ready).toBe(true);
  });

  it("falls back to copy, size check, and unlink when rename returns EXDEV", async () => {
    const { ctx, db, downloads, staging, library, cleanup } = fixture();
    cleanups.push(cleanup);
    const body = Buffer.from("cross-device-audio");
    mkdirSync(downloads, { recursive: true });
    writeFileSync(path.join(downloads, "track.mp3"), body);
    const realRename = fs.renameSync;
    vi.spyOn(fs, "renameSync").mockImplementation((src, dest) => {
      if (String(src).includes(".partial")) return realRename(src, dest);
      const error = new Error("EXDEV: cross-device link not permitted") as NodeJS.ErrnoException;
      error.code = "EXDEV";
      throw error;
    });
    const request = createRequest(db, { rawQuery: "Artist - Track" });
    advance(db, request.id, "DOWNLOAD_COMPLETE");
    await placeInLibrary(ctx, request.id, "track.mp3");
    expect(readFileSync(path.join(library, "track.mp3"))).toEqual(body);
    expect(relativeFiles(downloads)).toEqual([]);
    expect(relativeFiles(staging)).toEqual([]);
    expect(filesUnder(library).some((file) => file.includes(".partial"))).toBe(false);
    expect(filesUnder(staging).some((file) => file.includes(".partial"))).toBe(false);
  });

  it("keeps the source and removes the partial when the EXDEV copy size does not match", async () => {
    const { ctx, db, downloads, staging, library, calls, cleanup } = fixture();
    cleanups.push(cleanup);
    const body = Buffer.from("good-copy-bytes");
    mkdirSync(downloads, { recursive: true });
    writeFileSync(path.join(downloads, "track.mp3"), body);
    const realRename = fs.renameSync;
    vi.spyOn(fs, "renameSync").mockImplementation((src, dest) => {
      if (String(src).includes(".partial")) return realRename(src, dest);
      const error = new Error("EXDEV: cross-device link not permitted") as NodeJS.ErrnoException;
      error.code = "EXDEV";
      throw error;
    });
    vi.spyOn(fs, "copyFileSync").mockImplementation((_src, dest) => {
      writeFileSync(dest, Buffer.from("x"));
    });
    const request = createRequest(db, { rawQuery: "Artist - Track" });
    advance(db, request.id, "DOWNLOAD_COMPLETE");
    const job = enqueueJob(db, {
      type: "validate_file",
      requestId: request.id,
      payload: { filename: "track.mp3", size: body.length },
    });
    await expect(handleValidateFile(ctx, job)).rejects.toThrow(/move verification failed/);
    expect(getRequest(db, request.id)?.status).toBe("FAILED");
    expect(getRequest(db, request.id)?.error).toMatch(/move verification failed/);
    expect(readFileSync(path.join(downloads, "track.mp3"))).toEqual(body);
    expect(relativeFiles(staging)).toEqual([]);
    expect(relativeFiles(library)).toEqual([]);
    expect(filesUnder(staging).concat(filesUnder(library), filesUnder(downloads)).some((file) => file.includes(".partial"))).toBe(
      false,
    );
    expect(calls).toEqual([]);
    const failure = listRequestEvents(db, request.id).find((event) => event.to_status === "FAILED");
    expect(failure?.from_status).toBe("VALIDATING");
    expect(JSON.parse(failure?.payload_json ?? "{}").error).toMatch(/move verification failed/);
    expect(listJobsForRequest(db, request.id).some((row) => row.type === "import_library")).toBe(false);
    expect(listJobsForRequest(db, request.id).some((row) => row.type === "search_acquisition" || row.type === "download")).toBe(
      false,
    );
  });

  it("does not delete other downloads files or a folder that still has files", async () => {
    const { ctx, db, downloads, staging, library, cleanup } = fixture();
    cleanups.push(cleanup);
    const body = Buffer.from("the-validated-file");
    mkdirSync(path.join(downloads, "only"), { recursive: true });
    mkdirSync(path.join(downloads, "shared"), { recursive: true });
    mkdirSync(path.join(downloads, "keep"), { recursive: true });
    writeFileSync(path.join(downloads, "only", "track.mp3"), body);
    writeFileSync(path.join(downloads, "shared", "track.mp3"), Buffer.from("sibling-track"));
    writeFileSync(path.join(downloads, "shared", "leave.txt"), "leave-me");
    writeFileSync(path.join(downloads, "keep", "note.txt"), "other-folder");
    writeFileSync(path.join(downloads, "other.mp3"), Buffer.from("unrelated"));
    const request = createRequest(db, { rawQuery: "Artist - Track" });
    advance(db, request.id, "DOWNLOAD_COMPLETE");
    await placeInLibrary(ctx, request.id, path.join("only", "track.mp3"));
    expect(readFileSync(path.join(library, "only", "track.mp3"))).toEqual(body);
    expect(existsSync(path.join(downloads, "only"))).toBe(false);
    expect(readFileSync(path.join(downloads, "shared", "track.mp3"))).toEqual(Buffer.from("sibling-track"));
    expect(readFileSync(path.join(downloads, "shared", "leave.txt"), "utf8")).toBe("leave-me");
    expect(readFileSync(path.join(downloads, "keep", "note.txt"), "utf8")).toBe("other-folder");
    expect(readFileSync(path.join(downloads, "other.mp3"))).toEqual(Buffer.from("unrelated"));
    expect(relativeFiles(staging)).toEqual([]);
    expect(existsSync(downloads)).toBe(true);
  });

  it("fails instead of overwriting a library file that is already there", async () => {
    const { ctx, db, staging, library, cleanup } = fixture();
    cleanups.push(cleanup);
    mkdirSync(staging, { recursive: true });
    mkdirSync(library, { recursive: true });
    writeFileSync(path.join(staging, "track.mp3"), "incoming");
    writeFileSync(path.join(library, "track.mp3"), "already-there");
    const request = createRequest(db, { rawQuery: "Artist - Track" });
    advance(db, request.id, "VALIDATING");
    await expect(
      handleImportLibrary(
        ctx,
        enqueueJob(db, { type: "import_library", requestId: request.id, payload: { filename: "track.mp3" } }),
      ),
    ).rejects.toThrow(/library file already exists/);
    expect(getRequest(db, request.id)?.status).toBe("FAILED");
    expect(getRequest(db, request.id)?.error).toBe("library file already exists: track.mp3");
    expect(readFileSync(path.join(library, "track.mp3"), "utf8")).toBe("already-there");
    expect(readFileSync(path.join(staging, "track.mp3"), "utf8")).toBe("incoming");
  });

  it("fails validation when ffprobe is missing and leaves the download in place", async () => {
    const { ctx, db, downloads, cleanup } = fixture();
    cleanups.push(cleanup);
    setFfprobeRunner(async () => "unavailable");
    mkdirSync(downloads, { recursive: true });
    writeFileSync(path.join(downloads, "track.mp3"), "audio");
    const request = createRequest(db, { rawQuery: "Artist - Track" });
    advance(db, request.id, "DOWNLOAD_COMPLETE");
    await expect(
      handleValidateFile(
        ctx,
        enqueueJob(db, { type: "validate_file", requestId: request.id, payload: { filename: "track.mp3", size: 5 } }),
      ),
    ).rejects.toThrow(/ffprobe_unavailable/);
    expect(getRequest(db, request.id)?.error).toBe("ffprobe_unavailable");
    expect(readFileSync(path.join(downloads, "track.mp3"), "utf8")).toBe("audio");
    expect(listJobsForRequest(db, request.id).some((job) => job.type === "import_library")).toBe(false);
  });

  it("fails validation when the codec does not match the extension", async () => {
    const { ctx, db, downloads, cleanup } = fixture();
    cleanups.push(cleanup);
    setFfprobeRunner(async () => ({ codecName: "aac", formatName: "mov,mp4,m4a" }));
    mkdirSync(downloads, { recursive: true });
    writeFileSync(path.join(downloads, "track.mp3"), "audio");
    const request = createRequest(db, { rawQuery: "Artist - Track" });
    advance(db, request.id, "DOWNLOAD_COMPLETE");
    await expect(
      handleValidateFile(
        ctx,
        enqueueJob(db, { type: "validate_file", requestId: request.id, payload: { filename: "track.mp3", size: 5 } }),
      ),
    ).rejects.toThrow(/ffprobe_format_mismatch/);
    expect(readFileSync(path.join(downloads, "track.mp3"), "utf8")).toBe("audio");
  });

  it("fails validation when the probed duration is outside the selected length", async () => {
    const { ctx, db, downloads, cleanup } = fixture();
    cleanups.push(cleanup);
    setFfprobeRunner(async () => ({ codecName: "mp3", formatName: "mp3", durationSeconds: 400 }));
    mkdirSync(downloads, { recursive: true });
    writeFileSync(path.join(downloads, "track.mp3"), "audio");
    const request = createRequest(db, { rawQuery: "Artist - Track" });
    advance(db, request.id, "DOWNLOAD_COMPLETE");
    await expect(
      handleValidateFile(
        ctx,
        enqueueJob(db, {
          type: "validate_file",
          requestId: request.id,
          payload: { filename: "track.mp3", size: 5, duration_seconds: 180 },
        }),
      ),
    ).rejects.toThrow(/ffprobe_duration_mismatch/);
    expect(readFileSync(path.join(downloads, "track.mp3"), "utf8")).toBe("audio");
  });

  it("accepts a probed duration within two seconds of the selected length", async () => {
    const { ctx, db, downloads, staging, cleanup } = fixture();
    cleanups.push(cleanup);
    setFfprobeRunner(async () => ({ codecName: "mp3", formatName: "mp3", durationSeconds: 181.5 }));
    mkdirSync(downloads, { recursive: true });
    writeFileSync(path.join(downloads, "track.mp3"), "audio");
    const request = createRequest(db, { rawQuery: "Artist - Track" });
    advance(db, request.id, "DOWNLOAD_COMPLETE");
    await handleValidateFile(
      ctx,
      enqueueJob(db, {
        type: "validate_file",
        requestId: request.id,
        payload: { filename: "track.mp3", size: 5, duration_seconds: 180 },
      }),
    );
    expect(readFileSync(path.join(staging, "track.mp3"), "utf8")).toBe("audio");
    expect(existsSync(path.join(downloads, "track.mp3"))).toBe(false);
  });
});
