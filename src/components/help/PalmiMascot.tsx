import React from "react";
import numaMascotUrl from "../../assets/numa-official.webp";
import type { NumaMood } from "./numa";

export type { NumaMood };

/**
 * Mascota oficial de NUMA.
 * Esta es la única fuente visual del personaje; los estados se expresan
 * mediante clases de animación sin sustituir ni duplicar el asset.
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
      src={numaMascotUrl}
      alt="NUMA, mascota guía de PALMYRA"
      className={`numa-mascot numa-mood-${mood} ${className}`}
      draggable={false}
      decoding="async"
    />
  );
}
