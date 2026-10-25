import { db, photoUrl } from "./db.js";
import { S } from "./state.js";
import { auth, authForm, signOut, passwordRecoveryForm, isAdmin } from "./auth.js";
import { $, esc, norm, money, toast, yearOptions, ago, loadLeaflet } from "./util.js";
import { CAT, CAT_LABEL } from "./categorias.js";
import { CENTRO } from "./config.js";
import { markRequestsSeen } from "./notify.js";
import { pushCard } from "./push.js";
import { importPanelHTML, bindImport, resetImport } from "./importar.js";

// ---------- Planes ----------
export const PLAN = {
  trial:         { name: "Prueba gratis", limit: 100, price: 0,  orders: true },
  trial_expired: { name: "Prueba vencida", limit: 0, price: 0,  orders: false },
  basico:        { name: "Básico",        limit: 50,  price: 10, orders: false },
  estandar:      { name: "Estándar",      limit: 100, price: 20, orders: true },
  plus:          { name: "Plus",          limit: Infinity, price: 25, orders: true },
};
const PAID = ["basico", "estandar", "plus"];
const FEATURES = {
  basico: ["Hasta 50 repuestos", "Apareces en el mapa y en las búsquedas", "Botón de WhatsApp en tus repuestos"],
  estandar: ["Hasta 100 repuestos", "Recibes y respondes pedidos de clientes", "Estadísticas de contactos"],
  plus: ["Repuestos ilimitados", "Recibes y respondes pedidos de clientes", "Sales de primero en las búsquedas"],
};
const ZONES = ["Barrio Obrero", "Centro", "La Concordia", "Pueblo Nuevo", "Santa Teresa", "Las Acacias", "Pirineos", "Av. Carabobo", "La Guayana", "Táriba", "Palmira", "Barrio Sucre", "San Juan de Colón", "Rubio", "Capacho", "Otro"];

// ---------- Estado de esta pantalla ----------
const T = {
  loaded: false, store: null, products: [], contacts7: 0, planReq: null,
  invQ: "", invF: "todos", showPlans: false,
  editing: null, fs: null, fv: null, photoFile: null, photoPreview: null, confirmDel: false, saving: false,
  regPin: null, asStore: null,
  reqs: [], openCount: 0, ans: {},
};
let regMap = null;

export function resetTienda() { resetImport(); Object.assign(T, { loaded: false, store: null, products: [], editing: null, fs: null, fv: null, planReq: null, asStore: null, reqs: [], openCount: 0, ans: {} }); }
// La administradora puede abrir el panel de cualquier tienda para cargarle repuestos
export function openAsStore(id) { resetTienda(); T.asStore = id; }

function effPlan() {
  const s = T.store;
  if (!s) return "trial";
  if (s.plan === "trial" && s.trial_ends_at && new Date(s.trial_ends_at) < new Date()) return "trial_expired";
  return s.plan;
}
const daysLeft = () => T.store?.trial_ends_at ? Math.max(0, Math.ceil((new Date(T.store.trial_ends_at) - Date.now()) / 86400000)) : null;
const vehText = (v) => `${v.make} ${v.model} ${v.year_from}–${v.year_to}${v.engine ? ` · motor ${v.engine}` : ""}`;
const thumb = (p) => { const u = p.photo_path ? photoUrl(p.photo_path) : null; return u ? `<img src="${esc(u)}" alt="" loading="lazy">` : CAT[p.category] || CAT.motor; };

// ---------- Carga de datos ----------
async function loadAll() {
  const q = db.from("stores").select("*");
  const { data: store, error } = await (T.asStore ? q.eq("id", T.asStore) : q.eq("owner_id", auth.user.id)).maybeSingle();
  if (error) throw error;
  T.store = store;
  if (store) await Promise.all([loadProducts(), loadExtras()]);
  T.loaded = true;
}

async function loadProducts() {
  const { data, error } = await db.from("products")
    .select("id, name, category, currency, photo_path, updated_at, product_versions(id, make, model, year_from, year_to, engine, part_brand, part_number, condition, price, in_stock, updated_at)")
    .eq("store_id", T.store.id).order("updated_at", { ascending: false });
  if (error) throw error;
  T.products = data.map((p) => ({ ...p, versions: (p.product_versions || []).sort((a, b) => a.id - b.id) }));
}

async function loadExtras() {
  const since = new Date(Date.now() - 7 * 86400000).toISOString();
  const [c, r] = await Promise.all([
    db.from("contact_events").select("id", { count: "exact", head: true }).eq("store_id", T.store.id).gte("created_at", since),
    db.from("plan_requests").select("plan, created_at").eq("store_id", T.store.id).eq("status", "pending").order("created_at", { ascending: false }).limit(1),
  ]);
  T.contacts7 = c.count || 0;
  T.planReq = r.data?.[0]?.plan || null;
  await loadRequests();
}

// Pedidos de clientes de los últimos 7 días (solo tiendas activas)
async function loadRequests() {
  T.reqs = []; T.openCount = 0;
  if (T.store.status !== "active") return;
  if (PLAN[effPlan()].orders) {
    const since = new Date(Date.now() - 7 * 86400000).toISOString();
    const { data, error } = await db.from("part_requests")
      .select("id, part, make, model, year, engine, note, status, created_at, request_responses(store_id, price_text, note)")
      .eq("status", "open").gte("created_at", since)
      .order("created_at", { ascending: false }).limit(40);
    if (error) { console.error(error); return; }
    T.reqs = data.map((r) => ({ ...r, mine: (r.request_responses || []).find((x) => x.store_id === T.store.id) || null }));
    T.openCount = T.reqs.filter((r) => !r.mine).length;
  } else {
    const { data } = await db.rpc("open_requests_count");
    T.openCount = data || 0;
  }
}

const reqVeh = (r) => [r.make, r.model, r.year, r.engine ? `motor ${r.engine}` : ""].filter(Boolean).join(" ") || "Vehículo sin especificar";

