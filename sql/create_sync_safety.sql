create table if not exists public.sync_job_leases (
  job_name text primary key,
  owner_token text not null,
  expires_at timestamptz not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.sync_stale_candidates (
  job_name text not null,
  record_id text not null,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  last_run_id text not null,
  consecutive_runs integer not null default 1 check (consecutive_runs > 0),
  primary key (job_name, record_id)
);

alter table public.sync_job_leases enable row level security;
alter table public.sync_stale_candidates enable row level security;

create or replace function public.acquire_sync_job_lease(
  p_job_name text,
  p_owner_token text,
  p_lease_seconds integer default 7200
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  acquired boolean := false;
begin
  if p_lease_seconds < 60 or p_lease_seconds > 21600 then
    raise exception 'lease seconds must be between 60 and 21600';
  end if;

  insert into public.sync_job_leases (
    job_name, owner_token, expires_at, updated_at
  ) values (
    p_job_name,
    p_owner_token,
    now() + make_interval(secs => p_lease_seconds),
    now()
  )
  on conflict (job_name) do update
    set owner_token = excluded.owner_token,
        expires_at = excluded.expires_at,
        updated_at = now()
    where sync_job_leases.expires_at <= now()
  returning true into acquired;

  return coalesce(acquired, false);
end;
$$;

create or replace function public.release_sync_job_lease(
  p_job_name text,
  p_owner_token text
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.sync_job_leases
  where job_name = p_job_name and owner_token = p_owner_token;
  return found;
end;
$$;

create or replace function public.record_sync_stale_candidates(
  p_job_name text,
  p_run_id text,
  p_record_ids text[]
) returns text[]
language plpgsql
security definer
set search_path = public
as $$
declare
  eligible_ids text[];
begin
  delete from public.sync_stale_candidates
  where job_name = p_job_name
    and not (record_id = any(coalesce(p_record_ids, array[]::text[])));

  insert into public.sync_stale_candidates (
    job_name, record_id, last_run_id
  )
  select p_job_name, candidate.record_id, p_run_id
  from unnest(coalesce(p_record_ids, array[]::text[]))
    as candidate(record_id)
  on conflict (job_name, record_id) do update
    set consecutive_runs = case
          when sync_stale_candidates.last_run_id <> excluded.last_run_id
            then sync_stale_candidates.consecutive_runs + 1
          else sync_stale_candidates.consecutive_runs
        end,
        last_run_id = excluded.last_run_id,
        last_seen_at = now();

  select coalesce(array_agg(record_id order by record_id), array[]::text[])
  into eligible_ids
  from public.sync_stale_candidates
  where job_name = p_job_name and consecutive_runs >= 2;

  return eligible_ids;
end;
$$;

revoke all on function public.acquire_sync_job_lease(text, text, integer)
  from public, anon, authenticated;
revoke all on function public.release_sync_job_lease(text, text)
  from public, anon, authenticated;
revoke all on function public.record_sync_stale_candidates(text, text, text[])
  from public, anon, authenticated;

grant execute on function public.acquire_sync_job_lease(text, text, integer)
  to service_role;
grant execute on function public.release_sync_job_lease(text, text)
  to service_role;
grant execute on function public.record_sync_stale_candidates(text, text, text[])
  to service_role;
