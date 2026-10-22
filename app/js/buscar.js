import { db, photoUrl } from "./db.js";
import { S, here, saveCar, storeById } from "./state.js";
import { $, esc, norm, money, distanceKm, kmText, waLink, toast, yearOptions, debounce } from "./util.js";
import { CAT, CAT_LABEL } from "./categorias.js";

const CUR_ORDER = { USD: 0, COP: 1, VES: 2 };
let results = [];
let searchSeq = 0;

// ---------- Ayudas para mostrar ----------
const vehText = (v) => `${v.make} ${v.model} ${v.year_from}–${v.year_to}${v.engine ? ` · motor ${v.engine}` : ""}`;
const condTag = (v) => (v.condition === "usado" ? '<span class="tag-used">Usado</span>' : '<span class="tag-new">Nuevo</span>');
const thumb = (p) => { const u = photoUrl(p.photo_path); return u ? `<img src="${esc(u)}" alt="" loading="lazy">` : CAT[p.category] || CAT.motor; };
const plateText = () => [S.car.make, S.car.model, S.car.year, S.car.engine].filter(Boolean).join(" ") || "Elige tu carro";

function makeOptions(sel) {
  return `<option value="">Marca</option>` + Object.keys(S.catalog).map((m) => `<option ${m === sel ? "selected" : ""}>${esc(m)}</option>`).join("");
}
function modelOptions(make, sel) {
  const models = make && S.catalog[make] ? Object.keys(S.catalog[make]) : [];
  return `<option value="">Modelo</option>` + models.map((m) => `<option ${m === sel ? "selected" : ""}>${esc(m)}</option>`).join("");
}
function engineOptions(make, model, sel) {
  const list = (make && model && S.catalog[make]?.[model]) || [];
  return `<option value="">Motor: todos</option>` + list.map((e) => `<option value="${esc(e)}" ${e === sel ? "selected" : ""}>Motor ${esc(e)}</option>`).join("");
}

// ---------- Pantalla ----------
export function renderBuscar() {
  const v = $("#view-buscar");
  const sf = S.storeFilter ? storeById(S.storeFilter) : null;
  const open = S.carOpen ?? !S.car.make;
  $("#f-q").value = S.q;
  v.innerHTML = `
    <section class="car-card" aria-label="Mi carro">
      <div class="car-row">
        <div class="car-ico"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 17h14M6 17l1.5-5h9L18 17M7 17v2M17 17v2"/><circle cx="8" cy="14.5" r=".6"/><circle cx="16" cy="14.5" r=".6"/></svg></div>
        <div class="car-txt"><span>Mi carro</span><b>${esc(S.car.make ? plateText() : "Elige tu carro")}</b></div>
        ${S.car.make ? `<button class="car-btn" data-car-toggle>${open ? "Listo" : "Cambiar"}</button>` : ""}
      </div>
      ${open ? `<div class="selects">
        <select id="f-make" aria-label="Marca">${makeOptions(S.car.make)}</select>
        <select id="f-model" aria-label="Modelo">${modelOptions(S.car.make, S.car.model)}</select>
        <select id="f-year" aria-label="Año">${yearOptions(S.car.year)}</select>
        <select id="f-engine" aria-label="Motor">${engineOptions(S.car.make, S.car.model, S.car.engine)}</select>
      </div>` : ""}
    </section>
    ${S.q ? "" : `<div class="chips">${["Pastillas de freno", "Filtro de aceite", "Bomba de agua", "Batería", "Amortiguador"].map((c) => `<button class="chip" data-chip="${c}">${c}</button>`).join("")}</div>`}
    <div class="pills" role="group" aria-label="Ordenar y filtrar">
      <button class="pill" data-sort="near" aria-pressed="${S.sort === "near"}">Más cerca</button>
      <button class="pill" data-sort="price" aria-pressed="${S.sort === "price"}">Más económico</button>
      <button class="pill" data-cond="nuevo" aria-pressed="${S.cond === "nuevo"}">Nuevo</button>
      <button class="pill" data-cond="usado" aria-pressed="${S.cond === "usado"}">Usado</button>
      <button class="pill" data-stock aria-pressed="${S.onlyStock}">Disponibles</button>
    </div>
    ${S.loc ? "" : `<div class="loc-note">Distancias desde el centro de San Cristóbal. <button data-loc>Usar mi ubicación</button></div>`}
    ${sf ? `<div class="toolbar"><span class="muted" style="font-size:13px">Repuestos de <b>${esc(sf.name)}</b></span><button class="btn btn-ghost btn-sm" data-clear-store>Ver todas las tiendas</button></div>` : ""}
    <div id="res"></div>`;
  search();
}

