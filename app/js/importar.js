import { db } from "./db.js";
import { S } from "./state.js";
import { $, esc, norm, toast } from "./util.js";
import { CAT_LABEL } from "./categorias.js";

// ---------- Cargar y actualizar repuestos desde Excel ----------
// La tienda descarga la plantilla (o sus repuestos actuales), la llena y la sube.
// Las filas con el mismo nombre y moneda se agrupan como versiones de un repuesto.
// Si el repuesto ya existe, sus versiones se reemplazan por las del archivo (así se actualizan precios).

const XLSX_URLS = [
  "https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js",
  "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js",
];
let xlsxP = null;
function loadXLSX() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  return (xlsxP ||= (async () => {
    for (const src of XLSX_URLS) {
      const ok = await new Promise((res) => {
        const s = document.createElement("script");
        s.src = src; s.onload = () => res(true); s.onerror = () => { s.remove(); res(false); };
        document.head.appendChild(s);
      });
      if (ok && window.XLSX) return window.XLSX;
    }
    xlsxP = null;
    throw new Error("No se pudo cargar el lector de Excel");
  })());
}

// Columnas de la plantilla y otros nombres con que pueden venir en el Excel de la tienda
const COLS = [
  ["name", "Repuesto", ["repuesto", "nombre", "producto", "descripcion", "articulo", "nombre del repuesto", "nombre del producto"]],
  ["cat", "Categoría", ["categoria", "tipo", "grupo", "linea", "rubro"]],
  ["cur", "Moneda", ["moneda", "divisa"]],
  ["make", "Marca del carro", ["marca del carro", "marca carro", "marca del vehiculo", "marca vehiculo", "marca"]],
  ["model", "Modelo", ["modelo", "modelo del carro", "modelo del vehiculo", "modelo vehiculo"]],
  ["from", "Año desde", ["ano desde", "desde", "ano", "anos", "ano inicial", "año"]],
  ["to", "Año hasta", ["ano hasta", "hasta", "ano final"]],
  ["eng", "Motor", ["motor", "cilindrada"]],
  ["pbrand", "Marca del repuesto", ["marca del repuesto", "marca repuesto", "marca de la pieza", "fabricante"]],
  ["pn", "Código", ["codigo", "referencia", "ref", "numero de parte", "nro de parte", "part number", "sku"]],
  ["cond", "Estado", ["estado", "condicion", "nuevo o usado", "nuevo/usado"]],
  ["price", "Precio", ["precio", "precio de venta", "precio venta", "pvp", "valor"]],
  ["stock", "Disponible", ["disponible", "existencia", "stock", "cantidad", "hay"]],
];

const CUR_LABEL = { USD: "Dólares", COP: "Pesos", VES: "Bolívares" };

// Si no ponen categoría, la adivinamos por el nombre
const CAT_GUESS = [
  ["filtros", ["filtro"]],
  ["frenos", ["freno", "pastilla", "banda", "disco", "tambor", "zapata", "caliper", "mordaza", "abs"]],
  ["encendido", ["bujia", "bobina", "cable de bujia", "distribuidor"]],
  ["refrigeracion", ["radiador", "bomba de agua", "termostato", "electroventilador", "ventilador", "manguera", "envase de refrigerante", "tapa de radiador"]],
  ["electrico", ["bateria", "alternador", "arranque", "motor de arranque", "bombillo", "faro", "sensor", "relay", "rele", "fusible", "switch", "regulador"]],
  ["suspension", ["amortiguador", "rotula", "terminal", "meseta", "buje", "cremallera", "bomba de direccion", "espiral", "resorte", "barra", "muñon", "munon", "base de amortiguador"]],
  ["transmision", ["clutch", "croche", "embrague", "caja", "tripoide", "homocinetica", "punta de eje", "collarin", "volante", "kit de embrague", "cardan"]],
];
function guessCat(name) {
  const n = norm(name);
  for (const [cat, words] of CAT_GUESS) if (words.some((w) => n.includes(norm(w)))) return cat;
  return "motor";
}
const CAT_BY_TEXT = (() => {
  const m = {};
  for (const [k, label] of Object.entries(CAT_LABEL)) { m[norm(k)] = k; m[norm(label)] = k; }
  m["suspension"] = "suspension"; m["direccion"] = "suspension"; m["electricidad"] = "electrico"; m["enfriamiento"] = "refrigeracion"; m["embrague"] = "transmision";
  return m;
})();

