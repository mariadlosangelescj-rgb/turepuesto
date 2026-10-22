// Función "avisar" de Tu Repuesto (Supabase Edge Function).
// La base de datos la llama cuando se crea un pedido o una respuesta,
// y esta función manda la notificación al celular de quien corresponda.
//
// Necesita estos secretos en Supabase (Edge Functions → Secrets):
//   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, AVISO_SECRET
// SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY ya vienen incluidos.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

// ---------- Web Push (RFC 8291 y RFC 8292) con WebCrypto ----------
const te = new TextEncoder();
const b64u = (buf) => {
  let s = "";
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const unb64u = (s) => {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  s += "=".repeat((4 - (s.length % 4)) % 4);
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
};
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) { out.set(p, i); i += p.length; }
  return out;
};
async function hkdf(salt, ikm, info, len) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, len * 8));
}

// Cifra el mensaje para un navegador (aes128gcm). `fixed` solo se usa en pruebas.
export async function encryptPayload(text, p256dhB64, authB64, fixed) {
  const uaPublic = unb64u(p256dhB64), authSecret = unb64u(authB64);
  const asKeys = fixed?.keys || await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", asKeys.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, asKeys.privateKey, 256));
  const ikm = await hkdf(authSecret, shared, concat(te.encode("WebPush: info\0"), uaPublic, asPublic), 32);
  const salt = fixed?.salt || crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, te.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, te.encode("Content-Encoding: nonce\0"), 12);
  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aes, concat(te.encode(text), new Uint8Array([2]))));
  const header = new Uint8Array(21);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = asPublic.length;
  return concat(header, asPublic, cipher);
}

// Firma VAPID: identifica a Tu Repuesto ante el servicio de notificaciones
export async function vapidHeader(endpoint, publicB64, privateB64) {
  const pub = unb64u(publicB64);
  const jwk = { kty: "EC", crv: "P-256", d: privateB64, x: b64u(pub.slice(1, 33)), y: b64u(pub.slice(33, 65)), ext: true };
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const head = b64u(te.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const body = b64u(te.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: "https://turepuesto.pages.dev" })));
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, te.encode(`${head}.${body}`));
  return `vapid t=${head}.${body}.${b64u(sig)}, k=${publicB64}`;
}

async function sendPush(sub, message) {
  const body = await encryptPayload(JSON.stringify(message), sub.p256dh, sub.auth);
  const res = await fetch(sub.endpoint, {
    method: "POST",
    headers: {
      Authorization: await vapidHeader(sub.endpoint, Deno.env.get("VAPID_PUBLIC_KEY"), Deno.env.get("VAPID_PRIVATE_KEY")),
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: "86400",
      Urgency: "high",
    },
    body,
  });
  return res.status;
}

// ---------- Quién recibe qué ----------
const ORDER_PLANS = ["trial", "estandar", "plus"];
const vehOf = (r) => [r.make, r.model, r.year].filter(Boolean).join(" ");

export async function handle(db, table, record) {
  let users = [], msg = null;
  if (table === "request_responses") {
    const [{ data: req }, { data: st }] = await Promise.all([
      db.from("part_requests").select("id, buyer_id, part").eq("id", record.request_id).maybeSingle(),
      db.from("stores").select("name").eq("id", record.store_id).maybeSingle(),
    ]);
    if (!req) return { sent: 0 };
    users = [req.buyer_id];
    const no = /^no disponible/i.test(record.price_text);
    msg = {
      title: `${st?.name || "Una tienda"} respondió tu pedido`,
      body: `${req.part}: ${no ? "no lo tiene" : record.price_text}`,
      url: "./#pedir", tag: `pedido-${req.id}`,
    };
  } else if (table === "part_requests") {
    const { data: stores } = await db.from("stores").select("owner_id, plan, trial_ends_at").eq("status", "active");
    const now = Date.now();
    users = (stores || [])
      .filter((s) => ORDER_PLANS.includes(s.plan) && !(s.plan === "trial" && s.trial_ends_at && new Date(s.trial_ends_at).getTime() < now))
      .map((s) => s.owner_id)
      .filter((id) => id && id !== record.buyer_id);
    const veh = vehOf(record);
    msg = { title: "Nuevo pedido de un cliente", body: `${record.part}${veh ? " · " + veh : ""}`, url: "./#tienda", tag: `nuevo-${record.id}` };
  }
  if (!users.length || !msg) return { sent: 0 };
  const { data: subs } = await db.from("push_subscriptions").select("id, endpoint, p256dh, auth").in("user_id", [...new Set(users)]);
  let sent = 0;
  await Promise.all((subs || []).map(async (s) => {
    try {
      const status = await sendPush(s, msg);
      if (status === 404 || status === 410) await db.from("push_subscriptions").delete().eq("id", s.id); // el teléfono ya no acepta avisos
      else if (status < 300) sent++;
      else console.error("push", status, s.endpoint.slice(0, 40));
    } catch (e) { console.error(e); }
  }));
  return { sent };
}

if (typeof Deno !== "undefined" && Deno.serve) {
  Deno.serve(async (req) => {
    if (req.headers.get("x-aviso-secret") !== Deno.env.get("AVISO_SECRET")) return new Response("no autorizado", { status: 401 });
    try {
      const { table, record } = await req.json();
      const db = createClient(Deno.env.get("SUPABASE_URL"), Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
      return Response.json(await handle(db, table, record));
    } catch (e) {
      console.error(e);
      return new Response("error", { status: 500 });
    }
  });
}