// ---------- Búsqueda en la base de datos ----------
export async function search() {
  const res = $("#res");
  if (!res) return;
  const text = norm(S.q);
  if (!S.car.make && text.length < 2 && !S.storeFilter) {
    results = [];
    res.innerHTML = `<div class="empty-state">Elige tu carro o escribe arriba el repuesto que buscas.</div>`;
    return;
  }
  const seq = ++searchSeq;
  res.innerHTML = `<div class="loading">Buscando…</div>`;

  let q = db
    .from("product_versions")
    .select("id, product_id, make, model, year_from, year_to, engine, part_brand, part_number, condition, price, in_stock, updated_at, products!inner(id, name, category, currency, photo_path, search, store_id)")
    .limit(200);
  if (S.car.make) q = q.eq("make", S.car.make);
  if (S.car.model) q = q.eq("model", S.car.model);
  if (S.car.year) q = q.lte("year_from", +S.car.year).gte("year_to", +S.car.year);
  if (S.car.engine) q = q.or(`engine.is.null,engine.eq."${S.car.engine}"`);
  for (const word of text.split(/\s+/).filter((w) => w.length > 1)) q = q.ilike("products.search", `%${word}%`);
  if (S.cond !== "todos") q = q.eq("condition", S.cond);
  if (S.money !== "todas") q = q.eq("products.currency", S.money);
  if (S.onlyStock) q = q.eq("in_stock", true);
  if (S.storeFilter) q = q.eq("products.store_id", S.storeFilter);

  const { data, error } = await q;
  if (seq !== searchSeq) return; // llegó una búsqueda más nueva
  if (error) {
    console.error(error);
    res.innerHTML = `<div class="empty-state">No pudimos buscar. Revisa tu conexión e inténtalo de nuevo.</div>`;
    return;
  }
  const me = here();
  results = data
    .map((v) => ({ ...v, p: v.products, st: storeById(v.products.store_id) }))
    .filter((r) => r.st)
    .map((r) => ({ ...r, dist: distanceKm(me, r.st) }));

  // "Mejor precio": mismo repuesto, mismo carro, mismo estado y misma moneda
  const key = (r) => [r.p.search, r.make, r.model, r.condition, r.p.currency].join("|");
  const best = {}, count = {};
  for (const r of results) if (r.in_stock) {
    const k = key(r); count[k] = (count[k] || 0) + 1;
    if (!best[k] || r.price < best[k].price) best[k] = r;
  }
  for (const r of results) r.best = best[key(r)] === r && count[key(r)] > 1;

  const plus = (r) => (r.st.plan === "plus" ? 1 : 0);
  results.sort((a, b) =>
    (b.in_stock - a.in_stock) || (plus(b) - plus(a)) ||
    (S.sort === "near"
      ? (a.dist ?? 999) - (b.dist ?? 999)
      : (CUR_ORDER[a.p.currency] - CUR_ORDER[b.p.currency]) || (a.price - b.price)));

  renderResults();
  if (text.length >= 3) logSearch(text, results.length);
}

const logSearch = debounce((query, n) => {
  db.from("search_logs").insert({ query, make: S.car.make || null, model: S.car.model || null, year: S.car.year ? +S.car.year : null, engine: S.car.engine || null, results: n }).then(() => {});
}, 1500);

