const WAVEFORM_SAMPLE_RATE = 48_000
const WAVEFORM_PEAKS_PER_SECOND = 20
const SAMPLES_PER_PEAK = WAVEFORM_SAMPLE_RATE / WAVEFORM_PEAKS_PER_SECOND
const MAX_WAVEFORM_PEAKS = 2_000_000
const MAX_METADATA_LINE_BYTES = 64 * 1024
const PEAK_METADATA_PREFIX = 'lavfi.astats.Overall.Peak_level='

function waveformLimitError() {
  return Object.assign(new Error('音声が長すぎて波形を生成できません'), {
    code: 'WAVEFORM_TOO_LONG',
  })
}

function peakGainFromMetadata(value) {
  const normalized = value.trim().toLowerCase()
  if (normalized === '-inf' || normalized === '-infinity') return 0
  const decibels = Number(value)
  if (!Number.isFinite(decibels)) return 0
  return Math.min(1, Math.max(0, 10 ** (decibels / 20)))
}

/**
 * Parse FFmpeg ametadata output incrementally. FFmpeg performs 48 kHz peak
 * analysis internally, so high-frequency gunshots/music are not lost to a
 * low-rate resampler; only one small dB value per 50 ms crosses the pipe.
 */
function createWaveformMetadataAccumulator(options = {}) {
  const maxPeaks = options.maxPeaks ?? MAX_WAVEFORM_PEAKS
  if (!Number.isInteger(maxPeaks) || maxPeaks <= 0) {
    throw new TypeError('maxPeaks must be a positive integer')
  }

  const peaks = []
  let leftover = ''
  let finished = false
  let finishedPeaks = null

  const consumeLine = (line) => {
    if (!line.startsWith(PEAK_METADATA_PREFIX)) return
    if (peaks.length >= maxPeaks) throw waveformLimitError()
    peaks.push(peakGainFromMetadata(line.slice(PEAK_METADATA_PREFIX.length)))
  }

  const push = (chunk) => {
    if (finished) throw new Error('waveform accumulator is already finished')
    const incoming = typeof chunk === 'string'
      ? chunk
      : Buffer.from(chunk).toString('utf8')
    const text = leftover + incoming
    const lines = text.split(/\r?\n/)
    leftover = lines.pop() ?? ''
    if (Buffer.byteLength(leftover, 'utf8') > MAX_METADATA_LINE_BYTES) {
      throw new Error('波形解析データが不正です')
    }
    for (const line of lines) consumeLine(line)
  }

  const finish = () => {
    if (finishedPeaks) return finishedPeaks
    if (leftover) consumeLine(leftover)
    leftover = ''
    finished = true
    finishedPeaks = Float32Array.from(peaks)
    return finishedPeaks
  }

  return {
    push,
    finish,
    get peakCount() {
      return peaks.length
    },
  }
}

function buildWaveformFfmpegArgs(sourcePath) {
  const analysisFilter = [
    `aresample=${WAVEFORM_SAMPLE_RATE}`,
    `asetnsamples=n=${SAMPLES_PER_PEAK}:p=1`,
    'astats=metadata=1:reset=1',
    `ametadata=print:key=lavfi.astats.Overall.Peak_level:file=-`,
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
    '0:a:0',
    '-vn',
    '-af',
    analysisFilter,
    '-f',
    'null',
    '-',
  ]
}

module.exports = {
  WAVEFORM_SAMPLE_RATE,
  WAVEFORM_PEAKS_PER_SECOND,
  MAX_WAVEFORM_PEAKS,
  createWaveformMetadataAccumulator,
  buildWaveformFfmpegArgs,
}
