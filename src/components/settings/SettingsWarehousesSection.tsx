import { Edit, Plus, Save, Store, Trash2 } from "lucide-react";
import type { Branch } from "../../types";
import { SettingsSectionHeader } from "./SettingsSectionHeader";

type Props = {
  active: boolean;
  branches: Branch[];
  editingBranch: Branch | null;
  newBranchName: string;
  setEditingBranch: (branch: Branch | null) => void;
  setNewBranchName: (name: string) => void;
  setBranchToDelete: (value: { id: string; name: string } | null) => void;
  onAddBranch: () => void;
  warehouseLimit?: number | null;
  warehousePlanName?: string;
};

export function SettingsWarehousesSection({
  active,
  branches,
  editingBranch,
  newBranchName,
  setEditingBranch,
  setNewBranchName,
  setBranchToDelete,
  onAddBranch,
  warehouseLimit = null,
  warehousePlanName = "",
}: Props) {
  if (!active) return null;

  const activeWarehouseCount = branches.filter((branch) => branch.isActive !== false).length;
  const limitReached =
    warehouseLimit !== null &&
    activeWarehouseCount >= warehouseLimit &&
    !editingBranch;

  return (
    <div className="bg-secondary rounded-2xl shadow-sm border border-base p-3 sm:p-5 space-y-4">
      <SettingsSectionHeader
        icon={Store}
        title="Almacenes"
        subtitle="Ubicaciones de inventario del negocio. Cada venta y traslado usa el almacén activo."
      />

      <div className="space-y-3">
        <div className="max-h-48 overflow-y-auto space-y-1.5 pr-1 custom-scrollbar">
          {branches.map((branch) => (
            <div
              key={branch.id}
              className="flex justify-between items-center gap-2 bg-subtle py-1.5 pl-3 pr-1.5 rounded-xl border border-base group"
            >
              <div className="text-sm font-semibold text-primary break-words leading-snug flex-1 min-w-0">
                {branch.name}
              </div>
              <div className="flex gap-1 shrink-0">
                <button
                  type="button"
                  onClick={() => {
                    setEditingBranch(branch);
                    setNewBranchName(branch.name);
                  }}
                  className="flex h-11 w-11 items-center justify-center rounded-xl text-muted transition-colors hover:bg-primary hover:text-violet-600 cursor-pointer"
                  title="Editar"
                  aria-label={`Editar ${branch.name}`}
                >
                  <Edit size={16} />
                </button>
                {branches.length > 1 && (
                  <button
                    type="button"
                    onClick={() => setBranchToDelete({ id: branch.id, name: branch.name })}
                    className="flex h-11 w-11 items-center justify-center rounded-xl text-muted transition-colors hover:bg-primary hover:text-rose-500 cursor-pointer"
                    title="Eliminar"
                    aria-label={`Eliminar ${branch.name}`}
                  >
                    <Trash2 size={16} />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>

        <div className="space-y-3">
          {editingBranch && (
            <div className="flex items-center justify-between gap-2 rounded-xl border border-violet-200 bg-violet-50/60 p-2.5 dark:border-violet-900/50 dark:bg-violet-950/20">
              <p className="min-w-0 text-sm font-medium text-violet-900 dark:text-violet-100">
                Editando <strong className="break-words">{editingBranch.name}</strong>
              </p>
              <button
                type="button"
                onClick={() => {
                  setEditingBranch(null);
                  setNewBranchName("");
                }}
                className="h-11 shrink-0 rounded-xl border border-violet-200 px-3 text-sm font-semibold text-violet-700 dark:border-violet-900/50 dark:text-violet-200"
              >
                Cancelar
              </button>
            </div>
          )}
          <div className="flex gap-2">
            <input
              type="text"
              value={newBranchName}
              onChange={(e) => setNewBranchName(e.target.value)}
              placeholder={editingBranch ? "Nuevo nombre del almacén" : "Nombre del almacén"}
              className="flex-1 min-w-0 h-11 px-3 bg-primary border border-base rounded-xl text-sm font-semibold text-primary outline-none focus:ring-1 focus:ring-violet-500"
            />
            <button
              type="button"
              onClick={onAddBranch}
              disabled={limitReached}
              title={limitReached ? `Has alcanzado el límite de ${warehouseLimit} almacén${warehouseLimit === 1 ? "" : "es"} del plan.` : editingBranch ? "Guardar nombre" : "Agregar almacén"}
              className="h-11 w-11 bg-violet-600 text-white rounded-xl hover:bg-violet-700 active:scale-95 transition-all shrink-0 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed flex items-center justify-center"
            >
              {editingBranch ? <Save size={16} /> : <Plus size={16} />}
            </button>
          </div>
          {limitReached && (
            <p className="text-sm font-medium text-rose-600 dark:text-rose-400">
              Has alcanzado el límite de {warehouseLimit} almacén{warehouseLimit === 1 ? "" : "es"} de {warehousePlanName || "tu plan"}.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
