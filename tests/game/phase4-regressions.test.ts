// Crownfall: The Last Light — Phase 4 regressions.
//   P2-A — portal reward is transactional (Godot _on_player_loot_portal_relic):
//     the relic is marked looted ONLY after tryAddBundle succeeds; failures
//     leave the portal retryable and every balance untouched; success cannot
//     be duplicated.
//   P4-A (audit B7) — the six mid-combat encounter sub-fields
//     (attack_timer, light_burn_acc, west_attack_timer, west_burn_acc,
//     east_trampled, west_trampled) are serialized and restored with the
//     exact Godot NightEncounterManager.to_save_dict() / apply_save_dict()
//     semantics (snap 0.001, clamps [0, ATTACK_INTERVAL] / [0, 1], per-side
//     trampled filtering, safe defaults for legacy saves).

import { describe, test, expect, beforeEach } from "bun:test";

import { NIGHT, PORTAL, WALL_ID } from "../../src/lib/game/data";
import { validateSavePayload } from "../../src/lib/game/save-validation";
import {
  installStorage,
  makeEngine,
  type RecordedHooks,
} from "./helpers";
import type { GameEngine } from "../../src/lib/game/engine";

// ---------------------------------------------------------------------------
// P2-A — portal reward transaction
// ---------------------------------------------------------------------------

describe("Phase 4 P2-A — portal reward transaction", () => {
  let engine: GameEngine;
  let hooks: RecordedHooks;

  beforeEach(() => {
    installStorage();
    const made = makeEngine();
    engine = made.engine;
    hooks = made.hooks;
    engine.newGame();
    engine.playerX = PORTAL.X; // within PORTAL.RANGE of the relic
  });

  test("normal successful collection grants the reward and marks the portal", () => {
    const goldBefore = engine.gold; // 2
    const stoneBefore = engine.stone; // 1
    const res = engine.executeWorldCommand("loot_portal");
    expect(res.ok).toBe(true);
    expect(engine.gold).toBe(goldBefore + 3);
    expect(engine.stone).toBe(stoneBefore + 2);
    expect(engine.portalLooted).toBe(true);
    expect(hooks.sfxNames).toContain("coin");
    expect(hooks.messages.join("\n")).toContain("Scavenged Ancient Relic");
  });

  test("gold at maximum capacity: transaction fails, portal stays retryable", () => {
    engine.gold = 999999;
    const stoneBefore = engine.stone;
    const res = engine.executeWorldCommand("loot_portal");
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("capacity");
    // atomic bundle: no gold was added (cap), no stone either
    expect(engine.gold).toBe(999999);
    expect(engine.stone).toBe(stoneBefore);
    // the portal is NOT marked looted — reward never lost
    expect(engine.portalLooted).toBe(false);
    expect(hooks.sfxNames).not.toContain("coin");

    // failed collection followed by a successful retry after freeing space
    engine.gold = 999996;
    const retry = engine.executeWorldCommand("loot_portal");
    expect(retry.ok).toBe(true);
    expect(engine.gold).toBe(999999);
    expect(engine.portalLooted).toBe(true);
  });

  test("stone at maximum capacity: transaction fails, portal stays retryable", () => {
    engine.stone = 999999;
    const goldBefore = engine.gold;
    expect(engine.executeWorldCommand("loot_portal").ok).toBe(false);
    expect(engine.stone).toBe(999999);
    expect(engine.gold).toBe(goldBefore);
    expect(engine.portalLooted).toBe(false);
  });

  test("partial capacity: a bundle that cannot fully fit commits NOTHING", () => {
    // stone cannot accept +2, gold could accept +3 — the bundle is atomic,
    // so the gold reward must NOT be granted either.
    engine.stone = 999999;
    const goldBefore = engine.gold;
    expect(engine.executeWorldCommand("loot_portal").ok).toBe(false);
    expect(engine.gold).toBe(goldBefore); // unchanged despite available capacity
    expect(engine.portalLooted).toBe(false);
  });

  test("repeated collection after success never duplicates the reward", () => {
    expect(engine.executeWorldCommand("loot_portal").ok).toBe(true);
    const goldAfterFirst = engine.gold;
    const stoneAfterFirst = engine.stone;

    const second = engine.executeWorldCommand("loot_portal");
    expect(second.ok).toBe(false);
    expect(second.reason).toContain("already scavenged");
    expect(engine.gold).toBe(goldAfterFirst);
    expect(engine.stone).toBe(stoneAfterFirst);
    expect(engine.portalLooted).toBe(true);

    // survives a save/load: the looted flag round-trips, no double reward
    expect(engine.saveGame()).toBe(true);
    engine.gold = 1;
    expect(engine.loadGame()).toBe(true);
    expect(engine.portalLooted).toBe(true);
    const third = engine.executeWorldCommand("loot_portal");
    expect(third.ok).toBe(false);
    expect(engine.gold).toBe(goldAfterFirst);
  });
});

