-- Run once in Supabase > SQL Editor > New query > Run
create table if not exists public.kaffi_docs (
  col        text        not null,
  id         text        not null,
  data       jsonb       not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (col, id)
);

create index if not exists kaffi_docs_data_gin on public.kaffi_docs using gin (data);

-- The backend uses the SECRET key (bypasses RLS). Turning RLS on with no policies
-- means the public/publishable key can NOT read or write this table.
alter table public.kaffi_docs enable row level security;
