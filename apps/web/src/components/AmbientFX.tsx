"use client";

/**
 * AmbientFX — the global living backdrop.
 *
 * Aurora fields, a perspective table grid and a pointer-tracked spotlight give
 * every screen depth without adding DOM weight inside the game surface. The
 * pointer position is written straight to CSS variables inside a single
 * animation frame, so moving the mouse never triggers a React render.
 */

import { useEffect, useRef } from "react";

export function AmbientFX() {
  const spotlightRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const spotlight = spotlightRef.current;
    if (!spotlight) return;
    const finePointer = window.matchMedia("(hover: hover) and (pointer: fine)");
    let frame = 0;
    let lastX = -1;
    let lastY = -1;

    const applyPointer = (event: PointerEvent) => {
      frame = 0;
      // Touch drags are not a spotlight: writing the CSS variables would
      // force a full-screen gradient repaint on every scroll frame.
      if (event.pointerType === "touch") return;
      if (document.visibilityState !== "visible") return;
      const x = Math.round((event.clientX / window.innerWidth) * 100);
      const y = Math.round((event.clientY / window.innerHeight) * 100);
      if (x === lastX && y === lastY) return;
      lastX = x;
      lastY = y;
      // Keep the custom properties scoped to the spotlight. Writing them on
      // <html> makes the whole tree inherit an invalidation on every move.
      spotlight.style.setProperty("--pointer-x", `${x}%`);
      spotlight.style.setProperty("--pointer-y", `${y}%`);
    };

    const onPointerMove = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      if (frame !== 0) return;
      frame = window.requestAnimationFrame(() => applyPointer(event));
    };

    const syncPointerListener = () => {
      if (finePointer.matches) {
        window.addEventListener("pointermove", onPointerMove, { passive: true });
      } else {
        window.removeEventListener("pointermove", onPointerMove);
      }
    };

    syncPointerListener();
    finePointer.addEventListener("change", syncPointerListener);
    return () => {
      finePointer.removeEventListener("change", syncPointerListener);
      window.removeEventListener("pointermove", onPointerMove);
      if (frame !== 0) window.cancelAnimationFrame(frame);
    };
  }, []);

  return (
    <div className="ambient-fx" aria-hidden>
      <div className="ambient-aurora ambient-aurora-a" />
      <div className="ambient-aurora ambient-aurora-b" />
      <div className="ambient-aurora ambient-aurora-c" />
      <div className="ambient-grid">
        <div className="ambient-grid-layer" />
      </div>
      <div ref={spotlightRef} className="ambient-spotlight" />
      <div className="ambient-vignette" />
      <div className="ambient-grain" />
    </div>
  );
}