function ordersHTML(pl) {
  const P = PLAN[pl], st = T.store;
  const head = (badge) => `<div class="toolbar"><h2 style="font-size:19px">Pedidos de clientes</h2>${badge}</div>`;
  if (st.status !== "active") return `<section class="panel" id="orders-sec">${head("")}<p class="muted" style="margin:0;font-size:13.5px">Cuando aprobemos tu tienda verás aquí los repuestos que piden los clientes, para responderles con tu precio.</p></section>`;
  if (!P.orders) {
    const up = pl === "plus" ? "plus" : "estandar";
    const btn = T.asStore ? "" : T.planReq ? '<div class="muted" style="font-size:12.5px">Solicitud enviada</div>' : `<button class="btn btn-signal btn-sm" data-t-reqplan="${up}">Quiero el plan ${PLAN[up].name}</button>`;
    return `<section class="panel" id="orders-sec">${head("")}
      <div class="locked"><b>${T.openCount ? `Hay ${T.openCount} pedido${T.openCount === 1 ? "" : "s"} de clientes esperando respuesta.` : "Los clientes piden repuestos que no encuentran en la app."}</b><span>Con el plan ${PLAN[up].name} ($${PLAN[up].price} al mes) puedes verlos y responderlos para ganar esas ventas.</span>${btn}</div></section>`;
  }
  const open = T.reqs.filter((r) => !r.mine), done = T.reqs.filter((r) => r.mine);
  const badge = `<span class="badge ${open.length ? "b-best" : "b-ok"}">${open.length} sin responder</span>`;
  if (!T.reqs.length) return `<section class="panel" id="orders-sec">${head(badge)}<p class="muted" style="margin:0;font-size:13.5px">No hay pedidos ahora. Cuando un cliente pida un repuesto, aparecerá aquí.</p>${T.asStore ? "" : pushCard("Te avisamos cuando un cliente pida un repuesto, aunque tengas la app cerrada.")}<button class="btn-link" data-t-reqs style="align-self:flex-start">Actualizar</button></section>`;
  const item = (r) => {
    const a = T.ans[r.id] || { price: "", note: "" };
    const top = `<div><b>${esc(r.part)}</b> · ${esc(reqVeh(r))}<div class="muted" style="font-size:12.5px">${ago(r.created_at)}${r.note ? ` · “${esc(r.note)}”` : ""}</div></div>`;
    if (r.mine) return `<div style="border-top:1px solid var(--line);padding-top:10px;display:flex;flex-direction:column;gap:6px">${top}<div class="muted" style="font-size:13px">Respondiste: <b style="color:var(--ink)">${esc(r.mine.price_text)}</b>${r.mine.note ? ` · ${esc(r.mine.note)}` : ""}</div></div>`;
    return `<div style="border-top:1px solid var(--line);padding-top:10px;display:flex;flex-direction:column;gap:8px">${top}
      ${T.asStore ? "" : `<div class="grid2"><input type="text" data-ans-price="${r.id}" maxlength="60" placeholder="Precio, ej: $ 30" aria-label="Precio" value="${esc(a.price)}"><input type="text" data-ans-note="${r.id}" maxlength="500" placeholder="Nota (opcional)" aria-label="Nota" value="${esc(a.note)}"></div>
      <div class="btn-row"><button class="btn btn-primary btn-sm" data-t-answer="${r.id}">Responder</button><button class="btn btn-ghost btn-sm" data-t-noans="${r.id}">No lo tengo</button></div>`}
    </div>`;
  };
  return `<section class="panel" id="orders-sec">${head(badge)}
    <p class="muted" style="margin:0;font-size:13px">El cliente ve tu respuesta en la app y te escribe por WhatsApp.</p>
    ${T.asStore ? "" : pushCard("Te avisamos cuando un cliente pida un repuesto, aunque tengas la app cerrada.")}
    ${open.map(item).join("")}
    ${done.length ? `<details><summary class="muted" style="font-size:13px;cursor:pointer">Ya respondidos (${done.length})</summary>${done.map(item).join("")}</details>` : ""}
    <button class="btn-link" data-t-reqs style="align-self:flex-start">Actualizar</button>
  </section>`;
}

async function answerRequest(id, priceText, note) {
  const { error } = await db.from("request_responses").insert({ request_id: id, store_id: T.store.id, price_text: priceText, note: note || null });
  if (error) {
    console.error(error);
    if (error.code === "23505") toast("Ya habías respondido este pedido.");
    else return toast("No pudimos enviar tu respuesta. Inténtalo de nuevo.");
  } else toast("Respuesta enviada al cliente.");
  delete T.ans[id];
  await loadRequests(); syncForm(); renderPanel($("#view-tienda"));
}

// ---------- Pantalla principal ----------
export async function renderTienda() {
  const v = $("#view-tienda");
  if (auth.recovery) { v.innerHTML = passwordRecoveryForm(); return; }
  if (!auth.user) { renderLogin(v); return; }
  if (!T.loaded) {
    v.innerHTML = `<div class="loading">Cargando tu tienda…</div>`;
    try { await loadAll(); } catch (e) { console.error(e); v.innerHTML = `<div class="empty-state">No pudimos cargar tu tienda. Revisa tu conexión y vuelve a intentarlo.<br><button class="btn btn-ghost btn-sm" data-t-reload>Reintentar</button></div>`; return; }
  }
  if (S.tab !== "tienda") return;
  if (!T.store && isAdmin() && !T.asStore) { v.innerHTML = `<div><div class="eyebrow">Administradora</div><h2>Hola</h2></div><div class="admin-bar">Tu cuenta es de administradora. Desde tu panel apruebas tiendas, activas planes y cargas repuestos por cualquier tienda.</div><button class="btn btn-primary" data-go="admin">Abrir panel de administradora</button><button class="btn-link" data-t-logout style="color:var(--muted);align-self:center">Cerrar sesión</button>`; return; }
  if (!T.store) { renderRegister(v); return; }
  if (T.store.status === "rejected" || T.store.status === "suspended") { renderBlocked(v); return; }
  renderPanel(v);
}

