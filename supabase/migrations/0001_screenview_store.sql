-- ScreenView session store for Supabase (Postgres).
--
-- One small key/value table plus one function, screenview_exec(), that runs a
-- single store command (the same Redis-like operations as server/store.js:
-- get, set [px] [nx], del, pexpire, pttl, incr, hset, hgetall, rpush, lrange,
-- drain). The server calls it over Supabase's REST API.
--
-- Security:
--   * Both tables have row level security on and no policies, and all table
--     privileges are revoked from the API roles, so the tables cannot be read
--     or written through the REST API directly.
--   * The function is SECURITY DEFINER and refuses to run unless p_secret
--     matches the value stored in screenview_config (key 'secret'). Only the
--     ScreenView server knows it (Vercel env SCREENVIEW_STORE_SECRET); it is
--     never sent to browsers and is not in this file.
--
-- Values: strings are stored as JSON strings, hashes as JSON objects and lists
-- as JSON arrays. exp is an absolute expiry in epoch milliseconds (null = none).

create table if not exists public.screenview_kv (
  k   text primary key,
  v   jsonb not null,
  exp bigint
);
create index if not exists screenview_kv_exp_idx on public.screenview_kv (exp);

create table if not exists public.screenview_config (
  k text primary key,
  v text not null
);

alter table public.screenview_kv enable row level security;
alter table public.screenview_config enable row level security;
revoke all on table public.screenview_kv from anon, authenticated;
revoke all on table public.screenview_config from anon, authenticated;

create or replace function public.screenview_exec(p_secret text, p_cmd jsonb, p_now bigint default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  t      bigint := coalesce(p_now, floor(extract(epoch from clock_timestamp()) * 1000)::bigint);
  op     text   := p_cmd->>0;
  key    text   := p_cmd->>1;
  px     bigint;
  maxlen int;
  n      bigint;
  rv     jsonb;
  rexp   bigint;
begin
  if p_secret is null
     or p_secret is distinct from (select c.v from screenview_config c where c.k = 'secret') then
    raise exception 'screenview: unauthorized' using errcode = '28000';
  end if;

  -- Occasionally sweep expired rows so the table stays small.
  if random() < 0.01 then
    delete from screenview_kv where exp is not null and exp <= t;
  end if;

  case op
  when 'get' then
    select kv.v into rv from screenview_kv kv
      where kv.k = key and (kv.exp is null or kv.exp > t);
    if rv is null or jsonb_typeof(rv) <> 'string' then return 'null'::jsonb; end if;
    return rv;

  when 'set' then  -- [op, key, value, px|null, nx]
    px := (p_cmd->>3)::bigint;
    if coalesce((p_cmd->>4)::boolean, false) then
      insert into screenview_kv as kv (k, v, exp)
        values (key, to_jsonb(p_cmd->>2), case when px > 0 then t + px end)
      on conflict (k) do update set v = excluded.v, exp = excluded.exp
        where kv.exp is not null and kv.exp <= t;
      get diagnostics n = row_count;
      return to_jsonb(n > 0);
    end if;
    insert into screenview_kv as kv (k, v, exp)
      values (key, to_jsonb(p_cmd->>2), case when px > 0 then t + px end)
    on conflict (k) do update set v = excluded.v, exp = excluded.exp;
    return 'true'::jsonb;

  when 'del' then  -- [op, key, key, ...]
    delete from screenview_kv where k in (select jsonb_array_elements_text(p_cmd - 0));
    return 'null'::jsonb;

  when 'pexpire' then  -- [op, key, ms]
    update screenview_kv set exp = t + (p_cmd->>2)::bigint
      where k = key and (exp is null or exp > t);
    return 'null'::jsonb;

  when 'pttl' then
    select kv.v, kv.exp into rv, rexp from screenview_kv kv
      where kv.k = key and (kv.exp is null or kv.exp > t);
    if rv is null then return '-2'::jsonb; end if;
    if rexp is null then return '-1'::jsonb; end if;
    return to_jsonb(greatest(0, rexp - t));

  when 'incr' then  -- [op, key, px|null]; px starts a window on the first increment
    px := (p_cmd->>2)::bigint;
    insert into screenview_kv as kv (k, v, exp)
      values (key, to_jsonb('1'::text), case when px > 0 then t + px end)
    on conflict (k) do update set
      v   = case when kv.exp is not null and kv.exp <= t then excluded.v
                 else to_jsonb(((kv.v #>> '{}')::bigint + 1)::text) end,
      exp = case when kv.exp is not null and kv.exp <= t then excluded.exp else kv.exp end
    returning (kv.v #>> '{}')::bigint into n;
    return to_jsonb(n);

  when 'hset' then  -- [op, key, field, value, px|null]
    px := (p_cmd->>4)::bigint;
    insert into screenview_kv as kv (k, v, exp)
      values (key, jsonb_build_object(p_cmd->>2, p_cmd->>3), case when px > 0 then t + px end)
    on conflict (k) do update set
      v   = (case when (kv.exp is not null and kv.exp <= t) or jsonb_typeof(kv.v) <> 'object'
                  then '{}'::jsonb else kv.v end) || excluded.v,
      exp = case when px > 0 then excluded.exp
                 when kv.exp is not null and kv.exp <= t then null
                 else kv.exp end;
    return 'null'::jsonb;

  when 'hgetall' then
    select kv.v into rv from screenview_kv kv
      where kv.k = key and (kv.exp is null or kv.exp > t);
    if rv is null or jsonb_typeof(rv) <> 'object' then return '{}'::jsonb; end if;
    return rv;

  when 'rpush' then  -- [op, key, value, px|null, max|null]
    px := (p_cmd->>3)::bigint;
    maxlen := (p_cmd->>4)::int;
    insert into screenview_kv as kv (k, v, exp)
      values (key, jsonb_build_array(p_cmd->>2), case when px > 0 then t + px end)
    on conflict (k) do update set
      v   = (case when (kv.exp is not null and kv.exp <= t) or jsonb_typeof(kv.v) <> 'array'
                  then '[]'::jsonb else kv.v end) || excluded.v,
      exp = case when px > 0 then excluded.exp
                 when kv.exp is not null and kv.exp <= t then null
                 else kv.exp end;
    if maxlen > 0 then
      update screenview_kv set v = (
        select coalesce(jsonb_agg(e order by i), '[]'::jsonb)
        from jsonb_array_elements(v) with ordinality as a(e, i)
        where i > jsonb_array_length(v) - maxlen
      ) where k = key and jsonb_array_length(v) > maxlen;
    end if;
    return 'null'::jsonb;

  when 'lrange' then
    select kv.v into rv from screenview_kv kv
      where kv.k = key and (kv.exp is null or kv.exp > t);
    if rv is null or jsonb_typeof(rv) <> 'array' then return '[]'::jsonb; end if;
    return rv;

  when 'drain' then  -- atomically read and empty a list (a mailbox)
    delete from screenview_kv kv where kv.k = key returning kv.v, kv.exp into rv, rexp;
    if rv is null or (rexp is not null and rexp <= t) or jsonb_typeof(rv) <> 'array' then
      return '[]'::jsonb;
    end if;
    return rv;

  else
    raise exception 'screenview: unknown command %', op using errcode = '22023';
  end case;
end;
$$;

revoke all on function public.screenview_exec(text, jsonb, bigint) from public;
grant execute on function public.screenview_exec(text, jsonb, bigint) to anon, authenticated, service_role;
