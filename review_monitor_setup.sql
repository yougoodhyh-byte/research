-- 外审动态监控：在 Supabase SQL Editor 中运行一次
-- 运行后，网站会显示“外审动态监控”开关和首页提醒。

alter table public.papers
  add column if not exists monitor_enabled boolean not null default false,
  add column if not exists tracking_hash text,
  add column if not exists tracking_status text,
  add column if not exists tracking_checked_at timestamptz,
  add column if not exists tracking_last_change_at timestamptz,
  add column if not exists tracking_error text;

create table if not exists public.review_notifications (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  paper_id uuid references public.papers(id) on delete cascade,
  paper_title text,
  journal text,
  old_status text,
  new_status text,
  message text not null default '追踪页面检测到变化',
  created_at timestamptz not null default now(),
  dismissed_at timestamptz
);

create index if not exists review_notifications_owner_created_idx
on public.review_notifications(owner_id, created_at desc);

alter table public.review_notifications enable row level security;

drop policy if exists review_notifications_owner_select on public.review_notifications;
create policy review_notifications_owner_select
on public.review_notifications for select to authenticated
using (owner_id = auth.uid());

drop policy if exists review_notifications_owner_update on public.review_notifications;
create policy review_notifications_owner_update
on public.review_notifications for update to authenticated
using (owner_id = auth.uid())
with check (owner_id = auth.uid());

grant select, update on public.review_notifications to authenticated;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname='supabase_realtime'
      and schemaname='public'
      and tablename='review_notifications'
  ) then
    alter publication supabase_realtime add table public.review_notifications;
  end if;
end $$;