function renderLogin(v) {
  v.innerHTML = `
    <div><div class="eyebrow">Para tiendas de repuestos</div><h2>Vende en Tu Repuesto</h2><p class="muted" style="margin:4px 0 0">Publica tus repuestos y recibe clientes de San Cristóbal por WhatsApp.</p></div>
    <ul class="perks"><li>Tus repuestos aparecen cuando alguien busca para su carro</li><li>Los clientes te escriben directo por WhatsApp</li><li>El primer mes es gratis</li></ul>
    <section class="panel auth-card">
      <h2 style="font-size:19px">Entra o crea tu cuenta</h2>
      ${authForm("seller", "signup")}
    </section>`;
}

function renderBlocked(v) {
  const rej = T.store.status === "rejected";
  v.innerHTML = `
    <div class="toolbar" style="align-items:flex-start"><div><div class="eyebrow">Mi tienda</div><h2>${esc(T.store.name)}</h2></div><button class="btn-link" data-t-logout style="color:var(--muted)">Cerrar sesión</button></div>
    <section class="panel">
      <h2 style="font-size:19px">${rej ? "Tu solicitud no fue aprobada" : "Tu tienda está suspendida"}</h2>
      <p class="muted" style="margin:0">${rej ? "No pudimos verificar los datos de la tienda." : "Tu tienda no aparece por ahora en las búsquedas."} Escríbenos por WhatsApp para resolverlo.</p>
    </section>`;
}

// ---------- Registro de tienda ----------
function renderRegister(v) {
  v.innerHTML = `
    <div class="toolbar" style="align-items:flex-start"><div><div class="eyebrow">Paso 2 de 3</div><h2>Datos de tu tienda</h2><p class="muted" style="margin:4px 0 0;font-size:13px">Cuenta: ${esc(auth.user.email)}</p></div><button class="btn-link" data-t-logout style="color:var(--muted)">Cerrar sesión</button></div>
    <form class="panel" id="store-form" novalidate>
      <label class="fl">Nombre de la tienda<input type="text" id="s-name" maxlength="80" placeholder="Ej: Repuestos La Ermita" required></label>
      <div class="grid2">
        <label class="fl">RIF<input type="text" id="s-rif" placeholder="J-12345678-9"></label>
        <label class="fl">WhatsApp<input type="tel" id="s-wa" placeholder="0414 000 0000" required></label>
      </div>
      <div class="grid2">
        <label class="fl">Zona<input type="text" id="s-zone" list="zones" placeholder="Ej: Barrio Obrero"></label>
        <label class="fl">Horario<input type="text" id="s-hours" placeholder="Lun–Sáb 8:00–5:00"></label>
      </div>
      <datalist id="zones">${ZONES.map((z) => `<option value="${z}">`).join("")}</datalist>
      <label class="fl">Dirección<input type="text" id="s-addr" placeholder="Calle, número y una referencia"></label>
      <div class="fl">Ubicación en el mapa
        <div class="pin-map-box">
          <div id="reg-map" class="map-real" style="height:240px"></div>
          <div class="toolbar" style="padding:6px 10px"><span class="muted" id="pin-hint" style="font-size:12px">Toca el mapa donde está tu tienda.</span><button class="btn-link" type="button" data-t-myloc>Usar mi ubicación</button></div>
        </div>
      </div>
      <div class="form-msg" id="store-msg" role="status" hidden></div>
      <button class="btn btn-signal" type="submit">Enviar solicitud</button>
    </form>`;
  initRegMap();
}

async function initRegMap() {
  const box = $("#reg-map");
  if (!box) return;
  if (!window.L) box.innerHTML = '<div class="loading">Cargando mapa…</div>';
  if (!(await loadLeaflet())) { box.innerHTML = '<div class="loading">No se pudo cargar el mapa. Usa "Usar mi ubicación".</div>'; return; }
  if (!document.body.contains(box)) return;
  box.innerHTML = "";
  if (regMap) { regMap.remove(); regMap = null; }
  const c = T.regPin || CENTRO;
  regMap = L.map("reg-map").setView([c.lat, c.lng], 14);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "&copy; OpenStreetMap" }).addTo(regMap);
  let marker = T.regPin ? L.marker([c.lat, c.lng]).addTo(regMap) : null;
  const place = (lat, lng) => {
    T.regPin = { lat, lng };
    if (marker) marker.setLatLng([lat, lng]); else marker = L.marker([lat, lng]).addTo(regMap);
    $("#pin-hint").textContent = "Ubicación marcada. Toca otra vez para moverla.";
  };
  regMap.on("click", (e) => place(e.latlng.lat, e.latlng.lng));
  regMap._place = place;
}

async function submitStore(e) {
  e.preventDefault();
  const msg = (t) => { const m = $("#store-msg"); m.hidden = false; m.textContent = t; };
  const name = $("#s-name").value.trim(), wa = $("#s-wa").value.trim();
  if (name.length < 2) return msg("Escribe el nombre de la tienda.");
  if (wa.replace(/\D/g, "").length < 10) return msg("Escribe un número de WhatsApp válido, por ejemplo 0414 123 4567.");
  if (!T.regPin) return msg("Toca el mapa para marcar dónde está tu tienda.");
  const btn = e.target.querySelector('button[type="submit"]'); btn.disabled = true;
  const { error } = await db.from("stores").insert({
    name, whatsapp: wa, rif: $("#s-rif").value.trim() || null, zone: $("#s-zone").value.trim() || null,
    address: $("#s-addr").value.trim() || null, hours: $("#s-hours").value.trim() || null, lat: T.regPin.lat, lng: T.regPin.lng,
  });
  btn.disabled = false;
  if (error) { console.error(error); return msg("No pudimos enviar la solicitud. Inténtalo de nuevo."); }
  toast("Solicitud enviada. Te avisaremos cuando la tienda esté aprobada.");
  T.loaded = false; renderTienda();
}

