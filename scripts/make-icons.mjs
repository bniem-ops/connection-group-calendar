// Generates the PNG app icons with zero dependencies (Node's zlib only).
// Draws the same flat calendar mark as public/icons/icon.svg.
// Run: npm run gen:icons
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";

// ---- tiny raster canvas ----
function Canvas(w, h) {
  const buf = new Uint8Array(w * h * 4);
  return {
    w, h, buf,
    fill(x, y, rw, rh, [r, g, b, a = 255]) {
      const x0 = Math.max(0, Math.round(x));
      const y0 = Math.max(0, Math.round(y));
      const x1 = Math.min(w, Math.round(x + rw));
      const y1 = Math.min(h, Math.round(y + rh));
      for (let py = y0; py < y1; py++) {
        for (let px = x0; px < x1; px++) {
          const i = (py * w + px) * 4;
          buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = a;
        }
      }
    },
  };
}

// ---- PNG encoder (8-bit RGBA) ----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const t = Buffer.from(type, "ascii");
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, Buffer.from(data), crc]);
}
function encodePNG({ w, h, buf }) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc(h * (1 + w * 4));
  for (let y = 0; y < h; y++) {
    raw[y * (1 + w * 4)] = 0; // filter: none
    buf.subarray(y * w * 4, (y + 1) * w * 4).forEach((v, x) => {
      raw[y * (1 + w * 4) + 1 + x] = v;
    });
  }
  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---- the icon artwork (coords on a 512 grid, scaled to size) ----
const BLUE = [37, 99, 235];
const DARK = [30, 64, 175];
const WHITE = [255, 255, 255];
const CELL = [147, 197, 253];

function draw(size, pad = 0) {
  const c = Canvas(size, size);
  const s = size / 512;
  const P = pad;
  const inner = size - P * 2;
  const sc = (n) => P + n * (inner / 512);

  c.fill(0, 0, size, size, BLUE);                    // background
  c.fill(sc(96), sc(120), sc(320), sc(296), WHITE);  // calendar body
  c.fill(sc(96), sc(120), sc(320), sc(72), DARK);    // header band
  c.fill(sc(160), sc(96), sc(32), sc(40), DARK);     // left binder tab
  c.fill(sc(320), sc(96), sc(32), sc(40), DARK);     // right binder tab

  const cols = [132, 200, 268, 336];
  const rows = [224, 288, 352];
  for (const ry of rows) {
    for (const cx of cols) {
      const isAccent = ry === 352 && cx === 336;
      c.fill(sc(cx), sc(ry), sc(48), sc(40), isAccent ? BLUE : CELL);
    }
  }
  return encodePNG(c);
}

const out = (name) => new URL(`../public/icons/${name}`, import.meta.url);
writeFileSync(out("icon-192.png"), draw(192));
writeFileSync(out("icon-512.png"), draw(512));
writeFileSync(out("icon-maskable-512.png"), draw(512, 56)); // safe-area padding
console.log("wrote icon-192.png, icon-512.png, icon-maskable-512.png");
