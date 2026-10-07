export function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a,b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function percentile(values, pct) {
  if (!values.length) return 1;
  const sorted = [...values].sort((a,b) => a - b);
  const idx = (sorted.length - 1) * pct;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo] || 1;
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

export function mean(values) {
  return values.length ? values.reduce((acc, value) => acc + value, 0) / values.length : null;
}

function hexToRgb(hex) {
  const clean = hex.replace('#', '');
  return [parseInt(clean.slice(0,2), 16), parseInt(clean.slice(2,4), 16), parseInt(clean.slice(4,6), 16)];
}

function rgbToHex(rgb) {
  return '#' + rgb.map(v => Math.round(v).toString(16).padStart(2, '0')).join('');
}

export function interpolateColor(stops, value) {
  if (value === null || value === undefined || Number.isNaN(value)) return '#94a3b8';
  const t = Math.max(0, Math.min(1, value));
  for (let i = 0; i < stops.length - 1; i++) {
    const [p1, c1] = stops[i];
    const [p2, c2] = stops[i + 1];
    if (t >= p1 && t <= p2) {
      const local = (t - p1) / (p2 - p1 || 1);
      const a = hexToRgb(c1), b = hexToRgb(c2);
      return rgbToHex(a.map((v, idx) => v + (b[idx] - v) * local));
    }
  }
  return stops[stops.length - 1][1];
}

export const priceStops = [[0,'#e0f2fe'],[.18,'#7dd3fc'],[.35,'#5eead4'],[.5,'#bef264'],[.68,'#fde68a'],[.84,'#fca5a5'],[1,'#fb7185']];
export const deltaStops = [[0,'#1d4ed8'],[.22,'#60a5fa'],[.4,'#bfdbfe'],[.5,'#e5e7eb'],[.6,'#fed7aa'],[.78,'#fb923c'],[1,'#dc2626']];
export const condoStops = [[0,'#16a34a'],[.18,'#84cc16'],[.36,'#facc15'],[.55,'#fb923c'],[.72,'#c084fc'],[.88,'#7e22ce'],[1,'#3b0764']];
