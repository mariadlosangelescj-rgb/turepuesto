import { db } from "./db.js";
import { S } from "./state.js";
import { auth } from "./auth.js";
import { toast, store } from "./util.js";

// Avisos dentro de la app: puntito en la pestaña y mensaje cuando
// una tienda responde (cliente) o cuando llega un pedido nuevo (tienda).
const N = { channel: null, myStore: null, timer: null };
const ORDER_PLANS = ["trial", "estandar", "plus"];
const WEEK = 7 * 86400000;

export function setDot(tab, on) {
  const b = document.querySelector(`.tabs [data-tab="${tab}"]`);
  if (!b) return;
  let d = b.querySelector(".tab-dot");
  if (!d) { d = document.createElement("span"); d.className = "tab-dot"; b.appendChild(d); }
  d.hidden = !on;
}

function storeGetsOrders(s) {
  if (!s || s.status !== "active") return false;
  if (s.plan === "trial" && s.trial_ends_at && new Date(s.trial_ends_at) < new Date()) return false;
  return ORDER_PLANS.includes(s.plan);
}

// La tienda abrió su panel: los pedidos que hay ya los vio
export function markRequestsSeen() {
  if (!auth.user) return;
  store.set("seenReq:" + auth.user.id, new Date().toISOString());
  setDot("tienda", false);
}

export async function checkAll() {
  if (!auth.user) { setDot("pedir", false); setDot("tienda", false); return; }
  const uid = auth.user.id;
  if (S.tab !== "pedir") {
    const { data } = await db.from("part_requests").select("request_responses(id)").eq("buyer_id", uid).limit(30);
    if (data) setDot("pedir", data.reduce((n, r) => n + (r.request_responses?.length || 0), 0) > store.get("seen:" + uid, 0));
  }
  if (storeGetsOrders(N.myStore) && S.tab !== "tienda") {
    const seen = store.get("seenReq:" + uid, null);
    const since = new Date(Math.max(Date.now() - WEEK, seen ? new Date(seen).getTime() : 0)).toISOString();
    const { data } = await db.from("part_requests").select("id, buyer_id, request_responses(store_id)")
      .eq("status", "open").gt("created_at", since).limit(40);
    if (data) setDot("tienda", data.some((r) => r.buyer_id !== uid && !(r.request_responses || []).some((x) => x.store_id === N.myStore.id)));
  }
}

function onResponse(row) {
  if (N.myStore && row.store_id === N.myStore.id) return; // es la respuesta que yo mismo envié como tienda
  toast("Una tienda respondió tu pedido");
  if (S.tab !== "pedir") setDot("pedir", true);
  window.dispatchEvent(new Event("tr:response"));
}

function onRequest(row) {
  if (row.buyer_id === auth.user?.id) return;
  toast("Nuevo pedido de un cliente");
  if (S.tab !== "tienda") setDot("tienda", true);
  window.dispatchEvent(new Event("tr:request"));
}

// Se llama al abrir la app y cada vez que alguien entra o sale de su cuenta
export async function startNotify() {
  if (N.channel) { db.removeChannel(N.channel); N.channel = null; }
  N.myStore = null;
  if (auth.user) {
    const { data } = await db.from("stores").select("id, status, plan, trial_ends_at").eq("owner_id", auth.user.id).maybeSingle();
    N.myStore = data || null;
    try {
      let ch = db.channel("avisos-" + auth.user.id)
        .on("postgres_changes", { event: "INSERT", schema: "public", table: "request_responses" }, (p) => onResponse(p.new));
      if (storeGetsOrders(N.myStore)) ch = ch.on("postgres_changes", { event: "INSERT", schema: "public", table: "part_requests" }, (p) => onRequest(p.new));
      N.channel = ch.subscribe();
    } catch (e) { console.error(e); }
  }
  await checkAll();
  if (!N.timer) {
    // Respaldo por si se corta la conexión en vivo
    N.timer = setInterval(() => { if (!document.hidden) checkAll(); }, 60000);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) checkAll(); });
  }
}
