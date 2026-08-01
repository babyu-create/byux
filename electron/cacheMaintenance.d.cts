export function clearOwnedCacheFiles(
  root: string,
  pattern: RegExp,
  protectedPaths?: string[],
): Promise<{ files: number; bytes: number; protectedFiles: number }>;
