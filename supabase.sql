-- Pinzle: ejecutar una vez en Supabase -> SQL Editor -> New query -> Run

-- Perfiles de usuario (1 por cuenta)
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  username text not null check (char_length(username) between 2 and 14),
  wins integer not null default 0,
  rounds_played integer not null default 0,
  created_at timestamptz not null default now()
);
create unique index if not exists profiles_username_lower on public.profiles (lower(username));

alter table public.profiles enable row level security;

drop policy if exists "Perfiles visibles para todos" on public.profiles;
create policy "Perfiles visibles para todos" on public.profiles
  for select to anon, authenticated using (true);
-- Sin policies de insert/update: solo se escribe vía trigger y RPC.

-- Crear el perfil automáticamente al registrarse
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, username)
  values (new.id, coalesce(nullif(trim(new.raw_user_meta_data ->> 'username'), ''), 'player_' || substr(new.id::text, 1, 6)));
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Registrar el resultado de una ronda para el usuario logueado
create or replace function public.record_round(won boolean)
returns void language sql security definer set search_path = public as $$
  update public.profiles
     set rounds_played = rounds_played + 1,
         wins = wins + case when won then 1 else 0 end
   where id = auth.uid();
$$;

revoke all on function public.record_round(boolean) from public, anon;
grant execute on function public.record_round(boolean) to authenticated;
