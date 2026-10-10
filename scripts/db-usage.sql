-- Run in Supabase Dashboard -> SQL Editor. Read-only.
-- Free plan limit: 500 MB database size.
select pg_size_pretty(pg_database_size(current_database())) as total_database_size;

select
  n.nspname as schema,
  c.relname as table,
  pg_size_pretty(pg_total_relation_size(c.oid)) as total_size,
  pg_size_pretty(pg_relation_size(c.oid)) as table_size,
  pg_size_pretty(pg_total_relation_size(c.oid) - pg_relation_size(c.oid)) as index_and_toast,
  c.reltuples::bigint as approx_rows
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where c.relkind = 'r'
  and n.nspname not in ('pg_catalog', 'information_schema')
order by pg_total_relation_size(c.oid) desc
limit 25;
