create table if not exists public.comment_likes (
  comment_id uuid not null references public.comments(id) on delete cascade,
  user_id text not null,
  created_at timestamp with time zone null,
  primary key (comment_id, user_id)
);

create index if not exists comment_likes_user_id_idx
  on public.comment_likes (user_id);
