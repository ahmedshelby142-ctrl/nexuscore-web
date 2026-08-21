#!/usr/bin/env node
/**
 * make-placeholder-icon.cjs
 *
 * Generates a 1024x1024 PNG to use as the source for the Tauri icon
 * generator. The output lands at `src-tauri/icons/source.png` so
 * `npm run tauri:icon` (or `tauri icon src-tauri/icons/source.png`)
 * can expand it into the full icon set (32x32, 128x128, 128x128@2x,
 * icon.ico, icon.icns, plus the Windows Store variants).
 *
 * Why a script and not a checked-in binary: the source is a binary
 * PNG which can't be created via the Edit/Write tools, and we want
 * the repo to stay clean of generated assets. This script runs as
 * part of `npm run tauri:setup` and is also safe to run on its own.
 *
 * Design:
 *   - 1024x1024, solid Deep Navy background (`#0F172A` — the brand's
 *     primary surface color from styles.css).
 *   - A centered "N" mark in Nexus Cyan (`#06B6D4`) drawn as a simple
 *     diagonal stroke. Pure pixel-buffer drawing — no canvas dep.
 *   - Written with the standard zlib-based PNG encoder (no native
 *     deps, no `pngjs`, no `sharp`).
 *
 * If the user later drops a real logo at `src/assets/logo-light.png`,
 * the `tauri:icon` npm script already points at it directly. This
 * script is only the fallback for first-run / no-logo scenarios.
 */

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

// Brand colors (mirror the oklch values in src/styles.css).
const BG = { r: 0x0f, g: 0x17, b: 0x2a }; // #0F172A — Deep Navy
const FG = { r: 0x06, g: 0xb6, b: 0xd4 }; // #06B6D4 — Nexus Cyan

const SIZE = 1024;
const outPath = path.resolve(__dirname, "..", "src-tauri", "icons", "source.png");

// ── Pixel buffer (RGBA) ─────────────────────────────────────────────
const pixels = Buffer.alloc(SIZE * SIZE * 4);
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const i = (y * SIZE + x) * 4;
    pixels[i] = BG.r;
    pixels[i + 1] = BG.g;
    pixels[i + 2] = BG.b;
    pixels[i + 3] = 0xff;
  }
}

// ── Draw the "N" mark ────────────────────────────────────────────────
// A simple block "N" with two vertical bars and one diagonal bar,
// centered, occupying the central ~60% of the canvas.
const inset = Math.floor(SIZE * 0.2); // 20% padding on every side
const top = inset;
const bottom = SIZE - inset;
const left = inset;
const right = SIZE - inset;
const bar = Math.floor(SIZE * 0.08); // stroke thickness

function drawRect(x0, y0, x1, y1) {
  for (let y = Math.max(0, y0); y < Math.min(SIZE, y1); y++) {
    for (let x = Math.max(0, x0); x < Math.min(SIZE, x1); x++) {
      const i = (y * SIZE + x) * 4;
      pixels[i] = FG.r;
      pixels[i + 1] = FG.g;
      pixels[i + 2] = FG.b;
      pixels[i + 3] = 0xff;
    }
  }
}

// Left vertical bar
drawRect(left, top, left + bar, bottom);
// Right vertical bar
drawRect(right - bar, top, right, bottom);

// Diagonal bar — rasterize a thick line from (left, bottom) to
// (right, top) using a half-pixel Bresenham approximation. We use a
// bounding box + per-row clipping to keep the math simple.
{
  const x0 = left;
  const y0 = bottom;
  const x1 = right;
  const y1 = top;
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.hypot(dx, dy);
  // perpendicular unit vector
  const px = -dy / len;
  const py = dx / len;
  const half = bar / 2;
  for (let t = 0; t <= len; t++) {
    const cx = x0 + (dx * t) / len;
    const cy = y0 + (dy * t) / len;
    const xA = Math.floor(cx + px * half);
    const yA = Math.floor(cy + py * half);
    const xB = Math.floor(cx - px * half);
    const yB = Math.floor(cy - py * half);
    drawRect(
      Math.min(xA, xB),
      Math.min(yA, yB),
      Math.max(xA, xB) + 1,
      Math.max(yA, yB) + 1,
    );
  }
}

// ── PNG encoding (no deps) ───────────────────────────────────────────
function u32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0, 0);
  return b;
}
function chunk(type, data) {
  const len = u32(data.length);
  const t = Buffer.from(type, "ascii");
  const crcInput = Buffer.concat([t, data]);
  // CRC32 implementation (PNG uses IEEE 802.3 polynomial 0xedb88320).
  let c = 0xffffffff;
  for (let i = 0; i < crcInput.length; i++) {
    c ^= crcInput[i];
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
  }
  const crc = u32((c ^ 0xffffffff) >>> 0);
  return Buffer.concat([len, t, data, crc]);
}

const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// IHDR: width, height, bit depth, color type (6 = RGBA), compression (0),
// filter (0), interlace (0).
const ihdr = Buffer.concat([
  u32(SIZE),
  u32(SIZE),
  Buffer.from([8, 6, 0, 0, 0]),
]);

// IDAT: filter byte 0 (none) prepended to every scanline, then deflated.
const stride = SIZE * 4;
const filtered = Buffer.alloc(SIZE * (stride + 1));
for (let y = 0; y < SIZE; y++) {
  filtered[y * (stride + 1)] = 0; // filter type: None
  pixels.copy(filtered, y * (stride + 1) + 1, y * stride, y * stride + stride);
}
const idat = zlib.deflateSync(filtered, { level: 9 });

const png = Buffer.concat([
  signature,
  chunk("IHDR", ihdr),
  chunk("IDAT", idat),
  chunk("IEND", Buffer.alloc(0)),
]);

// ── Write ────────────────────────────────────────────────────────────
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, png);
console.log(`[icon] wrote ${outPath} (${png.length} bytes, ${SIZE}x${SIZE})`);
console.log("[icon] run `npm run tauri:icon` to generate the full icon set");
