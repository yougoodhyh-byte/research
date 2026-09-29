-- 外审服务状态归档：在 Supabase SQL Editor 中运行一次
-- 现有记录会默认设为 pending（未审）。

alter table public.review_services
  add column if not exists status text not null default 'pending';

update public.review_services
set status='pending'
where status is null or status not in ('pending','reviewed');

alter table public.review_services
  drop constraint if exists review_services_status_check;

alter table public.review_services
  add constraint review_services_status_check
  check (status in ('pending','reviewed'));

create index if not exists review_services_owner_status_idx
on public.review_services(owner_id,status);
