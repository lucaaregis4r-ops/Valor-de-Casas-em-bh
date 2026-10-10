import { map, currentLayers, clearLayers } from './map.js';
import { median, percentile, interpolateColor, priceStops } from './statistics.js';
import { norm } from './filters.js';

const money = new Intl.NumberFormat('pt-BR', {style:'currency', currency:'BRL', maximumFractionDigits:0});
const number = new Intl.NumberFormat('pt-BR');
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[c]));

function rings(feature) {
  const geometry = feature.geometry;
  if (geometry.type === 'Polygon') return [geometry.coordinates];
  return geometry.type === 'MultiPolygon' ? geometry.coordinates : [];
}

function bounds(feature) {
  let west = Infinity, east = -Infinity, south = Infinity, north = -Infinity;
  for (const polygon of rings(feature)) for (const ring of polygon) for (const [lon, lat] of ring) {
    west = Math.min(west, lon); east = Math.max(east, lon);
    south = Math.min(south, lat); north = Math.max(north, lat);
  }
  return {west, east, south, north};
}

function insideRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a[1] > lat) !== (b[1] > lat) && lon < (b[0] - a[0]) * (lat - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

export function pointInFeature(lon, lat, feature) {
  const b = feature._bounds || bounds(feature);
  if (lon < b.west || lon > b.east || lat < b.south || lat > b.north) return false;
  return rings(feature).some(polygon => polygon.length && insideRing(lon, lat, polygon[0])
    && !polygon.slice(1).some(hole => insideRing(lon, lat, hole)));
}

function spatialIndex(features, step = .01) {
  const buckets = new Map();
  for (const feature of features) {
    feature._bounds = bounds(feature);
    const b = feature._bounds;
    for (let x = Math.floor(b.west / step); x <= Math.floor(b.east / step); x++) {
      for (let y = Math.floor(b.south / step); y <= Math.floor(b.north / step); y++) {
        const key = `${x}:${y}`;
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(feature);
      }
    }
  }
  return (lon, lat) => (buckets.get(`${Math.floor(lon / step)}:${Math.floor(lat / step)}`) || [])
    .find(feature => pointInFeature(lon, lat, feature));
}

const metrics = {
  sale2026: {label:'Venda 2026', description:'apartamentos à venda · base 2026', select:p => p.year === 2026 && p.operation === 'sale' && p.property_type === 'apartment'},
  sale2021: {label:'Venda 2021', description:'apartamentos à venda · base 2021', select:p => p.year === 2021 && p.operation === 'sale'},
  rent2026: {label:'Aluguel 2026', description:'aluguel anunciado · base 2026', select:p => p.year === 2026 && p.operation === 'rent'},
  currentRent: {label:'Aluguel agora', description:'anúncios ativos da última coleta válida', select:p => p.available && p.operation === 'rent'},
};

export async function createMosaic(historical, current) {
  const [neighborhoodResponse, cityResponse] = await Promise.all([
    fetch('data/geography/bh_neighborhoods.geojson'),
    fetch('data/geography/rmbh_cities.geojson'),
  ]);
  if (!neighborhoodResponse.ok || !cityResponse.ok) throw new Error('Não foi possível carregar a malha da RMBH.');
  const neighborhoods = (await neighborhoodResponse.json()).features;
  const cities = (await cityResponse.json()).features;
  const byCode = new Map(neighborhoods.map(feature => [String(feature.properties.code), feature]));
  const byName = new Map(neighborhoods.map(feature => [norm(feature.properties.name), feature]));
  const cityByCode = new Map(cities.map(feature => [String(feature.properties.code), feature]));
  const cityByName = new Map(cities.map(feature => [norm(feature.properties.name), feature]));
  const bh = cityByName.get(norm('Belo Horizonte'));
  const bhCode = String(bh.properties.code);
  const findCity = spatialIndex(cities);
  const findNeighborhood = spatialIndex(neighborhoods);
  let cells = null;
  let metroCells = null;
  let selectedCity = null;
  let selected = null;
  let activePoints = [];
  let activeMetric = 'sale2026';
  let active = false;
  let sequence = 0;
  const wholeCityBounds = L.geoJSON({type:'FeatureCollection', features:neighborhoods}).getBounds();
  const metroBounds = L.geoJSON({type:'FeatureCollection', features:cities}).getBounds();

  function classify(items, approximate = false) {
    return items.filter(item => Number.isFinite(item.price_m2) && item.price_m2 > 0
      && Number.isFinite(item.lat) && Number.isFinite(item.lon))
      .map(item => {
        const isApproximate = approximate && item.location_precision === 'neighborhood';
        const fallbackCity = isApproximate ? cityByName.get(norm(item.city)) : null;
        const city = fallbackCity || findCity(item.lon, item.lat);
        if (!city) return null;
        const cityCode = String(city.properties.code);
        const fallbackNeighborhood = isApproximate && cityCode === bhCode ? byName.get(norm(item.neighborhood)) : null;
        const neighborhood = cityCode === bhCode
          ? fallbackNeighborhood || findNeighborhood(item.lon, item.lat) : null;
        return {...item, mosaicCityCode:cityCode, mosaicCode:neighborhood ? String(neighborhood.properties.code) : null,
          approximate:isApproximate};
      }).filter(Boolean);
  }

  const classifiedHistorical = classify(historical);
  const classifiedCurrent = classify(current, true);
  const citySelect = document.getElementById('mosaicCity');
  citySelect.replaceChildren(new Option('Escolha uma cidade', ''),
    ...[...cities].sort((a,b) => a.properties.name.localeCompare(b.properties.name, 'pt-BR'))
      .map(feature => new Option(feature.properties.name, String(feature.properties.code))));
  const neighborhoodSelect = document.getElementById('mosaicNeighborhood');
  const sorted = [...neighborhoods].sort((a,b) => a.properties.name.localeCompare(b.properties.name, 'pt-BR'));
  neighborhoodSelect.replaceChildren(new Option('Escolha um bairro', ''),
    ...sorted.map(feature => new Option(feature.properties.name, String(feature.properties.code))));

  function pointSet() {
    const source = activeMetric === 'currentRent' ? classifiedCurrent : classifiedHistorical;
    return source.filter(metrics[activeMetric].select);
  }

  function clearMap() {
    clearLayers();
    if (window.legendControl) {
      map.removeControl(window.legendControl);
      window.legendControl = null;
    }
  }

  function color(value, cap) {
    return interpolateColor(priceStops, Math.max(.05, Math.min(1, value / (cap || 1))));
  }

  function addLegend(label, threshold, cap) {
    const legend = L.control({position:'bottomright'});
    legend.onAdd = () => {
      const div = L.DomUtil.create('div', 'legend mosaic-legend');
      div.innerHTML = `<strong>${escapeHtml(label)} · preço pedido/m²</strong><div class="bar-price"></div><span>Menor preço</span><span>Até ${money.format(cap)}/m²</span><small>Cinza: menos de ${threshold} anúncios</small>`;
      return div;
    };
    legend.addTo(map);
    window.legendControl = legend;
  }

  function updateHeader(title, subtitle) {
    document.getElementById('mosaicAreaTitle').textContent = title;
    document.getElementById('mosaicAreaSubtitle').textContent = subtitle;
    const back = document.getElementById('mosaicBack');
    back.hidden = !selectedCity;
    back.textContent = selected ? '← Ver bairros de BH' : '← Ver cidades da região metropolitana';
    citySelect.value = selectedCity ? String(selectedCity.properties.code) : '';
    neighborhoodSelect.value = selected ? String(selected.properties.code) : '';
    document.getElementById('mosaicNeighborhoodWrap').hidden = !selectedCity || String(selectedCity.properties.code) !== bhCode;
    document.getElementById('mapSourceLabel').textContent = `MOSAICO RMBH · ${metrics[activeMetric].label.toUpperCase()}`;
    document.getElementById('mapAreaLabel').textContent = selected ? selected.properties.name
      : selectedCity ? selectedCity.properties.name : 'Clique numa cidade para ver suas regiões';
    document.getElementById('mapInteractionHint').textContent = selected
      ? 'Clique numa região ou ponto para ver os preços · use a seta para voltar'
      : selectedCity && String(selectedCity.properties.code) === bhCode
        ? 'Clique num bairro para ver suas regiões · use a seta para voltar'
        : selectedCity
          ? 'Clique numa região ou ponto para ver os preços · use a seta para voltar'
          : 'Clique numa cidade · escolha o período acima · explore as regiões';
    document.getElementById('mapCaption').textContent = selected
      ? 'Células de 400 m recortadas pelo bairro. Preços pedidos em anúncios, não valores de transação.'
      : selectedCity && String(selectedCity.properties.code) !== bhCode
        ? 'Grade de 1 km recortada pelo município. Regiões cinzas têm menos de 3 anúncios localizados.'
        : selectedCity
          ? 'Bairros: PBH/Prodabel, Bairro Popular 2024. Clique num bairro para ver as regiões de 400 m.'
          : 'Municípios: Fundação João Pinheiro/PBH, RMBH 2026. Cor = mediana do preço pedido por m²; cinza = amostra pequena.';
  }

  function drawMetro() {
    clearMap();
    selectedCity = null;
    selected = null;
    activePoints = pointSet();
    const groups = new Map();
    activePoints.forEach(p => {
      if (!groups.has(p.mosaicCityCode)) groups.set(p.mosaicCityCode, []);
      groups.get(p.mosaicCityCode).push(p);
    });
    const cap = percentile(activePoints.map(p => p.price_m2), .95) || 1;
    const layer = L.geoJSON({type:'FeatureCollection', features:cities}, {
      style: feature => {
        const items = groups.get(String(feature.properties.code)) || [];
        const value = items.length >= 5 ? median(items.map(p => p.price_m2)) : null;
        return {color:'#f8fbf6', weight:1.4, fillColor:value ? color(value, cap) : '#91a5a0', fillOpacity:value ? .78 : .72};
      },
      onEachFeature: (feature, polygon) => {
        const items = groups.get(String(feature.properties.code)) || [];
        const value = items.length >= 5 ? median(items.map(p => p.price_m2)) : null;
        polygon.bindTooltip(`<strong>${escapeHtml(feature.properties.name)}</strong><br>${value ? `${money.format(value)}/m²` : 'Amostra insuficiente'} · ${number.format(items.length)} anúncios`, {sticky:true});
        polygon.on('mouseover', () => polygon.setStyle({weight:2.5, color:'#173432', fillOpacity:.9}));
        polygon.on('mouseout', () => layer.resetStyle(polygon));
        polygon.on('click', () => openCity(String(feature.properties.code)));
      }
    }).addTo(map);
    currentLayers.push(layer);
    addLegend(metrics[activeMetric].label, 5, cap);
    map.fitBounds(metroBounds.pad(.025), {animate:false});
    updateHeader('Região Metropolitana de Belo Horizonte', `${number.format(cities.length)} cidades · ${number.format(activePoints.length)} anúncios localizados na malha`);
    document.getElementById('mosaicDetail').hidden = true;
  }

  function drawCity() {
    clearMap();
    selectedCity = bh;
    selected = null;
    activePoints = pointSet().filter(p => p.mosaicCityCode === bhCode && p.mosaicCode);
    const groups = new Map();
    activePoints.forEach(p => {
      if (!groups.has(p.mosaicCode)) groups.set(p.mosaicCode, []);
      groups.get(p.mosaicCode).push(p);
    });
    const cap = percentile(activePoints.map(p => p.price_m2), .95) || 1;
    const layer = L.geoJSON({type:'FeatureCollection', features:neighborhoods}, {
      style: feature => {
        const points = groups.get(String(feature.properties.code)) || [];
        const value = points.length >= 5 ? median(points.map(p => p.price_m2)) : null;
        return {color:'#f8fbf6', weight:1, fillColor:value ? color(value, cap) : '#91a5a0', fillOpacity:value ? .78 : .72};
      },
      onEachFeature: (feature, polygon) => {
        const points = groups.get(String(feature.properties.code)) || [];
        const value = points.length >= 5 ? median(points.map(p => p.price_m2)) : null;
        polygon.bindTooltip(`<strong>${escapeHtml(feature.properties.name)}</strong><br>${value ? `${money.format(value)}/m²` : 'Amostra insuficiente'} · ${number.format(points.length)} anúncios`, {sticky:true});
        polygon.on('mouseover', () => polygon.setStyle({weight:2, color:'#173432', fillOpacity:.9}));
        polygon.on('mouseout', () => layer.resetStyle(polygon));
        polygon.on('click', () => openNeighborhood(String(feature.properties.code)));
      }
    }).addTo(map);
    currentLayers.push(layer);
    addLegend(metrics[activeMetric].label, 5, cap);
    map.fitBounds(wholeCityBounds.pad(.025), {animate:false});
    updateHeader('Belo Horizonte', `${number.format(neighborhoods.length)} áreas oficiais · ${number.format(activePoints.length)} anúncios associados aos bairros`);
    document.getElementById('mosaicDetail').hidden = true;
  }

  async function loadMetroCells() {
    if (metroCells) return metroCells;
    const response = await fetch('data/geography/rmbh_cells_1000m.geojson');
    if (!response.ok) throw new Error('Não foi possível carregar as regiões da cidade.');
    metroCells = (await response.json()).features;
    return metroCells;
  }

  async function openCity(code) {
    const target = cityByCode.get(code);
    if (!target) return;
    const request = ++sequence;
    selectedCity = target;
    selected = null;
    if (code === bhCode) { drawCity(); return; }
    updateHeader(target.properties.name, 'Carregando as regiões da cidade…');
    try {
      await loadMetroCells();
      if (request !== sequence || !active) return;
      drawMunicipality();
    } catch (error) {
      console.error(error);
      document.getElementById('mosaicAreaSubtitle').textContent = 'Falha ao carregar as regiões. Tente selecionar a cidade novamente.';
    }
  }

  function drawMunicipality() {
    if (!selectedCity || String(selectedCity.properties.code) === bhCode) return;
    clearMap();
    const code = String(selectedCity.properties.code);
    const points = pointSet().filter(p => p.mosaicCityCode === code);
    const precise = points.filter(p => !p.approximate);
    const cellFeatures = metroCells.filter(feature => String(feature.properties.code) === code);
    const findCell = spatialIndex(cellFeatures);
    const groups = new Map();
    precise.forEach(p => {
      const cell = findCell(p.lon, p.lat);
      if (!cell) return;
      const id = cell.properties.id;
      if (!groups.has(id)) groups.set(id, []);
      groups.get(id).push(p);
    });
    const cap = percentile(pointSet().map(p => p.price_m2), .95) || 1;
    const outline = L.geoJSON(selectedCity, {style:{color:'#173432', weight:3, fillColor:'#eef2e9', fillOpacity:.7}, interactive:false}).addTo(map);
    currentLayers.push(outline);
    const layer = L.geoJSON({type:'FeatureCollection', features:cellFeatures}, {
      style: feature => {
        const items = groups.get(feature.properties.id) || [];
        const value = items.length >= 3 ? median(items.map(p => p.price_m2)) : null;
        return {color:'#f8fbf6', weight:1.2, fillColor:value ? color(value, cap) : '#b9c5bf', fillOpacity:value ? .82 : .45};
      },
      onEachFeature: (feature, polygon) => {
        const items = groups.get(feature.properties.id) || [];
        const value = items.length >= 3 ? median(items.map(p => p.price_m2)) : null;
        const label = value ? `${money.format(value)}/m²` : 'Amostra insuficiente';
        polygon.bindTooltip(`<strong>${escapeHtml(selectedCity.properties.name)}</strong><br>Região de 1 km · ${label}<br>${items.length} anúncios com localização`, {sticky:true});
        polygon.bindPopup(`<strong>Região de ${escapeHtml(selectedCity.properties.name)}</strong><br>Preço pedido/m²: ${label}<br>${items.length} anúncios localizados${items.length < 3 ? '<br><small>São necessários 3 anúncios para colorir esta região.</small>' : ''}`);
        polygon.on('mouseover', () => polygon.setStyle({weight:2.4, color:'#173432'}));
        polygon.on('mouseout', () => layer.resetStyle(polygon));
      }
    }).addTo(map);
    currentLayers.push(layer);
    const dots = L.layerGroup();
    precise.forEach(p => {
      const marker = L.circleMarker([p.lat, p.lon], {radius:3.5, color:'#173432', weight:1, fillColor:'#fff', fillOpacity:.95});
      marker.bindPopup(`<strong>${escapeHtml(p.address || selectedCity.properties.name)}</strong><br>${money.format(p.price_m2)}/m² · ${money.format(p.price)}${p.area ? `<br>${number.format(p.area)} m²` : ''}<br><small>Localização informada na base; pode ser aproximada.</small>`);
      marker.addTo(dots);
    });
    dots.addTo(map);
    currentLayers.push(dots);
    addLegend(metrics[activeMetric].label, 3, cap);
    map.fitBounds(outline.getBounds().pad(.08), {animate:false, maxZoom:13});
    const value = points.length >= 5 ? median(points.map(p => p.price_m2)) : null;
    const colored = [...groups.values()].filter(items => items.length >= 3).length;
    updateHeader(selectedCity.properties.name, `${metrics[activeMetric].description} · ${number.format(points.length)} anúncios associados à cidade`);
    const detail = document.getElementById('mosaicDetail');
    detail.hidden = false;
    detail.innerHTML = `<div class="mosaic-detail-heading"><span>INTERIOR DA CIDADE</span><h2>${escapeHtml(selectedCity.properties.name)}</h2><p>Grade de 1 km recortada pelo limite municipal. Clique numa região ou num ponto para ver os valores.</p></div><div class="mosaic-detail-stats"><div><strong>${value ? `${money.format(value)}/m²` : 'sem mediana'}</strong><span>Mediana da cidade · mínimo de 5 anúncios</span></div><div><strong>${number.format(precise.length)}</strong><span>Anúncios com coordenadas para localizar regiões</span></div><div><strong>${number.format(colored)}</strong><span>Regiões com pelo menos 3 anúncios</span></div></div><p class="mosaic-detail-note">${points.length - precise.length ? `${number.format(points.length - precise.length)} anúncio(s) com posição aproximada entram no total, mas não na grade interna. ` : ''}Cinza indica amostra pequena. A grade é geométrica e não representa limites oficiais de bairros. A atribuição dos imóveis usa suas coordenadas e pode divergir da cidade escrita no anúncio.</p>`;
  }

  async function loadCells() {
    if (cells) return cells;
    const response = await fetch('data/geography/bh_cells_400m.geojson');
    if (!response.ok) throw new Error('Não foi possível carregar as regiões dos bairros.');
    cells = (await response.json()).features;
    return cells;
  }

  async function openNeighborhood(code) {
    const target = byCode.get(code);
    if (!target) return;
    selectedCity = bh;
    selected = target;
    const request = ++sequence;
    updateHeader(target.properties.name, 'Carregando as regiões do bairro…');
    try {
      await loadCells();
      if (request !== sequence || !active) return;
      drawNeighborhood();
    } catch (error) {
      console.error(error);
      document.getElementById('mosaicAreaSubtitle').textContent = 'Falha ao carregar as regiões. Tente selecionar o bairro novamente.';
    }
  }

  function drawNeighborhood() {
    if (!selected) return;
    clearMap();
    activePoints = pointSet().filter(p => p.mosaicCityCode === bhCode && p.mosaicCode);
    const code = String(selected.properties.code);
    const points = activePoints.filter(p => p.mosaicCityCode === bhCode && p.mosaicCode === code);
    const precise = points.filter(p => !p.approximate);
    const cellFeatures = cells.filter(feature => String(feature.properties.code) === code);
    const findCell = spatialIndex(cellFeatures, .004);
    const groups = new Map();
    precise.forEach(p => {
      const cell = findCell(p.lon, p.lat);
      if (!cell) return;
      const id = cell.properties.id;
      if (!groups.has(id)) groups.set(id, []);
      groups.get(id).push(p);
    });
    const cap = percentile(activePoints.map(p => p.price_m2), .95) || 1;
    const outline = L.geoJSON(selected, {style:{color:'#173432', weight:3, fillColor:'#eef2e9', fillOpacity:.7}, interactive:false}).addTo(map);
    currentLayers.push(outline);
    const layer = L.geoJSON({type:'FeatureCollection', features:cellFeatures}, {
      style: feature => {
        const items = groups.get(feature.properties.id) || [];
        const value = items.length >= 3 ? median(items.map(p => p.price_m2)) : null;
        return {color:'#f8fbf6', weight:1.4, fillColor:value ? color(value, cap) : '#b9c5bf', fillOpacity:value ? .82 : .45};
      },
      onEachFeature: (feature, polygon) => {
        const items = groups.get(feature.properties.id) || [];
        const value = items.length >= 3 ? median(items.map(p => p.price_m2)) : null;
        const label = value ? `${money.format(value)}/m²` : 'Amostra insuficiente';
        polygon.bindTooltip(`<strong>${escapeHtml(selected.properties.name)}</strong><br>Região de 400 m · ${label}<br>${items.length} anúncios com localização`, {sticky:true});
        polygon.bindPopup(`<strong>Região de ${escapeHtml(selected.properties.name)}</strong><br>Preço pedido/m²: ${label}<br>${items.length} anúncios localizados${items.length < 3 ? '<br><small>São necessários 3 anúncios para colorir esta região.</small>' : ''}`);
        polygon.on('mouseover', () => polygon.setStyle({weight:2.5, color:'#173432'}));
        polygon.on('mouseout', () => layer.resetStyle(polygon));
      }
    }).addTo(map);
    currentLayers.push(layer);
    const dots = L.layerGroup();
    precise.forEach(p => {
      const marker = L.circleMarker([p.lat, p.lon], {radius:3.5, color:'#173432', weight:1, fillColor:'#fff', fillOpacity:.95});
      marker.bindPopup(`<strong>${escapeHtml(p.address || selected.properties.name)}</strong><br>${money.format(p.price_m2)}/m² · ${money.format(p.price)}${p.area ? `<br>${number.format(p.area)} m²` : ''}<br><small>Localização informada na base; pode ser aproximada.</small>`);
      marker.addTo(dots);
    });
    dots.addTo(map);
    currentLayers.push(dots);
    addLegend(metrics[activeMetric].label, 3, cap);
    map.fitBounds(outline.getBounds().pad(.14), {animate:false, maxZoom:15});
    const value = points.length >= 5 ? median(points.map(p => p.price_m2)) : null;
    const colored = [...groups.values()].filter(items => items.length >= 3).length;
    updateHeader(selected.properties.name, `${metrics[activeMetric].description} · ${number.format(points.length)} anúncios associados ao bairro`);
    const detail = document.getElementById('mosaicDetail');
    detail.hidden = false;
    detail.innerHTML = `<div class="mosaic-detail-heading"><span>INTERIOR DO BAIRRO</span><h2>${escapeHtml(selected.properties.name)}</h2><p>Regiões de 400 m recortadas pelo limite oficial. Clique numa região ou num ponto para ver os valores.</p></div><div class="mosaic-detail-stats"><div><strong>${value ? `${money.format(value)}/m²` : 'sem mediana'}</strong><span>Mediana do bairro · mínimo de 5 anúncios</span></div><div><strong>${number.format(precise.length)}</strong><span>Anúncios com coordenadas para localizar regiões</span></div><div><strong>${number.format(colored)}</strong><span>Regiões com pelo menos 3 anúncios</span></div></div><p class="mosaic-detail-note">${points.length - precise.length ? `${number.format(points.length - precise.length)} anúncio(s) com posição aproximada pelo bairro entram no total, mas não nas regiões internas. ` : ''}Cinza indica amostra pequena. Os limites são da PBH/Prodabel; a atribuição dos imóveis usa suas coordenadas e pode divergir do bairro escrito no anúncio.</p>`;
  }

  document.getElementById('mosaicMetric').addEventListener('change', event => {
    activeMetric = event.target.value;
    if (!active) return;
    if (selected) cells ? drawNeighborhood() : openNeighborhood(String(selected.properties.code));
    else if (selectedCity) String(selectedCity.properties.code) === bhCode ? drawCity()
      : metroCells ? drawMunicipality() : openCity(String(selectedCity.properties.code));
    else drawMetro();
  });
  citySelect.addEventListener('change', event => {
    if (event.target.value) openCity(event.target.value);
    else backToMetro();
  });
  neighborhoodSelect.addEventListener('change', event => {
    if (event.target.value) openNeighborhood(event.target.value);
    else backToCity();
  });
  document.getElementById('mosaicBack').addEventListener('click', () => selected ? backToCity() : backToMetro());

  function backToCity() {
    ++sequence;
    if (active) drawCity();
  }

  function backToMetro() {
    ++sequence;
    if (active) drawMetro();
  }

  function showSelected() {
    if (selected) cells ? drawNeighborhood() : openNeighborhood(String(selected.properties.code));
    else if (selectedCity) String(selectedCity.properties.code) === bhCode ? drawCity()
      : metroCells ? drawMunicipality() : openCity(String(selectedCity.properties.code));
    else drawMetro();
  }

  return {
    show() { active = true; showSelected(); },
    hide() { active = false; ++sequence; },
  };
}
