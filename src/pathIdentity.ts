import { realpathSync } from "node:fs";
import { normalize, resolve } from "node:path";

export function canonicalizePath(fileSystemPath: string): string {
  try {
    return realpathSync.native(fileSystemPath);
  } catch {
    return normalize(resolve(fileSystemPath));
  }
}

export function pathsIdentifySameLocation(
  firstFileSystemPath: string,
  secondFileSystemPath: string,
): boolean {
  return canonicalizePath(firstFileSystemPath) === canonicalizePath(secondFileSystemPath);
}
