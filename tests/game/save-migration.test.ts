// Crownfall: The Last Light — Phase 4 P2-B/P4-B regression tests.
// Explicit migration pipeline: legacy payloads are migrated BEFORE validation
// (parity with SaveManager.gd `_read_and_validate_file`), unsupported versions
// are rejected explicitly, and migrated saves re-save cleanly as web v3.
//
// Fixtures use the VERIFIED historical payload structures:
//  - Godot schema v1 (commit 3e6e6e8): no player/night_encounter/camp
//    vagrants; progression_flags = first_night_survived + collected_nodes[];
//    buildings without level/type.
//  - Godot schema v2 (current Godot format): full structure incl.
//    night_encounter; early v2 saves may lack current_day_number/era_id
//    (Godot migrate_payload backfills both).
//  - Web v1/v2 never existed (git log -S SAVE_SCHEMA_VERSION: v3 since the
//    first commit introducing the constant) — the version numbers 1 and 2
//    are treated as the Godot formats they verifiably were.

import { describe, expect, test } from "bun:test";

import {
  CURRENT_WEB_SCHEMA,
  MAX_SUPPORTED_SCHEMA,
  MIN_SUPPORTED_SCHEMA,
  migrateSavePayload,
  normalizeReignState,
} from "../../src/lib/game/save-migration";
import { validateSavePayload } from "../../src/lib/game/save-validation";
import { SAVE_BACKUP_KEY, SAVE_KEY } from "../../src/lib/game/data";
import {
  installStorage,
  makeEngine,
  seedMidGameState,
  writeSlot,
} from "./helpers";

// ---------------------------------------------------------------------------
// Realistic historical fixtures (representative structures, NOT re-tagged
// modern payloads)
// ---------------------------------------------------------------------------

/** Verified Godot v1 layout: what ForgottenShoreSession.build_save_payload
 * wrote at commit 3e6e6e8 (SCHEMA_VERSION = 1). */
function makeGodotV1Payload(): Record<string, unknown> {
  return {
    schema_version: 1,
    world_id: "aetherion",
    island_id: "forgotten_shore",
    day_count: 3,
    world_time: 120.5,
    world_phase: "daylight",
    resources: { gold: 7, wood: 9, stone: 4 },
    buildings: [
      {
        id: "wall_east_01",
        state: "COMPLETED",
        durability: 150,
        position_x: 380.0,
      },
    ],
    npcs: [
      {
        id: "npc_builder_01",
        recruited: true,
        role: "builder",
        state: "IDLE",
        position_x: -220,
      },
    ],
    progression_flags: {
      first_night_survived: true,
      collected_nodes: ["cache_gold_west", "timber_pile_west", "shrine_cache_far_west"],
    },
  };
}

/** Realistic early Godot v2 layout: full structure including night_encounter,
 * but predating the era system and the current_day_number backfill — the two
 * fields Godot's cross-version migration backfills. reign_state is the
 * legacy numeric encoding the migration normalizes. */
function makeGodotV2Payload(): Record<string, unknown> {
  return {
    schema_version: 2,
    world_id: "aetherion",
    island_id: "forgotten_shore",
    day_count: 4,
    world_time: 30.0,
    world_phase: "sunset",
    player: { position_x: 123.4, facing_direction: -1 },
    resources: { gold: 12, wood: 15, stone: 8 },
    buildings: [
      {
        id: "wall_east_01",
        type: "stone_wall",
        position_x: 380.0,
        level: 2,
        state: "DAMAGED",
        durability: 90,
        progress: 1,
        max_durability: 260,
      },
      {
        id: "farm_west_01",
        type: "farm_plot",
        position_x: -310.0,
        level: 1,
        state: "COMPLETED",
        durability: 64,
        progress: 1,
        max_durability: 80,
      },
    ],
    npcs: [
      {
        id: "npc_builder_01",
        recruited: true,
        role: "builder",
        state: "IDLE",
        position_x: -57.5,
        farm_timer: 0,
      },
    ],
    camp_vagrants_available: 1,
    night_encounter: {
      night_active: false,
      night_elapsed: 0,
      spawned_wave_count: 2,
      enemy_active: false,
      enemy_x: 820,
      enemy_hp: 0,
      enemy_max_hp: 45,
      enemy_archetype: "raider",
      west_spawned_count: 1,
      west_enemy_active: false,
      west_enemy_x: -820,
      west_enemy_hp: 0,
      west_enemy_max_hp: 45,
      settlement_breached: false,
      first_night_survived: true,
    },
    progression_flags: {
      first_night_survived: true,
      reign_state: 1, // legacy numeric encoding (1 = BREACH_PENALTY)
      hearth_level: 2,
      shipwreck_stage: 1,
      portal_relic_looted: true,
      node_states: { cache_gold_west: true, timber_pile_west: true },
      tree_states: { tree_west_01: 1 },
    },
  };
}

