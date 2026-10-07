import { map, currentLayers, clearLayers } from './map.js';
import { median, percentile, mean, interpolateColor, priceStops, deltaStops, condoStops } from './statistics.js';
import { norm, selectedFilters, baseFilter, groupByNeighborhood, neighborhoodMedians, cityMedian } from './filters.js';
import { loadPublicData, currentListings, neighborhoodDaily, listingEvents, publicMeta } from './public-data.js';

let allPoints = [];
let allCities = [];
let allNeighborhoods = [];
const fmtBRL = new Intl.NumberFormat('pt-BR', {style:'currency', currency:'BRL', maximumFractionDigits:0});
const fmtNum = new Intl.NumberFormat('pt-BR');
let mode = 'delta';
let viewFamily = 'historical';

function relativeColor(value) {
  if (value === null || Number.isNaN(value)) return '#94a3b8';
  return interpolateColor(deltaStops, (Math.max(-0.5, Math.min(0.5, value)) + 0.5));
}
function deltaColor(value) {
  if (value === null || Number.isNaN(value)) return '#94a3b8';
  return interpolateColor(deltaStops, (Math.max(-0.6, Math.min(0.6, value)) + 0.6) / 1.2);
}
function pct(value) {
  if (value === null || Number.isNaN(value)) return 'sem amostra';
  return `${value >= 0 ? '+' : ''}${(value * 100).toFixed(1)}%`;
}
function modeValue(items) {
  const counts = new Map();
  items.filter(Boolean).forEach(item => counts.set(item, (counts.get(item) || 0) + 1));
  let best = '', bestCount = 0;
  counts.forEach((count, item) => {
    if (count > bestCount) {
      best = item;
      bestCount = count;
    }
  });
  return best;
}
function confidenceLabel(n2021, n2026, minSamples) {
  const low = Math.min(n2021, n2026);
  if (low < minSamples) return 'insuficiente';
  if (low >= minSamples * 4) return 'alta';
  if (low >= minSamples * 2) return 'boa';
  return 'moderada';
}
function pointTooltip(p, bairroMedian) {
  const diff = bairroMedian ? (p.price_m2 / bairroMedian.median_m2) - 1 : null;
  const medianText = bairroMedian ? fmtBRL.format(bairroMedian.median_m2) : 'amostra insuficiente';
  return `
    <strong>${p.neighborhood || 'Sem bairro'}</strong><br>
    Cidade: ${p.city || 'sem cidade'}<br>
    Tipo: ${p.property_type || 'sem tipo'}<br>
    Preço/m²: <strong>${fmtBRL.format(p.price_m2)}</strong><br>
    Mediana do bairro: ${medianText}<br>
    Diferença bairro: <strong>${pct(diff)}</strong><br>
    Preço total: ${fmtBRL.format(p.price)}<br>
    Área: ${p.area} m²<br>
    Ano/base: ${p.year}<br>
    ${p.address || ''}
  `;
}
function addIndividualPoints(points, relative=false) {
  const medians = neighborhoodMedians(points);
  const cap = percentile(points.map(p => p.price_m2), .95);
  const layer = L.layerGroup();
  points.forEach(p => {
    const bairroMedian = medians.get(norm(p.neighborhood));
    const relativeValue = bairroMedian ? (p.price_m2 / bairroMedian.median_m2) - 1 : null;
    const priceRatio = Math.max(.05, Math.min(p.price_m2, cap) / cap);
    const color = relative ? relativeColor(relativeValue) : colorForRatio(priceRatio);
    const radius = relative ? 4.5 : 4;
    L.circleMarker([p.lat, p.lon], {
      radius,
      color: '#334155',
      weight: .7,
      fillColor: color,
      fillOpacity: relative ? .72 : .62
    }).bindTooltip(pointTooltip(p, bairroMedian), {sticky:true})
      .bindPopup(pointTooltip(p, bairroMedian))
      .addTo(layer);
  });
  layer.addTo(map);
  currentLayers.push(layer);
}
function addGrid(points, relative=false) {
  const medians = neighborhoodMedians(points);
  const cell = 0.008;
  const cells = new Map();
  points.forEach(p => {
    const key = `${Math.floor(p.lat / cell)}:${Math.floor(p.lon / cell)}`;
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(p);
  });
  const rows = [...cells.entries()].map(([key, pts]) => {
    const [latIdx, lonIdx] = key.split(':').map(Number);
    const deviations = pts.map(p => {
      const bairroMedian = medians.get(norm(p.neighborhood));
      return bairroMedian ? (p.price_m2 / bairroMedian.median_m2) - 1 : null;
    }).filter(v => v !== null && !Number.isNaN(v));
    return {
      key,
      pts,
      lat1: latIdx * cell,
      lon1: lonIdx * cell,
      lat2: (latIdx + 1) * cell,
      lon2: (lonIdx + 1) * cell,
      n: pts.length,
      median_m2: median(pts.map(p => p.price_m2)),
      median_relative: median(deviations)
    };
  }).filter(c => c.n >= Math.max(2, Math.floor(selectedFilters().minSamples / 2)));
  const priceCap = percentile(rows.map(c => c.median_m2), .95);
  const layer = L.layerGroup();
  rows.forEach(c => {
    const value = relative ? c.median_relative : Math.max(.05, Math.min(c.median_m2, priceCap) / priceCap);
    const fill = relative ? relativeColor(value) : colorForRatio(value);
    L.rectangle([[c.lat1, c.lon1], [c.lat2, c.lon2]], {
      color: '#334155',
      weight: .4,
      fillColor: fill,
      fillOpacity: .48
    }).bindTooltip(`
      <strong>Grade espacial</strong><br>
      Imóveis: ${c.n}<br>
      Mediana preço/m²: ${fmtBRL.format(c.median_m2)}<br>
      Mediana relativa ao bairro: ${pct(c.median_relative)}
    `, {sticky:true}).addTo(layer);
  });
  layer.addTo(map);
  currentLayers.push(layer);
}
function cellDegrees(sizeMeters, latRef=-19.9167) {
  // Aproximação: 1 grau de latitude tem ~111,32 km; longitude varia pelo cosseno da latitude.
  const latDeg = sizeMeters / 111320;
  const lonDeg = sizeMeters / (111320 * Math.cos(latRef * Math.PI / 180));
  return {latDeg, lonDeg};
}
function quadrantKey(p, sizeMeters) {
  const deg = cellDegrees(sizeMeters, p.lat);
  const latIdx = Math.floor(p.lat / deg.latDeg);
  const lonIdx = Math.floor(p.lon / deg.lonDeg);
  return `${latIdx}:${lonIdx}`;
}
function quadrantBounds(key, sizeMeters) {
  const [latIdx, lonIdx] = key.split(':').map(Number);
  const deg = cellDegrees(sizeMeters);
  return {
    lat1: latIdx * deg.latDeg,
    lon1: lonIdx * deg.lonDeg,
    lat2: (latIdx + 1) * deg.latDeg,
    lon2: (lonIdx + 1) * deg.lonDeg
  };
}
function groupQuadrants(points, sizeMeters) {
  const groups = new Map();
  points.forEach(p => {
    const key = quadrantKey(p, sizeMeters);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  });
  return groups;
}
function medianRelativeToNeighborhood(points) {
  const medians = neighborhoodMedians(points);
  const rel = points.map(p => {
    const n = medians.get(norm(p.neighborhood));
    return n ? (p.price_m2 / n.median_m2) - 1 : null;
  }).filter(v => v !== null && !Number.isNaN(v));
  return median(rel);
}
function drawQuadrantDelta() {
  const f = selectedFilters();
  const sizeMeters = Number(document.getElementById('cellSize').value);
  const p2021 = baseFilter(allPoints.filter(p => p.year === 2021));
  const p2026 = baseFilter(allPoints.filter(p => p.year === 2026));
  const g2021 = groupQuadrants(p2021, sizeMeters);
  const g2026 = groupQuadrants(p2026, sizeMeters);
  const layer = L.layerGroup();
  const rows = [];
  for (const [key, oldPts] of g2021.entries()) {
    const newPts = g2026.get(key);
    if (!newPts) continue;
    const n2021 = oldPts.length;
    const n2026 = newPts.length;
    if (n2021 < f.minSamples || n2026 < f.minSamples) continue;
    const m2021 = median(oldPts.map(p => p.price_m2));
    const m2026 = median(newPts.map(p => p.price_m2));
    if (!m2021 || !m2026) continue;
    rows.push({
      key,
      oldPts,
      newPts,
      n2021,
      n2026,
      m2021,
      m2026,
      deltaNominal: m2026 - m2021,
      deltaPct: (m2026 / m2021) - 1,
      city: modeValue([...oldPts, ...newPts].map(p => p.city)),
      neighborhood: modeValue([...oldPts, ...newPts].map(p => p.neighborhood)),
      relativeMedian: medianRelativeToNeighborhood(newPts),
      confidence: confidenceLabel(n2021, n2026, f.minSamples)
    });
  }
  rows.forEach(row => {
    const b = quadrantBounds(row.key, sizeMeters);
    const isLowConfidence = row.confidence === 'moderada';
    const color = deltaColor(row.deltaPct);
    L.rectangle([[b.lat1, b.lon1], [b.lat2, b.lon2]], {
      color: isLowConfidence ? '#64748b' : '#334155',
      weight: isLowConfidence ? 1 : .7,
      dashArray: isLowConfidence ? '4 4' : null,
      fillColor: color,
      fillOpacity: isLowConfidence ? .30 : .48
    }).bindTooltip(`
      <strong>Quadrante ${sizeMeters} m</strong><br>
      Bairro predominante: ${row.neighborhood || 'sem informação'}<br>
      Cidade: ${row.city || 'sem informação'}<br>
      Imóveis 2021: ${row.n2021}<br>
      Imóveis 2026: ${row.n2026}<br>
      Preço/m² 2021: ${fmtBRL.format(row.m2021)}<br>
      Preço/m² 2026: ${fmtBRL.format(row.m2026)}<br>
      Delta nominal: ${row.deltaNominal >= 0 ? '+' : ''}${fmtBRL.format(row.deltaNominal)}/m²<br>
      Delta percentual: <strong>${pct(row.deltaPct)}</strong><br>
      Desvio mediano vs bairro: ${pct(row.relativeMedian)}<br>
      Confiança: ${row.confidence}
    `, {sticky:true}).addTo(layer);
  });
  layer.addTo(map);
  currentLayers.push(layer);
  updateQuadrantStats(rows);
}
function deltaData() {
  const f = selectedFilters();
  const p2021 = baseFilter(allPoints.filter(p => p.year === 2021));
  const p2026 = baseFilter(allPoints.filter(p => p.year === 2026));
  const g2021 = groupByNeighborhood(p2021);
  const g2026 = groupByNeighborhood(p2026);
  const deltas = new Map();
  for (const [key, oldGroup] of g2021.entries()) {
    const newGroup = g2026.get(key);
    if (!newGroup || oldGroup.points.length < f.minSamples || newGroup.points.length < f.minSamples) continue;
    const oldM2 = median(oldGroup.points.map(p => p.price_m2));
    const newM2 = median(newGroup.points.map(p => p.price_m2));
    if (!oldM2 || !newM2) continue;
    deltas.set(key, {
      neighborhood: newGroup.name,
      n2021: oldGroup.points.length,
      n2026: newGroup.points.length,
      m2_2021: oldM2,
      m2_2026: newM2,
      delta: ((newM2 / oldM2) - 1) * 100,
      lat: mean(newGroup.points.map(p => p.lat)),
      lon: mean(newGroup.points.map(p => p.lon))
    });
  }
  return {p2021, p2026, deltas};
}
function addLegend(kind) {
  if (window.legendControl) map.removeControl(window.legendControl);
  window.legendControl = L.control({position:'bottomright'});
  window.legendControl.onAdd = () => {
    const div = L.DomUtil.create('div', 'legend');
    div.innerHTML = kind === 'delta'
      ? '<strong>Delta nominal preço/m²</strong><div class="bar-delta"></div>Azul queda, laranja alta'
      : kind === 'condo'
        ? '<strong>Índice de condominização</strong><div class="bar-condo"></div>Verde baixo, roxo alto'
        : '<strong>Preço por m²</strong><div class="bar-price"></div>Azul menor, coral maior';
    return div;
  };
  window.legendControl.addTo(map);
}
function colorForRatio(ratio) {
  return interpolateColor(priceStops, ratio);
}
function condoIndexColor(value) {
  return interpolateColor(condoStops, Math.max(0, Math.min(0.6, value)) / 0.6);
}
function isCondoIndex() {
  return selectedFilters().rentMetric === 'condo_index';
}
function metricFormat(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return 'sem dado';
  return isCondoIndex() ? `${(value * 100).toFixed(1)}%` : fmtBRL.format(value);
}
function metricColor(value, cap) {
  if (isCondoIndex()) return condoIndexColor(value);
  return colorForRatio(Math.max(.05, Math.min(value, cap) / cap));
}
function rentMetricValue(p) {
  const metric = selectedFilters().rentMetric;
  if (metric === 'rent_total') return p.price;
  if (metric === 'rent_m2') return p.price_m2;
  if (metric === 'condo') return p.condo_fee;
  if (metric === 'condo_index') return p.condo_fee == null || !p.price ? null : p.condo_fee / p.price;
  return p.price;
}
function rentMetricLabel() {
  const metric = selectedFilters().rentMetric;
  if (metric === 'rent_total') return 'aluguel';
  if (metric === 'rent_m2') return 'aluguel/m²';
  if (metric === 'condo') return 'condomínio';
  if (metric === 'condo_index') return 'índice de condominização';
  return 'aluguel';
}
function aggregateRentMetric(points) {
  if (!points.length) return null;
  const metric = selectedFilters().rentMetric;
  if (metric === 'condo_index') {
    const rentVals = points.map(p => p.price).filter(v => v !== null && v !== undefined && !Number.isNaN(v));
    const condoVals = points.map(p => p.condo_fee).filter(v => v !== null && v !== undefined && !Number.isNaN(v));
    const avgRent = mean(rentVals);
    const avgCondo = mean(condoVals);
    return avgRent && avgCondo !== null ? avgCondo / avgRent : null;
  }
  const vals = points.map(p => rentMetricValue(p)).filter(v => v !== null && v !== undefined && !Number.isNaN(v));
  return mean(vals);
}
function rentPopup(p, value) {
  return `
    <strong>${p.neighborhood || 'Sem bairro'}</strong><br>
    Cidade: ${p.city || 'sem cidade'}<br>
    Tipo: ${p.property_type || 'sem tipo'}<br>
    Aluguel: ${fmtBRL.format(p.price)}<br>
    Aluguel/m²: ${fmtBRL.format(p.price_m2)}<br>
    Condomínio: ${p.condo_fee == null ? 'não encontrado' : fmtBRL.format(p.condo_fee)}<br>
    Índice condominização: ${p.condo_fee == null || !p.price ? 'sem dado' : `${((p.condo_fee / p.price) * 100).toFixed(1)}%`}<br>
    Métrica exibida: <strong>${metricFormat(value)}</strong><br>
    Área: ${p.area} m²<br>
    Ano/base: 2026 aluguel<br>
    ${p.address || ''}
  `;
}
function drawPrice(year) {
  clearLayers();
  addLegend('price');
  const f = selectedFilters();
  const points = baseFilter(allPoints.filter(p => p.year === year));
  const cap = percentile(points.map(p => p.price_m2), .95);
  const style = document.getElementById('priceStyle').value;
  if (style === 'heat' || style === 'both') {
    const heat = L.heatLayer(points.map(p => [p.lat, p.lon, Math.max(.05, Math.min(p.price_m2, cap) / cap)]), {
      radius: f.radius, blur: Math.round(f.radius * .95), minOpacity:.13, maxZoom:15,
      gradient: {.05:'#e0f2fe', .18:'#7dd3fc', .35:'#5eead4', .5:'#bef264', .68:'#fde68a', .84:'#fca5a5', 1:'#fb7185'}
    }).addTo(map);
    currentLayers.push(heat);
  }
  if (style === 'bubbles' || style === 'both') {
    const groups = [...groupByNeighborhood(points).values()]
      .filter(g => g.points.length >= f.minSamples)
      .map(g => ({
        name: g.name,
        n: g.points.length,
        lat: mean(g.points.map(p => p.lat)),
        lon: mean(g.points.map(p => p.lon)),
        median_m2: median(g.points.map(p => p.price_m2)),
        median_price: median(g.points.map(p => p.price))
      }));
    const bubbleCap = percentile(groups.map(g => g.median_m2), .95);
    const countCap = percentile(groups.map(g => g.n), .9);
    const bubbleLayer = L.layerGroup();
    groups.forEach(g => {
      const ratio = Math.max(.05, Math.min(g.median_m2, bubbleCap) / bubbleCap);
      const countRatio = Math.min(g.n, countCap) / countCap;
      const radius = 7 + countRatio * 20;
      const fill = colorForRatio(ratio);
      L.circleMarker([g.lat, g.lon], {
        radius,
        color: '#334155',
        weight: 1,
        fillColor: fill,
        fillOpacity: .62
      }).bindTooltip(`${g.name}: ${fmtBRL.format(g.median_m2)}/m²`, {sticky:true})
        .bindPopup(`
          <strong>${g.name}</strong><br>
          Mediana preço/m²: <strong>${fmtBRL.format(g.median_m2)}</strong><br>
          Mediana preço: ${fmtBRL.format(g.median_price)}<br>
          Amostra: ${g.n} imóveis<br>
          Cor = preço/m²; tamanho = quantidade de anúncios.
        `).addTo(bubbleLayer);
    });
    bubbleLayer.addTo(map);
    currentLayers.push(bubbleLayer);
  }
  if (style === 'points_abs') {
    addIndividualPoints(points, false);
  }
  if (style === 'points_relative') {
    addIndividualPoints(points, true);
  }
  if (style === 'grid_price') {
    addGrid(points, false);
  }
  if (style === 'grid_relative') {
    addGrid(points, true);
  }
  updateStats(points, [], year);
  updateNeighborhoodSummary(points, year);
}
function drawRent() {
  clearLayers();
  addLegend(isCondoIndex() ? 'condo' : 'price');
  const f = selectedFilters();
  const points = baseFilter(allPoints.filter(p => p.operation === 'rent'))
    .filter(p => rentMetricValue(p) !== null && rentMetricValue(p) !== undefined && !Number.isNaN(rentMetricValue(p)));
  const values = points.map(p => rentMetricValue(p));
  const cap = percentile(values, .95);
  const style = document.getElementById('priceStyle').value;
  if (style === 'heat' || style === 'both') {
    const heat = L.heatLayer(points.map(p => [p.lat, p.lon, Math.max(.05, Math.min(rentMetricValue(p), cap) / cap)]), {
      radius: f.radius, blur: Math.round(f.radius * .95), minOpacity:.13, maxZoom:15,
      gradient: isCondoIndex()
        ? {.05:'#16a34a', .18:'#84cc16', .36:'#facc15', .55:'#fb923c', .72:'#c084fc', .88:'#7e22ce', 1:'#3b0764'}
        : {.05:'#e0f2fe', .18:'#7dd3fc', .35:'#5eead4', .5:'#bef264', .68:'#fde68a', .84:'#fca5a5', 1:'#fb7185'}
    }).addTo(map);
    currentLayers.push(heat);
  }
  if (style === 'bubbles' || style === 'both') {
    const groups = [...groupByNeighborhood(points).values()]
      .filter(g => g.points.length >= f.minSamples)
      .map(g => {
        const avg = aggregateRentMetric(g.points);
        return {
          name: g.name,
          n: g.points.length,
          lat: mean(g.points.map(p => p.lat)),
          lon: mean(g.points.map(p => p.lon)),
          avg
        };
      }).filter(g => g.n >= f.minSamples && g.avg !== null);
    const bubbleCap = percentile(groups.map(g => g.avg), .95);
    const countCap = percentile(groups.map(g => g.n), .9);
    const bubbleLayer = L.layerGroup();
    groups.forEach(g => {
      const ratio = Math.max(.05, Math.min(g.avg, bubbleCap) / bubbleCap);
      const radius = 7 + (Math.min(g.n, countCap) / countCap) * 20;
      L.circleMarker([g.lat, g.lon], {
        radius,
        color: '#334155',
        weight: 1,
        fillColor: metricColor(g.avg, bubbleCap),
        fillOpacity: .62
      }).bindTooltip(`${g.name}: ${metricFormat(g.avg)} (${rentMetricLabel()})`, {sticky:true})
        .bindPopup(`<strong>${g.name}</strong><br>${rentMetricLabel()}: <strong>${metricFormat(g.avg)}</strong><br>Amostra: ${g.n} imóveis`)
        .addTo(bubbleLayer);
    });
    bubbleLayer.addTo(map);
    currentLayers.push(bubbleLayer);
  }
  if (style === 'points_abs' || style === 'points_relative') {
    const layer = L.layerGroup();
    points.forEach(p => {
      const value = rentMetricValue(p);
      const ratio = Math.max(.05, Math.min(value, cap) / cap);
      L.circleMarker([p.lat, p.lon], {
        radius: 4.3,
        color: '#334155',
        weight: .7,
        fillColor: metricColor(value, cap),
        fillOpacity: .68
      }).bindTooltip(rentPopup(p, value), {sticky:true}).bindPopup(rentPopup(p, value)).addTo(layer);
    });
    layer.addTo(map);
    currentLayers.push(layer);
  }
  if (style === 'grid_price' || style === 'grid_relative') {
    addRentGrid(points);
  }
  updateRentStats(points);
}
function addRentGrid(points) {
  const sizeMeters = Number(document.getElementById('cellSize').value);
  const groups = groupQuadrants(points, sizeMeters);
  const rows = [...groups.entries()].map(([key, pts]) => {
    const avg = aggregateRentMetric(pts);
    return {key, pts, n: pts.length, avg};
  }).filter(row => row.n >= Math.max(2, Math.floor(selectedFilters().minSamples / 2)) && row.avg !== null);
  const cap = percentile(rows.map(r => r.avg), .95);
  const layer = L.layerGroup();
  rows.forEach(row => {
    const b = quadrantBounds(row.key, sizeMeters);
    const ratio = Math.max(.05, Math.min(row.avg, cap) / cap);
    L.rectangle([[b.lat1, b.lon1], [b.lat2, b.lon2]], {
      color: '#334155',
      weight: .45,
      fillColor: metricColor(row.avg, cap),
      fillOpacity: .45
    }).bindTooltip(`
      <strong>Quadrante aluguel ${sizeMeters} m</strong><br>
      Imóveis: ${row.n}<br>
      ${rentMetricLabel()}: <strong>${metricFormat(row.avg)}</strong>
    `, {sticky:true}).addTo(layer);
  });
  layer.addTo(map);
  currentLayers.push(layer);
}
function updateRentStats(points) {
  const vals = points.map(p => rentMetricValue(p)).filter(v => v !== null && v !== undefined && !Number.isNaN(v));
  const rentVals = points.map(p => p.price);
  const rentM2Vals = points.map(p => p.price_m2);
  const condoVals = points.map(p => p.condo_fee).filter(v => v !== null && v !== undefined && !Number.isNaN(v));
  const condoIndex = mean(rentVals) && condoVals.length ? mean(condoVals) / mean(rentVals) : null;
  document.getElementById('stats').innerHTML = `
    <div class="stat"><strong>${fmtNum.format(points.length)}</strong>aluguéis filtrados</div>
    <div class="stat"><strong>${fmtBRL.format(mean(rentVals) || 0)}</strong>aluguel médio</div>
    <div class="stat"><strong>${fmtBRL.format(mean(rentM2Vals) || 0)}</strong>aluguel médio/m²</div>
    <div class="stat"><strong>${condoVals.length ? fmtBRL.format(mean(condoVals)) : 'sem dado'}</strong>condomínio médio</div>
    <div class="stat" style="grid-column:1/-1"><strong>${metricFormat(condoIndex)}</strong>índice de condominização: condomínio médio / aluguel médio</div>`;
  document.getElementById('neighborhoodSummary').innerHTML = '';
  const groups = [...groupByNeighborhood(points).values()].map(g => {
    return {name:g.name, n:g.points.length, avg:aggregateRentMetric(g.points)};
  }).filter(g => g.n >= selectedFilters().minSamples && g.avg !== null).sort((a,b) => b.avg - a.avg).slice(0,14);
  document.getElementById('ranking').innerHTML = groups.map(g => `<li><span>${g.name} <small>(${g.n})</small></span><span>${metricFormat(g.avg)}</span></li>`).join('');
  document.getElementById('note').textContent = isCondoIndex()
    ? 'Índice de condominização = condomínio médio da área dividido pelo aluguel médio da área. Roxo indica áreas onde o condomínio pesa mais no custo mensal.'
    : 'Camada de aluguel usa anúncios do QuintoAndar raspados em CSV separado. Condomínio depende do campo estar disponível na página.';
}
function drawDelta() {
  clearLayers();
  addLegend('delta');
  const f = selectedFilters();
  const {p2021, p2026, deltas} = deltaData();
  const deltaValues = [...deltas.values()];
  const points = p2026.filter(p => deltas.has(norm(p.neighborhood)));
  const absCap = percentile(deltaValues.map(d => Math.abs(d.delta)), .9);
  const style = document.getElementById('deltaStyle').value;
  if (style === 'quadrants') {
    drawQuadrantDelta();
    updateStats(points, deltaValues, 'delta', p2021, p2026);
    updateNeighborhoodSummary(points, 'delta');
    return;
  }
  if (style === 'heat' || style === 'both') {
    const positive = points.filter(p => deltas.get(norm(p.neighborhood)).delta > 0)
      .map(p => [p.lat, p.lon, Math.min(Math.abs(deltas.get(norm(p.neighborhood)).delta), absCap) / absCap]);
    const negative = points.filter(p => deltas.get(norm(p.neighborhood)).delta < 0)
      .map(p => [p.lat, p.lon, Math.min(Math.abs(deltas.get(norm(p.neighborhood)).delta), absCap) / absCap]);
    const posLayer = L.heatLayer(positive, {radius:f.radius, blur:Math.round(f.radius), minOpacity:.13, maxZoom:15, gradient:{.15:'#fff7ed', .35:'#fed7aa', .55:'#fdba74', .75:'#fb923c', 1:'#dc2626'}}).addTo(map);
    const negLayer = L.heatLayer(negative, {radius:f.radius, blur:Math.round(f.radius), minOpacity:.13, maxZoom:15, gradient:{.15:'#eff6ff', .35:'#bfdbfe', .55:'#93c5fd', .75:'#60a5fa', 1:'#1d4ed8'}}).addTo(map);
    currentLayers.push(posLayer, negLayer);
  }
  if (style === 'bubbles' || style === 'both') {
    const bubbleLayer = L.layerGroup();
    deltaValues.forEach(d => {
      const intensity = Math.min(Math.abs(d.delta), absCap) / absCap;
      const radius = 6 + intensity * 24;
      const isUp = d.delta >= 0;
      const color = isUp ? '#c2410c' : '#1d4ed8';
      const fill = isUp ? '#fb923c' : '#60a5fa';
      L.circleMarker([d.lat, d.lon], {
        radius,
        color,
        weight: 1.5,
        fillColor: fill,
        fillOpacity: 0.48
      }).bindTooltip(`${d.neighborhood}: ${d.delta >= 0 ? '+' : ''}${d.delta.toFixed(1)}%`, {sticky:true})
        .bindPopup(`
          <strong>${d.neighborhood}</strong><br>
          Delta preço/m²: <strong>${d.delta >= 0 ? '+' : ''}${d.delta.toFixed(2)}%</strong><br>
          2021: ${fmtBRL.format(d.m2_2021)}/m², n=${d.n2021}<br>
          2026: ${fmtBRL.format(d.m2_2026)}/m², n=${d.n2026}<br>
          Tamanho da bolha proporcional ao módulo da mudança.
        `).addTo(bubbleLayer);
    });
    bubbleLayer.addTo(map);
    currentLayers.push(bubbleLayer);
  }
  updateStats(points, deltaValues, 'delta', p2021, p2026);
  updateNeighborhoodSummary(points, 'delta');
}
function updateStats(points, deltas, currentMode, p2021=[], p2026=[]) {
  const medM2 = median(points.map(p => p.price_m2));
  const medPrice = median(points.map(p => p.price));
  if (currentMode === 'delta') {
    const up = deltas.filter(d => d.delta > 0).length;
    const down = deltas.filter(d => d.delta < 0).length;
    document.getElementById('stats').innerHTML = `
      <div class="stat"><strong>${fmtNum.format(points.length)}</strong>pontos 2026 no delta</div>
      <div class="stat"><strong>${fmtNum.format(deltas.length)}</strong>bairros comparáveis</div>
      <div class="stat"><strong>${up}</strong>bairros em alta</div>
      <div class="stat"><strong>${down}</strong>bairros em queda</div>`;
    const ordered = deltas.sort((a,b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, 14);
    document.getElementById('ranking').innerHTML = ordered.map(d => `<li><span>${d.neighborhood}</span><span class="${d.delta >= 0 ? 'pos':'neg'}">${d.delta >= 0 ? '+' : ''}${d.delta.toFixed(1)}%</span></li>`).join('');
    document.getElementById('note').textContent = 'Delta calculado pela mediana do preço/m² por bairro. Para comparação mais justa, use Tipo = Apartamentos.';
  } else {
    document.getElementById('stats').innerHTML = `
      <div class="stat"><strong>${fmtNum.format(points.length)}</strong>imóveis filtrados</div>
      <div class="stat"><strong>${fmtBRL.format(medM2 || 0)}</strong>mediana preço/m²</div>
      <div class="stat"><strong>${fmtBRL.format(medPrice || 0)}</strong>mediana preço</div>
      <div class="stat"><strong>${currentMode}</strong>ano exibido</div>`;
    const groups = groupByNeighborhood(points);
    const ranking = [...groups.values()].map(g => ({name:g.name, n:g.points.length, m2:median(g.points.map(p => p.price_m2))}))
      .filter(g => g.n >= 5).sort((a,b) => b.m2 - a.m2).slice(0,14);
    document.getElementById('ranking').innerHTML = ranking.map(g => `<li><span>${g.name} <small>(${g.n})</small></span><span>${fmtBRL.format(g.m2)}</span></li>`).join('');
    document.getElementById('note').textContent = currentMode === 2021 ? 'A base 2021 foi tratada como apartamentos, pois não tem coluna de tipo.' : 'A base 2026 vem de anúncios de venda do QuintoAndar.';
  }
}
function pctl(values, fraction) {
  return percentile(values, fraction);
}
function updateNeighborhoodSummary(points, currentMode) {
  const f = selectedFilters();
  const box = document.getElementById('neighborhoodSummary');
  if (f.neighborhood === 'all') {
    box.innerHTML = '';
    return;
  }
  const selected = points.filter(p => p.neighborhood === f.neighborhood);
  if (selected.length < f.minSamples) {
    box.innerHTML = `<div class="stat" style="grid-column:1/-1"><strong>${selected.length}</strong>Amostra insuficiente para análise confiável neste bairro.</div>`;
    return;
  }
  const values = selected.map(p => p.price_m2).sort((a,b) => a-b);
  const med = median(values);
  const avg = mean(values);
  const min = values[0];
  const max = values[values.length - 1];
  const p25 = pctl(values, .25);
  const p75 = pctl(values, .75);
  const cityPoints = allPoints.filter(p => {
    const targetYear = currentMode === 'delta' ? 2026 : currentMode;
    if (p.year !== targetYear) return false;
    if (f.type !== 'all' && p.property_type !== f.type) return false;
    if (f.city !== 'all' && p.city !== f.city) return false;
    return true;
  });
  const cityMed = cityMedian(cityPoints);
  const cityDiff = cityMed ? (med / cityMed) - 1 : null;
  const delta = deltaData().deltas.get(norm(f.neighborhood));
  box.innerHTML = `
    <div class="stat"><strong>${fmtNum.format(selected.length)}</strong>imóveis no bairro</div>
    <div class="stat"><strong>${fmtBRL.format(med)}</strong>mediana preço/m²</div>
    <div class="stat"><strong>${fmtBRL.format(avg)}</strong>média preço/m²</div>
    <div class="stat"><strong>${fmtBRL.format(min)}</strong>menor preço/m²</div>
    <div class="stat"><strong>${fmtBRL.format(max)}</strong>maior preço/m²</div>
    <div class="stat"><strong>${fmtBRL.format(p25)} / ${fmtBRL.format(p75)}</strong>P25 / P75</div>
    <div class="stat"><strong>${fmtBRL.format(max - min)}</strong>amplitude interna</div>
    <div class="stat"><strong>${pct(cityDiff)}</strong>vs mediana da cidade</div>
    <div class="stat" style="grid-column:1/-1"><strong>${delta ? pct(delta.delta / 100) : 'sem delta'}</strong>delta 2021-2026 no bairro</div>
  `;
}
function updateQuadrantStats(rows) {
  const box = document.getElementById('neighborhoodSummary');
  if (!rows.length) {
    box.innerHTML = `<div class="stat" style="grid-column:1/-1"><strong>0</strong>Nenhum quadrante com amostra suficiente para o filtro atual.</div>`;
    return;
  }
  const deltas = rows.map(r => r.deltaPct);
  const up = rows.filter(r => r.deltaPct > .1).length;
  const down = rows.filter(r => r.deltaPct < -.1).length;
  const stable = rows.length - up - down;
  const best = [...rows].sort((a,b) => b.deltaPct - a.deltaPct)[0];
  const worst = [...rows].sort((a,b) => a.deltaPct - b.deltaPct)[0];
  box.innerHTML = `
    <div class="stat"><strong>${rows.length}</strong>quadrantes exibidos</div>
    <div class="stat"><strong>${pct(median(deltas))}</strong>delta mediano</div>
    <div class="stat"><strong>${up}</strong>quadrantes em alta</div>
    <div class="stat"><strong>${down}</strong>quadrantes em queda</div>
    <div class="stat"><strong>${stable}</strong>quadrantes estáveis</div>
    <div class="stat"><strong>${best.neighborhood || '-'}</strong>maior alta: ${pct(best.deltaPct)}</div>
    <div class="stat" style="grid-column:1/-1"><strong>${worst.neighborhood || '-'}</strong>maior queda: ${pct(worst.deltaPct)}</div>
  `;
}
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({
    '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'
  })[character]);
}
function safeExternalLink(value) {
  if (!value) return '';
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    return `<a href="${escapeHtml(url.href)}" target="_blank" rel="noopener noreferrer">Abrir anúncio</a>`;
  } catch {
    return '';
  }
}
function localDateLabel(value) {
  if (!value) return 'sem data';
  const date = new Date(`${value.slice(0, 10)}T12:00:00`);
  return Number.isNaN(date.valueOf()) ? escapeHtml(value) : date.toLocaleDateString('pt-BR');
}
function renderCollectionStatus() {
  const banner = document.getElementById('collectionStatus');
  const health = publicMeta?.health?.status || 'unknown';
  const lastSuccess = publicMeta?.last_successful_update
    ? new Date(publicMeta.last_successful_update).toLocaleString('pt-BR')
    : null;
  const failedSource = publicMeta?.sources?.find(source => source.status === 'failed');
  const presentations = {
    healthy: ['success', 'Dados atualizados', lastSuccess ? `Última coleta válida em ${lastSuccess}.` : 'A coleta diária está saudável.'],
    success: ['success', 'Dados atualizados', lastSuccess ? `Última coleta válida em ${lastSuccess}.` : 'A coleta diária está saudável.'],
    degraded: ['degraded', 'Atualização parcial', 'A base válida foi preservada enquanto uma fonte requer atenção.'],
    running: ['running', 'Coleta em andamento', 'Os novos dados serão publicados depois da validação.'],
    failed: [
      'failed',
      lastSuccess ? 'Última coleta não concluída' : 'Primeira coleta não concluída',
      failedSource?.failure_type
        ? `A base publicada foi preservada. Falha: ${failedSource.failure_type}.`
        : 'A base publicada foi preservada e a fonte requer atenção.'
    ],
    unknown: ['degraded', 'Aguardando dados diários', 'O histórico de 2021 e 2026 continua disponível.']
  };
  const [state, title, detail] = presentations[health] || presentations.unknown;
  banner.dataset.state = state;
  banner.innerHTML = `<span class="status-dot" aria-hidden="true"></span><span><strong>${escapeHtml(title)}</strong><small>${escapeHtml(detail)}</small></span>`;
}
function listingHistorySvg(history) {
  const points = (history || []).filter(item => Number.isFinite(item.price));
  if (points.length < 2) return '';
  const values = points.map(item => item.price);
  const low = Math.min(...values), high = Math.max(...values);
  const span = high - low || 1;
  const path = values.map((value, index) => {
    const x = (index / (values.length - 1)) * 120;
    const y = 30 - ((value - low) / span) * 24;
    return `${index ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  return `<svg class="price-history-chart" viewBox="0 0 120 34" role="img" aria-label="Histórico de preço do aluguel"><path d="${path}" fill="none" stroke="#0f766e" stroke-width="2.5"/><circle cx="120" cy="${(30 - ((values.at(-1) - low) / span) * 24).toFixed(1)}" r="3" fill="#0f766e"/></svg>`;
}
function listingPopup(listing) {
  const history = Array.isArray(listing.price_history) ? listing.price_history : [];
  const historyRows = history.map(point => `
    <li>${localDateLabel(point.observed_at)}: ${point.price == null ? 'sem valor' : fmtBRL.format(point.price)}${point.condo_fee == null ? '' : ` · condomínio ${fmtBRL.format(point.condo_fee)}`}</li>
  `).join('');
  const historyMarkup = history.length
    ? `${listingHistorySvg(history)}<ul class="popup-history">${historyRows}</ul>`
    : '<small>Sem alterações de preço registradas.</small>';
  return `
    <strong>${escapeHtml(listing.title || 'Anúncio de aluguel')}</strong><br>
    ${escapeHtml(listing.neighborhood || 'Sem bairro')}, ${escapeHtml(listing.city || 'sem cidade')}<br>
    Aluguel atual: <strong>${listing.price == null ? 'sem valor' : fmtBRL.format(listing.price)}</strong><br>
    Aluguel/m²: ${listing.price_m2 == null ? 'sem dado' : fmtBRL.format(listing.price_m2)}<br>
    Localização: ${listing.location_precision === 'neighborhood' ? 'aproximada pelo centro do bairro' : 'informada no anúncio'}<br>
    Observado desde: ${localDateLabel(listing.first_seen_at)}<br>
    Última observação: ${localDateLabel(listing.last_seen_at)}<br>
    Tempo acompanhado: ${fmtNum.format(listing.days_listed || 0)} dias<br>
    Fonte: ${escapeHtml(listing.source || 'sem informação')}<br>
    ${historyMarkup}<br>${safeExternalLink(listing.url)}
  `;
}
const dailyMetricLabels = {
  median_price_m2:'mediana do aluguel/m²', active:'oferta ativa', new:'novos anúncios',
  removed:'anúncios retirados', price_reduced:'reduções de preço',
  price_increased:'aumentos de preço', variation_7d:'variação em 7 dias', variation_30d:'variação em 30 dias'
};
const eventTypesByMetric = {
  new:'new', removed:'removed', price_reduced:'price_reduced', price_increased:'price_increased'
};
function currentDailyFilters() {
  return {
    city:document.getElementById('cityFilter').value,
    neighborhood:document.getElementById('neighborhoodFilter').value
  };
}
function matchesDailyArea(item, filters) {
  if (filters.city !== 'all' && norm(item.city) !== norm(filters.city)) return false;
  if (filters.neighborhood !== 'all' && norm(item.neighborhood) !== norm(filters.neighborhood)) return false;
  return true;
}
function formatDailyMetric(value, metric) {
  if (value == null || !Number.isFinite(Number(value))) return 'sem dado';
  if (metric === 'median_price_m2') return `${fmtBRL.format(value)}/m²`;
  if (metric.startsWith('variation_')) return pct(Number(value));
  return fmtNum.format(value);
}
function eventPopup(event) {
  const titles = {new:'Novo anúncio', removed:'Anúncio retirado', price_reduced:'Redução de preço', price_increased:'Aumento de preço'};
  const change = event.change_pct == null ? '' : `<br>Variação: <strong>${pct(event.change_pct)}</strong>`;
  const prices = event.old_price == null && event.new_price == null ? ''
    : `<br>Preço anterior: ${event.old_price == null ? '—' : fmtBRL.format(event.old_price)}<br>Preço observado: ${event.new_price == null ? '—' : fmtBRL.format(event.new_price)}${change}`;
  return `<strong>${titles[event.type] || 'Evento do anúncio'}</strong><br>
    ${escapeHtml(event.title || 'Anúncio de aluguel')}<br>
    ${escapeHtml(event.neighborhood || 'Sem bairro')}, ${escapeHtml(event.city || 'sem cidade')}<br>
    Data: ${localDateLabel(event.date)}<br>Fonte: ${escapeHtml(event.source || 'sem informação')}<br>
    Localização: ${event.location_precision === 'neighborhood' ? 'aproximada pelo centro do bairro' : 'informada no anúncio'}${prices}<br>
    ${safeExternalLink(event.url)}`;
}
function dailyNeighborhoodPopup(row) {
  return `<strong>${escapeHtml(row.neighborhood || 'Sem bairro')}</strong><br>
    Cidade: ${escapeHtml(row.city || 'sem cidade')}<br>
    Oferta ativa: ${fmtNum.format(row.active || 0)}<br>
    Mediana aluguel: ${row.median_rent == null ? 'sem dado' : fmtBRL.format(row.median_rent)}<br>
    Mediana aluguel/m²: ${row.median_price_m2 == null ? 'sem dado' : `${fmtBRL.format(row.median_price_m2)}/m²`}<br>
    P25 / P75 aluguel/m²: ${row.p25_price_m2 == null ? 'sem dado' : `${fmtBRL.format(row.p25_price_m2)} / ${fmtBRL.format(row.p75_price_m2)}`}<br>
    Novos: ${fmtNum.format(row.new || 0)} · retirados: ${fmtNum.format(row.removed || 0)}<br>
    Reduções: ${fmtNum.format(row.price_reduced || 0)} · aumentos: ${fmtNum.format(row.price_increased || 0)}<br>
    Variação 7d / 30d: ${pct(row.variation_7d)} / ${pct(row.variation_30d)}`;
}
function drawDailyNeighborhoods(rows, metric) {
  const usable = rows.filter(row => Number.isFinite(row.lat) && Number.isFinite(row.lon)
    && row[metric] != null && Number.isFinite(Number(row[metric])));
  if (!usable.length) return 0;
  const values = usable.map(row => Number(row[metric]));
  const low = Math.min(...values), high = Math.max(...values);
  const layer = L.layerGroup();
  usable.forEach(row => {
    const value = Number(row[metric]);
    const relative = high === low ? .5 : (value - low) / (high - low);
    const color = metric.startsWith('variation_') ? deltaColor(value)
      : metric === 'active' ? '#0f766e'
        : colorForRatio(Math.max(.05, relative));
    const radius = metric === 'active'
      ? 6 + Math.min(20, Math.sqrt(Math.max(0, Number(row.active) || 0)) * 1.8)
      : 8 + Math.min(13, Math.sqrt(Math.abs(value)) * 1.3);
    L.circleMarker([row.lat, row.lon], {
      radius, color:'#334155', weight:1, fillColor:color, fillOpacity:.68
    }).bindTooltip(`${escapeHtml(row.neighborhood || 'Sem bairro')}: ${formatDailyMetric(value, metric)}`, {sticky:true})
      .bindPopup(dailyNeighborhoodPopup(row)).addTo(layer);
  });
  layer.addTo(map);
  currentLayers.push(layer);
  return usable.length;
}
function drawCurrentRentalListings(listings) {
  const located = listings.filter(item => Number.isFinite(item.lat) && Number.isFinite(item.lon));
  const layer = L.layerGroup();
  const cap = percentile(located.map(item => item.price_m2).filter(Number.isFinite), .95) || 1;
  located.forEach(item => {
    const color = colorForRatio(Math.max(.05, Math.min(item.price_m2 || 0, cap) / cap));
    const popup = listingPopup(item);
    L.circleMarker([item.lat, item.lon], {
      radius:5, color:'#334155', weight:.7, fillColor:color, fillOpacity:.72
    }).bindTooltip(`${escapeHtml(item.neighborhood || 'Sem bairro')} · ${item.price == null ? 'sem preço' : fmtBRL.format(item.price)}`, {sticky:true})
      .bindPopup(popup, {maxWidth:330}).addTo(layer);
  });
  layer.addTo(map);
  currentLayers.push(layer);
  return located.length;
}
function dailySummary(rows, selectedDate, metric) {
  const totals = rows.reduce((sum, row) => {
    for (const field of ['active', 'new', 'removed', 'price_reduced', 'price_increased']) sum[field] += Number(row[field]) || 0;
    return sum;
  }, {active:0, new:0, removed:0, price_reduced:0, price_increased:0});
  const neighborhoodMedians = rows.map(row => row.median_price_m2).filter(Number.isFinite);
  const lastSuccess = publicMeta?.last_successful_update
    ? new Date(publicMeta.last_successful_update).toLocaleString('pt-BR') : 'sem coleta válida';
  const sourceHealth = publicMeta?.health?.sources || {};
  const sourceHealthText = publicMeta?.sources?.length
    ? `${sourceHealth.healthy || 0} saudáveis · ${sourceHealth.degraded || 0} atenção · ${sourceHealth.failed || 0} falhas · ${sourceHealth.running || 0} em execução`
    : 'sem coleta';
  document.getElementById('stats').innerHTML = `
    <div class="stat"><strong>${fmtNum.format(totals.active)}</strong>anúncios ativos</div>
    <div class="stat"><strong>${fmtNum.format(totals.new)}</strong>novos anúncios</div>
    <div class="stat"><strong>${fmtNum.format(totals.removed)}</strong>retirados</div>
    <div class="stat"><strong>${fmtNum.format(totals.price_reduced)}</strong>reduções de preço</div>
    <div class="stat"><strong>${neighborhoodMedians.length ? `${fmtBRL.format(median(neighborhoodMedians))}/m²` : 'sem dado'}</strong>mediana das medianas dos bairros</div>
    <div class="stat"><strong>${escapeHtml(lastSuccess)}</strong>última coleta válida</div>
    <div class="stat"><strong>${escapeHtml(sourceHealthText)}</strong>saúde das fontes</div>`;

  const compareDate = document.getElementById('dailyCompareDate').value;
  const compareBox = document.getElementById('compareSummary');
  if (compareDate && compareDate !== selectedDate) {
    const compareRows = neighborhoodDaily.filter(row => row.date === compareDate && matchesDailyArea(row, currentDailyFilters()));
    const comparison = dailyRows => ({
      active:dailyRows.reduce((sum, row) => sum + (Number(row.active) || 0), 0),
      new:dailyRows.reduce((sum, row) => sum + (Number(row.new) || 0), 0),
      removed:dailyRows.reduce((sum, row) => sum + (Number(row.removed) || 0), 0),
      medianM2:median(dailyRows.map(row => row.median_price_m2).filter(Number.isFinite)),
      medianRent:median(dailyRows.map(row => row.median_rent).filter(Number.isFinite))
    });
    const current = comparison(rows);
    const earlier = comparison(compareRows);
    const change = (next, previous) => previous ? pct((next / previous) - 1) : 'sem base';
    compareBox.hidden = false;
    compareBox.innerHTML = compareRows.length ? `
      <div class="stat comparison-title" style="grid-column:1/-1"><strong>${localDateLabel(selectedDate)} ↔ ${localDateLabel(compareDate)}</strong>Comparação da área filtrada</div>
      <div class="stat"><strong>${fmtNum.format(current.active)} ↔ ${fmtNum.format(earlier.active)}</strong>ativos: data principal ↔ comparação</div>
      <div class="stat"><strong>${change(current.active, earlier.active)}</strong>mudança na oferta ativa</div>
      <div class="stat"><strong>${current.medianM2 == null ? 'sem dado' : fmtBRL.format(current.medianM2)} ↔ ${earlier.medianM2 == null ? 'sem dado' : fmtBRL.format(earlier.medianM2)}</strong>mediana das medianas de aluguel/m²</div>
      <div class="stat"><strong>${current.medianM2 == null || earlier.medianM2 == null ? 'sem base' : change(current.medianM2, earlier.medianM2)}</strong>mudança na mediana das medianas</div>
      <div class="stat"><strong>${fmtNum.format(current.new)} ↔ ${fmtNum.format(earlier.new)}</strong>novos anúncios: principal ↔ comparação</div>
      <div class="stat"><strong>${fmtNum.format(current.removed)} ↔ ${fmtNum.format(earlier.removed)}</strong>retirados: principal ↔ comparação</div>`
      : `<div class="stat" style="grid-column:1/-1"><strong>${localDateLabel(compareDate)}</strong>Sem dados para a data de comparação com os filtros atuais.</div>`;
  } else {
    compareBox.hidden = true;
    compareBox.innerHTML = '';
  }

  const filters = currentDailyFilters();
  const selectedRows = filters.neighborhood === 'all' ? [] : rows.filter(row =>
    norm(row.neighborhood) === norm(filters.neighborhood));
  const summary = document.getElementById('neighborhoodSummary');
  if (!selectedRows.length) {
    summary.innerHTML = `<div class="stat" style="grid-column:1/-1"><strong>${escapeHtml(localDateLabel(selectedDate))}</strong>Selecione um bairro para ver suas métricas diárias.</div>`;
  } else {
    const medRent = median(selectedRows.map(row => row.median_rent).filter(Number.isFinite));
    const medM2 = median(selectedRows.map(row => row.median_price_m2).filter(Number.isFinite));
    const p25 = median(selectedRows.map(row => row.p25_price_m2).filter(Number.isFinite));
    const p75 = median(selectedRows.map(row => row.p75_price_m2).filter(Number.isFinite));
    const total = field => selectedRows.reduce((sum, row) => sum + (Number(row[field]) || 0), 0);
    summary.innerHTML = `
      <div class="stat"><strong>${fmtNum.format(total('active'))}</strong>ativos no bairro</div>
      <div class="stat"><strong>${medRent == null ? 'sem dado' : fmtBRL.format(medRent)}</strong>mediana do aluguel</div>
      <div class="stat"><strong>${medM2 == null ? 'sem dado' : `${fmtBRL.format(medM2)}/m²`}</strong>mediana do aluguel/m²</div>
      <div class="stat"><strong>${p25 == null ? 'sem dado' : `${fmtBRL.format(p25)} / ${fmtBRL.format(p75)}`}</strong>P25 / P75 por bairro</div>
      <div class="stat"><strong>${pct(median(selectedRows.map(row => row.variation_7d).filter(Number.isFinite)))}</strong>variação em 7 dias</div>
      <div class="stat"><strong>${pct(median(selectedRows.map(row => row.variation_30d).filter(Number.isFinite)))}</strong>variação em 30 dias</div>
      <div class="stat"><strong>${fmtNum.format(total('new'))} / ${fmtNum.format(total('removed'))}</strong>novos / retirados</div>
      <div class="stat"><strong>${fmtNum.format(total('price_reduced'))} / ${fmtNum.format(total('price_increased'))}</strong>reduções / aumentos</div>`;
  }
  const ordered = [...rows].filter(row => row.neighborhood && row[metric] != null && Number.isFinite(Number(row[metric])))
    .sort((a,b) => metric.startsWith('variation_')
      ? Math.abs(Number(b[metric])) - Math.abs(Number(a[metric]))
      : Number(b[metric]) - Number(a[metric])).slice(0, 14);
  document.getElementById('rankingLabel').textContent = `Bairros · ${dailyMetricLabels[metric] || metric}`;
  document.getElementById('ranking').innerHTML = ordered.map(row =>
    `<li><span>${escapeHtml(row.neighborhood)} <small>(${fmtNum.format(row.active || 0)} ativos)</small></span><span>${escapeHtml(formatDailyMetric(Number(row[metric]), metric))}</span></li>`
  ).join('') || '<li>Sem dados para esta data e métrica.</li>';
}
function drawDaily() {
  clearLayers();
  if (window.legendControl) map.removeControl(window.legendControl);
  const selectedDate = document.getElementById('dailyDate').value;
  const metric = document.getElementById('dailyMetric').value;
  const filters = currentDailyFilters();
  const rows = neighborhoodDaily.filter(row => row.date === selectedDate && matchesDailyArea(row, filters));
  const dateEvents = listingEvents.filter(event => event.date === selectedDate && matchesDailyArea(event, filters));
  const latestDate = neighborhoodDaily.reduce((latest, row) => row.date > latest ? row.date : latest, '');
  let plotted = 0;
  if (eventTypesByMetric[metric]) {
    const matching = dateEvents.filter(event => event.type === eventTypesByMetric[metric]);
    const color = {new:'#15803d', removed:'#b91c1c', price_reduced:'#c2410c', price_increased:'#1d4ed8'}[metric];
    const layer = L.layerGroup();
    matching.filter(event => Number.isFinite(event.lat) && Number.isFinite(event.lon)).forEach(event => {
      L.circleMarker([event.lat, event.lon], {
        radius:7, color:'#fff', weight:1.4, fillColor:color, fillOpacity:.85
      }).bindTooltip(`${escapeHtml(event.neighborhood || 'Sem bairro')} · ${dailyMetricLabels[metric]}`, {sticky:true})
        .bindPopup(eventPopup(event), {maxWidth:320}).addTo(layer);
      plotted++;
    });
    layer.addTo(map);
    currentLayers.push(layer);
  } else if (metric === 'active' && selectedDate === latestDate) {
    const listings = currentListings.filter(item => item.available && matchesDailyArea(item, filters));
    plotted = drawCurrentRentalListings(listings);
  } else {
    plotted = drawDailyNeighborhoods(rows, metric);
  }
  dailySummary(rows, selectedDate, metric);
  const lastSuccess = publicMeta?.last_successful_update
    ? new Date(publicMeta.last_successful_update).toLocaleString('pt-BR') : 'sem coleta válida';
  const collectionFailed = publicMeta?.health?.status === 'failed';
  document.getElementById('note').textContent = rows.length
    ? `${localDateLabel(selectedDate)} · ${plotted} elementos no mapa. Bolhas históricas representam médias de localização por bairro; anúncios individuais aparecem no dia mais recente. Última coleta válida: ${lastSuccess}.`
    : collectionFailed
      ? 'A coleta diária não produziu uma base válida. O histórico de 2021 e 2026 continua disponível enquanto a fonte é corrigida.'
      : `Sem dados diários para ${localDateLabel(selectedDate)} com os filtros atuais.`;
}
function redraw() {
  const historical = viewFamily === 'historical';
  document.getElementById('historicalControls').hidden = !historical;
  document.getElementById('historicalControlsDetails').hidden = !historical;
  document.getElementById('dailyControls').hidden = historical;
  document.getElementById('typeFilterWrap').hidden = !historical;
  document.getElementById('typeFilterWrap').parentElement.style.gridTemplateColumns = historical ? '' : '1fr';
  document.getElementById('familyHistorical').classList.toggle('active', historical);
  document.getElementById('familyDaily').classList.toggle('active', !historical);
  document.getElementById('familyHistorical').setAttribute('aria-selected', String(historical));
  document.getElementById('familyDaily').setAttribute('aria-selected', String(!historical));
  if (!historical) {
    document.getElementById('rankingLabel').textContent = 'Bairros · mercado diário';
    drawDaily();
    return;
  }
  document.getElementById('rankingLabel').textContent = 'Maiores variações';
  document.querySelectorAll('.buttons button').forEach(b => b.classList.remove('active'));
  if (mode === '2021') { document.getElementById('mode2021').classList.add('active'); drawPrice(2021); }
  if (mode === '2026') { document.getElementById('mode2026').classList.add('active'); drawPrice(2026); }
  if (mode === 'delta') { document.getElementById('modeDelta').classList.add('active'); drawDelta(); }
  if (mode === 'rent') { document.getElementById('modeRent').classList.add('active'); drawRent(); }
}
function fillSelects() {
  const publishedCities = [
    ...currentListings.map(item => item.city),
    ...neighborhoodDaily.map(item => item.city),
    ...listingEvents.map(item => item.city)
  ];
  const publishedNeighborhoods = [
    ...currentListings.map(item => item.neighborhood),
    ...neighborhoodDaily.map(item => item.neighborhood),
    ...listingEvents.map(item => item.neighborhood)
  ];
  allCities = [...new Set([...allCities, ...publishedCities].filter(Boolean))].sort((a,b) => a.localeCompare(b, 'pt-BR'));
  allNeighborhoods = [...new Set([...allNeighborhoods, ...publishedNeighborhoods].filter(Boolean))].sort((a,b) => a.localeCompare(b, 'pt-BR'));
  const city = document.getElementById('cityFilter');
  city.replaceChildren(new Option('Todas', 'all'), ...allCities.map(name => new Option(name, name)));
  city.value = allCities.includes('Belo Horizonte') ? 'Belo Horizonte' : 'all';
  const nb = document.getElementById('neighborhoodFilter');
  nb.replaceChildren(new Option('Todos', 'all'), ...allNeighborhoods.map(name => new Option(name, name)));
}
function bindControls() {
  document.getElementById('mode2021').onclick = () => {mode='2021'; redraw();};
  document.getElementById('mode2026').onclick = () => {mode='2026'; redraw();};
  document.getElementById('modeDelta').onclick = () => {mode='delta'; redraw();};
  document.getElementById('modeRent').onclick = () => {mode='rent'; redraw();};
  document.getElementById('familyHistorical').onclick = () => {viewFamily='historical'; redraw();};
  document.getElementById('familyDaily').onclick = () => {viewFamily='daily'; redraw();};
  ['typeFilter','cityFilter','neighborhoodFilter','minSamples','deltaStyle','priceStyle','cellSize','rentMetric','dailyMetric'].forEach(id => document.getElementById(id).addEventListener('change', redraw));
  document.getElementById('radius').addEventListener('input', redraw);
  document.getElementById('dailyDate').addEventListener('change', redraw);
  document.getElementById('dailyCompareDate').addEventListener('change', redraw);
}

async function initializeApp() {
  async function loadBaseline(year) {
    const response = await fetch(`data/baseline/${year}.json`);
    if (!response.ok) throw new Error(`Falha ao carregar a base ${year}: HTTP ${response.status}`);
    return response.json();
  }

  const [points2021, points2026] = await Promise.all([
    loadBaseline(2021),
    loadBaseline(2026),
    loadPublicData()
  ]);
  allPoints = [...points2021, ...points2026];
  allCities = [...new Set(allPoints.map(point => point.city).filter(Boolean))];
  allNeighborhoods = [...new Set(allPoints.map(point => point.neighborhood).filter(Boolean))];

  renderCollectionStatus();
  fillSelects();
  const dates = [...new Set(neighborhoodDaily.map(row => row.date).filter(Boolean))].sort();
  const dateInput = document.getElementById('dailyDate');
  if (dates.length) {
    dateInput.min = dates[0];
    dateInput.max = dates.at(-1);
    dateInput.value = dates.at(-1);
    const compareInput = document.getElementById('dailyCompareDate');
    compareInput.min = dates[0];
    compareInput.max = dates.at(-1);
    compareInput.value = dates.length > 1 ? dates[Math.max(0, dates.length - 8)] : '';
    document.getElementById('dailyDateStart').textContent = localDateLabel(dates[0]);
    document.getElementById('dailyDateEnd').textContent = localDateLabel(dates.at(-1));
  } else {
    dateInput.disabled = true;
    document.getElementById('dailyCompareDate').disabled = true;
    document.getElementById('dailyDateStart').textContent = 'Sem histórico';
    document.getElementById('dailyDateEnd').textContent = '';
  }
  bindControls();
  redraw();
}

initializeApp().catch(error => {
  console.error('Não foi possível carregar as bases do mapa.', error);
  document.getElementById('note').textContent = 'Não foi possível carregar os dados do mapa. Tente recarregar a página.';
});
