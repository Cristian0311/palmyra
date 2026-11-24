-- Retención de cron.job_run_details.
--
-- pg_cron no borra sus propias filas de ejecución: la tabla llegó a ~63 MB
-- (59% de la base). Aquí se poda todo lo anterior a 14 días en porciones (el
-- DELETE por ctid no bloquea los jobs en curso) y se programa una limpieza
-- semanal que mantiene el tope.
--
-- Idempotente: la poda es reejecutable y el job solo se crea si no existe.
begin;

do $prune$
begin
  loop
    delete from cron.job_run_details
    where ctid in (
      select ctid from cron.job_run_details
      where end_time < now() - interval '14 days'
      limit 50000
    );
    exit when not found;
  end loop;
end
$prune$;

select cron.schedule(
  'palmyra-cron-run-details-retention',
  '30 4 * * 1',
  $$ delete from cron.job_run_details where end_time < now() - interval '14 days' $$
)
where not exists (
  select 1 from cron.job where jobname = 'palmyra-cron-run-details-retention'
);

commit;