describe("migrateSavePayload — pipeline contract", () => {
  test("current web schema (v3) passes through unchanged", () => {
    const payload = { ...makeGodotV2Payload(), schema_version: 3 };
    const result = migrateSavePayload(payload);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.fromVersion).toBe(3);
    expect(result.data.schema_version).toBe(CURRENT_WEB_SCHEMA);
    expect(validateSavePayload(result.data)).toBe(true);
  });

  test("non-object roots and missing/invalid schema versions rejected explicitly", () => {
    for (const bad of [null, [1, 2], "save", 42]) {
      expect(migrateSavePayload(bad).ok).toBe(false);
    }
    const noVersion = makeGodotV2Payload();
    delete noVersion.schema_version;
    const r1 = migrateSavePayload(noVersion);
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.reason).toContain("schema_version");

    for (const v of [0, -1, 4, 99]) {
      const p = { ...makeGodotV2Payload(), schema_version: v };
      const r = migrateSavePayload(p);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toContain("unsupported schema_version");
    }
    // non-integer / wrong-type versions fail the exact-int gate
    for (const v of [1.5, "3", null]) {
      const r = migrateSavePayload({
        ...makeGodotV2Payload(),
        schema_version: v,
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toContain("schema_version");
    }
  });

  test("supported version bounds exported and consistent", () => {
    expect(MIN_SUPPORTED_SCHEMA).toBe(1);
    expect(MAX_SUPPORTED_SCHEMA).toBe(CURRENT_WEB_SCHEMA);
    expect(CURRENT_WEB_SCHEMA).toBe(3);
  });

  test("migration deep-clones — input object is never mutated", () => {
    const payload = makeGodotV1Payload();
    const snapshot = JSON.stringify(payload);
    const result = migrateSavePayload(payload);
    expect(result.ok).toBe(true);
    expect(JSON.stringify(payload)).toBe(snapshot); // untouched
    if (result.ok) expect(result.data).not.toBe(payload);
  });
});

describe("migrateSavePayload — Godot v1 transforms (verified meanings only)", () => {
  test("realistic v1 fixture: all Godot migrate_payload transforms applied", () => {
    const result = migrateSavePayload(makeGodotV1Payload());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const d = result.data;

    expect(d.schema_version).toBe(3);

    // player default injected (Godot: d["player"] = {position_x: 0, facing_direction: 1})
    expect(d.player).toEqual({ position_x: 0, facing_direction: 1 });

    const pf = d.progression_flags as Record<string, unknown>;
    // reign_state absent → normalized default ACTIVE
    expect(pf.reign_state).toBe("ACTIVE");
    // defaults for fields introduced after v1
    expect(pf.hearth_level).toBe(1);
    expect(pf.shipwreck_stage).toBe(0);
    expect(pf.portal_relic_looted).toBe(false);
    // collected_nodes array → node_states map (preserving every id)
    expect(pf.node_states).toEqual({
      cache_gold_west: true,
      timber_pile_west: true,
      shrine_cache_far_west: true,
    });
    // era inferred (no stone_wall building → wood_age)
    expect(pf.era_id).toBe("wood_age");
    // original legacy key preserved (Godot does not delete it; validators
    // ignore unknown progression_flags keys)
    expect("collected_nodes" in pf).toBe(true);

    // buildings get level/type defaults (Godot v1 block)
    const buildings = d.buildings as Array<Record<string, unknown>>;
    expect(buildings[0].level).toBe(1);
    expect(buildings[0].type).toBe("wooden_wall");
  });

  test("v1 with numeric reign_state normalizes 1→BREACH_PENALTY, 2→ISLAND_CLEARED", () => {
    const p = makeGodotV1Payload();
    (p.progression_flags as Record<string, unknown>).reign_state = 1;
    const r1 = migrateSavePayload(p);
    expect(r1.ok).toBe(true);
    if (r1.ok)
      expect(
        (r1.data.progression_flags as Record<string, unknown>).reign_state,
      ).toBe("BREACH_PENALTY");

    const p2 = makeGodotV1Payload();
    (p2.progression_flags as Record<string, unknown>).reign_state = 2;
    const r2 = migrateSavePayload(p2);
    if (r2.ok)
      expect(
        (r2.data.progression_flags as Record<string, unknown>).reign_state,
      ).toBe("ISLAND_CLEARED");

    // unknown numeric / invalid string → ACTIVE
    expect(normalizeReignState(7)).toBe("ACTIVE");
    expect(normalizeReignState("breach_penalty")).toBe("BREACH_PENALTY");
    expect(normalizeReignState("garbage")).toBe("ACTIVE");
    expect(normalizeReignState(undefined)).toBe("ACTIVE");
  });

  test("v1 with stone_wall building infers stone_age era", () => {
    const p = makeGodotV1Payload();
    const buildings = p.buildings as Array<Record<string, unknown>>;
    buildings[0].type = "stone_wall";
    buildings[0].level = 2;
    const r = migrateSavePayload(p);
    if (r.ok)
      expect(
        (r.data.progression_flags as Record<string, unknown>).era_id,
      ).toBe("stone_age");
  });

  test("v1 collected_nodes with non-array or node_states present keeps safe semantics", () => {
    // node_states already present → collected_nodes ignored (Godot: only
    // converts when node_states is missing or not a dict)
    const p = makeGodotV1Payload();
    (p.progression_flags as Record<string, unknown>).node_states = {
      cache_gold_west: false,
    };
    const r = migrateSavePayload(p);
    if (r.ok)
      expect((r.data.progression_flags as Record<string, unknown>).node_states)
        .toEqual({ cache_gold_west: false });

    // collected_nodes missing → empty node_states map
    const p2 = makeGodotV1Payload();
    delete (p2.progression_flags as Record<string, unknown>).collected_nodes;
    const r2 = migrateSavePayload(p2);
    if (r2.ok)
      expect((r2.data.progression_flags as Record<string, unknown>).node_states)
        .toEqual({});
  });

  test("realistic v1 (no night_encounter) fails post-migration validation — Godot parity", () => {
    // Godot itself never synthesizes night_encounter for v1 payloads, so its
    // validate_payload rejects migrated v1 saves today. The web mirrors that
    // accept/reject outcome exactly — no fabricated encounter state.
    const migrated = migrateSavePayload(makeGodotV1Payload());
    expect(migrated.ok).toBe(true);
    if (migrated.ok) expect(validateSavePayload(migrated.data)).toBe(false);
  });

  test("v1 with malformed/impossible values is rejected after migration", () => {
    const p = makeGodotV1Payload();
    (p.resources as Record<string, unknown>).gold = -50;
    const r = migrateSavePayload(p);
    expect(r.ok).toBe(true); // migration is structural, not semantic
    if (r.ok) expect(validateSavePayload(r.data)).toBe(false); // validator rejects
  });
});

