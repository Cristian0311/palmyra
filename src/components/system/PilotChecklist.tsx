import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, ListChecks, RotateCcw } from "lucide-react";
import { cn } from "../../lib/utils";
import { PRODUCT_DISPLAY_VERSION } from "../../lib/productVersion";
import { getPalmyraScopedStorageKey } from "../../services/localScope";

/**
 * Lista de comprobación del piloto F7-D.
 *
 * Siete pasos que el negocio marca a medida que los cumple. Todo vive en el
 * almacenamiento local del equipo: la tarjeta funciona sin internet y no hace
 * ninguna petición de red. Si existe un ámbito usuario/empresa se guarda por
 * ámbito; si no, queda en la clave global.
 */

export const PILOT_CHECKLIST_STORAGE_KEY = "palmyra:pilot-checklist:v1";

/** Tope defensivo: un valor mayor no puede ser un estado legítimo. */
const MAX_RAW_LENGTH = 4096;

export type PilotChecklistItemId =
  | "instalado"
  | "emparejado"
  | "respaldo-local"
  | "respaldo-nube"
  | "restauracion-prueba"
  | "update-usb"
  | "plan-fallo-hub";

export interface PilotChecklistItem {
  id: PilotChecklistItemId;
  title: string;
  detail: string;
  /** Sección del manual de campo que explica el paso. */
  manualSection: string;
  /** Ancla de esa sección en docs/PILOTO_MANUAL.md. */
  manualAnchor: string;
}

export const PILOT_CHECKLIST_ITEMS: readonly PilotChecklistItem[] = [
  {
    id: "instalado",
    title: "PALMYRA instalado en el PC principal",
    detail:
      `Windows 10/11, versión ${PRODUCT_DISPLAY_VERSION}, Diagnóstico de instalación sin errores y acceso LAN activo.`,
    manualSection: "2. Instalar en PC",
    manualAnchor: "instalar-en-pc",
  },
  {
    id: "emparejado",
    title: "Equipos emparejados por QR o por código",
    detail:
      "Cada caja aparece como Vinculada en Configuración → Red local, con su nombre en Máquinas conectadas.",
    manualSection: "4. Emparejar equipos por QR y manual",
    manualAnchor: "emparejar-equipos-por-qr-y-manual",
  },
  {
    id: "respaldo-local",
    title: "Respaldo local creado y guardado fuera del equipo",
    detail:
      "Archivo cifrado descargado con una frase propia y copiado a un USB o a otro lugar seguro.",
    manualSection: "6. Respaldar",
    manualAnchor: "respaldar",
  },
  {
    id: "respaldo-nube",
    title: "Respaldo en la nube activo con su clave guardada",
    detail:
      "El respaldo diario aparece en Días en la nube y la clave de recuperación está anotada fuera del equipo.",
    manualSection: "6. Respaldar",
    manualAnchor: "respaldar",
  },
  {
    id: "restauracion-prueba",
    title: "Restauración de prueba completada",
    detail:
      "Un respaldo se verificó y se restauró en un equipo de prueba sin perder ventas ni inventario.",
    manualSection: "7. Restaurar",
    manualAnchor: "restaurar",
  },
  {
    id: "update-usb",
    title: "Actualización por USB probada",
    detail:
      "El instalador o APK guardado se aplicó desde archivo en PC o Android y la versión instalada subió.",
    manualSection: "8. Actualizar",
    manualAnchor: "actualizar",
  },
  {
    id: "plan-fallo-hub",
    title: "Plan de fallo del hub leído y acordado",
    detail:
      "El dueño sabe qué hacer si el PC principal falla, quién restaura y cuánto puede venderse sin hub.",
    manualSection: "9. Si el hub falla",
    manualAnchor: "si-el-hub-falla",
  },
] as const;

const ITEM_IDS = new Set<string>(PILOT_CHECKLIST_ITEMS.map((item) => item.id));
const ITEM_ORDER = PILOT_CHECKLIST_ITEMS.map((item) => item.id);

export interface PilotChecklistStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

function defaultStorage(): PilotChecklistStorage | null {
  if (typeof localStorage === "undefined") return null;
  return localStorage;
}

/**
 * Clave de almacenamiento. `scopeKey` llega desde `getPalmyraLocalScopeKey()`
 * (`userId__companyId`) a través de `getPalmyraScopedStorageKey`.
 */
