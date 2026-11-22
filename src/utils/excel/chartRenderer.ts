/**
 * Renderizador de gráficas sin dependencias externas.
 *
 * Genera SVG puro (fácil de probar en Node) y el navegador lo rasteriza a PNG
 * para incrustarlo en el libro de Excel. Se dibujan agregados, nunca filas
 * individuales, así que un reporte de 50.000 líneas sigue produciendo una
 * imagen pequeña.
 */

import { CHART_COLORS } from './theme';

export type ChartKind = 'bar' | 'line' | 'donut';
export type ChartValueFormat = 'currency' | 'integer' | 'percent';

export interface ChartSeries {
  name: string;
  values: number[];
  color?: string;
}

export interface ChartSpec {
  kind: ChartKind;
  title: string;
  subtitle?: string;
  labels: string[];
  series: ChartSeries[];
  valueFormat?: ChartValueFormat;
  /** Etiqueta opcional para el centro del donut (por defecto: total). */
  centerLabel?: string;
}

export interface ChartSize {
  width: number;
  height: number;
}

const DEFAULT_SIZE: ChartSize = { width: 700, height: 320 };

const COLOR_INK = '#1F1B2E';
const COLOR_MUTED = '#6B7280';
const COLOR_GRID = '#EDEFF5';
const COLOR_VIOLET = '#32145F';
const COLOR_BORDER = '#E5E7EB';

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function groupThousands(value: number, decimals: number): string {
  const negative = value < 0;
  const fixed = Math.abs(value).toFixed(decimals);
  const [whole, fraction] = fixed.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const result = decimals > 0 ? `${grouped},${fraction}` : grouped;
  return negative ? `-${result}` : result;
}

export function formatChartAmount(value: number, format: ChartValueFormat = 'integer'): string {
  if (!Number.isFinite(value)) return '0';
  if (format === 'percent') return `${groupThousands(value, 1)}%`;
  if (format === 'currency') return groupThousands(value, 2);
  return groupThousands(value, 0);
}

function formatAxisValue(value: number, format: ChartValueFormat): string {
  if (!Number.isFinite(value)) return '0';
  const abs = Math.abs(value);
  if (format === 'percent') return `${groupThousands(value, 0)}%`;
  if (abs >= 1_000_000_000) return `${groupThousands(value / 1_000_000_000, 1)} mil M`;
  if (abs >= 1_000_000) return `${groupThousands(value / 1_000_000, 1)} M`;
  if (abs >= 10_000) return `${groupThousands(value / 1_000, 1)} mil`;
  return groupThousands(value, 0);
}

