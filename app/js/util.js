// Funciones pequeñas que usa toda la app

export const $ = (sel) => document.querySelector(sel);

export const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// Minúsculas y sin acentos, para comparar textos ("Batería" = "bateria")
export const norm = (s) => String(s ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();

export function money(value, currency) {
  const v = Number(value);
  if (currency === "USD") return "$ " + v.toLocaleString("es-VE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (currency === "COP") return "COP " + Math.round(v).toLocaleString("es-CO");
  return "Bs " + v.toLocaleString("es-VE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Distancia en km entre dos puntos (fórmula de haversine)
export function distanceKm(a, b) {
  if (!a || !b || a.lat == null || b.lat == null) return null;
  const R = 6371, toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function kmText(d) {
  if (d == null) return "";
  return d < 1 ? Math.max(50, Math.round((d * 1000) / 50) * 50) + " m" : d.toFixed(1).replace(".", ",") + " km";
}

// Enlace de WhatsApp: convierte "0414 123 4567" en 584141234567
export function waLink(phone, text) {
  let digits = String(phone ?? "").replace(/\D/g, "");
  if (digits.startsWith("0")) digits = "58" + digits.slice(1);
  if (digits.length === 10 && digits.startsWith("4")) digits = "58" + digits;
  return `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;
}

let toastTimer;
export function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 3500);
}

export function yearOptions(selected, label = "Año") {
  let o = `<option value="">${label}</option>`;
  const now = new Date().getFullYear() + 1;
  for (let y = now; y >= 1975; y--) o += `<option ${String(y) === String(selected) ? "selected" : ""}>${y}</option>`;
  return o;
}

export function debounce(fn, ms = 350) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

export const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem("pc:" + key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem("pc:" + key, JSON.stringify(value)); } catch {}
  },
};

// "hace 5 min", "hace 2 h", "ayer", "hace 3 días"
export function ago(date) {
  const s = (Date.now() - new Date(date).getTime()) / 1000;
  if (s < 60) return "ahora";
  if (s < 3600) return `hace ${Math.floor(s / 60)} min`;
  if (s < 86400) return `hace ${Math.floor(s / 3600)} h`;
  const d = Math.floor(s / 86400);
  return d === 1 ? "ayer" : `hace ${d} días`;
}
