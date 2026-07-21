import type { ChildProcess } from 'node:child_process';

export const MAX_CAPTURE_BYTES: number;

export function resolveFfmpegBinary(
  isPackaged: boolean,
  resourcesPath: string,
  appRoot: string,
): string;

export function minimalEnvironment(): Record<string, string>;
export function appendTail(current: string, chunk: Uint8Array, maxBytes?: number): string;
export function runCaptured(
  binaryPath: string,
  args: string[],
  options?: {
    timeoutMs?: number;
    cwd?: string;
    onSpawn?: (child: ChildProcess) => void;
  },
): Promise<{
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}>;
export function verifyFfmpegBinary(binaryPath: string): Promise<boolean>;
export function probeInputHasAudio(binaryPath: string, sourcePath: string): Promise<boolean>;
export function parseInputMediaStreams(stderr: string): {
  hasVideo: boolean;
  hasAudio: boolean;
  kind: 'video' | 'audio' | null;
};
export function probeInputMediaKind(
  binaryPath: string,
  sourcePath: string,
): Promise<'video' | 'audio' | null>;
export function validateOutput(
  binaryPath: string,
  outputPath: string,
  expected: { width: number; height: number; duration: number; maxBytes?: number },
): Promise<{ size: number; duration: number }>;
export function terminateProcess(child: ChildProcess, graceMs?: number): Promise<void>;
