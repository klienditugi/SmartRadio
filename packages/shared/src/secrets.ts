import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export function readSecretFile(secretsDir: string, name: string): string | undefined {
  if (!name || name.includes("..") || name.includes("/") || name.includes("\\") || name.includes("\0")) {
    throw new Error("invalid secret file name");
  }
  const full = path.resolve(secretsDir, name);
  const root = path.resolve(secretsDir);
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  if (full !== root && !full.startsWith(prefix)) {
    throw new Error("secret path escapes secrets dir");
  }
  if (!existsSync(full)) return undefined;
  return readFileSync(full, "utf8").trim() || undefined;
}

export const SECRET_FILES = {
  adminPassword: "admin_password",
  sessionSecret: "session_secret",
  navidromePassword: "navidrome_password",
  subwaveAdminPassword: "subwave_admin_password",
  slskdApiKey: "slskd_api_key",
} as const;

export type LoadedSecrets = {
  adminPassword?: string;
  sessionSecret?: string;
  navidromePassword?: string;
  subwaveAdminPassword?: string;
  slskdApiKey?: string;
};

export function loadSecrets(secretsDir: string): LoadedSecrets {
  return {
    adminPassword: readSecretFile(secretsDir, SECRET_FILES.adminPassword),
    sessionSecret: readSecretFile(secretsDir, SECRET_FILES.sessionSecret),
    navidromePassword: readSecretFile(secretsDir, SECRET_FILES.navidromePassword),
    subwaveAdminPassword: readSecretFile(secretsDir, SECRET_FILES.subwaveAdminPassword),
    slskdApiKey: readSecretFile(secretsDir, SECRET_FILES.slskdApiKey),
  };
}

const SECRET_FILE_NAMES = new Set<string>(Object.values(SECRET_FILES));

export function writeSecretFile(secretsDir: string, name: string, value: string): void {
  if (!name || name.includes("..") || name.includes("/") || name.includes("\\") || name.includes("\0")) {
    throw new Error("invalid secret file name");
  }
  if (!SECRET_FILE_NAMES.has(name)) {
    throw new Error(`refusing to write unknown secret file: ${name}`);
  }
  const full = path.resolve(secretsDir, name);
  const root = path.resolve(secretsDir);
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  if (full !== root && !full.startsWith(prefix)) {
    throw new Error("secret path escapes secrets dir");
  }
  mkdirSync(root, { recursive: true, mode: 0o700 });
  writeFileSync(full, `${value.trim()}\n`, { encoding: "utf8", mode: 0o600 });
}
