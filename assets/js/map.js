export const map = L.map('map').setView([-19.9167, -43.9345], 11);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {maxZoom:19, attribution:'&copy; OpenStreetMap'}).addTo(map);

export const currentLayers = [];

export function clearLayers() {
  currentLayers.forEach(layer => map.removeLayer(layer));
  currentLayers.length = 0;
}