function parseCur(v, def) {
  const n = norm(v);
  if (!n) return def;
  if (["usd", "$", "us$", "dolar", "dolares", "dólares"].includes(n) || n.startsWith("dolar")) return "USD";
  if (["cop", "peso", "pesos", "col$", "cop$"].includes(n) || n.startsWith("peso")) return "COP";
  if (["bs", "bs.", "ves", "bss", "bolivar", "bolivares", "bs.s", "bs.d"].includes(n) || n.startsWith("boliv")) return "VES";
  return null;
}
function parsePrice(v) {
  if (typeof v === "number") return v;
  let t = String(v ?? "").trim().replace(/[^\d.,]/g, "");
  if (!t) return NaN;
  if (t.includes(",") && t.includes(".")) t = t.lastIndexOf(",") > t.lastIndexOf(".") ? t.replace(/\./g, "").replace(",", ".") : t.replace(/,/g, "");
  else if (t.includes(",")) t = /^\d{1,3}(,\d{3})+$/.test(t) ? t.replace(/,/g, "") : t.replace(",", ".");
  else if (/^\d{1,3}(\.\d{3})+$/.test(t)) t = t.replace(/\./g, "");
  return parseFloat(t);
}
function year(v) {
  if (v === "" || v == null) return null;
  let y = parseInt(String(v).trim(), 10);
  if (Number.isNaN(y)) return NaN;
  if (y < 100) y += y < 50 ? 2000 : 1900;
  return y;
}
function parseStock(v) {
  if (v === "" || v == null) return true;
  if (typeof v === "number") return v > 0;
  const n = norm(v);
  if (["no", "agotado", "0", "n", "false", "falso"].includes(n)) return false;
  if (/^\d+$/.test(n)) return +n > 0;
  return true;
}
function parseEngine(v) {
  const n = norm(v).replace(",", ".").replace(/\s*(l|lts|litros|cc)$/, "").trim();
  if (!n || ["todos", "todo", "-", "cualquiera", "n/a"].includes(n)) return null;
  return n.toUpperCase().replace(/^(\d)\.(\d)$/, "$1.$2");
}
function catalogIndex() {
  const makes = {};
  for (const [make, models] of Object.entries(S.catalog)) {
    const mm = {};
    for (const model of Object.keys(models)) { mm[norm(model)] = model; mm[norm(model).replace(/[\s-]/g, "")] = model; }
    makes[norm(make)] = { make, models: mm };
  }
  // Nombres comunes de marcas
  const alias = { chevy: "chevrolet", vw: "volkswagen", "mercedes benz": "mercedes-benz", mercedes: "mercedes-benz" };
  for (const [a, real] of Object.entries(alias)) if (makes[real] && !makes[a]) makes[a] = makes[real];
  return makes;
}

// ---------- Estado ----------
const IMP = { cur: "USD", busy: false, progress: "", plan: null, fileName: "" };
export function resetImport() { Object.assign(IMP, { busy: false, progress: "", plan: null, fileName: "" }); }

// ---------- Leer el archivo ----------
function mapHeaders(headers) {
  const idx = {};
  const used = new Set();
  // primero coincidencias exactas con el nombre de la plantilla, luego los otros nombres
  for (const [key, label, aliases] of COLS) {
    const want = [norm(label), ...aliases.map(norm)];
    const i = headers.findIndex((h, j) => !used.has(j) && want.includes(norm(h)));
    if (i >= 0) { idx[key] = i; used.add(i); }
  }
  return idx;
}

