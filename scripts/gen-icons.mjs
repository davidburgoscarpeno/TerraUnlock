import zlib from 'node:zlib';
import fs from 'node:fs';

function crc32(buf) {
  let c, table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c; }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, paint) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = paint(x / size, y / size);
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
// Diseno: fondo oscuro, pico teal con brillo y circulo de conquista
function draw(size, maskable) {
  return png(size, (u, v) => {
    const bg = [11, 16, 23];
    // glow radial
    const dx = u - 0.5, dy = v - 0.52;
    const d = Math.sqrt(dx * dx + dy * dy);
    const glow = Math.max(0, 1 - d * (maskable ? 1.6 : 1.9));
    let r = bg[0] + 45 * glow * 0.18, g = bg[1] + 200 * glow * 0.18, b = bg[2] + 170 * glow * 0.18;
    // pico: triangulo
    const px = Math.abs(u - 0.5), base = 0.78, apex = 0.30, halfW = 0.26;
    const t = (v - apex) / (base - apex);
    if (t > 0 && t < 1 && px < halfW * t) {
      // nieve cerca del apex
      const snow = t < 0.34 && px < halfW * t * 0.55 + 0.02 * Math.sin(u * 40);
      if (snow) { r = 235; g = 240; b = 244; }
      else { r = 45; g = 200; b = 170; }
    }
    return [Math.round(r), Math.round(g), Math.round(b), 255];
  });
}
for (const [size, name, mask] of [[192, 'icon-192.png', false], [512, 'icon-512.png', false], [512, 'icon-maskable-512.png', true], [180, 'apple-touch-icon.png', false]]) {
  fs.writeFileSync(`public/icons/${name}`, draw(size, mask));
  console.log(name, 'ok');
}
