import React, { useEffect, useMemo, useState } from "react";
import { BookOpen, CheckCircle2, ChevronLeft, ChevronRight, X } from "lucide-react";
import { useStore } from "../../store/useStore";
import { getAccessibleNumaTourSteps } from "./palmiGuideSteps";

export default function NumaGuide() {
  const currentUser = useStore((state) => state.currentUser);
  const [open, setOpen] = useState(false);
  const [index, setIndex] = useState(0);

  const isMobile =
    typeof window !== "undefined" &&
    window.matchMedia("(max-width: 720px)").matches;

  const steps = useMemo(
    () => getAccessibleNumaTourSteps(currentUser, isMobile),
    [currentUser, isMobile]
  );

  useEffect(() => {
    const handleOpen = () => {
      if (!currentUser || steps.length === 0) return;
      setIndex(0);
      setOpen(true);
    };

    window.addEventListener("palmyra:open-guide", handleOpen);
    return () => window.removeEventListener("palmyra:open-guide", handleOpen);
  }, [currentUser, steps.length]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
      if (event.key === "ArrowRight") setIndex((value) => Math.min(value + 1, steps.length - 1));
      if (event.key === "ArrowLeft") setIndex((value) => Math.max(value - 1, 0));
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, steps.length]);

  if (!open || !steps.length) return null;

  const step = steps[index];
  const isLast = index === steps.length - 1;
  const progress = Math.round(((index + 1) / steps.length) * 100);

  const finish = () => {
    setOpen(false);
    window.dispatchEvent(new Event("palmyra:tutorial-finished"));
  };

  return (
    <div className="fixed inset-0 z-[10050] flex items-center justify-center p-4">
      <button
        type="button"
        className="absolute inset-0 bg-slate-950/65 backdrop-blur-[2px]"
        aria-label="Cerrar guía"
        onClick={() => setOpen(false)}
      />
      <section
        role="dialog"
        aria-modal="true"
        aria-label="Guía Numa de PALMYRA"
        className="relative w-full max-w-xl overflow-hidden rounded-[28px] border border-white/10 bg-white shadow-2xl"
      >
        <div className="h-1 bg-slate-100">
          <div
            className="h-full bg-violet-600 transition-all duration-300"
            style={{ width: progress + "%" }}
          />
        </div>

        <div className="p-5 sm:p-7">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-violet-50 text-violet-600">
                <BookOpen className="h-5 w-5" />
              </div>
              <div>
                <p className="text-[10px] font-black uppercase tracking-[0.2em] text-violet-600">Numa · Guía PALMYRA</p>
                <p className="mt-1 text-xs font-bold text-slate-400">Paso {index + 1} de {steps.length}</p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded-xl p-2 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
              aria-label="Cerrar guía"
            >
              <X className="h-5 w-5" />
            </button>
          </div>

          <div className="mt-8">
            <span className="text-[10px] font-black uppercase tracking-[0.2em] text-violet-500">{step.eyebrow}</span>
            <h2 className="mt-2 text-2xl font-black tracking-tight text-slate-900">{step.title}</h2>
            <p className="mt-3 text-sm leading-6 text-slate-600">{step.message}</p>

            {step.tip ? (
              <div className="mt-5 rounded-2xl border border-violet-100 bg-violet-50 p-4">
                <p className="text-[10px] font-black uppercase tracking-[0.16em] text-violet-600">Consejo PALMYRA</p>
                <p className="mt-1 text-xs font-semibold leading-5 text-violet-950">{step.tip}</p>
              </div>
            ) : null}
          </div>

          <div className="mt-8 flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between">
            <button
              type="button"
              onClick={() => setIndex((value) => Math.max(value - 1, 0))}
              disabled={index === 0}
              className="inline-flex h-11 items-center justify-center gap-2 rounded-xl border border-slate-200 px-4 text-xs font-black text-slate-700 disabled:cursor-not-allowed disabled:opacity-35"
            >
              <ChevronLeft className="h-4 w-4" />
              Anterior
            </button>

            {isLast ? (
              <button
                type="button"
                onClick={finish}
                className="inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-violet-600 px-5 text-xs font-black text-white shadow-lg shadow-violet-600/20"
              >
                <CheckCircle2 className="h-4 w-4" />
                Terminar tutorial
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setIndex((value) => Math.min(value + 1, steps.length - 1))}
                className="inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-violet-600 px-5 text-xs font-black text-white shadow-lg shadow-violet-600/20"
              >
                Siguiente
                <ChevronRight className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
