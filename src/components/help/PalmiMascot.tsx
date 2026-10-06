import React from "react";
import type { NumaMood } from "./numa";

export type { NumaMood };

/**
 * Mascota gráfica de NUMA.
 * La ilustración vive como asset independiente para que el componente sea ligero,
 * cacheable y fácil de sustituir sin tocar la lógica de la guía.
 */
export function PalmiMascot({
  className = "",
  mood = "idle"
}: {
  className?: string;
  mood?: NumaMood;
}) {
  return (
    <img
      src="/numa-mascot.svg"
      alt="NUMA, mascota guía de PALMYRA"
      className={`numa-mascot numa-mood-${mood} ${className}`}
      draggable={false}
      decoding="async"
    />
  );
}
