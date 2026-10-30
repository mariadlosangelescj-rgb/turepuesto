// Guarda los archivos de la app para que abra rápido y funcione con señal débil.
// Los datos (repuestos, tiendas, pedidos) siempre se piden frescos a internet.
const VERSION = "tr-v15";
const LIBS = "tr-libs-1"; // Supabase, mapa y letras: tienen versión fija, se guardan una sola vez
const SHELL = ["./", "index.html", "styles.css", "manifest.webmanifest", "img/favicon-64.png", "img/logo-header.png", "img/icono-192.png", "img/apple-touch-icon.png", "img/badge-96.png",
  "js/app.js", "js/auth.js", "js/tienda.js", "js/admin.js", "js/pedir.js", "js/notify.js", "js/push.js", "js/importar.js", "js/buscar.js", "js/mapa.js", "js/state.js", "js/db.js", "js/util.js", "js/config.js", "js/categorias.js"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: "reload" })))).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k !== LIBS).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
const LIB_HOSTS = ["cdn.sheetjs.com", "cdn.jsdelivr.net", "unpkg.com", "fonts.googleapis.com", "fonts.gstatic.com"];

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Librerías con versión fija: si ya están guardadas, se usan sin ir a internet
  if (LIB_HOSTS.includes(url.hostname)) {
    e.respondWith(caches.open(LIBS).then(async (c) => {
      const hit = await c.match(req);
      if (hit) return hit;
      const r = await fetch(req);
      if (r.ok || r.type === "opaque") c.put(req, r.clone());
      return r;
    }));
    return;
  }
  if (url.origin !== location.origin) return; // Supabase y el mapa: directo a internet

  // Archivos de la app: se muestran de una vez desde el teléfono y se actualizan por detrás.
  // Cuando publicamos una versión nueva, se ve la próxima vez que se abra la app.
  e.respondWith(caches.open(VERSION).then(async (c) => {
    const hit = await c.match(req, { ignoreSearch: req.mode === "navigate" });
    const net = fetch(req).then((r) => { if (r.ok) c.put(req, r.clone()); return r; });
    if (hit) { e.waitUntil(net.catch(() => {})); return hit; }
    return net.catch(() => c.match("./"));
  }));
});

// ---------- Notificaciones al celular ----------
self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { title: "Tu Repuesto Aquí", body: e.data?.text() || "" }; }
  e.waitUntil(self.registration.showNotification(d.title || "Tu Repuesto Aquí", {
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