// ---------------------------------------------------------------------------
// P4-A — night encounter save-state parity (audit B7)
// ---------------------------------------------------------------------------

/** Seed an ACTIVE mid-combat night and mutate the six sub-fields so a
 * save/load round-trip can observe them. */
function seedActiveNight(engine: GameEngine) {
  engine.phase = "night";
  engine.nightActive = true;
  engine.nightElapsed = 130; // past every spawn schedule entry
  engine.spawnedWaves = 4; // escalated day-2 schedule fully spawned
  engine.westSpawned = 2; // both west scouts spawned
  engine.nightDayNumber = 2;
  engine.day = 2;
  engine.firstNightSurvived = true;
  // east enemy engaged at the wall (stopX = 380 + 26)
  engine.night.active = true;
  engine.night.archetype = "raider";
  engine.night.x = 400;
  engine.night.hp = 30;
  engine.night.maxHp = 45;
  // west scout roaming
  engine.west.active = true;
  engine.west.archetype = "raider";
  engine.west.x = -500;
  engine.west.hp = 20;
  engine.west.maxHp = 45;
  // the six B7 sub-fields, in an observable non-default state
  engine.night.attackTimer = 0.6;
  engine.night.burnAccumulator = 0.4;
  engine.west.attackTimer = 0.25;
  engine.west.burnAccumulator = 0.75;
  engine.eastTrampled = ["watchtower_east_01", "farm_east_01"];
  engine.westTrampled = ["farm_west_01"];
  // east wall damaged but standing → barrier exists for attack ticks
  const wall = engine.plots.get(WALL_ID);
  if (wall) {
    wall.state = "DAMAGED";
    wall.durability = 120;
    wall.maxDurability = 150;
    wall.level = 1;
    wall.type = "wooden_wall";
  }
}

