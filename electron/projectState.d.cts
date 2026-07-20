export function canonicalProject(text: string): string | null;

export function shouldClearRecovery(
  recovery: { version: number; generation?: string; text: string } | null,
  savedText: string,
  autosaveGeneration: string | null,
): boolean;
