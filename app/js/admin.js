import { db } from "./db.js";
import { S, loadStores, loadCatalog } from "./state.js";
import { auth, isAdmin } from "./auth.js";
import { $, esc, norm, toast } from "./util.js";
import { PLAN, openAsStore } from "./tienda.js";

// ---------- Estado del panel ----------
const A = { tab: "resumen", loaded: false, stores: [], owners: {}, planReqs: [], payments: [], searches: [], counts: {}, confirm: null, payFor: null, q: "" };
const PAID = ["basico", "estandar", "plus"];
const STATUS = { pending: ["b-best", "Por aprobar"], active: ["b-ok", "Activa"], rejected: ["b-out", "Rechazada"], suspended: ["b-out", "Suspendida"] };
const today = () => new Date().toISOString().slice(0, 10);
const addDays = (d, n) => { const x = new Date(d + "T12:00:00"); x.setDate(x.getDate() + n); return x.toISOString().slice(0, 10); };
const fmtDate = (d) => d ? new Date(d.length === 10 ? d + "T12:00:00" : d).toLocaleDateString("es-VE", { day: "numeric", month: "short" }) : "—";

function payState(s) {
  if (s.status !== "active") return null;
  if (s.plan === "trial") {
    if (!s.trial_ends_at) return ["b-free", "Prueba"];
    const left = Math.ceil((new Date(s.trial_ends_at) - Date.now()) / 86400000);
    return left < 0 ? ["b-out", "Prueba vencida"] : ["b-free", `Prueba · ${left} días`];
  }
  if (!s.paid_until) return ["b-out", "Sin pago registrado"];
  const left = Math.ceil((new Date(s.paid_until + "T23:59:59") - Date.now()) / 86400000);
  if (left < 0) return ["b-out", `Vencido hace ${-left} días`];
  if (left <= 3) return ["b-best", `Vence en ${left} días`];
  return ["b-ok", `Al día · ${fmtDate(s.paid_until)}`];
}

// ---------- Carga ----------
async function load() {
  const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
  const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();
  const [stores, profiles, reqs, pays, logs, prods, contacts, users] = await Promise.all([
    db.from("stores").select("*").order("created_at", { ascending: false }),
    db.from("profiles").select("id, email, full_name"),
    db.from("plan_requests").select("id, store_id, plan, created_at").eq("status", "pending").order("created_at"),
    db.from("payments").select("store_id, plan, amount, currency, method, paid_at").gte("paid_at", monthStart.toISOString().slice(0, 10)),
    db.from("search_logs").select("query, make, model, year, results, created_at").gte("created_at", weekAgo).limit(5000),
    db.from("products").select("id, store_id"),
    db.from("contact_events").select("id, store_id, created_at").gte("created_at", monthStart.toISOString()),
    db.from("profiles").select("id", { count: "exact", head: true }),
  ]);
  for (const r of [stores, profiles, reqs, pays, logs, prods, contacts]) if (r.error) throw r.error;
  A.stores = stores.data;
  A.owners = Object.fromEntries(profiles.data.map((p) => [p.id, p]));
  A.planReqs = reqs.data;
  A.payments = pays.data;
  A.searches = logs.data;
  A.counts = {
    products: prods.data.length,
    productsBy: prods.data.reduce((m, p) => ((m[p.store_id] = (m[p.store_id] || 0) + 1), m), {}),
    contacts: contacts.data.length,
    contactsBy: contacts.data.reduce((m, c) => ((m[c.store_id] = (m[c.store_id] || 0) + 1), m), {}),
    users: users.count || 0,
  };
  A.loaded = true;
}

