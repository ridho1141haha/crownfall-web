// Crownfall: The Last Light — bun test helpers.
// Deterministic, browser-free harness for the pure game engine:
// - Map-backed localStorage shim (no jsdom needed)
// - EngineHooks recorder
// - Fixed-timestep helpers
// - Canonical valid save payload factory (produced by a real engine run)

import { GameEngine, type EngineHooks } from "../../src/lib/game/engine";
import { SAVE_BACKUP_KEY, SAVE_KEY } from "../../src/lib/game/data";

// ---------------------------------------------------------------------------
// localStorage shim
// ---------------------------------------------------------------------------

export class MemoryStorage {
  private store = new Map<string, string>();
  getItem(key: string): string | null {
    return this.store.has(key) ? (this.store.get(key) as string) : null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  clear(): void {
    this.store.clear();
  }
}

export function installStorage(): MemoryStorage {
  const storage = new MemoryStorage();
  (globalThis as { localStorage?: unknown }).localStorage = storage;
  return storage;
}

// ---------------------------------------------------------------------------
// Hooks recorder
// ---------------------------------------------------------------------------

export interface RecordedHooks extends EngineHooks {
  messages: string[];
  sfxNames: string[];
  victories: Array<{ title: string; subtitle: string }>;
}

export function makeHooks(): RecordedHooks {
  const hooks: RecordedHooks = {
    messages: [],
    sfxNames: [],
    victories: [],
    sfx: (name) => hooks.sfxNames.push(name),
    message: (text) => hooks.messages.push(text),
    victory: (title, subtitle) => hooks.victories.push({ title, subtitle }),
  };
  return hooks;
}

// ---------------------------------------------------------------------------
// Engine factory
// ---------------------------------------------------------------------------

export function makeEngine(): { engine: GameEngine; hooks: RecordedHooks } {
  const hooks = makeHooks();
  const engine = new GameEngine(hooks);
  return { engine, hooks };
}

/** Advance the engine with fixed time steps (deterministic simulation). */
export function step(engine: GameEngine, dt: number, ticks: number): void {
  for (let i = 0; i < ticks; i++) engine.update(dt);
}

/**
 * A realistic in-game state used to prove save/load round-trips:
 * distinct balances, day/phase, player position, hearth tier, etc.
 */
export function seedMidGameState(engine: GameEngine): void {
  engine.gold = 7;
  engine.wood = 9;
  engine.stone = 4;
  engine.day = 3;
  engine.phase = "sunset";
  engine.phaseElapsed = 12.5;
  engine.playerX = 123.4;
  engine.facing = -1;
  engine.hearthLevel = 2;
  engine.hearthBoost = 0;
  engine.shipwreckStage = 1;
  engine.portalLooted = true;
  engine.firstNightSurvived = true;
  engine.reign = "ACTIVE";
  engine.campVagrants = 1;
  engine.eraIndex = 1;
  // mark a resource node + a tree so node/tree restore is observable
  engine.nodeStates.set("timber_pile_west", true);
  engine.treeHp.set("tree_west_01", 1);
  // recruit the builder and give the plots observable, consistent states
  engine.agents[0].recruited = true;
  engine.agents[0].role = "builder";
  engine.agents[0].state = "IDLE";
  engine.agents[0].x = -57.5;
  const farm = engine.plots.get("farm_west_01");
  if (farm) {
    farm.state = "COMPLETED";
    farm.durability = 64;
    farm.progress = 1;
  }
  const wall = engine.plots.get("wall_east_01");
  if (wall) {
    wall.state = "DAMAGED";
    wall.durability = 90;
  }
}

/**
 * Canonical VALID save payload captured from a live engine — the baseline
 * every validation test mutates. Guaranteed self-consistent because it is
 * produced by buildSavePayload() of a seeded engine (and saveGame() itself
 * now validates before writing).
 */
export function makeValidPayload(): Record<string, unknown> {
  const { engine } = makeEngine();
  engine.newGame();
  seedMidGameState(engine);
  const ok = engine.saveGame();
  if (!ok) throw new Error("makeValidPayload: saveGame rejected its own payload");
  const raw = localStorage.getItem(SAVE_KEY);
  if (raw === null) throw new Error("makeValidPayload: primary save missing");
  return JSON.parse(raw) as Record<string, unknown>;
}

/** Deep-clone helper for payload mutation tests. */
export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Write raw text directly into a save slot. */
export function writeSlot(key: string, text: string | null): void {
  if (text === null) {
    localStorage.removeItem(key);
  } else {
    localStorage.setItem(key, text);
  }
}

export const SLOT_KEYS = { primary: SAVE_KEY, backup: SAVE_BACKUP_KEY };
