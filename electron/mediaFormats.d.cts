export const VIDEO_EXTENSION_LIST: readonly string[];
export const AUDIO_EXTENSION_LIST: readonly string[];
export const VIDEO_EXTENSIONS: ReadonlySet<string>;
export const AUDIO_EXTENSIONS: ReadonlySet<string>;
export function mediaExtensionMatchesKind(
  filePath: string,
  kind: 'video' | 'audio',
): boolean;
export function mediaKindForPath(
  filePath: string,
): 'video' | 'audio' | null;
