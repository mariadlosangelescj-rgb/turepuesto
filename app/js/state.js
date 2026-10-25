import { db } from "./db.js";
import { store } from "./util.js";
import { CENTRO } from "./config.js";

// Estado compartido de la app
export const S = {
  tab: "buscar",
  car: store.get("car", { make: "", model: "", year: "", engine: "" }), // "Mi carro" se recuerda en el teléfono
  q: "",
  sort: "near",
  cond: "todos",
  money: "todas",
  onlyStock: false,
  storeFilter: null,
  loc: store.get("loc", null),   // ubicación de la persona {lat, lng}
  catalog: {},                   // { Toyota: { Corolla: ["1.6","1.8"] } }
  stores: [],                    // tiendas activas
};

export const here = () => S.loc || CENTRO;

export function saveCar() { store.set("car", S.car); }

export async function loadCatalog() {
  const { data, error } = await db.from("vehicle_models").select("make, model, engines").order("make").order("model");
  if (error) throw error;
  const cat = {};
  for (const r of data) (cat[r.make] ||= {})[r.model] = r.engines || [];
  const changed = JSON.stringify(cat) !== JSON.stringify(S.catalog);
  S.catalog = cat;
  store.set("cache:catalog", cat);
  return changed;
}

// Copia guardada en el teléfono de la última vez: así la app abre al instante
export function loadCached() {
  const cat = store.get("cache:catalog", null), st = store.get("cache:stores", null);
  if (!cat || !st) return false;
  S.catalog = cat; S.stores = st;
  return true;
}

export async function loadStores() {
  const { data, error } = await db.from("stores").select("id, name, zone, address, hours, whatsapp, lat, lng, plan").eq("status", "active");
  if (error) throw error;
  const changed = JSON.stringify(data) !== JSON.stringify(S.stores);
  S.stores = data;
  store.set("cache:stores", data);
  return changed;
}

export const storeById = (id) => S.stores.find((s) => s.id === id);

export function askLocation() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(false);
    navigator.geolocation.getCurrentPosition(
      (p) => { S.loc = { lat: p.coords.latitude, lng: p.coords.longitude }; store.set("loc", S.loc); resolve(true); },
      () => resolve(false),
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 600000 }
    );
  });
}