function truncateLabel(label: string, max = 16): string {
  const clean = String(label ?? '').trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, Math.max(1, max - 1))}…`;
}

function labelStep(count: number, maxLabels: number): number {
  if (count <= maxLabels) return 1;
  return Math.ceil(count / maxLabels);
}

function collectNumbers(spec: ChartSpec): number[] {
  const values: number[] = [];
  for (const series of spec.series || []) {
    for (const value of series.values || []) {
      if (Number.isFinite(value)) values.push(value);
    }
  }
  return values;
}

/**
 * Una gráfica solo se dibuja si hay etiquetas y al menos un valor distinto de
 * cero. Evita ejes con NaN y divisiones por cero en periodos vacíos.
 */
export function hasChartData(spec: ChartSpec | null | undefined): boolean {
  if (!spec || !Array.isArray(spec.labels) || spec.labels.length === 0) return false;
  if (!Array.isArray(spec.series) || spec.series.length === 0) return false;
  const values = collectNumbers(spec);
  return values.length > 0 && values.some(value => Math.abs(value) > 0.000001);
}

interface Scale {
  min: number;
  max: number;
  ticks: number[];
}

function buildScale(values: number[]): Scale {
  const finite = values.filter(value => Number.isFinite(value));
  let max = finite.length ? Math.max(...finite) : 0;
  let min = finite.length ? Math.min(...finite) : 0;
  if (max === min) {
    if (max === 0) {
      max = 1;
      min = 0;
    } else {
      max = max > 0 ? max * 1.2 : max * 0.8;
      min = min > 0 ? 0 : min * 1.2;
    }
  }
  if (max > 0) max *= 1.08;
  if (min < 0) min *= 1.08;
  const span = max - min || 1;
  const ticks = [0, 1, 2, 3, 4].map(index => min + (span * index) / 4);
  return { min, max, ticks };
}

function valueToY(value: number, scale: Scale, top: number, height: number): number {
  const ratio = (value - scale.min) / (scale.max - scale.min || 1);
  return top + height - ratio * height;
}

function renderTitle(spec: ChartSpec): string {
  return [
    `<text x="24" y="30" font-family="Segoe UI, Arial, sans-serif" font-size="15" font-weight="700" fill="${COLOR_VIOLET}">${escapeXml(
      truncateLabel(spec.title, 78),
    )}</text>`,
    spec.subtitle
      ? `<text x="24" y="48" font-family="Segoe UI, Arial, sans-serif" font-size="10" fill="${COLOR_MUTED}">${escapeXml(
          truncateLabel(spec.subtitle, 120),
        )}</text>`
      : '',
  ].join('');
}

function renderAxes(scale: Scale, format: ChartValueFormat, left: number, top: number, plotWidth: number, plotHeight: number): string {
  const parts: string[] = [];
  scale.ticks.forEach(tick => {
    const y = valueToY(tick, scale, top, plotHeight);
    parts.push(
      `<line x1="${left}" y1="${y.toFixed(1)}" x2="${(left + plotWidth).toFixed(1)}" y2="${y.toFixed(1)}" stroke="${COLOR_GRID}" stroke-width="1"/>`,
    );
    parts.push(
      `<text x="${left - 8}" y="${(y + 3.5).toFixed(1)}" text-anchor="end" font-family="Segoe UI, Arial, sans-serif" font-size="9" fill="${COLOR_MUTED}">${escapeXml(
        formatAxisValue(tick, format),
      )}</text>`,
    );
  });
  return parts.join('');
}

function renderXLabels(labels: string[], left: number, slot: number, y: number, maxLabels: number): string {
  const step = labelStep(labels.length, maxLabels);
  return labels
    .map((label, index) => {
      if (index % step !== 0) return '';
      const x = left + slot * (index + 0.5);
      return `<text x="${x.toFixed(1)}" y="${y}" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-size="9" fill="${COLOR_MUTED}">${escapeXml(
        truncateLabel(label, 15),
      )}</text>`;
    })
    .join('');
}

function renderBarChart(spec: ChartSpec, size: ChartSize): string {
  const left = 72;
  const top = 68;
  const plotWidth = size.width - left - 28;
  const plotHeight = size.height - top - 52;
  const values = collectNumbers(spec);
  const scale = buildScale([0, ...values]);
  const labels = spec.labels;
  const slot = plotWidth / Math.max(1, labels.length);
  const seriesCount = Math.max(1, spec.series.length);
  const groupWidth = slot * 0.72;
  const barWidth = Math.max(3, groupWidth / seriesCount - (seriesCount > 1 ? 2 : 0));
  const baseline = valueToY(0, scale, top, plotHeight);
  const parts: string[] = [renderAxes(scale, spec.valueFormat || 'integer', left, top, plotWidth, plotHeight)];

  labels.forEach((label, labelIndex) => {
    const groupStart = left + slot * labelIndex + (slot - groupWidth) / 2;
    spec.series.forEach((series, seriesIndex) => {
      const raw = Number(series.values[labelIndex]);
      if (!Number.isFinite(raw)) return;
      const color = series.color || CHART_COLORS[seriesIndex % CHART_COLORS.length];
      const x = groupStart + seriesIndex * (barWidth + 2);
      const y = valueToY(raw, scale, top, plotHeight);
      const height = Math.abs(baseline - y);
      const rectY = raw >= 0 ? y : baseline;
      const radius = Math.min(3, barWidth / 2);
      parts.push(
        `<rect x="${x.toFixed(1)}" y="${rectY.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${Math.max(
          1,
          height,
        ).toFixed(1)}" rx="${radius}" fill="${color}"/>`,
      );
      if (labels.length <= 9 && seriesCount === 1) {
        parts.push(
          `<text x="${(x + barWidth / 2).toFixed(1)}" y="${(rectY - 5).toFixed(1)}" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-size="9" font-weight="600" fill="${COLOR_INK}">${escapeXml(
            formatAxisValue(raw, spec.valueFormat || 'integer'),
          )}</text>`,
        );
      }
    });
  });

  const legend = renderLegend(spec, size.width);
  return [
    `<rect x="0.5" y="0.5" width="${size.width - 1}" height="${size.height - 1}" rx="8" fill="#FFFFFF" stroke="${COLOR_BORDER}"/>`,
    renderTitle(spec),
    parts.join(''),
    `<line x1="${left}" y1="${baseline.toFixed(1)}" x2="${left + plotWidth}" y2="${baseline.toFixed(1)}" stroke="#C9CDD8" stroke-width="1"/>`,
    renderXLabels(labels, left, slot, size.height - 26, 14),
    legend,
  ].join('');
}

