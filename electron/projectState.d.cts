export function canonicalProject(text: string): string | null;

export function maxAutosaveEnvelopeBytes(maxProjectTextBytes: number): number;

export function projectWriteError(
  error: { code?: string } | null | undefined,
  fallback?: string,
): string;

export function shouldClearRecovery(
  recovery: { version: number; generation?: string; text: string } | null,
  savedText: string,
  autosaveGeneration: string | null,
): boolean;
