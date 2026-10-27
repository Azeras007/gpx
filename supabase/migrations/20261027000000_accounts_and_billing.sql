-- Accounts, cloud routes and subscriptions for GPX Studio.
--
-- Who is Pro is decided here, never in the browser:
--   * `subscriptions` is written only by the Stripe webhook (service role)
--     and by `start_trial()`; users can read their own row, nothing more.
--   * `is_pro()` is the single definition of "Pro", used by the route limit.

-- ── Subscriptions ──────────────────────────────────────────────────────────

create table public.subscriptions (
  user_id uuid primary key references auth.users (id) on delete cascade,
  -- Stripe subscription status: trialing, active, past_due, canceled, unpaid, incomplete…
  status text,
  plan text check (plan in ('monthly', 'yearly')),
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  stripe_customer_id text unique,
  stripe_subscription_id text unique,
  -- Free trial without a card, started from the app (see start_trial)
  trial_ends_at timestamptz,
  updated_at timestamptz not null default now()
);

alter table public.subscriptions enable row level security;

create policy "read own subscription" on public.subscriptions
  for select to authenticated using (user_id = auth.uid());

-- No insert/update/delete policy: only the service role (webhook) and the
-- security-definer functions below can write.

create or replace function public.is_pro(uid uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.subscriptions s
    where s.user_id = uid
      and (
        (s.status in ('active', 'trialing', 'past_due') and s.current_period_end > now())
        or s.trial_ends_at > now()
      )
  );
$$;

-- One free 14-day trial per account, no card needed.
create or replace function public.start_trial()
returns timestamptz
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  ends timestamptz;
begin
  if uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  insert into public.subscriptions (user_id, trial_ends_at)
  values (uid, now() + interval '14 days')
  on conflict (user_id) do update
    set trial_ends_at = now() + interval '14 days', updated_at = now()
    where public.subscriptions.trial_ends_at is null
  returning trial_ends_at into ends;
  if ends is null then
    raise exception 'trial already used' using errcode = 'P0001';
  end if;
  return ends;
end;
$$;

revoke execute on function public.start_trial() from public, anon;
grant execute on function public.start_trial() to authenticated;
grant execute on function public.is_pro(uuid) to authenticated;

-- ── Saved routes ───────────────────────────────────────────────────────────

create table public.routes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 200),
  activity text not null check (activity in ('run', 'hike')),
  waypoints jsonb not null,
  pois jsonb not null default '[]'::jsonb,
  distance double precision not null default 0,
  gain double precision not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Keep rows small: a route is at most a few hundred waypoints
  constraint routes_size check (pg_column_size(waypoints) + pg_column_size(pois) < 512000)
);

create index routes_user_updated on public.routes (user_id, updated_at desc);

alter table public.routes enable row level security;

create policy "read own routes" on public.routes
  for select to authenticated using (user_id = auth.uid());
create policy "insert own routes" on public.routes
  for insert to authenticated with check (user_id = auth.uid());
create policy "update own routes" on public.routes
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "delete own routes" on public.routes
  for delete to authenticated using (user_id = auth.uid());

-- Free accounts keep at most 5 routes; enforced in the database so it
-- cannot be bypassed from the browser.
create or replace function public.enforce_route_limit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_pro(new.user_id)
     and (select count(*) from public.routes r where r.user_id = new.user_id) >= 5 then
    raise exception 'free route limit reached' using errcode = 'P0001', hint = 'upgrade';
  end if;
  return new;
end;
$$;

create trigger routes_limit
  before insert on public.routes
  for each row execute function public.enforce_route_limit();

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger routes_touch
  before update on public.routes
  for each row execute function public.touch_updated_at();
