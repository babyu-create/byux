'use strict';

const MAX_SUBTITLE_CUES = 10_000;
const MAX_SUBTITLE_TEXT_LENGTH = 2_000;

function assColor(value, fallback, forcedAlpha) {
  const input = String(value ?? '').trim();
  const short = /^#([0-9a-f]{3})$/i.exec(input);
  const long = /^#([0-9a-f]{6})$/i.exec(input);
  const rgba = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(?:\s*,\s*(0|1|0?\.\d+))?\s*\)$/i.exec(input);
  let red;
  let green;
  let blue;
  let alpha = forcedAlpha ?? 0;
  if (short) {
    red = parseInt(short[1][0] + short[1][0], 16);
    green = parseInt(short[1][1] + short[1][1], 16);
    blue = parseInt(short[1][2] + short[1][2], 16);
  } else if (long) {
    red = parseInt(long[1].slice(0, 2), 16);
    green = parseInt(long[1].slice(2, 4), 16);
    blue = parseInt(long[1].slice(4, 6), 16);
  } else if (rgba) {
    red = Math.min(255, Number(rgba[1]));
    green = Math.min(255, Number(rgba[2]));
    blue = Math.min(255, Number(rgba[3]));
    if (forcedAlpha === undefined && rgba[4] !== undefined) {
      alpha = 255 - Math.round(Number(rgba[4]) * 255);
    }
  } else if (input === 'transparent') {
    red = green = blue = 0;
    alpha = 255;
  } else {
    return fallback;
  }
  const hex = (number) => Math.max(0, Math.min(255, number)).toString(16).padStart(2, '0').toUpperCase();
  return `&H${hex(alpha)}${hex(blue)}${hex(green)}${hex(red)}`;
}

function assTime(seconds) {
  const centiseconds = Math.max(0, Math.round(Number(seconds) * 100));
  const hours = Math.floor(centiseconds / 360000);
  const minutes = Math.floor(centiseconds / 6000) % 60;
  const secs = Math.floor(centiseconds / 100) % 60;
  const cs = centiseconds % 100;
  return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

function assText(value) {
  return String(value)
    .slice(0, MAX_SUBTITLE_TEXT_LENGTH)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\\/g, '＼')
    .replace(/\{/g, '｛')
    .replace(/\}/g, '｝')
    .replace(/\r\n?|\n/g, '\\N');
}

function buildAssSubtitles(cues, style, width, height) {
  if (!Array.isArray(cues) || cues.length > MAX_SUBTITLE_CUES) {
    throw new Error('字幕数が不正です');
  }
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) {
    throw new Error('字幕の解像度が不正です');
  }
  const safeStyle = style && typeof style === 'object' ? style : {};
  const fontSizePercent = Number(safeStyle.fontSize ?? 5.2);
  if (!Number.isFinite(fontSizePercent) || fontSizePercent < 2 || fontSizePercent > 12) {
    throw new Error('字幕サイズが不正です');
  }
  const position = safeStyle.position ?? 'bottom';
  if (!['top', 'center', 'bottom'].includes(position)) throw new Error('字幕位置が不正です');
  const primary = assColor(safeStyle.color, '&H00FFFFFF');
  const outline = assColor(safeStyle.outlineColor, '&H00000000');
  const background = assColor(safeStyle.background, '&HFF000000');
  const hasBackground = String(safeStyle.background ?? 'transparent') !== 'transparent';
  const alignment = position === 'top' ? 8 : position === 'center' ? 5 : 2;
  const fontSize = Math.max(12, Math.round(height * fontSizePercent / 100));
  const marginV = Math.max(8, Math.round(height * 0.07));
  const marginH = Math.max(8, Math.round(width * 0.05));
  const borderStyle = hasBackground ? 3 : 1;
  const outlineWidth = hasBackground ? Math.max(3, Math.round(fontSize * 0.18)) : Math.max(1, Math.round(fontSize * 0.075));
  const outlineColor = hasBackground ? background : outline;
  const events = [];
  for (const cue of cues) {
    const start = Number(cue?.start);
    const end = Number(cue?.end);
    const text = assText(cue?.text ?? '');
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || !text.trim()) {
      throw new Error('字幕の時刻または本文が不正です');
    }
    events.push(`Dialogue: 0,${assTime(start)},${assTime(end)},Default,,0,0,0,,${text}`);
  }
  return `[Script Info]\nScriptType: v4.00+\nPlayResX: ${Math.round(width)}\nPlayResY: ${Math.round(height)}\nScaledBorderAndShadow: yes\nWrapStyle: 2\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Arial,${fontSize},${primary},${primary},${outlineColor},${background},-1,0,0,0,100,100,0,0,${borderStyle},${outlineWidth},0,${alignment},${marginH},${marginH},${marginV},1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n${events.join('\n')}\n`;
}

module.exports = { MAX_SUBTITLE_CUES, assText, assTime, buildAssSubtitles };
