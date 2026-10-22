// Guarda los archivos de la app para que abra rápido y funcione con señal débil.
// Los datos (repuestos, tiendas) siempre se piden frescos a internet.
const VERSION = "tr-v6";
const SHELL = ["./", "index.html", "styles.css", "manifest.webmanifest", "img/icono.svg",
  "js/app.js", "js/auth.js", "js/tienda.js", "js/admin.js", "js/pedir.js", "js/buscar.js", "js/mapa.js", "js/state.js", "js/db.js", "js/util.js", "js/config.js", "js/categorias.js"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return; // Supabase, mapas, etc.: directo a internet
  // Primero internet (para tener siempre la última versión); si no hay conexión, la copia guardada
  e.respondWith(
    fetch(e.request)
      .then((r) => { const copy = r.clone(); caches.open(VERSION).then((c) => c.put(e.request, copy)); return r; })
      .catch(() => caches.match(e.request))
  );
});
