import { useAndroidBackup } from "../../hooks/useAndroidBackup";

/**
 * Arranca el respaldo programado una sola vez por sesión.
 *
 * No pinta nada: la tarjeta de Configuración solo muestra el estado. El hook y
 * el candado de ejecución viven en el módulo, así que montar ambos no duplica
 * respaldos.
 */
export default function AndroidBackupRuntime() {
  useAndroidBackup();
  return null;
}