export function analyze(rows, ctx) {
  // rows: arreglo de arreglos (primera fila = títulos)
  const headerAt = rows.findIndex((r) => r.some((c) => String(c).trim()));
  if (headerAt < 0) return { fatal: "El archivo está vacío." };
  const idx = mapHeaders(rows[headerAt].map((h) => String(h ?? "")));
  const missing = ["name", "make", "model", "price"].filter((k) => idx[k] == null);
  if (missing.length) {
    const names = missing.map((k) => COLS.find((c) => c[0] === k)[1]);
    return { fatal: `No encontramos estas columnas: ${names.join(", ")}. Usa la plantilla o cambia los títulos de tu Excel.` };
  }
  const cat = catalogIndex();
  const get = (r, k) => (idx[k] == null ? "" : r[idx[k]] ?? "");
  const errors = [];
  const groups = new Map();
  let lines = 0;
  for (let i = headerAt + 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || !r.some((c) => String(c ?? "").trim())) continue;
    lines++;
    const line = i + 1;
    const err = (m) => errors.push({ line, msg: m });
    const name = String(get(r, "name")).trim().replace(/\s+/g, " ");
    if (name.length < 2) { err("Falta el nombre del repuesto."); continue; }
    if (name.length > 120) { err("El nombre es muy largo (máximo 120 letras)."); continue; }
    const mk = cat[norm(get(r, "make"))];
    if (!mk) { err(String(get(r, "make")).trim() ? `La marca "${String(get(r, "make")).trim()}" no está en la lista de carros.` : "Falta la marca del carro."); continue; }
    const rawModel = norm(get(r, "model"));
    const model = mk.models[rawModel] || mk.models[rawModel.replace(/[\s-]/g, "")];
    if (!model) { err(rawModel ? `El modelo "${String(get(r, "model")).trim()}" de ${mk.make} no está en la lista de carros.` : "Falta el modelo del carro."); continue; }
    // Años: "2008", o "2008-2012" en una sola columna
    let yf = get(r, "from"), yt = get(r, "to");
    const both = String(yf).match(/^\s*(\d{2,4})\s*(?:-|–|al|a|\/)\s*(\d{2,4})\s*$/i);
    if (both) { yf = both[1]; yt = both[2]; }
    let from = year(yf), to = year(yt);
    if (from == null && to == null) { err("Falta el año."); continue; }
    if (from == null) from = to;
    if (to == null) to = from;
    if (Number.isNaN(from) || Number.isNaN(to) || from < 1950 || to > 2100 || from > 2100 || to < 1950) { err("El año no es válido."); continue; }
    if (to < from) [from, to] = [to, from];
    const price = parsePrice(get(r, "price"));
    if (Number.isNaN(price) || price < 0) { err("El precio no es válido."); continue; }
    const cur = parseCur(get(r, "cur"), IMP.cur);
    if (!cur) { err(`La moneda "${get(r, "cur")}" no se reconoce. Usa $, COP o Bs.`); continue; }
    const condTxt = norm(get(r, "cond"));
    const condition = condTxt.startsWith("usad") ? "usado" : "nuevo";
    const catTxt = norm(get(r, "cat"));
    const category = CAT_BY_TEXT[catTxt] || guessCat(name);
    const key = norm(name) + "|" + cur;
    if (!groups.has(key)) groups.set(key, { name, category, currency: cur, versions: [] });
    groups.get(key).versions.push({
      make: mk.make, model, year_from: from, year_to: to, engine: parseEngine(get(r, "eng")),
      part_brand: String(get(r, "pbrand")).trim().slice(0, 60) || null,
      part_number: String(get(r, "pn")).trim().slice(0, 60) || null,
      condition, price: Math.round(price * 100) / 100, in_stock: parseStock(get(r, "stock")),
    });
  }
  const existing = new Map(ctx.products().map((p) => [norm(p.name) + "|" + p.currency, p]));
  const updates = [], news = [];
  for (const [key, g] of groups) (existing.has(key) ? updates.push({ ...g, id: existing.get(key).id }) : news.push(g));
  const room = ctx.room();
  const skipped = Number.isFinite(room) ? Math.max(0, news.length - room) : 0;
  return { lines, errors, updates, news: skipped ? news.slice(0, Math.max(0, room)) : news, skipped, versions: [...updates, ...news].reduce((n, g) => n + g.versions.length, 0) };
}