export function pilotChecklistStorageKey(scopeKey?: string | null): string {
  return scopeKey ? `${PILOT_CHECKLIST_STORAGE_KEY}__${scopeKey}` : PILOT_CHECKLIST_STORAGE_KEY;
}

function resolvePilotChecklistStorageKey(): string {
  try {
    const scoped = getPalmyraScopedStorageKey(PILOT_CHECKLIST_STORAGE_KEY);
    return scoped || PILOT_CHECKLIST_STORAGE_KEY;
  } catch {
    return PILOT_CHECKLIST_STORAGE_KEY;
  }
}

function canonical(ids: Iterable<string>): PilotChecklistItemId[] {
  const unique = new Set(ids);
  return ITEM_ORDER.filter((id) => unique.has(id));
}

/** Acepta el formato actual `{ version, done }` y el arreglo heredado. */
export function sanitizePilotChecklist(raw: string | null | undefined): PilotChecklistItemId[] {
  if (!raw || raw.length > MAX_RAW_LENGTH) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const done = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && Array.isArray((parsed as { done?: unknown }).done)
      ? ((parsed as { done: unknown[] }).done)
      : [];
  const ids = done.filter((value): value is string => typeof value === "string" && ITEM_IDS.has(value));
  return canonical(ids);
}

export function readPilotChecklist(
  storage: PilotChecklistStorage | null = defaultStorage(),
  key: string = resolvePilotChecklistStorageKey()
): PilotChecklistItemId[] {
  if (!storage) return [];
  try {
    return sanitizePilotChecklist(storage.getItem(key));
  } catch {
    return [];
  }
}

export function writePilotChecklist(
  done: readonly PilotChecklistItemId[],
  storage: PilotChecklistStorage | null = defaultStorage(),
  key: string = resolvePilotChecklistStorageKey()
): void {
  if (!storage) return;
  const clean = canonical(done);
  try {
    storage.setItem(
      key,
      JSON.stringify({ version: 1, done: clean, updatedAt: new Date().toISOString() })
    );
  } catch {
    // Sin cuota o sin almacenamiento la marca solo dura la sesión.
  }
}

export function resetPilotChecklist(
  storage: PilotChecklistStorage | null = defaultStorage(),
  key: string = resolvePilotChecklistStorageKey()
): void {
  if (!storage) return;
  try {
    if (typeof storage.removeItem === "function") storage.removeItem(key);
    else storage.setItem(key, JSON.stringify({ version: 1, done: [], updatedAt: new Date().toISOString() }));
  } catch {
    // Nada que limpiar si el almacenamiento no responde.
  }
}

export function togglePilotChecklistItem(
  done: readonly PilotChecklistItemId[],
  id: PilotChecklistItemId
): PilotChecklistItemId[] {
  const set = new Set(done);
  if (set.has(id)) set.delete(id);
  else set.add(id);
  return canonical(set);
}

/** Porcentaje entero 0-100 sin contar identificadores repetidos. */
export function checklistPercent(done: readonly string[]): number {
  const unique = new Set(done.filter((id) => ITEM_IDS.has(id)));
  const total = PILOT_CHECKLIST_ITEMS.length;
  if (total === 0) return 0;
  return Math.min(100, Math.max(0, Math.round((unique.size / total) * 100)));
}

