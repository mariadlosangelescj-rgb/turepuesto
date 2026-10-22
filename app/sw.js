// Guarda los archivos de la app para que abra rápido y funcione con señal débil.
// Los datos (repuestos, tiendas) siempre se piden frescos a internet.
const VERSION = "tr-v8";
const SHELL = ["./", "index.html", "styles.css", "manifest.webmanifest", "img/icono.svg", "img/icono-192.png", "img/badge-96.png",
  "js/app.js", "js/auth.js", "js/tienda.js", "js/admin.js", "js/pedir.js", "js/notify.js", "js/push.js", "js/buscar.js", "js/mapa.js", "js/state.js", "js/db.js", "js/util.js", "js/config.js", "js/categorias.js"];

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

// ---------- Notificaciones al celular ----------
self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { title: "Tu Repuesto", body: e.data?.text() || "" }; }
  e.waitUntil(self.registration.showNotification(d.title || "Tu Repuesto", {
    body: d.body || "",
    icon: "img/icono-192.png",
    badge: "img/badge-96.png",
    tag: d.tag,
    renotify: !!d.tag,
    data: { url: d.url || "./" },
  }));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || "./", self.registration.scope).href;
  const tab = new URL(url).hash.slice(1);
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const w of wins) {
      if (new URL(w.url).origin === location.origin) {
        await w.focus();
        w.postMessage({ go: tab });
        return;
      }
    }
    await self.clients.openWindow(url);
  })());
});
