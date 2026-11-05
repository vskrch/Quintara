/**
 * PWA bootstrap (§33): service-worker registration, settings hydration and
 * the install prompt. Offline modes (AI, local, tutorial) work without the
 * server once the app shell is cached.
 */

"use client";

import { useEffect, useState } from "react";
import { useSettings } from "@/lib/settings";
import { startMusic } from "@/lib/sound";
import { withBasePath } from "@/lib/site";

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

export function PwaBootstrap() {
  const hydrate = useSettings((s) => s.hydrate);
  const [installEvent, setInstallEvent] =
    useState<BeforeInstallPromptEvent | null>(null);
  const [updateReady, setUpdateReady] = useState(false);

  useEffect(() => {
    hydrate();

    let refreshing = false;
    // A first install claims the page and fires controllerchange. Reloading
    // there is pointless (and can loop); only reload when replacing a worker
    // that was already controlling this page.
    let canReload = Boolean(navigator.serviceWorker?.controller);
    let visibilityHandler: (() => void) | null = null;
    const onControllerChange = () => {
      if (!canReload) {
        canReload = true;
        return;
      }
      if (refreshing) return;
      refreshing = true;
      window.location.reload();
    };
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.addEventListener(
        "controllerchange",
        onControllerChange,
      );
      const register = () => {
        navigator.serviceWorker
          .register(withBasePath("/sw.js"))
          .then((registration) => {
            const watch = () => {
              if (registration.waiting && navigator.serviceWorker.controller) {
                setUpdateReady(true);
              }
              registration.addEventListener("updatefound", () => {
                const worker = registration.installing;
                worker?.addEventListener("statechange", () => {
                  if (
                    worker.state === "installed" &&
                    navigator.serviceWorker.controller
                  ) {
                    setUpdateReady(true);
                  }
                });
              });
            };
            watch();
            // Check for a new deploy on each launch and when the tab returns.
            registration.update().catch(() => {});
            const onVisible = () => {
              if (document.visibilityState === "visible") {
                registration.update().catch(() => {});
              }
            };
            visibilityHandler = onVisible;
            document.addEventListener("visibilitychange", onVisible);
          })
          .catch(() => {
            // Offline caching unavailable (e.g. dev without SW) — non-fatal.
          });
      };
      if (document.readyState === "complete") register();
      else window.addEventListener("load", register, { once: true });
    }

    // §65: manual reduced-motion overrides the OS default so pixel-sensitive
    // players can force calm motion even when their system keeps animations on.
    const applyReducedMotion = () => {
      const setting = useSettings.getState().reducedMotion;
      const root = document.documentElement;
      if (setting === true) root.dataset.reducedMotion = "true";
      else delete root.dataset.reducedMotion;
    };
    applyReducedMotion();
    const unsubscribe = useSettings.subscribe(applyReducedMotion);

    // Pause infinite CSS animations while the tab/app is hidden so a
    // backgrounded phone is not still painting the aurora scene.
    const root = document.documentElement;
    const syncVisibility = () => {
      if (document.visibilityState === "hidden") {
        root.dataset.pageHidden = "true";
      } else {
        delete root.dataset.pageHidden;
      }
    };
    syncVisibility();
    document.addEventListener("visibilitychange", syncVisibility);

    // Browsers refuse to start an AudioContext before a gesture. Hydration
    // restores the user's music preference, then the first interaction starts
    // the ambient pad if both master and music volumes are above zero.
    let musicArmed = false;
    const startMusicOnGesture = () => {
      if (musicArmed) return;
      musicArmed = true;
      const { masterVolume, musicVolume } = useSettings.getState();
      if (masterVolume > 0 && musicVolume > 0) startMusic();
      window.removeEventListener("pointerdown", startMusicOnGesture);
      window.removeEventListener("keydown", startMusicOnGesture);
    };
    window.addEventListener("pointerdown", startMusicOnGesture, {
      passive: true,
    });
    window.addEventListener("keydown", startMusicOnGesture);

    const onPrompt = (event: Event) => {
      event.preventDefault();
      setInstallEvent(event as BeforeInstallPromptEvent);
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("pointerdown", startMusicOnGesture);
      window.removeEventListener("keydown", startMusicOnGesture);
      if (visibilityHandler) {
        document.removeEventListener("visibilitychange", visibilityHandler);
      }
      navigator.serviceWorker?.removeEventListener(
        "controllerchange",
        onControllerChange,
      );
      document.removeEventListener("visibilitychange", syncVisibility);
      unsubscribe();
    };
  }, [hydrate]);

  if (!installEvent && !updateReady) return null;

  return (
    <div className="fixed bottom-[calc(var(--safe-bottom)+1rem)] right-4 z-40 flex max-w-[calc(100vw-2rem)] flex-col gap-2">
      {updateReady && (
        <div className="toast flex items-center gap-3" role="status">
          <span className="text-sm">A new version is ready</span>
          <button
            type="button"
            className="btn btn-primary px-3 py-1.5 text-xs"
            onClick={() => {
              navigator.serviceWorker.getRegistration().then((registration) => {
                registration?.waiting?.postMessage({ type: "SKIP_WAITING" });
              });
            }}
          >
            Refresh
          </button>
          <button
            type="button"
            className="btn btn-ghost px-2 py-1.5 text-xs"
            onClick={() => setUpdateReady(false)}
          >
            Later
          </button>
        </div>
      )}
      {installEvent && (
        <div className="toast flex items-center gap-3">
          <span className="text-sm">Install Quintara</span>
          <button
            type="button"
            className="btn btn-primary px-3 py-1.5 text-xs"
            onClick={async () => {
              await installEvent.prompt();
              setInstallEvent(null);
            }}
          >
            Install
          </button>
          <button
            type="button"
            className="btn btn-ghost px-2 py-1.5 text-xs"
            onClick={() => setInstallEvent(null)}
          >
            Not now
          </button>
        </div>
      )}
    </div>
  );
}