// ---------- Panel de la tienda ----------
function renderPanel(v) {
  const st = T.store, pl = effPlan(), P = PLAN[pl], n = T.products.length;
  const versions = T.products.flatMap((p) => p.versions);
  const pending = st.status === "pending";
  if (P.orders && !T.asStore && st.status === "active") markRequestsSeen();
  v.innerHTML = `
    <div class="toolbar" style="align-items:flex-start"><div style="min-width:0"><div class="eyebrow">${T.asStore ? "Viendo como administradora" : "Mi tienda"}</div><h2>${esc(st.name)}</h2><p class="muted" style="margin:2px 0 0;font-size:13px">${esc([st.zone, st.hours].filter(Boolean).join(" · "))}</p></div>${T.asStore ? `<button class="btn btn-primary btn-sm" data-t-exitas>Volver al panel</button>` : `<button class="btn-link" data-t-logout style="color:var(--muted)">Cerrar sesión</button>`}</div>
    ${!T.asStore && isAdmin() ? `<button class="btn btn-ghost btn-sm" data-go="admin" style="align-self:flex-start">Abrir panel de administradora</button>` : ""}
    ${pending ? `<div class="welcome"><b>Tu tienda está en revisión.</b> Verificamos que exista y te avisamos por WhatsApp, normalmente en menos de 24 horas. Mientras tanto, ya puedes ir cargando tus repuestos: se verán apenas la aprobemos.</div>` : ""}
    ${!pending && !n ? `<div class="welcome"><b>¡Tu tienda está activa!</b> Empieza publicando tus repuestos más vendidos.</div>` : ""}
    <div class="stats">
      <div class="stat"><b>${T.contacts7}</b><span>contactos por WhatsApp (7 días)</span></div>
      <div class="stat"><b>${n}</b><span>repuestos publicados</span></div>
      <div class="stat"><b>${versions.filter((x) => x.in_stock).length}/${versions.length}</b><span>versiones disponibles</span></div>
    </div>
    ${planCard(pl, n)}
    ${T.showPlans ? plansHTML(pl) : ""}
    ${ordersHTML(pl)}
    ${T.editing ? "" : importPanelHTML(IMPORT_CTX)}
    ${!T.editing && n >= P.limit ? limitCard(pl, n) : productForm()}
    <section class="panel">
      <h2 style="font-size:19px">Mis repuestos</h2>
      <div class="inv-tools">
        <div class="search inv-search">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
          <input type="search" id="inv-q" placeholder="Buscar por nombre, carro o marca" value="${esc(T.invQ)}" aria-label="Buscar en mis repuestos" autocomplete="off">
        </div>
        <div class="grid2">
          <select id="inv-f" aria-label="Filtrar mis repuestos">
            ${[["todos", "Todos"], ["disp", "Disponibles"], ["agot", "Agotados"]].map(([k, l]) => `<option value="${k}" ${T.invF === k ? "selected" : ""}>${l}</option>`).join("")}
            <optgroup label="Categoría">${Object.entries(CAT_LABEL).map(([k, l]) => `<option value="${k}" ${T.invF === k ? "selected" : ""}>${l}</option>`).join("")}</optgroup>
          </select>
          <span class="muted" id="inv-count" style="font-size:12.5px;align-self:center;text-align:right"></span>
        </div>
      </div>
      <div id="inv-list"></div>
    </section>`;
  renderInv();
}

function planCard(pl, n) {
  const P = PLAN[pl], lim = P.limit;
  const pct = isFinite(lim) && lim > 0 ? Math.min(100, Math.round((n / lim) * 100)) : 100;
  const state = !isFinite(lim) ? "" : n >= lim ? "full" : n >= lim - 4 ? "warn" : "";
  const d = daysLeft();
  return `<section class="panel plan-card">
    <div class="toolbar"><div><div class="eyebrow">Tu plan</div><b class="plan-n">${P.name}</b> ${P.price ? `<span class="muted" style="font-size:13px">$${P.price} al mes</span>` : pl === "trial" && T.store.status === "active" && d != null ? `<span class="muted" style="font-size:13px">quedan ${d} días</span>` : ""}</div><button class="btn btn-ghost btn-sm" data-t-plans>${T.showPlans ? "Ocultar planes" : "Ver planes"}</button></div>
    ${pl === "trial" && T.store.status === "pending" ? `<div class="muted" style="font-size:13px">Tu mes gratis empieza cuando aprobemos la tienda.</div>` : ""}
    ${pl === "trial_expired" ? `<p class="lim-msg full">Tu mes de prueba terminó. Elige un plan para seguir publicando repuestos.</p>` : isFinite(lim) ? `
      <div class="toolbar"><span style="font-size:14px"><b>${n}</b> de ${lim} repuestos</span><span class="muted" style="font-size:12.5px">${Math.max(0, lim - n)} disponibles</span></div>
      <div class="bar lim ${state}"><span style="width:${pct}%"></span></div>
      ${state === "full" ? `<p class="lim-msg full">Llegaste al límite de tu plan. Puedes editar tus repuestos, pero para publicar nuevos necesitas un plan mayor.</p>` : state === "warn" ? `<p class="lim-msg">Te quedan ${lim - n} repuestos en tu plan.</p>` : ""}`
      : `<div class="muted" style="font-size:13.5px">Repuestos ilimitados · ${n} publicados</div>`}
    ${T.planReq ? `<div class="admin-bar">Solicitaste el plan <b>${PLAN[T.planReq].name}</b>. Te escribiremos por WhatsApp para coordinar el pago.</div>` : ""}
  </section>`;
}