// ---------- Pantalla ----------
export async function renderAdmin() {
  const v = $("#view-admin");
  if (!auth.user || !isAdmin()) {
    v.innerHTML = `<div class="empty-state">Esta sección es solo para la administradora. Entra con tu cuenta desde <b>Mi tienda</b>.<br><button class="btn btn-ghost btn-sm" data-go="tienda">Ir a Mi tienda</button></div>`;
    return;
  }
  if (!A.loaded) {
    v.innerHTML = `<div class="loading">Cargando el panel…</div>`;
    try { await load(); } catch (e) { console.error(e); v.innerHTML = `<div class="empty-state">No pudimos cargar el panel. Revisa tu conexión.<br><button class="btn btn-ghost btn-sm" data-a-reload>Reintentar</button></div>`; return; }
  }
  const pend = A.stores.filter((s) => s.status === "pending");
  const tabs = [["resumen", "Resumen"], ["solicitudes", `Solicitudes${pend.length ? ` (${pend.length})` : ""}`], ["tiendas", "Tiendas"], ["catalogo", "Catálogo"]];
  const body = { resumen: resumenHTML, solicitudes: solicitudesHTML, tiendas: tiendasHTML, catalogo: catalogoHTML }[A.tab]();
  v.innerHTML = `
    <div class="toolbar" style="align-items:flex-start"><div><div class="eyebrow">Solo para ti</div><h2>Panel de administradora</h2></div><button class="btn btn-ghost btn-sm" data-a-reload>Actualizar</button></div>
    <div class="seg adm-tabs" role="tablist">${tabs.map(([k, l]) => `<button role="tab" data-atab="${k}" aria-pressed="${A.tab === k}">${l}</button>`).join("")}</div>
    ${body}`;
}

