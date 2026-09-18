import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(process.cwd());

function read(rel: string): string {
  return readFileSync(path.join(ROOT, rel), "utf8");
}

describe("ops scripts", () => {
  const scripts = ["install.sh", "update.sh", "uninstall.sh", "backup.sh", "restore.sh", "doctor.sh"];

  it("are present, executable, and refuse to manage Ollama", () => {
    for (const name of scripts) {
      const full = path.join(ROOT, name);
      expect(statSync(full).mode & 0o100, name).toBeTruthy();
      const body = read(name);
      expect(body.startsWith("#!/usr/bin/env bash")).toBe(true);
      expect(body).toMatch(/Ollama/i);
      expect(body.toLowerCase()).not.toMatch(/apt(?:-get)? install[^\n]*ollama/);
      expect(body.toLowerCase()).not.toMatch(/dnf install[^\n]*ollama/);
      expect(body).not.toMatch(/ollama pull/i);
      expect(body.toLowerCase()).not.toMatch(/oci compute|oracle-cloud-agent|terraform apply/);
    }
  });

  it("keeps the clone → install.sh story and compose host mounts", () => {
    const install = read("install.sh");
    expect(install).toMatch(/git clone <repo-url> subwave-ai/);
    expect(install).toMatch(/cd subwave-ai/);
    expect(install).toMatch(/sudo \.\/install\.sh/);
    expect(install).toMatch(/never install/i);
    const compose = read("deploy/docker-compose.yml");
    expect(compose).toMatch(/SUBWAVE_LIBRARY_DIR/);
    expect(compose).toMatch(/SUBWAVE_DATA_DIR/);
    expect(compose).not.toMatch(/image:\s*ollama/i);
    expect(compose).not.toMatch(/services:\s*\n\s*ollama/i);
  });
});
