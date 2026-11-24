import { useEffect } from "react";
import {
  EHS_VARIANTS,
  EHS_VARIANT_KEYS,
  getEhsVariantMeta,
  type EhsVariantKey,
} from "./ehsPrototypeTypes";

export interface PrototypeSwitcherProps {
  current: EhsVariantKey;
  onChange: (next: EhsVariantKey) => void;
}

function isEditableElement(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}

/**
 * Floating bottom-centre variant switcher pill per UI prototype conventions:
 * - Cycles variants with ← / → buttons and ArrowLeft / ArrowRight keys.
 * - Keeps `?variant=A|B|C` in sync via `history.replaceState` so URLs are reload-stable & shareable.
 * - Hidden in production builds (`!import.meta.env.DEV`).
 */
export function PrototypeSwitcher({ current, onChange }: PrototypeSwitcherProps) {
  const idx = Math.max(0, EHS_VARIANT_KEYS.indexOf(current));
  const meta = getEhsVariantMeta(current);

  const step = (delta: number) => {
    const nextIdx = (idx + delta + EHS_VARIANT_KEYS.length) % EHS_VARIANT_KEYS.length;
    onChange(EHS_VARIANT_KEYS[nextIdx]);
  };

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isEditableElement(e.target)) return;
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        step(-1);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        step(1);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [idx, onChange]);

  if (!import.meta.env.DEV) return null;

  return (
    <div
      data-testid="ehs-prototype-switcher"
      role="region"
      aria-label="EHS 原型方案切换器"
      className="fixed bottom-3 left-1/2 z-50 flex -translate-x-1/2 items-center gap-2 rounded-full border border-amber-400/50 bg-slate-950/92 px-2.5 py-1.5 text-xs text-white shadow-2xl ring-1 ring-white/10 backdrop-blur-md"
    >
      <span className="hidden rounded-full bg-amber-400/20 px-2 py-0.5 text-[10px] font-bold tracking-wide text-amber-300 sm:inline">
        PROTOTYPE #20
      </span>

      <button
        type="button"
        data-testid="prototype-prev-btn"
        aria-label="上一个原型方案"
        onClick={() => step(-1)}
        className="flex h-7 w-7 items-center justify-center rounded-full bg-white/10 text-sm font-bold text-white transition hover:bg-white/20 active:scale-95"
        title="上一个方案 (←)"
      >
        ←
      </button>

      <div className="flex items-center gap-1.5 px-1">
        <span
          data-testid="prototype-current-label"
          className="whitespace-nowrap font-semibold tracking-tight text-white"
        >
          {meta.key} ({meta.shortName})
        </span>
        <div className="hidden items-center gap-1 sm:flex">
          {EHS_VARIANTS.map((v) => (
            <button
              key={v.key}
              type="button"
              onClick={() => onChange(v.key)}
              title={v.title}
              className={`h-2 rounded-full transition-all ${
                v.key === current
                  ? "w-5 bg-emerald-400"
                  : "w-2 bg-slate-500 hover:bg-slate-300"
              }`}
              aria-label={`切换到方案 ${v.key}`}
            />
          ))}
        </div>
      </div>

      <button
        type="button"
        data-testid="prototype-next-btn"
        aria-label="下一个原型方案"
        onClick={() => step(1)}
        className="flex h-7 w-7 items-center justify-center rounded-full bg-white/10 text-sm font-bold text-white transition hover:bg-white/20 active:scale-95"
        title="下一个方案 (→)"
      >
        →
      </button>

      <span className="hidden pr-1 text-[10px] text-slate-400 md:inline">←/→ 切换</span>
    </div>
  );
}