function resumenHTML() {
  const active = A.stores.filter((s) => s.status === "active");
  const paying = active.filter((s) => PAID.includes(s.plan));
  const expected = paying.reduce((a, s) => a + PLAN[s.plan].price, 0);
  const collected = A.payments.filter((p) => (p.currency || "USD") === "USD").reduce((a, p) => a + Number(p.amount), 0);
  const toCollect = paying.filter((s) => { const ps = payState(s); return ps && ps[0] !== "b-ok"; });
  const byPlan = ["plus", "estandar", "basico", "trial"].map((pl) => [pl, active.filter((s) => s.plan === pl).length]);

  // Búsquedas de la semana
  const top = {}, none = {};
  for (const l of A.searches) {
    const k = norm(l.query); if (!k) continue;
    top[k] = (top[k] || 0) + 1;
    if (l.results === 0) { const kk = [l.query, l.make, l.model, l.year].filter(Boolean).join(" · "); none[kk] = (none[kk] || 0) + 1; }
  }
  const topList = Object.entries(top).sort((a, b) => b[1] - a[1]).slice(0, 6);
  const noneList = Object.entries(none).sort((a, b) => b[1] - a[1]).slice(0, 6);
  const maxS = topList[0]?.[1] || 1;

  return `
    <div class="kpis">
      <div class="stat"><b>${active.length}</b><span>tiendas activas</span></div>
      <div class="stat"><b>${A.stores.filter((s) => s.status === "pending").length}</b><span>tiendas por aprobar</span></div>
      <div class="stat"><b>${A.counts.products}</b><span>repuestos publicados</span></div>
      <div class="stat"><b>${A.counts.contacts}</b><span>contactos por WhatsApp este mes</span></div>
    </div>
    <section class="panel">
      <div class="toolbar"><h2 style="font-size:19px">Ingresos del mes</h2><span class="money-big">$${collected.toLocaleString("es-VE")} <small>de $${expected} esperados</small></span></div>
      <div class="bar"><span style="width:${expected ? Math.min(100, Math.round((collected / expected) * 100)) : 0}%"></span></div>
      <table class="tbl"><thead><tr><th>Plan</th><th class="rnum">Tiendas</th><th class="rnum">Precio</th><th class="rnum">Total</th></tr></thead><tbody>
        ${byPlan.map(([pl, n]) => `<tr><td>${PLAN[pl].name}</td><td class="rnum">${n}</td><td class="rnum">$${PLAN[pl].price}</td><td class="rnum">$${n * PLAN[pl].price}</td></tr>`).join("")}
      </tbody></table>
      <p class="muted" style="margin:0;font-size:12px">"Cobrado" suma los pagos en dólares registrados este mes. Los pagos en otras monedas quedan anotados en cada tienda.</p>
    </section>
    ${A.planReqs.length ? `<section class="panel">
      <h2 style="font-size:19px">Solicitudes de cambio de plan</h2>
      ${A.planReqs.map((r) => { const s = A.stores.find((x) => x.id === r.store_id); return s ? `<div class="adm-row"><div style="min-width:0"><b>${esc(s.name)}</b><div class="muted" style="font-size:12.5px">${PLAN[s.plan]?.name || s.plan} → ${PLAN[r.plan].name} · $${PLAN[r.plan].price} al mes · ${fmtDate(r.created_at)}</div></div><button class="btn btn-primary btn-sm" data-a-pay="${s.id}:${r.plan}:${r.id}">Registrar pago</button></div>` : ""; }).join("")}
    </section>` : ""}
    <section class="panel">
      <h2 style="font-size:19px">Cobros pendientes</h2>
      ${toCollect.length ? toCollect.map((s) => `<div class="adm-row"><div style="min-width:0"><b>${esc(s.name)}</b><div class="muted" style="font-size:12.5px">Plan ${PLAN[s.plan].name} · $${PLAN[s.plan].price} · <span class="badge ${payState(s)[0]}">${payState(s)[1]}</span></div></div><button class="btn btn-primary btn-sm" data-a-pay="${s.id}:${s.plan}:">Registrar pago</button></div>`).join("")
        : `<p class="muted" style="margin:0;font-size:13.5px">Todas las tiendas con plan pagado están al día.</p>`}
    </section>
    ${payFormHTML()}
    <section class="panel">
      <h2 style="font-size:19px">Lo más buscado (7 días)</h2>
      ${topList.length ? `<div class="hbars">${topList.map(([q, n]) => `<div class="hb"><span>${esc(q)}</span><div class="hb-track"><i style="width:${Math.round((n / maxS) * 100)}%"></i></div><b>${n}</b></div>`).join("")}</div>` : `<p class="muted" style="margin:0;font-size:13.5px">Todavía no hay búsquedas.</p>`}
    </section>
    <section class="panel">
      <div><h2 style="font-size:19px">Búsquedas sin resultado (7 días)</h2><p class="muted" style="margin:2px 0 0;font-size:13px">Lo que la gente busca y ninguna tienda tiene. Úsalo para saber qué tiendas buscar.</p></div>
      ${noneList.length ? noneList.map(([q, n]) => `<div class="adm-row"><span>${esc(q)}</span><span class="badge b-out">${n}</span></div>`).join("") : `<p class="muted" style="margin:0;font-size:13.5px">Nada por ahora.</p>`}
    </section>
    <p class="muted" style="font-size:12.5px;margin:0">${A.counts.users} cuentas registradas en total.</p>`;
}

function payFormHTML() {
  if (!A.payFor) return "";
  const [id, plan] = A.payFor;
  const s = A.stores.find((x) => x.id === id);
  const from = s.paid_until && s.paid_until >= today() ? s.paid_until : today();
  return `<form class="panel edit-mode" id="pay-form" novalidate>
    <div class="toolbar"><h2 style="font-size:19px">Registrar pago</h2><span class="badge b-best">${esc(s.name)}</span></div>
    <div class="grid2">
      <label class="fl">Plan<select id="p-plan">${PAID.map((p) => `<option value="${p}" ${p === plan ? "selected" : ""}>${PLAN[p].name} · $${PLAN[p].price}</option>`).join("")}</select></label>
      <label class="fl">Monto<input type="text" inputmode="decimal" id="p-amount" value="${PLAN[plan]?.price || ""}"></label>
    </div>
    <div class="grid2">
      <label class="fl">Moneda<select id="p-cur"><option value="USD">Dólares ($)</option><option value="COP">Pesos (COP)</option><option value="VES">Bolívares (Bs)</option></select></label>
      <label class="fl">Forma de pago<select id="p-method"><option>Pago móvil</option><option>Zelle</option><option>Efectivo</option><option>Transferencia</option><option>Otro</option></select></label>
    </div>
    <label class="fl">Pagado hasta<input type="date" id="p-until" value="${addDays(from, 30)}"></label>
    <label class="fl">Nota (opcional)<input type="text" id="p-notes" placeholder="Ej: referencia del pago móvil"></label>
    <div class="btn-row"><button class="btn btn-signal" type="submit">Guardar pago y activar plan</button><button class="btn btn-ghost" type="button" data-a-paycancel>Cancelar</button></div>
  </form>`;
}

