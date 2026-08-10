-- =========================================================================
-- Harlan's Legacy — Supabase schema (Phase 12)
--
-- Run this once in the Supabase SQL Editor (Dashboard → SQL → New query → Run).
-- It preserves the existing JSON shapes verbatim using JSONB columns, so no
-- data model is redesigned. All access is server-side via the service-role key
-- (which bypasses RLS); RLS is enabled with NO anon/authenticated policies, so
-- the browser can never read or write these tables directly.
-- =========================================================================

-- ---- documents: single-row JSON blobs (site, entities, photos, story_photos) ----
create table if not exists public.documents (
  key        text primary key,
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- ---- stories: one row per memory; the full record lives in `data` (JSONB) ----
create table if not exists public.stories (
  id         integer primary key,
  data       jsonb not null,
  updated_at timestamptz not null default now()
);

-- Handy generated columns for querying/sorting without unpacking JSON (optional).
create index if not exists stories_status_idx on public.stories ((data->>'status'));
create index if not exists stories_published_idx on public.stories (((data->>'publishedISO')));

-- ---- lock everything down: only the service-role key (server-side) may touch it
alter table public.documents enable row level security;
alter table public.stories   enable row level security;
-- (no policies created on purpose → anon/authenticated clients get zero access;
--  the service-role key used by the serverless API bypasses RLS.)

-- ---- Storage buckets for uploaded originals (public read; writes are server-side) ----
insert into storage.buckets (id, name, public)
values ('photos', 'photos', true)
on conflict (id) do update set public = true;

insert into storage.buckets (id, name, public)
values ('story-photos', 'story-photos', true)
on conflict (id) do update set public = true;

-- Public buckets already allow public downloads via the public object URL, which
-- is all the site/admin need. Uploads/deletes happen server-side with the
-- service-role key (bypasses storage RLS), so no extra storage policies are
-- required. If you prefer PRIVATE buckets + signed URLs, set public=false above
-- and add read policies to taste.
