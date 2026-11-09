-- YoEcho reminders + push notifications: run once in YoEcho's Supabase project (SQL Editor).
create table if not exists push_subs (
  endpoint     text primary key,
  profile_id   text not null,
  p256dh       text not null,
  auth         text not null,
  tz           text default 'UTC',
  prefs        jsonb default '{}'::jsonb,
  last_checkin timestamptz,
  last_seen    timestamptz,
  created_at   timestamptz default now()
);
create index if not exists push_subs_profile on push_subs(profile_id);

create table if not exists reminders (
  id          text primary key,
  profile_id  text not null,
  title       text not null,
  due_at      timestamptz not null,
  repeat      text default 'none',
  tz          text default 'UTC',
  done        boolean default false,
  notified_at timestamptz,
  created_at  timestamptz default now()
);
create index if not exists reminders_profile on reminders(profile_id);
create index if not exists reminders_due on reminders(due_at) where done = false and notified_at is null;

create table if not exists push_config (key text primary key, value text not null);

-- Lock the tables: only the server (service key) can read them.
alter table push_subs   enable row level security;
alter table reminders   enable row level security;
alter table push_config enable row level security;

-- QUICK MODE (only if you do NOT want to add SUPABASE_SERVICE_KEY to Netlify; less private because the anon key can then read these tables):
-- create policy "open" on push_subs   for all using (true) with check (true);
-- create policy "open" on reminders   for all using (true) with check (true);
-- create policy "open" on push_config for all using (true) with check (true);