function renderResults() {
  const res = $("#res");
  if (!results.length) {
    res.innerHTML = `<div class="empty-state">No encontramos ese repuesto para tu carro en las tiendas de la app.<br><button class="btn btn-signal btn-sm" data-go="pedir">Pídelo y que las tiendas te respondan</button></div>`;
    return;
  }
  res.innerHTML = `<div class="toolbar" style="margin-bottom:8px"><span class="muted" style="font-size:13px">${results.length} resultado${results.length === 1 ? "" : "s"}</span></div>
    <div class="list">${results.map((r, i) => `
      <button class="card ${r.in_stock ? "" : "out"}" data-r="${i}">
        <div class="thumb">${thumb(r.p)}</div>
        <div class="card-body">
          <div class="card-title">${esc(r.p.name)}${r.part_brand ? ` <span class="pb">${esc(r.part_brand)}</span>` : ""} ${condTag(r)}</div>
          <div class="card-meta">${esc(vehText(r))}</div>
          <div class="store-line"><span>${esc(r.st.name)}</span>${r.st.plan === "plus" ? '<span class="tag-star">Destacada</span>' : ""}<span class="dist">· ${kmText(r.dist)}</span></div>
        </div>
        <div class="price"><b>${money(r.price, r.p.currency)}</b>${r.in_stock ? (r.best ? '<span class="badge b-best">Mejor precio</span>' : "") : '<span class="badge b-out">Agotado</span>'}</div>
      </button>`).join("")}</div>`;
}

// ---------- Detalle de un repuesto ----------
export async function openResult(i) {
  const r = results[i];
  if (!r) return;
  const st = r.st;
  const car = S.car.make ? plateText() : vehText(r);
  const msg = `Hola, vi en Tu Repuesto: ${r.p.name}${r.part_brand ? ` marca ${r.part_brand}` : ""}${r.part_number ? ` (ref. ${r.part_number})` : ""} para ${car}. ¿Lo tienen disponible? Precio publicado: ${money(r.price, r.p.currency)}.`;
  const maps = st.lat != null ? `https://www.google.com/maps/dir/?api=1&destination=${st.lat},${st.lng}` : null;

  $("#sheet-in").innerHTML = `
    <div class="sheet-head">
      <div class="thumb">${thumb(r.p)}</div>
      <div style="min-width:0"><div class="eyebrow">${esc(CAT_LABEL[r.p.category] || "")}</div><h2 id="sheet-title">${esc(r.p.name)}</h2>${r.part_number ? `<div class="pn">Ref. ${esc(r.part_number)}</div>` : ""}</div>
      <button class="x" data-close aria-label="Cerrar">×</button>
    </div>
    <div style="display:flex;align-items:baseline;gap:10px;flex-wrap:wrap">
      <span style="font-family:var(--f-display);font-size:30px;font-weight:700">${money(r.price, r.p.currency)}</span>
      ${r.in_stock ? '<span class="badge b-ok">Disponible</span>' : '<span class="badge b-out">Agotado</span>'}
    </div>
    <dl class="info-grid">
      <dt>Sirve para</dt><dd>${esc(vehText(r))}</dd>
      ${r.part_brand ? `<dt>Marca</dt><dd>${esc(r.part_brand)}</dd>` : ""}
      <dt>Estado</dt><dd>${condTag(r)}</dd>
      <dt>Tienda</dt><dd><b>${esc(st.name)}</b><br>${esc([st.zone, st.address].filter(Boolean).join(" · "))}${r.dist != null ? ` · <span class="dist">${kmText(r.dist)}</span>` : ""}</dd>
      ${st.hours ? `<dt>Horario</dt><dd>${esc(st.hours)}</dd>` : ""}
      <dt>Actualizado</dt><dd>${new Date(r.updated_at).toLocaleDateString("es-VE", { day: "numeric", month: "long" })}</dd>
    </dl>
    <div class="btn-row">
      <a class="btn btn-wa" href="${esc(waLink(st.whatsapp, msg))}" target="_blank" rel="noopener" data-contact="${st.id}:${r.id}">Preguntar por WhatsApp</a>
      ${maps ? `<a class="btn btn-ghost" href="${maps}" target="_blank" rel="noopener">Cómo llegar</a>` : ""}
    </div>
    <div id="more"></div>`;
  $("#sheet").hidden = false;
  loadMore(r);
}

