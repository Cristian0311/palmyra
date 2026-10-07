import { useCallback, useEffect } from 'react';
import type { FormEvent } from 'react';
import type { AppState } from '../../../store/storeTypes';
import type { InventoryLevel, PendingOrder, Product, CartItem } from '../../../types';
import { useBarcodeScanner } from '../../../hooks/useBarcodeScanner';
import { normalizeSemanticText } from '../../../utils/textUtils';
import type { Html5QrcodeScanner as Html5QrcodeScannerType } from 'html5-qrcode';

type POSScannerArgs = {
  products: Product[];
  inventory: InventoryLevel[];
  currentBranchId: string;
  currentSessionBranchId?: string;
  cart: CartItem[];
  pendingOrders: PendingOrder[];
  addToCart: AppState['addToCart'];
  clearCart: AppState['clearCart'];
  removePendingOrder: AppState['removePendingOrder'];
  selectedProduct: Product | null;
  setSelectedProduct: (product: Product | null) => void;
  configData: { serialNumber?: string; selectedSize?: string; selectedColor?: string };
  setConfigData: (value: { serialNumber?: string; selectedSize?: string; selectedColor?: string }) => void;
  setShowConfigModal: (value: boolean) => void;
  showCameraScanner: boolean;
  setShowCameraScanner: (value: boolean) => void;
  setPosSuccess: (value: string) => void;
  setPosError: (value: string) => void;
};

