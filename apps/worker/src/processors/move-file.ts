import fs from "node:fs";
import path from "node:path";
import { assertInsideRoot } from "@subwave-ai/shared";

export type MoveFileOptions = {
  source: string;
  destination: string;
  /** Transfer size, when the acquisition payload has one. */
  expectedBytes?: number;
};

function isExdev(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && (err as { code?: unknown }).code === "EXDEV");
}

function fsyncFile(filePath: string): void {
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, "r+");
    fs.fsyncSync(fd);
  } catch {
    // Some filesystems cannot fsync. Size verification still runs.
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // The fd is best-effort.
      }
    }
  }
}

function fsyncDirectory(dir: string): void {
  let fd: number | undefined;
  try {
    fd = fs.openSync(dir, "r");
    fs.fsyncSync(fd);
  } catch {
    // Directory fsync is not available on every platform.
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // The fd is best-effort.
      }
    }
  }
}

function removeIfExists(filePath: string): void {
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {
    // Keep going. The source file is still the good copy.
  }
}

function partialPath(destination: string): string {
  const dir = path.dirname(destination);
  const base = path.basename(destination);
  const unique = `${process.pid}.${Date.now().toString(36)}.${Math.random().toString(16).slice(2)}`;
  return path.join(dir, `.${base}.${unique}.partial`);
}

/**
 * Move one file. Same-filesystem uses rename. EXDEV copies to a temp name in the
 * destination directory, checks the byte size, renames that temp into place, then
 * unlinks the source. A failed check deletes the temp and leaves the source.
 */
export function moveFileSync(options: MoveFileOptions): void {
  const source = options.source;
  const destination = options.destination;
  const sourceStat = fs.statSync(source);
  if (!sourceStat.isFile()) {
    throw new Error(`move source is not a file: ${path.basename(source)}`);
  }
  if (fs.existsSync(destination)) {
    throw new Error(`destination already exists: ${path.basename(destination)}`);
  }
  if (options.expectedBytes !== undefined && sourceStat.size !== options.expectedBytes) {
    throw new Error(
      `size mismatch: source ${sourceStat.size} bytes, expected ${options.expectedBytes}`,
    );
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  try {
    fs.renameSync(source, destination);
    return;
  } catch (err) {
    if (!isExdev(err)) throw err;
  }

  const temp = partialPath(destination);
  try {
    fs.copyFileSync(source, temp);
    fsyncFile(temp);
    const copied = fs.statSync(temp).size;
    const expected = options.expectedBytes;
    if (copied !== sourceStat.size || (expected !== undefined && copied !== expected)) {
      const expectedNote = expected !== undefined ? `, expected ${expected}` : "";
      throw new Error(
        `move verification failed: destination ${copied} bytes, source ${sourceStat.size} bytes${expectedNote}`,
      );
    }
    if (fs.existsSync(destination)) {
      throw new Error(`destination already exists: ${path.basename(destination)}`);
    }
    fs.renameSync(temp, destination);
    fsyncDirectory(path.dirname(destination));
    fs.unlinkSync(source);
  } catch (err) {
    removeIfExists(temp);
    throw err;
  }
}

/**
 * Remove a now-empty directory that held the moved file.
 * Never removes `root` itself and never walks upward or deletes recursively.
 */
export function removeEmptyChildDirectory(root: string, sourceFile: string): void {
  const parent = path.dirname(path.resolve(sourceFile));
  const resolvedRoot = path.resolve(root);
  if (parent === resolvedRoot) return;
  let checked: string;
  try {
    checked = assertInsideRoot(resolvedRoot, parent);
  } catch {
    return;
  }
  if (checked === resolvedRoot) return;
  let entries: string[];
  try {
    entries = fs.readdirSync(checked);
  } catch {
    return;
  }
  if (entries.length !== 0) return;
  try {
    fs.rmdirSync(checked);
  } catch {
    // Not empty, or not removable. Leave it.
  }
}