function solicitudesHTML() {
  const pend = A.stores.filter((s) => s.status === "pending");
  if (!pend.length) return `<div class="empty-state">No hay tiendas esperando aprobación.</div>`;
  return `<p class="muted" style="margin:0;font-size:13.5px">Antes de aprobar, confirma que la tienda existe: escríbele por WhatsApp o pídele a tu socio que la visite.</p>` + pend.map((s) => `
    <section class="panel">
      <div class="toolbar"><b style="font-size:16px">${esc(s.name)}</b><span class="muted" style="font-size:12px">${fmtDate(s.created_at)}</span></div>
      <dl class="info-grid">
        <dt>RIF</dt><dd>${esc(s.rif || "—")}</dd>
        <dt>WhatsApp</dt><dd>${esc(s.whatsapp)}</dd>
        <dt>Zona</dt><dd>${esc([s.zone, s.address].filter(Boolean).join(" · ") || "—")}</dd>
        <dt>Cuenta</dt><dd>${esc(A.owners[s.owner_id]?.email || "—")}</dd>
        <dt>Repuestos</dt><dd>${A.counts.productsBy[s.id] || 0} cargados</dd>
        ${s.lat != null ? `<dt>Mapa</dt><dd><a href="https://www.google.com/maps?q=${s.lat},${s.lng}" target="_blank" rel="noopener">Ver ubicación</a></dd>` : ""}
      </dl>
      ${A.confirm === "rej:" + s.id
        ? `<div class="del-confirm"><span>¿Rechazar esta tienda?</span><div class="btn-row"><button class="btn btn-danger btn-sm" data-a-status="${s.id}:rejected">Sí, rechazar</button><button class="btn btn-ghost btn-sm" data-a-cancel>No</button></div></div>`
        : `<div class="btn-row"><button class="btn btn-signal" data-a-status="${s.id}:active">Aprobar tienda</button><button class="btn btn-ghost" data-a-confirm="rej:${s.id}">Rechazar</button></div>`}
    </section>`).join("");
}

