import { Edit, Plus, Save, Store, Trash2 } from "lucide-react";
import type { Branch } from "../../types";

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
    <div className="bg-secondary rounded-2xl shadow-sm border border-base p-5 space-y-4">
      <div className="flex items-center gap-3 border-b border-base pb-3">
        <div className="bg-rose-50 dark:bg-rose-950/30 p-2 rounded-lg text-rose-600 dark:text-rose-400">
          <Store size={16} />
        </div>
        <div>
          <h3 className="text-xs font-black text-primary uppercase tracking-wider">
            Almacenes
          </h3>
          <p className="text-[8px] font-bold text-muted uppercase tracking-tight">
            Gestión de Ubicaciones
          </p>
        </div>
      </div>

      <div className="space-y-3">
        <div className="max-h-48 overflow-y-auto space-y-1.5 pr-1 custom-scrollbar">
          {branches.map((branch) => (
            <div
              key={branch.id}
              className="flex justify-between items-center bg-subtle p-2 rounded-xl border border-base group"
            >
              <div className="text-[11px] font-black text-primary uppercase tracking-tight break-words leading-snug flex-1 min-w-0 mr-2">
                {branch.name}
              </div>
              <div className="flex gap-1 shrink-0 ml-1">
                <button
                  type="button"
                  onClick={() => {
                    setEditingBranch(branch);
                    setNewBranchName(branch.name);
                  }}
                  className="p-1.5 text-muted hover:text-rose-600 rounded-lg transition-colors cursor-pointer"
                  title="Editar"
                >
                  <Edit size={13} />
                </button>
                {branches.length > 1 && (
                  <button
                    type="button"
                    onClick={() =>
                      setBranchToDelete({ id: branch.id, name: branch.name })
                    }
                    className="p-1.5 text-muted hover:text-rose-500 rounded-lg transition-colors cursor-pointer"
                    title="Eliminar"
                  >
                    <Trash2 size={13} />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>

        <div className="space-y-3">
          <div className="flex gap-2">
            <input
              type="text"
              value={newBranchName}
              onChange={(e) => setNewBranchName(e.target.value)}
              placeholder="Nombre"
              className="flex-1 min-w-0 px-3 py-2 bg-primary border border-base rounded-xl text-xs font-bold text-primary outline-none focus:ring-1 focus:ring-rose-500"
            />
            <button
              type="button"
              onClick={onAddBranch}
              disabled={limitReached}
              title={limitReached ? `Has alcanzado el límite de ${warehouseLimit} almacén${warehouseLimit === 1 ? "" : "es"} del plan.` : undefined}
              className="p-2 bg-rose-600 text-white rounded-xl hover:bg-rose-700 active:scale-95 transition-all shrink-0 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-rose-600"
            >
              {editingBranch ? <Save size={16} /> : <Plus size={16} />}
            </button>
          </div>
          {limitReached && (
            <p className="text-[9px] font-bold text-rose-600 dark:text-rose-400">
              Has alcanzado el límite de {warehouseLimit} almacén{warehouseLimit === 1 ? "" : "es"} de {warehousePlanName || "tu plan"}.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
