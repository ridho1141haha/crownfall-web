"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  Coins,
  Hammer,
  HelpCircle,
  Logs,
  Moon,
  Mountain,
  Pause as PauseIcon,
  Play,
  RotateCcw,
  Save,
  FolderOpen,
  Sun,
  Sunset,
  Target,
  Volume2,
  VolumeX,
  Flame,
  Crown,
  Ship,
  ChevronLeft,
  ChevronRight,
  Hand,
  ArrowUpFromLine,
  Wrench,
  Clock,
  Sparkles,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Maximize, Minimize, Settings } from "lucide-react";
import { VIEW } from "@/lib/game/data";
import { GameEngine } from "@/lib/game/engine";
import { Renderer } from "@/lib/game/renderer";
import { AudioManager } from "@/lib/game/audio";
import {
  DEFAULT_SETTINGS,
  loadSettings,
  saveSettings,
  type CrownfallSettings,
} from "@/lib/game/settings";
import type { Snapshot } from "@/lib/game/types";

interface Toast {
  id: number;
  text: string;
  born: number;
}

const PHASE_META = {
  daylight: { label: "Daylight", icon: Sun, tint: "text-amber-300" },
  sunset: { label: "Sunset", icon: Sunset, tint: "text-orange-300" },
  night: { label: "Night", icon: Moon, tint: "text-indigo-200" },
} as const;

