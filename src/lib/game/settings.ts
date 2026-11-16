// Crownfall: The Last Light — persisted user settings (P4-D).
//
// Mirrors the Godot PauseMenu settings contract (scripts/ui/PauseMenu.gd):
//   - audio.master_volume : float 0..1, default 1.0 (settings.cfg)
//   - display.fullscreen  : bool, default false (settings.cfg)
// The web adds the pre-existing HUD mute toggle (M key) as a persisted
// preference; Godot expresses "muted" as volume 0 — both exist here because
// the mute toggle predates Phase 4 and its keybinding is documented UX.
//
// Storage: localStorage (browser equivalent of Godot's user://settings.cfg).
// Malformed or missing data always falls back to defaults — settings are
// cosmetic-only and must never break game startup.

export interface CrownfallSettings {
  /** Master volume, linear 0..1 (Godot PauseMenu slider step 0.05). */
  volume: number;
  /** HUD mute toggle (web-only addition, default off). */
  muted: boolean;
  /** Fullscreen preference. Browsers require a user gesture to actually
   * enter fullscreen — the preference is honored on the first user gesture
   * after load, unlike Godot which applies it at startup unconditionally. */
  fullscreen: boolean;
}

export const SETTINGS_STORAGE_KEY = "crownfall_settings_v1";

export const DEFAULT_SETTINGS: CrownfallSettings = {
  volume: 1,
  muted: false,
  fullscreen: false,
};

/** Defensive sanitizer: every field independently falls back to its default
 * when missing, out of range, or of the wrong type. */
export function sanitizeSettings(raw: unknown): CrownfallSettings {
  const out: CrownfallSettings = { ...DEFAULT_SETTINGS };
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return out;
  }
  const d = raw as Record<string, unknown>;
  if (typeof d.volume === "number" && Number.isFinite(d.volume)) {
    out.volume = Math.min(1, Math.max(0, d.volume));
  }
  if (typeof d.muted === "boolean") {
    out.muted = d.muted;
  }
  if (typeof d.fullscreen === "boolean") {
    out.fullscreen = d.fullscreen;
  }
  return out;
}

/** Load settings from localStorage; never throws, never returns invalid data. */
export function loadSettings(): CrownfallSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (raw === null) return { ...DEFAULT_SETTINGS };
    return sanitizeSettings(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/** Persist settings; quota/serialization failures are non-fatal by design. */
export function saveSettings(settings: CrownfallSettings): void {
  try {
    localStorage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify(sanitizeSettings(settings)),
    );
  } catch {
    // storage unavailable/full — settings stay session-local
  }
}