async function readFile(file) {
  const XLSX = await loadXLSX();
  let wb;
  if (/\.(csv|txt)$/i.test(file.name)) {
    // CSV: puede venir en UTF-8 o en el formato viejo de Excel en español (Windows-1252)
    const buf = await file.arrayBuffer();
    let text = new TextDecoder("utf-8").decode(buf);
    if (text.includes("\uFFFD")) text = new TextDecoder("windows-1252").decode(buf);
    wb = XLSX.read(text.replace(/^\uFEFF/, ""), { type: "string" });
  } else {
    wb = XLSX.read(await file.arrayBuffer(), { type: "array" });
  }
  // Usa la hoja "Repuestos" si existe; si no, la primera
  const name = wb.SheetNames.find((n) => norm(n) === "repuestos") || wb.SheetNames[0];
  return XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: "", raw: true });
}

// ---------- Plantilla y descarga de mis repuestos ----------
const HEAD = COLS.map((c) => c[1]);
function versionRow(p, v) {
  return [p.name, CAT_LABEL[p.category] || p.category, p.currency === "USD" ? "$" : p.currency === "VES" ? "Bs" : "COP",
    v.make, v.model, v.year_from, v.year_to, v.engine || "", v.part_brand || "", v.part_number || "",
    v.condition === "usado" ? "Usado" : "Nuevo", Number(v.price), v.in_stock ? "Sí" : "No"];
}
function sheetWithWidths(XLSX, aoa) {
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws["!cols"] = [28, 14, 9, 16, 14, 10, 10, 9, 18, 14, 9, 10, 11].map((w) => ({ wch: w }));
  return ws;
}
function helpSheet(XLSX) {
  const aoa = [
    ["Cómo llenar la hoja Repuestos"],
    [],
    ["Cada fila es un repuesto para un carro. Si el mismo repuesto sirve para varios carros, escribe una fila por cada carro con el mismo nombre: la app los junta como versiones."],
    ["Obligatorio: Repuesto, Marca del carro, Modelo, Año desde y Precio. Lo demás es opcional."],
    ["Año hasta: si lo dejas vacío, se usa el mismo año. También puedes escribir 2008-2012 en Año desde."],
    ["Motor: déjalo vacío si sirve para todos los motores de ese modelo."],
    ["Moneda: $, COP o Bs. Si la dejas vacía, se usa la que elijas en la app al subir el archivo."],
    ["Estado: Nuevo o Usado (si lo dejas vacío, es Nuevo). Disponible: Sí o No (si lo dejas vacío, es Sí)."],
    ["Categoría: " + Object.values(CAT_LABEL).join(", ") + ". Si la dejas vacía, la app la adivina por el nombre."],
    ["Para actualizar precios: en la app toca \"Descargar mis repuestos\", cambia los precios y vuelve a subir el archivo."],
    ["Las marcas y modelos deben estar escritos como en la hoja Carros."],
  ];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws["!cols"] = [{ wch: 120 }];
  return ws;
}
function carsSheet(XLSX) {
  const aoa = [["Marca del carro", "Modelo", "Motores"]];
  for (const [make, models] of Object.entries(S.catalog)) for (const [model, engines] of Object.entries(models)) aoa.push([make, model, (engines || []).join(", ")]);
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws["!cols"] = [{ wch: 18 }, { wch: 18 }, { wch: 24 }];
  return ws;
}
async function download(kind, ctx) {
  let XLSX;
  try { XLSX = await loadXLSX(); } catch { return toast("No se pudo preparar el Excel. Revisa tu conexión."); }
  const wb = XLSX.utils.book_new();
  let rows;
  if (kind === "mine") {
    rows = [HEAD];
    for (const p of ctx.products()) for (const v of p.versions) rows.push(versionRow(p, v));
  } else {
    rows = [HEAD,
      ["Pastillas de freno delanteras", "Frenos", "$", "Toyota", "Corolla", 2009, 2014, "", "Bosch", "0986AB1234", "Nuevo", 28, "Sí"],
      ["Pastillas de freno delanteras", "Frenos", "$", "Toyota", "Yaris", 2006, 2012, "", "Bosch", "0986AB5678", "Nuevo", 25, "Sí"],
      ["Bomba de agua", "", "Bs", "Chevrolet", "Aveo", 2005, 2012, "1.6", "", "", "Usado", 900, ""],
    ];
  }
  XLSX.utils.book_append_sheet(wb, sheetWithWidths(XLSX, rows), "Repuestos");
  XLSX.utils.book_append_sheet(wb, helpSheet(XLSX), "Instrucciones");
  XLSX.utils.book_append_sheet(wb, carsSheet(XLSX), "Carros");
  const store = norm(ctx.store().name).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  XLSX.writeFile(wb, kind === "mine" ? `repuestos-${store}.xlsx` : "plantilla-tu-repuesto.xlsx");
}

