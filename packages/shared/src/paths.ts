import path from "node:path";

export class PathTraversalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PathTraversalError";
  }
}

function assertNoNul(input: string): void {
  if (input.includes("\0")) {
    throw new PathTraversalError("path contains a NUL byte");
  }
}

/** Resolve `target` and require it to stay inside `root`. */
export function assertInsideRoot(root: string, target: string): string {
  assertNoNul(root);
  assertNoNul(target);
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  const prefix = resolvedRoot.endsWith(path.sep) ? resolvedRoot : resolvedRoot + path.sep;
  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(prefix)) {
    throw new PathTraversalError(`path escapes root: ${target}`);
  }
  return resolvedTarget;
}

/** Join segments onto `root` with path-traversal protection. */
export function safeJoin(root: string, ...segments: string[]): string {
  assertNoNul(root);
  for (const segment of segments) {
    assertNoNul(segment);
    if (path.isAbsolute(segment)) {
      throw new PathTraversalError("absolute path segments are not allowed");
    }
  }
  const joined = path.resolve(root, ...segments);
  return assertInsideRoot(root, joined);
}

export function isAllowedAudioExtension(filename: string, allowed: readonly string[]): boolean {
  const ext = path.extname(filename).toLowerCase();
  return allowed.some((item) => item.toLowerCase() === ext);
}
