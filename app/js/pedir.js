import { db } from "./db.js";
import { S, here, storeById } from "./state.js";
import { $, esc, distanceKm, kmText, waLink, toast, yearOptions, ago, store } from "./util.js";
import { auth, authForm, signOut } from "./auth.js";
import { setDot } from "./notify.js";

// Pestaña "Pedir": el cliente pide un repuesto y las tiendas le responden
const MAX_OPEN = 5; // pedidos abiertos a la vez por persona
const R = { list: null, loading: false, sending: false, form: null };
let timer = null;

export function resetPedir() { R.list = null; R.form = null; }

const ICON_USER = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/></svg>`;

const vehOf = (r) => [r.make, r.model, r.year, r.engine ? `motor ${r.engine}` : ""].filter(Boolean).join(" ") || "Vehículo sin especificar";
const isNo = (x) => /^no disponible/i.test(x.price_text);

function makeOptions(sel) {
  return `<option value="">Marca</option>` + Object.keys(S.catalog).map((m) => `<option ${m === sel ? "selected" : ""}>${esc(m)}</option>`).join("");
}
function modelOptions(make, sel) {
  const models = make && S.catalog[make] ? Object.keys(S.catalog[make]) : [];
  return `<option value="">Modelo</option>` + models.map((m) => `<option ${m === sel ? "selected" : ""}>${esc(m)}</option>`).join("");
}
function engineOptions(make, model, sel) {
  const list = (make && model && S.catalog[make]?.[model]) || [];
  return `<option value="">Motor (opcional)</option>` + list.map((e) => `<option value="${esc(e)}" ${e === sel ? "selected" : ""}>Motor ${esc(e)}</option>`).join("");
}

// ---------- Datos ----------
async function loadMine() {
  const { data, error } = await db.from("part_requests")
    .select("id, part, make, model, year, engine, note, status, created_at, request_responses(id, store_id, price_text, note, created_at)")
    .eq("buyer_id", auth.user.id)
    .order("created_at", { ascending: false })
    .limit(30);
  if (error) throw error;
  R.list = data.map((r) => ({ ...r, responses: (r.request_responses || []).sort((a, b) => new Date(a.created_at) - new Date(b.created_at)) }));
  markSeen();
}

const totalResponses = (list) => list.reduce((n, r) => n + r.responses.length, 0);
function markSeen() {
  if (!auth.user || !R.list) return;
  store.set("seen:" + auth.user.id, totalResponses(R.list));
  setDot("pedir", false);
}

// ---------- Pantalla ----------
export async function renderPedir() {
  const v = $("#view-pedir");
  clearInterval(timer);
  const head = `<div><div class="eyebrow">¿No lo encuentras?</div><h2>Pide tu repuesto</h2><p class="muted" style="margin:4px 0 0">Las tiendas de la app reciben tu pedido y te responden con precio y disponibilidad.</p></div>`;

  if (!auth.user) {
    v.innerHTML = head + `
      <section class="panel auth-card">
        <div class="auth-ico">${ICON_USER}</div>
        <h2 style="font-size:19px">Entra para pedir repuestos</h2>
        <p class="muted" style="margin:0;font-size:13.5px">Para buscar y ver precios no necesitas cuenta. Para pedir un repuesto sí: así las respuestas de las tiendas quedan guardadas en <b>Mis pedidos</b>, aunque cambies de teléfono.</p>
        ${authForm("buyer", "signup")}
      </section>`;
    return;
  }

  const f = R.form || { part: S.q || "", make: S.car.make, model: S.car.model, year: S.car.year, engine: S.car.engine, note: "" };
  const email = auth.user.email || "";
  v.innerHTML = head + `
    <div class="acct"><span class="acct-ico">${esc((email[0] || "?").toUpperCase())}</span><div style="min-width:0;overflow:hidden;text-overflow:ellipsis"><b>Mi cuenta</b><div class="muted" style="font-size:12px">${esc(email)}</div></div><button class="btn-link" data-p-logout>Cerrar sesión</button></div>
    <form class="panel" id="req-form" novalidate>
      <label class="fl">Repuesto que necesitas<input type="text" id="r-part" maxlength="120" placeholder="Ej: Bomba de agua" value="${esc(f.part)}"></label>
      <div class="grid3">
        <select id="r-make" aria-label="Marca">${makeOptions(f.make)}</select>
        <select id="r-model" aria-label="Modelo">${modelOptions(f.make, f.model)}</select>
        <select id="r-year" aria-label="Año">${yearOptions(f.year)}</select>
      </div>
      <select id="r-engine" aria-label="Motor">${engineOptions(f.make, f.model, f.engine)}</select>
      <label class="fl">Detalles (opcional)<textarea id="r-note" maxlength="500" placeholder="Ej: original o genérico, lado del conductor, cantidad">${esc(f.note)}</textarea></label>
      <div class="form-msg" id="req-msg" role="status" hidden></div>
      <button class="btn btn-signal" type="submit" ${R.sending ? "disabled" : ""}>${R.sending ? "Enviando…" : "Enviar pedido a las tiendas"}</button>
    </form>
    <div class="list" id="req-list"><div class="loading">Cargando tus pedidos…</div></div>`;

  if (!R.list) {
    try { await loadMine(); } catch (e) { console.error(e); const el = $("#req-list"); if (el) el.innerHTML = `<div class="empty-state">No pudimos cargar tus pedidos. Revisa tu conexión.<br><button class="btn btn-ghost btn-sm" data-p-reload>Reintentar</button></div>`; return; }
  } else { renderList(); try { await loadMine(); } catch {} }
  renderList();

  // Mientras la pestaña está abierta, busca respuestas nuevas cada 30 segundos
  timer = setInterval(async () => {
    if (S.tab !== "pedir" || !auth.user || document.hidden) return;
    const before = totalResponses(R.list || []);
    try { await loadMine(); } catch { return; }
    if (totalResponses(R.list) > before) { renderList(); toast("Una tienda respondió tu pedido"); }
  }, 30000);
}

function respHTML(r, x) {
  const st = storeById(x.store_id);
  const name = st ? st.name : "Tienda";
  const dist = st ? ` <span class="dist">· ${kmText(distanceKm(here(), st))}</span>` : "";
  const no = isNo(x);
  const wa = st && !no && r.status === "open"
    ? `<a class="btn btn-wa btn-sm resp-wa" target="_blank" rel="noopener" data-p-wa="${st.id}" href="${esc(waLink(st.whatsapp, `Hola, pedí en Tu Repuesto: ${r.part} para ${vehOf(r)}. Me respondieron ${x.price_text}.`))}">Continuar por WhatsApp</a>`
    : "";
  return `<div class="resp"><span><b>${esc(name)}</b>${dist}</span><span class="p" ${no ? 'style="color:var(--muted);font-weight:500"' : ""}>${esc(x.price_text)}</span>${x.note ? `<span class="note">${esc(x.note)}</span>` : ""}${wa}</div>`;
}

function renderList() {
  const el = $("#req-list");
  if (!el) return;
  const list = R.list || [];
  if (!list.length) { el.innerHTML = `<div class="empty-state">Aquí verás las respuestas de las tiendas a tus pedidos.</div>`; return; }
  el.innerHTML = `<div class="toolbar"><div class="eyebrow">Mis pedidos</div><span class="muted" style="font-size:12px">Guardados en tu cuenta</span></div>` + list.map((r) => {
    const n = r.responses.length;
    const closed = r.status !== "open";
    const old = Date.now() - new Date(r.created_at).getTime() > 7 * 86400000;
    return `
    <div class="req" ${closed ? 'style="opacity:.75"' : ""}>
      <div class="req-head">
        <div class="toolbar"><span class="t">${esc(r.part)}</span><span class="muted" style="font-size:12px">${ago(r.created_at)} · ${n} respuesta${n === 1 ? "" : "s"}</span></div>
        <span class="muted" style="font-size:13px">${esc(vehOf(r))}${r.note ? ` · ${esc(r.note)}` : ""}</span>
      </div>
      ${r.responses.map((x) => respHTML(r, x)).join("")}
      ${closed
        ? `<div class="waiting">Pedido cerrado</div>`
        : old
          ? `<div class="waiting">Este pedido ya no se muestra a las tiendas (pasaron 7 días).<button class="btn-link" data-p-close="${r.id}" style="margin-left:auto">Cerrar</button></div>`
          : `<div class="waiting">${n ? "" : `<span class="dots"><span></span><span></span><span></span></span>Esperando respuestas de las tiendas`}<button class="btn-link" data-p-close="${r.id}" style="margin-left:auto">Ya lo conseguí</button></div>`}
    </div>`;
  }).join("");
}

function syncForm() {
  if (!$("#req-form")) return;
  R.form = { part: $("#r-part").value, make: $("#r-make").value, model: $("#r-model").value, year: $("#r-year").value, engine: $("#r-engine").value, note: $("#r-note").value };
}

function showMsg(text) { const m = $("#req-msg"); if (m) { m.hidden = false; m.className = "form-msg"; m.textContent = text; } }

async function submitRequest() {
  syncForm();
  const f = R.form;
  const part = f.part.trim();
  if (part.length < 2) return showMsg("Escribe qué repuesto necesitas.");
  if (!f.make) return showMsg("Elige la marca de tu carro para que las tiendas sepan qué buscar.");
  const open = (R.list || []).filter((r) => r.status === "open" && Date.now() - new Date(r.created_at).getTime() < 7 * 86400000).length;
  if (open >= MAX_OPEN) return showMsg(`Ya tienes ${MAX_OPEN} pedidos abiertos. Cierra alguno con "Ya lo conseguí" antes de pedir otro.`);
  R.sending = true; renderPedir();
  const { data, error } = await db.from("part_requests").insert({
    part, make: f.make || null, model: f.model || null, year: f.year ? +f.year : null, engine: f.engine || null, note: f.note.trim() || null,
  }).select("id, part, make, model, year, engine, note, status, created_at").single();
  R.sending = false;
  if (error) { console.error(error); await renderPedir(); return showMsg("No pudimos enviar tu pedido. Revisa tu conexión e inténtalo de nuevo."); }
  R.list = [{ ...data, responses: [] }, ...(R.list || [])];
  R.form = { ...f, part: "", note: "" };
  await renderPedir();
  toast("Pedido enviado a las tiendas");
}

export function bindPedir() {
  // Llegó una respuesta en vivo: si estoy mirando Mis pedidos, la muestro de una vez
  window.addEventListener("tr:response", async () => {
    if (S.tab !== "pedir" || !auth.user) return;
    try { await loadMine(); renderList(); } catch {}
  });
  document.addEventListener("submit", (e) => { if (e.target.id === "req-form") { e.preventDefault(); if (!R.sending) submitRequest(); } });
  document.addEventListener("change", (e) => {
    const id = e.target.id;
    if (id === "r-make" || id === "r-model") {
      syncForm();
      if (id === "r-make") { R.form.model = ""; R.form.engine = ""; } else R.form.engine = "";
      $("#r-model").innerHTML = modelOptions(R.form.make, R.form.model);
      $("#r-engine").innerHTML = engineOptions(R.form.make, R.form.model, R.form.engine);
    }
  });
  document.addEventListener("click", async (e) => {
    const t = e.target;
    if (t.closest("[data-p-logout]")) { clearInterval(timer); await signOut(); resetPedir(); setDot("pedir", false); renderPedir(); toast("Cerraste sesión."); return; }
    if (t.closest("[data-p-reload]")) { R.list = null; renderPedir(); return; }
    const c = t.closest("[data-p-close]");
    if (c) {
      const id = +c.dataset.pClose;
      c.disabled = true;
      const { error } = await db.from("part_requests").update({ status: "closed" }).eq("id", id);
      if (error) { c.disabled = false; return toast("No pudimos cerrar el pedido. Inténtalo de nuevo."); }
      const r = R.list.find((x) => x.id === id); if (r) r.status = "closed";
      renderList(); toast("Pedido cerrado. ¡Qué bueno que lo conseguiste!");
      return;
    }
    const w = t.closest("[data-p-wa]");
    if (w) db.from("contact_events").insert({ store_id: +w.dataset.pWa }).then(() => {}, () => {});
  });
}
