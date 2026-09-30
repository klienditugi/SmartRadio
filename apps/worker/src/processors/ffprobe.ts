import { spawn } from "node:child_process";

/** Probed duration may differ from the search `length` by at most this many seconds. */
export const FFPROBE_DURATION_TOLERANCE_SECONDS = 2;

export type ProbeInfo = {
  codecName?: string;
  formatName?: string;
  durationSeconds?: number;
};

export type ProbeResult = ProbeInfo | "unavailable" | "failed";

export type FfprobeRunner = (ffprobePath: string, filePath: string) => Promise<ProbeResult>;

const EXT_RULES: Record<string, { codec: (name: string) => boolean; formats: string[] }> = {
  ".mp3": { codec: (name) => name === "mp3", formats: ["mp3"] },
  ".flac": { codec: (name) => name === "flac", formats: ["flac"] },
  ".ogg": { codec: (name) => name === "vorbis" || name === "opus", formats: ["ogg"] },
  ".m4a": { codec: (name) => name === "aac" || name === "alac", formats: ["mov", "mp4", "m4a", "3gp", "3g2", "mj2"] },
  ".wav": { codec: (name) => name === "pcm" || name.startsWith("pcm_"), formats: ["wav"] },
};

export function probeMatchesExtension(filename: string, info: ProbeInfo): boolean {
  const dot = filename.lastIndexOf(".");
  const ext = dot >= 0 ? filename.slice(dot).toLowerCase() : "";
  const rule = EXT_RULES[ext];
  if (!rule) return false;
  const codec = info.codecName?.trim().toLowerCase();
  if (!codec || !rule.codec(codec)) return false;
  const tokens = (info.formatName ?? "")
    .toLowerCase()
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  return tokens.some((token) => rule.formats.includes(token));
}

function defaultRunner(ffprobePath: string, filePath: string): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const child = spawn(
      ffprobePath,
      ["-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", filePath],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.on("error", (err: NodeJS.ErrnoException) => {
      resolve(err.code === "ENOENT" ? "unavailable" : "failed");
    });
    child.on("close", (code) => {
      if (code !== 0) {
        resolve("failed");
        return;
      }
      resolve(parseProbe(stdout));
    });
  });
}

function parseProbe(stdout: string): ProbeResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return "failed";
  }
  if (!parsed || typeof parsed !== "object") return "failed";
  const record = parsed as { format?: unknown; streams?: unknown };
  const format = record.format && typeof record.format === "object" ? (record.format as Record<string, unknown>) : {};
  const streams = Array.isArray(record.streams) ? record.streams : [];
  const audio = streams.find(
    (stream) => stream && typeof stream === "object" && (stream as { codec_type?: unknown }).codec_type === "audio",
  ) as { codec_name?: unknown } | undefined;
  const codecName = typeof audio?.codec_name === "string" ? audio.codec_name : undefined;
  const formatName = typeof format.format_name === "string" ? format.format_name : undefined;
  const rawDuration = format.duration;
  const durationSeconds =
    typeof rawDuration === "number"
      ? rawDuration
      : typeof rawDuration === "string" && rawDuration.trim() && Number.isFinite(Number(rawDuration))
        ? Number(rawDuration)
        : undefined;
  if (!codecName && !formatName) return "failed";
  return {
    ...(codecName ? { codecName } : {}),
    ...(formatName ? { formatName } : {}),
    ...(durationSeconds !== undefined ? { durationSeconds } : {}),
  };
}

let runner: FfprobeRunner = defaultRunner;

/** Tests replace the binary. Pass undefined to restore the real ffprobe spawn. */
export function setFfprobeRunner(next: FfprobeRunner | undefined): void {
  runner = next ?? defaultRunner;
}

export function runFfprobe(ffprobePath: string, filePath: string): Promise<ProbeResult> {
  return runner(ffprobePath, filePath);
}
