export let currentListings = [];
export let neighborhoodDaily = [];
export let listingEvents = [];
export let publicMeta = null;

async function loadJson(path) {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`Falha ao carregar ${path}: HTTP ${response.status}`);
  return response.json();
}

export async function loadPublicData() {
  const [current, daily, events, meta] = await Promise.all([
    loadJson('data/public/current.json'),
    loadJson('data/public/neighborhood_daily.json'),
    loadJson('data/public/listing_events.json'),
    loadJson('data/public/meta.json')
  ]);
  if (!Array.isArray(current) || !Array.isArray(daily) || !Array.isArray(events) || !meta || meta.schema_version !== 1) {
    throw new Error('Os arquivos públicos do mercado diário têm um formato inválido.');
  }
  currentListings = current;
  neighborhoodDaily = daily;
  listingEvents = events;
  publicMeta = meta;
}
