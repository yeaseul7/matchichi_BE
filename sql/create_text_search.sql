create extension if not exists vector with schema public;
create extension if not exists pg_trgm with schema public;

alter table public.animals
  add column if not exists search_text text not null default '',
  add column if not exists text_embedding public.vector(384),
  add column if not exists text_embedding_hash text,
  add column if not exists text_embedded_at timestamptz;

create index if not exists animals_search_text_trgm_idx
  on public.animals using gin (search_text gin_trgm_ops);

create index if not exists animals_text_embedding_hnsw_idx
  on public.animals using hnsw (text_embedding public.vector_cosine_ops)
  where text_embedding is not null;

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

drop function if exists public.search_animals_by_text(
  public.vector, integer, double precision, text, text
);
drop function if exists public.search_animals_by_text(
  public.vector, integer, double precision, text, text, text, integer, integer
);

create or replace function public.search_animals_by_text(
  query_embedding public.vector(384),
  match_count integer default 24,
  minimum_similarity double precision default 0.25,
  species_filter text default null,
  region_filter text default null,
  breed_filter text default null,
  color_filter text default null,
  minimum_age_filter integer default null,
  maximum_age_filter integer default null
)
returns table (
  animal jsonb,
  similarity double precision,
  semantic_similarity double precision,
  color_score double precision
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
      and (
        breed_filter is null
        or a.kind_nm ilike '%' || breed_filter || '%'
        or a.kind_full_nm ilike '%' || breed_filter || '%'
      )
      and (
        minimum_age_filter is null
        or extract(year from current_date)::integer
          - substring(a.age from '([0-9]{4})')::integer >= minimum_age_filter
      )
      and (
        maximum_age_filter is null
        or extract(year from current_date)::integer
          - substring(a.age from '([0-9]{4})')::integer <= maximum_age_filter
      )
  )
  , scored_animals as (
    select
      a.*,
      1 - (a.text_embedding <=> query_embedding) as semantic_score,
      case
        when color_filter is null then 0.0
        when color_filter = '흰색' and
          regexp_replace(lower(coalesce(a.color_cd, '')), '\s', '', 'g') ~
            '^(흰색|백색|기타\((흰색|백)\))$'
          then 1.0
        when color_filter = '흰색' and
          regexp_replace(lower(coalesce(a.color_cd, '')), '\s', '', 'g') ~
            '^(기타\()?((흰|백))'
          then 0.8
        when color_filter = '흰색' and coalesce(a.color_cd, '') ~ '(흰|백)'
          then 0.55
        when color_filter = '흰색' and coalesce(a.color_cd, '') ~ '(아이보리|크림)'
          then 0.3
        else 0.0
      end::double precision as matched_color_score
    from filtered_animals a
  )
  select
    to_jsonb(a) - 'text_embedding' - 'semantic_score' - 'matched_color_score'
      as animal,
    case
      when color_filter is null then a.semantic_score
      else a.semantic_score * 0.45 + a.matched_color_score * 0.55
    end as similarity,
    a.semantic_score as semantic_similarity,
    a.matched_color_score as color_score
  from scored_animals a
  where a.semantic_score >= minimum_similarity
    or (color_filter is not null and a.matched_color_score > 0)
  order by similarity desc
  limit least(greatest(match_count, 1), 50);
$$;

revoke all on function public.search_animals_by_text(
  public.vector, integer, double precision, text, text, text, text, integer,
  integer
) from public, anon, authenticated;
grant execute on function public.search_animals_by_text(
  public.vector, integer, double precision, text, text, text, text, integer,
  integer
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