export default function CrownfallGame() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const engineRef = useRef<GameEngine | null>(null);
  const rendererRef = useRef<Renderer | null>(null);
  const audioRef = useRef<AudioManager | null>(null);
  const toastIdRef = useRef(1);

  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [screen, setScreen] = useState<"title" | "game">("title");
  const [paused, setPaused] = useState(false);
  const [exitWarn, setExitWarn] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [victory, setVictory] = useState<{ title: string; subtitle: string } | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  // P4-D: settings load once at first render (client-only — the initializer
  // falls back to defaults during SSR, and no settings-dependent UI exists in
  // the initial title-screen render, so hydration stays consistent).
  const [savedSettings] = useState(() =>
    typeof window === "undefined" ? DEFAULT_SETTINGS : loadSettings(),
  );
  const [muted, setMuted] = useState(savedSettings.muted);
  const [volume, setVolume] = useState(savedSettings.volume);
  const [pausePanel, setPausePanel] = useState<"main" | "settings">("main");
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [fsSupported] = useState(
    () =>
      typeof document !== "undefined" && Boolean(document.fullscreenEnabled),
  );
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const fsPrefRef = useRef(savedSettings.fullscreen);
  const fsAutoAttemptedRef = useRef(false);

  const pushToast = useCallback((text: string) => {
    setToasts((ts) => {
      const next = [...ts, { id: toastIdRef.current++, text, born: performance.now() }];
      return next.slice(-5);
    });
  }, []);

  // refs mirroring UI state for stable event handlers
  const screenRef = useRef<"title" | "game">("title");
  const pausedRef = useRef(false);

  // ---------------------------------------------------------------------------
  // Engine + renderer + main loop
  // ---------------------------------------------------------------------------
  useEffect(() => {
    const audio = new AudioManager();
    audioRef.current = audio;

    const engine = new GameEngine({
      sfx: (name) => audio.play(name),
      message: (text) => pushToast(text),
      victory: (title, subtitle) => setVictory({ title, subtitle }),
    });
    engineRef.current = engine;

    // E2E / QA instrumentation: read-only state dump, no gameplay effect.
    if (process.env.NODE_ENV !== "production") {
      const w = window as unknown as {
        __crownfall?: {
          read: () => Record<string, unknown>;
          engine: GameEngine;
        };
      };
      w.__crownfall = {
        engine,
        read: () => ({
          started: engine.started,
          paused: engine.paused,
          day: engine.day,
          phase: engine.phase,
          phaseElapsed: Math.round(engine.phaseElapsed * 10) / 10,
          timeScale: engine.timeScale,
          gold: engine.gold,
          wood: engine.wood,
          stone: engine.stone,
          playerX: Math.round(engine.playerX * 10) / 10,
          reign: engine.reign,
          hearthLevel: engine.hearthLevel,
          hearthBoost: Math.round(engine.hearthBoost),
          flareTimer: Math.round(engine.flareTimer * 10) / 10,
          flareCooldown: Math.round(engine.flareCooldown * 10) / 10,
          shipwreckStage: engine.shipwreckStage,
          portalLooted: engine.portalLooted,
          shrineUsedToday: engine.shrineUsedToday,
          campVagrants: engine.campVagrants,
          nightActive: engine.nightActive,
          nightElapsed: Math.round(engine.nightElapsed * 10) / 10,
          spawnedWaves: engine.spawnedWaves,
          westSpawned: engine.westSpawned,
          settlementBreached: engine.settlementBreached,
          plots: [...engine.plots.values()].map((p) => ({
            id: p.id,
            type: p.type,
            x: p.x,
            level: p.level,
            state: p.state,
            progress: Math.round(p.progress * 100) / 100,
            durability: Math.round(p.durability * 10) / 10,
            maxDurability: p.maxDurability,
          })),
          agents: engine.agents.map((a) => ({
            id: a.id,
            role: a.role,
            recruited: a.recruited,
            state: a.state,
            x: Math.round(a.x),
            task: a.task,
          })),
          enemies: [
            engine.night.active
              ? { side: "east", ...engine.night, x: Math.round(engine.night.x), hp: Math.round(engine.night.hp) }
              : null,
            engine.west.active
              ? { side: "west", ...engine.west, x: Math.round(engine.west.x), hp: Math.round(engine.west.hp) }
              : null,
          ].filter(Boolean),
          nodesCollected: [...engine.nodeStates.entries()]
            .filter(([, done]) => done)
            .map(([id]) => id),
          treesFelled: engine
            .treeStatesForRender()
            .filter((t) => t.felled)
            .map((t) => t.id),
        }),
      };
    }

    const renderer = new Renderer();
    rendererRef.current = renderer;
    void renderer.load();

    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d") ?? null;

    let raf = 0;
    let last = performance.now();
    let snapAcc = 0;

    const loop = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      engine.update(dt);
      if (ctx && canvas) {
        renderer.render(engine, ctx, VIEW.WIDTH, VIEW.HEIGHT);
      }
      snapAcc += dt;
      if (snapAcc >= 0.1) {
        snapAcc = 0;
        setSnap(engine.getSnapshot());
        const cutoff = now - 4800;
        setToasts((ts) => (ts.length ? ts.filter((t) => t.born >= cutoff) : ts));
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    // --- keyboard ---
    const down = (e: KeyboardEvent) => {
      const eng = engineRef.current;
      if (!eng || screenRef.current !== "game") return;
      audio.unlock();
      const k = e.key.toLowerCase();
      if (["arrowleft", "arrowright", "arrowup", "arrowdown", " "].includes(k)) {
        e.preventDefault();
      }
      if (k === "escape") {
        setPaused((p) => !p);
        setPausePanel("main");
        return;
      }
      if (pausedRef.current) return;
      if (k === "a" || k === "arrowleft") eng.input.left = true;
      else if (k === "d" || k === "arrowright") eng.input.right = true;
      else if (k === "e") eng.interact();
      else if (k === "q") eng.upgradeAction();
      else if (k === "r") eng.recruitAction();
      else if (k === "b") eng.buildAction();
      else if (k === "f") eng.repairAction();
      else if (k === " ") eng.flareAction();
      else if (k === "t") eng.toggleTimeScale();
      else if (k === "k") eng.manualSave();
      else if (k === "m") setMuted((m) => !m);
      else if (k === "h") setHelpOpen((v) => !v);
    };
    const up = (e: KeyboardEvent) => {
      const eng = engineRef.current;
      if (!eng) return;
      const k = e.key.toLowerCase();
      if (k === "a" || k === "arrowleft") eng.input.left = false;
      else if (k === "d" || k === "arrowright") eng.input.right = false;
    };
    const firstGesture = () => {
      audio.unlock();
      // P4-D: browsers require a user gesture for fullscreen — honor the
      // persisted preference on the first gesture (Godot applies it at
      // startup; the gesture requirement is a documented platform limit).
      if (
        fsPrefRef.current &&
        !fsAutoAttemptedRef.current &&
        typeof document !== "undefined" &&
        document.fullscreenEnabled &&
        !document.fullscreenElement &&
        viewportRef.current
      ) {
        fsAutoAttemptedRef.current = true;
        viewportRef.current
          .requestFullscreen()
          .catch(() => {
            /* rejection handled by fullscreenerror listener / toggle state */
          });
      }
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("pointerdown", firstGesture, { once: true });

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("pointerdown", firstGesture);
    };
  }, []);

  // keep refs in sync so the key handler can read them without re-subscribing
  useEffect(() => {
    screenRef.current = screen;
    pausedRef.current = paused || screen !== "game";
    const eng = engineRef.current;
    if (eng) eng.paused = paused || screen !== "game";
    if (paused || screen !== "game") {
      if (eng) {
        eng.input.left = false;
        eng.input.right = false;
      }
    }
  }, [paused, screen]);

  useEffect(() => {
    audioRef.current?.setMuted(muted);
  }, [muted]);

  useEffect(() => {
    audioRef.current?.setVolume(volume);
  }, [volume]);

  // P4-D persistence: any volume/mute change survives reloads (settings.ts
  // sanitizes defensively; storage failures are non-fatal).
  const persistCurrentSettings = (
    patch: Partial<CrownfallSettings>,
  ) => {
    saveSettings({
      volume,
      muted,
      fullscreen: fsPrefRef.current,
      ...patch,
    });
  };

  useEffect(() => {
    persistCurrentSettings({ volume });
  }, [volume]);

  useEffect(() => {
    persistCurrentSettings({ muted });
  }, [muted]);

  // Keep the fullscreen UI state synchronized with the ACTUAL browser state
  // (Esc exit, F11, other tabs) — Godot has no equivalent source of truth.
  useEffect(() => {
    const sync = () => setIsFullscreen(Boolean(document.fullscreenElement));
    const onError = () => {
      setIsFullscreen(Boolean(document.fullscreenElement));
      pushToast("Fullscreen request was rejected by the browser.");
    };
    document.addEventListener("fullscreenchange", sync);
    document.addEventListener("fullscreenerror", onError);
    return () => {
      document.removeEventListener("fullscreenchange", sync);
      document.removeEventListener("fullscreenerror", onError);
    };
  }, []);

  const toggleFullscreen = () => {
    const el = viewportRef.current;
    if (!el || typeof document === "undefined" || !document.fullscreenEnabled) {
      return;
    }
    if (document.fullscreenElement) {
      fsPrefRef.current = false;
      persistCurrentSettings({ fullscreen: false });
      void document.exitFullscreen().catch(() => setIsFullscreen(false));
      return;
    }
    fsAutoAttemptedRef.current = true;
    el
      .requestFullscreen()
      .then(() => {
        fsPrefRef.current = true;
        persistCurrentSettings({ fullscreen: true });
      })
      .catch(() => {
        // request rejected (permissions/iframe policy) — the fullscreenerror
        // listener already surfaces the toast and re-syncs the UI state;
        // preference untouched so the user can retry from the toggle.
      });
  };

  // auto-dismiss victory banner (mirrors the 7s Godot banner)
  useEffect(() => {
    if (!victory) return;
    const t = setTimeout(() => setVictory(null), 8000);
    return () => clearTimeout(t);
  }, [victory]);

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------
  const startNew = () => {
    audioRef.current?.unlock();
    engineRef.current?.newGame();
    setScreen("game");
    setPaused(false);
    setVictory(null);
  };

  const continueGame = () => {
    audioRef.current?.unlock();
    const eng = engineRef.current;
    if (!eng) return;
    // B3: revalidate at the moment of choice so stale cached state can never
    // mask invalid saves, and never silently start a fresh reign when the
    // player intended to continue one (parity with Main.gd
    // refresh_continue_state + SaveManager.has_valid_save).
    eng.refreshHasSave();
    if (!eng.hasSave) {
      pushToast("No valid save found — start a New Reign instead.");
      return;
    }
    const ok = eng.loadGame();
    if (ok) {
      setScreen("game");
      setPaused(false);
    } else {
      // Unreachable while hasSave is true; fail safe without auto-starting.
      pushToast("Failed to load the saved kingdom — saves may be corrupted.");
      eng.refreshHasSave();
    }
  };

  const saveAndTitle = () => {
    const eng = engineRef.current;
    const ok = eng ? eng.manualSave() : false;
    if (ok) {
      setExitWarn(false);
      setPaused(false);
      setScreen("title");
    } else {
      // Manual save terkunci saat malam & autosave hanya saat sunrise —
      // minta konfirmasi eksplisit sebelum membuang progres.
      setExitWarn(true);
    }
  };

  const restart = () => {
    engineRef.current?.newGame();
    setPaused(false);
    setVictory(null);
  };

  const hold = (dir: "left" | "right", value: boolean) => {
    const eng = engineRef.current;
    if (eng) eng.input[dir] = value;
  };

  const act = (fn: (e: GameEngine) => void) => {
    audioRef.current?.unlock();
    const eng = engineRef.current;
    if (eng && screen === "game" && !paused) fn(eng);
  };

  const hasSave = snap?.hasSave ?? false;

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  const phaseMeta = snap ? PHASE_META[snap.phase] : PHASE_META.daylight;
  const PhaseIcon = phaseMeta.icon;

  return (
    <main className="flex min-h-screen flex-col bg-stone-950 text-stone-100">
      <div className="mx-auto w-full max-w-[1400px] flex-1 px-2 py-3 sm:px-4 sm:py-5">
        {/* header strip */}
        <header className="mb-2 flex items-center justify-between gap-2 px-1">
          <div className="flex items-center gap-2">
            <Crown className="h-5 w-5 text-amber-300" aria-hidden />
            <div>
              <h1 className="text-sm font-bold tracking-widest sm:text-base">
                CROWNFALL: THE LAST LIGHT
              </h1>
              <p className="text-[10px] text-stone-400 sm:text-xs">
                Web port of the Godot 4 vertical slice · Forgotten Shore
              </p>
            </div>
          </div>
          {screen === "game" && (
            <div className="flex items-center gap-1.5">
              <Button
                variant="outline"
                size="sm"
                className="border-stone-700 bg-stone-900/90 text-stone-200 hover:bg-stone-800 hover:text-stone-100"
                onClick={() => setHelpOpen(true)}
                aria-label="Help (H)"
              >
                <HelpCircle className="h-4 w-4" />
                <span className="hidden sm:inline">Help</span>
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="border-stone-700 bg-stone-900/90 text-stone-200 hover:bg-stone-800 hover:text-stone-100"
                onClick={() => setMuted((m) => !m)}
                aria-label={muted ? "Unmute (M)" : "Mute (M)"}
              >
                {muted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="border-stone-700 bg-stone-900/90 text-stone-200 hover:bg-stone-800 hover:text-stone-100"
                onClick={() => {
                  setPaused(true);
                  setPausePanel("main");
                }}
                aria-label="Pause (Esc)"
              >
                <PauseIcon className="h-4 w-4" />
                <span className="hidden sm:inline">Menu</span>
              </Button>
            </div>
          )}
        </header>

        {/* game viewport */}
        <div
          ref={viewportRef}
          className="relative w-full overflow-hidden rounded-lg border border-stone-800 bg-black shadow-2xl"
        >
          <canvas
            ref={canvasRef}
            width={VIEW.WIDTH}
            height={VIEW.HEIGHT}
            className="block h-auto w-full [image-rendering:pixelated]"
            aria-label="Crownfall game world"
            role="img"
          />

          {/* ------- HUD (only during play) ------- */}
          {screen === "game" && snap && (
            <>
              {/* top-left: clock */}
              <div className="pointer-events-none absolute left-1.5 top-1.5 w-40 rounded-md border border-stone-700/70 bg-stone-950/75 p-1.5 backdrop-blur-sm sm:left-2 sm:top-2 sm:w-56 sm:p-2 md:w-64">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <PhaseIcon className={`h-4 w-4 ${phaseMeta.tint}`} aria-hidden />
                    <span className="text-sm font-semibold">
                      Day {snap.day} · {phaseMeta.label} · {snap.era}
                    </span>
                  </div>
                  {snap.timeScale > 1 && (
                    <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">
                      <Clock className="mr-0.5 h-3 w-3" />20x
                    </Badge>
                  )}
                </div>
                <Progress
                  value={snap.phaseProgress * 100}
                  className="mt-1.5 h-1.5"
                  aria-label="Phase progress"
                />
                <div className="mt-1.5 flex items-center gap-2 text-[11px] text-stone-300">
                  <span className="inline-flex items-center gap-0.5">
                    <Coins className="h-3 w-3 text-amber-300" /> {snap.gold}
                  </span>
                  <span className="inline-flex items-center gap-0.5">
                    <Logs className="h-3 w-3 text-orange-200" /> {snap.wood}
                  </span>
                  <span className="inline-flex items-center gap-0.5">
                    <Mountain className="h-3 w-3 text-stone-300" /> {snap.stone}
                  </span>
                  <span className="ml-auto inline-flex items-center gap-0.5">
                    <Flame className="h-3 w-3 text-orange-300" /> Lv.{snap.hearthLevel}
                  </span>
                </div>
              </div>

              {/* top-right: forecast / alert + population */}
              <div className="pointer-events-none absolute right-1.5 top-1.5 w-44 rounded-md border border-stone-700/70 bg-stone-950/75 p-1.5 text-right text-[10px] backdrop-blur-sm sm:right-2 sm:top-2 sm:w-72 sm:p-2 sm:text-[11px] md:w-80">
                {snap.alert ? (
                  <p className="font-semibold text-red-300">{snap.alert}</p>
                ) : (
                  <p className="text-sky-200/90">{snap.forecast}</p>
                )}
                <p className="mt-1 text-stone-400">{snap.population}</p>
                {(snap.flareActive || snap.flareCooldown > 0) && (
                  <p className="mt-1 text-orange-300">
                    {snap.flareActive
                      ? "KINDLE FLARE ACTIVE (+50% light damage)"
                      : `Flare cooldown ${Math.ceil(snap.flareCooldown)}s`}
                  </p>
                )}
                {snap.hearthBoost > 0 && (
                  <p className="mt-1 text-orange-200">
                    Hearth stoked ({Math.ceil(snap.hearthBoost)}s)
                  </p>
                )}
                {snap.reign === "ISLAND_CLEARED" && (
                  <p className="mt-1 font-semibold text-emerald-300">
                    Island cleared — the kingdom is at peace
                  </p>
                )}
              </div>

              {/* bottom-center: context prompt */}
              {snap.prompt && (
                <div className="pointer-events-none absolute bottom-16 left-1/2 -translate-x-1/2">
                  <div className="flex items-center gap-2 rounded-full border border-amber-300/40 bg-stone-950/85 px-4 py-1.5 text-xs text-amber-200 shadow-lg backdrop-blur">
                    <kbd className="rounded border border-amber-300/50 bg-stone-900 px-1.5 py-0.5 font-mono text-[11px] text-amber-200">
                      {snap.promptKey}
                    </kbd>
                    <span>{snap.prompt}</span>
                  </div>
                </div>
              )}

              {/* bottom-left: feedback toasts */}
              <div className="pointer-events-none absolute bottom-2 left-2 flex w-80 flex-col gap-1">
                {toasts.slice(-3).map((t) => (
                  <div
                    key={t.id}
                    className="rounded border border-stone-700/60 bg-stone-950/80 px-2 py-1 text-[11px] text-stone-200 backdrop-blur-sm"
                  >
                    {t.text}
                  </div>
                ))}
              </div>

              {/* desktop controls hint */}
              <div className="pointer-events-none absolute bottom-2 right-2 hidden rounded-md border border-stone-700/60 bg-stone-950/70 px-2 py-1 text-[10px] text-stone-400 backdrop-blur-sm lg:block">
                A/D move · E interact · Q upgrade · R recruit · B build · F repair ·
                Space flare · T 20x · K save · M mute · Esc menu
              </div>

              {/* touch controls */}
              <div className="absolute bottom-2 left-1/2 flex -translate-x-1/2 flex-nowrap items-center justify-center gap-1 lg:hidden">
                <TouchButton
                  label="Left"
                  onPress={(v) => hold("left", v)}
                  ariaLabel="Move left"
                >
                  <ChevronLeft className="h-5 w-5" />
                </TouchButton>
                <TouchButton
                  label="Right"
                  onPress={(v) => hold("right", v)}
                  ariaLabel="Move right"
                >
                  <ChevronRight className="h-5 w-5" />
                </TouchButton>
                <ActionButton icon={Hand} kbd="E" onPress={() => act((e) => e.interact())} ariaLabel="Interact" />
                <ActionButton icon={ArrowUpFromLine} kbd="Q" onPress={() => act((e) => e.upgradeAction())} ariaLabel="Upgrade" />
                <ActionButton icon={Sparkles} kbd="R" onPress={() => act((e) => e.recruitAction())} ariaLabel="Recruit" />
                <ActionButton icon={Hammer} kbd="B" onPress={() => act((e) => e.buildAction())} ariaLabel="Build" />
                <ActionButton icon={Wrench} kbd="F" onPress={() => act((e) => e.repairAction())} ariaLabel="Repair" />
                <ActionButton icon={Flame} kbd="␣" onPress={() => act((e) => e.flareAction())} ariaLabel="Kindle flare" />
              </div>
            </>
          )}

          {/* ------- Title screen ------- */}
          {screen === "title" && (
            <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-b from-stone-950/85 via-stone-950/70 to-stone-950/90 backdrop-blur-[2px]">
              <div className="w-full max-w-md px-6 text-center">
                <Crown className="mx-auto h-10 w-10 text-amber-300" aria-hidden />
                <h2 className="mt-3 text-3xl font-black tracking-widest text-amber-100">
                  CROWNFALL
                </h2>
                <p className="text-sm font-semibold tracking-[0.3em] text-stone-400">
                  THE LAST LIGHT
                </p>
                <p className="mt-3 text-xs leading-relaxed text-stone-300">
                  Build a kingdom. Explore forgotten lands. Survive the darkness.
                  Collect Gold, Wood &amp; Stone by day — hold the wall against the
                  Greedling raiders by night.
                </p>
                <div className="mt-5 flex flex-col gap-2">
                  <Button onClick={startNew} size="lg" className="gap-2">
                    <Play className="h-4 w-4" /> New Reign
                  </Button>
                  <Button
                    onClick={continueGame}
                    size="lg"
                    variant="secondary"
                    className="gap-2"
                    disabled={!hasSave}
                  >
                    <FolderOpen className="h-4 w-4" />
                    {hasSave ? "Continue Reign" : "No Save Found"}
                  </Button>
                  <Button
                    onClick={() => setHelpOpen(true)}
                    size="lg"
                    variant="outline"
                    className="gap-2 border-stone-700 bg-stone-900/90 text-stone-200 hover:bg-stone-800 hover:text-stone-100"
                  >
                    <HelpCircle className="h-4 w-4" /> How to Play
                  </Button>
                </div>
                <p className="mt-4 text-[10px] text-stone-500">
                  Faithful browser port of{" "}
                  <Link
                    href="https://github.com/ridho1141haha/crownfall"
                    target="_blank"
                    rel="noreferrer"
                    className="underline hover:text-stone-300"
                  >
                    github.com/ridho1141haha/crownfall
                  </Link>{" "}
                  (Godot 4 · GDScript) using its original assets, data files and
                  system rules.
                </p>
              </div>
            </div>
          )}

          {/* ------- Pause menu ------- */}
          {screen === "game" && paused && (
            <div className="absolute inset-0 flex items-center justify-center bg-stone-950/80 backdrop-blur-sm">
              <div className="w-full max-w-xs rounded-lg border border-stone-700 bg-stone-900/95 p-5 shadow-2xl">
                {pausePanel === "main" ? (
                  <>
                <h3 className="text-center text-lg font-bold tracking-widest text-amber-100">
                  PAUSED
                </h3>
                <p className="mt-1 text-center text-[11px] text-stone-400">
                  {snap ? `Day ${snap.day} · ${phaseMeta.label} · ${snap.era} · ${snap.gold}G ${snap.wood}W ${snap.stone}S` : ""}
                </p>
                <div className="mt-4 flex flex-col gap-2">
                  <Button onClick={() => setPaused(false)} className="gap-2">
                    <Play className="h-4 w-4" /> Resume
                  </Button>
                  <Button
                    variant="secondary"
                    className="gap-2"
                    onClick={() => {
                      const ok = engineRef.current?.manualSave() ?? false;
                      pushToast(ok ? "Kingdom state saved." : "Save failed (disabled during Night).");
                    }}
                  >
                    <Save className="h-4 w-4" /> Save (K)
                  </Button>
                  <Button
                    variant="secondary"
                    className="gap-2"
                    onClick={() => setPausePanel("settings")}
                  >
                    <Settings className="h-4 w-4" /> Settings
                  </Button>
                  <Button
                    variant="secondary"
                    className="gap-2"
                    onClick={() => {
                      const ok = engineRef.current?.loadGame() ?? false;
                      pushToast(ok ? "Save loaded." : "Load failed — save may be corrupted.");
                      if (ok) setPaused(false);
                    }}
                  >
                    <FolderOpen className="h-4 w-4" /> Load Last Save
                  </Button>
                  <Button
                    variant="outline"
                    className="gap-2 border-stone-700 bg-stone-900/90 text-stone-200 hover:bg-stone-800 hover:text-stone-100"
                    onClick={() => setHelpOpen(true)}
                  >
                    <HelpCircle className="h-4 w-4" /> Help (H)
                  </Button>
                  <Button
                    variant="outline"
                    className="gap-2 border-stone-700 bg-stone-900/90 text-stone-200 hover:bg-stone-800 hover:text-stone-100"
                    onClick={saveAndTitle}
                  >
                    <Crown className="h-4 w-4" /> Save &amp; Title
                  </Button>
                  <Button variant="destructive" className="gap-2" onClick={restart}>
                    <RotateCcw className="h-4 w-4" /> Abandon &amp; Restart
                  </Button>
                </div>
                <p className="mt-3 text-center text-[10px] text-stone-500">
                  Saves are kept in this browser (slot 0, with backup recovery).
                </p>
                  </>
                ) : (
                  <>
                    {/* ------- Settings panel (Godot PauseMenu parity) ------- */}
                    <h3 className="text-center text-lg font-bold tracking-widest text-amber-100">
                      SETTINGS
                    </h3>
                    <div className="mt-5">
                      <div className="flex items-center justify-between text-sm text-stone-200">
                        <span>Master Volume</span>
                        <span className="text-stone-400">
                          {Math.round(volume * 100)}%
                        </span>
                      </div>
                      <Slider
                        className="mt-2"
                        value={[volume]}
                        min={0}
                        max={1}
                        step={0.05}
                        onValueChange={(vals) => setVolume(vals[0] ?? 0)}
                        aria-label="Master volume"
                      />
                    </div>
                    <div className="mt-5 flex items-center justify-between text-sm text-stone-200">
                      <span className="inline-flex items-center gap-2">
                        {isFullscreen ? (
                          <Minimize className="h-4 w-4" />
                        ) : (
                          <Maximize className="h-4 w-4" />
                        )}
                        Fullscreen
                      </span>
                      <Switch
                        checked={isFullscreen}
                        disabled={!fsSupported}
                        onCheckedChange={(checked) => {
                          if (checked !== isFullscreen) toggleFullscreen();
                        }}
                        aria-label="Toggle fullscreen"
                      />
                    </div>
                    {!fsSupported && (
                      <p className="mt-1 text-right text-[10px] text-stone-500">
                        Fullscreen is not supported by this browser
                      </p>
                    )}
                    <Button
                      variant="outline"
                      className="mt-5 w-full gap-2 border-stone-700 bg-stone-900/90 text-stone-200 hover:bg-stone-800 hover:text-stone-100"
                      onClick={() => setPausePanel("main")}
                    >
                      Back
                    </Button>
                  </>
                )}
              </div>
            </div>
          )}

          {/* ------- Unsaved progress warning (save locked at Night) ------- */}
          {screen === "game" && paused && exitWarn && (
            <div className="absolute inset-0 flex items-center justify-center bg-stone-950/90 backdrop-blur-sm">
              <div className="w-full max-w-xs rounded-lg border border-amber-700/60 bg-stone-900/95 p-5 shadow-2xl">
                <h3 className="text-center text-base font-bold tracking-widest text-amber-300">
                  UNSAVED PROGRESS
                </h3>
                <p className="mt-2 text-center text-xs leading-relaxed text-stone-300">
                  Manual save is disabled during Night combat and autosave only
                  fires at sunrise. Progress since your last save will be lost.
                  Return to title anyway?
                </p>
                <div className="mt-4 flex justify-center gap-2">
                  <Button
                    variant="secondary"
                    onClick={() => setExitWarn(false)}
                  >
                    Stay
                  </Button>
                  <Button
                    variant="destructive"
                    onClick={() => {
                      setExitWarn(false);
                      setPaused(false);
                      setScreen("title");
                    }}
                  >
                    Return Anyway
                  </Button>
                </div>
              </div>
            </div>
          )}

          {/* ------- Help ------- */}
          {helpOpen && (
            <div
              className="absolute inset-0 flex items-center justify-center bg-stone-950/85 p-4 backdrop-blur-sm"
              onClick={(e) => {
                if (e.target === e.currentTarget) setHelpOpen(false);
              }}
            >
              <div className="max-h-[90%] w-full max-w-lg overflow-y-auto rounded-lg border border-stone-700 bg-stone-900/95 p-5 text-sm shadow-2xl">
                <div className="flex items-center justify-between">
                  <h3 className="text-lg font-bold tracking-widest text-amber-100">
                    HOW TO PLAY
                  </h3>
                  <Button variant="ghost" size="sm" onClick={() => setHelpOpen(false)}>
                    Close
                  </Button>
                </div>
                <Separator className="my-3" />
                <div className="space-y-3 text-xs leading-relaxed text-stone-300">
                  <p>
                    <strong className="text-stone-100">Goal:</strong> survive the
                    nights, grow the settlement, repair the Shipwreck (far west,
                    3 stages) and Set Sail to clear the island.
                  </p>
                  <div>
                    <strong className="text-stone-100">Controls</strong>
                    <ul className="mt-1 space-y-0.5 pl-4">
                      <li><kbd className="kbd">A/D</kbd> or <kbd className="kbd">←/→</kbd> move the Monarch</li>
                      <li><kbd className="kbd">E</kbd> interact / collect / stoke hearth / set sail</li>
                      <li><kbd className="kbd">Q</kbd> upgrade (Wall → Stone, Hearth tiers)</li>
                      <li><kbd className="kbd">R</kbd> recruit Villager at Vagrant Camp (2G)</li>
                      <li><kbd className="kbd">B</kbd> fund construction at a plot</li>
                      <li><kbd className="kbd">F</kbd> instant repair (+1 extra Wood at night)</li>
                      <li><kbd className="kbd">Space</kbd> Kindle Flare at night (1 Wood, 8s +50%)</li>
                      <li><kbd className="kbd">T</kbd> toggle 1x / 20x clock · <kbd className="kbd">K</kbd> save · <kbd className="kbd">M</kbd> mute · <kbd className="kbd">Esc</kbd> menu</li>
                    </ul>
                  </div>
                  <div>
                    <strong className="text-stone-100">Roles (assign Villagers at stands)</strong>
                    <ul className="mt-1 space-y-0.5 pl-4">
                      <li><Hammer className="mr-1 inline h-3 w-3" />Builder — constructs &amp; repairs plots (free)</li>
                      <li><Sparkles className="mr-1 inline h-3 w-3" />Farmer — harvests +2G every 60s from Farms (1G 1S)</li>
                      <li><Target className="mr-1 inline h-3 w-3" />Archer — shoots raiders, 2x dmg on Watchtower (1G 1W, first free)</li>
                    </ul>
                  </div>
                  <div>
                    <strong className="text-stone-100">Night survival</strong>
                    <ul className="mt-1 space-y-0.5 pl-4">
                      <li>Day 1: 3 raider waves hit the East Wall from the east shore.</li>
                      <li>Day 2+: 4 waves + West Scouts from the far west flank.</li>
                      <li>Walls deal thorn damage; Watchtower adds +10 per hit; Stone Wall Lv2 raises HP to 260 / thorns 20.</li>
                      <li>Hearth light burns enemies (stoke with 1 Wood: +30% radius, +2 DPS).</li>
                      <li>If a raider reaches Town Center, half your Gold is lost at dawn.</li>
                      <li>Stay in the light — darkness staggers the Monarch (-1 Gold).</li>
                      <li>Wood/Stone nodes &amp; trees regrow each sunrise; autosave at dawn.</li>
                    </ul>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* ------- Victory banner ------- */}
          {victory && (
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-stone-950/95">
              <Ship className="h-10 w-10 text-amber-300" aria-hidden />
              <h3 className="mt-3 text-4xl font-black tracking-widest text-amber-300">
                {victory.title}
              </h3>
              <p className="mt-2 text-sm text-stone-200">{victory.subtitle}</p>
            </div>
          )}
        </div>

        {/* key legend (mobile-friendly summary) */}
        {screen === "game" && (
          <p className="mt-2 text-center text-[10px] text-stone-500 lg:hidden">
            Use the on-screen buttons · hold ◀ / ▶ to move · Esc opens the menu
          </p>
        )}
      </div>

      <footer className="mt-auto border-t border-stone-800/80 bg-stone-950 px-4 py-2.5">
        <div className="mx-auto flex max-w-[1400px] flex-wrap items-center justify-between gap-1 text-[10px] text-stone-500">
          <p>
            CROWNFALL: THE LAST LIGHT — fan web port of the original{" "}
            <Link
              href="https://github.com/ridho1141haha/crownfall"
              target="_blank"
              rel="noreferrer"
              className="underline hover:text-stone-300"
            >
              Godot 4 project
            </Link>
            . All sprite &amp; audio assets from the original repository.
          </p>
          <p className="text-stone-600">
            M0–M8 vertical slice mechanics · local saves stay in your browser
          </p>
        </div>
      </footer>
    </main>
  );
}

function TouchButton({
  label,
  onPress,
  ariaLabel,
  children,
}: {
  label: string;
  onPress: (down: boolean) => void;
  ariaLabel: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      className="flex h-10 w-10 select-none items-center justify-center rounded-full border border-stone-600 bg-stone-900/85 text-stone-100 shadow-md active:bg-stone-800"
      onPointerDown={(e) => {
        e.preventDefault();
        onPress(true);
      }}
      onPointerUp={() => onPress(false)}
      onPointerLeave={() => onPress(false)}
      onPointerCancel={() => onPress(false)}
      onContextMenu={(e) => e.preventDefault()}
    >
      {children}
      <span className="sr-only">{label}</span>
    </button>
  );
}

function ActionButton({
  icon: Icon,
  kbd,
  onPress,
  ariaLabel,
}: {
  icon: React.ComponentType<{ className?: string }>;
  kbd: string;
  onPress: () => void;
  ariaLabel: string;
}) {
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      className="flex h-10 min-w-[40px] select-none flex-col items-center justify-center rounded-lg border border-stone-600 bg-stone-900/85 px-1.5 text-stone-100 shadow-md active:bg-stone-800"
      onPointerDown={(e) => {
        e.preventDefault();
        onPress();
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <Icon className="h-4 w-4" />
      <span className="font-mono text-[9px] text-stone-400">{kbd}</span>
    </button>
  );
}
