'use strict'

const BEAT_SAMPLE_RATE = 48_000
const BEAT_WINDOW_SECONDS = 0.05
const SAMPLES_PER_BEAT_WINDOW = Math.round(BEAT_SAMPLE_RATE * BEAT_WINDOW_SECONDS)
const DEFAULT_BEAT_THRESHOLD = 1.45
const DEFAULT_MIN_SEPARATION_SECONDS = 0.18
const DEFAULT_LOOKBACK_SECONDS = 1
// About nine hours even at a dense 180 BPM. Higher counts make timeline snap
// searches and project serialization expensive despite the streaming parser.
const MAX_BEAT_COUNT = 100_000
const MAX_BEAT_WINDOWS = 7 * 24 * 60 * 60 / BEAT_WINDOW_SECONDS
const MAX_METADATA_LINE_BYTES = 64 * 1024
const RMS_METADATA_PREFIX = 'lavfi.astats.Overall.RMS_level='

function beatLimitError(message = 'ビートが多すぎるため解析できません') {
  return Object.assign(new Error(message), { code: 'BEAT_ANALYSIS_TOO_LARGE' })
}

function energyFromRmsMetadata(value) {
  const normalized = value.trim().toLowerCase()
  if (normalized === '-inf' || normalized === '-infinity') return 0
  const decibels = Number(value)
  if (!Number.isFinite(decibels)) return 0
  // RMS dB uses an amplitude ratio. Squaring it reproduces the mean-square
  // energy used by the renderer's legacy Web Audio detector.
  return Math.max(0, 10 ** (decibels / 10))
}

/** Incrementally detect onsets from one FFmpeg RMS value per 50 ms window. */
function createBeatMetadataAccumulator(options = {}) {
  const windowSeconds = options.windowSeconds ?? BEAT_WINDOW_SECONDS
  const threshold = options.threshold ?? DEFAULT_BEAT_THRESHOLD
  const minSeparationSeconds = options.minSeparationSeconds ?? DEFAULT_MIN_SEPARATION_SECONDS
  const lookbackWindows = Math.max(
    4,
    Math.floor((options.lookbackSeconds ?? DEFAULT_LOOKBACK_SECONDS) / windowSeconds),
  )
  const maxBeats = options.maxBeats ?? MAX_BEAT_COUNT
  const maxWindows = options.maxWindows ?? MAX_BEAT_WINDOWS
  if (!Number.isFinite(windowSeconds) || windowSeconds <= 0 || windowSeconds > 1) {
    throw new TypeError('windowSeconds must be between 0 and 1')
  }
  if (!Number.isFinite(threshold) || threshold <= 1) {
    throw new TypeError('threshold must be greater than 1')
  }
  if (!Number.isFinite(minSeparationSeconds) || minSeparationSeconds < 0) {
    throw new TypeError('minSeparationSeconds must be non-negative')
  }
  if (!Number.isSafeInteger(maxBeats) || maxBeats <= 0 ||
      !Number.isSafeInteger(maxWindows) || maxWindows <= 0) {
    throw new TypeError('analysis limits must be positive integers')
  }

  const history = new Float64Array(lookbackWindows)
  const beats = []
  let historyCount = 0
  let historyIndex = 0
  let historySum = 0
  let windowCount = 0
  let lastBeat = -Infinity
  let leftover = ''
  let finished = false

  const consumeEnergy = (energy) => {
    if (windowCount >= maxWindows) {
      throw beatLimitError('音声が長すぎてビートを解析できません')
    }
    if (historyCount < lookbackWindows) {
      history[historyCount] = energy
      historyCount += 1
      historySum += energy
    } else {
      const average = historySum / lookbackWindows
      const time = windowCount * windowSeconds
      if (average > 0 && energy > average * threshold &&
          time - lastBeat >= minSeparationSeconds) {
        if (beats.length >= maxBeats) throw beatLimitError()
        beats.push(time)
        lastBeat = time
      }
      historySum += energy - history[historyIndex]
      history[historyIndex] = energy
      historyIndex = (historyIndex + 1) % lookbackWindows
    }
    windowCount += 1
  }

  const consumeLine = (line) => {
    if (!line.startsWith(RMS_METADATA_PREFIX)) return
    consumeEnergy(energyFromRmsMetadata(line.slice(RMS_METADATA_PREFIX.length)))
  }

  const push = (chunk) => {
    if (finished) throw new Error('beat accumulator is already finished')
    const incoming = typeof chunk === 'string'
      ? chunk
      : Buffer.from(chunk).toString('utf8')
    const lines = (leftover + incoming).split(/\r?\n/)
    leftover = lines.pop() ?? ''
    if (Buffer.byteLength(leftover, 'utf8') > MAX_METADATA_LINE_BYTES) {
      throw new Error('ビート解析データが不正です')
    }
    for (const line of lines) consumeLine(line)
  }

  const finish = () => {
    if (finished) return beats
    if (leftover) consumeLine(leftover)
    leftover = ''
    finished = true
    return beats
  }

  return {
    push,
    finish,
    get beatCount() { return beats.length },
    get windowCount() { return windowCount },
    get retainedEnergyCount() { return historyCount },
  }
}

function buildBeatFfmpegArgs(sourcePath, audioStreamIndex = 0) {
  if (!Number.isSafeInteger(audioStreamIndex) || audioStreamIndex < 0 || audioStreamIndex > 127) {
    throw new Error('Audio stream index is invalid')
  }
  const analysisFilter = [
    `aresample=${BEAT_SAMPLE_RATE}`,
    `asetnsamples=n=${SAMPLES_PER_BEAT_WINDOW}:p=1`,
    'astats=metadata=1:reset=1',
    `ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-`,
  ].join(',')
  return [
    '-hide_banner',
    '-nostdin',
    '-nostats',
    '-loglevel',
    'error',
    '-protocol_whitelist',
    'file,pipe',
    '-i',
    sourcePath,
    '-map',
    `0:a:${audioStreamIndex}`,
    '-vn',
    '-sn',
    '-dn',
    '-af',
    analysisFilter,
    '-f',
    'null',
    '-',
  ]
}

module.exports = {
  BEAT_SAMPLE_RATE,
  BEAT_WINDOW_SECONDS,
  MAX_BEAT_COUNT,
  MAX_BEAT_WINDOWS,
  createBeatMetadataAccumulator,
  buildBeatFfmpegArgs,
}
