const MAX_WIDTH = 600;
const MAX_HEIGHT = 600;
const JPEG_QUALITY = 0.7;

export function resizeProductImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onerror = () => reject(reader.error || new Error('No se pudo leer la imagen.'));
    reader.onload = event => {
      const result = event.target?.result;
      if (typeof result !== 'string') {
        reject(new Error('El archivo de imagen no pudo convertirse a datos.'));
        return;
      }

      const img = new Image();
      img.onerror = () => reject(new Error('La imagen no pudo cargarse.'));
      img.onload = () => {
        const ratio = Math.min(
          MAX_WIDTH / Math.max(img.width, 1),
          MAX_HEIGHT / Math.max(img.height, 1),
          1,
        );
        const width = Math.max(1, Math.round(img.width * ratio));
        const height = Math.max(1, Math.round(img.height * ratio));

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext('2d');
        if (!context) {
          reject(new Error('El navegador no pudo preparar la imagen.'));
          return;
        }

        context.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', JPEG_QUALITY));
      };
      img.src = result;
    };

    reader.readAsDataURL(file);
  });
}
