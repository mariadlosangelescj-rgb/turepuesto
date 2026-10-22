import { S, loadCatalog, loadStores } from "./state.js";
import { $ } from "./util.js";
import { renderBuscar, bindBuscar, search } from "./buscar.js";
import { renderMapa, bindMapa } from "./mapa.js";
import { initAuth, bindAuth } from "./auth.js";
import { renderTienda, bindTienda, resetTienda } from "./tienda.js";
import { renderAdmin, bindAdmin, resetAdmin } from "./admin.js";
import { renderPedir, bindPedir, resetPedir, checkNewResponses } from "./pedir.js";

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
  $("#view-buscar").innerHTML = `<div class="loading">Cargando…</div>`;
  try {
    await Promise.all([loadCatalog(), loadStores()]);
  } catch (err) {
    console.error(err);
    $("#view-buscar").innerHTML = `<div class="empty-state">No pudimos conectarnos. Revisa tu conexión a internet y recarga la página.</div>`;
    return;
  }
  await initAuth((recovery) => { resetTienda(); resetAdmin(); resetPedir(); checkNewResponses(); if (recovery) go("tienda"); else if (["tienda", "admin", "pedir"].includes(S.tab)) RENDER[S.tab](); });
  const h = location.hash;
  checkNewResponses();
  setInterval(checkNewResponses, 120000);
  go(h === "#pedir" ? "pedir" : h === "#admin" ? "admin" : h === "#tienda" || h.includes("type=recovery") ? "tienda" : "buscar");
}

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
}

start();
