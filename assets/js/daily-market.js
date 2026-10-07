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
    <div class="stat"><strong>${fmtNum.format(totals.active)}</strong>anúncios ativos</div>
    <div class="stat"><strong>${fmtNum.format(totals.new)}</strong>novos anúncios</div>
    <div class="stat"><strong>${fmtNum.format(totals.removed)}</strong>retirados</div>
    <div class="stat"><strong>${fmtNum.format(totals.price_reduced)}</strong>reduções de preço</div>
    <div class="stat"><strong>${currentRents.length ? fmtBRL.format(median(currentRents)) : 'sem dado'}</strong>mediana do aluguel pedido${selectedDate === latestDate ? '' : ' · somente data mais recente'}</div>
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
    ? `${localDateLabel(selectedDate)} · ${plotted} elementos no mapa. Nas datas anteriores, os marcadores representam agregados por bairro; os anúncios individuais aparecem na data mais recente quando a métrica é oferta ativa. Última coleta válida: ${lastSuccess}.`
    : collectionFailed
      ? 'A coleta diária não produziu uma base válida. O histórico de 2021 e 2026 continua disponível enquanto a fonte é corrigida.'
      : `Sem dados diários para ${localDateLabel(selectedDate)} com os filtros atuais.`;
}
return { drawDaily, renderCollectionStatus, localDateLabel };
}