function plansHTML(cur) {
  return `<section class="panel"><div class="toolbar"><h2 style="font-size:19px">Planes</h2><button class="btn-link" data-t-plans style="color:var(--muted)">Cerrar</button></div>
    <div class="plans">${PAID.map((pl) => `
      <div class="plan ${pl === cur ? "is-cur" : ""} ${pl === "estandar" ? "is-rec" : ""}">
        <div class="toolbar"><b class="plan-n">${PLAN[pl].name}</b>${pl === cur ? '<span class="badge b-ok">Tu plan</span>' : pl === "estandar" ? '<span class="badge b-best">Recomendado</span>' : ""}</div>
        <div class="plan-p">$${PLAN[pl].price}<small> al mes</small></div>
        <ul>${FEATURES[pl].map((f) => `<li>${f}</li>`).join("")}</ul>
        ${pl === cur ? "" : T.planReq === pl ? '<div class="muted" style="font-size:12.5px">Solicitud enviada</div>' : `<button class="btn btn-signal btn-sm" data-t-reqplan="${pl}">Quiero este plan</button>`}
      </div>`).join("")}</div>
    <p class="muted" style="margin:0;font-size:12.5px">El pago es por pago móvil, Zelle o efectivo. Al solicitar un plan te escribimos por WhatsApp para coordinarlo y lo activamos apenas recibimos el pago.</p>
  </section>`;
}

function limitCard(pl, n) {
  const next = pl === "basico" ? "estandar" : "plus";
  return `<section class="panel limit-card"><h2 style="font-size:19px">Publicar repuesto</h2>
    <p style="margin:0">${pl === "trial_expired" ? "Tu mes de prueba terminó." : `Ya tienes <b>${n} repuestos</b>, el máximo de tu plan.`}</p>
    <p class="muted" style="margin:0;font-size:13.5px">Con el plan ${PLAN[next].name} ($${PLAN[next].price} al mes) puedes publicar ${isFinite(PLAN[next].limit) ? `hasta ${PLAN[next].limit} repuestos` : "sin límite"}.</p>
    ${T.planReq ? '<div class="admin-bar">Solicitud enviada. Te escribiremos por WhatsApp.</div>' : `<button class="btn btn-signal" data-t-reqplan="${next}">Quiero el plan ${PLAN[next].name}</button>`}
  </section>`;
}

// ---------- Formulario de repuesto (con versiones) ----------
function makeOptions(sel) { return `<option value="">Marca</option>` + Object.keys(S.catalog).map((m) => `<option ${m === sel ? "selected" : ""}>${esc(m)}</option>`).join(""); }
function modelOptions(mk, sel) { const ms = mk && S.catalog[mk] ? Object.keys(S.catalog[mk]) : []; return `<option value="">Modelo</option>` + ms.map((m) => `<option ${m === sel ? "selected" : ""}>${esc(m)}</option>`).join(""); }
function engineOptions(mk, md, sel) { const list = (mk && md && S.catalog[mk]?.[md]) || []; return `<option value="">Todos</option>` + list.map((e) => `<option value="${esc(e)}" ${e === sel ? "selected" : ""}>${esc(e)}</option>`).join(""); }
const blankVariant = (prev) => ({ id: null, mk: prev?.mk || "", md: prev?.md || "", from: prev?.from || "", to: prev?.to || "", eng: prev?.eng || "", pbrand: "", pn: "", price: "", cond: prev?.cond || "nuevo" });

function loadForm() {
  if (T.editing && T.editing !== "new") {
    const p = T.products.find((x) => x.id === T.editing);
    T.fs = { name: p.name, cat: p.category, cur: p.currency, photo_path: p.photo_path };
    T.fv = p.versions.map((x) => ({ id: x.id, mk: x.make, md: x.model, from: x.year_from, to: x.year_to, eng: x.engine || "", pbrand: x.part_brand || "", pn: x.part_number || "", price: String(x.price), cond: x.condition }));
  } else {
    T.fs = { name: "", cat: "motor", cur: "USD", photo_path: null };
    T.fv = [blankVariant()];
  }
}

function syncForm() {
  if (!T.fs || !$("#add-form")) return;
  T.fs.name = $("#a-name").value; T.fs.cat = $("#a-cat").value; T.fs.cur = $("#a-cur").value;
  document.querySelectorAll("#add-form .variant").forEach((el, i) => {
    const v = T.fv[i]; if (!v) return;
    v.mk = el.querySelector(".v-mk").value; v.md = el.querySelector(".v-md").value; v.eng = el.querySelector(".v-eng").value;
    v.from = el.querySelector(".v-from").value; v.to = el.querySelector(".v-to").value;
    v.price = el.querySelector(".v-price").value; v.cond = el.querySelector(".v-cond").value;
    v.pbrand = el.querySelector(".v-brand").value; v.pn = el.querySelector(".v-pn").value;
  });
}

function variantHTML(v, i) {
  return `
    <div class="variant" data-vi="${i}">
      <div class="v-head"><b>Versión ${i + 1}</b>${T.fv.length > 1 ? `<button type="button" class="btn-link" data-vdel="${i}">Quitar</button>` : ""}</div>
      <div class="grid2">
        <label class="fl">Marca del carro<select class="v-mk" id="v-mk-${i}">${makeOptions(v.mk)}</select></label>
        <label class="fl">Modelo<select class="v-md" id="v-md-${i}">${modelOptions(v.mk, v.md)}</select></label>
      </div>
      <div class="grid3e">
        <label class="fl">Desde<select class="v-from" id="v-from-${i}">${yearOptions(v.from, "Año")}</select></label>
        <label class="fl">Hasta<select class="v-to" id="v-to-${i}">${yearOptions(v.to, "Año")}</select></label>
        <label class="fl">Motor<select class="v-eng" id="v-eng-${i}">${engineOptions(v.mk, v.md, v.eng)}</select></label>
      </div>
      <div class="grid2">
        <label class="fl">Precio<input type="text" inputmode="decimal" class="v-price" id="v-price-${i}" placeholder="0" value="${esc(v.price)}"></label>
        <label class="fl">Estado<select class="v-cond" id="v-cond-${i}"><option value="nuevo" ${v.cond !== "usado" ? "selected" : ""}>Nuevo</option><option value="usado" ${v.cond === "usado" ? "selected" : ""}>Usado</option></select></label>
      </div>
      <div class="grid2">
        <label class="fl">Marca del repuesto<input type="text" class="v-brand" id="v-brand-${i}" maxlength="40" placeholder="Ej: Aisin, Bosch, genérica" value="${esc(v.pbrand)}"></label>
        <label class="fl">Referencia (opcional)<input type="text" class="v-pn" id="v-pn-${i}" maxlength="40" placeholder="Ej: GWF-98" value="${esc(v.pn)}"></label>
      </div>
    </div>`;
}

