import { Edit, LayoutGrid, Plus, Save, Trash2 } from "lucide-react";
import type { Category } from "../../types";
import { SettingsSectionHeader } from "./SettingsSectionHeader";

type Props = {
  active: boolean;
  categories: Category[];
  editingCategory: Category | null;
  newCategory: { name: string; department: string };
  setEditingCategory: (category: Category | null) => void;
  setNewCategory: (value: { name: string; department: string }) => void;
  setCategoryToDelete: (value: { id: string; name: string } | null) => void;
  onAddCategory: () => void;
};

export function SettingsCategoriesSection({
  active,
  categories,
  editingCategory,
  newCategory,
  setEditingCategory,
  setNewCategory,
  setCategoryToDelete,
  onAddCategory,
}: Props) {
  if (!active) return null;

  return (
    <div className="bg-secondary rounded-2xl shadow-sm border border-base p-3 sm:p-5 space-y-4">
      <SettingsSectionHeader
        icon={LayoutGrid}
        title="Categorías"
        subtitle="Organiza el catálogo por categoría y departamento para encontrar productos más rápido."
      />

      <div className="space-y-3">
        <div className="max-h-48 overflow-y-auto space-y-1.5 pr-1 custom-scrollbar">
          {categories.length === 0 ? (
            <div className="rounded-xl border border-dashed border-base bg-primary px-4 py-6 text-center">
              <LayoutGrid size={20} className="mx-auto text-muted" />
              <p className="mt-2 text-sm font-medium text-muted">Aún no hay categorías. Agrega la primera abajo.</p>
            </div>
          ) : categories.map((category) => (
            <div
              key={category.id}
              className="flex justify-between items-center gap-2 bg-subtle py-1.5 pl-3 pr-1.5 rounded-xl border border-base group"
            >
              <div className="flex-1 min-w-0">
                <div className="text-sm font-semibold text-primary break-words leading-snug">
                  {category.name}
                </div>
                {category.department && (
                  <div className="text-sm font-medium text-muted break-words">
                    {category.department}
                  </div>
                )}
              </div>
              <div className="flex gap-1 shrink-0">
                <button
                  type="button"
                  onClick={() => {
                    setEditingCategory(category);
                    setNewCategory({
                      name: category.name,
                      department: category.department,
                    });
                  }}
                  className="flex h-11 w-11 items-center justify-center rounded-xl text-muted transition-colors hover:bg-primary hover:text-violet-600 cursor-pointer"
                  title="Editar"
                  aria-label={`Editar ${category.name}`}
                >
                  <Edit size={16} />
                </button>
                <button
                  type="button"
                  onClick={() => setCategoryToDelete({ id: category.id, name: category.name })}
                  className="flex h-11 w-11 items-center justify-center rounded-xl text-muted transition-colors hover:bg-primary hover:text-rose-500 cursor-pointer"
                  title="Eliminar"
                  aria-label={`Eliminar ${category.name}`}
                >
                  <Trash2 size={16} />
                </button>
              </div>
            </div>
          ))}
        </div>

        <div className="space-y-3">
          {editingCategory && (
            <div className="flex items-center justify-between gap-2 rounded-xl border border-violet-200 bg-violet-50/60 p-2.5 dark:border-violet-900/50 dark:bg-violet-950/20">
              <p className="min-w-0 text-sm font-medium text-violet-900 dark:text-violet-100">
                Editando <strong className="break-words">{editingCategory.name}</strong>
              </p>
              <button
                type="button"
                onClick={() => {
                  setEditingCategory(null);
                  setNewCategory({ name: "", department: "" });
                }}
                className="h-11 shrink-0 rounded-xl border border-violet-200 px-3 text-sm font-semibold text-violet-700 dark:border-violet-900/50 dark:text-violet-200"
              >
                Cancelar
              </button>
            </div>
          )}
          <div className="flex flex-col sm:flex-row gap-2">
            <input
              type="text"
              value={newCategory.name}
              onChange={(e) => setNewCategory({ ...newCategory, name: e.target.value })}
              placeholder={editingCategory ? "Nuevo nombre de la categoría" : "Nombre de la categoría"}
              className="flex-[2] min-w-0 w-full h-11 px-3 bg-primary border border-base rounded-xl text-sm font-semibold text-primary outline-none focus:ring-1 focus:ring-violet-500 shadow-sm"
            />
            <input
              type="text"
              value={newCategory.department}
              onChange={(e) => setNewCategory({ ...newCategory, department: e.target.value })}
              placeholder="Departamento"
              className="flex-1 min-w-0 w-full h-11 px-3 bg-primary border border-base rounded-xl text-sm font-semibold text-primary outline-none focus:ring-1 focus:ring-violet-500 shadow-sm"
            />
            <button
              type="button"
              onClick={onAddCategory}
              title={editingCategory ? "Guardar cambios" : "Agregar categoría"}
              className="h-11 sm:w-11 w-full bg-violet-600 text-white rounded-xl hover:bg-violet-700 active:scale-95 transition-all flex items-center justify-center shadow-sm shrink-0 cursor-pointer"
            >
              {editingCategory ? <Save size={16} /> : <Plus size={16} />}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