describe("migrateSavePayload — Godot v2 → web v3", () => {
  test("realistic early-v2 fixture: backfills applied, validation passes", () => {
    const result = migrateSavePayload(makeGodotV2Payload());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const d = result.data;
    expect(d.schema_version).toBe(3);
    // cross-version backfill: current_day_number ← max(1, day_count)
    expect(
      (d.night_encounter as Record<string, unknown>).current_day_number,
    ).toBe(4);
    // era_id backfilled (stone_wall present → stone_age)
    expect(
      (d.progression_flags as Record<string, unknown>).era_id,
    ).toBe("stone_age");
    // legacy numeric reign_state in v2 is NOT rewritten by Godot (v1 block
    // only) — validation ignores non-string reign_state; the session restore
    // falls back to ACTIVE exactly like Godot's String() cast fallback.
    expect(
      (d.progression_flags as Record<string, unknown>).reign_state,
    ).toBe(1);
    expect(validateSavePayload(d)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Full load-path integration: migration happens inside readValidSaveCandidate
// (parse → migrate → validate), Continue-gating counts migrated legacy saves,
// and a migrated reign re-saves as web v3.
// ---------------------------------------------------------------------------

describe("loadGame — legacy saves migrate through the real load path", () => {
  test("Godot v2 save loads, preserves progression/resources/collected nodes", () => {
    installStorage();
    writeSlot(SAVE_KEY, JSON.stringify(makeGodotV2Payload()));
    const { engine } = makeEngine();
    engine.refreshHasSave();
    expect(engine.hasSave).toBe(true); // migrated legacy save counts as valid
    expect(engine.loadGame()).toBe(true);

    // preserved gameplay data
    expect(engine.gold).toBe(12);
    expect(engine.wood).toBe(15);
    expect(engine.stone).toBe(8);
    expect(engine.day).toBe(4);
    expect(engine.hearthLevel).toBe(2);
    expect(engine.shipwreckStage).toBe(1);
    expect(engine.portalLooted).toBe(true);
    expect(engine.firstNightSurvived).toBe(true);
    expect(engine.nodeStates.get("cache_gold_west")).toBe(true);
    expect(engine.nodeStates.get("timber_pile_west")).toBe(true);
    expect(engine.treeHp.get("tree_west_01")).toBe(1);
    expect(engine.spawnedWaves).toBe(2);
    expect(engine.nightDayNumber).toBe(4); // backfilled from day_count
    // legacy numeric reign_state falls back to ACTIVE (Godot String() parity)
    expect(engine.reign).toBe("ACTIVE");
    const wall = engine.plots.get("wall_east_01");
    expect(wall?.type).toBe("stone_wall");
    expect(wall?.state).toBe("DAMAGED");
    expect(wall?.durability).toBe(90);
  });

  test("Godot v1 save is rejected safely (Godot parity) — no fresh reign, state untouched", () => {
    installStorage();
    const { engine, hooks } = makeEngine();
    engine.newGame();
    seedMidGameState(engine);
    const goldBefore = engine.gold;
    const dayBefore = engine.day;
    writeSlot(SAVE_KEY, JSON.stringify(makeGodotV1Payload()));
    engine.refreshHasSave();
    expect(engine.hasSave).toBe(false); // not loadable — same as Godot today
    expect(engine.loadGame()).toBe(false);
    // live state untouched, never silently replaced by a fresh reign
    expect(engine.gold).toBe(goldBefore);
    expect(engine.day).toBe(dayBefore);
    expect(hooks.victories).toHaveLength(0);
  });

  test("corrupt primary + legacy v2 backup recovers via migration", () => {
    installStorage();
    writeSlot(SAVE_KEY, "{broken json");
    writeSlot(SAVE_BACKUP_KEY, JSON.stringify(makeGodotV2Payload()));
    const { engine } = makeEngine();
    expect(engine.loadGame()).toBe(true);
    expect(engine.gold).toBe(12);
    // self-heal rewrites the primary with the MIGRATED current-schema payload
    const healed = JSON.parse(localStorage.getItem(SAVE_KEY) as string) as Record<
      string,
      unknown
    >;
    expect(healed.schema_version).toBe(3);
    expect(validateSavePayload(healed)).toBe(true);
  });

  test("unsupported future schema is rejected by the load path", () => {
    installStorage();
    const future = { ...makeGodotV2Payload(), schema_version: 4 };
    writeSlot(SAVE_KEY, JSON.stringify(future));
    const { engine } = makeEngine();
    engine.refreshHasSave();
    expect(engine.hasSave).toBe(false);
    expect(engine.loadGame()).toBe(false);
  });

  test("migrated legacy reign re-saves as web v3 and reloads (round-trip)", () => {
    installStorage();
    writeSlot(SAVE_KEY, JSON.stringify(makeGodotV2Payload()));
    const { engine } = makeEngine();
    expect(engine.loadGame()).toBe(true);
    engine.gold = 20; // play a little after migration
    expect(engine.saveGame()).toBe(true);
    const saved = JSON.parse(localStorage.getItem(SAVE_KEY) as string) as Record<
      string,
      unknown
    >;
    expect(saved.schema_version).toBe(3);
    expect(validateSavePayload(saved)).toBe(true);

    // reload into a fresh engine — everything survives
    const { engine: fresh } = makeEngine();
    expect(fresh.loadGame()).toBe(true);
    expect(fresh.gold).toBe(20);
    expect(fresh.hearthLevel).toBe(2);
    expect(fresh.portalLooted).toBe(true);
    expect(fresh.treeHp.get("tree_west_01")).toBe(1);
  });
});

describe("saveGame — migrated legacy primary backup staging", () => {
  test("valid Godot v2 primary is staged before being replaced by web v3", () => {
    installStorage();
    const legacyRaw = JSON.stringify(makeGodotV2Payload());
    writeSlot(SAVE_KEY, legacyRaw);

    const { engine } = makeEngine();
    expect(engine.loadGame()).toBe(true);
    engine.gold = 20;
    expect(engine.saveGame()).toBe(true);

    // Godot's SaveManager validates the existing save through migration
    // before staging its original bytes as .bak. Web must do the same:
    // the v2 payload is valid after migration, even though raw v2 is not
    // accepted by the current-schema-only validator.
    expect(localStorage.getItem(SAVE_BACKUP_KEY)).toBe(legacyRaw);

    // Prove the staged legacy backup remains recoverable and self-heals to v3.
    localStorage.setItem(SAVE_KEY, "{corrupt-primary");
    const { engine: recovered } = makeEngine();
    expect(recovered.loadGame()).toBe(true);
    expect(recovered.gold).toBe(12); // original v2 backup, not overwritten
    const healed = JSON.parse(
      localStorage.getItem(SAVE_KEY) as string,
    ) as Record<string, unknown>;
    expect(healed.schema_version).toBe(3);
    expect((healed.resources as Record<string, unknown>).gold).toBe(12);
  });
});
