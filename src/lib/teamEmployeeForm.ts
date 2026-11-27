/**
 * Equipo · textos y estado del formulario de trabajador.
 *
 * Módulo puro (sin red ni almacenamiento) para poder probarlo con `node:test`.
 * Nace del editor de empleado: el campo «Nueva contraseña del POS» aparecía
 * vacío y con pinta de obligatorio aunque el trabajador ya tuviera contraseña.
 * La contraseña no se puede mostrar (se guarda como hash en
 * `private.employee_pos_credentials`), así que el campo debe explicar su estado
 * real en vez de fingir que falta un dato.
 */

export type PosPasswordFieldStatus = 'missing' | 'defined' | 'typing';

export interface PosPasswordFieldCopy {
  /** true solo cuando el trabajador aún no tiene contraseña POS. */
  required: boolean;
  label: string;
  placeholder: string;
  status: PosPasswordFieldStatus;
  /** Chip de estado: nunca deja la impresión de un campo vacío por error. */
  statusLabel: string;
  helper: string;
}

/**
 * Textos del campo de contraseña POS.
 *
 * En edición se asume que la contraseña existe: `create_employee_pos_secure`
 * la exige al dar de alta y quien tiene cuenta web valida además con su
 * contraseña de cuenta. Por eso el campo se presenta como cambio opcional
 * («deja vacío para conservarla») y solo la creación lo marca obligatorio.
 */
export function describePosPasswordField(input: {
  editing: boolean;
  /** false únicamente cuando se sabe con certeza que no hay contraseña POS. */
  hasStoredPassword?: boolean;
  typing?: boolean;
}): PosPasswordFieldCopy {
  const editing = Boolean(input.editing);
  const stored = editing && (input.hasStoredPassword ?? true);
  const typing = Boolean(input.typing);

  if (!stored) {
    return {
      required: true,
      label: 'Contraseña del POS',
      placeholder: 'Mínimo 6 caracteres',
      status: 'missing',
      statusLabel: editing ? 'Contraseña actual: sin definir' : 'Sin contraseña POS todavía',
      helper: editing
        ? 'Este trabajador aún no tiene contraseña POS. Define una de al menos 6 caracteres; se guardará como hash seguro.'
        : 'Define una contraseña POS de al menos 6 caracteres; es obligatoria para operar. Puedes verla con el icono del ojo mientras escribes.'
    };
  }

  if (typing) {
    return {
      required: false,
      label: 'Nueva contraseña del POS',
      placeholder: 'Mínimo 6 caracteres',
      status: 'typing',
      statusLabel: 'Nueva contraseña lista para guardar',
      helper: 'Al guardar se reemplaza la contraseña actual; se almacena como hash seguro y no se podrá volver a mostrar.'
    };
  }

  return {
    required: false,
    label: 'Nueva contraseña del POS',
    placeholder: 'Vacío = conservar la contraseña actual',
    status: 'defined',
    statusLabel: 'Contraseña actual: definida · deja vacío para conservarla',
    helper: 'Se guarda como hash seguro y por eso no se puede mostrar. Déjalo vacío para conservarla o escribe una nueva (mínimo 6 caracteres).'
  };
}
