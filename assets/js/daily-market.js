import { map, currentLayers, clearLayers } from './map.js';
import { median, percentile } from './statistics.js';
import { norm } from './filters.js';
import { currentListings, neighborhoodDaily, listingEvents, publicMeta } from './public-data.js';
import { profileLink } from './neighborhoods.js';

const fmtBRL = new Intl.NumberFormat('pt-BR', {style:'currency', currency:'BRL', maximumFractionDigits:0});
const fmtNum = new Intl.NumberFormat('pt-BR');

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
    degraded: ['degraded', 'Atualização parcial', lastSuccess ? `Última coleta válida em ${lastSuccess}. Uma fonte requer atenção.` : 'A base válida foi preservada enquanto uma fonte requer atenção.'],
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
    Condomínio: ${listing.condo_fee == null ? 'sem valor' : fmtBRL.format(listing.condo_fee)} · IPTU: ${listing.iptu == null ? 'sem valor' : fmtBRL.format(listing.iptu)}<br>
    Total anunciado: <strong>${listing.total_price == null ? 'sem valor' : fmtBRL.format(listing.total_price)}</strong><br>
    Aluguel/m²: ${listing.price_m2 == null ? 'sem dado' : fmtBRL.format(listing.price_m2)}<br>
    Localização: ${listing.location_precision === 'neighborhood' ? 'aproximada pelo centro do bairro' : 'informada no anúncio'}<br>
    Observado desde: ${localDateLabel(listing.first_seen_at)}<br>
    Última observação: ${localDateLabel(listing.last_seen_at)}<br>
    Tempo acompanhado: ${fmtNum.format(listing.days_listed || 0)} dias<br>
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
    ${safeExternalLink(event.url)}<br>${event.neighborhood ? profileLink(event.neighborhood) : ''}`;
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
function drawCurrentRentalListings(listings, field) {
  const located = listings.filter(item => Number.isFinite(item.lat) && Number.isFinite(item.lon));
  const layer = L.layerGroup();
  const cap = percentile(located.map(item => item[field]).filter(Number.isFinite), .95) || 1;
  located.forEach(item => {
    const color = colorForRatio(Math.max(.05, Math.min(item[field] || 0, cap) / cap));
    const popup = listingPopup(item);
    L.circleMarker([item.lat, item.lon], {
      radius:5, color:'#334155', weight:.7, fillColor:color, fillOpacity:.72
    }).bindTooltip(`${escapeHtml(item.neighborhood || 'Sem bairro')} · ${priceLabel(item[field], field)}`, {sticky:true})
      .bindPopup(popup, {maxWidth:330}).addTo(layer);
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
function renderDailyDeals(listings) {
  const host = document.getElementById('dailyDeals');
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
  const eligible = new Set(benchmarkListings);
  const candidates = listings.filter(item => eligible.has(item)).map(item => {
    const cityKey = `${norm(item.city)}|${item.property_type}`;
    const neighborhoodKey = `${cityKey}|${norm(item.neighborhood)}`;
    const cityValues = byCity.get(cityKey) || [];
    const neighborhoodValues = byNeighborhood.get(neighborhoodKey) || [];
    if (cityValues.length < 30 || neighborhoodValues.length < 8) return null;
    const costM2 = item.total_price / item.area;
    const cityMedian = cityMedians.get(cityKey), neighborhoodMedian = neighborhoodMedians.get(neighborhoodKey);
    const cityDiscount = 1 - costM2 / cityMedian;
    const neighborhoodDiscount = 1 - costM2 / neighborhoodMedian;
    if (cityDiscount <= 0 || neighborhoodDiscount <= 0) return null;
    return {item, costM2, cityDiscount, neighborhoodDiscount, score:Math.min(cityDiscount, neighborhoodDiscount)};
  }).filter(Boolean).sort((a,b) => b.score - a.score || a.item.total_price - b.item.total_price).slice(0, 3);
  const propertyTypes = {apartment:'Apartamento', house:'Casa', kitnet:'Kitnet'};
  host.innerHTML = `<div class="daily-deals-heading"><div><span>OLHAR DE PERTO</span><h2>Anúncios abaixo da referência</h2><p>Até três ofertas do mesmo tipo de imóvel, comparadas pelo total anunciado por m² com as medianas do bairro e da cidade.</p></div><small>${fmtNum.format(listings.length)} anúncios na seleção</small></div>
    ${candidates.length ? `<div class="daily-deals-grid">${candidates.map(({item, costM2, cityDiscount, neighborhoodDiscount}, index) => `
      <article class="daily-deal-card"><span class="daily-deal-index">0${index + 1} / OFERTA</span><h3>${escapeHtml(item.neighborhood || 'Bairro não informado')}</h3><p class="daily-deal-city">${escapeHtml(item.city || 'Cidade não informada')} · ${escapeHtml(propertyTypes[item.property_type] || 'Imóvel')} · ${fmtNum.format(item.area)} m²</p><div class="daily-deal-price"><strong>${fmtBRL.format(item.total_price)}</strong><small>/mês · aluguel + condomínio + IPTU</small></div><div class="daily-deal-details"><span>${fmtBRL.format(costM2)}/m² total</span><span>${Math.round(neighborhoodDiscount * 100)}% abaixo do bairro</span><span>${Math.round(cityDiscount * 100)}% abaixo da cidade</span></div><a href="${escapeHtml(safeExternalUrl(item.url))}" target="_blank" rel="noopener noreferrer">Ver anúncio <b aria-hidden="true">↗</b></a></article>`).join('')}</div>` : '<p class="daily-deals-empty">Nenhum anúncio da seleção tem amostra suficiente e preço abaixo das duas referências.</p>'}
    <p class="daily-deals-note">Referências: pelo menos 8 anúncios do mesmo tipo no bairro e 30 na cidade. Preço baixo não confirma qualidade, disponibilidade ou localização exata; confira no anúncio.</p>`;
}
function dailySummary(rows, selectedDate, metric, currentContext=null) {
  const totals = rows.reduce((sum, row) => {
    for (const field of ['active', 'new', 'removed', 'price_reduced', 'price_increased']) sum[field] += Number(row[field]) || 0;
    return sum;
  }, {active:0, new:0, removed:0, price_reduced:0, price_increased:0});
  const neighborhoodMedians = rows.map(row => row.median_price_m2).filter(Number.isFinite);
  const latestDate = neighborhoodDaily.reduce((latest, row) => row.date > latest ? row.date : latest, '');
  const currentRents = selectedDate === latestDate
    ? currentListings.filter(item => item.available && matchesDailyArea(item, currentDailyFilters()))
      .map(item => item.price).filter(Number.isFinite)
    : [];
  const lastSuccess = publicMeta?.last_successful_update
    ? new Date(publicMeta.last_successful_update).toLocaleString('pt-BR') : 'sem coleta válida';
  const sourceHealth = publicMeta?.health?.sources || {};
  const sourceHealthText = publicMeta?.sources?.length
    ? `${sourceHealth.healthy || 0} saudáveis · ${sourceHealth.degraded || 0} atenção · ${sourceHealth.failed || 0} falhas · ${sourceHealth.running || 0} em execução`
    : 'sem coleta';
  document.getElementById('stats').innerHTML = `
    ${currentContext ? `<div class="stat"><strong>${fmtNum.format(currentContext.plotted)}</strong>anúncios no mapa · faixa selecionada</div><div class="stat"><strong>${currentContext.listings.length ? priceLabel(median(currentContext.listings.map(item => item[currentContext.field])), currentContext.field) : 'sem dado'}</strong>mediana da faixa · ${priceViews[currentContext.field].label}</div>` : ''}
    <div class="stat"><strong>${fmtNum.format(totals.active)}</strong>anúncios ativos na coleta · sem faixa</div>
    <div class="stat"><strong>${fmtNum.format(totals.new)}</strong>novos anúncios</div>
    <div class="stat"><strong>${fmtNum.format(totals.removed)}</strong>retirados</div>
    <div class="stat"><strong>${fmtNum.format(totals.price_reduced)}</strong>reduções de preço</div>
    <div class="stat"><strong>${currentRents.length ? fmtBRL.format(median(currentRents)) : 'sem dado'}</strong>mediana do aluguel pedido${selectedDate === latestDate ? ' · sem faixa' : ' · somente data mais recente'}</div>
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
      ${currentContext ? `<div class="stat"><strong>${fmtNum.format(currentContext.listings.length)}</strong>anúncios do bairro na faixa</div>` : ''}
      <div class="stat"><strong>${fmtNum.format(total('active'))}</strong>ativos no bairro · sem faixa</div>
      <div class="stat"><strong>${medRent == null ? 'sem dado' : fmtBRL.format(medRent)}</strong>mediana do aluguel</div>
      <div class="stat"><strong>${medM2 == null ? 'sem dado' : `${fmtBRL.format(medM2)}/m²`}</strong>mediana do aluguel/m²</div>
      <div class="stat"><strong>${p25 == null ? 'sem dado' : `${fmtBRL.format(p25)} / ${fmtBRL.format(p75)}`}</strong>P25 / P75 por bairro</div>
      <div class="stat"><strong>${pct(median(selectedRows.map(row => row.variation_7d).filter(Number.isFinite)))}</strong>variação em 7 dias</div>
      <div class="stat"><strong>${pct(median(selectedRows.map(row => row.variation_30d).filter(Number.isFinite)))}</strong>variação em 30 dias</div>
      <div class="stat"><strong>${fmtNum.format(total('new'))} / ${fmtNum.format(total('removed'))}</strong>novos / retirados</div>
      <div class="stat"><strong>${fmtNum.format(total('price_reduced'))} / ${fmtNum.format(total('price_increased'))}</strong>reduções / aumentos</div>`;
  }
  if (currentContext) {
    const counts = new Map();
    for (const item of currentContext.listings) {
      const key = `${norm(item.city)}|${norm(item.neighborhood)}`;
      if (!counts.has(key)) counts.set(key, {city:item.city, neighborhood:item.neighborhood || 'Sem bairro', count:0});
      counts.get(key).count++;
    }
    const orderedCounts = [...counts.values()].sort((a,b) => b.count - a.count || a.neighborhood.localeCompare(b.neighborhood, 'pt-BR')).slice(0,14);
    document.getElementById('rankingLabel').textContent = 'Bairros · anúncios na faixa';
    document.getElementById('ranking').innerHTML = orderedCounts.map(row =>
      `<li><span>${escapeHtml(row.neighborhood)} <small>(${escapeHtml(row.city || 'sem cidade')})</small></span><span>${fmtNum.format(row.count)}</span></li>`
    ).join('') || '<li>Nenhum anúncio nesta faixa e área.</li>';
    return;
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
    const listings = currentListings.filter(item => item.available && matchesDailyArea(item, filters)
      && Number.isFinite(item[range.field]) && !range.invalid
      && (range.min == null || item[range.field] >= range.min)
      && (range.max == null || item[range.field] <= range.max));
    plotted = drawCurrentRentalListings(listings, range.field);
    currentContext = {listings, plotted, field:range.field};
    const rangeHelp = document.getElementById('dailyPriceHelp');
    rangeHelp.textContent = range.invalid ? 'O valor inicial precisa ser menor que o final.'
      : `A faixa usa ${priceViews[range.field].label} (${priceViews[range.field].unit}); as cores usam a mesma medida.`;
    rangeHelp.dataset.error = String(range.invalid);
    renderDailyDeals(listings);
    if ((range.min != null || range.max != null) && plotted) {
      const points = listings.filter(item => Number.isFinite(item.lat) && Number.isFinite(item.lon));
      map.fitBounds(L.latLngBounds(points.map(item => [item.lat, item.lon])), {padding:[32,32], maxZoom:14});
    }
  } else {
    plotted = drawDailyNeighborhoods(rows, metric);
  }
  dailySummary(rows, selectedDate, metric, currentContext);
  const lastSuccess = publicMeta?.last_successful_update
    ? new Date(publicMeta.last_successful_update).toLocaleString('pt-BR') : 'sem coleta válida';
  const collectionFailed = publicMeta?.health?.status === 'failed';
  document.getElementById('note').textContent = rows.length
    ? currentView
      ? `${localDateLabel(selectedDate)} · ${plotted} anúncios da faixa no mapa. Total anunciado = aluguel + condomínio + IPTU informados. A posição fornecida pela fonte pode ser aproximada. Última coleta válida: ${lastSuccess}.`
      : `${localDateLabel(selectedDate)} · ${plotted} elementos no mapa. Nas datas anteriores, os marcadores representam agregados por bairro; os anúncios individuais aparecem na data mais recente quando a métrica é oferta ativa. Última coleta válida: ${lastSuccess}.`
    : collectionFailed
      ? 'A coleta diária não produziu uma base válida. O histórico de 2021 e 2026 continua disponível enquanto a fonte é corrigida.'
      : `Sem dados diários para ${localDateLabel(selectedDate)} com os filtros atuais.`;
}
return { drawDaily, renderCollectionStatus, localDateLabel };
}
