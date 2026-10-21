-- =====================================================================
-- PiezaCerca · Estructura de la base de datos (versión 1)
-- Pegar completo en Supabase → SQL Editor → New query → Run
-- Se puede ejecutar una sola vez en un proyecto nuevo.
-- =====================================================================

create extension if not exists unaccent with schema extensions;

-- ---------------------------------------------------------------------
-- Usuarios: un perfil por cada cuenta (compradores, tiendas y administradora)
-- ---------------------------------------------------------------------
create table public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  email       text,
  full_name   text,
  role        text not null default 'user' check (role in ('user', 'admin')),
  created_at  timestamptz not null default now()
);

create or replace function public.is_admin()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin');
$$;

-- Acciones de confianza: la administradora, o el editor SQL de Supabase (sin usuario)
create or replace function public.is_privileged()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select auth.uid() is null or public.is_admin();
$$;

-- Crea el perfil automáticamente al registrarse (con Google o correo)
create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name'));
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Nadie puede darse a sí mismo el rol de administradora
create or replace function public.guard_profile()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.role is distinct from old.role and not public.is_privileged() then
    raise exception 'No tienes permiso para cambiar el rol';
  end if;
  return new;
end;
$$;

create trigger guard_profile before update on public.profiles
  for each row execute function public.guard_profile();

-- ---------------------------------------------------------------------
-- Tiendas
-- status: pending (esperando aprobación) · active · rejected · suspended
-- plan:   trial (1 mes gratis) · basico ($10) · estandar ($20) · plus ($25)
-- ---------------------------------------------------------------------
create table public.stores (
  id             bigint generated always as identity primary key,
  owner_id       uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name           text not null check (char_length(name) between 2 and 80),
  rif            text,
  whatsapp       text not null,
  zone           text,
  address        text,
  hours          text,
  lat            double precision,
  lng            double precision,
  status         text not null default 'pending' check (status in ('pending', 'active', 'rejected', 'suspended')),
  plan           text not null default 'trial' check (plan in ('trial', 'basico', 'estandar', 'plus')),
  trial_ends_at  timestamptz,
  paid_until     date,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index stores_owner_idx on public.stores(owner_id);
create index stores_status_idx on public.stores(status);

-- Las tiendas no pueden cambiarse el estado ni el plan: eso lo hace la administradora
create or replace function public.guard_store()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if not public.is_privileged() then
      new.owner_id := auth.uid();
      new.status := 'pending';
      new.plan := 'trial';
      new.trial_ends_at := null;
      new.paid_until := null;
    end if;
  else
    if not public.is_privileged() then
      new.owner_id := old.owner_id;
      new.status := old.status;
      new.plan := old.plan;
      new.trial_ends_at := old.trial_ends_at;
      new.paid_until := old.paid_until;
    end if;
    -- Al aprobarla por primera vez empieza su mes de prueba
    if new.status = 'active' and old.status <> 'active' and new.plan = 'trial' and new.trial_ends_at is null then
      new.trial_ends_at := now() + interval '30 days';
    end if;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

create trigger guard_store before insert or update on public.stores
  for each row execute function public.guard_store();

-- Plan efectivo: si se venció la prueba gratis, queda como 'trial_expired'
create or replace function public.store_plan(p_store bigint)
returns text
language sql stable security definer set search_path = ''
as $$
  select case
    when s.plan = 'trial' and s.trial_ends_at is not null and s.trial_ends_at < now() then 'trial_expired'
    else s.plan end
  from public.stores s where s.id = p_store;
$$;

-- Límite de repuestos por plan (null = ilimitado)
create or replace function public.plan_limit(p_plan text)
returns integer
language sql immutable
as $$
  select case p_plan
    when 'trial' then 100
    when 'basico' then 50
    when 'estandar' then 100
    when 'plus' then null
    else 0 end;
$$;

-- Planes que pueden ver y responder pedidos de clientes
create or replace function public.plan_has_orders(p_plan text)
returns boolean
language sql immutable
as $$
  select p_plan in ('trial', 'estandar', 'plus');
$$;

create or replace function public.owns_store(p_store bigint)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.stores where id = p_store and owner_id = auth.uid());
$$;

