import React from "react";
import numaMascotUrl from "../../assets/numa-mascot.webp";
import type { NumaMood } from "./numa";

export type { NumaMood };

/**
 * Mascota oficial de NUMA.
 * Un único render 3D consistente; los estados se diferencian visualmente
 * mediante clases de animación sin sustituir el personaje.
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