function tiendasHTML() {
  const q = norm(A.q);
  const list = A.stores.filter((s) => !q || norm(`${s.name} ${s.zone} ${s.whatsapp}`).includes(q));
  return `
    <div class="search inv-search"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
      <input type="search" id="a-q" placeholder="Buscar tienda" value="${esc(A.q)}" aria-label="Buscar tienda" autocomplete="off"></div>
    ${payFormHTML()}
    ${list.length ? list.map((s) => { const ps = payState(s); const st = STATUS[s.status]; return `
    <section class="panel ${s.status === "suspended" ? "is-sus" : ""}">
      <div class="toolbar" style="align-items:flex-start"><div style="min-width:0"><b style="font-size:15.5px">${esc(s.name)}</b><div class="muted" style="font-size:12.5px">${esc(s.zone || "—")} · ${A.counts.productsBy[s.id] || 0} repuestos · ${A.counts.contactsBy[s.id] || 0} contactos este mes</div><div class="muted" style="font-size:12.5px">${esc([s.whatsapp, A.owners[s.owner_id]?.email].filter(Boolean).join(" · "))}</div></div>
        <div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px"><span class="badge ${st[0]}">${st[1]}</span>${ps ? `<span class="badge ${ps[0]}">${ps[1]}</span>` : ""}</div></div>
      <div class="adm-actions">
        <label class="fl" style="flex:1;min-width:130px">Plan<select data-a-plan="${s.id}" id="plan-${s.id}">${["trial", ...PAID].map((p) => `<option value="${p}" ${p === s.plan ? "selected" : ""}>${PLAN[p].name}</option>`).join("")}</select></label>
        ${s.status === "active" && PAID.includes(s.plan) ? `<button class="btn btn-primary btn-sm" data-a-pay="${s.id}:${s.plan}:">Registrar pago</button>` : ""}
        <button class="btn btn-ghost btn-sm" data-a-store="${s.id}">Ver y editar repuestos</button>
      </div>
      <div class="btn-row" style="justify-content:flex-start;gap:16px">
        ${s.status === "active" ? `<button class="btn-link" data-a-status="${s.id}:suspended">Suspender</button>` : ""}
        ${s.status === "suspended" || s.status === "rejected" ? `<button class="btn-link" style="color:var(--ok)" data-a-status="${s.id}:active">Reactivar</button>` : ""}
        ${s.status === "pending" ? `<button class="btn-link" style="color:var(--ok)" data-a-status="${s.id}:active">Aprobar</button>` : ""}
      </div>
    </section>`; }).join("") : `<div class="empty-state">${A.stores.length ? "Ninguna tienda coincide." : "Todavía no hay tiendas registradas."}</div>`}`;
}

function catalogoHTML() {
  const rows = Object.keys(S.catalog).flatMap((mk) => Object.keys(S.catalog[mk]).map((md) => [mk, md, S.catalog[mk][md]]));
  return `
    <form class="panel" id="cat-form" novalidate>
      <h2 style="font-size:19px">Agregar modelo o motores</h2>
      <p class="muted" style="margin:0;font-size:13px">Si el modelo ya existe, los motores nuevos se suman a los que tiene.</p>
      <div class="grid2"><label class="fl">Marca<input type="text" id="c-make" list="mk-list" placeholder="Ej: Hyundai"></label><label class="fl">Modelo<input type="text" id="c-model" placeholder="Ej: Getz"></label></div>
      <datalist id="mk-list">${Object.keys(S.catalog).map((m) => `<option value="${esc(m)}">`).join("")}</datalist>
      <label class="fl">Motores (separados por coma)<input type="text" id="c-eng" placeholder="Ej: 1.3, 1.6"></label>
      <button class="btn btn-signal" type="submit">Guardar en el catálogo</button>
    </form>
    <section class="panel">
      <h2 style="font-size:19px">Catálogo · ${rows.length} modelos</h2>
      <div style="overflow-x:auto"><table class="tbl"><thead><tr><th>Marca</th><th>Modelo</th><th>Motores</th></tr></thead><tbody>
        ${rows.map(([mk, md, en]) => `<tr><td>${esc(mk)}</td><td>${esc(md)}</td><td>${en.length ? en.map(esc).join(", ") : "—"}</td></tr>`).join("")}
      </tbody></table></div>
    </section>`;
}

// ---------- Acciones ----------
async function setStatus(id, status) {
  const { error } = await db.from("stores").update({ status }).eq("id", id);
  if (error) { toast("No pudimos guardar el cambio."); return; }
  const s = A.stores.find((x) => x.id === id);
  A.confirm = null;
  A.loaded = false; await renderAdmin(); loadStores();
  toast({ active: `${s.name} está activa y ya aparece en la app.`, rejected: `${s.name} fue rechazada.`, suspended: `${s.name} fue suspendida.` }[status]);
}

