import { renderChartSvg, type ChartSpec } from './chartRenderer';

export interface RenderedChart {
  extension: 'png';
  /** Imagen PNG en base64 sin el prefijo data:. */
  base64?: string;
  buffer?: Uint8Array;
  width: number;
  height: number;
}

/**
 * Convierte una especificación de gráfica en una imagen PNG usando el canvas
 * del navegador. Se renderiza a 2x para que se vea nítida en Excel y se reduce
 * al tamaño final mediante el anclaje del libro.
 */
export async function renderChartPng(spec: ChartSpec, width = 700, height = 320): Promise<RenderedChart | null> {
  const svg = renderChartSvg(spec, { width, height });
  if (!svg) return null;
  if (typeof document === 'undefined' || typeof Image === 'undefined' || typeof Blob === 'undefined') {
    return null;
  }

  const scale = 2;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const context = canvas.getContext('2d');
  if (!context) return null;

  let objectUrl: string | null = null;
  try {
    const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
    objectUrl = URL.createObjectURL(blob);
    const image = new Image();
    image.decoding = 'async';
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('No se pudo rasterizar la gráfica'));
      image.src = objectUrl as string;
    });
    context.fillStyle = '#FFFFFF';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.setTransform(scale, 0, 0, scale, 0, 0);
    context.drawImage(image, 0, 0, width, height);
    const dataUrl = canvas.toDataURL('image/png');
    const base64 = dataUrl.split(',')[1];
    if (!base64) return null;
    return { extension: 'png', base64, width, height };
  } catch {
    return null;
  } finally {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  }
}