create or replace function public.store_is_active(p_store bigint)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.stores where id = p_store and status = 'active');
$$;

-- ---------------------------------------------------------------------
-- Catálogo de vehículos (lo administra la administradora)
-- ---------------------------------------------------------------------
create table public.vehicle_models (
  id       bigint generated always as identity primary key,
  make     text not null,
  model    text not null,
  engines  text[] not null default '{}',
  unique (make, model)
);

-- ---------------------------------------------------------------------
-- Repuestos: un producto (ej. "Bomba de agua") con varias versiones
-- (cada versión: carro, años, motor, marca del repuesto, estado y precio)
-- ---------------------------------------------------------------------
create table public.products (
  id          bigint generated always as identity primary key,
  store_id    bigint not null references public.stores(id) on delete cascade,
  name        text not null check (char_length(name) between 2 and 120),
  category    text not null,
  currency    text not null default 'USD' check (currency in ('USD', 'COP', 'VES')),
  photo_path  text,
  search      text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index products_store_idx on public.products(store_id);
create index products_search_idx on public.products(search);

create table public.product_versions (
  id           bigint generated always as identity primary key,
  product_id   bigint not null references public.products(id) on delete cascade,
  make         text not null,
  model        text not null,
  year_from    integer not null check (year_from between 1950 and 2100),
  year_to      integer not null check (year_to between 1950 and 2100),
  engine       text,               -- vacío = sirve para todos los motores del modelo
  part_brand   text,
  part_number  text,
  condition    text not null default 'nuevo' check (condition in ('nuevo', 'usado')),
  price        numeric(14, 2) not null check (price >= 0),
  in_stock     boolean not null default true,
  updated_at   timestamptz not null default now(),
  check (year_to >= year_from)
);
create index versions_product_idx on public.product_versions(product_id);
create index versions_vehicle_idx on public.product_versions(make, model);

create or replace function public.product_store(p_product bigint)
returns bigint
language sql stable security definer set search_path = ''
as $$
  select store_id from public.products where id = p_product;
$$;

-- Texto de búsqueda sin acentos y fecha de actualización
create or replace function public.prepare_product()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  new.search := lower(extensions.unaccent(new.name || ' ' || coalesce(new.category, '')));
  new.updated_at := now();
  return new;
end;
$$;

create trigger prepare_product before insert or update on public.products
  for each row execute function public.prepare_product();

-- No permitir más repuestos que los que da el plan
create or replace function public.check_plan_limit()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_plan  text;
  v_limit integer;
  v_count integer;
begin
  if public.is_privileged() then return new; end if;
  v_plan := public.store_plan(new.store_id);
  v_limit := public.plan_limit(v_plan);
  if v_limit is null then return new; end if;
  select count(*) into v_count from public.products where store_id = new.store_id;
  if v_count >= v_limit then
    raise exception 'LIMITE_PLAN: tu plan permite % repuestos', v_limit;
  end if;
  return new;
end;
$$;

create trigger check_plan_limit before insert on public.products
  for each row execute function public.check_plan_limit();

create or replace function public.touch_version()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger touch_version before update on public.product_versions
  for each row execute function public.touch_version();

-- ---------------------------------------------------------------------
-- Pedidos de clientes ("Pide tu repuesto") y respuestas de las tiendas
-- ---------------------------------------------------------------------
create table public.part_requests (
  id          bigint generated always as identity primary key,
  buyer_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  part        text not null check (char_length(part) between 2 and 120),
  make        text,
  model       text,
  year        integer,
  engine      text,
  note        text check (char_length(note) <= 500),
  status      text not null default 'open' check (status in ('open', 'closed')),
  created_at  timestamptz not null default now()
);
create index requests_buyer_idx on public.part_requests(buyer_id);
create index requests_created_idx on public.part_requests(created_at desc);

create table public.request_responses (
  id          bigint generated always as identity primary key,
  request_id  bigint not null references public.part_requests(id) on delete cascade,
  store_id    bigint not null references public.stores(id) on delete cascade,
  price_text  text not null check (char_length(price_text) <= 60),
  note        text check (char_length(note) <= 500),
  created_at  timestamptz not null default now(),
  unique (request_id, store_id)
);
create index responses_request_idx on public.request_responses(request_id);

-- Para las tiendas sin pedidos en su plan: solo cuántos pedidos hay (sin ver el detalle)
create or replace function public.open_requests_count()
returns integer
language sql stable security definer set search_path = ''
as $$
  select count(*)::integer from public.part_requests
  where status = 'open' and created_at > now() - interval '7 days';
$$;

-- ---------------------------------------------------------------------
-- Solicitudes de cambio de plan y pagos registrados
-- ---------------------------------------------------------------------
create table public.plan_requests (
  id          bigint generated always as identity primary key,
  store_id    bigint not null references public.stores(id) on delete cascade,
  plan        text not null check (plan in ('basico', 'estandar', 'plus')),
  status      text not null default 'pending' check (status in ('pending', 'done', 'cancelled')),
  created_at  timestamptz not null default now()
);

create table public.payments (
  id            bigint generated always as identity primary key,
  store_id      bigint not null references public.stores(id) on delete cascade,
  plan          text not null,
  amount        numeric(14, 2) not null,
  currency      text not null default 'USD',
  method        text,          -- pago móvil, Zelle, efectivo…
  paid_at       date not null default current_date,
  period_until  date,
  notes         text,
  created_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Estadísticas: contactos por WhatsApp y búsquedas
-- ---------------------------------------------------------------------
create table public.contact_events (
  id          bigint generated always as identity primary key,
  store_id    bigint not null references public.stores(id) on delete cascade,
  version_id  bigint references public.product_versions(id) on delete set null,
  created_at  timestamptz not null default now()
);
create index contacts_store_idx on public.contact_events(store_id, created_at desc);

create table public.search_logs (
  id          bigint generated always as identity primary key,
  query       text,
  make        text,
  model       text,
  year        integer,
  engine      text,
  results     integer,
  created_at  timestamptz not null default now()
);

-- =====================================================================
-- Seguridad (RLS): quién puede ver y cambiar qué
-- =====================================================================
alter table public.profiles           enable row level security;
alter table public.stores             enable row level security;
alter table public.vehicle_models     enable row level security;
alter table public.products           enable row level security;
alter table public.product_versions   enable row level security;
alter table public.part_requests      enable row level security;
alter table public.request_responses  enable row level security;
alter table public.plan_requests      enable row level security;
alter table public.payments           enable row level security;
alter table public.contact_events     enable row level security;
alter table public.search_logs        enable row level security;

-- Perfiles: cada quien ve y edita el suyo; la administradora ve todos
create policy "perfil propio" on public.profiles for select using (id = auth.uid() or public.is_admin());
create policy "editar perfil propio" on public.profiles for update using (id = auth.uid() or public.is_admin());

-- Tiendas: todos ven las activas; el dueño ve la suya aunque esté pendiente
create policy "ver tiendas" on public.stores for select
  using (status = 'active' or owner_id = auth.uid() or public.is_admin());
create policy "registrar tienda" on public.stores for insert to authenticated
  with check (owner_id = auth.uid() or public.is_admin());
create policy "editar tienda" on public.stores for update
  using (owner_id = auth.uid() or public.is_admin());
create policy "borrar tienda" on public.stores for delete using (public.is_admin());

-- Catálogo de vehículos: todos lo ven, solo la administradora lo cambia
create policy "ver catalogo" on public.vehicle_models for select using (true);
create policy "admin catalogo" on public.vehicle_models for all using (public.is_admin()) with check (public.is_admin());

-- Repuestos: todos ven los de tiendas activas; cada tienda maneja los suyos
create policy "ver repuestos" on public.products for select
  using (public.store_is_active(store_id) or public.owns_store(store_id) or public.is_admin());
create policy "crear repuestos" on public.products for insert to authenticated
  with check (public.owns_store(store_id) or public.is_admin());
create policy "editar repuestos" on public.products for update
  using (public.owns_store(store_id) or public.is_admin());
create policy "borrar repuestos" on public.products for delete
  using (public.owns_store(store_id) or public.is_admin());

create policy "ver versiones" on public.product_versions for select
  using (public.store_is_active(public.product_store(product_id)) or public.owns_store(public.product_store(product_id)) or public.is_admin());
create policy "crear versiones" on public.product_versions for insert to authenticated
  with check (public.owns_store(public.product_store(product_id)) or public.is_admin());
create policy "editar versiones" on public.product_versions for update
  using (public.owns_store(public.product_store(product_id)) or public.is_admin());
create policy "borrar versiones" on public.product_versions for delete
  using (public.owns_store(public.product_store(product_id)) or public.is_admin());

-- Pedidos: el comprador ve los suyos; las tiendas activas con pedidos en su plan ven todos
create policy "crear pedido" on public.part_requests for insert to authenticated
  with check (buyer_id = auth.uid());
create policy "ver pedidos" on public.part_requests for select
  using (
    buyer_id = auth.uid() or public.is_admin()
    or exists (select 1 from public.stores s
               where s.owner_id = auth.uid() and s.status = 'active'
                 and public.plan_has_orders(public.store_plan(s.id)))
  );
create policy "cerrar pedido propio" on public.part_requests for update
  using (buyer_id = auth.uid() or public.is_admin());

-- Respuestas: las da una tienda activa con pedidos en su plan; las ven el comprador y la tienda
create policy "responder pedido" on public.request_responses for insert to authenticated
  with check (
    public.owns_store(store_id) and public.store_is_active(store_id)
    and public.plan_has_orders(public.store_plan(store_id))
  );
create policy "ver respuestas" on public.request_responses for select
  using (
    public.owns_store(store_id) or public.is_admin()
    or exists (select 1 from public.part_requests r where r.id = request_id and r.buyer_id = auth.uid())
  );
create policy "editar respuesta" on public.request_responses for update using (public.owns_store(store_id));
create policy "borrar respuesta" on public.request_responses for delete using (public.owns_store(store_id) or public.is_admin());

-- Cambio de plan: la tienda lo solicita, la administradora lo gestiona
create policy "solicitar plan" on public.plan_requests for insert to authenticated with check (public.owns_store(store_id));
create policy "ver solicitudes de plan" on public.plan_requests for select using (public.owns_store(store_id) or public.is_admin());
create policy "gestionar solicitudes de plan" on public.plan_requests for update using (public.is_admin());

-- Pagos: solo la administradora (la tienda puede ver los suyos)
create policy "ver pagos" on public.payments for select using (public.owns_store(store_id) or public.is_admin());
create policy "admin pagos" on public.payments for all using (public.is_admin()) with check (public.is_admin());

-- Estadísticas: cualquiera registra un evento; solo la tienda y la administradora los ven
create policy "registrar contacto" on public.contact_events for insert with check (public.store_is_active(store_id));
create policy "ver contactos" on public.contact_events for select using (public.owns_store(store_id) or public.is_admin());
create policy "registrar busqueda" on public.search_logs for insert with check (true);
create policy "ver busquedas" on public.search_logs for select using (public.is_admin());

-- =====================================================================
-- Fotos de los repuestos (cada tienda sube en su propia carpeta)
-- =====================================================================
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('product-photos', 'product-photos', true, 2097152, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

create policy "fotos: subir a mi tienda" on storage.objects for insert to authenticated
  with check (bucket_id = 'product-photos' and (public.owns_store(((storage.foldername(name))[1])::bigint) or public.is_admin()));
create policy "fotos: cambiar las de mi tienda" on storage.objects for update to authenticated
  using (bucket_id = 'product-photos' and (public.owns_store(((storage.foldername(name))[1])::bigint) or public.is_admin()));
create policy "fotos: borrar las de mi tienda" on storage.objects for delete to authenticated
  using (bucket_id = 'product-photos' and (public.owns_store(((storage.foldername(name))[1])::bigint) or public.is_admin()));

-- =====================================================================
-- Catálogo inicial de vehículos comunes en Venezuela
-- (la administradora puede agregar más desde su panel)
-- =====================================================================
insert into public.vehicle_models (make, model, engines) values
  ('Toyota', 'Corolla', '{1.6,1.8}'),
  ('Toyota', 'Yaris', '{1.3,1.5}'),
  ('Toyota', 'Camry', '{2.4,3.5}'),
  ('Toyota', 'Hilux', '{2.7,"3.0 diésel",4.0}'),
  ('Toyota', 'Fortuner', '{2.7,4.0}'),
  ('Toyota', '4Runner', '{4.0}'),
  ('Toyota', 'Land Cruiser (Machito)', '{4.5}'),
  ('Toyota', 'Terios', '{1.3,1.5}'),
  ('Chevrolet', 'Aveo', '{1.4,1.6}'),
  ('Chevrolet', 'Optra', '{1.6,1.8}'),
  ('Chevrolet', 'Spark', '{1.0}'),
  ('Chevrolet', 'Corsa', '{1.3,1.4,1.6}'),
  ('Chevrolet', 'Cruze', '{1.8}'),
  ('Chevrolet', 'Captiva', '{2.4}'),
  ('Chevrolet', 'Grand Vitara', '{1.6,2.0}'),
  ('Chevrolet', 'Silverado', '{4.8,5.3}'),
  ('Chevrolet', 'Malibu', '{2.4}'),
  ('Ford', 'Fiesta', '{1.4,1.6}'),
  ('Ford', 'Ka', '{1.6}'),
  ('Ford', 'Focus', '{2.0}'),
  ('Ford', 'Fusion', '{2.3,2.5}'),
  ('Ford', 'EcoSport', '{2.0}'),
  ('Ford', 'Explorer', '{4.0}'),
  ('Ford', 'F-150', '{4.2,4.6,5.4}'),
  ('Mitsubishi', 'Lancer', '{1.6,2.0}'),
  ('Mitsubishi', 'Signo', '{1.3}'),
  ('Mitsubishi', 'Montero', '{3.0,3.5,3.8}'),
  ('Hyundai', 'Getz', '{1.3,1.6}'),
  ('Hyundai', 'Accent', '{1.5,1.6}'),
  ('Hyundai', 'Elantra', '{1.6,2.0}'),
  ('Hyundai', 'Tucson', '{2.0,2.7}'),
  ('Kia', 'Rio', '{1.4,1.5,1.6}'),
  ('Kia', 'Picanto', '{1.1}'),
  ('Kia', 'Sportage', '{2.0}'),
  ('Renault', 'Logan', '{1.6}'),
  ('Renault', 'Clio', '{1.6}'),
  ('Renault', 'Megane', '{1.6}'),
  ('Fiat', 'Palio', '{1.3,1.6}'),
  ('Fiat', 'Siena', '{1.6}'),
  ('Fiat', 'Uno', '{1.3}'),
  ('Chery', 'Orinoco', '{1.8}'),
  ('Chery', 'Arauca', '{1.5}'),
  ('Chery', 'Tiggo', '{2.0}'),
  ('Jeep', 'Cherokee', '{3.7,4.0}'),
  ('Jeep', 'Grand Cherokee', '{4.0,4.7}'),
  ('Jeep', 'Wrangler', '{4.0}'),
  ('Nissan', 'Sentra', '{1.6,1.8}'),
  ('Nissan', 'Frontier', '{2.5,3.0}'),
  ('Mazda', '3', '{1.6,2.0}'),
  ('Volkswagen', 'Gol', '{1.6}'),
  ('Volkswagen', 'Jetta', '{2.0}')
on conflict (make, model) do nothing;
