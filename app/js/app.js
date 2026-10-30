import { S, loadCatalog, loadStores, loadCached } from "./state.js";
import { $ } from "./util.js";
import { renderBuscar, bindBuscar, search } from "./buscar.js";
import { renderMapa, bindMapa } from "./mapa.js";
import { initAuth, bindAuth, auth } from "./auth.js";
import { renderTienda, bindTienda, resetTienda } from "./tienda.js";
import { renderAdmin, bindAdmin, resetAdmin } from "./admin.js";
import { renderPedir, bindPedir, resetPedir } from "./pedir.js";
import { startNotify, setDot } from "./notify.js";
import { bindPush, syncPush } from "./push.js";

const RENDER = {
  buscar: renderBuscar,
  mapa: renderMapa,
  pedir: renderPedir,
  tienda: renderTienda,
  admin: renderAdmin,
};

export function go(tab) {
  S.tab = tab;
  document.querySelectorAll("main").forEach((m) => (m.hidden = m.id !== "view-" + tab));
  document.querySelectorAll(".tabs button").forEach((b) => (b.dataset.tab === tab ? b.setAttribute("aria-current", "page") : b.removeAttribute("aria-current")));
  if (tab === "pedir" || tab === "tienda") setDot(tab, false);
  RENDER[tab]();
  window.scrollTo(0, 0);
}

function closeSheet() { $("#sheet").hidden = true; }

function bindGlobal() {
  document.querySelector(".tabs").addEventListener("click", (e) => { const b = e.target.closest("[data-tab]"); if (b) go(b.dataset.tab); });
  $("#money").addEventListener("click", (e) => {
    const b = e.target.closest("[data-money]"); if (!b) return;
    S.money = b.dataset.money;
    $("#money").querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", x === b));
    if (S.tab !== "buscar") go("buscar"); else search();
  });
  $("#sheet").addEventListener("click", (e) => { if (e.target.id === "sheet" || e.target.closest("[data-close]")) closeSheet(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeSheet(); });
  document.addEventListener("click", (e) => { const g = e.target.closest("[data-go]"); if (g) go(g.dataset.go); });
}

async function start() {
  bindGlobal();
  bindBuscar();
  bindMapa(go);
  bindAuth(() => RENDER[S.tab]());
  bindTienda(go);
  bindAdmin(go);
  bindPedir();
  bindPush(() => RENDER[S.tab]());
  // Todo se pide a la vez (antes se esperaba una cosa tras otra)
  const fresh = Promise.all([loadCatalog(), loadStores()]);
  const authReady = initAuth(async (recovery) => { resetTienda(); resetAdmin(); resetPedir(); startNotify(); await syncPush(!!auth.user); if (recovery) go("tienda"); else if (["tienda", "admin", "pedir"].includes(S.tab)) RENDER[S.tab](); }).catch((e) => console.error(e));
  const h = location.hash;
  const first = h === "#pedir" ? "pedir" : h === "#admin" ? "admin" : h === "#tienda" || h.includes("type=recovery") ? "tienda" : "buscar";

  if (loadCached()) {
    // Abre de una vez con lo guardado y actualiza por detrás
    fresh.then(([catChanged, storesChanged]) => {
      const typing = document.activeElement?.matches("input, select, textarea");
      if (S.tab === "buscar" && !typing && catChanged) renderBuscar();
      else if (S.tab === "buscar" && storesChanged) search();
      else if (S.tab === "mapa" && storesChanged) RENDER.mapa();
    }).catch((e) => console.error(e));
  } else {
    $("#view-buscar").innerHTML = `<div class="loading">Cargando…</div>`;
    try { await fresh; } catch (err) {
      console.error(err);
      $("#view-buscar").innerHTML = `<div class="empty-state">No pudimos conectarnos. Revisa tu conexión a internet y recarga la página.</div>`;
      return;
    }
  }

  // Buscar no necesita la cuenta: se muestra sin esperarla
  if (first === "buscar") go("buscar");
  await authReady;
  if (first !== "buscar") go(first);
  else if (S.tab !== "buscar") RENDER[S.tab](); // abrió otra pestaña mientras se cargaba la cuenta
  startNotify();
  syncPush(!!auth.user);
}

if ("serviceWorker" in navigator) {
  const reg = () => navigator.serviceWorker.register("sw.js").then((r) => {
    // Al volver a la app, revisa si publicamos una versión nueva
    document.addEventListener("visibilitychange", () => { if (!document.hidden) r.update().catch(() => {}); });
  }).catch(() => {});
  // Cuando llega una versión nueva: si la app se acaba de abrir, recarga sola; si no, ofrece actualizar
  const hadController = !!navigator.serviceWorker.controller, t0 = Date.now();
  let reloading = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!hadController || reloading) return;
    const typing = document.activeElement?.matches("input, textarea, select");
    if (Date.now() - t0 < 15000 && !typing) { reloading = true; location.reload(); return; }
    if (document.querySelector(".update-bar")) return;
    const bar = document.createElement("div");
    bar.className = "update-bar";
    bar.innerHTML = `<span>Hay una versión nueva de la app.</span><button class="btn btn-signal btn-sm">Actualizar</button>`;
    bar.querySelector("button").onclick = () => { reloading = true; location.reload(); };
    document.body.appendChild(bar);
  });
  if (document.readyState === "complete") reg(); else window.addEventListener("load", reg);
  // Al tocar una notificación con la app ya abierta, ir a la pestaña correspondiente
  navigator.serviceWorker.addEventListener("message", (e) => { if (RENDER[e.data?.go]) go(e.data.go); });
}

start();
