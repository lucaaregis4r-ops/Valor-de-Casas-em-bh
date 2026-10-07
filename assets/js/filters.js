import { median } from './statistics.js';

export function norm(text) {
  return String(text || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

export function selectedFilters() {
  return {
    type: document.getElementById('typeFilter').value,
    city: document.getElementById('cityFilter').value,
    neighborhood: document.getElementById('neighborhoodFilter').value,
    minSamples: Number(document.getElementById('minSamples').value),
    radius: Number(document.getElementById('radius').value),
    rentMetric: document.getElementById('rentMetric').value
  };
}

export function baseFilter(points, includeYear=true) {
  const f = selectedFilters();
  return points.filter(p => {
    if (f.type !== 'all' && p.property_type !== f.type) return false;
    if (f.city !== 'all' && p.city !== f.city) return false;
    if (f.neighborhood !== 'all' && p.neighborhood !== f.neighborhood) return false;
    return true;
  });
}

export function groupByNeighborhood(points) {
  const groups = new Map();
  for (const p of points) {
    const key = norm(p.neighborhood);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, {name:p.neighborhood, points:[]});
    groups.get(key).points.push(p);
  }
  return groups;
}

export function neighborhoodMedians(points) {
  const f = selectedFilters();
  const medians = new Map();
  for (const [key, group] of groupByNeighborhood(points).entries()) {
    if (group.points.length < f.minSamples) continue;
    medians.set(key, {
      name: group.name,
      count: group.points.length,
      median_m2: median(group.points.map(p => p.price_m2))
    });
  }
  return medians;
}

export function cityMedian(points) {
  return median(points.map(p => p.price_m2));
}