function renderLegend(spec: ChartSpec, width: number): string {
  if (spec.series.length <= 1) return '';
  let x = 24;
  const y = 56;
  const parts: string[] = [];
  spec.series.forEach((series, index) => {
    const color = series.color || CHART_COLORS[index % CHART_COLORS.length];
    parts.push(`<rect x="${x}" y="${y - 8}" width="9" height="9" rx="2" fill="${color}"/>`);
    parts.push(
      `<text x="${x + 13}" y="${y}" font-family="Segoe UI, Arial, sans-serif" font-size="9" fill="${COLOR_MUTED}">${escapeXml(
        truncateLabel(series.name, 24),
      )}</text>`,
    );
    x += Math.min(150, 30 + series.name.length * 5.4);
  });
  void width;
  return parts.join('');
}

function renderLineChart(spec: ChartSpec, size: ChartSize): string {
  const left = 72;
  const top = 74;
  const plotWidth = size.width - left - 28;
  const plotHeight = size.height - top - 58;
  const values = collectNumbers(spec);
  const scale = buildScale([0, ...values]);
  const labels = spec.labels;
  const slot = plotWidth / Math.max(1, labels.length - 1);
  const parts: string[] = [renderAxes(scale, spec.valueFormat || 'integer', left, top, plotWidth, plotHeight)];
  const baseline = valueToY(0, scale, top, plotHeight);

  spec.series.forEach((series, seriesIndex) => {
    const color = series.color || CHART_COLORS[seriesIndex % CHART_COLORS.length];
    const points = labels.map((_, index) => {
      const raw = Number(series.values[index]);
      const value = Number.isFinite(raw) ? raw : 0;
      return { x: left + slot * index, y: valueToY(value, scale, top, plotHeight) };
    });
    if (points.length === 0) return;
    if (points.length === 1) {
      points.push({ ...points[0] });
    }
    const path = points.map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' ');
    const area = `${path} L${points[points.length - 1].x.toFixed(1)},${baseline.toFixed(1)} L${points[0].x.toFixed(
      1,
    )},${baseline.toFixed(1)} Z`;
    parts.push(`<path d="${area}" fill="${color}" opacity="0.10"/>`);
    parts.push(`<path d="${path}" fill="none" stroke="${color}" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round"/>`);
    points.forEach(point => {
      parts.push(`<circle cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="2.6" fill="#FFFFFF" stroke="${color}" stroke-width="1.8"/>`);
    });
  });

  return [
    `<rect x="0.5" y="0.5" width="${size.width - 1}" height="${size.height - 1}" rx="8" fill="#FFFFFF" stroke="${COLOR_BORDER}"/>`,
    renderTitle(spec),
    renderLegend(spec, size.width),
    parts.join(''),
    `<line x1="${left}" y1="${baseline.toFixed(1)}" x2="${left + plotWidth}" y2="${baseline.toFixed(1)}" stroke="#C9CDD8" stroke-width="1"/>`,
    renderXLabels(labels, left, slot, size.height - 24, 12),
  ].join('');
}

function polarPoint(cx: number, cy: number, radius: number, angle: number): { x: number; y: number } {
  return { x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle) };
}

function donutSegment(cx: number, cy: number, outer: number, inner: number, start: number, end: number): string {
  const large = end - start > Math.PI ? 1 : 0;
  const p1 = polarPoint(cx, cy, outer, start);
  const p2 = polarPoint(cx, cy, outer, end);
  const p3 = polarPoint(cx, cy, inner, end);
  const p4 = polarPoint(cx, cy, inner, start);
  return [
    `M${p1.x.toFixed(2)},${p1.y.toFixed(2)}`,
    `A${outer},${outer} 0 ${large} 1 ${p2.x.toFixed(2)},${p2.y.toFixed(2)}`,
    `L${p3.x.toFixed(2)},${p3.y.toFixed(2)}`,
    `A${inner},${inner} 0 ${large} 0 ${p4.x.toFixed(2)},${p4.y.toFixed(2)}`,
    'Z',
  ].join(' ');
}

