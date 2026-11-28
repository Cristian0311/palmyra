import { useMemo } from "react";
import { QRCodeSVG } from "qrcode.react";
import { Smartphone } from "lucide-react";

type AccessQrProps = {
  /** Enlace https de acceso: el esquema palmyra:// no lo abre la cámara del teléfono. */
  value: string;
  size?: number;
  caption?: string;
  className?: string;
};

/**
 * QR del enlace de acceso de un trabajador. Se apoya en `qrcode.react`, que ya
 * estaba en el bundle para las etiquetas de inventario, para no añadir peso.
 *
 * El cuadro SIEMPRE se pinta sobre blanco aunque la app esté en modo oscuro: un
 * QR invertido o sobre violeta deja de ser escaneable para muchas cámaras, y el
 * enlace se entrega justamente en otro dispositivo.
 */
export default function AccessQr({
  value,
  size = 168,
  caption = "Escanea con la cámara del otro dispositivo",
  className = ""
}: AccessQrProps) {
  const link = value.trim();
  const tooLong = useMemo(() => new TextEncoder().encode(link).length > 2_000, [link]);

  if (!link || tooLong) return null;

  return (
    <div
      className={`inline-flex flex-col items-center gap-2 rounded-2xl border border-slate-200 bg-white p-3 ${className}`.trim()}
    >
      <div className="rounded-xl bg-white p-1">
        <QRCodeSVG
          value={link}
          size={size}
          level="M"
          marginSize={2}
          bgColor="#FFFFFF"
          fgColor="#1B1030"
          style={{ display: "block", height: "auto", maxWidth: "100%" }}
          role="img"
          aria-label="Código QR del enlace de acceso del trabajador"
        />
      </div>
      <p className="inline-flex items-center gap-1.5 text-[10px] font-black uppercase tracking-wider text-slate-600">
        <Smartphone className="h-3.5 w-3.5" aria-hidden="true" />
        {caption}
      </p>
    </div>
  );
}
