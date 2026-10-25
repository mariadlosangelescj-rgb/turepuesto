import { db } from "./db.js";
import { VAPID_PUBLIC_KEY } from "./config.js";
import { toast } from "./util.js";

// Notificaciones al celular aunque la app esté cerrada (Web Push)
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const installed = () => window.matchMedia?.("(display-mode: standalone)").matches || navigator.standalone === true;
const supported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

let subscribed = false;

function keyBytes(b64) {
  const s = b64.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (b64.length % 4)) % 4);
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

async function currentSub() {
  if (!supported()) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  return reg ? reg.pushManager.getSubscription() : null;
}

async function save(sub) {
  const j = sub.toJSON();
  const { error } = await db.rpc("save_push", { p_endpoint: j.endpoint, p_p256dh: j.keys.p256dh, p_auth: j.keys.auth });
  if (error) throw error;
}

// Al entrar a una cuenta: si este teléfono ya tenía avisos activados, los conecta a esa cuenta
export async function syncPush(loggedIn) {
  subscribed = false;
  if (!loggedIn) return;
  try {
    if (!supported() || Notification.permission !== "granted") return;
    const sub = await currentSub();
    if (sub) { await save(sub); subscribed = true; document.querySelectorAll(".push-card").forEach((c) => c.remove()); }
  } catch (e) { console.error(e); }
}

// Al salir de la cuenta: este teléfono deja de recibir los avisos de esa cuenta
export async function unlinkPush() {
  try {
    const sub = await currentSub();
    if (sub) await db.rpc("remove_push", { p_endpoint: sub.endpoint });
  } catch (e) { console.error(e); }
  subscribed = false;
}

export async function enablePush() {
  if (!supported()) return false;
  const perm = await Notification.requestPermission();
  if (perm !== "granted") { toast("No diste permiso para avisos. Puedes activarlo en los ajustes del navegador."); return false; }
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = (await reg.pushManager.getSubscription()) || (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(VAPID_PUBLIC_KEY) }));
    await save(sub);
    subscribed = true;
    toast("Listo, te avisaremos en este teléfono.");
    return true;
  } catch (e) {
    console.error(e);
    toast("No pudimos activar los avisos. Inténtalo de nuevo.");
    return false;
  }
}

// Tarjeta para activar los avisos. `text` explica qué avisos recibe esta persona.
export function pushCard(text) {
  if (subscribed && Notification.permission === "granted") return "";
  let inner;
  if (!supported()) {
    if (isIOS && !installed()) inner = `<b>Recibe avisos en tu iPhone</b><span>Primero agrega Tu Repuesto a tu pantalla de inicio: toca el botón Compartir <b>⬆</b> de Safari y luego <b>"Agregar a inicio"</b>. Ábrela desde ese ícono y activa los avisos aquí.</span>`;
    else return "";
  } else if (Notification.permission === "denied") {
    inner = `<b>Los avisos están bloqueados</b><span>Para recibirlos, permite las notificaciones de este sitio en los ajustes del navegador.</span>`;
  } else {
    inner = `<b>Activa los avisos en este teléfono</b><span>${text}</span><button class="btn btn-signal btn-sm" data-push-on>Activar avisos</button>`;
  }
  return `<div class="locked push-card">${inner}</div>`;
}

export function bindPush(onChange) {
  document.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-push-on]");
    if (!b) return;
    b.disabled = true;
    const ok = await enablePush();
    if (ok) document.querySelectorAll(".push-card").forEach((c) => c.remove());
    else { b.disabled = false; onChange?.(); }
  });
}
