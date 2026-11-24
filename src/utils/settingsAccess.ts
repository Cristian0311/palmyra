// Secciones reales de Configuración. Los slugs retirados (lan, connectivity,
// advanced, piloto, «Salud local») ya no forman parte del contrato: cualquier
// enlace viejo cae en «Empresa» (o en «Notificaciones» sin permisos) en lugar
// de dejar una pestaña fantasma.
export const SETTINGS_SECTIONS = ['company', 'branches', 'categories', 'currency', 'ticket', 'visual', 'notifications'] as const;
export type SettingsSection = typeof SETTINGS_SECTIONS[number];
export const NOTIFICATIONS_PATH = '/settings?section=notifications';

type SettingsUser = { role?: string; permissions?: string[] } | null | undefined;
export function canManageSettings(user: SettingsUser): boolean {
  return user?.role === 'admin' || user?.permissions?.includes('settings.manage') === true;
}
export function canAccessSettingsSection(user: SettingsUser, section: string | null): boolean {
  return Boolean(user) && (canManageSettings(user) || section === 'notifications');
}
export function resolveSettingsSection(user: SettingsUser, section: string | null): SettingsSection {
  if (!canManageSettings(user)) return 'notifications';
  return SETTINGS_SECTIONS.includes(section as SettingsSection) ? section as SettingsSection : 'company';
}
