-- Avisos en vivo: la app se entera al momento cuando llega un pedido o una respuesta.
-- Cada persona solo recibe lo que ya puede ver según las reglas de seguridad (RLS).
alter publication supabase_realtime add table public.part_requests, public.request_responses;
