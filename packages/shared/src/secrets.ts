import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync, writeSync } from "node:fs";
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
  /**
   * HMAC key for stored test-connection fingerprints. Not the session secret:
   * rotating sessions must not force every integration to be re-verified.
   * Raw 32 bytes, mode 600. Never returned by the API.
   */
  verificationHmacKey: "verification_hmac_key",
} as const;

export type LoadedSecrets = {
  adminPassword?: string;
  sessionSecret?: string;
  navidromePassword?: string;
  subwaveAdminPassword?: string;
  slskdApiKey?: string;
  /** Exactly 32 bytes when `secrets/verification_hmac_key` is usable. */
  verificationHmacKey?: Buffer;
};

/** Create `verification_hmac_key` on first use. Does not replace an existing file. */
export function ensureVerificationHmacKey(secretsDir: string): void {
  mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
  const full = path.resolve(secretsDir, SECRET_FILES.verificationHmacKey);
  if (!existsSync(full)) {
    const bytes = randomBytes(32);
    let fd: number | undefined;
    try {
      fd = openSync(full, "wx", 0o600);
      writeSync(fd, bytes);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  try {
    chmodSync(full, 0o600);
  } catch {
    // A read-only secrets dir still fails closed if the key cannot be read.
  }
}

export function readVerificationHmacKey(secretsDir: string): Buffer | undefined {
  const full = path.resolve(secretsDir, SECRET_FILES.verificationHmacKey);
  if (!existsSync(full)) return undefined;
  const bytes = readFileSync(full);
  if (bytes.length !== 32) return undefined;
  return bytes;
}

export function loadSecrets(secretsDir: string): LoadedSecrets {
  ensureVerificationHmacKey(secretsDir);
  return {
    adminPassword: readSecretFile(secretsDir, SECRET_FILES.adminPassword),
    sessionSecret: readSecretFile(secretsDir, SECRET_FILES.sessionSecret),
    navidromePassword: readSecretFile(secretsDir, SECRET_FILES.navidromePassword),
    subwaveAdminPassword: readSecretFile(secretsDir, SECRET_FILES.subwaveAdminPassword),
    slskdApiKey: readSecretFile(secretsDir, SECRET_FILES.slskdApiKey),
    verificationHmacKey: readVerificationHmacKey(secretsDir),
  };
}

const SECRET_FILE_NAMES = new Set<string>(
  Object.values(SECRET_FILES).filter((name) => name !== SECRET_FILES.verificationHmacKey),
);

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
