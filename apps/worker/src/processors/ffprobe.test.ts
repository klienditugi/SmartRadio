import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const spawn = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  spawn,
}));

import { runFfprobe, setFfprobeRunner } from "./ffprobe.js";

function fakeChild(): EventEmitter & { stdout: EventEmitter & { setEncoding: () => void }; stderr: EventEmitter } {
  const stdout = new EventEmitter() as EventEmitter & { setEncoding: () => void };
  stdout.setEncoding = () => {};
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter & { setEncoding: () => void };
    stderr: EventEmitter;
  };
  child.stdout = stdout;
  child.stderr = new EventEmitter();
  return child;
}

describe("ffprobe arguments", () => {
  beforeEach(() => {
    spawn.mockReset();
    setFfprobeRunner(undefined);
  });

  it("passes an apostrophe filename as one argv entry and does not use a shell", async () => {
    const file = "Adam Beyer - Don't Go (Original Mix).mp3";
    spawn.mockImplementation(() => {
      const child = fakeChild();
      queueMicrotask(() => {
        child.stdout.emit(
          "data",
          JSON.stringify({
            streams: [{ codec_type: "audio", codec_name: "mp3" }],
            format: { format_name: "mp3", duration: "200" },
          }),
        );
        child.emit("close", 0);
      });
      return child;
    });

    const result = await runFfprobe("ffprobe", file);

    expect(result).toMatchObject({ codecName: "mp3", formatName: "mp3", durationSeconds: 200 });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0]?.[0]).toBe("ffprobe");
    expect(spawn.mock.calls[0]?.[1]).toEqual([
      "-v",
      "quiet",
      "-print_format",
      "json",
      "-show_format",
      "-show_streams",
      file,
    ]);
    expect(spawn.mock.calls[0]?.[2]).toMatchObject({ shell: false });
    expect(typeof spawn.mock.calls[0]?.[0]).toBe("string");
  });
});
