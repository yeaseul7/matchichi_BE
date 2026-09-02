-- Requires the vector extension to be installed in the public schema and
-- animals.text_embedding to be public.vector(384).

create or replace function public.invalidate_animal_text_embedding()
returns trigger
language plpgsql
as $$
begin
  if new.search_text is distinct from old.search_text
    and new.text_embedding_hash is not distinct from old.text_embedding_hash
  then
    new.text_embedding := null;
    new.text_embedding_hash := null;
    new.text_embedded_at := null;
  end if;
  return new;
end;
$$;

drop trigger if exists animals_invalidate_text_embedding on public.animals;
create trigger animals_invalidate_text_embedding
before update of search_text on public.animals
for each row
execute function public.invalidate_animal_text_embedding();

create or replace function public.search_animals_by_text(
  query_embedding public.vector(384),
  match_count integer default 24,
  minimum_similarity double precision default 0.25,
  species_filter text default null,
  region_filter text default null
)
returns table (
  animal jsonb,
  similarity double precision
)
language sql
stable
security invoker
set search_path = public
as $$
  with filtered_animals as materialized (
    select a.*
    from public.animals a
    where a.text_embedding is not null
      and (
        species_filter is null
        or a.up_kind_nm = species_filter
      )
      and (
        region_filter is null
        or a.org_nm ilike '%' || region_filter || '%'
        or a.care_addr ilike '%' || region_filter || '%'
      )
  )
  select
    to_jsonb(a) - 'text_embedding' as animal,
    1 - (a.text_embedding <=> query_embedding) as similarity
  from filtered_animals a
  where 1 - (a.text_embedding <=> query_embedding) >= minimum_similarity
  order by a.text_embedding <=> query_embedding
  limit least(greatest(match_count, 1), 50);
$$;

revoke all on function public.search_animals_by_text(
  public.vector, integer, double precision, text, text
) from public, anon, authenticated;
grant execute on function public.search_animals_by_text(
  public.vector, integer, double precision, text, text
) to service_role;

create or replace function public.save_animal_text_embeddings(p_rows jsonb)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  updated_count integer;
begin
  update public.animals a
  set search_text = row_data.search_text,
      text_embedding = (row_data.embedding::text)::public.vector(384),
      text_embedding_hash = row_data.embedding_hash,
      text_embedded_at = row_data.embedded_at
  from jsonb_to_recordset(p_rows) as row_data(
    id uuid,
    search_text text,
    embedding jsonb,
    embedding_hash text,
    embedded_at timestamptz
  )
  where a.id = row_data.id;

  get diagnostics updated_count = row_count;
  return updated_count;
end;
$$;

revoke all on function public.save_animal_text_embeddings(jsonb)
  from public, anon, authenticated;
grant execute on function public.save_animal_text_embeddings(jsonb)
  to service_role;

create table if not exists public.text_search_usage (
  usage_identifier text not null,
  usage_date date not null default current_date,
  used_count integer not null default 0 check (used_count >= 0),
  updated_at timestamptz not null default now(),
  primary key (usage_identifier, usage_date)
);

alter table public.text_search_usage enable row level security;

create or replace function public.consume_ai_search_usage(
  p_usage_identifier text,
  p_daily_limit integer
)
returns table (
  allowed boolean,
  used_count integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  current_count integer;
begin
  if p_daily_limit < 1 or p_daily_limit > 1000 then
    raise exception 'daily_limit must be between 1 and 1000';
  end if;

  insert into public.text_search_usage (
    usage_identifier,
    usage_date,
    used_count
  ) values (
    p_usage_identifier,
    current_date,
    0
  )
  on conflict do nothing;

  select u.used_count
  into current_count
  from public.text_search_usage u
  where u.usage_identifier = p_usage_identifier
    and u.usage_date = current_date
  for update;

  if current_count >= p_daily_limit then
    return query select false, current_count;
    return;
  end if;

  update public.text_search_usage u
  set used_count = u.used_count + 1,
      updated_at = now()
  where u.usage_identifier = p_usage_identifier
    and u.usage_date = current_date
  returning u.used_count into current_count;

  return query select true, current_count;
end;
$$;

revoke all on function public.consume_ai_search_usage(text, integer)
  from public, anon, authenticated;
grant execute on function public.consume_ai_search_usage(text, integer)
  to service_role;