function productForm() {
  if (!T.fs) loadForm();
  const editing = T.editing && T.editing !== "new";
  const ph = T.photoPreview || (T.fs.photo_path ? photoUrl(T.fs.photo_path) : null);
  const opt = (v, cur) => `<option value="${v[0]}" ${v[0] === cur ? "selected" : ""}>${v[1]}</option>`;
  return `
    <form class="panel ${editing ? "edit-mode" : ""}" id="add-form" novalidate>
      <div class="toolbar"><h2 style="font-size:19px">${editing ? "Editar repuesto" : "Publicar repuesto"}</h2>${editing ? '<span class="badge b-best">Editando</span>' : ""}</div>
      <div class="photo-in">
        <div class="thumb" id="ph-prev">${ph ? `<img src="${esc(ph)}" alt="">` : CAT[T.fs.cat] || CAT.motor}</div>
        <label class="btn btn-ghost btn-sm" for="a-photo">${ph ? "Cambiar foto" : "Tomar o subir foto"}</label>
        <input type="file" id="a-photo" accept="image/*" class="sr">
      </div>
      <label class="fl">Nombre del repuesto<input type="text" id="a-name" maxlength="120" placeholder="Ej: Bomba de agua" value="${esc(T.fs.name)}"></label>
      <div class="grid2">
        <label class="fl">Categoría<select id="a-cat">${Object.entries(CAT_LABEL).map((v) => opt(v, T.fs.cat)).join("")}</select></label>
        <label class="fl">Moneda del precio<select id="a-cur">${[["USD", "Dólares ($)"], ["COP", "Pesos (COP)"], ["VES", "Bolívares (Bs)"]].map((v) => opt(v, T.fs.cur)).join("")}</select></label>
      </div>
      <div>
        <div class="eyebrow">Versiones · ${T.fv.length}</div>
        <p class="muted" style="font-size:12.5px;margin:4px 0 0">¿Tienes este repuesto para varios carros, de varias marcas o nuevo y usado? Agrega cada uno como una versión con su propio precio.</p>
      </div>
      ${T.fv.map(variantHTML).join("")}
      <button type="button" class="btn btn-ghost" data-vadd>+ Agregar otra versión</button>
      <div class="form-msg" id="add-msg" role="status" hidden></div>
      ${editing ? `
        <div class="btn-row"><button class="btn btn-signal" type="submit" ${T.saving ? "disabled" : ""}>${T.saving ? "Guardando…" : "Guardar cambios"}</button><button class="btn btn-ghost" type="button" data-t-cancel>Cancelar</button></div>
        ${T.confirmDel
          ? `<div class="del-confirm"><span>¿Eliminar este repuesto y todas sus versiones?</span><div class="btn-row"><button class="btn btn-danger btn-sm" type="button" data-t-delyes>Sí, eliminar</button><button class="btn btn-ghost btn-sm" type="button" data-t-delno>No</button></div></div>`
          : `<button class="btn-link" type="button" data-t-delask>Eliminar repuesto</button>`}`
        : `<button class="btn btn-signal" type="submit" ${T.saving ? "disabled" : ""}>${T.saving ? "Publicando…" : `Publicar${T.fv.length > 1 ? ` ${T.fv.length} versiones` : ""}`}</button>`}
    </form>`;
}

// Acepta "30", "30.5", "30,50", "110.000" o "1.250,50"
function parsePrice(txt) {
  let t = String(txt).trim().replace(/[^\d.,]/g, "");
  if (t.includes(",")) t = t.replace(/\./g, "").replace(",", ".");
  else if (/^\d{1,3}(\.\d{3})+$/.test(t)) t = t.replace(/\./g, "");
  return t ? parseFloat(t) : NaN;
}

async function compressPhoto(file) {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, 1024 / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
  return await new Promise((r) => c.toBlob(r, "image/jpeg", 0.82));
}

async function saveProduct(e) {
  e.preventDefault();
  syncForm();
  const fail = (t, focus) => { const m = $("#add-msg"); m.hidden = false; m.textContent = t; if (focus) $(focus)?.focus(); };
  const name = T.fs.name.trim();
  if (name.length < 2) return fail("Escribe el nombre del repuesto.", "#a-name");
  for (const [i, v] of T.fv.entries()) {
    if (!v.mk || !v.md) return fail(`Elige la marca y el modelo del carro en la versión ${i + 1}.`, `#v-mk-${i}`);
    if (!v.from || !v.to) return fail(`Elige los años (desde y hasta) en la versión ${i + 1}.`, `#v-from-${i}`);
    v._price = parsePrice(v.price);
    if (!(v._price >= 0)) return fail(`Escribe el precio de la versión ${i + 1}.`, `#v-price-${i}`);
  }
  T.saving = true; renderPanel($("#view-tienda"));
  try {
    const isNew = !T.editing || T.editing === "new";
    let pid = T.editing;
    const base = { name, category: T.fs.cat, currency: T.fs.cur };
    if (isNew) {
      const { data, error } = await db.from("products").insert({ ...base, store_id: T.store.id }).select("id").single();
      if (error) throw error;
      pid = data.id;
    } else {
      const { error } = await db.from("products").update(base).eq("id", pid);
      if (error) throw error;
      const keep = T.fv.filter((v) => v.id).map((v) => v.id);
      const old = T.products.find((p) => p.id === pid).versions.map((v) => v.id).filter((id) => !keep.includes(id));
      if (old.length) { const r = await db.from("product_versions").delete().in("id", old); if (r.error) throw r.error; }
    }
    const row = (v) => {
      let f = +v.from, t = +v.to; if (f > t) [f, t] = [t, f];
      return { make: v.mk, model: v.md, year_from: f, year_to: t, engine: v.eng || null, part_brand: v.pbrand.trim() || null, part_number: v.pn.trim() || null, condition: v.cond, price: v._price };
    };
    for (const v of T.fv.filter((v) => v.id)) {
      const r = await db.from("product_versions").update(row(v)).eq("id", v.id); if (r.error) throw r.error;
    }
    const fresh = T.fv.filter((v) => !v.id).map((v) => ({ ...row(v), product_id: pid }));
    if (fresh.length) { const r = await db.from("product_versions").insert(fresh); if (r.error) throw r.error; }
    if (T.photoFile) {
      const blob = await compressPhoto(T.photoFile);
      const path = `${T.store.id}/${pid}-${Date.now()}.jpg`;
      const up = await db.storage.from("product-photos").upload(path, blob, { contentType: "image/jpeg", upsert: true });
      if (up.error) throw up.error;
      await db.from("products").update({ photo_path: path }).eq("id", pid);
      if (T.fs.photo_path) db.storage.from("product-photos").remove([T.fs.photo_path]);
    }
    const n = T.fv.length;
    resetForm();
    await loadProducts();
    toast(isNew ? `Publicado con ${n} versi${n === 1 ? "ón" : "ones"}.${T.store.status === "active" ? " Ya aparece en las búsquedas." : ""}` : "Cambios guardados.");
  } catch (err) {
    console.error(err);
    T.saving = false;
    renderPanel($("#view-tienda"));
    const m = String(err?.message || "");
    fail(m.includes("LIMITE_PLAN") ? "Llegaste al límite de repuestos de tu plan." : "No pudimos guardar. Revisa tu conexión e inténtalo de nuevo.");
    return;
  }
  T.saving = false;
  renderPanel($("#view-tienda"));
}

