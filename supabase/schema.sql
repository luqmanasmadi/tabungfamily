-- =====================================================================
-- TabungFamily — database (run once in Supabase > SQL Editor)
-- 1) Change admin_email below to YOUR login email.
-- 2) Run the whole file.
-- =====================================================================
create extension if not exists pg_net;

-- ---------- settings ----------
create table if not exists settings (
  key   text primary key,
  value text not null default ''
);
insert into settings (key, value) values
  ('admin_email',     'YOUR_EMAIL@gmail.com'),  -- <== CHANGE: only this login can edit
  ('fund_name',       'TabungFamily'),
  ('monthly_due',     '100'),                   -- RM per member per month
  ('opening_balance', '0'),                     -- money in the fund before the first record
  ('last_backup_at',  ''),                      -- written by the Google Sheet backup
  ('backup_sheet_url',''),                      -- written by the Google Sheet backup (admin only)
  ('backup_hook_url', ''),                      -- Apps Script web app URL (admin only)
  ('backup_secret',   '')                       -- same as SECRET in Apps Script (admin only)
on conflict (key) do nothing;

-- ---------- members ----------
create table if not exists members (
  id          serial primary key,
  name        text not null unique,
  start_month date not null default date_trunc('month', now())::date,  -- first month they owe
  tg_chat_id  bigint unique,                                           -- linked via the bot
  created_at  timestamptz not null default now()
);

-- A "break" = months a member does NOT owe. Stop contributing = open break (to_month null).
create table if not exists member_breaks (
  id          serial primary key,
  member_id   int  not null references members(id) on delete cascade,
  from_month  date not null,            -- first month not owed
  to_month    date,                     -- last month not owed; null = still stopped
  reason      text,
  created_at  timestamptz not null default now()
);

-- ---------- money in ----------
create table if not exists cash_in (
  id          serial primary key,
  member_id   int  references members(id),            -- null = money not from a member (e.g. "Lain-lain")
  paid_on     date not null default current_date,
  amount      numeric(10,2) not null check (amount > 0),
  method      text not null default 'transfer',      -- transfer | cash
  ref         text,                                   -- bank / DuitNow reference
  receipt_url text,                                   -- Google Drive (private)
  tg_file_uid text,                                   -- Telegram file id (duplicate check)
  batch_id    uuid not null default gen_random_uuid(),-- one receipt split for several members
  sent_by     int references members(id),             -- who sent the receipt
  source      text not null default 'bot',            -- bot | manual | import
  status      text not null default 'pending' check (status in ('pending','approved','rejected')),
  note        text,
  payee       text,                                   -- recipient name read by AI (admin only)
  kind        text not null default 'yuran' check (kind in ('yuran','sumbangan')), -- sumbangan = extra money, not monthly dues
  for_month   date,                                   -- month this fee is for (null = fill oldest owed month first)
  created_at  timestamptz not null default now(),
  constraint member_or_sumbangan check (member_id is not null or kind = 'sumbangan')
);
-- for projects created from an older draft
alter table cash_in add column if not exists payee text;
alter table cash_in add column if not exists kind text not null default 'yuran';
alter table cash_in add column if not exists for_month date;
alter table cash_in alter column member_id drop not null;
create unique index if not exists cash_in_ref_uq on cash_in(ref, member_id) where ref is not null and status <> 'rejected';
create index if not exists cash_in_file_ix on cash_in(tg_file_uid);
create index if not exists cash_in_batch_ix on cash_in(batch_id);

-- ---------- money out ----------
create table if not exists cash_out (
  id          serial primary key,
  spent_on    date not null default current_date,
  description text not null,
  category    text not null default 'lain',
  amount      numeric(10,2) not null check (amount > 0),
  receipt_url text,                                    -- public Drive link
  legacy      boolean not null default false,          -- old imported record without receipt
  tg_file_uid text,
  source      text not null default 'bot',
  created_at  timestamptz not null default now(),
  constraint receipt_required check (receipt_url is not null or legacy)
);
create index if not exists cash_out_file_ix on cash_out(tg_file_uid);