function renderDonutChart(spec: ChartSpec, size: ChartSize): string {
  const series = spec.series[0];
  const labels = spec.labels;
  const rawValues = labels.map((_, index) => {
    const value = Number(series.values[index]);
    return Number.isFinite(value) && value > 0 ? value : 0;
  });
  const total = rawValues.reduce((sum, value) => sum + value, 0);
  if (total <= 0) return '';

  const cx = 220;
  const cy = size.height / 2 + 8;
  const outer = Math.min(105, (size.height - 110) / 2 + 18);
  const inner = outer * 0.6;
  let angle = -Math.PI / 2;
  const slices: string[] = [];
  const legend: string[] = [];
  const top = Math.max(3, Math.min(labels.length, 8));
  let legendY = 92;

  rawValues.forEach((value, index) => {
    if (value <= 0) return;
    const sweep = (value / total) * Math.PI * 2;
    const color = CHART_COLORS[index % CHART_COLORS.length];
    slices.push(`<path d="${donutSegment(cx, cy, outer, inner, angle, angle + sweep)}" fill="${color}"/>`);
    angle += sweep;
  });

  rawValues.slice(0, top).forEach((value, index) => {
    if (value <= 0) return;
    const color = CHART_COLORS[index % CHART_COLORS.length];
    const pct = (value / total) * 100;
    legend.push(`<rect x="430" y="${legendY - 9}" width="10" height="10" rx="2" fill="${color}"/>`);
    legend.push(
      `<text x="446" y="${legendY}" font-family="Segoe UI, Arial, sans-serif" font-size="10" fill="${COLOR_INK}">${escapeXml(
        truncateLabel(labels[index], 24),
      )}</text>`,
    );
    legend.push(
      `<text x="${size.width - 28}" y="${legendY}" text-anchor="end" font-family="Segoe UI, Arial, sans-serif" font-size="10" font-weight="600" fill="${COLOR_INK}">${escapeXml(
        `${groupThousands(pct, 1)}%`,
      )}</text>`,
    );
    legend.push(
      `<text x="${size.width - 28}" y="${legendY + 12}" text-anchor="end" font-family="Segoe UI, Arial, sans-serif" font-size="9" fill="${COLOR_MUTED}">${escapeXml(
        formatChartAmount(value, spec.valueFormat || 'integer'),
      )}</text>`,
    );
    legendY += 27;
  });

  const centerValue = formatChartAmount(total, spec.valueFormat || 'integer');
  return [
    `<rect x="0.5" y="0.5" width="${size.width - 1}" height="${size.height - 1}" rx="8" fill="#FFFFFF" stroke="${COLOR_BORDER}"/>`,
    renderTitle(spec),
    slices.join(''),
    `<circle cx="${cx}" cy="${cy}" r="${inner - 2}" fill="#FFFFFF"/>`,
    `<text x="${cx}" y="${cy - 2}" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-size="10" fill="${COLOR_MUTED}">${escapeXml(
      spec.centerLabel ? spec.centerLabel : 'TOTAL',
    )}</text>`,
    `<text x="${cx}" y="${cy + 18}" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-size="15" font-weight="700" fill="${COLOR_VIOLET}">${escapeXml(
      centerValue,
    )}</text>`,
    legend.join(''),
  ].join('');
}

function wrapSvg(body: string, size: ChartSize): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size.width}" height="${size.height}" viewBox="0 0 ${size.width} ${size.height}">${body}</svg>`;
}

export function renderChartSvg(spec: ChartSpec, size: Partial<ChartSize> = {}): string | null {
  if (!hasChartData(spec)) return null;
  const resolved: ChartSize = { ...DEFAULT_SIZE, ...size };
  if (spec.kind === 'donut') {
    const svg = renderDonutChart(spec, resolved);
    return svg ? wrapSvg(svg, resolved) : null;
  }
  if (spec.kind === 'line') return wrapSvg(renderLineChart(spec, resolved), resolved);
  return wrapSvg(renderBarChart(spec, resolved), resolved);
}
