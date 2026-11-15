// Crownfall: The Last Light — Phase 4 P4-D settings persistence regressions.
// The persisted settings contract mirrors Godot PauseMenu (volume 0..1
// default 1.0, fullscreen default false) plus the web-only mute toggle.
// Malformed data must never break startup — every field falls back
// independently to its default.

import { describe, test, expect, beforeEach } from "bun:test";

import {
  DEFAULT_SETTINGS,
  SETTINGS_STORAGE_KEY,
  loadSettings,
  sanitizeSettings,
  saveSettings,
} from "../../src/lib/game/settings";
import { installStorage } from "./helpers";

describe("P4-D — settings sanitization", () => {
  test("defaults mirror Godot PauseMenu", () => {
    expect(DEFAULT_SETTINGS).toEqual({ volume: 1, muted: false, fullscreen: false });
  });

  test("non-object / malformed roots fall back to defaults", () => {
    expect(sanitizeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(sanitizeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(sanitizeSettings("x")).toEqual(DEFAULT_SETTINGS);
    expect(sanitizeSettings([1])).toEqual(DEFAULT_SETTINGS);
  });

  test("each field independently validated", () => {
    expect(sanitizeSettings({ volume: 0.5 })).toEqual({ volume: 0.5, muted: false, fullscreen: false });
    expect(sanitizeSettings({ muted: true })).toEqual({ volume: 1, muted: true, fullscreen: false });
    expect(sanitizeSettings({ fullscreen: true })).toEqual({ volume: 1, muted: false, fullscreen: true });

    // out-of-range / wrong-type volume clamps to [0, 1]
    expect(sanitizeSettings({ volume: 1.5 }).volume).toBe(1);
    expect(sanitizeSettings({ volume: -2 }).volume).toBe(0);
    expect(sanitizeSettings({ volume: Number.NaN }).volume).toBe(1);
    expect(sanitizeSettings({ volume: Number.POSITIVE_INFINITY }).volume).toBe(1);
    expect(sanitizeSettings({ volume: "0.3" }).volume).toBe(1);

    // wrong-type booleans fall back
    expect(sanitizeSettings({ muted: "yes" }).muted).toBe(false);
    expect(sanitizeSettings({ fullscreen: 1 }).fullscreen).toBe(false);
  });
});

describe("P4-D — settings storage round-trip", () => {
  beforeEach(() => {
    installStorage();
  });

  test("save → load preserves values (survive reloads)", () => {
    saveSettings({ volume: 0.35, muted: true, fullscreen: true });
    expect(loadSettings()).toEqual({ volume: 0.35, muted: true, fullscreen: true });
  });

  test("missing storage → defaults", () => {
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
  });

  test("corrupt storage → defaults (never throws)", () => {
    localStorage.setItem(SETTINGS_STORAGE_KEY, "{not json");
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ volume: "bad", extra: 1 }));
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
  });
});