export function usePOSScanner({
  products,
  inventory,
  currentBranchId,
  currentSessionBranchId,
  cart,
  pendingOrders,
  addToCart,
  clearCart,
  removePendingOrder,
  selectedProduct,
  setSelectedProduct,
  configData,
  setConfigData,
  setShowConfigModal,
  showCameraScanner,
  setShowCameraScanner,
  setPosSuccess,
  setPosError,
}: POSScannerArgs) {
const getProductStock = (productId: string, variantLabel?: string) => {
  return (inventory || []).reduce((total, item) => {
    const stockBranchId = currentSessionBranchId || currentBranchId;
    if (item.branchId !== stockBranchId || item.productId !== productId) return total;
    if (variantLabel) return item.variantLabel === variantLabel ? total + item.quantity : total;
    return total + item.quantity;
  }, 0);
};

const getCartQuantity = (productId: string, variantLabel?: string) => {
  return cart
    .filter(item => {
      const pId = typeof (item.product as any) === 'object' && item.product !== null ? item.product.id : item.product;
      return pId === productId && (item.variantLabel || '') === (variantLabel || '');
    })
    .reduce((sum, item) => sum + item.quantity, 0);
};

useBarcodeScanner((barcode) => {
  const normCode = normalizeSemanticText(barcode);
  const scannedProduct = (products || []).find(p => {
    if (!p) return false;
    return (
      p.id === barcode ||
      normalizeSemanticText(p.sku) === normCode ||
      normalizeSemanticText(p.barcode) === normCode ||
      p.sku === barcode ||
      p.barcode === barcode
    );
  });

  if (scannedProduct) {
     const totalAvailable = getProductStock(scannedProduct.id);
     if (totalAvailable > 0) {
        const needsConfig = scannedProduct.hasSerial || (scannedProduct.availableSizes?.length) || (scannedProduct.availableColors?.length);
        if (needsConfig) {
           setSelectedProduct(scannedProduct);
           setShowConfigModal(true);
        } else {
           addToCart(scannedProduct);
           setPosSuccess(`¡Producto "${scannedProduct.name}" detectado y agregado al carrito!`);
           setTimeout(() => setPosSuccess(""), 2000);
        }
     } else {
        setPosError(`El producto "${scannedProduct.name}" no tiene existencias suficientes en este almacén.`);
        setTimeout(() => setPosError(""), 3000);
     }
  } else {
    setPosError(`No se encontró ningún producto con el código "${barcode}".`);
    setTimeout(() => setPosError(""), 2500);
  }
});

useEffect(() => {
  let scanner: Html5QrcodeScannerType | null = null;
  let cancelled = false;

  if (showCameraScanner) {
    void import("html5-qrcode").then(({ Html5QrcodeScanner }) => {
      if (cancelled) return;

      scanner = new Html5QrcodeScanner(
        "qr-reader",
        { fps: 10, qrbox: { width: 250, height: 250 } },
        false
      );

      scanner.render((decodedText) => {
      // On successful scan
      const scannedProduct = products.find(p => p.sku === decodedText || p.id === decodedText || p.barcode === decodedText);
      if (scannedProduct) {
        const totalAvailable = getProductStock(scannedProduct.id);
        if (totalAvailable > 0) {
          const needsConfig = scannedProduct.hasSerial || (scannedProduct.availableSizes?.length) || (scannedProduct.availableColors?.length);
          if (needsConfig) {
            setSelectedProduct(scannedProduct);
            setShowConfigModal(true);
          } else {
            addToCart(scannedProduct);
            setPosSuccess("Producto escaneado");
            setTimeout(() => setPosSuccess(""), 1500);
          }
        } else {
          setPosError("Sin existencias");
          setTimeout(() => setPosError(""), 1500);
        }
      } else {
        // Check if it's an order payload from the customer shop
        if (decodedText.startsWith("APP_ORDER:")) {
          try {
            const payloadStr = decodedText.replace("APP_ORDER:", "");
            const payload = JSON.parse(payloadStr);
            if (payload && payload.i && Array.isArray(payload.i)) {
              clearCart();
              payload.i.forEach((item: any) => {
                const p = products.find(prod => prod.id === item.id);
                if (p) {
                  for(let i=0; i<item.q; i++) {
                    addToCart(p);
                  }
                }
              });
              setPosSuccess("Carrito de cliente cargado exitosamente.");
              setTimeout(() => setPosSuccess(""), 3000);
            }
          } catch(e) {
            setPosError("Código de orden inválido");
            setTimeout(() => setPosError(""), 1500);
          }
        } else {
          // Check if it's a legacy pending order (by ID)
          const order = pendingOrders.find(o => o.id === decodedText && o.status === 'pending');
          if (order) {
            clearCart();
            order.items.forEach(item => {
              const prodObj = typeof (item.product as any) === 'object' && item.product !== null ? item.product : products.find(p => p.id === (item.product as any));
              if (prodObj) {
                for(let i=0; i<item.quantity; i++){
                  addToCart(prodObj, item.serialNumber);
                }
              }
            });
            removePendingOrder(order.id);
            setPosSuccess("Orden cargada exitosamente.");
            setTimeout(() => setPosSuccess(""), 3000);
          } else {
            setPosError("Código no reconocido");
            setTimeout(() => setPosError(""), 1500);
          }
        }
      }
        setShowCameraScanner(false);
      }, (error) => {
        // Handle scan errors silently
      });
    });
  }

  return () => {
    cancelled = true;
    if (scanner) {
      scanner.clear().catch(error => {
        console.error("Failed to clear html5QrcodeScanner. ", error);
      });
    }
  };
}, [showCameraScanner, products, inventory, currentBranchId]);

const handleProductClick = useCallback((product: Product) => {
  setPosError("");
  setSelectedProduct(product);
  const autoSN = product.hasSerial ? `SN-${Math.floor(Math.random() * 100000000).toString().padStart(8, "0")}` : "";
  const stockForVariant = (label?: string) => {
    if (!label) return 0;
    const stockBranchId = currentSessionBranchId || currentBranchId;
    return (inventory || []).reduce((total, item) =>
      item.branchId === stockBranchId && item.productId === product.id && (item.variantLabel || '') === label
        ? total + Number(item.quantity || 0)
        : total,
      0
    );
  };
  const firstAvailableSize = product.availableSizes?.find(size => stockForVariant(size) > 0) || product.availableSizes?.[0];
  const firstAvailableColor = product.availableColors?.find(color => stockForVariant(color) > 0) || product.availableColors?.[0];
  setConfigData({
    selectedSize: firstAvailableSize,
    selectedColor: firstAvailableColor,
    serialNumber: autoSN
  });
  setShowConfigModal(true);
}, []);

const handleCatalogOutOfStock = useCallback(() => {
  setPosError("Sin existencias en esta sucursal.");
  setTimeout(() => setPosError(""), 3000);
}, []);

const handleConfigSubmit = (e: FormEvent) => {
  e.preventDefault();
  setPosError("");
  if (selectedProduct) {
    const variantLabel = configData.selectedSize || configData.selectedColor;
    if (getCartQuantity(selectedProduct.id, variantLabel) >= getProductStock(selectedProduct.id, variantLabel)) {
      setPosError(`No hay suficiente stock para la variante ${variantLabel || 'seleccionada'}.`);
      setTimeout(() => setPosError(""), 3000);
      return;
    }
    addToCart({
      ...selectedProduct,
    }, configData.serialNumber, { size: configData.selectedSize, color: configData.selectedColor, variantLabel });
    
    setShowConfigModal(false);
    setSelectedProduct(null);
    setConfigData({});
  }
};
  return {
    getProductStock,
    getCartQuantity,
    handleProductClick,
    handleCatalogOutOfStock,
    handleConfigSubmit,
  };
}
