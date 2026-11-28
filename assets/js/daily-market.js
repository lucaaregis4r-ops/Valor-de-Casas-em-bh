import { map, currentLayers, clearLayers } from './map.js';
import { median, percentile } from './statistics.js';
import { norm } from './filters.js';
import { currentListings, neighborhoodDaily, listingEvents, publicMeta } from './public-data.js';
import { profileLink } from './neighborhoods.js';

const fmtBRL = new Intl.NumberFormat('pt-BR', {style:'currency', currency:'BRL', maximumFractionDigits:0});
const fmtNum = new Intl.NumberFormat('pt-BR');
const fmtReadRate = new Intl.NumberFormat('pt-BR', {style:'percent', maximumFractionDigits:1});
const fmtCollectionTime = new Intl.DateTimeFormat('pt-BR', {
  dateStyle:'short', timeStyle:'short', timeZone:'America/Sao_Paulo'
});

export function createDailyMarket({deltaColor, colorForRatio, pct}) {
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({
    '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'
  })[character]);
}
function safeExternalUrl(value) {
  if (!value) return '';
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    return url.href;
  } catch {
    return '';
  }
}
function safeExternalLink(value) {
  const url = safeExternalUrl(value);
  return url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">Abrir anúncio</a>` : '';
}
function localDateLabel(value) {
  if (!value) return 'sem data';
  const date = new Date(`${value.slice(0, 10)}T12:00:00`);
  return Number.isNaN(date.valueOf()) ? escapeHtml(value) : date.toLocaleDateString('pt-BR');
}
function collectionTimeLabel(value) {
  const date = new Date(value ?? NaN);
  return Number.isNaN(date.valueOf()) ? null : fmtCollectionTime.format(date);
}
function renderCollectionStatus() {
  const banner = document.getElementById('collectionStatus');
  const health = publicMeta?.health?.status || 'unknown';
  const lastSuccess = collectionTimeLabel(publicMeta?.last_successful_update);
  const failedSource = publicMeta?.sources?.find(source => source.status === 'failed');
  const lastAttempt = collectionTimeLabel(failedSource?.last_run_at);
  const readRate = failedSource?.metrics?.page_parse_success_fraction;
  const failureDetails = [
    lastSuccess ? `Dados exibidos da coleta de ${lastSuccess}.` : 'Ainda não há uma coleta válida.',
    lastAttempt ? `Tentativa mais recente em ${lastAttempt}.` : '',
    Number.isFinite(readRate) ? `${fmtReadRate.format(readRate)} das páginas elegíveis foram lidas.` : ''
  ].filter(Boolean).join(' ');
  const presentations = {
    healthy: ['success', 'Dados atualizados', lastSuccess ? `Última coleta válida em ${lastSuccess}.` : 'A coleta diária foi concluída.'],
    success: ['success', 'Dados atualizados', lastSuccess ? `Última coleta válida em ${lastSuccess}.` : 'A coleta diária foi concluída.'],
    degraded: ['degraded', 'Coleta parcial', lastSuccess ? `Última coleta válida em ${lastSuccess}. Algumas fontes precisam de atenção.` : 'Os dados válidos foram mantidos; algumas fontes precisam de atenção.'],
    running: ['running', 'Coleta em andamento', 'Os dados serão publicados depois da validação.'],
    failed: [
      'failed',
      lastSuccess ? 'A última coleta falhou' : 'Ainda não há dados válidos',
      failureDetails
    ],
    unknown: ['degraded', 'Aguardando a coleta diária', 'O histórico de 2021 e 2026 continua disponível.']
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
    Aluguel pedido: <strong>${listing.price == null ? 'sem valor' : fmtBRL.format(listing.price)}</strong><br>
    Condomínio: ${listing.condo_fee == null ? 'sem valor' : fmtBRL.format(listing.condo_fee)} · IPTU: ${listing.iptu == null ? 'sem valor' : fmtBRL.format(listing.iptu)}<br>
    Total anunciado: <strong>${listing.total_price == null ? 'sem valor' : fmtBRL.format(listing.total_price)}</strong><br>
    Aluguel/m²: ${listing.price_m2 == null ? 'sem dado' : fmtBRL.format(listing.price_m2)}<br>
    Localização: ${listing.location_precision === 'neighborhood' ? 'aproximada pelo centro do bairro' : 'informada no anúncio'}<br>
    Observado desde: ${localDateLabel(listing.first_seen_at)}<br>
    Última observação: ${localDateLabel(listing.last_seen_at)}<br>
    Tempo no levantamento: ${fmtNum.format(listing.days_listed || 0)} dias<br>
    Fonte: ${escapeHtml(listing.source || 'sem informação')}<br>
    ${historyMarkup}<br>${safeExternalLink(listing.url)}<br>${listing.neighborhood ? profileLink(listing.neighborhood) : ''}
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
function listingPriceDrop(listing) {
  const history = (listing.price_history || []).filter(point => Number.isFinite(point.price));
  if (history.length < 2) return { dropped: false, amount: 0, pct: 0 };
  const initial = history[0].price;
  const current = Number.isFinite(listing.price) ? listing.price : history.at(-1).price;
  if (!(initial > current)) return { dropped: false, amount: 0, pct: 0 };
  return { dropped: true, amount: initial - current, pct: (current / initial) - 1 };
}
function currentDailyFilters() {
  const belowBtn = document.querySelector('.quick-chip[data-chip="belowMedian"]');
  const dropBtn = document.querySelector('.quick-chip[data-chip="priceDrop"]');
  return {
    city: document.getElementById('cityFilter').value,
    neighborhood: document.getElementById('neighborhoodFilter').value,
    propertyType: document.getElementById('typeFilterWrap').hidden ? 'all' : document.getElementById('typeFilter').value,
    minRooms: Number(document.getElementById('dailyRooms')?.value || 0),
    minArea: Number(document.getElementById('dailyMinArea')?.value || 0),
    onlyBelowMedian: belowBtn?.getAttribute('aria-pressed') === 'true',
    onlyPriceDrop: dropBtn?.getAttribute('aria-pressed') === 'true'
  };
}
function matchesDailyArea(item, filters, isListing = false) {
  if (filters.city !== 'all' && norm(item.city) !== norm(filters.city)) return false;
  if (filters.neighborhood !== 'all' && norm(item.neighborhood) !== norm(filters.neighborhood)) return false;
  if (filters.propertyType !== 'all' && item.property_type && item.property_type !== filters.propertyType) return false;
  if (isListing) {
    if (filters.minRooms > 0 && !(Number(item.rooms) >= filters.minRooms)) return false;
    if (filters.minArea > 0 && !(Number(item.area) >= filters.minArea)) return false;
  }
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
    ${safeExternalLink(event.url)}<br>${event.neighborhood ? profileLink(event.neighborhood) : ''}`;
}
function dailyNeighborhoodPopup(row) {
  return `<strong>${escapeHtml(row.neighborhood || 'Sem bairro')}</strong><br>
    Cidade: ${escapeHtml(row.city || 'sem cidade')}<br>
    Anúncios ativos: ${fmtNum.format(row.active || 0)}<br>
    Mediana do aluguel pedido: ${row.median_rent == null ? 'sem dado' : fmtBRL.format(row.median_rent)}<br>
    Mediana do aluguel pedido/m²: ${row.median_price_m2 == null ? 'sem dado' : `${fmtBRL.format(row.median_price_m2)}/m²`}<br>
    P25 / P75 do aluguel/m²: ${row.p25_price_m2 == null ? 'sem dado' : `${fmtBRL.format(row.p25_price_m2)} / ${fmtBRL.format(row.p75_price_m2)}`}<br>
    Novos: ${fmtNum.format(row.new || 0)} · retirados: ${fmtNum.format(row.removed || 0)}<br>
    Reduções: ${fmtNum.format(row.price_reduced || 0)} · aumentos: ${fmtNum.format(row.price_increased || 0)}<br>
    Variação 7d / 30d: ${pct(row.variation_7d)} / ${pct(row.variation_30d)}<br>
    ${profileLink(row.neighborhood)}`;
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
const priceViews = {
  total_price:{label:'total anunciado', unit:'R$/mês'},
  price:{label:'aluguel pedido', unit:'R$/mês'},
  price_m2:{label:'aluguel por m²', unit:'R$/m²'}
};
function priceLabel(value, field) {
  return `${fmtBRL.format(value)}${field === 'price_m2' ? '/m²' : ''}`;
}
function selectedPriceRange() {
  const field = document.getElementById('dailyPriceView').value;
  const minRaw = document.getElementById('dailyPriceMin').value;
  const maxRaw = document.getElementById('dailyPriceMax').value;
  return {
    field,
    min:minRaw === '' ? null : Number(minRaw),
    max:maxRaw === '' ? null : Number(maxRaw),
    invalid:minRaw !== '' && maxRaw !== '' && Number(minRaw) > Number(maxRaw)
  };
}
let listingMarkersById = new Map();
let dealsSortMode = 'discount';
let dealsVisibleCount = 9;
let lastDealsFilterKey = '';

function computeBenchmarks() {
  const benchmarkListings = currentListings.filter(item => item.available && safeExternalUrl(item.url)
    && Number.isFinite(item.area) && item.area >= 15 && item.area <= 500
    && Number.isFinite(item.total_price) && item.total_price >= 200 && item.total_price <= 50000
    && item.total_price / item.area >= 5 && item.total_price / item.area <= 300);
  const byNeighborhood = new Map(), byCity = new Map();
  for (const item of benchmarkListings) {
    const value = item.total_price / item.area;
    const cityKey = `${norm(item.city)}|${item.property_type}`;
    const neighborhoodKey = `${cityKey}|${norm(item.neighborhood)}`;
    if (!byCity.has(cityKey)) byCity.set(cityKey, []);
    if (!byNeighborhood.has(neighborhoodKey)) byNeighborhood.set(neighborhoodKey, []);
    byCity.get(cityKey).push(value);
    byNeighborhood.get(neighborhoodKey).push(value);
  }
  const cityMedians = new Map([...byCity].map(([key, values]) => [key, median(values)]));
  const neighborhoodMedians = new Map([...byNeighborhood].map(([key, values]) => [key, median(values)]));
  return { byCity, byNeighborhood, cityMedians, neighborhoodMedians };
}

function enrichListing(item, benchmarks) {
  const hasArea = Number.isFinite(item.area) && item.area > 0 && Number.isFinite(item.total_price);
  const costM2 = hasArea ? item.total_price / item.area : null;
  const cityKey = `${norm(item.city)}|${item.property_type}`;
  const neighborhoodKey = `${cityKey}|${norm(item.neighborhood)}`;
  const cityValues = benchmarks.byCity.get(cityKey) || [];
  const neighborhoodValues = benchmarks.byNeighborhood.get(neighborhoodKey) || [];
  const cityMedian = cityValues.length >= 10 ? benchmarks.cityMedians.get(cityKey) : null;
  const neighborhoodMedian = neighborhoodValues.length >= 5 ? benchmarks.neighborhoodMedians.get(neighborhoodKey) : null;
  const cityDiscount = costM2 && cityMedian ? 1 - costM2 / cityMedian : null;
  const neighborhoodDiscount = costM2 && neighborhoodMedian ? 1 - costM2 / neighborhoodMedian : null;
  const refMedian = neighborhoodMedian ?? cityMedian;
  const estimatedMonthlySaving = (costM2 && refMedian && costM2 < refMedian)
    ? Math.max(0, (refMedian - costM2) * item.area)
    : 0;
  const drop = listingPriceDrop(item);
  const bestDiscount = neighborhoodDiscount ?? cityDiscount ?? -999;
  return {
    item, costM2, cityDiscount, neighborhoodDiscount,
    estimatedMonthlySaving, drop, bestDiscount
  };
}

function drawCurrentRentalListings(listings, field) {
  listingMarkersById = new Map();
  const located = listings.filter(item => Number.isFinite(item.lat) && Number.isFinite(item.lon));
  const layer = L.layerGroup();
  const cap = percentile(located.map(item => item[field]).filter(Number.isFinite), .95) || 1;
  located.forEach(item => {
    const color = colorForRatio(Math.max(.05, Math.min(item[field] || 0, cap) / cap));
    const popup = listingPopup(item);
    const marker = L.circleMarker([item.lat, item.lon], {
      radius:5, color:'#334155', weight:.7, fillColor:color, fillOpacity:.72
    }).bindTooltip(`${escapeHtml(item.neighborhood || 'Sem bairro')} · ${priceLabel(item[field], field)}`, {sticky:true})
      .bindPopup(popup, {maxWidth:330});
    marker.addTo(layer);
    if (item.id) listingMarkersById.set(String(item.id), marker);
  });
  layer.addTo(map);
  currentLayers.push(layer);
  if (located.length) {
    window.legendControl = L.control({position:'bottomright'});
    window.legendControl.onAdd = () => {
      const div = L.DomUtil.create('div', 'legend');
      div.innerHTML = `<strong>Cor · ${priceViews[field].label}</strong><div class="bar-price"></div><span>R$ 0 → ${priceLabel(cap, field)} ou mais</span>`;
      return div;
    };
    window.legendControl.addTo(map);
  }
  return located.length;
}

function focusListingOnMap(listingId) {
  const item = currentListings.find(entry => String(entry.id) === String(listingId));
  const marker = listingMarkersById.get(String(listingId));
  if (!item || !Number.isFinite(item.lat) || !Number.isFinite(item.lon)) return;
  document.getElementById('map').scrollIntoView({ behavior: 'smooth', block: 'center' });
  map.setView([item.lat, item.lon], Math.max(map.getZoom(), 16), { animate: true });
  if (marker) marker.openPopup();
}

function renderDailyDeals(enrichedListings, filterKey) {
  const host = document.getElementById('dailyDeals');
  if (filterKey !== lastDealsFilterKey) {
    dealsVisibleCount = 9;
    lastDealsFilterKey = filterKey;
  }
  const sorters = {
    discount: (a, b) => b.bestDiscount - a.bestDiscount || (a.item.total_price || 0) - (b.item.total_price || 0),
    total_asc: (a, b) => (a.item.total_price || 9e9) - (b.item.total_price || 9e9),
    m2_asc: (a, b) => (a.costM2 || 9e9) - (b.costM2 || 9e9),
    price_drop: (a, b) => (b.drop.amount - a.drop.amount) || b.bestDiscount - a.bestDiscount,
    newest: (a, b) => (a.item.days_listed ?? 9e9) - (b.item.days_listed ?? 9e9)
  };
  const sorted = [...enrichedListings].filter(entry => safeExternalUrl(entry.item.url)).sort(sorters[dealsSortMode] || sorters.discount);
  const visible = sorted.slice(0, dealsVisibleCount);
  const remaining = Math.max(0, sorted.length - visible.length);
  const propertyTypes = {apartment:'Apartamento', house:'Casa', kitnet:'Kitnet'};

  host.innerHTML = `<div class="daily-deals-heading">
      <div><span>OPORTUNIDADES ENCONTRADAS</span><h2>Imóveis ordenados pelo melhor custo-benefício</h2><p>Compare o custo mensal total (aluguel + condomínio + IPTU) com a mediana do bairro e da cidade.</p></div>
      <div class="daily-deals-actions">
        <span class="deals-count">${fmtNum.format(sorted.length)} imóveis na busca</span>
        <div class="deals-sort-wrap">
          <label for="dailySort">Ordenar por</label>
          <select id="dailySort">
            <option value="discount"${dealsSortMode === 'discount' ? ' selected' : ''}>Maior desconto vs. bairro</option>
            <option value="total_asc"${dealsSortMode === 'total_asc' ? ' selected' : ''}>Menor custo total/mês</option>
            <option value="m2_asc"${dealsSortMode === 'm2_asc' ? ' selected' : ''}>Menor preço/m²</option>
            <option value="price_drop"${dealsSortMode === 'price_drop' ? ' selected' : ''}>Maior redução de preço</option>
            <option value="newest"${dealsSortMode === 'newest' ? ' selected' : ''}>Mais recentes no ar</option>
          </select>
        </div>
      </div>
    </div>
    ${visible.length ? `<div class="daily-deals-grid">${visible.map(({item, costM2, cityDiscount, neighborhoodDiscount, estimatedMonthlySaving, drop}, index) => {
      const specs = [
        propertyTypes[item.property_type] || 'Imóvel',
        Number.isFinite(item.rooms) ? `${fmtNum.format(item.rooms)} ${item.rooms === 1 ? 'quarto' : 'quartos'}` : null,
        Number.isFinite(item.area) ? `${fmtNum.format(item.area)} m²` : null,
        Number.isFinite(item.parking_spaces) && item.parking_spaces > 0 ? `${fmtNum.format(item.parking_spaces)} ${item.parking_spaces === 1 ? 'vaga' : 'vagas'}` : null
      ].filter(Boolean).join(' · ');
      const breakdown = [
        Number.isFinite(item.price) ? `Aluguel ${fmtBRL.format(item.price)}` : null,
        Number.isFinite(item.condo_fee) && item.condo_fee > 0 ? `Cond. ${fmtBRL.format(item.condo_fee)}` : null,
        Number.isFinite(item.iptu) && item.iptu > 0 ? `IPTU ${fmtBRL.format(item.iptu)}` : null
      ].filter(Boolean).join(' + ');
      const hasMapCoords = Number.isFinite(item.lat) && Number.isFinite(item.lon);
      return `
      <article class="daily-deal-card">
        <div class="deal-card-top">
          <span class="daily-deal-index">${String(index + 1).padStart(2, '0')}</span>
          <div class="deal-badges">
            ${neighborhoodDiscount != null && neighborhoodDiscount > 0 ? `<span class="deal-badge deal-badge-discount">${Math.round(neighborhoodDiscount * 100)}% abaixo do bairro</span>` : ''}
            ${drop.dropped ? `<span class="deal-badge deal-badge-drop">Caiu ${fmtBRL.format(drop.amount)}</span>` : ''}
          </div>
        </div>
        <h3>${escapeHtml(item.neighborhood || 'Bairro não informado')}</h3>
        <p class="daily-deal-city">${escapeHtml(item.city || 'Cidade não informada')} · ${escapeHtml(specs)}</p>
        <div class="daily-deal-price">
          <strong>${fmtBRL.format(item.total_price)}<small>/mês</small></strong>
          <small>${escapeHtml(breakdown || 'Total anunciado')}</small>
        </div>
        <div class="daily-deal-details">
          ${costM2 ? `<span>${fmtBRL.format(costM2)}/m² total</span>` : ''}
          ${cityDiscount != null && cityDiscount > 0 ? `<span>${Math.round(cityDiscount * 100)}% abaixo da cidade</span>` : ''}
          ${estimatedMonthlySaving >= 50 ? `<span>Economia ~${fmtBRL.format(estimatedMonthlySaving)}/mês</span>` : ''}
          <span>${fmtNum.format(item.days_listed || 0)} dias no ar</span>
        </div>
        <div class="deal-card-actions">
          ${hasMapCoords ? `<button type="button" class="deal-map-btn" data-listing-id="${escapeHtml(item.id)}">Ver no mapa</button>` : ''}
          <a href="${escapeHtml(safeExternalUrl(item.url))}" target="_blank" rel="noopener noreferrer">Ver anúncio <b aria-hidden="true">↗</b></a>
        </div>
      </article>`;
    }).join('')}</div>` : '<p class="daily-deals-empty">Nenhum imóvel encontrado com esses filtros. Tente ampliar o orçamento máximo ou limpar os filtros.</p>'}
    ${remaining > 0 ? `<div class="deals-more-wrap"><button type="button" id="dealsShowMore" class="deals-more-btn">Mostrar mais imóveis (+${fmtNum.format(Math.min(9, remaining))} de ${fmtNum.format(remaining)} restantes)</button></div>` : ''}
    <p class="daily-deals-note">A comparação por bairro exige ao menos 5 imóveis do mesmo tipo no bairro e 10 na cidade. Confira conservação, localização exata e disponibilidade no anúncio.</p>`;

  const sortEl = document.getElementById('dailySort');
  if (sortEl) {
    sortEl.addEventListener('change', () => {
      dealsSortMode = sortEl.value;
      renderDailyDeals(enrichedListings, filterKey);
    });
  }
  const moreBtn = document.getElementById('dealsShowMore');
  if (moreBtn) {
    moreBtn.addEventListener('click', () => {
      dealsVisibleCount += 9;
      renderDailyDeals(enrichedListings, filterKey);
    });
  }
  host.querySelectorAll('.deal-map-btn').forEach(btn => {
    btn.addEventListener('click', () => focusListingOnMap(btn.dataset.listingId));
  });
}
function dailySummary(rows, selectedDate, metric, currentContext=null) {
  const totals = rows.reduce((sum, row) => {
    for (const field of ['active', 'new', 'removed', 'price_reduced', 'price_increased']) sum[field] += Number(row[field]) || 0;
    return sum;
  }, {active:0, new:0, removed:0, price_reduced:0, price_increased:0});
  const neighborhoodMedians = rows.map(row => row.median_price_m2).filter(Number.isFinite);
  const latestDate = neighborhoodDaily.reduce((latest, row) => row.date > latest ? row.date : latest, '');
  const previousDate = neighborhoodDaily.reduce((previous, row) => row.date < selectedDate && row.date > previous ? row.date : previous, '');
  const previousByNeighborhood = new Map(neighborhoodDaily
    .filter(row => row.date === previousDate && matchesDailyArea(row, currentDailyFilters()) && row.neighborhood && Number(row.active) >= 5)
    .map(row => [`${norm(row.city)}|${norm(row.neighborhood)}`, row]));
  const previousComparisons = rows.map(row => {
    const old = previousByNeighborhood.get(`${norm(row.city)}|${norm(row.neighborhood)}`);
    return Number(row.active) >= 5 && old && Number(old.median_price_m2) > 0 && Number.isFinite(row.median_price_m2)
      ? (Number(row.median_price_m2) / Number(old.median_price_m2)) - 1 : null;
  }).filter(Number.isFinite);
  const historicalByNeighborhood = new Map();
  for (const row of neighborhoodDaily) {
    if (row.date >= selectedDate || !matchesDailyArea(row, currentDailyFilters()) || Number(row.active) < 5
      || !row.neighborhood || !Number.isFinite(row.median_price_m2)) continue;
    const key = `${norm(row.city)}|${norm(row.neighborhood)}`;
    if (!historicalByNeighborhood.has(key)) historicalByNeighborhood.set(key, []);
    historicalByNeighborhood.get(key).push({date:row.date, value:Number(row.median_price_m2)});
  }
  const areaFilters = currentDailyFilters();
  const cityMedians = new Map();
  const cityValues = new Map();
  for (const row of neighborhoodDaily) {
    if (row.date !== selectedDate || !row.city
      || (areaFilters.city !== 'all' && norm(row.city) !== norm(areaFilters.city))
      || Number(row.active) < 5 || !Number.isFinite(row.median_price_m2)) continue;
    const key = norm(row.city);
    if (!cityValues.has(key)) cityValues.set(key, []);
    cityValues.get(key).push(Number(row.median_price_m2));
  }
  for (const [city, values] of cityValues) cityMedians.set(city, median(values));
  const historicalComparison = rows.map(row => {
    const history = historicalByNeighborhood.get(`${norm(row.city)}|${norm(row.neighborhood)}`) || [];
    if (Number(row.active) < 5 || !Number.isFinite(row.median_price_m2) || history.length < 3) return null;
    const average = history.reduce((sum, point) => sum + point.value, 0) / history.length;
    const cityMedian = cityMedians.get(norm(row.city));
    return {
      row, average, dates:history.length,
      relative:(Number(row.median_price_m2) / average) - 1,
      cityRelative:cityMedian ? (Number(row.median_price_m2) / cityMedian) - 1 : null
    };
  }).filter(Boolean);
  const historicalWindow = [...historicalByNeighborhood.values()].flat().map(point => point.date).sort();
  const historicalStart = historicalWindow[0] || null;
  const historicalEnd = historicalWindow.at(-1) || null;
  const relativeToHistory = median(historicalComparison.map(item => item.relative));
  const lowerCostNeighborhoods = historicalComparison.filter(item => item.relative < 0 && item.cityRelative != null && item.cityRelative < 0);
  const trendPrevious = median(previousComparisons);
  const trend30Rows = rows.filter(row => Number(row.active) >= 5 && Number.isFinite(row.variation_30d));
  const trend30d = median(trend30Rows.map(row => row.variation_30d));
  const trend30Up = trend30Rows.filter(row => row.variation_30d > 0).length;
  const trend30Down = trend30Rows.filter(row => row.variation_30d < 0).length;
  const currentRentListings = selectedDate === latestDate
    ? currentListings.filter(item => item.available && matchesDailyArea(item, currentDailyFilters()))
    : [];
  const currentRents = currentRentListings.map(item => item.price).filter(Number.isFinite);
  const reductionsObserved = currentRentListings.filter(item => {
    const history = (item.price_history || []).filter(point => Number.isFinite(point.price));
    return history.some((point, index) => index > 0 && point.price < history[index - 1].price);
  }).length;
  const medianDaysListed = median(currentRentListings.map(item => item.days_listed).filter(Number.isFinite));
  const rankingFilters = {...currentDailyFilters(), neighborhood:'all'};
  const rankingListings = currentListings.filter(item => item.available && matchesDailyArea(item, rankingFilters)
    && Number.isFinite(item.total_price) && Number(item.area) > 0 && item.property_type);
  const cityTypeGroups = new Map();
  const neighborhoodTypeGroups = new Map();
  for (const item of rankingListings) {
    const cityType = `${norm(item.city)}|${item.property_type}`;
    const neighborhoodType = `${cityType}|${norm(item.neighborhood)}`;
    if (!cityTypeGroups.has(cityType)) cityTypeGroups.set(cityType, []);
    cityTypeGroups.get(cityType).push(item);
    if (item.neighborhood) {
      if (!neighborhoodTypeGroups.has(neighborhoodType)) neighborhoodTypeGroups.set(neighborhoodType, []);
      neighborhoodTypeGroups.get(neighborhoodType).push(item);
    }
  }
  const affordabilityRows = [...neighborhoodTypeGroups.entries()].flatMap(([key, listings]) => {
    const cityType = key.split('|').slice(0, 2).join('|');
    const cityListings = cityTypeGroups.get(cityType) || [];
    if (listings.length < 8 || cityListings.length < 30) return [];
    const cityMedianM2 = median(cityListings.map(item => item.price_m2).filter(Number.isFinite));
    const neighborhoodMedianM2 = median(listings.map(item => item.price_m2).filter(Number.isFinite));
    return [{
      neighborhood:listings[0].neighborhood,
      city:listings[0].city,
      propertyType:listings[0].property_type,
      count:listings.length,
      medianTotal:median(listings.map(item => item.total_price)),
      medianM2:neighborhoodMedianM2,
      cityRelative:cityMedianM2 ? (neighborhoodMedianM2 / cityMedianM2) - 1 : null
    }];
  }).sort((a,b) => a.medianTotal - b.medianTotal);
  const lastSuccess = collectionTimeLabel(publicMeta?.last_successful_update) || 'sem coleta válida';
  const sourceHealth = publicMeta?.health?.sources || {};
  const sourceHealthText = publicMeta?.sources?.length
    ? `${sourceHealth.healthy || 0} em ordem · ${sourceHealth.degraded || 0} com atenção · ${sourceHealth.failed || 0} com falha · ${sourceHealth.running || 0} em andamento`
    : 'sem coleta';
  document.getElementById('stats').innerHTML = `
    ${currentContext ? `<div class="stat"><strong>${fmtNum.format(currentContext.plotted)}</strong>anúncios no mapa · dentro da faixa de preço</div><div class="stat"><strong>${currentContext.listings.length ? priceLabel(median(currentContext.listings.map(item => item[currentContext.field])), currentContext.field) : 'sem dado'}</strong>mediana dos anúncios na faixa · ${priceViews[currentContext.field].label}</div>` : ''}
    ${currentContext ? `<div class="stat"><strong>${pct(trendPrevious)}</strong>mudança do mercado desde a coleta anterior${previousDate ? ` · ${localDateLabel(previousDate)}` : ''} · ${previousComparisons.length} bairros</div><div class="stat"><strong>${pct(trend30d)}</strong>mudança do mercado em 30 dias · ${trend30Up} bairros em alta, ${trend30Down} em queda, ${Math.max(0, trend30Rows.length - trend30Up - trend30Down)} estáveis</div><div class="stat"><strong>${pct(relativeToHistory)}</strong>diferença mediana para a média histórica de cada bairro · ${historicalComparison.length} comparáveis</div><div class="stat"><strong>${fmtNum.format(lowerCostNeighborhoods.length)}</strong>bairros abaixo da média histórica e da mediana da cidade</div><div class="stat"><strong>${historicalStart && historicalEnd ? `${localDateLabel(historicalStart)} a ${localDateLabel(historicalEnd)}` : 'sem histórico suficiente'}</strong>período usado para a média histórica · mínimo de 3 coletas e 5 anúncios por data</div><div class="stat"><strong>${medianDaysListed == null ? 'sem dado' : `${Math.round(medianDaysListed)} dias`}</strong>tempo mediano anunciado · ${reductionsObserved} ofertas com redução observada</div>` : ''}
    <div class="stat"><strong>${fmtNum.format(totals.active)}</strong>anúncios ativos na data (sem aplicar a faixa de preço)</div>
    <div class="stat"><strong>${fmtNum.format(totals.new)}</strong>novos anúncios</div>
    <div class="stat"><strong>${fmtNum.format(totals.removed)}</strong>anúncios retirados</div>
    <div class="stat"><strong>${fmtNum.format(totals.price_reduced)} / ${fmtNum.format(totals.price_increased)}</strong>anúncios com redução / aumento de preço</div>
    <div class="stat"><strong>${currentRents.length ? fmtBRL.format(median(currentRents)) : 'sem dado'}</strong>mediana do aluguel pedido${selectedDate === latestDate ? ' · sem aplicar a faixa de preço' : ' · apenas na data mais recente'}</div>
    <div class="stat"><strong>${neighborhoodMedians.length ? `${fmtBRL.format(median(neighborhoodMedians))}/m²` : 'sem dado'}</strong>mediana dos valores medianos por bairro</div>
    <div class="stat"><strong>${escapeHtml(lastSuccess)}</strong>última coleta válida</div>
    <div class="stat"><strong>${escapeHtml(sourceHealthText)}</strong>status das fontes</div>`;

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
      <div class="stat comparison-title" style="grid-column:1/-1"><strong>${localDateLabel(selectedDate)} ↔ ${localDateLabel(compareDate)}</strong>Dados da área filtrada</div>
      <div class="stat"><strong>${fmtNum.format(current.active)} ↔ ${fmtNum.format(earlier.active)}</strong>anúncios ativos: data escolhida ↔ comparação</div>
      <div class="stat"><strong>${change(current.active, earlier.active)}</strong>mudança na oferta ativa</div>
      <div class="stat"><strong>${current.medianM2 == null ? 'sem dado' : fmtBRL.format(current.medianM2)} ↔ ${earlier.medianM2 == null ? 'sem dado' : fmtBRL.format(earlier.medianM2)}</strong>mediana por bairro do aluguel/m²</div>
      <div class="stat"><strong>${current.medianM2 == null || earlier.medianM2 == null ? 'sem base' : change(current.medianM2, earlier.medianM2)}</strong>variação da mediana por bairro</div>
      <div class="stat"><strong>${fmtNum.format(current.new)} ↔ ${fmtNum.format(earlier.new)}</strong>novos anúncios: data escolhida ↔ comparação</div>
      <div class="stat"><strong>${fmtNum.format(current.removed)} ↔ ${fmtNum.format(earlier.removed)}</strong>anúncios retirados: data escolhida ↔ comparação</div>`
      : `<div class="stat" style="grid-column:1/-1"><strong>${localDateLabel(compareDate)}</strong>Não há dados nessa data com os filtros atuais.</div>`;
  } else {
    compareBox.hidden = true;
    compareBox.innerHTML = '';
  }

  const filters = currentDailyFilters();
  const selectedRows = filters.neighborhood === 'all' ? [] : rows.filter(row =>
    norm(row.neighborhood) === norm(filters.neighborhood));
  const summary = document.getElementById('neighborhoodSummary');
  if (!selectedRows.length) {
    summary.innerHTML = `<div class="stat" style="grid-column:1/-1"><strong>${escapeHtml(localDateLabel(selectedDate))}</strong>Escolha um bairro para consultar os dados diários.</div>`;
  } else {
    const medRent = median(selectedRows.map(row => row.median_rent).filter(Number.isFinite));
    const medM2 = median(selectedRows.map(row => row.median_price_m2).filter(Number.isFinite));
    const p25 = median(selectedRows.map(row => row.p25_price_m2).filter(Number.isFinite));
    const p75 = median(selectedRows.map(row => row.p75_price_m2).filter(Number.isFinite));
    const total = field => selectedRows.reduce((sum, row) => sum + (Number(row[field]) || 0), 0);
    summary.innerHTML = `
      ${currentContext ? `<div class="stat"><strong>${fmtNum.format(currentContext.listings.length)}</strong>anúncios do bairro na faixa</div>` : ''}
      <div class="stat"><strong>${fmtNum.format(total('active'))}</strong>anúncios ativos no bairro (sem aplicar a faixa de preço)</div>
      <div class="stat"><strong>${medRent == null ? 'sem dado' : fmtBRL.format(medRent)}</strong>mediana do aluguel</div>
      <div class="stat"><strong>${medM2 == null ? 'sem dado' : `${fmtBRL.format(medM2)}/m²`}</strong>mediana do aluguel/m²</div>
      <div class="stat"><strong>${p25 == null ? 'sem dado' : `${fmtBRL.format(p25)} / ${fmtBRL.format(p75)}`}</strong>P25 / P75 do aluguel/m²</div>
      <div class="stat"><strong>${pct(median(selectedRows.map(row => row.variation_7d).filter(Number.isFinite)))}</strong>variação em 7 dias</div>
      <div class="stat"><strong>${pct(median(selectedRows.map(row => row.variation_30d).filter(Number.isFinite)))}</strong>variação em 30 dias</div>
      <div class="stat"><strong>${fmtNum.format(total('new'))} / ${fmtNum.format(total('removed'))}</strong>anúncios novos / retirados</div>
      <div class="stat"><strong>${fmtNum.format(total('price_reduced'))} / ${fmtNum.format(total('price_increased'))}</strong>anúncios com redução / aumento de preço</div>`;
  }
  if (currentContext) {
    const counts = new Map();
    for (const item of currentContext.listings) {
      const key = `${norm(item.city)}|${norm(item.neighborhood)}`;
      if (!counts.has(key)) counts.set(key, {city:item.city, neighborhood:item.neighborhood || 'Sem bairro', count:0});
      counts.get(key).count++;
    }
    const orderedCounts = [...counts.values()].sort((a,b) => b.count - a.count || a.neighborhood.localeCompare(b.neighborhood, 'pt-BR')).slice(0,14);
    const rankingEl = document.getElementById('ranking');
    document.getElementById('rankingLabel').textContent = affordabilityRows.length ? 'Bairros mais baratos agora' : 'Anúncios por bairro na faixa';
    rankingEl.innerHTML = affordabilityRows.length
      ? affordabilityRows.slice(0,14).map(row => `<li><button type="button" class="ranking-filter-btn" data-neighborhood="${escapeHtml(row.neighborhood)}"><span>${escapeHtml(row.neighborhood)} <small>${escapeHtml(row.city || '')} · ${row.count} ofertas · ${row.propertyType === 'apartment' ? 'apartamentos' : row.propertyType === 'house' ? 'casas' : 'kitnets'}</small></span><span>${fmtBRL.format(row.medianTotal)}/mês · ${pct(row.cityRelative)}</span></button></li>`).join('')
      : orderedCounts.map(row => `<li><button type="button" class="ranking-filter-btn" data-neighborhood="${escapeHtml(row.neighborhood)}"><span>${escapeHtml(row.neighborhood)} <small>(${escapeHtml(row.city || 'sem cidade')})</small></span><span>${fmtNum.format(row.count)}</span></button></li>`).join('') || '<li>Nenhum anúncio nesta faixa de preço e área.</li>';
    rankingEl.querySelectorAll('.ranking-filter-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const nb = btn.dataset.neighborhood;
        const nbSelect = document.getElementById('dailyNeighborhood');
        const mainNbSelect = document.getElementById('neighborhoodFilter');
        if (nbSelect && mainNbSelect) {
          nbSelect.value = nb;
          mainNbSelect.value = nb;
          nbSelect.dispatchEvent(new Event('change'));
          document.getElementById('dailyPriceTools')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      });
    });
    return;
  }
  const ordered = [...rows].filter(row => row.neighborhood && row[metric] != null && Number.isFinite(Number(row[metric])))
    .sort((a,b) => metric.startsWith('variation_')
      ? Math.abs(Number(b[metric])) - Math.abs(Number(a[metric]))
      : Number(b[metric]) - Number(a[metric])).slice(0, 14);
  document.getElementById('rankingLabel').textContent = `Bairros · ${dailyMetricLabels[metric] || metric}`;
  document.getElementById('ranking').innerHTML = ordered.map(row =>
    `<li><span>${escapeHtml(row.neighborhood)} <small>(${fmtNum.format(row.active || 0)} ativos)</small></span><span>${escapeHtml(formatDailyMetric(Number(row[metric]), metric))}</span></li>`
  ).join('') || '<li>Não há dados para esta data e métrica.</li>';
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
  const currentView = metric === 'active' && selectedDate === latestDate;
  document.getElementById('dailyPriceTools').hidden = !currentView;
  document.getElementById('dailyDeals').hidden = !currentView;
  let currentContext = null;
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
  } else if (currentView) {
    const range = selectedPriceRange();
    const benchmarks = computeBenchmarks();
    const baseListings = currentListings.filter(item => item.available && matchesDailyArea(item, filters, true)
      && Number.isFinite(item[range.field]) && !range.invalid
      && (range.min == null || item[range.field] >= range.min)
      && (range.max == null || item[range.field] <= range.max));
    const enriched = baseListings
      .map(item => enrichListing(item, benchmarks))
      .filter(entry => (!filters.onlyBelowMedian || (entry.neighborhoodDiscount != null && entry.neighborhoodDiscount > 0) || (entry.cityDiscount != null && entry.cityDiscount > 0))
        && (!filters.onlyPriceDrop || entry.drop.dropped));
    const listings = enriched.map(entry => entry.item);
    plotted = drawCurrentRentalListings(listings, range.field);
    currentContext = {listings, plotted, field:range.field};
    const rangeHelp = document.getElementById('dailyPriceHelp');
    rangeHelp.textContent = range.invalid ? 'O valor mínimo precisa ser menor que o máximo.'
      : `A faixa usa ${priceViews[range.field].label} (${priceViews[range.field].unit}); as cores usam a mesma medida.`;
    rangeHelp.dataset.error = String(range.invalid);
    const filterKey = JSON.stringify([filters, range]);
    renderDailyDeals(enriched, filterKey);
    if ((range.min != null || range.max != null || filters.neighborhood !== 'all') && plotted) {
      const points = listings.filter(item => Number.isFinite(item.lat) && Number.isFinite(item.lon));
      if (points.length) map.fitBounds(L.latLngBounds(points.map(item => [item.lat, item.lon])), {padding:[32,32], maxZoom:14});
    }
  } else {
    plotted = drawDailyNeighborhoods(rows, metric);
  }
  dailySummary(rows, selectedDate, metric, currentContext);
  const lastSuccess = collectionTimeLabel(publicMeta?.last_successful_update) || 'sem coleta válida';
  const collectionFailed = publicMeta?.health?.status === 'failed';
  document.getElementById('note').textContent = rows.length
    ? currentView
      ? `${localDateLabel(selectedDate)} · ${plotted} anúncios dentro da faixa no mapa. O total anunciado soma aluguel, condomínio e IPTU, quando informados. As ofertas e recomendações respeitam o tipo selecionado; as tendências de bairro combinam tipos de imóvel. A localização fornecida pela fonte pode ser aproximada. Última coleta válida: ${lastSuccess}.`
      : `${localDateLabel(selectedDate)} · ${plotted} marcadores no mapa. Nas datas anteriores, cada marcador resume os dados do bairro; os anúncios individuais aparecem apenas na data mais recente, quando a métrica é “Oferta ativa”. Última coleta válida: ${lastSuccess}.`
    : collectionFailed
      ? 'Não foi possível validar a coleta diária. O histórico de 2021 e 2026 continua disponível enquanto a fonte é corrigida.'
      : `Sem dados diários para ${localDateLabel(selectedDate)} com os filtros atuais.`;
}
return { drawDaily, renderCollectionStatus, localDateLabel };
}
