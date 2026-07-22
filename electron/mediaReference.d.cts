export function canonicalMediaName(filePath: unknown): string | null;

export interface RegisteredMediaSource {
  leases?: number;
  releaseRequested?: boolean;
}

export function revokeMediaRegistrations<T extends RegisteredMediaSource>(
  registry: Map<string, T>,
): { removed: number; deferred: number };
