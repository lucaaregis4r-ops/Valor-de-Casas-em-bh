import { median } from './statistics.js';
import { norm, groupByNeighborhood } from './filters.js';

const money = new Intl.NumberFormat('pt-BR', {style:'currency', currency:'BRL', maximumFractionDigits:0});
const number = new Intl.NumberFormat('pt-BR');
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[char]));
export const neighborhoodSlug = name => norm(name).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
export const profileLink = name => `<a class="profile-link" href="#/bairro/${encodeURIComponent(neighborhoodSlug(name))}">Ver perfil completo ↗</a>`;

export function neighborhoodNames(points, current) {
  return [...new Set([...points, ...current].map(item => item.neighborhood).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, 'pt-BR'));
}

export function renderDirectory(names, term = '') {
  const matching = names.filter(name => norm(name).includes(norm(term)));
  document.getElementById('bairroDirectory').innerHTML = matching.map(name =>
    `<a href="#/bairro/${encodeURIComponent(neighborhoodSlug(name))}"><strong>${escapeHtml(name)}</strong><span>Ver perfil ↗</span></a>`
  ).join('') || '<p>Nenhum bairro encontrado.</p>';
}

const stat = (value, label) => `<div class="profile-stat"><strong>${value}</strong><span>${label}</span></div>`;
const finiteMedian = (items, field) => median(items.map(item => item[field]).filter(Number.isFinite));
const formatMoney = value => value == null ? 'sem dado' : money.format(value);

export function renderProfile(slug, points, current, daily, meta, names) {
  const name = names.find(item => neighborhoodSlug(item) === slug);
  const title = document.getElementById('profileTitle');
  const historical = document.getElementById('profileHistorical');
  const recent = document.getElementById('profileCurrent');
  if (!name) {
    title.textContent = 'Bairro não encontrado';
    document.getElementById('profileSubtitle').textContent = 'Confira o nome no índice de bairros.';
    historical.innerHTML = recent.innerHTML = '';
    return;
  }
  title.textContent = name;
  const key = norm(name);
  const city = 'Belo Horizonte';
  const old = points.filter(item => item.year === 2021 && item.operation === 'sale' && item.property_type === 'apartment' && norm(item.neighborhood) === key && item.city === city);
  const newer = points.filter(item => item.year === 2026 && item.operation === 'sale' && item.property_type === 'apartment' && norm(item.neighborhood) === key && item.city === city);
  const m21 = finiteMedian(old, 'price_m2');
  const m26 = finiteMedian(newer, 'price_m2');
  const comparable = old.length >= 5 && newer.length >= 5 && m21 && m26;
  const delta = comparable ? (m26 / m21 - 1) * 100 : null;
  const listings = current.filter(item => item.available && norm(item.neighborhood) === key && item.city === city);
  const dates = daily.filter(item => norm(item.neighborhood) === key && item.city === city).sort((a,b) => a.date.localeCompare(b.date));
  const latest = dates.at(-1);
  const update = meta?.last_successful_update ? new Date(meta.last_successful_update).toLocaleString('pt-BR') : 'sem coleta válida';
  document.getElementById('profileSubtitle').textContent = 'Belo Horizonte · leitura das bases disponíveis para este bairro';
  historical.innerHTML = `<div class="block-head"><span>01 / ATLAS</span><h2>Histórico de venda · 2021—2026</h2><p>Medianas do preço pedido por m² de apartamentos. Bases históricas consolidadas.</p></div><div class="profile-stats">
    ${stat(old.length >= 5 ? formatMoney(m21) : 'amostra insuficiente', `2021 · ${number.format(old.length)} imóveis`)}
    ${stat(newer.length >= 5 ? formatMoney(m26) : 'amostra insuficiente', `2026 · ${number.format(newer.length)} imóveis`)}
    ${stat(delta == null ? 'sem comparação' : `${delta >= 0 ? '+' : ''}${delta.toFixed(1)}%`, 'Variação do preço/m²')}
  </div><p class="block-note">Comparação disponível com pelo menos 5 anúncios em cada ano. Os preços são pedidos, não transações.</p>`;
  recent.innerHTML = `<div class="block-head"><span>02 / MERCADO AGORA</span><h2>Aluguel anunciado · coletas recentes</h2><p>Observação da oferta ativa; não é continuação da série histórica de venda.</p></div><div class="profile-stats">
    ${stat(number.format(listings.length), 'Anúncios ativos')}
    ${stat(listings.length >= 5 ? formatMoney(finiteMedian(listings, 'price')) : 'amostra insuficiente', 'Mediana do aluguel pedido')}
    ${stat(listings.length >= 5 ? formatMoney(finiteMedian(listings, 'condo_fee')) : 'amostra insuficiente', 'Mediana do condomínio informado')}
    ${stat(latest ? number.format(latest.new || 0) : 'sem dado', 'Novos anúncios na última data')}
  </div><p class="block-note">Última coleta válida: ${escapeHtml(update)}. ${latest ? `Último agregado do bairro: ${escapeHtml(latest.date.split('-').reverse().join('/'))}.` : 'Sem agregado diário para este bairro.'} Médias e variações de amostras pequenas não são exibidas.</p>`;
}

export function renderComparison(points) {
  const names = [...document.getElementById('compareNeighborhoods').selectedOptions].map(option => option.value);
  const target = document.getElementById('comparisonResults');
  if (names.length < 2) {
    target.innerHTML = '<p class="hint">Escolha pelo menos dois bairros para ver a comparação.</p>';
    return;
  }
  const saleApartments = points.filter(p => p.operation === 'sale' && p.property_type === 'apartment' && p.city === 'Belo Horizonte');
  const byYear = new Map([2021, 2026].map(year => [year, groupByNeighborhood(saleApartments.filter(p => p.year === year))]));
  const rows = names.map(name => {
    const old = byYear.get(2021).get(norm(name))?.points || [];
    const newer = byYear.get(2026).get(norm(name))?.points || [];
    const a = old.length >= 5 ? finiteMedian(old, 'price_m2') : null;
    const b = newer.length >= 5 ? finiteMedian(newer, 'price_m2') : null;
    return `<tr><th scope="row"><a href="#/bairro/${encodeURIComponent(neighborhoodSlug(name))}">${escapeHtml(name)}</a></th><td>${formatMoney(a)}<small>n = ${number.format(old.length)}</small></td><td>${formatMoney(b)}<small>n = ${number.format(newer.length)}</small></td><td>${a && b ? `${b >= a ? '+' : ''}${((b/a-1)*100).toFixed(1)}%` : 'sem comparação'}</td></tr>`;
  });
  target.innerHTML = `<div class="table-scroll"><table><thead><tr><th>Bairro</th><th>2021 · R$/m²</th><th>2026 · R$/m²</th><th>Variação</th></tr></thead><tbody>${rows.join('')}</tbody></table></div><p class="hint">Medianas de anúncios de venda de apartamentos em Belo Horizonte. Mínimo de 5 observações por ano.</p>`;
}
