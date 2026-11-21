import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Check,
  Copy,
  Laptop,
  Monitor,
  Pencil,
  QrCode,
  RefreshCw,
  Router,
  Server,
  Smartphone,
  Tablet,
  Trash2,
  Wifi,
  WifiOff,
  X
} from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { cn } from '../../lib/utils';
import { SettingsSectionHeader } from './SettingsSectionHeader';
import {
  fetchLanSnapshot,
  forgetLanDevice,
  getDeviceId,
  renameLanDevice,
  setDeviceName,
  updateLanAccess,
  type LanDevice,
  type LanSnapshot
} from '../../services/lanPresence';

type Toast = (message: string, type?: 'success' | 'error' | 'info') => void;
type Props = { active: boolean; onToast: Toast };

const REFRESH_MS = 15000;

function deviceIcon(kind: LanDevice['kind']) {
  if (kind === 'mobile') return Smartphone;
  if (kind === 'tablet') return Tablet;
  if (kind === 'desktop') return Monitor;
  return Laptop;
}

function relative(iso: string) {
  const diff = Date.now() - Date.parse(iso);
  if (!Number.isFinite(diff)) return '—';
  if (diff < 20000) return 'ahora mismo';
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return `hace ${Math.max(1, Math.floor(diff / 1000))} s`;
  if (minutes < 60) return `hace ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `hace ${hours} h`;
  return `hace ${Math.floor(hours / 24)} d`;
}

export default function SettingsLanSection({ active, onToast }: Props) {
  const [snapshot, setSnapshot] = useState<LanSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState('');
  const [savingName, setSavingName] = useState(false);
  const [forgetId, setForgetId] = useState<string | null>(null);
  const [togglingAccess, setTogglingAccess] = useState(false);
  const deviceId = getDeviceId();

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const data = await fetchLanSnapshot();
      setSnapshot(data);
      setError('');
      return data;
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'No se pudo consultar la red local.');
      return null;
    } finally {
      if (!quiet) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    void load();
    const timer = window.setInterval(() => { void load(true); }, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [active, load]);

  const lanUrl = useMemo(() => {
    if (typeof window === 'undefined') return null;
    const local = ['localhost', '127.0.0.1'].includes(window.location.hostname);
    if (!local) return window.location.origin;
    return snapshot?.status.url || null;
  }, [snapshot]);

  if (!active) return null;

  const devices = snapshot?.devices || [];
  const onlineCount = devices.filter(device => device.online).length;

  const handleCopy = async () => {
    if (!lanUrl) return;
    try {
      await navigator.clipboard.writeText(lanUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2200);
    } catch {
      onToast('El navegador no permitió copiar la dirección.', 'error');
    }
  };

  const handleToggleAccess = async () => {
    if (!snapshot) return;
    setTogglingAccess(true);
    try {
      const status = await updateLanAccess(!snapshot.status.desired);
      setSnapshot(current => current ? { ...current, status } : current);
      if (status.desired && status.requiresRestart) {
        onToast('Acceso LAN activado. Reinicia PALMYRA POS para que otros equipos puedan conectarse.', 'info');
      } else if (!status.desired) {
        onToast('Acceso LAN desactivado. Reinicia PALMYRA POS para cerrar la red.', 'info');
      } else {
        onToast('Configuración de red guardada.');
      }
    } catch (toggleError) {
      onToast(toggleError instanceof Error ? toggleError.message : 'No se pudo cambiar el acceso LAN.', 'error');
    } finally {
      setTogglingAccess(false);
    }
  };

  const startRename = (device: LanDevice) => {
    setEditingId(device.id);
    setNameDraft(device.name);
    setForgetId(null);
  };

  const commitRename = async (device: LanDevice) => {
    const name = nameDraft.trim();
    if (!name) {
      onToast('El nombre no puede quedar vacío.', 'error');
      return;
    }
    if (name === device.name) {
      setEditingId(null);
      return;
    }
    setSavingName(true);
    try {
      const data = await renameLanDevice(device.id, name);
      setSnapshot(data);
      if (device.id === deviceId) setDeviceName(name);
      setEditingId(null);
      onToast('Nombre de la máquina actualizado.');
    } catch (renameError) {
      onToast(renameError instanceof Error ? renameError.message : 'No se pudo renombrar el equipo.', 'error');
    } finally {
      setSavingName(false);
    }
  };

  const commitForget = async (device: LanDevice) => {
    try {
      const data = await forgetLanDevice(device.id);
      setSnapshot(data);
      setForgetId(null);
      onToast('Equipo olvidado. Volverá a aparecer si se conecta de nuevo.');
    } catch (forgetError) {
      onToast(forgetError instanceof Error ? forgetError.message : 'No se pudo olvidar el equipo.', 'error');
    }
  };

  return (
    <div className="space-y-4 min-w-0">
      <section className="rounded-2xl border border-base bg-secondary p-3 sm:p-5 shadow-sm space-y-4 min-w-0">
        <SettingsSectionHeader
          icon={Router}
          title="Acceso desde otros equipos"
          subtitle="Abre PALMYRA desde un móvil, tablet o PC conectado al mismo Wi-Fi del negocio."
          action={snapshot?.status.desktop ? (
            <button
              type="button"
              role="switch"
              aria-checked={snapshot.status.desired}
              aria-label="Permitir acceso LAN"
              onClick={handleToggleAccess}
              disabled={togglingAccess}
              className="relative h-11 w-12 shrink-0 rounded-full disabled:opacity-60"
            >
              <span className={cn('absolute left-0 top-1/2 h-7 w-12 -translate-y-1/2 rounded-full border transition-colors', snapshot.status.desired ? 'bg-violet-600 border-violet-600' : 'bg-slate-300 border-slate-400 dark:bg-slate-600 dark:border-slate-500')}>
                <span className={cn('absolute top-[3px] h-[22px] w-[22px] rounded-full bg-white shadow transition-all', snapshot.status.desired ? 'left-[23px]' : 'left-[3px]')} />
              </span>
            </button>
          ) : undefined}
        />

        {error && (
          <p role="alert" className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm font-medium text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
            {error} El POS sigue funcionando normalmente sin red local.
          </p>
        )}

        {snapshot?.status.requiresRestart && (
          <p className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm font-medium leading-6 text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
            Hay un cambio pendiente de red. Cierra y vuelve a abrir PALMYRA POS para aplicarlo.
          </p>
        )}

        <div className="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_176px] gap-4 items-start">
          <div className="space-y-3 min-w-0">
            <div>
              <span className="mb-1.5 block text-sm font-semibold text-muted">Dirección para otros dispositivos</span>
              {lanUrl ? (
                <div className="flex items-stretch gap-2">
                  <div className="flex-1 min-w-0 rounded-xl border border-base bg-primary px-3 py-2.5 font-mono text-[12px] font-bold text-violet-700 dark:text-violet-300 break-all">
                    {lanUrl}
                  </div>
                  <button
                    type="button"
                    onClick={handleCopy}
                    className="shrink-0 h-11 px-3 rounded-xl bg-violet-600 text-white text-sm font-semibold flex items-center gap-1.5 hover:bg-violet-700 transition-colors"
                  >
                    {copied ? <Check size={15} /> : <Copy size={15} />} {copied ? 'Copiado' : 'Copiar'}
                  </button>
                </div>
              ) : (
                <div className="rounded-xl border border-dashed border-base bg-primary px-3 py-4 text-sm font-medium leading-6 text-muted">
                  {snapshot?.status.desktop
                    ? 'Activa el acceso LAN y reinicia PALMYRA POS para obtener una dirección de red.'
                    : 'Este servidor no está expuesto en la red local.'}
                </div>
              )}
            </div>
            <dl className="grid grid-cols-2 gap-2 text-sm">
              <div className="rounded-xl border border-base bg-primary p-2.5 min-w-0">
                <dt className="text-sm font-medium text-muted">Puerto</dt>
                <dd className="font-black text-primary tabular-nums">{snapshot?.status.port ?? '—'}</dd>
              </div>
              <div className="rounded-xl border border-base bg-primary p-2.5 min-w-0">
                <dt className="text-sm font-medium text-muted">Equipos en línea</dt>
                <dd className="font-black text-primary tabular-nums">{onlineCount} de {devices.length}</dd>
              </div>
              {snapshot?.status.addresses?.length ? (
                <div className="col-span-2 rounded-xl border border-base bg-primary p-2.5 min-w-0">
                  <dt className="text-sm font-medium text-muted">IP de este servidor</dt>
                  <dd className="font-bold text-primary break-all">{snapshot.status.addresses.join(' · ')}</dd>
                </div>
              ) : null}
            </dl>
          </div>

          <div className="rounded-2xl border border-base bg-primary p-3 flex flex-col items-center justify-center gap-2 self-stretch">
            {lanUrl ? (
              <>
                <div className="rounded-xl bg-white p-2 shadow-sm">
                  <QRCodeSVG value={lanUrl} size={128} level="M" />
                </div>
                <span className="flex items-center gap-1 text-sm font-medium text-muted"><QrCode size={13} /> Escanea para abrir</span>
              </>
            ) : (
              <div className="flex flex-col items-center gap-2 py-6 text-center">
                <WifiOff size={26} className="text-muted" />
                <span className="text-sm font-medium leading-5 text-muted">Sin dirección LAN activa</span>
              </div>
            )}
          </div>
        </div>

        <p className="rounded-xl border border-base bg-subtle p-3 text-sm font-medium leading-6 text-secondary">
          Cada dispositivo mantiene su propia copia local y sincroniza por la nube cuando tiene internet. El acceso LAN comparte la misma aplicación web,
          no copia datos entre equipos. Actívalo solo en una red de confianza: PALMYRA sigue pidiendo iniciar sesión.
        </p>
      </section>

      <section className="rounded-2xl border border-base bg-secondary p-3 sm:p-5 shadow-sm space-y-3 min-w-0">
        <SettingsSectionHeader
          icon={Server}
          title="Máquinas conectadas"
          subtitle="Renombra cada equipo para reconocerlo en el negocio."
          action={
            <button
              type="button"
              onClick={() => void load()}
              disabled={loading}
              className="h-11 px-3 rounded-xl border border-base bg-primary text-primary text-sm font-semibold flex items-center gap-1.5 hover:bg-subtle disabled:opacity-50 transition-colors"
            >
              <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> Actualizar
            </button>
          }
        />

        {loading && !snapshot ? (
          <div className="rounded-xl border border-base bg-primary px-4 py-10 text-center">
            <RefreshCw size={22} className="mx-auto animate-spin text-violet-600" />
            <p className="mt-2 text-sm font-medium text-muted">Consultando los equipos de la red local…</p>
          </div>
        ) : devices.length === 0 ? (
          <div className="rounded-xl border border-dashed border-base bg-primary px-4 py-8 text-center">
            <Server size={24} className="mx-auto text-muted" />
            <p className="mt-2 text-sm font-medium leading-6 text-muted">
              Aún no hay equipos registrados. Este equipo aparecerá al abrir PALMYRA con sesión iniciada.
            </p>
          </div>
        ) : (
          <ul className="space-y-2">
            {devices.map(device => {
              const Icon = deviceIcon(device.kind);
              const isCurrent = device.id === deviceId;
              const editing = editingId === device.id;
              return (
                <li key={device.id} className="rounded-xl border border-base bg-primary p-3">
                  <div className="flex items-start gap-3 min-w-0">
                    <div className={cn('mt-0.5 rounded-lg border p-2 shrink-0', device.online ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/50 dark:bg-emerald-950/30 dark:text-emerald-300' : 'border-base bg-subtle text-muted')}>
                      <Icon size={16} />
                    </div>
                    <div className="flex-1 min-w-0 space-y-1">
                      {editing ? (
                        <div className="flex flex-col sm:flex-row gap-2">
                          <input
                            autoFocus
                            value={nameDraft}
                            maxLength={60}
                            onChange={event => setNameDraft(event.target.value)}
                            onKeyDown={event => {
                              if (event.key === 'Enter') void commitRename(device);
                              if (event.key === 'Escape') setEditingId(null);
                            }}
                            className="flex-1 min-w-0 h-11 rounded-xl border border-base bg-subtle px-3 text-sm font-semibold text-primary outline-none focus:ring-1 focus:ring-violet-500"
                            aria-label="Nombre de la máquina"
                          />
                          <div className="flex gap-1.5 shrink-0">
                            <button type="button" onClick={() => void commitRename(device)} disabled={savingName} className="h-11 px-3 rounded-xl bg-violet-600 text-white text-sm font-semibold flex items-center gap-1.5 hover:bg-violet-700 disabled:opacity-60">
                              <Check size={14} /> Guardar
                            </button>
                            <button type="button" onClick={() => setEditingId(null)} className="h-11 w-11 rounded-xl border border-base text-muted flex items-center justify-center hover:bg-subtle" aria-label="Cancelar cambio de nombre">
                              <X size={16} />
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className="flex flex-wrap items-center gap-1.5 min-w-0">
                          <span className="text-xs font-black text-primary break-words min-w-0">{device.name}</span>
                          {isCurrent && <span className="rounded-full bg-violet-100 px-2 py-0.5 text-sm font-semibold text-violet-700 dark:bg-violet-950/40 dark:text-violet-300">Este equipo</span>}
                          <span className={cn('rounded-full px-2 py-0.5 text-sm font-semibold', device.online ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300' : 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300')}>
                            {device.online ? 'En línea' : 'Desconectado'}
                          </span>
                        </div>
                      )}
                      <p className="flex flex-wrap gap-x-3 gap-y-0.5 text-sm font-medium text-muted">
                        {device.ip && <span className="break-all">{device.ip}</span>}
                        <span className={device.online ? 'inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-300' : ''}>
                          {device.online ? <Wifi size={11} /> : null}{relative(device.lastSeen)}
                        </span>
                        {device.warehouseName && <span>Almacén: {device.warehouseName}</span>}
                      </p>
                      {!editing && (
                        <div className="flex flex-wrap gap-2 pt-1">
                          <button type="button" onClick={() => startRename(device)} className="h-11 px-3 rounded-xl border border-base text-sm font-semibold text-primary flex items-center gap-1.5 hover:bg-subtle">
                            <Pencil size={13} /> Renombrar
                          </button>
                          {!isCurrent && (forgetId === device.id ? (
                            <span className="flex items-center gap-1.5">
                              <button type="button" onClick={() => void commitForget(device)} className="h-11 px-3 rounded-xl bg-rose-600 text-white text-sm font-semibold hover:bg-rose-700">
                                Confirmar
                              </button>
                              <button type="button" onClick={() => setForgetId(null)} className="h-11 px-3 rounded-xl border border-base text-sm font-semibold text-primary hover:bg-subtle">
                                Cancelar
                              </button>
                            </span>
                          ) : (
                            <button type="button" onClick={() => setForgetId(device.id)} className="h-11 px-3 rounded-xl border border-base text-sm font-semibold text-muted flex items-center gap-1.5 hover:bg-subtle">
                              <Trash2 size={13} /> Olvidar
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        <p className="text-sm font-medium leading-6 text-muted">
          Los equipos sin conexión permanecen siete días en esta lista. “Olvidar” solo borra el registro; no cambia la configuración de esa máquina.
        </p>
      </section>
    </div>
  );
}
