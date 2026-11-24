-- PENDIENTE DE APLICAR
-- Drena `local_change_inbox` hacia las tablas de negocio cada 2 minutos.
--
-- Sin este programador los cambios que los equipos empujan a la nube quedarían
-- en estado `pending` para siempre. La función es idempotente por
-- (company_id, seq), reintenta hijas que llegan antes que el padre y solo
-- requiere el secreto de worker, que ya vive en Vault.
--
-- Idempotente: si el job ya existe no se vuelve a crear.
begin;

do $migration$
begin
  if not exists (select 1 from cron.job where jobname = 'palmyra-materialize-local-changes') then
    perform cron.schedule(
      'palmyra-materialize-local-changes',
      '*/2 * * * *',
      $job$
        select net.http_post(
          url := (select decrypted_secret from vault.decrypted_secrets where name = 'PALMYRA_PROJECT_URL')
                 || '/functions/v1/materialize-local-changes',
          headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'x-worker-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'PALMYRA_NOTIFICATION_WORKER_SECRET')
          ),
          body := jsonb_build_object('p_limit', 200, 'max_batches', 10),
          timeout_milliseconds := 25000
        ) as request_id;
      $job$
    );
  end if;
end
$migration$;

commit;
