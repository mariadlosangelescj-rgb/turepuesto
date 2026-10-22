import { db } from "./db.js";
import { esc } from "./util.js";

// Sesión actual (null si nadie ha entrado)
export const auth = { user: null, recovery: false, role: "user" };
export const isAdmin = () => auth.role === "admin";

async function loadRole() {
  auth.role = "user";
  if (!auth.user) return;
  const { data } = await db.from("profiles").select("role").eq("id", auth.user.id).maybeSingle();
  auth.role = data?.role || "user";
}

export async function initAuth(onChange) {
  const { data } = await db.auth.getSession();
  auth.user = data.session?.user ?? null;
  await loadRole();
  db.auth.onAuthStateChange(async (event, session) => {
    const before = auth.user?.id;
    auth.user = session?.user ?? null;
    if (event === "PASSWORD_RECOVERY") { auth.recovery = true; onChange(true); return; }
    if (before !== auth.user?.id) { await loadRole(); onChange(); }
  });
}

export async function signOut() {
  await db.auth.signOut();
}

// Mensajes de error de Supabase en español
export function authError(err) {
  const m = String(err?.message || err || "");
  if (/Invalid login credentials/i.test(m)) return "Correo o contraseña incorrectos.";
  if (/Email not confirmed/i.test(m)) return "Todavía no confirmas tu correo. Revisa tu bandeja de entrada (y la carpeta de spam).";
  if (/already registered|already been registered/i.test(m)) return "Ya existe una cuenta con ese correo. Usa \"Ya tengo cuenta\".";
  if (/Password should be at least/i.test(m)) return "La contraseña debe tener al menos 8 caracteres.";
  if (/rate limit|too many/i.test(m)) return "Demasiados intentos seguidos. Espera unos minutos e inténtalo de nuevo.";
  if (/valid email|invalid email/i.test(m)) return "Ese correo no parece válido.";
  return "No pudimos completar la acción. Revisa tu conexión e inténtalo de nuevo.";
}

// Formulario de entrar / crear cuenta. `who` distingue dónde se usa (tienda o comprador)
export function authForm(who, mode = "signup") {
  const signup = mode === "signup";
  return `
    <form class="mail-form" data-authform="${who}" data-mode="${mode}" novalidate>
      <label class="fl">Correo<input type="email" id="${who}-email" placeholder="tucorreo@gmail.com" autocomplete="email" required></label>
      <label class="fl">Contraseña<input type="password" id="${who}-pass" placeholder="Mínimo 8 caracteres" autocomplete="${signup ? "new-password" : "current-password"}" required minlength="8"></label>
      <div class="form-msg" id="${who}-msg" role="status" hidden></div>
      <button class="btn btn-signal" type="submit">${signup ? "Crear cuenta" : "Entrar"}</button>
      <button class="btn-link" type="button" data-authmode="${who}:${signup ? "login" : "signup"}" style="color:var(--muted);align-self:center">${signup ? "Ya tengo cuenta" : "Crear una cuenta nueva"}</button>
      ${signup ? "" : `<button class="btn-link" type="button" data-reset="${who}" style="color:var(--muted);align-self:center">Olvidé mi contraseña</button>`}
    </form>`;
}

function showMsg(who, text, ok = false) {
  const el = document.getElementById(`${who}-msg`);
  if (!el) return;
  el.hidden = false;
  el.className = "form-msg" + (ok ? " ok" : "");
  el.textContent = text;
}

// Maneja el envío de cualquier formulario de acceso
export function bindAuth(rerender) {
  document.addEventListener("submit", async (e) => {
    const f = e.target.closest("[data-authform]");
    if (!f) return;
    e.preventDefault();
    const who = f.dataset.authform, mode = f.dataset.mode;
    const email = document.getElementById(`${who}-email`).value.trim();
    const password = document.getElementById(`${who}-pass`).value;
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return showMsg(who, "Escribe un correo válido.");
    if (password.length < 8) return showMsg(who, "La contraseña debe tener al menos 8 caracteres.");
    const btn = f.querySelector('button[type="submit"]');
    btn.disabled = true;
    try {
      if (mode === "signup") {
        const { data, error } = await db.auth.signUp({ email, password, options: { emailRedirectTo: location.origin + location.pathname } });
        if (error) throw error;
        if (!data.session) showMsg(who, `Te enviamos un correo a ${email}. Ábrelo y toca el enlace para confirmar tu cuenta; después vuelve aquí y entra.`, true);
      } else {
        const { error } = await db.auth.signInWithPassword({ email, password });
        if (error) throw error;
      }
    } catch (err) {
      showMsg(who, authError(err));
    } finally {
      btn.disabled = false;
    }
  });

  document.addEventListener("submit", async (e) => {
    if (e.target.id !== "newpass-form") return;
    e.preventDefault();
    const pass = document.getElementById("newpass").value;
    if (pass.length < 8) return showMsg("newpass", "La contraseña debe tener al menos 8 caracteres.");
    const { error } = await db.auth.updateUser({ password: pass });
    if (error) return showMsg("newpass", authError(error));
    auth.recovery = false;
    history.replaceState(null, "", location.pathname);
    rerender();
  });

  document.addEventListener("click", async (e) => {
    const m = e.target.closest("[data-authmode]");
    if (m) { const [who, mode] = m.dataset.authmode.split(":"); const f = document.querySelector(`[data-authform="${who}"]`); if (f) f.outerHTML = authForm(who, mode); return; }
    const r = e.target.closest("[data-reset]");
    if (r) {
      const who = r.dataset.reset;
      const email = document.getElementById(`${who}-email`).value.trim();
      if (!email) return showMsg(who, "Escribe tu correo arriba y vuelve a tocar \"Olvidé mi contraseña\".");
      const { error } = await db.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname + "#nueva-clave" });
      showMsg(who, error ? authError(error) : `Te enviamos un correo a ${esc(email)} para crear una contraseña nueva.`, !error);
    }
  });
}

// Si la persona llega desde el correo de "olvidé mi contraseña"
export function passwordRecoveryForm() {
  return `
    <section class="panel">
      <h2 style="font-size:19px">Crea tu contraseña nueva</h2>
      <form id="newpass-form" class="mail-form" novalidate>
        <label class="fl">Contraseña nueva<input type="password" id="newpass" minlength="8" autocomplete="new-password" required></label>
        <div class="form-msg" id="newpass-msg" role="status" hidden></div>
        <button class="btn btn-signal" type="submit">Guardar contraseña</button>
      </form>
    </section>`;
}