async function savePayment(e) {
  e.preventDefault();
  const [id, , reqId] = A.payFor;
  const plan = $("#p-plan").value, until = $("#p-until").value;
  const amount = parseFloat($("#p-amount").value.replace(/\./g, "").replace(",", ".")) || parseFloat($("#p-amount").value);
  if (!(amount > 0)) return toast("Escribe el monto del pago.");
  if (!until) return toast("Elige hasta qué fecha queda pagado.");
  const r1 = await db.from("payments").insert({ store_id: id, plan, amount, currency: $("#p-cur").value, method: $("#p-method").value, period_until: until, notes: $("#p-notes").value.trim() || null });
  if (r1.error) return toast("No pudimos registrar el pago.");
  const r2 = await db.from("stores").update({ plan, paid_until: until }).eq("id", id);
  if (r2.error) return toast("El pago quedó registrado, pero no pudimos activar el plan.");
  if (reqId) await db.from("plan_requests").update({ status: "done" }).eq("id", +reqId);
  else await db.from("plan_requests").update({ status: "done" }).eq("store_id", id).eq("status", "pending");
  A.payFor = null; A.loaded = false; await renderAdmin(); loadStores();
  toast(`Pago registrado. Plan ${PLAN[plan].name} activo hasta el ${fmtDate(until)}`);
}

async function saveCatalog(e) {
  e.preventDefault();
  const mk = $("#c-make").value.trim(), md = $("#c-model").value.trim();
  const en = $("#c-eng").value.split(",").map((x) => x.trim()).filter(Boolean);
  if (!mk || !md) return toast("Escribe la marca y el modelo.");
  const engines = [...new Set([...(S.catalog[mk]?.[md] || []), ...en])];
  const { error } = await db.from("vehicle_models").upsert({ make: mk, model: md, engines }, { onConflict: "make,model" });
  if (error) { console.error(error); return toast("No pudimos guardarlo en el catálogo."); }
  await loadCatalog(); renderAdmin(); toast(`${mk} ${md} guardado en el catálogo.`);
}

export function resetAdmin() { A.loaded = false; }

export function bindAdmin(go) {
  document.addEventListener("submit", (e) => {
    if (e.target.id === "pay-form") savePayment(e);
    if (e.target.id === "cat-form") saveCatalog(e);
  });
  document.addEventListener("input", (e) => {
    if (e.target.id === "a-q") { A.q = e.target.value; const pos = e.target.selectionStart; renderAdmin().then(() => { const i = $("#a-q"); i?.focus(); i?.setSelectionRange(pos, pos); }); }
  });
  document.addEventListener("change", async (e) => {
    const pl = e.target.dataset?.aPlan;
    if (!pl) return;
    const id = +pl, plan = e.target.value;
    const { error } = await db.from("stores").update({ plan }).eq("id", id);
    if (error) return toast("No pudimos cambiar el plan.");
    A.stores.find((s) => s.id === id).plan = plan; renderAdmin(); loadStores();
    toast(`Plan cambiado a ${PLAN[plan].name}. Si ya pagó, registra el pago para fijar la fecha.`);
  });
  document.addEventListener("click", (e) => {
    const t = e.target;
    if (!t.closest("#view-admin")) return;
    if (t.closest("[data-a-reload]")) { A.loaded = false; renderAdmin(); return; }
    const at = t.closest("[data-atab]"); if (at) { A.tab = at.dataset.atab; A.payFor = null; renderAdmin(); return; }
    const st = t.closest("[data-a-status]"); if (st) { const [id, s] = st.dataset.aStatus.split(":"); setStatus(+id, s); return; }
    const cf = t.closest("[data-a-confirm]"); if (cf) { A.confirm = cf.dataset.aConfirm; renderAdmin(); return; }
    if (t.closest("[data-a-cancel]")) { A.confirm = null; renderAdmin(); return; }
    const pay = t.closest("[data-a-pay]"); if (pay) { const [id, plan, req] = pay.dataset.aPay.split(":"); A.payFor = [+id, PAID.includes(plan) ? plan : "basico", req || ""]; renderAdmin().then(() => $("#pay-form")?.scrollIntoView({ behavior: "smooth", block: "center" })); return; }
    if (t.closest("[data-a-paycancel]")) { A.payFor = null; renderAdmin(); return; }
    const as = t.closest("[data-a-store]"); if (as) { openAsStore(+as.dataset.aStore); go("tienda"); return; }
  });
}
