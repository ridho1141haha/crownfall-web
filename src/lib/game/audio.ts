// Web Audio sfx manager — mirrors the original SFXPlayer behavior
// (pitch variation 0.92–1.08 per play, wav assets from the Godot project).

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

export class AudioManager {
  private context: AudioContext | null = null;
  private buffers = new Map<SfxName, AudioBuffer>();
  private loading = false;
  private muted = false;

  setMuted(muted: boolean) {
    this.muted = muted;
  }

  isMuted() {
    return this.muted;
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
    if (this.muted || !this.context) return;
    const buf = this.buffers.get(name);
    if (!buf) return;
    const source = this.context.createBufferSource();
    source.buffer = buf;
    source.playbackRate.value = 0.92 + Math.random() * 0.16;
    const gain = this.context.createGain();
    gain.gain.value = volume;
    source.connect(gain);
    gain.connect(this.context.destination);
    source.start();
  }
}
