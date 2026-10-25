import { SUPABASE_URL, SUPABASE_KEY } from "./config.js";

// Supabase llega en un solo archivo desde index.html; si fallara, se usa la versión por partes
const { createClient } = window.supabase || (await import("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm"));

export const db = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});

// Dirección pública de una foto guardada en Supabase
export function photoUrl(path) {
  if (!path) return null;
  return db.storage.from("product-photos").getPublicUrl(path).data.publicUrl;
}
