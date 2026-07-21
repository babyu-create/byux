'use strict';

const MAGIC = Buffer.from('BYUXWFM1', 'ascii');
const HEADER_BYTES = 16;
const MAX_CACHE_PEAKS = 2_000_000;

function encodeWaveformCache(peaks, peaksPerSecond) {
  if (
    !(peaks instanceof Float32Array) ||
    peaks.length < 1 ||
    peaks.length > MAX_CACHE_PEAKS ||
    !Number.isInteger(peaksPerSecond) ||
    peaksPerSecond < 1 ||
    peaksPerSecond > 1_000
  ) {
    throw new Error('波形キャッシュデータが不正です');
  }
  const buffer = Buffer.allocUnsafe(HEADER_BYTES + peaks.length * 4);
  MAGIC.copy(buffer, 0);
  buffer.writeUInt32LE(peaksPerSecond, 8);
  buffer.writeUInt32LE(peaks.length, 12);
  for (let index = 0; index < peaks.length; index++) {
    const value = peaks[index];
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw new Error('波形キャッシュデータが不正です');
    }
    buffer.writeFloatLE(value, HEADER_BYTES + index * 4);
  }
  return buffer;
}

function decodeWaveformCache(bytes) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (buffer.length < HEADER_BYTES || !buffer.subarray(0, 8).equals(MAGIC)) return null;
  const peaksPerSecond = buffer.readUInt32LE(8);
  const count = buffer.readUInt32LE(12);
  if (
    peaksPerSecond < 1 ||
    peaksPerSecond > 1_000 ||
    count < 1 ||
    count > MAX_CACHE_PEAKS ||
    buffer.length !== HEADER_BYTES + count * 4
  ) return null;
  const peaks = new Float32Array(count);
  for (let index = 0; index < count; index++) {
    const value = buffer.readFloatLE(HEADER_BYTES + index * 4);
    if (!Number.isFinite(value) || value < 0 || value > 1) return null;
    peaks[index] = value;
  }
  return { peaks, peaksPerSecond };
}

module.exports = { HEADER_BYTES, MAX_CACHE_PEAKS, encodeWaveformCache, decodeWaveformCache };