-- ---------- who is admin ----------
create or replace function is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(auth.jwt() ->> 'email', '') <> ''
     and lower(auth.jwt() ->> 'email') = lower((select value from settings where key = 'admin_email'))
$$;
revoke all on function is_admin() from public;
grant execute on function is_admin() to anon, authenticated;

-- ---------- security: public read-only, admin full ----------
alter table settings      enable row level security;
alter table members       enable row level security;
alter table member_breaks enable row level security;
alter table cash_in       enable row level security;
alter table cash_out      enable row level security;

revoke all on settings, members, member_breaks, cash_in, cash_out from anon;
grant select (key, value)                                     on settings      to anon;
grant select (id, name, start_month)                          on members       to anon;
grant select (id, member_id, from_month, to_month)            on member_breaks to anon;
grant select (id, member_id, paid_on, amount, method, status, kind, for_month, ref) on cash_in to anon;  -- ref shown publicly; receipt link & note stay private
grant select                                                  on cash_out      to anon;  -- receipts public (transparency)

grant all on settings, members, member_breaks, cash_in, cash_out to authenticated;
grant usage, select on all sequences in schema public to authenticated;

drop policy if exists settings_read on settings;
create policy settings_read on settings for select to anon, authenticated
  using (key in ('fund_name','monthly_due','opening_balance','last_backup_at') or is_admin());
drop policy if exists settings_admin on settings;
create policy settings_admin on settings for all to authenticated using (is_admin()) with check (is_admin());

drop policy if exists members_read on members;
create policy members_read  on members for select to anon, authenticated using (true);
drop policy if exists members_admin on members;
create policy members_admin on members for all to authenticated using (is_admin()) with check (is_admin());

drop policy if exists breaks_read on member_breaks;
create policy breaks_read  on member_breaks for select to anon, authenticated using (true);
drop policy if exists breaks_admin on member_breaks;
create policy breaks_admin on member_breaks for all to authenticated using (is_admin()) with check (is_admin());

drop policy if exists cash_in_read on cash_in;
create policy cash_in_read  on cash_in for select to anon, authenticated using (status = 'approved' or is_admin());
drop policy if exists cash_in_admin on cash_in;
create policy cash_in_admin on cash_in for all to authenticated using (is_admin()) with check (is_admin());

drop policy if exists cash_out_read on cash_out;
create policy cash_out_read  on cash_out for select to anon, authenticated using (true);
drop policy if exists cash_out_admin on cash_out;
create policy cash_out_admin on cash_out for all to authenticated using (is_admin()) with check (is_admin());

-- ---------- real-time backup: every change is sent to the Google Sheet ----------
create or replace function backup_push() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
declare
  url text; sec text; r record; payload jsonb; extra jsonb := '{}'::jsonb;
begin
  select value into url from settings where key = 'backup_hook_url';
  select value into sec from settings where key = 'backup_secret';
  if coalesce(url, '') = '' then return null; end if;
  if TG_OP = 'DELETE' then r := OLD; else r := NEW; end if;
  if TG_TABLE_NAME in ('cash_in', 'member_breaks') then
    extra := jsonb_build_object('member_name', (select name from members where id = r.member_id));
  end if;
  payload := jsonb_build_object('secret', sec, 'action', 'change', 'table', TG_TABLE_NAME, 'op', TG_OP,
                                'row', to_jsonb(r)) || extra;
  perform net.http_post(url := url, body := payload,
                        headers := '{"Content-Type":"application/json"}'::jsonb, timeout_milliseconds := 15000);
  return null;
exception when others then
  return null;  -- never block a save because the backup is unreachable
end $$;

drop trigger if exists backup_members on members;
create trigger backup_members after insert or update or delete on members for each row execute function backup_push();
drop trigger if exists backup_breaks on member_breaks;
create trigger backup_breaks after insert or update or delete on member_breaks for each row execute function backup_push();
drop trigger if exists backup_cash_in on cash_in;
create trigger backup_cash_in after insert or update or delete on cash_in for each row execute function backup_push();
drop trigger if exists backup_cash_out on cash_out;
create trigger backup_cash_out after insert or update or delete on cash_out for each row execute function backup_push();
