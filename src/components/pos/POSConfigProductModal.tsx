import type { FormEvent } from "react";
import type { InventoryLevel, Product } from "../../types";

type ConfigData = {
  serialNumber?: string;
  selectedSize?: string;
  selectedColor?: string;
};

type Props = {
  open: boolean;
  product: Product | null;
  configData: ConfigData;
  setConfigData: (next: ConfigData) => void;
  generateSerial: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onClose: () => void;
  inventory: InventoryLevel[];
  branchId: string;
};

export function POSConfigProductModal({
  open,
  product,
  configData,
  setConfigData,
  generateSerial,
  onSubmit,
  onClose,
  inventory,
  branchId,
}: Props) {
  if (!open) return null;

  const stockForVariant = (label?: string) => {
    if (!product || !label) return 0;
    return (inventory || []).reduce((total, item) => {
      if (item.productId !== product.id || item.branchId !== branchId) return total;
      return (item.variantLabel || "") === label ? total + Number(item.quantity || 0) : total;
    }, 0);
  };
  const hasVariants = Boolean(product?.availableSizes?.length || product?.availableColors?.length);
  const selectedVariantLabel = configData.selectedSize || configData.selectedColor || "";
  const selectedVariantStock = stockForVariant(selectedVariantLabel);

  return (
    <div className="fixed inset-0 bg-slate-900/50 z-50 flex items-center justify-center p-4">
      <div className="palmyra-mobile-modal bg-white rounded-2xl shadow-xl w-full max-w-[560px] max-h-[calc(100dvh-1rem)] overflow-y-auto animate-in zoom-in-95">
        <div className="p-3 sm:p-5">
          <h3 className="text-base sm:text-xl font-bold text-slate-900 mb-1.5 sm:mb-2">
            Configurar Producto
          </h3>
          <p className="text-slate-500 mb-4">
            Completa los detalles para{" "}
            <span className="font-semibold text-slate-800">{product?.name}</span>.
          </p>

          <form onSubmit={onSubmit} className="space-y-3">
            {product?.hasSerial && (
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">
                  Número de Serie (Opcional)
                </label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    autoFocus
                    placeholder="Ej: SN-123456789"
                    value={configData.serialNumber || ""}
                    onChange={(e) =>
                      setConfigData({
                        ...configData,
                        serialNumber: e.target.value,
                      })
                    }
                    className="flex-1 px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-indigo-500 outline-none transition-shadow"
                  />
                  <button
                    type="button"
                    onClick={generateSerial}
                    className="px-4 py-2.5 bg-indigo-50 text-indigo-700 rounded-xl font-medium hover:bg-indigo-100 transition-colors"
                  >
                    Generar
                  </button>
                </div>
              </div>
            )}

            {product?.availableSizes && product.availableSizes.length > 0 && (
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">
                  Talla
                </label>
                <select
                  required
                  value={configData.selectedSize || ""}
                  onChange={(e) =>
                    setConfigData({
                      ...configData,
                      selectedSize: e.target.value,
                    })
                  }
                  className="w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-indigo-500 outline-none transition-shadow"
                >
                  {product.availableSizes.map((size) => (
                    <option key={size} value={size} disabled={stockForVariant(size) <= 0}>
                      {size} · Stock: {stockForVariant(size)}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {product?.availableColors && product.availableColors.length > 0 && (
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">
                  Color
                </label>
                <select
                  required
                  value={configData.selectedColor || ""}
                  onChange={(e) =>
                    setConfigData({
                      ...configData,
                      selectedColor: e.target.value,
                    })
                  }
                  className="w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-indigo-500 outline-none transition-shadow"
                >
                  {product.availableColors.map((color) => (
                    <option key={color} value={color} disabled={stockForVariant(color) <= 0}>
                      {color} · Stock: {stockForVariant(color)}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {hasVariants && (
              <div className={`rounded-xl border px-3 py-2 text-[11px] font-bold ${selectedVariantStock > 0 ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-rose-200 bg-rose-50 text-rose-700"}`}>
                {selectedVariantLabel ? <>Stock disponible en esta zona para <strong>{selectedVariantLabel}</strong>: <strong>{selectedVariantStock}</strong></> : "Selecciona una variante para consultar su stock."}
              </div>
            )}

            <div className="flex gap-3 pt-4">
              <button
                type="button"
                onClick={onClose}
                className="flex-1 py-3 bg-white border border-slate-200 text-slate-700 rounded-xl font-medium hover:bg-slate-50 transition-colors"
              >
                Cancelar
              </button>
              <button
                type="submit"
                className="flex-1 py-3 bg-indigo-600 text-white rounded-xl font-medium hover:bg-indigo-700 transition-colors disabled:opacity-50"
              >
                Agregar
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