// ---------- Guardar ----------
const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

async function save(ctx) {
  const plan = IMP.plan, store = ctx.store();
  IMP.busy = true;
  const step = (t) => { IMP.progress = t; const el = $("#imp-progress"); if (el) el.textContent = t; };
  try {
    let done = 0;
    const total = plan.updates.length + plan.news.length;
    // 1) Repuestos que ya existían: se reemplazan sus versiones
    for (const part of chunk(plan.updates, 50)) {
      const ids = part.map((g) => g.id);
      let r = await db.from("product_versions").delete().in("product_id", ids);
      if (r.error) throw r.error;
      r = await db.from("product_versions").insert(part.flatMap((g) => g.versions.map((v) => ({ ...v, product_id: g.id }))));
      if (r.error) throw r.error;
      await Promise.all(part.map((g) => db.from("products").update({ category: g.category }).eq("id", g.id)));
      done += part.length; step(`Guardando… ${done} de ${total}`);
    }
    // 2) Repuestos nuevos
    for (const part of chunk(plan.news, 50)) {
      const { data, error } = await db.from("products")
        .insert(part.map((g) => ({ store_id: store.id, name: g.name, category: g.category, currency: g.currency })))
        .select("id, name, currency");
      if (error) throw error;
      const idOf = new Map(data.map((p) => [norm(p.name) + "|" + p.currency, p.id]));
      const vers = part.flatMap((g) => g.versions.map((v) => ({ ...v, product_id: idOf.get(norm(g.name) + "|" + g.currency) })));
      for (const vp of chunk(vers, 500)) { const r = await db.from("product_versions").insert(vp); if (r.error) throw r.error; }
      done += part.length; step(`Guardando… ${done} de ${total}`);
    }
    toast(`Listo: ${plan.news.length} nuevos y ${plan.updates.length} actualizados.`);
    resetImport();
    await ctx.done();
  } catch (e) {
    console.error(e);
    const lim = /LIMITE_PLAN/.test(e?.message || "");
    IMP.busy = false;
    IMP.plan = { fatal: lim ? "Llegaste al máximo de repuestos de tu plan. Lo que alcanzó a guardarse quedó guardado." : "Hubo un problema al guardar (revisa tu conexión). Lo que alcanzó a guardarse quedó guardado: puedes volver a subir el mismo archivo y no se duplica nada." };
    await ctx.done();
  }
}

