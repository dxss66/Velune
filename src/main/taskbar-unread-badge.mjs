const BADGE_PIXEL_SIZE = 48;
const BADGE_SCALE_FACTOR = 3;
const BADGE_BLUE = Object.freeze({ red: 22, green: 119, blue: 255 });
const BADGE_WHITE = Object.freeze({ red: 255, green: 255, blue: 255 });

const GLYPHS = Object.freeze({
  "0": ["111", "101", "101", "101", "111"],
  "1": ["010", "110", "010", "010", "111"],
  "2": ["111", "001", "111", "100", "111"],
  "3": ["111", "001", "111", "001", "111"],
  "4": ["101", "101", "111", "001", "001"],
  "5": ["111", "100", "111", "001", "111"],
  "6": ["111", "100", "111", "101", "111"],
  "7": ["111", "001", "010", "010", "010"],
  "8": ["111", "101", "111", "101", "111"],
  "9": ["111", "101", "111", "001", "111"],
  "+": ["000", "010", "111", "010", "000"],
});

export function normalizeTaskbarUnreadCount(value) {
  const count = Number(value);
  if (!Number.isFinite(count) || count <= 0) return 0;
  return Math.min(9999, Math.floor(count));
}

export function taskbarUnreadBadgeLabel(value) {
  const count = normalizeTaskbarUnreadCount(value);
  if (count <= 0) return "";
  return count > 99 ? "99+" : String(count);
}

export function createTaskbarUnreadBadgeBitmap(value) {
  const count = normalizeTaskbarUnreadCount(value);
  const label = taskbarUnreadBadgeLabel(count);
  if (!label) return null;

  const buffer = Buffer.alloc(BADGE_PIXEL_SIZE * BADGE_PIXEL_SIZE * 4);
  drawBadgeCircle(buffer);
  drawBadgeLabel(buffer, label);
  return {
    buffer,
    width: BADGE_PIXEL_SIZE,
    height: BADGE_PIXEL_SIZE,
    scaleFactor: BADGE_SCALE_FACTOR,
    label,
    count,
  };
}

function drawBadgeCircle(buffer) {
  const center = BADGE_PIXEL_SIZE / 2;
  const outerRadius = 23;
  const innerRadius = 20;
  for (let y = 0; y < BADGE_PIXEL_SIZE; y += 1) {
    for (let x = 0; x < BADGE_PIXEL_SIZE; x += 1) {
      const distance = Math.hypot(x + 0.5 - center, y + 0.5 - center);
      const outerCoverage = clamp01(outerRadius + 0.5 - distance);
      if (outerCoverage <= 0) continue;
      const innerCoverage = clamp01(innerRadius + 0.5 - distance);
      const color = blendColor(BADGE_WHITE, BADGE_BLUE, innerCoverage);
      setBgraPixel(buffer, x, y, color, outerCoverage);
    }
  }
}

function drawBadgeLabel(buffer, label) {
  const scale = label.length === 1 ? 7 : label.length === 2 ? 5 : 3;
  const gap = scale;
  const glyphWidth = 3 * scale;
  const labelWidth = label.length * glyphWidth + (label.length - 1) * gap;
  const labelHeight = 5 * scale;
  const startX = Math.floor((BADGE_PIXEL_SIZE - labelWidth) / 2);
  const startY = Math.floor((BADGE_PIXEL_SIZE - labelHeight) / 2);

  [...label].forEach((character, characterIndex) => {
    const glyph = GLYPHS[character];
    if (!glyph) return;
    const glyphX = startX + characterIndex * (glyphWidth + gap);
    glyph.forEach((row, rowIndex) => {
      [...row].forEach((pixel, columnIndex) => {
        if (pixel !== "1") return;
        fillBgraRect(
          buffer,
          glyphX + columnIndex * scale,
          startY + rowIndex * scale,
          scale,
          scale,
          BADGE_WHITE,
        );
      });
    });
  });
}

function blendColor(background, foreground, foregroundCoverage) {
  const backgroundCoverage = 1 - foregroundCoverage;
  return {
    red: Math.round(background.red * backgroundCoverage + foreground.red * foregroundCoverage),
    green: Math.round(background.green * backgroundCoverage + foreground.green * foregroundCoverage),
    blue: Math.round(background.blue * backgroundCoverage + foreground.blue * foregroundCoverage),
  };
}

function fillBgraRect(buffer, left, top, width, height, color) {
  for (let y = top; y < top + height; y += 1) {
    for (let x = left; x < left + width; x += 1) {
      setBgraPixel(buffer, x, y, color, 1);
    }
  }
}

function setBgraPixel(buffer, x, y, color, alpha) {
  if (x < 0 || y < 0 || x >= BADGE_PIXEL_SIZE || y >= BADGE_PIXEL_SIZE) return;
  const offset = (y * BADGE_PIXEL_SIZE + x) * 4;
  buffer[offset] = color.blue;
  buffer[offset + 1] = color.green;
  buffer[offset + 2] = color.red;
  buffer[offset + 3] = Math.round(clamp01(alpha) * 255);
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}
