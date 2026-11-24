-- ============================================================================
-- POKER — Supabase setup script
-- ============================================================================
-- Paste this whole file into the Supabase SQL Editor and click Run ONCE.
-- It is safe to run again: every statement is idempotent (re-running it
-- will not error and will not wipe existing rooms).
--
-- What this creates:
--   * A single table, `rooms`, that stores one row per game room.
--     The room's entire game state lives in the `state` jsonb column;
--     the host's browser writes it, everyone else's browser reads it.
--   * Row Level Security with wide-open policies for the `anon` role.
--
-- WHY THE POLICIES ARE WIDE OPEN (read this before "fixing" them):
--   This is a friendly, play-money poker game. There are no accounts,
--   no real chips, no money, and nothing private stored in a room row —
--   just cards and fake-chip counts for a game anyone with the room
--   code is meant to join. The Supabase anon key is PUBLIC BY DESIGN
--   for this app (it ships in config.js in the browser). RLS with these
--   permissive policies is the intended protection level: the anon key
--   can read/create/update rooms, and that is all it can do. There is
--   deliberately NO delete policy for anon, so rooms can't be wiped by
--   randoms — clean them up manually (see the optional cleanup at the
--   bottom of this file).
--
-- NOTE ON REALTIME: the game syncs in two ways.
--   1. Postgres Changes on this `rooms` table (enabled at the bottom of
--      this script) — used to push the authoritative game state.
--   2. Realtime BROADCAST channels (room codes as channel names) — used
--      for quick player-to-host messages like "I want to raise".
--      Broadcast channels need NO table and NO setup. If you were
--      wondering where the broadcast table is: there isn't one, on
--      purpose.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. Table
-- ----------------------------------------------------------------------------
create table if not exists public.rooms (
    id          uuid primary key default gen_random_uuid(),
    code        text unique not null,
    state       jsonb not null default '{}'::jsonb,
    host_token  text,
    created_at  timestamptz not null default now(),
    updated_at  timestamptz not null default now()
);

-- Fast lookup by the 4-letter room code players type in.
create index if not exists rooms_code_idx on public.rooms (code);


-- ----------------------------------------------------------------------------
-- 2. Keep updated_at fresh on every update
-- ----------------------------------------------------------------------------
create or replace function public.touch_rooms_updated_at()
returns trigger
language plpgsql
as $$
begin
    new.updated_at = now();
    return new;
end;
$$;

drop trigger if exists rooms_touch_updated_at on public.rooms;
create trigger rooms_touch_updated_at
    before update on public.rooms
    for each row
    execute function public.touch_rooms_updated_at();


-- ----------------------------------------------------------------------------
-- 3. Row Level Security + permissive anon policies
--    (See the header comment: friendly fake-chips game, no accounts,
--     anon key is public-by-design, RLS is the protection.)
-- ----------------------------------------------------------------------------
alter table public.rooms enable row level security;

-- Anyone with the (public) anon key can see rooms — needed so a friend
-- can look up a room by its code and watch/join the game.
drop policy if exists "rooms_select_anon" on public.rooms;
create policy "rooms_select_anon"
    on public.rooms
    for select
    to anon
    using (true);

-- Anyone can create a room (that's the "Create room" button).
drop policy if exists "rooms_insert_anon" on public.rooms;
create policy "rooms_insert_anon"
    on public.rooms
    for insert
    to anon
    with check (true);

-- Anyone can update a room's state (the host writes the game state;
-- guests write their presence/actions into it).
drop policy if exists "rooms_update_anon" on public.rooms;
create policy "rooms_update_anon"
    on public.rooms
    for update
    to anon
    using (true)
    with check (true);

-- NOTE: no DELETE policy for anon, on purpose. Rooms are cleaned up
-- manually (or with the optional statement at the bottom of this file,
-- run from this SQL Editor where you are the project owner).


-- ----------------------------------------------------------------------------
-- 4. Enable Realtime (Postgres Changes) for the rooms table
--    Guarded: if the table is already in the publication, skip quietly
--    instead of erroring, so this script can be re-run safely.
-- ----------------------------------------------------------------------------
do $$
begin
    alter publication supabase_realtime add table public.rooms;
exception
    when duplicate_object then
        raise notice 'public.rooms is already in the supabase_realtime publication — skipping.';
    when others then
        raise notice 'Could not add public.rooms to supabase_realtime (%). You can enable it manually: Database -> Replication -> supabase_realtime -> rooms.', sqlerrm;
end;
$$;


-- ============================================================================
-- OPTIONAL CLEANUP (commented out — nothing below this line runs)
-- ============================================================================
-- Rooms are never deleted automatically. To clear out stale rooms,
-- uncomment the line below and run it from this SQL Editor whenever
-- you like (e.g. once in a while by hand). It deletes rooms that
-- haven't been touched in over 24 hours. No pg_cron needed.
--
-- delete from public.rooms
-- where updated_at < now() - interval '24 hours';
-- ============================================================================
