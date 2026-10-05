import { Edit, LayoutGrid, Plus, Save, Trash2 } from "lucide-react";
import type { Category } from "../../types";

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
    <div className="bg-secondary rounded-2xl shadow-sm border border-base p-5 space-y-4">
      <div className="flex items-center gap-3 border-b border-base pb-3">
        <div className="bg-amber-50 dark:bg-amber-950/30 p-2 rounded-lg text-amber-600 dark:text-amber-400">
          <LayoutGrid size={16} />
        </div>
        <div>
          <h3 className="text-xs font-black text-primary uppercase tracking-wider">
            Categorías
          </h3>
          <p className="text-[8px] font-bold text-muted uppercase tracking-tight">
            Clasificación de Inventario
          </p>
        </div>
      </div>

      <div className="space-y-3">
        <div className="max-h-48 overflow-y-auto space-y-1.5 pr-1 custom-scrollbar">
          {categories.map((category) => (
            <div
              key={category.id}
              className="flex justify-between items-center bg-subtle p-2 rounded-xl border border-base group"
            >
              <div className="flex-1 min-w-0 mr-2">
                <div className="text-[11px] font-black text-primary uppercase tracking-tight break-words leading-snug">
                  {category.name}
                </div>
                <div className="text-[8px] font-bold text-muted uppercase tracking-wider">
                  {category.department}
                </div>
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
                  className="p-1.5 text-muted hover:text-rose-600 rounded-lg transition-colors cursor-pointer"
                  title="Editar"
                >
                  <Edit size={13} />
                </button>
                <button
                  type="button"
                  onClick={() =>
                    setCategoryToDelete({
                      id: category.id,
                      name: category.name,
                    })
                  }
                  className="p-1.5 text-muted hover:text-rose-500 rounded-lg transition-colors cursor-pointer"
                  title="Eliminar"
                >
                  <Trash2 size={13} />
                </button>
              </div>
            </div>
          ))}
        </div>

        <div className="space-y-3">
          <div className="flex flex-col sm:flex-row gap-2">
            <input
              type="text"
              value={newCategory.name}
              onChange={(e) =>
                setNewCategory({ ...newCategory, name: e.target.value })
              }
              placeholder="Categoría"
              className="flex-[2] min-w-0 w-full px-3 py-2 bg-primary border border-base rounded-xl text-xs font-bold text-primary outline-none focus:ring-1 focus:ring-rose-500 shadow-sm"
            />
            <input
              type="text"
              value={newCategory.department}
              onChange={(e) =>
                setNewCategory({
                  ...newCategory,
                  department: e.target.value,
                })
              }
              placeholder="Depto"
              className="flex-1 min-w-0 w-full px-3 py-2 bg-primary border border-base rounded-xl text-xs font-bold text-primary outline-none focus:ring-1 focus:ring-rose-500 shadow-sm"
            />
            <button
              type="button"
              onClick={onAddCategory}
              className="p-2.5 bg-rose-600 text-white rounded-xl hover:bg-rose-700 active:scale-95 transition-all flex items-center justify-center shadow-md shrink-0 cursor-pointer"
            >
              {editingCategory ? <Save size={16} /> : <Plus size={16} />}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
