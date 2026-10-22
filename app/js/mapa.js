import { S, here, askLocation } from "./state.js";
import { $, esc, distanceKm, kmText, waLink, toast } from "./util.js";

let map = null, layer = null;

export function renderMapa() {
  const v = $("#view-mapa");
  const me = here();
  const list = S.stores
    .map((s) => ({ ...s, d: distanceKm(me, s) }))
    .sort((a, b) => (a.d ?? 999) - (b.d ?? 999));

  v.innerHTML = `
    <div><div class="eyebrow">Cerca de ti</div><h2>Tiendas de repuestos</h2></div>
    <div class="map-box">
      <div id="map" class="map-real" role="region" aria-label="Mapa de tiendas"></div>
      <div class="map-legend">
        <span class="lg"><i style="background:var(--signal)"></i>${S.loc ? "Tu ubicación" : "Centro de San Cristóbal"}</span>
        <span class="lg"><i style="background:var(--petrol)"></i>Tienda</span>
        ${S.loc ? "" : '<span class="loc-note"><button data-loc>Usar mi ubicación</button></span>'}
      </div>
    </div>
    ${list.length ? `<div class="list">${list.map((s, i) => `
      <div class="store-card" id="sc-${s.id}">
        <div class="store-top"><span class="num">${i + 1}</span><span class="store-name">${esc(s.name)}</span>${s.plan === "plus" ? '<span class="tag-star">Destacada</span>' : ""}<span class="dist">${kmText(s.d)}</span></div>
        <div class="muted" style="font-size:13px">${esc([s.zone, s.address].filter(Boolean).join(" · "))}${s.hours ? ` · ${esc(s.hours)}` : ""}</div>
        <div class="btn-row">
          <button class="btn btn-primary btn-sm" data-store="${s.id}">Ver repuestos</button>
          <a class="btn btn-ghost btn-sm" href="${esc(waLink(s.whatsapp, "Hola, los vi en Tu Repuesto."))}" target="_blank" rel="noopener">WhatsApp</a>
        </div>
      </div>`).join("")}</div>`
      : `<div class="empty-state">Todavía no hay tiendas activas. Pronto aparecerán aquí.</div>`}`;

  drawMap(list, me);
}

function drawMap(list, me) {
  if (typeof L === "undefined") { $("#map").innerHTML = '<div class="loading">No se pudo cargar el mapa.</div>'; return; }
  if (map) { map.remove(); map = null; }
  map = L.map("map", { zoomControl: true, attributionControl: true }).setView([me.lat, me.lng], 13);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map);
  layer = L.layerGroup().addTo(map);
  L.marker([me.lat, me.lng], { icon: L.divIcon({ className: "", html: '<div class="pin-me"></div>', iconSize: [16, 16] }) }).addTo(layer);
  const pts = [[me.lat, me.lng]];
  list.forEach((s, i) => {
    if (s.lat == null) return;
    pts.push([s.lat, s.lng]);
    L.marker([s.lat, s.lng], { icon: L.divIcon({ className: "", html: `<div class="pin-store">${i + 1}</div>`, iconSize: [26, 26] }) })
      .addTo(layer)
      .bindPopup(`<b>${esc(s.name)}</b><br>${esc(s.zone || "")} · ${kmText(s.d)}`)
      .on("click", () => document.getElementById("sc-" + s.id)?.scrollIntoView({ behavior: "smooth", block: "nearest" }));
  });
  if (pts.length > 1) map.fitBounds(pts, { padding: [30, 30], maxZoom: 15 });
}

export function bindMapa(go) {
  document.addEventListener("click", async (e) => {
    const t = e.target;
    if (t.closest("[data-loc]")) {
      const ok = await askLocation();
      toast(ok ? "Listo, usamos tu ubicación para calcular distancias" : "No pudimos obtener tu ubicación. Revisa los permisos del navegador.");
      if (ok) go(S.tab);
      return;
    }
    const sb = t.closest("[data-store]");
    if (sb) { S.storeFilter = +sb.dataset.store; S.q = ""; go("buscar"); }
  });
}
