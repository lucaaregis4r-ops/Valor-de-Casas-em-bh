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
  const [neighborhoodResponse, cityResponse, metroNeighborhoodResponse] = await Promise.all([
    fetch('data/geography/bh_neighborhoods.geojson'),
    fetch('data/geography/rmbh_cities.geojson'),
    fetch('data/geography/metro_neighborhoods.geojson'),
  ]);
  if (!neighborhoodResponse.ok || !cityResponse.ok || !metroNeighborhoodResponse.ok) throw new Error('Não foi possível carregar a malha da RMBH.');
  const bhNeighborhoods = (await neighborhoodResponse.json()).features;
  const cities = (await cityResponse.json()).features;
  const metroNeighborhoods = (await metroNeighborhoodResponse.json()).features;
  const bh = cities.find(feature => norm(feature.properties.name) === norm('Belo Horizonte'));
  const bhCode = String(bh.properties.code);
  bhNeighborhoods.forEach(feature => { feature.properties.cityCode = bhCode; });
  const neighborhoods = [...bhNeighborhoods, ...metroNeighborhoods];
  const neighborhoodsByCity = new Map();
  neighborhoods.forEach(feature => {
    const cityCode = String(feature.properties.cityCode);
    if (!neighborhoodsByCity.has(cityCode)) neighborhoodsByCity.set(cityCode, []);
    neighborhoodsByCity.get(cityCode).push(feature);
  });
  const byCode = new Map(neighborhoods.map(feature => [String(feature.properties.code), feature]));
  const byName = new Map(neighborhoods.map(feature => [`${feature.properties.cityCode}:${norm(feature.properties.name)}`, feature]));
  const cityByCode = new Map(cities.map(feature => [String(feature.properties.code), feature]));
  const cityByName = new Map(cities.map(feature => [norm(feature.properties.name), feature]));
  const findCity = spatialIndex(cities);
  const findNeighborhoodByCity = new Map([...neighborhoodsByCity]
    .map(([code, features]) => [code, spatialIndex(features)]));
  let bhCells = null;
  let metroNeighborhoodCells = null;
  let metroCells = null;
  let selectedCity = null;
  let selected = null;
  let activePoints = [];
  let activeMetric = 'sale2026';
  let active = false;
  let sequence = 0;
  let showPoints = false;
  const metroBounds = L.geoJSON({type:'FeatureCollection', features:cities}).getBounds();

  function classify(items, approximate = false) {
    return items.filter(item => Number.isFinite(item.price_m2) && item.price_m2 > 0
      && Number.isFinite(item.lat) && Number.isFinite(item.lon))
      .map(item => {
        const isApproximate = approximate && item.location_precision === 'neighborhood';
        const city = findCity(item.lon, item.lat)
          || (isApproximate ? cityByName.get(norm(item.city)) : null);
        if (!city) return null;
        const cityCode = String(city.properties.code);
        const locatedNeighborhood = findNeighborhoodByCity.get(cityCode)?.(item.lon, item.lat);
        const neighborhood = locatedNeighborhood
          || (isApproximate ? byName.get(`${cityCode}:${norm(item.neighborhood)}`) : null);
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
  function populateNeighborhoodSelect() {
    const code = selectedCity ? String(selectedCity.properties.code) : '';
    const sorted = [...(neighborhoodsByCity.get(code) || [])]
      .sort((a,b) => a.properties.name.localeCompare(b.properties.name, 'pt-BR'));
    neighborhoodSelect.replaceChildren(new Option('Escolha um bairro', ''),
      ...sorted.map(feature => new Option(feature.properties.name, String(feature.properties.code))));
    neighborhoodSelect.value = selected ? String(selected.properties.code) : '';
  }

  function pointSet() {
    const source = activeMetric === 'currentRent' ? classifiedCurrent : classifiedHistorical;
    return source.filter(metrics[activeMetric].select);
  }

  function sourcePointSet() {
    const source = activeMetric === 'currentRent' ? current : historical;
    return source.filter(metrics[activeMetric].select);
  }

  function clearMap() {
    clearLayers();
    document.querySelector('.map-frame').classList.remove('mosaic-street-map');
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

  function addNeighborhoodLegend(low, high) {
    const legend = L.control({position:'bottomright'});
    legend.onAdd = () => {
      const div = L.DomUtil.create('div', 'legend mosaic-legend');
      div.innerHTML = `<strong>${escapeHtml(metrics[activeMetric].label)} · escala deste bairro</strong><div class="bar-price"></div><span>${low === null ? 'Sem regiões com amostra' : `${money.format(low)}/m²`}</span><span>${high === null ? '' : `${money.format(high)}/m²`}</span><small>Cinza: menos de 3 anúncios · preços pedidos</small>`;
      return div;
    };
    legend.addTo(map);
    window.legendControl = legend;
  }

  function revealStreetBasemap() {
    document.querySelector('.map-frame').classList.add('mosaic-street-map');
  }

  function updateHeader(title, subtitle) {
    document.getElementById('mosaicAreaTitle').textContent = title;
    document.getElementById('mosaicAreaSubtitle').textContent = subtitle;
    const back = document.getElementById('mosaicBack');
    back.hidden = !selectedCity;
    back.textContent = selected ? `← Ver bairros de ${selectedCity.properties.name}` : '← Ver cidades da região metropolitana';
    citySelect.value = selectedCity ? String(selectedCity.properties.code) : '';
    populateNeighborhoodSelect();
    const hasNeighborhoods = selectedCity && neighborhoodsByCity.has(String(selectedCity.properties.code));
    document.getElementById('mosaicNeighborhoodWrap').hidden = !hasNeighborhoods;
    document.getElementById('mapSourceLabel').textContent = `MOSAICO RMBH · ${metrics[activeMetric].label.toUpperCase()}`;
    document.getElementById('mapAreaLabel').textContent = selected ? selected.properties.name
      : selectedCity ? selectedCity.properties.name : 'Clique numa cidade para ver suas regiões';
    document.getElementById('mapInteractionHint').textContent = selected
      ? 'Clique numa região · ative os pontos dos anúncios abaixo do mapa'
      : hasNeighborhoods
        ? 'Clique num bairro para ver suas regiões · use a seta para voltar'
        : selectedCity
          ? 'Clique numa região ou ponto para ver os preços · use a seta para voltar'
          : 'Clique numa cidade · escolha o período acima · explore as regiões';
    document.getElementById('mapCaption').textContent = selected
      ? `${selectedCity.properties.name === 'Nova Lima' ? 'Limites propostos pela prefeitura, ainda não validados. ' : ''}Células de 400 m com escala de cores própria do bairro e ruas visíveis sob a camada. Preços pedidos, não valores de transação.`
      : hasNeighborhoods
        ? String(selectedCity.properties.code) === bhCode
          ? 'Bairros: PBH/Prodabel, Bairro Popular 2024. Clique num bairro para ver as regiões de 400 m.'
          : selectedCity.properties.name === 'Contagem'
            ? 'Bairros e loteamentos: Prefeitura de Contagem. Clique numa área para ver regiões de 400 m.'
            : selectedCity.properties.name === 'Nova Lima'
              ? 'Bairros/loteamentos: proposta da Prefeitura de Nova Lima, ainda não validada. Clique numa área para ver regiões de 400 m.'
              : 'Bairros: Prefeitura de Betim, mapa de março de 2026. Clique num bairro para ver regiões de 400 m.'
        : selectedCity
          ? 'Grade de 1 km recortada pelo município. Regiões cinzas têm menos de 3 anúncios localizados.'
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
    const sourcePoints = sourcePointSet();
    const withCoordinates = sourcePoints.filter(p => Number.isFinite(p.price_m2) && p.price_m2 > 0
      && Number.isFinite(p.lat) && Number.isFinite(p.lon)).length;
    const outside = withCoordinates - activePoints.length;
    const withoutCoordinates = sourcePoints.length - withCoordinates;
    updateHeader('Região Metropolitana de Belo Horizonte', `${number.format(cities.length)} cidades · ${number.format(activePoints.length)} anúncios na malha${outside ? ` · ${number.format(outside)} fora da malha` : ''}${withoutCoordinates ? ` · ${number.format(withoutCoordinates)} sem localização ou preço/m² válido` : ''}`);
    document.getElementById('mosaicDetail').hidden = true;
  }

  function drawCity() {
    clearMap();
    selected = null;
    const cityCode = String(selectedCity.properties.code);
    const cityNeighborhoods = neighborhoodsByCity.get(cityCode) || [];
    activePoints = pointSet().filter(p => p.mosaicCityCode === cityCode);
    const zoned = activePoints.filter(p => p.mosaicCode);
    const groups = new Map();
    zoned.forEach(p => {
      if (!groups.has(p.mosaicCode)) groups.set(p.mosaicCode, []);
      groups.get(p.mosaicCode).push(p);
    });
    const cap = percentile(zoned.map(p => p.price_m2), .95) || 1;
    const layer = L.geoJSON({type:'FeatureCollection', features:cityNeighborhoods}, {
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
    map.fitBounds(layer.getBounds().pad(.025), {animate:false});
    const unzoned = activePoints.length - zoned.length;
    const areaLabel = selectedCity.properties.name === 'Nova Lima' ? 'áreas propostas' : 'bairros/áreas';
    updateHeader(selectedCity.properties.name, `${number.format(cityNeighborhoods.length)} ${areaLabel} · ${number.format(activePoints.length)} anúncios no município · ${number.format(zoned.length)} nas áreas${unzoned ? ` · ${number.format(unzoned)} fora das áreas` : ''}`);
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
    if (neighborhoodsByCity.has(code)) { drawCity(); return; }
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
    let assignedToCells = 0;
    precise.forEach(p => {
      const cell = findCell(p.lon, p.lat);
      if (!cell) return;
      assignedToCells++;
      const id = cell.properties.id;
      if (!groups.has(id)) groups.set(id, []);
      groups.get(id).push(p);
    });
    const cap = percentile(pointSet().map(p => p.price_m2), .95) || 1;
    const outline = L.geoJSON(selectedCity, {style:{color:'#173432', weight:2.5, fillOpacity:0}, interactive:false}).addTo(map);
    currentLayers.push(outline);
    const layer = L.geoJSON({type:'FeatureCollection', features:cellFeatures}, {
      style: feature => {
        const items = groups.get(feature.properties.id) || [];
        const value = items.length >= 3 ? median(items.map(p => p.price_m2)) : null;
        return {color:value ? '#5e6d63' : '#9ba9a0', weight:.8, fillColor:value ? color(value, cap) : '#d0d9d1', fillOpacity:value ? .38 : .09};
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
    revealStreetBasemap();
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
    detail.innerHTML = `<div class="mosaic-detail-heading"><span>INTERIOR DA CIDADE</span><h2>${escapeHtml(selectedCity.properties.name)}</h2><p>Grade de 1 km recortada pelo limite municipal. Clique numa região ou num ponto para ver os valores.</p></div><div class="mosaic-detail-stats"><div><strong>${value ? `${money.format(value)}/m²` : 'sem mediana'}</strong><span>Mediana da cidade · mínimo de 5 anúncios</span></div><div><strong>${number.format(assignedToCells)}</strong><span>Anúncios localizados na grade interna</span></div><div><strong>${number.format(colored)}</strong><span>Regiões com pelo menos 3 anúncios</span></div></div><p class="mosaic-detail-note">${points.length - precise.length ? `${number.format(points.length - precise.length)} anúncio(s) com posição aproximada entram no total, mas não na grade interna. ` : ''}${precise.length - assignedToCells ? `${number.format(precise.length - assignedToCells)} anúncio(s) ficam no total da cidade, mas fora das células da grade. ` : ''}Cinza indica amostra pequena. A grade é geométrica e não representa limites oficiais de bairros. A atribuição dos imóveis usa suas coordenadas e pode divergir da cidade escrita no anúncio.</p>`;
  }

  async function loadCells() {
    const cityCode = String(selectedCity.properties.code);
    if (cityCode === bhCode && bhCells) return bhCells;
    if (cityCode !== bhCode && metroNeighborhoodCells) return metroNeighborhoodCells;
    const response = await fetch(cityCode === bhCode
      ? 'data/geography/bh_cells_400m.geojson'
      : 'data/geography/metro_neighborhood_cells_400m.geojson');
    if (!response.ok) throw new Error('Não foi possível carregar as regiões dos bairros.');
    const features = (await response.json()).features;
    if (cityCode === bhCode) bhCells = features;
    else metroNeighborhoodCells = features;
    return features;
  }

  async function openNeighborhood(code) {
    const target = byCode.get(code);
    if (!target) return;
    selectedCity = cityByCode.get(String(target.properties.cityCode));
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
    const cityCode = String(selectedCity.properties.code);
    activePoints = pointSet().filter(p => p.mosaicCityCode === cityCode && p.mosaicCode);
    const code = String(selected.properties.code);
    const points = activePoints.filter(p => p.mosaicCode === code);
    const precise = points.filter(p => !p.approximate);
    const sourceCells = cityCode === bhCode ? bhCells : metroNeighborhoodCells;
    const cellFeatures = sourceCells.filter(feature => String(feature.properties.code) === code);
    const findCell = spatialIndex(cellFeatures, .004);
    const groups = new Map();
    let assignedToCells = 0;
    precise.forEach(p => {
      const cell = findCell(p.lon, p.lat);
      if (!cell) return;
      assignedToCells++;
      const id = cell.properties.id;
      if (!groups.has(id)) groups.set(id, []);
      groups.get(id).push(p);
    });
    const pricedRegions = cellFeatures.map(feature => {
      const items = groups.get(feature.properties.id) || [];
      return {feature, count:items.length, price:items.length >= 3 ? median(items.map(p => p.price_m2)) : null};
    }).filter(region => region.price !== null).sort((a,b) => b.price - a.price || b.count - a.count);
    const prices = pricedRegions.map(region => region.price);
    const low = prices.length ? Math.min(...prices) : null;
    const high = prices.length ? Math.max(...prices) : null;
    const neighborhoodColor = value => interpolateColor(priceStops,
      high > low ? Math.max(0, Math.min(1, (value - low) / (high - low))) : .5);
    const outline = L.geoJSON(selected, {style:{color:'#173432', weight:2.5, fillOpacity:0}, interactive:false}).addTo(map);
    currentLayers.push(outline);
    const polygons = new Map();
    const layer = L.geoJSON({type:'FeatureCollection', features:cellFeatures}, {
      style: feature => {
        const items = groups.get(feature.properties.id) || [];
        const value = items.length >= 3 ? median(items.map(p => p.price_m2)) : null;
        return {color:value ? '#506259' : '#98aaa0', weight:.9, fillColor:value ? neighborhoodColor(value) : '#d4ddd5', fillOpacity:value ? .43 : .08};
      },
      onEachFeature: (feature, polygon) => {
        polygons.set(feature.properties.id, polygon);
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
    revealStreetBasemap();
    const dots = L.layerGroup();
    precise.forEach(p => {
      const marker = L.circleMarker([p.lat, p.lon], {radius:3, color:'#173432', weight:1, fillColor:'#fff', fillOpacity:.9});
      marker.bindPopup(`<strong>${escapeHtml(p.address || selected.properties.name)}</strong><br>${money.format(p.price_m2)}/m² · ${money.format(p.price)}${p.area ? `<br>${number.format(p.area)} m²` : ''}<br><small>Localização informada na base; pode ser aproximada.</small>`);
      marker.addTo(dots);
    });
    if (showPoints) dots.addTo(map);
    currentLayers.push(dots);
    const badges = L.layerGroup();
    pricedRegions.slice(0, 3).forEach((region, index) => {
      const polygon = polygons.get(region.feature.properties.id);
      if (!polygon) return;
      L.marker(polygon.getBounds().getCenter(), {
        icon:L.divIcon({className:'mosaic-rank-marker', html:String(index + 1), iconSize:[24,24], iconAnchor:[12,12]}),
        interactive:true,
      }).bindPopup(polygon.getPopup().getContent()).addTo(badges);
    });
    badges.addTo(map);
    currentLayers.push(badges);
    addNeighborhoodLegend(low, high);
    map.fitBounds(outline.getBounds().pad(.14), {animate:false, maxZoom:15});
    const value = points.length >= 5 ? median(points.map(p => p.price_m2)) : null;
    const colored = pricedRegions.length;
    updateHeader(selected.properties.name, `${selectedCity.properties.name === 'Nova Lima' ? 'limites propostos, ainda não validados · ' : ''}${metrics[activeMetric].description} · ${number.format(points.length)} anúncios associados ao bairro`);
    const detail = document.getElementById('mosaicDetail');
    detail.hidden = false;
    const topRegions = pricedRegions.slice(0, 3).map((region, index) => `<button type="button" data-mosaic-cell="${escapeHtml(region.feature.properties.id)}"><b>${index + 1}ª região</b><strong>${money.format(region.price)}/m²</strong><small>${number.format(region.count)} anúncios · aproximar ruas ↗</small></button>`).join('');
    const intro = colored ? 'As cores comparam as regiões deste bairro. As ruas continuam visíveis sob a camada translúcida; clique numa região ou aproxime pelo ranking.'
      : 'Ainda não há anúncios suficientes para comparar as regiões deste bairro. As ruas e seus limites continuam visíveis.';
    const sourceNote = cityCode === bhCode ? 'PBH/Prodabel'
      : cityCode === '32' ? 'Prefeitura de Contagem (bairros e loteamentos, inclusive áreas não aprovadas)'
        : cityCode === '27' ? 'Prefeitura de Nova Lima (proposta ainda não validada)'
          : 'Prefeitura de Betim';
    detail.innerHTML = `<div class="mosaic-detail-heading"><span>INTERIOR DO BAIRRO</span><h2>${escapeHtml(selected.properties.name)}</h2><p>${intro}</p></div><label class="mosaic-point-toggle"><input id="mosaicShowPoints" type="checkbox" ${showPoints ? 'checked' : ''}> Mostrar pontos dos anúncios</label><div class="mosaic-detail-stats"><div><strong>${value ? `${money.format(value)}/m²` : 'sem mediana'}</strong><span>Mediana do bairro · mínimo de 5 anúncios</span></div><div><strong>${number.format(assignedToCells)}</strong><span>Anúncios localizados na grade interna</span></div><div><strong>${number.format(colored)}</strong><span>Regiões com pelo menos 3 anúncios</span></div></div><div class="mosaic-top-regions"><h3>Regiões mais caras neste bairro</h3><p>Mediana do preço pedido em células de 400 m com pelo menos 3 anúncios.</p><div>${topRegions || '<span class="mosaic-empty">Ainda não há regiões com amostra suficiente.</span>'}</div></div><p class="mosaic-detail-note">${points.length - precise.length ? `${number.format(points.length - precise.length)} anúncio(s) com posição aproximada pelo bairro entram no total, mas não nas regiões internas. ` : ''}${precise.length - assignedToCells ? `${number.format(precise.length - assignedToCells)} anúncio(s) ficam no total do bairro, mas fora das células da grade. ` : ''}Cinza indica amostra pequena. Os limites são da ${sourceNote}; a atribuição dos imóveis usa suas coordenadas e pode divergir do bairro escrito no anúncio.</p>`;
    detail.querySelector('#mosaicShowPoints').addEventListener('change', event => {
      showPoints = event.target.checked;
      if (showPoints) dots.addTo(map);
      else map.removeLayer(dots);
    });
    detail.querySelectorAll('[data-mosaic-cell]').forEach(button => button.addEventListener('click', () => {
      const polygon = polygons.get(button.dataset.mosaicCell);
      if (!polygon) return;
      map.fitBounds(polygon.getBounds().pad(.6), {animate:true, maxZoom:17});
      polygon.openPopup();
    }));
    requestAnimationFrame(() => {
      if (active && selected && String(selected.properties.code) === code) {
        map.invalidateSize();
        map.fitBounds(outline.getBounds().pad(.14), {animate:false, maxZoom:15});
      }
    });
  }

  document.getElementById('mosaicMetric').addEventListener('change', event => {
    activeMetric = event.target.value;
    if (!active) return;
    if (selected) (String(selectedCity.properties.code) === bhCode ? bhCells : metroNeighborhoodCells)
      ? drawNeighborhood() : openNeighborhood(String(selected.properties.code));
    else if (selectedCity) neighborhoodsByCity.has(String(selectedCity.properties.code)) ? drawCity()
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
    if (selected) (String(selectedCity.properties.code) === bhCode ? bhCells : metroNeighborhoodCells)
      ? drawNeighborhood() : openNeighborhood(String(selected.properties.code));
    else if (selectedCity) neighborhoodsByCity.has(String(selectedCity.properties.code)) ? drawCity()
      : metroCells ? drawMunicipality() : openCity(String(selectedCity.properties.code));
    else drawMetro();
  }

  return {
    show() { active = true; showSelected(); },
    hide() { active = false; ++sequence; document.querySelector('.map-frame').classList.remove('mosaic-street-map'); },
  };
}
