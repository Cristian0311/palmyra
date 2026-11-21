/**
 * Genera los iconos y el PNG de correo desde los SVG de PALMYRA.
 * Uso: node scripts/generate-icons.mjs (independiente del directorio actual).
 *
 * Los iconos «any» y el ICO conservan el disco transparente.
 * Los iconos sólidos usan el camello blanco, sin un segundo disco oscuro.
 * En maskable, todo el camello queda dentro del círculo seguro del 40%.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import sharp from 'sharp';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SOURCE = path.join(ROOT, 'public/palmyra-mark-exact.svg');
const WORDMARK = path.join(ROOT, 'public/palmyra-logo-exact.svg');
const BRAND = '#7137C8';
const TRANSPARENT = { r: 0, g: 0, b: 0, alpha: 0 };
const icoSizes = [16, 24, 32, 48, 64, 128, 256];

function buildIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);

  const entries = [];
  let offset = 6 + images.length * 16;
  for (const { size, buffer } of images) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0);
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(buffer.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += buffer.length;
    entries.push(entry);
  }

  return Buffer.concat([header, ...entries, ...images.map((image) => image.buffer)]);
}

/** Renderiza desde el vector a cada tamaño; nunca amplía otro PNG. */
async function renderIcon(source, size, scale = 1, background = TRANSPARENT) {
  const inner = Math.round(size * scale);
  const mark = await sharp(source, { density: Math.max(72, 72 * inner * 4 / 256) })
    .resize(inner, inner, { fit: 'contain', background: TRANSPARENT })
    .png()
    .toBuffer();

  return sharp({ create: { width: size, height: size, channels: 4, background } })
    .composite([{ input: mark, left: Math.floor((size - inner) / 2), top: Math.floor((size - inner) / 2) }])
    .png({ compressionLevel: 9 })
    .toBuffer();
}

/** Devuelve los mismos bytes que se escriben; permite comprobar reproducibilidad. */
export async function generateIconBuffers() {
  const markSvg = await fs.readFile(SOURCE, 'utf8');
  const disc = /<circle\b[^>]*id="palmyra-disc"[^>]*\/>/g;
  if ([...markSvg.matchAll(disc)].length !== 1) {
    throw new Error('El símbolo debe contener un único círculo palmyra-disc.');
  }
  const mark = Buffer.from(markSvg);
  // El contorno del camello y sus huecos siguen procediendo del SVG canónico.
  const camel = Buffer.from(markSvg.replace(disc, ''));
  const desktop = await renderIcon(camel, 512, 0.92, BRAND);
  const icoImages = [];
  for (const size of icoSizes) {
    icoImages.push({ size, buffer: await renderIcon(mark, size) });
  }
  const ico = buildIco(icoImages);

  return new Map([
    ['public/pwa-192.png', await renderIcon(mark, 192)],
    ['public/pwa-512.png', await renderIcon(mark, 512)],
    ['public/pwa-maskable-512.png', await renderIcon(camel, 512, 0.82, BRAND)],
    ['public/apple-touch-icon.png', await renderIcon(camel, 180, 0.88, BRAND)],
    ['public/icon.png', desktop],
    ['build/icon.png', desktop],
    ['public/favicon.ico', ico],
    ['build/icon.ico', ico],
    // Fondo blanco explícito para clientes de correo que no conservan el tema.
    ['public/palmyra-email-logo-v2.png', await sharp(WORDMARK, { density: 192 })
      .resize({ width: 1200 })
      .flatten({ background: '#FFFFFF' })
      .png({ compressionLevel: 9 })
      .toBuffer()]
  ]);
}

async function main() {
  const outputs = await generateIconBuffers();
  await fs.mkdir(path.join(ROOT, 'build'), { recursive: true });
  for (const [file, buffer] of outputs) {
    await fs.writeFile(path.join(ROOT, file), buffer);
    console.log(`[icons] ${file} (${buffer.length} bytes)`);
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error('[icons] Error generando iconos:', error);
    process.exitCode = 1;
  });
}