function resetForm() { Object.assign(T, { editing: null, fs: null, fv: null, photoFile: null, photoPreview: null, confirmDel: false }); }

// ---------- Lista de mis repuestos ----------
function renderInv() {
  const el = $("#inv-list"); if (!el) return;
  const q = norm(T.invQ), f = T.invF;
  const list = T.products.filter((p) => {
    const txt = norm([p.name, CAT_LABEL[p.category], ...p.versions.map((v) => `${vehText(v)} ${v.part_brand || ""} ${v.part_number || ""}`)].join(" "));
    if (q && !txt.includes(q)) return false;
    if (f === "disp" && !p.versions.some((v) => v.in_stock)) return false;
    if (f === "agot" && !p.versions.some((v) => !v.in_stock)) return false;
    if (!["todos", "disp", "agot"].includes(f) && p.category !== f) return false;
    return true;
  });
  $("#inv-count").textContent = list.length === T.products.length ? `${T.products.length} repuestos` : `${list.length} de ${T.products.length} repuestos`;
  if (!T.products.length) { el.innerHTML = `<div class="empty-state">Todavía no has publicado repuestos. Empieza con el formulario de arriba.</div>`; return; }
  if (!list.length) { el.innerHTML = `<div class="empty-state">Ningún repuesto coincide con la búsqueda.</div>`; return; }
  el.innerHTML = list.map((p) => `
    <div class="inv-group ${T.editing === p.id ? "editing" : ""}">
      <div class="inv-head">
        <div class="thumb">${thumb(p)}</div>
        <div style="min-width:0"><div class="n">${esc(p.name)}</div><div class="muted" style="font-size:12px">${p.versions.length} versi${p.versions.length === 1 ? "ón" : "ones"} · ${esc(CAT_LABEL[p.category] || "")}</div></div>
        <button class="btn btn-ghost btn-sm" data-t-edit="${p.id}">Editar</button>
      </div>
      <div class="vlist">${p.versions.map((x) => `
        <div class="vrow">
          <div style="min-width:0"><div class="vt">${esc(vehText(x))}${x.part_brand ? ` · ${esc(x.part_brand)}` : ""} · ${x.condition === "usado" ? "Usado" : "Nuevo"}</div><div class="vp">${money(x.price, p.currency)}</div></div>
          <button class="switch" role="switch" aria-checked="${x.in_stock}" data-t-toggle="${p.id}:${x.id}" aria-label="Disponible: ${esc(p.name)} ${esc(vehText(x))}"><span class="track"></span>${x.in_stock ? "Disponible" : "Agotado"}</button>
        </div>`).join("")}</div>
    </div>`).join("");
}

// ---------- Eventos ----------
// Lo que necesita la carga desde Excel
const IMPORT_CTX = {
  store: () => T.store,
  products: () => T.products,
  room: () => (T.asStore || isAdmin() ? Infinity : PLAN[effPlan()].limit - T.products.length),
  done: async () => { try { await loadProducts(); } catch (e) { console.error(e); } syncForm(); renderPanel($("#view-tienda")); },
};

