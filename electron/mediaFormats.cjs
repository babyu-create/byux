const path = require('node:path')

const VIDEO_EXTENSION_LIST = Object.freeze([
  '.mp4', '.m4v', '.mov', '.qt', '.mkv', '.webm', '.avi', '.wmv', '.asf',
  '.flv', '.f4v', '.ts', '.mts', '.m2ts', '.m2t', '.mpg', '.mpeg', '.mpe',
  '.vob', '.ogv', '.3gp', '.3g2', '.mxf',
])

const AUDIO_EXTENSION_LIST = Object.freeze([
  '.mp3', '.wav', '.wave', '.ogg', '.oga', '.opus', '.m4a', '.aac', '.flac',
  '.wma', '.aiff', '.aif', '.ac3', '.eac3', '.amr',
])

const VIDEO_EXTENSIONS = new Set(VIDEO_EXTENSION_LIST)
const AUDIO_EXTENSIONS = new Set(AUDIO_EXTENSION_LIST)

function mediaExtensionMatchesKind(filePath, kind) {
  const ext = path.extname(filePath).toLowerCase()
  return kind === 'video' ? VIDEO_EXTENSIONS.has(ext) : AUDIO_EXTENSIONS.has(ext)
}

function mediaKindForPath(filePath) {
  const ext = path.extname(filePath).toLowerCase()
  if (VIDEO_EXTENSIONS.has(ext)) return 'video'
  if (AUDIO_EXTENSIONS.has(ext)) return 'audio'
  return null
}

module.exports = {
  VIDEO_EXTENSION_LIST,
  AUDIO_EXTENSION_LIST,
  VIDEO_EXTENSIONS,
  AUDIO_EXTENSIONS,
  mediaExtensionMatchesKind,
  mediaKindForPath,
}
