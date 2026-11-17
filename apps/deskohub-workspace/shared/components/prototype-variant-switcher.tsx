"use client";

// PROTOTYPE ONLY: floating bar that cycles a `?variant=` search param.
// Lives on throwaway prototype routes; never mount it on production pages.

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect } from "react";

export type PrototypeVariant = {
  key: string;
  label: string;
};

type PrototypeVariantSwitcherProps = {
  variants: readonly PrototypeVariant[];
  param?: string;
};

export function PrototypeVariantSwitcher({
  variants,
  param = "variant",
}: PrototypeVariantSwitcherProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const currentKey = searchParams.get(param) ?? variants[0]?.key;
  const currentIndex = Math.max(
    0,
    variants.findIndex((variant) => variant.key === currentKey)
  );
  const current = variants[currentIndex];

  const go = useCallback(
    (step: number) => {
      const next =
        variants[(currentIndex + step + variants.length) % variants.length];
      if (!next) return;
      const params = new URLSearchParams(searchParams.toString());
      params.set(param, next.key);
      router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [currentIndex, param, pathname, router, searchParams, variants]
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        target?.closest("input, textarea, select, [contenteditable='true']")
      ) {
        return;
      }
      if (event.key === "ArrowLeft") go(-1);
      if (event.key === "ArrowRight") go(1);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [go]);

  if (process.env.NODE_ENV === "production" || !current || variants.length < 2) {
    return null;
  }

  return (
    <div
      data-prototype-switcher
      className="fixed bottom-4 left-1/2 z-[100] flex -translate-x-1/2 items-center gap-1 rounded-full bg-neutral-950 px-1.5 py-1.5 font-mono text-xs text-white shadow-2xl ring-1 ring-white/20"
    >
      <button
        type="button"
        aria-label="Previous variant"
        className="rounded-full px-2.5 py-1 hover:bg-white/15"
        onClick={() => go(-1)}
      >
        ←
      </button>
      <span className="px-2 whitespace-nowrap">
        {current.key} · {current.label}
      </span>
      <button
        type="button"
        aria-label="Next variant"
        className="rounded-full px-2.5 py-1 hover:bg-white/15"
        onClick={() => go(1)}
      >
        →
      </button>
    </div>
  );
}