export function bindTienda(go) {
  bindImport(IMPORT_CTX);
  // Llegó un pedido nuevo en vivo: actualizo solo la sección de pedidos
  window.addEventListener("tr:request", async () => {
    if (S.tab !== "tienda" || !T.store || T.asStore) return;
    await loadRequests();
    const sec = document.getElementById("orders-sec");
    if (sec) { sec.outerHTML = ordersHTML(effPlan()); markRequestsSeen(); }
  });
  document.addEventListener("submit", (e) => {
    if (e.target.id === "store-form") submitStore(e);
    if (e.target.id === "add-form") saveProduct(e);
  });
  document.addEventListener("input", (e) => {
    const t = e.target;
    if (t.id === "inv-q") { T.invQ = t.value; renderInv(); }
    else if (t.dataset.ansPrice) (T.ans[t.dataset.ansPrice] ||= { price: "", note: "" }).price = t.value;
    else if (t.dataset.ansNote) (T.ans[t.dataset.ansNote] ||= { price: "", note: "" }).note = t.value;
  });
  document.addEventListener("change", (e) => {
    const t = e.target;
    if (t.id === "inv-f") { T.invF = t.value; renderInv(); }
    else if (t.classList.contains("v-mk")) { const vr = t.closest(".variant"); vr.querySelector(".v-md").innerHTML = modelOptions(t.value, ""); vr.querySelector(".v-eng").innerHTML = engineOptions("", "", ""); }
    else if (t.classList.contains("v-md")) { const vr = t.closest(".variant"); vr.querySelector(".v-eng").innerHTML = engineOptions(vr.querySelector(".v-mk").value, t.value, ""); }
    else if (t.id === "a-cat" && !T.photoPreview && !T.fs?.photo_path) { $("#ph-prev").innerHTML = CAT[t.value] || CAT.motor; }
    else if (t.id === "a-photo") {
      const f = t.files[0]; if (!f) return;
      if (!f.type.startsWith("image/")) { toast("Elige una foto (JPG o PNG)."); return; }
      T.photoFile = f; T.photoPreview = URL.createObjectURL(f);
      $("#ph-prev").innerHTML = `<img src="${T.photoPreview}" alt="">`;
    }
  });
  document.addEventListener("click", async (e) => {
    const t = e.target;
    if (!t.closest("#view-tienda")) return;
    if (t.closest("[data-t-logout]")) { await signOut(); resetTienda(); renderTienda(); toast("Cerraste sesión."); return; }
    if (t.closest("[data-t-reload]")) { T.loaded = false; renderTienda(); return; }
    if (t.closest("[data-t-exitas]")) { resetTienda(); go("admin"); return; }
    if (t.closest("[data-t-myloc]")) {
      if (!navigator.geolocation) return toast("Tu teléfono no permite compartir la ubicación.");
      navigator.geolocation.getCurrentPosition((p) => {
        const lat = p.coords.latitude, lng = p.coords.longitude;
        if (regMap?._place) { regMap._place(lat, lng); regMap.setView([lat, lng], 17); }
        else { T.regPin = { lat, lng }; const h = $("#pin-hint"); if (h) h.textContent = "Ubicación tomada de tu teléfono."; }
      },
        () => toast("No pudimos obtener tu ubicación. Revisa los permisos o marca la tienda en el mapa."), { enableHighAccuracy: true, timeout: 10000 });
      return;
    }
    const an = t.closest("[data-t-answer]");
    if (an) {
      const id = +an.dataset.tAnswer, a = T.ans[id] || {};
      const price = (a.price || "").trim();
      if (!price) { toast("Escribe el precio, o toca \"No lo tengo\"."); document.querySelector(`[data-ans-price="${id}"]`)?.focus(); return; }
      an.disabled = true; await answerRequest(id, price, (a.note || "").trim()); return;
    }
    const na = t.closest("[data-t-noans]");
    if (na) { na.disabled = true; await answerRequest(+na.dataset.tNoans, "No disponible", (T.ans[+na.dataset.tNoans]?.note || "").trim()); return; }
    if (t.closest("[data-t-reqs]")) { await loadRequests(); syncForm(); renderPanel($("#view-tienda")); toast("Pedidos actualizados."); return; }
    if (t.closest("[data-t-plans]")) { syncForm(); T.showPlans = !T.showPlans; renderPanel($("#view-tienda")); return; }
    const rp = t.closest("[data-t-reqplan]");
    if (rp) {
      const { error } = await db.from("plan_requests").insert({ store_id: T.store.id, plan: rp.dataset.tReqplan });
      if (error) return toast("No pudimos enviar la solicitud. Inténtalo de nuevo.");
      T.planReq = rp.dataset.tReqplan; T.showPlans = false; syncForm(); renderPanel($("#view-tienda"));
      toast(`Solicitud del plan ${PLAN[T.planReq].name} enviada. Te escribiremos por WhatsApp.`); return;
    }
    if (t.closest("[data-vadd]")) { syncForm(); T.fv.push(blankVariant(T.fv[T.fv.length - 1])); renderPanel($("#view-tienda")); document.querySelector(`.variant[data-vi="${T.fv.length - 1}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" }); return; }
    const vd = t.closest("[data-vdel]"); if (vd) { syncForm(); T.fv.splice(+vd.dataset.vdel, 1); renderPanel($("#view-tienda")); $("#add-form")?.scrollIntoView({ block: "start" }); return; }
    const ed = t.closest("[data-t-edit]");
    if (ed) { resetForm(); T.editing = +ed.dataset.tEdit; renderPanel($("#view-tienda")); $("#add-form").scrollIntoView({ behavior: "smooth", block: "start" }); return; }
    if (t.closest("[data-t-cancel]")) { resetForm(); renderPanel($("#view-tienda")); return; }
    if (t.closest("[data-t-delask]")) { syncForm(); T.confirmDel = true; renderPanel($("#view-tienda")); $("#add-form").scrollIntoView({ block: "center" }); return; }
    if (t.closest("[data-t-delno]")) { syncForm(); T.confirmDel = false; renderPanel($("#view-tienda")); return; }
    if (t.closest("[data-t-delyes]")) {
      const p = T.products.find((x) => x.id === T.editing);
      const { error } = await db.from("products").delete().eq("id", p.id);
      if (error) return toast("No pudimos eliminarlo. Inténtalo de nuevo.");
      if (p.photo_path) db.storage.from("product-photos").remove([p.photo_path]);
      T.products = T.products.filter((x) => x.id !== p.id); resetForm(); renderPanel($("#view-tienda")); toast("Repuesto eliminado."); return;
    }
    const tg = t.closest("[data-t-toggle]");
    if (tg) {
      const [pid, vid] = tg.dataset.tToggle.split(":").map(Number);
      const v = T.products.find((p) => p.id === pid).versions.find((x) => x.id === vid);
      const val = !v.in_stock;
      const { error } = await db.from("product_versions").update({ in_stock: val }).eq("id", vid);
      if (error) return toast("No pudimos actualizarlo. Inténtalo de nuevo.");
      v.in_stock = val; renderInv(); toast(val ? "Marcado como disponible" : "Marcado como agotado"); return;
    }
  });
}