describe("Phase 4 P4-A — night encounter six-field parity", () => {
  let engine: GameEngine;

  beforeEach(() => {
    installStorage();
    engine = makeEngine().engine;
    engine.newGame();
  });

  test("payload always contains the six fields (parity with to_save_dict)", () => {
    const payload = engine.buildSavePayload();
    const ne = payload.night_encounter as Record<string, unknown>;
    for (const key of [
      "attack_timer",
      "light_burn_acc",
      "west_attack_timer",
      "west_burn_acc",
      "east_trampled",
      "west_trampled",
    ]) {
      expect(key in ne).toBe(true);
    }
    expect(ne.attack_timer).toBe(0);
    expect(ne.east_trampled).toEqual([]);
    expect(validateSavePayload(payload)).toBe(true);
  });

  test("mid-combat state round-trips through save → diverge → load", () => {
    seedActiveNight(engine);
    expect(engine.saveGame()).toBe(true);
    const stored = JSON.parse(localStorage.getItem("crownfall_save_slot_0") as string) as Record<string, unknown>;
    const ne = stored.night_encounter as Record<string, unknown>;
    // serialized exactly as Godot snaps them
    expect(ne.attack_timer).toBe(0.6);
    expect(ne.light_burn_acc).toBe(0.4);
    expect(ne.west_attack_timer).toBe(0.25);
    expect(ne.west_burn_acc).toBe(0.75);
    expect(ne.east_trampled).toEqual(["watchtower_east_01", "farm_east_01"]);
    expect(ne.west_trampled).toEqual(["farm_west_01"]);

    // diverge the live sub-state completely
    engine.night.attackTimer = 0;
    engine.night.burnAccumulator = 0;
    engine.west.attackTimer = 0;
    engine.west.burnAccumulator = 0;
    engine.eastTrampled = [];
    engine.westTrampled = [];
    engine.eastTrampled = [];
    engine.westTrampled = [];

    expect(engine.loadGame()).toBe(true);
    expect(engine.night.attackTimer).toBeCloseTo(0.6, 6);
    expect(engine.night.burnAccumulator).toBeCloseTo(0.4, 6);
    expect(engine.west.attackTimer).toBeCloseTo(0.25, 6);
    expect(engine.west.burnAccumulator).toBeCloseTo(0.75, 6);
    expect(engine.eastTrampled).toEqual(["watchtower_east_01", "farm_east_01"]);
    expect(engine.westTrampled).toEqual(["farm_west_01"]);
    // the rest of the encounter state also survived
    expect(engine.nightActive).toBe(true);
    expect(engine.spawnedWaves).toBe(4);
    expect(engine.westSpawned).toBe(2);
    expect(engine.night.hp).toBe(30);
    expect(engine.west.hp).toBe(20);
  });

  test("restore clamps match Godot apply_save_dict", () => {
    seedActiveNight(engine);
    engine.saveGame();
    const stored = JSON.parse(localStorage.getItem("crownfall_save_slot_0") as string) as Record<string, unknown>;
    const ne = stored.night_encounter as Record<string, unknown>;
    // hand-crafted out-of-range values (validation accepts finite ≥ 0,
    // Godot clamps on restore: timers ≤ ATTACK_INTERVAL, burn ≤ 1)
    ne.attack_timer = 5;
    ne.light_burn_acc = 3;
    ne.west_attack_timer = 2.5;
    ne.west_burn_acc = 9;
    localStorage.setItem("crownfall_save_slot_0", JSON.stringify(stored));

    expect(engine.loadGame()).toBe(true);
    expect(engine.night.attackTimer).toBe(NIGHT.ATTACK_INTERVAL); // 1.0
    expect(engine.night.burnAccumulator).toBe(1);
    expect(engine.west.attackTimer).toBe(NIGHT.ATTACK_INTERVAL);
    expect(engine.west.burnAccumulator).toBe(1);
  });

  test("trampled lists are filtered per side exactly like apply_save_dict", () => {
    seedActiveNight(engine);
    engine.saveGame();
    const stored = JSON.parse(localStorage.getItem("crownfall_save_slot_0") as string) as Record<string, unknown>;
    const ne = stored.night_encounter as Record<string, unknown>;
    // east list carrying a west-only id, west list carrying east-only ids —
    // the validator whitelist accepts them (union), the restore filters.
    ne.east_trampled = ["farm_west_01", "watchtower_east_01"];
    ne.west_trampled = ["watchtower_east_01", "farm_west_01"];
    localStorage.setItem("crownfall_save_slot_0", JSON.stringify(stored));

    expect(engine.loadGame()).toBe(true);
    expect(engine.eastTrampled).toEqual(["watchtower_east_01"]);
    expect(engine.westTrampled).toEqual(["farm_west_01"]);
  });

  test("legacy saves without the six fields restore to safe defaults", () => {
    seedActiveNight(engine);
    engine.saveGame();
    const stored = JSON.parse(localStorage.getItem("crownfall_save_slot_0") as string) as Record<string, unknown>;
    const ne = stored.night_encounter as Record<string, unknown>;
    for (const key of [
      "attack_timer",
      "light_burn_acc",
      "west_attack_timer",
      "west_burn_acc",
      "east_trampled",
      "west_trampled",
    ]) {
      delete ne[key];
    }
    localStorage.setItem("crownfall_save_slot_0", JSON.stringify(stored));

    expect(engine.loadGame()).toBe(true);
    expect(engine.night.attackTimer).toBe(0);
    expect(engine.night.burnAccumulator).toBe(0);
    expect(engine.west.attackTimer).toBe(0);
    expect(engine.west.burnAccumulator).toBe(0);
    expect(engine.eastTrampled).toEqual([]);
    expect(engine.westTrampled).toEqual([]);
    // core encounter fields still restored
    expect(engine.night.active).toBe(true);
    expect(engine.night.hp).toBe(30);
  });

  test("invalid sub-field types are rejected without touching live state", () => {
    seedActiveNight(engine);
    engine.saveGame();
    const goldBefore = engine.gold;
    const dayBefore = engine.day;

    for (const patch of [
      { attack_timer: "soon" },
      { light_burn_acc: -1 },
      { west_attack_timer: Number.NaN },
      { east_trampled: "wall" },
      { west_trampled: [42] },
      { east_trampled: ["unknown_plot"] },
    ] as Array<Record<string, unknown>>) {
      const stored = JSON.parse(
        localStorage.getItem("crownfall_save_slot_0") as string,
      ) as Record<string, unknown>;
      Object.assign(
        stored.night_encounter as Record<string, unknown>,
        patch,
      );
      localStorage.setItem("crownfall_save_slot_0", JSON.stringify(stored));
      expect(engine.loadGame()).toBe(false);
    }

    expect(engine.gold).toBe(goldBefore);
    expect(engine.day).toBe(dayBefore);
    expect(engine.night.attackTimer).toBeCloseTo(0.6, 6); // unchanged
    expect(engine.eastTrampled).toEqual(["watchtower_east_01", "farm_east_01"]);
  });

  test("no duplicate enemy attacks after mid-combat restoration", () => {
    seedActiveNight(engine);
    engine.saveGame();
    // seed attack_timer near the firing threshold via the stored payload
    const stored = JSON.parse(localStorage.getItem("crownfall_save_slot_0") as string) as Record<string, unknown>;
    (stored.night_encounter as Record<string, unknown>).attack_timer = 0.9;
    localStorage.setItem("crownfall_save_slot_0", JSON.stringify(stored));

    expect(engine.loadGame()).toBe(true);
    expect(engine.night.attackTimer).toBeCloseTo(0.9, 6);
    const durabilityBefore = engine.plots.get(WALL_ID)?.durability ?? 0;

    // one 0.2 s step crosses ATTACK_INTERVAL exactly once
    engine.update(0.2);
    const durabilityAfter = engine.plots.get(WALL_ID)?.durability ?? 0;
    // raider (15 dmg), enemy at x=400 outside hearth light → exactly one
    // hit of 15; watchtower support only applies with a built watchtower.
    expect(durabilityBefore - durabilityAfter).toBe(15);
    expect(engine.night.attackTimer).toBeCloseTo(0.1, 6);
  });

  test("no regressions: normal (non-night) save still round-trips with defaults", () => {
    engine.newGame();
    engine.gold = 10;
    expect(engine.saveGame()).toBe(true);
    engine.gold = 1;
    expect(engine.loadGame()).toBe(true);
    expect(engine.gold).toBe(10);
    expect(engine.night.attackTimer).toBe(0);
    expect(engine.night.burnAccumulator).toBe(0);
    expect(engine.eastTrampled).toEqual([]);
    expect(engine.westTrampled).toEqual([]);
  });
});
