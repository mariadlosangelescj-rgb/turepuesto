import { S, loadCatalog, loadStores } from "./state.js";
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
  $("#view-buscar").innerHTML = `<div class="loading">Cargando…</div>`;
  try {
    await Promise.all([loadCatalog(), loadStores()]);
  } catch (err) {
    console.error(err);
    $("#view-buscar").innerHTML = `<div class="empty-state">No pudimos conectarnos. Revisa tu conexión a internet y recarga la página.</div>`;
    return;
  }
  await initAuth(async (recovery) => { resetTienda(); resetAdmin(); resetPedir(); startNotify(); await syncPush(!!auth.user); if (recovery) go("tienda"); else if (["tienda", "admin", "pedir"].includes(S.tab)) RENDER[S.tab](); });
  const h = location.hash;
  startNotify();
  await syncPush(!!auth.user);
  go(h === "#pedir" ? "pedir" : h === "#admin" ? "admin" : h === "#tienda" || h.includes("type=recovery") ? "tienda" : "buscar");
}

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
  // Al tocar una notificación con la app ya abierta, ir a la pestaña correspondiente
  navigator.serviceWorker.addEventListener("message", (e) => { if (RENDER[e.data?.go]) go(e.data.go); });
}

start();
