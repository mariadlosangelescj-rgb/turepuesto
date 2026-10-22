-- Notificaciones al celular (Web Push)
-- Antes de correrlo, reemplaza PEGA_AQUI_EL_AVISO_SECRET por la clave AVISO_SECRET
-- (la misma que pusiste en Edge Functions → Secrets).

-- 1) Teléfonos que aceptaron recibir avisos
create table if not exists public.push_subscriptions (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references auth.users(id) on delete cascade,
  endpoint    text not null unique,
  p256dh      text not null,
  auth        text not null,
  created_at  timestamptz not null default now()
);
create index if not exists push_user_idx on public.push_subscriptions(user_id);
alter table public.push_subscriptions enable row level security;
drop policy if exists "ver mis avisos" on public.push_subscriptions;
create policy "ver mis avisos" on public.push_subscriptions for select using (user_id = auth.uid());

-- Guardar o quitar el teléfono de la persona que está usando la app
create or replace function public.save_push(p_endpoint text, p_p256dh text, p_auth text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'Necesitas entrar a tu cuenta'; end if;
  delete from public.push_subscriptions where endpoint = p_endpoint;
  insert into public.push_subscriptions (user_id, endpoint, p256dh, auth) values (auth.uid(), p_endpoint, p_p256dh, p_auth);
end $$;

create or replace function public.remove_push(p_endpoint text)
returns void language sql security definer set search_path = '' as $$
  delete from public.push_subscriptions where endpoint = p_endpoint and user_id = auth.uid();
$$;

revoke execute on function public.save_push(text, text, text) from anon;
revoke execute on function public.remove_push(text) from anon;

-- 2) Cuando se crea un pedido o una respuesta, la base de datos llama a la función "avisar"
create extension if not exists pg_net with schema extensions;
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
create table if not exists private.ajustes (clave text primary key, valor text not null);
alter table private.ajustes enable row level security;
insert into private.ajustes (clave, valor) values
  ('aviso_url', 'https://vtjfbnhnhjhoxdzdlyly.supabase.co/functions/v1/avisar'),
  ('aviso_secret', 'PEGA_AQUI_EL_AVISO_SECRET')
on conflict (clave) do update set valor = excluded.valor;

create or replace function private.avisar()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  begin
    perform net.http_post(
      url := (select valor from private.ajustes where clave = 'aviso_url'),
      body := jsonb_build_object('table', tg_table_name, 'record', to_jsonb(new)),
      headers := jsonb_build_object('Content-Type', 'application/json',
                                    'x-aviso-secret', (select valor from private.ajustes where clave = 'aviso_secret'))
    );
  exception when others then
    raise warning 'avisar: %', sqlerrm; -- si falla el aviso, el pedido igual se guarda
  end;
  return new;
end $$;

drop trigger if exists avisar_pedido on public.part_requests;
create trigger avisar_pedido after insert on public.part_requests
  for each row execute function private.avisar();
drop trigger if exists avisar_respuesta on public.request_responses;
create trigger avisar_respuesta after insert on public.request_responses
  for each row execute function private.avisar();
