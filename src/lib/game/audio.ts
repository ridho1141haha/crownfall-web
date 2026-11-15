// Crownfall: The Last Light — Web Audio sfx manager — mirrors the original
// SFXPlayer behavior (pitch variation 0.92–1.08 per play, wav assets from the
// Godot project). Master volume mirrors the Godot PauseMenu.set_master_volume
// contract (P4-D): a 0..1 linear value; values <= 0.001 mute output entirely
// (Godot mutes the Master bus at the same threshold).

import { ASSETS } from "./data";

export type SfxName = "coin" | "build" | "hit" | "bow" | "sunset" | "night";

const SFX_PATHS: Record<SfxName, string> = {
  coin: ASSETS.sfxCoin,
  build: ASSETS.sfxBuild,
  hit: ASSETS.sfxHit,
  bow: ASSETS.sfxBow,
  sunset: ASSETS.sfxSunset,
  night: ASSETS.sfxNight,
};

/** Godot PauseMenu: AudioServer.set_bus_mute(bus, clamped <= 0.001). */
const MUTE_THRESHOLD = 0.001;

export class AudioManager {
  private context: AudioContext | null = null;
  private buffers = new Map<SfxName, AudioBuffer>();
  private loading = false;
  private muted = false;
  private masterVolume = 1;

  setMuted(muted: boolean) {
    this.muted = muted;
  }

  isMuted() {
    return this.muted;
  }

  /** Linear master volume, clamped to [0, 1]; NaN/Infinity fall back to 1. */
  setVolume(volume: number) {
    this.masterVolume =
      Number.isFinite(volume) && volume > 0
        ? Math.min(volume, 1)
        : volume <= 0
          ? 0
          : 1;
  }

  getVolume() {
    return this.masterVolume;
  }

  /** Call from a user-gesture handler to satisfy browser autoplay policies. */
  unlock() {
    if (this.context) {
      if (this.context.state === "suspended") void this.context.resume();
      return;
    }
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!Ctor) return;
    this.context = new Ctor();
    void this.loadAll();
  }

  private async loadAll() {
    if (this.loading || !this.context) return;
    this.loading = true;
    await Promise.all(
      (Object.keys(SFX_PATHS) as SfxName[]).map(async (name) => {
        if (this.buffers.has(name)) return;
        try {
          const res = await fetch(SFX_PATHS[name]);
          if (!res.ok) return;
          const arr = await res.arrayBuffer();
          const buf = await this.context!.decodeAudioData(arr);
          this.buffers.set(name, buf);
        } catch {
          // missing/undecodable sfx is non-fatal
        }
      }),
    );
    this.loading = false;
  }

  play(name: SfxName, volume = 0.5) {
    // Master mute (M toggle) and the <= 0.001 bus-mute threshold mirror the
    // Godot Master-bus behavior; the effective gain scales the per-sfx volume.
    if (this.muted || this.masterVolume <= MUTE_THRESHOLD || !this.context) {
      return;
    }
    const buf = this.buffers.get(name);
    if (!buf) return;
    const source = this.context.createBufferSource();
    source.buffer = buf;
    source.playbackRate.value = 0.92 + Math.random() * 0.16;
    const gain = this.context.createGain();
    gain.gain.value = volume * this.masterVolume;
    source.connect(gain);
    gain.connect(this.context.destination);
    source.start();
  }
}