export default function PilotChecklist() {
  const [done, setDone] = useState<PilotChecklistItemId[]>(() => readPilotChecklist());
  const [confirmReset, setConfirmReset] = useState(false);
  const [announcement, setAnnouncement] = useState("");

  useEffect(() => {
    writePilotChecklist(done);
  }, [done]);

  const total = PILOT_CHECKLIST_ITEMS.length;
  const completed = done.length;
  const percent = useMemo(() => checklistPercent(done), [done]);
  const finished = completed === total;

  const handleToggle = (id: PilotChecklistItemId) => {
    const next = togglePilotChecklistItem(done, id);
    setDone(next);
    const item = PILOT_CHECKLIST_ITEMS.find((entry) => entry.id === id);
    setAnnouncement(
      item
        ? `${next.includes(id) ? "Completado" : "Pendiente"}: ${item.title}. ${next.length} de ${total} pasos.`
        : `${next.length} de ${total} pasos.`
    );
  };

  const handleReset = () => {
    resetPilotChecklist();
    setDone([]);
    setConfirmReset(false);
    setAnnouncement("Lista del piloto reiniciada. Los 7 pasos quedaron pendientes.");
  };

  return (
    <section
      aria-labelledby="pilot-checklist-title"
      className="rounded-2xl border border-base bg-secondary p-3 shadow-sm sm:p-5 space-y-4 min-w-0"
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h3 id="pilot-checklist-title" className="flex items-center gap-2 text-base font-bold text-primary">
            <ListChecks size={18} className="shrink-0 text-violet-600" aria-hidden="true" />
            Lista del piloto
          </h3>
          <p className="mt-1 text-sm font-medium leading-6 text-muted">
            Marca cada paso cuando esté probado en el equipo real. Se guarda en este equipo y funciona sin
            internet.
          </p>
        </div>
        <span
          className={cn(
            "inline-flex shrink-0 items-center gap-1.5 self-start rounded-full px-2.5 py-1 text-sm font-semibold",
            finished
              ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300"
              : "bg-violet-100 text-violet-700 dark:bg-violet-950/40 dark:text-violet-300"
          )}
        >
          <CheckCircle2 size={14} aria-hidden="true" />
          {completed} de {total}
        </span>
      </div>

      <div className="space-y-1.5">
        <div
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          aria-valuetext={`${completed} de ${total} pasos completados`}
          aria-label="Progreso de la lista del piloto"
          className="h-2.5 w-full overflow-hidden rounded-full bg-subtle"
        >
          <div
            className={cn("h-full rounded-full transition-all", finished ? "bg-emerald-500" : "bg-violet-600")}
            style={{ width: `${percent}%` }}
          />
        </div>
        <p className="text-sm font-semibold text-muted">
          {finished ? "Piloto listo: los 7 pasos están comprobados." : `${percent} % completado`}
        </p>
      </div>

      <ul className="space-y-2">
        {PILOT_CHECKLIST_ITEMS.map((item) => {
          const checked = done.includes(item.id);
          return (
            <li key={item.id}>
              <div
                className={cn(
                  "flex items-start gap-3 rounded-xl border p-3 transition-colors",
                  checked ? "border-emerald-200 bg-emerald-50/60 dark:border-emerald-900/40 dark:bg-emerald-950/20" : "border-base bg-primary"
                )}
              >
                <input
                  id={`pilot-check-${item.id}`}
                  type="checkbox"
                  checked={checked}
                  onChange={() => handleToggle(item.id)}
                  aria-describedby={`pilot-detail-${item.id}`}
                  className="mt-0.5 h-5 w-5 shrink-0 cursor-pointer accent-violet-600"
                />
                <div className="min-w-0">
                  <label
                    htmlFor={`pilot-check-${item.id}`}
                    className="cursor-pointer text-sm font-bold leading-5 text-primary"
                  >
                    {item.title}
                  </label>
                  <p id={`pilot-detail-${item.id}`} className="mt-1 text-sm font-medium leading-5 text-muted">
                    {item.detail}
                  </p>
                </div>
              </div>
            </li>
          );
        })}
      </ul>

      <div className="flex flex-wrap items-center gap-2">
        {!confirmReset ? (
          <button
            type="button"
            onClick={() => setConfirmReset(true)}
            disabled={completed === 0}
            className="inline-flex h-11 items-center justify-center gap-1.5 rounded-xl border border-base bg-primary px-4 text-sm font-semibold text-primary transition-colors hover:bg-subtle disabled:opacity-50"
          >
            <RotateCcw size={15} aria-hidden="true" /> Reiniciar lista
          </button>
        ) : (
          <div
            role="alert"
            className="flex w-full flex-col gap-2 rounded-xl border border-rose-200 bg-rose-50 p-3 text-rose-800 dark:border-rose-900/40 dark:bg-rose-950/20 dark:text-rose-200 sm:flex-row sm:items-center sm:justify-between"
          >
            <p className="text-sm font-semibold leading-5">
              ¿Reiniciar la lista? Se borrarán las {completed} marcas de este equipo.
            </p>
            <div className="flex shrink-0 flex-wrap gap-2">
              <button
                type="button"
                onClick={handleReset}
                className="inline-flex h-11 items-center justify-center rounded-xl bg-rose-600 px-4 text-sm font-semibold text-white transition-colors hover:bg-rose-700"
              >
                Sí, reiniciar
              </button>
              <button
                type="button"
                onClick={() => setConfirmReset(false)}
                className="inline-flex h-11 items-center justify-center rounded-xl border border-base bg-primary px-4 text-sm font-semibold text-primary transition-colors hover:bg-subtle"
              >
                Cancelar
              </button>
            </div>
          </div>
        )}
      </div>

      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>
    </section>
  );
}
