import { useCallback, useEffect, useRef, useState } from "react";
import { canRunPos, currentAppSurface } from "../lib/appSurface";
import { getSupabase } from "../lib/supabase";
import { createCloudSync } from "../services/cloudSync/sync";
import {
  createCloudSyncRunner,
  type CloudSyncRunnerStatus,
  type CloudSyncRunner
} from "../services/cloudSync/runner";
import { createSupabaseCloudTransport } from "../services/cloudSync/supabaseTransport";
import { createSupabasePullTransport } from "../services/cloudSync/pullRemote";
import { createCloudPull } from "../services/cloudSync/pullEngine";
import {
  createLocalStorageBudgetStore,
  createLocalStorageCursorStore,
  createLocalStoragePullCursorStore
} from "../services/cloudSync/stores";
import { getRuntimeDriver } from "../services/localDb/runtimeDriver";
import type { LocalDbDriver } from "../services/localDb/contract";
import { getPalmyraLocalScope } from "../services/localScope";

/**
 * Sincronización con la nube en la app instalada.
 *
 * El almacén local es la fuente de verdad: el motor sube el journal posterior
 * al cursor confirmado y descarga a lo sumo una ventana cada 30 minutos, con
 * lote pequeño y presupuesto diario. En la web de registro (`web-tab`) no se
 * sincroniza nada porque no hay negocio: `syncNow` también queda inerte.
 * El runner y el driver son únicos por pestaña para no duplicar solicitudes.
 */

interface ActiveSync {
  key: string;
  runner: CloudSyncRunner;
  driver: LocalDbDriver;
}

export interface UseCloudSyncResult {
  /** Último estado reportado por el planificador (`null` si aún no hubo tick). */
  status: CloudSyncRunnerStatus | null;
  /** El planificador está montado para la empresa activa. */
  running: boolean;
  /** Hay una sincronización manual en curso. */
  syncing: boolean;
  /** Fuerza subida + descarga ahora, ignorando presupuesto e intervalos. */
  syncNow: () => Promise<void>;
}

let active: ActiveSync | null = null;
let generation = 0;
let statusListener: ((status: CloudSyncRunnerStatus) => void) | null = null;

async function startFor(companyId: string): Promise<void> {
  if (active?.key === companyId) {
    if (!active.runner.running) await active.runner.start();
    return;
  }
  stopActive();

  if (!canRunPos(currentAppSurface())) return;
  const client = getSupabase();
  if (!client) return;

  const gen = generation;
  try {
    // El driver es compartido con la escritura en sombra: nadie lo cierra aquí.
    const driver = await getRuntimeDriver();
    if (gen !== generation) return;
    const sync = createCloudSync({
      driver,
      transport: createSupabaseCloudTransport({ client }),
      cursors: createLocalStorageCursorStore(),
      budget: createLocalStorageBudgetStore(),
      companyId
    });
    const pull = createCloudPull({
      driver,
      transport: createSupabasePullTransport({ client }),
      cursors: createLocalStoragePullCursorStore(),
      companyId
    });
    const runner = createCloudSyncRunner({
      sync,
      pull,
      onStatus: (status) => {
        try {
          statusListener?.(status);
        } catch {
          // Un consumidor de estado no debe tumbar el planificador.
        }
      }
    });
    active = { key: companyId, runner, driver };
    await runner.start();
  } catch {
    // Sin almacén local no hay nada que sincronizar; nunca se rompe la app.
  }
}

function stopActive(): void {
  generation += 1;
  const current = active;
  active = null;
  if (!current) return;
  current.runner.stop();
}

/** Monta el sincronizador mientras dure la sesión de la empresa activa. */
export function useCloudSync(companyId?: string | null): UseCloudSyncResult {
  const [status, setStatus] = useState<CloudSyncRunnerStatus | null>(null);
  const [syncing, setSyncing] = useState(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    statusListener = (next) => {
      if (mounted.current) setStatus(next);
    };
    const target = companyId || getPalmyraLocalScope()?.companyId || "";
    if (!target) {
      return () => {
        mounted.current = false;
        statusListener = null;
      };
    }
    void startFor(target);
    return () => {
      mounted.current = false;
      statusListener = null;
      stopActive();
    };
  }, [companyId]);

  const syncNow = useCallback(async (): Promise<void> => {
    const runner = active?.runner;
    // En la web de registro no hay runner: la llamada es inocua.
    if (!runner) return;
    setSyncing(true);
    try {
      const result = await runner.syncNow();
      if (mounted.current) setStatus(result.status);
    } catch {
      // El planificador ya convierte los fallos en estado; nunca se propaga.
    } finally {
      if (mounted.current) setSyncing(false);
    }
  }, []);

  return { status, running: Boolean(active?.runner.running), syncing, syncNow };
}