async function loadMore(r) {
  const [sib, cmp] = await Promise.all([
    db.from("product_versions").select("id, make, model, year_from, year_to, engine, part_brand, condition, price, in_stock").eq("product_id", r.product_id).neq("id", r.id),
    db.from("product_versions").select("id, part_brand, condition, price, in_stock, products!inner(id, currency, search, store_id)")
      .eq("make", r.make).eq("model", r.model).eq("products.search", r.p.search).neq("product_id", r.product_id).limit(20),
  ]);
  const el = $("#more");
  if (!el) return;
  let h = "";
  if (sib.data?.length) {
    h += `<div><div class="eyebrow" style="margin:6px 0">Otras versiones en esta tienda</div><div class="compare">${sib.data.map((o) => `
      <div class="compare-row"><div><b>${esc(vehText(o))}</b><div class="muted" style="font-size:12px">${esc(o.part_brand || "Sin marca indicada")} · ${o.condition === "usado" ? "Usado" : "Nuevo"}${o.in_stock ? "" : " · agotado"}</div></div><span></span><div class="p">${money(o.price, r.p.currency)}</div></div>`).join("")}</div></div>`;
  }
  const others = (cmp.data || []).map((o) => ({ ...o, st: storeById(o.products.store_id), d: null })).filter((o) => o.st);
  if (others.length) {
    for (const o of others) o.d = distanceKm(here(), o.st);
    others.sort((a, b) => (b.in_stock - a.in_stock) || (CUR_ORDER[a.products.currency] - CUR_ORDER[b.products.currency]) || (a.price - b.price));
    h += `<div><div class="eyebrow" style="margin:10px 0 6px">También en otras tiendas</div><div class="compare">${others.map((o) => `
      <div class="compare-row"><div><b>${esc(o.st.name)}</b> ${o.condition === "usado" ? '<span class="tag-used">Usado</span>' : ""}<div class="muted" style="font-size:12px">${esc(o.st.zone || "")}${o.d != null ? ` · ${kmText(o.d)}` : ""}${o.in_stock ? "" : " · agotado"}</div></div><span></span><div class="p">${money(o.price, o.products.currency)}</div></div>`).join("")}</div></div>`;
  }
  el.innerHTML = h;
}

export function logContact(storeId, versionId) {
  db.from("contact_events").insert({ store_id: storeId, version_id: versionId }).then(() => {});
}

// ---------- Eventos de esta pantalla ----------
export function bindBuscar() {
  document.addEventListener("change", (e) => {
    const id = e.target.id;
    if (id === "f-make") { S.carOpen = true; S.car = { make: e.target.value, model: "", year: S.car.year, engine: "" }; saveCar(); renderBuscar(); }
    else if (id === "f-model") { S.car.model = e.target.value; S.car.engine = ""; saveCar(); renderBuscar(); }
    else if (id === "f-year") { S.car.year = e.target.value; saveCar(); renderBuscar(); }
    else if (id === "f-engine") { S.car.engine = e.target.value; saveCar(); renderBuscar(); }
  });
  const typed = debounce(() => search(), 300);
  document.addEventListener("input", (e) => {
    if (e.target.id === "f-q") { S.q = e.target.value; const ch = document.querySelector("#view-buscar .chips"); if (ch) ch.hidden = !!S.q; typed(); }
  });
  document.addEventListener("click", (e) => {
    const t = e.target;
    const chip = t.closest("[data-chip]"); if (chip) { S.q = chip.dataset.chip; renderBuscar(); return; }
    const so = t.closest("[data-sort]"); if (so) { S.sort = so.dataset.sort; renderBuscar(); return; }
    const co = t.closest("[data-cond]"); if (co) { S.cond = S.cond === co.dataset.cond ? "todos" : co.dataset.cond; renderBuscar(); return; }
    if (t.closest("[data-stock]")) { S.onlyStock = !S.onlyStock; renderBuscar(); return; }
    if (t.closest("[data-car-toggle]")) { S.carOpen = !(S.carOpen ?? !S.car.make); renderBuscar(); return; }
    const card = t.closest("[data-r]"); if (card) { openResult(+card.dataset.r); return; }
    const ct = t.closest("[data-contact]"); if (ct) { const [s, v] = ct.dataset.contact.split(":"); logContact(+s, +v); return; }
    if (t.closest("[data-clear-store]")) { S.storeFilter = null; renderBuscar(); return; }
  });
}
