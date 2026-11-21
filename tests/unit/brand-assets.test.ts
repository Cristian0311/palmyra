import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import sharp from 'sharp';
import { generateIconBuffers } from '../../scripts/generate-icons.mjs';

const root = new URL('../../', import.meta.url);
const read = (file: string) => fs.readFile(new URL(file, root));
const brand = [113, 55, 200];

async function pixels(input: Buffer) {
  return sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
}

function luminance(rgb: number[]) {
  return rgb.map(channel => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  }).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
}

function contrast(a: number[], b: number[]) {
  const values = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

test('brand SVGs are accessible, self-contained vectors with the same camel', async () => {
  const mark = (await read('public/palmyra-mark-exact.svg')).toString();
  const logo = (await read('public/palmyra-logo-exact.svg')).toString();
  for (const svg of [mark, logo]) {
    assert.match(svg, /role="img" aria-labelledby="title desc"/);
    assert.match(svg, /<title id="title">PALMYRA<\/title>/);
    assert.doesNotMatch(svg, /<(?:image|text|script|foreignObject|filter)\b|@font-face|(?:href|src)=/i);
    assert.doesNotMatch(svg, /prefers-color-scheme|currentColor/);
  }
  for (const pattern of [/<defs>[\s\S]*?<\/defs>/, /<circle id="palmyra-disc"[^>]*\/>/, /<g id="palmyra-camel"[\s\S]*?<\/g>/]) {
    assert.ok(mark.match(pattern));
    assert.equal(mark.match(pattern)![0], logo.match(pattern)![0]);
  }
  // Native viewBox borders must remain clear: no cropped legs or final A.
  for (const svg of [mark, logo]) {
    const { data, info } = await pixels(Buffer.from(svg));
    for (let y = 0; y < info.height; y++) {
      for (const x of [0, 1, info.width - 2, info.width - 1]) {
        assert.equal(data[(y * info.width + x) * 4 + 3], 0);
      }
    }
    for (let x = 0; x < info.width; x++) {
      for (const y of [0, 1, info.height - 2, info.height - 1]) {
        assert.equal(data[(y * info.width + x) * 4 + 3], 0);
      }
    }
  }
});

test('16, 32 and 64px marks retain white foreground, padding and transparency', async () => {
  const source = await read('public/palmyra-mark-exact.svg');
  for (const size of [16, 32, 64]) {
    const { data, info } = await pixels(await sharp(source).resize(size, size).png().toBuffer());
    assert.equal(info.width, size);
    assert.equal(info.height, size);
    assert.equal(data[3], 0);
    let white = 0;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = (y * size + x) * 4;
        if (data[i] > 220 && data[i + 1] > 220 && data[i + 2] > 220 && data[i + 3] > 200) {
          white++;
          assert.ok(Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2) < size * 0.48);
        }
      }
    }
    assert.ok(white > size * size * 0.06, `camello visible a ${size}px`);
  }
});

test('PNG exports have correct dimensions, transparency and solid backgrounds', async () => {
  const files: [string, number, number, boolean][] = [
    ['public/pwa-192.png', 192, 192, false],
    ['public/pwa-512.png', 512, 512, false],
    ['public/pwa-maskable-512.png', 512, 512, true],
    ['public/apple-touch-icon.png', 180, 180, true],
    ['public/icon.png', 512, 512, true],
    ['build/icon.png', 512, 512, true],
    ['public/palmyra-email-logo-v2.png', 1200, 310, true],
  ];
  for (const [file, width, height, solid] of files) {
    const buffer = await read(file);
    const metadata = await sharp(buffer).metadata();
    assert.equal(metadata.format, 'png', file);
    assert.equal(metadata.width, width, file);
    assert.equal(metadata.height, height, file);
    const { data } = await pixels(buffer);
    const expected = solid ? (file.includes('email') ? [255, 255, 255, 255] : [...brand, 255]) : [0, 0, 0, 0];
    for (const corner of [0, width - 1, (height - 1) * width, height * width - 1]) {
      assert.deepEqual([...data.subarray(corner * 4, corner * 4 + 4)], expected, file);
    }
    if (solid) {
      for (let i = 3; i < data.length; i += 4) assert.equal(data[i], 255, file);
    }
  }
});

test('maskable camel, including antialiasing, stays inside the 40% safe circle', async () => {
  const { data, info } = await pixels(await read('public/pwa-maskable-512.png'));
  let foreground = 0;
  let radius = 0;
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      const i = (y * info.width + x) * 4;
      if (brand.some((channel, index) => Math.abs(channel - data[i + index]) > 8)) {
        foreground++;
        radius = Math.max(radius, Math.hypot(x + 0.5 - info.width / 2, y + 0.5 - info.height / 2));
      }
    }
  }
  assert.ok(foreground > info.width * info.height * 0.1);
  assert.ok(radius < info.width * 0.39, `safe-zone reserve: ${radius}px`);
});

test('wordmark balances light/dark contrast and solid icons avoid dark-on-dark', async () => {
  const logo = (await read('public/palmyra-logo-exact.svg')).toString();
  const hex = logo.match(/id="palmyra-wordmark" fill="(#[A-F\d]{6})"/i)![1];
  const ink = hex.slice(1).match(/../g)!.map(channel => parseInt(channel, 16));
  // Wordmark is morado PALMYRA (legible sobre fondos oscuros y claros).
  assert.deepEqual(ink, [150, 96, 214]);
  assert.ok(contrast(ink, [255, 255, 255]) > 4.2);
  assert.ok(contrast(ink, [25, 17, 42]) > 4.2);
  assert.ok(contrast([255, 255, 255], brand) > 6);
  const { data } = await pixels(await read('public/icon.png'));
  let white = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i] > 245 && data[i + 1] > 245 && data[i + 2] > 245) white++;
  }
  assert.ok(white > 512 * 512 * 0.12);
});

test('ICO contains independently rendered, correctly indexed PNG frames from 16 to 256px', async () => {
  const ico = await read('public/favicon.ico');
  assert.deepEqual(ico, await read('build/icon.ico'));
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  assert.equal(ico.readUInt16LE(0), 0);
  assert.equal(ico.readUInt16LE(2), 1);
  assert.equal(ico.readUInt16LE(4), sizes.length);
  let expectedOffset = 6 + sizes.length * 16;
  for (const [index, size] of sizes.entries()) {
    const entry = 6 + index * 16;
    assert.equal(ico[entry] || 256, size);
    assert.equal(ico[entry + 1] || 256, size);
    assert.equal(ico.readUInt16LE(entry + 4), 1);
    assert.equal(ico.readUInt16LE(entry + 6), 32);
    const length = ico.readUInt32LE(entry + 8);
    const offset = ico.readUInt32LE(entry + 12);
    assert.equal(offset, expectedOffset);
    const frame = ico.subarray(offset, offset + length);
    const metadata = await sharp(frame).metadata();
    assert.equal(metadata.format, 'png');
    assert.equal(metadata.width, size);
    assert.equal(metadata.height, size);
    assert.equal((await pixels(frame)).data[3], 0);
    expectedOffset += length;
  }
  assert.equal(expectedOffset, ico.length);
});

test('all nine generated assets are byte-reproducible from the canonical SVGs', async () => {
  const outputs = await generateIconBuffers();
  assert.equal(outputs.size, 9);
  for (const [file, buffer] of outputs) assert.deepEqual(await read(file), buffer, file);
});
