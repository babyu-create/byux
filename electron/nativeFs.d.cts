export interface RenameRetryOptions {
  rename?: (source: string, target: string) => Promise<void>;
  attempts?: number;
  delayMs?: number;
  shouldAbort?: () => boolean;
}

export function renameWithRetry(
  source: string,
  target: string,
  options?: RenameRetryOptions,
): Promise<void>;

export interface SyncFileOptions {
  open?: (
    path: string,
    flags: 'r+',
  ) => Promise<{ sync(): Promise<void>; close(): Promise<void> }>;
  attempts?: number;
  delayMs?: number;
  shouldAbort?: () => boolean;
}

export function syncFileForCommit(
  path: string,
  options?: SyncFileOptions,
): Promise<void>;