// ---------- Pantalla ----------
export function importPanelHTML(ctx) {
  const n = ctx.products().length;
  const p = IMP.plan;
  let preview = "";
  if (IMP.busy) {
    preview = `<div class="admin-bar" id="imp-progress">${esc(IMP.progress || "Guardando…")}</div>`;
  } else if (p?.fatal) {
    preview = `<div class="form-msg">${esc(p.fatal)}</div>`;
  } else if (p) {
    const nV = p.versions;
    preview = `
      <div class="imp-sum">
        <b>${esc(IMP.fileName)}</b>
        <span>${p.lines} fila${p.lines === 1 ? "" : "s"} leída${p.lines === 1 ? "" : "s"}</span>
        ${p.news.length ? `<span class="b-ok badge">${p.news.length} repuestos nuevos</span>` : ""}
        ${p.updates.length ? `<span class="b-best badge">${p.updates.length} se actualizan</span>` : ""}
        ${p.errors.length ? `<span class="b-out badge">${p.errors.length} filas con error</span>` : ""}
        <span class="muted">${nV} versi${nV === 1 ? "ón" : "ones"} en total</span>
      </div>
      ${p.skipped ? `<div class="locked"><b>${p.skipped} repuestos nuevos no caben en tu plan.</b><span>Se guardarán solo los primeros ${p.news.length}. Pide un plan mayor para cargar el resto.</span></div>` : ""}
      ${p.updates.length ? `<p class="muted" style="margin:0;font-size:12.5px">Los que se actualizan ya estaban publicados con el mismo nombre: sus versiones y precios se cambian por los del archivo.</p>` : ""}
      ${p.errors.length ? `<details ${p.news.length + p.updates.length ? "" : "open"}><summary style="cursor:pointer;font-size:13px">Ver filas con error (no se cargan)</summary>
        <ul class="imp-err">${p.errors.slice(0, 100).map((e) => `<li><b>Fila ${e.line}:</b> ${esc(e.msg)}</li>`).join("")}${p.errors.length > 100 ? `<li>…y ${p.errors.length - 100} más</li>` : ""}</ul>
        ${p.errors.some((e) => /lista de carros/.test(e.msg)) ? `<p class="muted" style="margin:6px 0 0;font-size:12.5px">¿Falta un carro en la lista? Escríbenos y lo agregamos; luego vuelve a subir el archivo.</p>` : ""}</details>` : ""}
      <div class="btn-row">
        ${p.news.length + p.updates.length ? `<button class="btn btn-signal" data-imp-save>Guardar ${p.news.length + p.updates.length} repuesto${p.news.length + p.updates.length === 1 ? "" : "s"}</button>` : ""}
        <button class="btn btn-ghost" data-imp-cancel>Cancelar</button>
      </div>`;
  }
  return `<section class="panel" id="imp-panel">
    <h2 style="font-size:19px">Cargar desde Excel</h2>
    <p class="muted" style="margin:0;font-size:13.5px">Para subir muchos repuestos de una vez o actualizar precios. Descarga la plantilla, llénala (o copia ahí tu inventario) y súbela.</p>
    <div class="btn-row">
      <button class="btn btn-ghost btn-sm" data-imp-tpl>Descargar plantilla</button>
      ${n ? `<button class="btn btn-ghost btn-sm" data-imp-mine>Descargar mis repuestos</button>` : ""}
    </div>
    ${p || IMP.busy ? "" : `
    <div class="grid2" style="align-items:end">
      <label class="fl">Moneda si no la indica<select id="imp-cur">${Object.entries(CUR_LABEL).map(([k, l]) => `<option value="${k}" ${IMP.cur === k ? "selected" : ""}>${l}</option>`).join("")}</select></label>
      <label class="btn btn-primary" style="cursor:pointer">Subir Excel<input type="file" id="imp-file" accept=".xlsx,.xls,.csv,.ods" hidden></label>
    </div>`}
    <div id="imp-preview" style="display:flex;flex-direction:column;gap:10px">${preview}</div>
  </section>`;
}

function rerender() {
  const el = $("#imp-panel");
  if (el && IMP.ctx) el.outerHTML = importPanelHTML(IMP.ctx);
}

export function bindImport(ctx) {
  IMP.ctx = ctx;
  document.addEventListener("change", async (e) => {
    if (e.target.id === "imp-cur") { IMP.cur = e.target.value; return; }
    if (e.target.id !== "imp-file") return;
    const f = e.target.files[0];
    if (!f) return;
    IMP.fileName = f.name;
    IMP.busy = true; IMP.progress = "Leyendo el archivo…"; rerender();
    try {
      const rows = await readFile(f);
      IMP.plan = analyze(rows, ctx);
    } catch (err) {
      console.error(err);
      IMP.plan = { fatal: /lector/.test(err.message) ? "No se pudo cargar el lector de Excel. Revisa tu conexión e inténtalo de nuevo." : "No pudimos leer ese archivo. Guárdalo como Excel (.xlsx) o CSV e inténtalo de nuevo." };
    }
    IMP.busy = false; rerender();
    $("#imp-panel")?.scrollIntoView({ behavior: "smooth", block: "start" });
  });
  document.addEventListener("click", async (e) => {
    const t = e.target;
    if (t.closest("[data-imp-tpl]")) return download("tpl", ctx);
    if (t.closest("[data-imp-mine]")) return download("mine", ctx);
    if (t.closest("[data-imp-cancel]")) { resetImport(); rerender(); return; }
    if (t.closest("[data-imp-save]") && !IMP.busy) { IMP.busy = true; IMP.progress = "Guardando…"; rerender(); await save(ctx); }
  });
}
