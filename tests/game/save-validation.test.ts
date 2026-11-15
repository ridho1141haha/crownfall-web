// B4 regression: validateSavePayload must reject everything Godot's
// SaveManager.validate_payload + per-manager validators reject, while still
// accepting every legitimate save the current web game produces.

import { describe, test, expect, beforeEach } from "bun:test";
import { installStorage, makeValidPayload, clone } from "./helpers";
import {
  isExactIntValue,
  isValidSavedBuildingDict,
  isValidSavedEncounterDict,
  isValidSavedNpcDict,
  isValidSavedTreeStates,
  MAX_RESOURCE_CAP,
  validateSavePayload,
} from "../../src/lib/game/save-validation";
import { migrateSavePayload } from "../../src/lib/game/save-migration";

describe("isExactIntValue (EconomyLedger.is_exact_int_value parity)", () => {
  test("accepts integers and integral floats", () => {
    expect(isExactIntValue(3)).toBe(true);
    expect(isExactIntValue(3.0)).toBe(true);
    expect(isExactIntValue(-2)).toBe(true);
    expect(isExactIntValue(0)).toBe(true);
  });

  test("rejects non-finite and fractional values", () => {
    expect(isExactIntValue(Number.NaN)).toBe(false);
    expect(isExactIntValue(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isExactIntValue(Number.NEGATIVE_INFINITY)).toBe(false);
    expect(isExactIntValue(3.5)).toBe(false);
    expect(isExactIntValue("3")).toBe(false);
    expect(isExactIntValue(null)).toBe(false);
    expect(isExactIntValue(undefined)).toBe(false);
  });
});

describe("B4 — validateSavePayload: non-finite and fractional rejection", () => {
  let base: Record<string, unknown>;
  beforeEach(() => {
    installStorage();
    base = makeValidPayload();
  });

  const reject = (mutate: (p: Record<string, unknown>) => void) => {
    const payload = clone(base);
    mutate(payload);
    return validateSavePayload(payload);
  };

  test("Infinity day_count rejected (runtime-confirmed audit exploit)", () => {
    expect(
      reject((p) => {
        (p as { day_count: number }).day_count = Number.POSITIVE_INFINITY;
      }),
    ).toBe(false);
  });

  test("Infinity gold rejected", () => {
    expect(
      reject((p) => {
        const res = p.resources as { gold: number };
        res.gold = 1e999; // parses to Infinity from raw JSON
      }),
    ).toBe(false);
  });

  test("NaN wood rejected", () => {
    expect(
      reject((p) => {
        const res = p.resources as { wood: number };
        res.wood = Number.NaN;
      }),
    ).toBe(false);
  });

  test("fractional day_count rejected", () => {
    expect(reject((p) => (p.day_count = 3.5))).toBe(false);
  });

  test("fractional resource rejected", () => {
    expect(
      reject((p) => {
        (p.resources as { stone: number }).stone = 2.5;
      }),
    ).toBe(false);
  });

  test("Infinity inside night_encounter rejected", () => {
    expect(
      reject((p) => {
        const ne = p.night_encounter as Record<string, unknown>;
        ne.enemy_x = Number.POSITIVE_INFINITY;
        ne.enemy_active = true;
        ne.enemy_hp = 45;
      }),
    ).toBe(false);
  });

  test("Infinity survives the raw JSON text route and is rejected", () => {
    const raw = JSON.stringify(base).replace('"day_count":3', '"day_count":1e999');
    expect(raw).toContain("1e999"); // mutation actually applied
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed.day_count).toBe(Number.POSITIVE_INFINITY);
    expect(validateSavePayload(parsed)).toBe(false);
  });
});

describe("B4 — schema/version/world identifiers", () => {
  let base: Record<string, unknown>;
  beforeEach(() => {
    installStorage();
    base = makeValidPayload();
  });

  const reject = (mutate: (p: Record<string, unknown>) => void) => {
    const payload = clone(base);
    mutate(payload);
    return validateSavePayload(payload);
  };

  test("web schema version 3 accepted (platform difference preserved)", () => {
    expect(base.schema_version).toBe(3);
    expect(validateSavePayload(base)).toBe(true);
  });

  test("legacy versions 1..2 rejected by the validator — migration required first", () => {
    // P2-B/P4-B: a schema version is never accepted without the migration
    // needed for it. v1/v2 payloads must go through migrateSavePayload();
    // the Phase 2/3 range acceptance (1..3) let a raw v1 payload through
    // with no migration path.
    for (const v of [1, 2]) {
      expect(reject((p) => (p.schema_version = v))).toBe(false);
      const migrated = migrateSavePayload({ ...base, schema_version: v });
      expect(migrated.ok).toBe(true);
      if (migrated.ok) {
        expect(migrated.data.schema_version).toBe(3);
        // v3-shaped v2 fixture migrates cleanly; v1 fixture keeps Godot's
        // own accept/reject outcome (see save-migration.test.ts).
      }
    }
  });

  test("unsupported versions rejected", () => {
    for (const v of [0, 4, -1, 1.5, "3", null]) {
      expect(reject((p) => (p.schema_version = v as number))).toBe(false);
      expect(migrateSavePayload({ ...base, schema_version: v }).ok).toBe(
        false,
      );
    }
  });

  test("missing / empty world and island ids rejected", () => {
    expect(reject((p) => delete p.world_id)).toBe(false);
    expect(reject((p) => (p.world_id = ""))).toBe(false);
    expect(reject((p) => (p.island_id = "   "))).toBe(false);
    expect(reject((p) => (p.island_id = 42))).toBe(false);
  });

  test("missing required top-level keys rejected", () => {
    for (const key of [
      "schema_version",
      "world_id",
      "island_id",
      "day_count",
      "world_time",
      "world_phase",
      "resources",
      "buildings",
      "npcs",
      "night_encounter",
      "progression_flags",
    ]) {
      expect(reject((p) => delete p[key])).toBe(false);
    }
  });

  test("invalid world_phase rejected", () => {
    expect(reject((p) => (p.world_phase = "midnight"))).toBe(false);
    expect(reject((p) => (p.world_phase = 1))).toBe(false);
  });

  test("negative world_time rejected", () => {
    expect(reject((p) => (p.world_time = -1))).toBe(false);
  });

  test("non-object roots rejected", () => {
    expect(validateSavePayload(null)).toBe(false);
    expect(validateSavePayload([1, 2])).toBe(false);
    expect(validateSavePayload("save")).toBe(false);
    expect(validateSavePayload(3)).toBe(false);
    expect(validateSavePayload(undefined)).toBe(false);
  });
});

describe("B4 — resources", () => {
  let base: Record<string, unknown>;
  beforeEach(() => {
    installStorage();
    base = makeValidPayload();
  });

  const reject = (mutate: (p: Record<string, unknown>) => void) => {
    const payload = clone(base);
    mutate(payload);
    return validateSavePayload(payload);
  };

  test("negative resources rejected", () => {
    expect(
      reject((p) => {
        (p.resources as { gold: number }).gold = -1;
      }),
    ).toBe(false);
  });

  test("resources above the 999,999 cap rejected", () => {
    expect(
      reject((p) => {
        (p.resources as { gold: number }).gold = MAX_RESOURCE_CAP + 1;
      }),
    ).toBe(false);
    expect(
      reject((p) => {
        (p.resources as { wood: number }).wood = 1000000;
      }),
    ).toBe(false);
  });

  test("cap boundary value accepted", () => {
    expect(
      reject((p) => {
        (p.resources as { gold: number }).gold = MAX_RESOURCE_CAP;
      }),
    ).toBe(true);
  });

  test("missing resource keys rejected", () => {
    expect(
      reject((p) => {
        delete (p.resources as { stone?: number }).stone;
      }),
    ).toBe(false);
  });

  test("non-numeric resources rejected", () => {
    expect(
      reject((p) => {
        (p.resources as { gold: unknown }).gold = "100";
      }),
    ).toBe(false);
  });
});

describe("B4 — buildings (is_valid_saved_building_dict parity)", () => {
  let base: Record<string, unknown>;
  beforeEach(() => {
    installStorage();
    base = makeValidPayload();
  });

  const reject = (mutate: (p: Record<string, unknown>) => void) => {
    const payload = clone(base);
    mutate(payload);
    return validateSavePayload(payload);
  };

  test("PLACEHOLDER with durability > 0 rejected (runtime-confirmed audit exploit)", () => {
    expect(
      reject((p) => {
        const b = (p.buildings as Array<Record<string, unknown>>)[0];
        b.state = "PLACEHOLDER";
        b.durability = 100; // ≤ max_durability 150, old web check passed this
      }),
    ).toBe(false);
  });

  test("DESTROYED with durability > 0 rejected", () => {
    expect(
      reject((p) => {
        const b = (p.buildings as Array<Record<string, unknown>>)[0];
        b.state = "DESTROYED";
        b.durability = 5;
      }),
    ).toBe(false);
  });

  test("COMPLETED with durability 0 rejected", () => {
    expect(
      reject((p) => {
        const b = (p.buildings as Array<Record<string, unknown>>)[0];
        b.state = "COMPLETED";
        b.durability = 0;
      }),
    ).toBe(false);
  });

  test("DAMAGED with durability 0 rejected", () => {
    expect(
      reject((p) => {
        const b = (p.buildings as Array<Record<string, unknown>>)[0];
        b.state = "DAMAGED";
        b.durability = 0;
      }),
    ).toBe(false);
  });

  test("durability above max_durability rejected", () => {
    expect(
      reject((p) => {
        const b = (p.buildings as Array<Record<string, unknown>>)[0];
        b.durability = 999;
      }),
    ).toBe(false);
  });

  test("non-integer durability / progress / level rejected", () => {
    expect(
      reject((p) => {
        (p.buildings as Array<Record<string, unknown>>)[0].durability = 10.5;
      }),
    ).toBe(false);
    expect(
      reject((p) => {
        (p.buildings as Array<Record<string, unknown>>)[0].progress = 0.5;
      }),
    ).toBe(true); // progress is a float by design
    expect(
      reject((p) => {
        (p.buildings as Array<Record<string, unknown>>)[0].level = 1.5;
      }),
    ).toBe(false);
    expect(
      reject((p) => {
        (p.buildings as Array<Record<string, unknown>>)[0].level = 3;
      }),
    ).toBe(false);
  });

  test("stone_wall with level < 2 rejected", () => {
    expect(
      reject((p) => {
        const b = (p.buildings as Array<Record<string, unknown>>)[0];
        b.type = "stone_wall";
        b.level = 1;
        b.max_durability = 260;
        b.durability = 260;
        b.state = "COMPLETED";
      }),
    ).toBe(false);
  });

  test("watchtower / farm_plot with level 2 rejected", () => {
    expect(
      reject((p) => {
        const b = (p.buildings as Array<Record<string, unknown>>)[1]; // watchtower
        b.level = 2;
      }),
    ).toBe(false);
  });

  test("wrong type for a plot id rejected", () => {
    expect(
      reject((p) => {
        const b = (p.buildings as Array<Record<string, unknown>>)[2]; // farm_east
        b.type = "watchtower";
      }),
    ).toBe(false);
  });

  test("unknown plot id rejected", () => {
    expect(
      reject((p) => {
        const b = (p.buildings as Array<Record<string, unknown>>)[0];
        b.id = "wall_north_99";
      }),
    ).toBe(false);
  });

  test("duplicate plot ids rejected", () => {
    expect(
      reject((p) => {
        const arr = p.buildings as Array<Record<string, unknown>>;
        arr[1].id = arr[0].id;
      }),
    ).toBe(false);
  });

  test("empty buildings array rejected", () => {
    expect(reject((p) => (p.buildings = []))).toBe(false);
    expect(reject((p) => (p.buildings = "nope"))).toBe(false);
  });

  test("building position outside the world bounds rejected", () => {
    expect(
      reject((p) => {
        (p.buildings as Array<Record<string, unknown>>)[0].position_x = 99999;
      }),
    ).toBe(false);
  });

  test("standalone building validator rejects garbage", () => {
    expect(isValidSavedBuildingDict(null)).toBe(false);
    expect(isValidSavedBuildingDict("wall")).toBe(false);
    expect(isValidSavedBuildingDict({})).toBe(false);
    expect(isValidSavedBuildingDict({ id: "", state: "COMPLETED", durability: 1 })).toBe(false);
    expect(isValidSavedBuildingDict({ id: "wall_east_01", state: "NOPE", durability: 1 })).toBe(false);
    expect(
      isValidSavedBuildingDict({
        id: "wall_east_01",
        state: "COMPLETED",
        durability: 1.5,
      }),
    ).toBe(false);
    expect(
      isValidSavedBuildingDict({
        id: "wall_east_01",
        state: "COMPLETED",
        durability: 10,
      }),
    ).toBe(true);
  });
});

describe("B4 — npcs (is_valid_saved_npc_dict parity)", () => {
  let base: Record<string, unknown>;
  beforeEach(() => {
    installStorage();
    base = makeValidPayload();
  });

  const reject = (mutate: (p: Record<string, unknown>) => void) => {
    const payload = clone(base);
    mutate(payload);
    return validateSavePayload(payload);
  };

  test("invalid roles rejected", () => {
    expect(
      reject((p) => {
        (p.npcs as Array<Record<string, unknown>>)[0].role = "wizard";
      }),
    ).toBe(false);
  });

  test("invalid states rejected", () => {
    expect(
      reject((p) => {
        (p.npcs as Array<Record<string, unknown>>)[0].state = "SLEEPING";
      }),
    ).toBe(false);
  });

  test("non-boolean recruited rejected", () => {
    expect(
      reject((p) => {
        (p.npcs as Array<Record<string, unknown>>)[0].recruited = "yes";
      }),
    ).toBe(false);
  });

  test("farm_timer outside [0, 60] rejected (audit gap 2.4.7)", () => {
    expect(
      reject((p) => {
        (p.npcs as Array<Record<string, unknown>>)[0].farm_timer = Number.NaN;
      }),
    ).toBe(false);
    expect(
      reject((p) => {
        (p.npcs as Array<Record<string, unknown>>)[0].farm_timer = 61;
      }),
    ).toBe(false);
    expect(
      reject((p) => {
        (p.npcs as Array<Record<string, unknown>>)[0].farm_timer = -3;
      }),
    ).toBe(false);
    expect(
      reject((p) => {
        (p.npcs as Array<Record<string, unknown>>)[0].farm_timer = 30.5;
      }),
    ).toBe(true); // fractional timer is a legitimate float
  });

  test("npc position outside world bounds rejected", () => {
    expect(
      reject((p) => {
        (p.npcs as Array<Record<string, unknown>>)[0].position_x = -99999;
      }),
    ).toBe(false);
  });

  test("duplicate npc ids rejected", () => {
    expect(
      reject((p) => {
        const arr = p.npcs as Array<Record<string, unknown>>;
        arr.push({ ...arr[0], id: "npc_01" });
        arr[1].id = arr[0].id;
      }),
    ).toBe(false);
  });

  test("empty npc array rejected", () => {
    expect(reject((p) => (p.npcs = []))).toBe(false);
  });

  test("population above MAX_POPULATION rejected", () => {
    expect(
      reject((p) => {
        const arr = p.npcs as Array<Record<string, unknown>>;
        const template = arr[0];
        for (let i = arr.length; i < 7; i++) {
          arr.push({ ...template, id: `npc_${String(i).padStart(2, "0")}` });
        }
      }),
    ).toBe(false);
  });

  test("standalone npc validator rejects garbage", () => {
    expect(isValidSavedNpcDict(null)).toBe(false);
    expect(isValidSavedNpcDict({ id: "npc_01", recruited: true, role: "builder", state: "IDLE", position_x: 0 })).toBe(
      true,
    );
    expect(isValidSavedNpcDict({ id: "  ", recruited: true, role: "builder", state: "IDLE" })).toBe(false);
    expect(
      isValidSavedNpcDict({
        id: "npc_01",
        recruited: true,
        role: "builder",
        state: "IDLE",
        position_x: Number.POSITIVE_INFINITY,
      }),
    ).toBe(false);
  });
});

describe("B4 — night encounter (is_valid_saved_encounter_dict parity)", () => {
  let base: Record<string, unknown>;
  beforeEach(() => {
    installStorage();
    base = makeValidPayload();
  });

  const reject = (mutate: (p: Record<string, unknown>) => void) => {
    const payload = clone(base);
    mutate(payload);
    return validateSavePayload(payload);
  };

  test("missing required encounter fields rejected", () => {
    for (const key of [
      "night_active",
      "night_elapsed",
      "spawned_wave_count",
      "enemy_active",
      "enemy_x",
      "enemy_hp",
      "settlement_breached",
      "first_night_survived",
    ]) {
      expect(
        reject((p) => {
          delete (p.night_encounter as Record<string, unknown>)[key];
        }),
      ).toBe(false);
    }
  });

  test("wave count above schedule rejected", () => {
    expect(
      reject((p) => {
        (p.night_encounter as { spawned_wave_count: number }).spawned_wave_count = 5;
      }),
    ).toBe(false);
  });

  test("enemy hp above MAX_POSSIBLE_ENEMY_HP rejected", () => {
    expect(
      reject((p) => {
        const ne = p.night_encounter as Record<string, unknown>;
        ne.enemy_hp = 161;
        ne.enemy_max_hp = 161;
        ne.enemy_active = true;
      }),
    ).toBe(false);
  });

  test("active enemy with hp 0 rejected", () => {
    expect(
      reject((p) => {
        const ne = p.night_encounter as Record<string, unknown>;
        ne.enemy_active = true;
        ne.enemy_hp = 0;
      }),
    ).toBe(false);
  });

  test("unknown enemy archetype rejected", () => {
    expect(
      reject((p) => {
        (p.night_encounter as Record<string, unknown>).enemy_archetype = "dragon";
      }),
    ).toBe(false);
  });

  test("negative / non-finite timers rejected", () => {
    for (const key of ["attack_timer", "light_burn_acc", "west_attack_timer", "west_burn_acc"]) {
      expect(
        reject((p) => {
          (p.night_encounter as Record<string, unknown>)[key] = -1;
        }),
      ).toBe(false);
      expect(
        reject((p) => {
          (p.night_encounter as Record<string, unknown>)[key] = Number.POSITIVE_INFINITY;
        }),
      ).toBe(false);
    }
  });

  test("trampled arrays with unknown plot ids rejected", () => {
    expect(
      reject((p) => {
        (p.night_encounter as Record<string, unknown>).east_trampled = ["wall_north_99"];
      }),
    ).toBe(false);
    expect(
      reject((p) => {
        (p.night_encounter as Record<string, unknown>).west_trampled = "farm_west_01";
      }),
    ).toBe(false);
    expect(
      reject((p) => {
        (p.night_encounter as Record<string, unknown>).east_trampled = [
          "watchtower_east_01",
          "farm_west_01",
        ];
      }),
    ).toBe(true);
  });

  test("west scout fields validated", () => {
    expect(
      reject((p) => {
        const ne = p.night_encounter as Record<string, unknown>;
        ne.west_spawned_count = 3; // > WEST_SCOUT_TIMES.length (2)
      }),
    ).toBe(false);
    expect(
      reject((p) => {
        const ne = p.night_encounter as Record<string, unknown>;
        ne.west_enemy_active = true;
        ne.west_enemy_hp = 0;
      }),
    ).toBe(false);
    expect(
      reject((p) => {
        const ne = p.night_encounter as Record<string, unknown>;
        ne.west_enemy_max_hp = 45;
        ne.west_enemy_hp = 50;
      }),
    ).toBe(false);
  });

  test("current_day_number above day_count rejected", () => {
    expect(
      reject((p) => {
        const ne = p.night_encounter as Record<string, unknown>;
        ne.current_day_number = 4; // day_count is 3
      }),
    ).toBe(false);
  });

  test("current_day_number backfilled from day_count is accepted", () => {
    expect(
      reject((p) => {
        const ne = p.night_encounter as Record<string, unknown>;
        delete ne.current_day_number;
      }),
    ).toBe(true);
  });

  test("standalone encounter validator rejects garbage", () => {
    expect(isValidSavedEncounterDict(null)).toBe(false);
    expect(isValidSavedEncounterDict({ night_active: true })).toBe(false);
    expect(
      isValidSavedEncounterDict({
        night_active: false,
        night_elapsed: 0,
        spawned_wave_count: 0,
        enemy_active: false,
        enemy_x: 820,
        enemy_hp: 0,
        settlement_breached: false,
        first_night_survived: false,
      }),
    ).toBe(true);
  });
});

describe("B4 — progression flags", () => {
  let base: Record<string, unknown>;
  beforeEach(() => {
    installStorage();
    base = makeValidPayload();
  });

  const reject = (mutate: (p: Record<string, unknown>) => void) => {
    const payload = clone(base);
    mutate(payload);
    return validateSavePayload(payload);
  };

  test("hearth_level outside 1..3 rejected", () => {
    expect(
      reject((p) => {
        (p.progression_flags as { hearth_level: number }).hearth_level = 0;
      }),
    ).toBe(false);
    expect(
      reject((p) => {
        (p.progression_flags as { hearth_level: number }).hearth_level = 4;
      }),
    ).toBe(false);
    expect(
      reject((p) => {
        (p.progression_flags as { hearth_level: number }).hearth_level = 2.5;
      }),
    ).toBe(false);
  });

  test("invalid reign_state rejected", () => {
    expect(
      reject((p) => {
        (p.progression_flags as { reign_state: string }).reign_state = "CONQUERED";
      }),
    ).toBe(false);
  });

  test("shipwreck_stage outside 0..3 rejected", () => {
    expect(
      reject((p) => {
        (p.progression_flags as { shipwreck_stage: number }).shipwreck_stage = 4;
      }),
    ).toBe(false);
    expect(
      reject((p) => {
        (p.progression_flags as { shipwreck_stage: number }).shipwreck_stage = -1;
      }),
    ).toBe(false);
  });

  test("node_states with non-boolean values rejected", () => {
    expect(
      reject((p) => {
        const ns = (p.progression_flags as { node_states: Record<string, unknown> }).node_states;
        ns.timber_pile_west = 1;
      }),
    ).toBe(false);
  });

  test("tree_states validated (unknown ids, hp > max)", () => {
    expect(
      reject((p) => {
        const ts = (p.progression_flags as { tree_states: Record<string, unknown> }).tree_states;
        ts.tree_moon_99 = 2;
      }),
    ).toBe(false);
    expect(
      reject((p) => {
        const ts = (p.progression_flags as { tree_states: Record<string, unknown> }).tree_states;
        ts.tree_west_01 = 4; // maxHp is 3
      }),
    ).toBe(false);
    expect(
      reject((p) => {
        const ts = (p.progression_flags as { tree_states: Record<string, unknown> }).tree_states;
        ts.tree_west_01 = 1.5;
      }),
    ).toBe(false);
  });

  test("unknown era_id rejected", () => {
    expect(
      reject((p) => {
        (p.progression_flags as { era_id: string }).era_id = "space_age";
      }),
    ).toBe(false);
  });

  test("hearth_boost_remaining outside [0, 60] rejected", () => {
    expect(
      reject((p) => {
        (p.progression_flags as { hearth_boost_remaining: number }).hearth_boost_remaining = 60.1;
      }),
    ).toBe(false);
    expect(
      reject((p) => {
        (p.progression_flags as { hearth_boost_remaining: number }).hearth_boost_remaining = -1;
      }),
    ).toBe(false);
  });

  test("camp_vagrants_available outside [0, 2] rejected", () => {
    expect(reject((p) => (p.camp_vagrants_available = 3))).toBe(false);
    expect(reject((p) => (p.camp_vagrants_available = -1))).toBe(false);
    expect(reject((p) => (p.camp_vagrants_available = 1.5))).toBe(false);
  });
});

describe("B4 — player", () => {
  let base: Record<string, unknown>;
  beforeEach(() => {
    installStorage();
    base = makeValidPayload();
  });

  const reject = (mutate: (p: Record<string, unknown>) => void) => {
    const payload = clone(base);
    mutate(payload);
    return validateSavePayload(payload);
  };

  test("player position outside world bounds rejected", () => {
    expect(
      reject((p) => {
        (p.player as { position_x: number }).position_x = 100000;
      }),
    ).toBe(false);
  });

  test("player position NaN/Infinity rejected", () => {
    expect(
      reject((p) => {
        (p.player as { position_x: number }).position_x = Number.NaN;
      }),
    ).toBe(false);
  });

  test("invalid facing rejected", () => {
    expect(
      reject((p) => {
        (p.player as { facing_direction: number }).facing_direction = 0;
      }),
    ).toBe(false);
    expect(
      reject((p) => {
        (p.player as { facing_direction: number }).facing_direction = 2;
      }),
    ).toBe(false);
    expect(
      reject((p) => {
        (p.player as { facing_direction: number }).facing_direction = -1;
      }),
    ).toBe(true);
  });

  test("non-object player rejected", () => {
    expect(reject((p) => (p.player = "here"))).toBe(false);
  });
});

describe("B4 — legitimate saves are not rejected", () => {
  test("fresh new-game payload passes", () => {
    installStorage();
    const payload = makeValidPayload();
    expect(validateSavePayload(payload)).toBe(true);
  });

  test("valid tree states map accepted standalone", () => {
    expect(isValidSavedTreeStates({ tree_west_01: 0, tree_east_02: 3 })).toBe(true);
    expect(isValidSavedTreeStates({})).toBe(true);
    expect(isValidSavedTreeStates({ tree_west_01: -1 })).toBe(false);
    expect(isValidSavedTreeStates({ unknown: 1 })).toBe(false);
    expect(isValidSavedTreeStates(null)).toBe(false);
  });

  test("every mutation class that mirrors normal play passes", () => {
    installStorage();
    const payload = makeValidPayload();
    // stone wall upgrade result
    const upgraded = clone(payload);
    const wall = (upgraded.buildings as Array<Record<string, unknown>>)[0];
    wall.type = "stone_wall";
    wall.level = 2;
    wall.max_durability = 260;
    wall.durability = 260;
    wall.state = "COMPLETED";
    expect(validateSavePayload(upgraded)).toBe(true);
    // mid-construction plot
    const constructing = clone(payload);
    const plot = (constructing.buildings as Array<Record<string, unknown>>)[1];
    plot.state = "UNDER_CONSTRUCTION";
    plot.progress = 0.5;
    expect(validateSavePayload(constructing)).toBe(true);
    // active night with a live enemy
    const nightFight = clone(payload);
    const ne = nightFight.night_encounter as Record<string, unknown>;
    ne.night_active = true;
    ne.night_elapsed = 42.5;
    ne.spawned_wave_count = 2;
    ne.enemy_active = true;
    ne.enemy_hp = 45;
    ne.enemy_max_hp = 45;
    ne.current_day_number = 3;
    ne.attack_timer = 0.4;
    expect(validateSavePayload(nightFight)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Phase 3.1 — hardening regressions (independent code review findings)
// ---------------------------------------------------------------------------

describe("Phase 3.1 — hearth_level: invalid PRESENT values rejected", () => {
  let base: Record<string, unknown>;
  beforeEach(() => {
    installStorage();
    base = makeValidPayload();
  });

  const reject = (mutate: (p: Record<string, unknown>) => void) => {
    const payload = clone(base);
    mutate(payload);
    return validateSavePayload(payload);
  };

  const setHearth = (value: unknown) => (p: Record<string, unknown>) => {
    (p.progression_flags as Record<string, unknown>).hearth_level = value;
  };

  test("hearth_level 0 rejected", () => {
    expect(reject(setHearth(0))).toBe(false);
  });

  test("hearth_level 4 rejected", () => {
    expect(reject(setHearth(4))).toBe(false);
  });

  test("fractional hearth_level rejected", () => {
    expect(reject(setHearth(2.5))).toBe(false);
  });

  test("NaN hearth_level rejected", () => {
    expect(reject(setHearth(Number.NaN))).toBe(false);
  });

  test("Infinity hearth_level rejected", () => {
    expect(reject(setHearth(Number.POSITIVE_INFINITY))).toBe(false);
  });

  test("Infinity hearth_level rejected via the raw JSON text route", () => {
    // JSON has no NaN literal — 1e999 parses to Infinity (mirrors the
    // corrupted-file route the audit used for day_count).
    const raw = JSON.stringify(base).replace(
      '"hearth_level":2',
      '"hearth_level":1e999',
    );
    expect(raw).toContain("1e999"); // mutation actually applied
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const pf = parsed.progression_flags as Record<string, unknown>;
    expect(pf.hearth_level).toBe(Number.POSITIVE_INFINITY);
    expect(validateSavePayload(parsed)).toBe(false);
  });

  test("non-numeric hearth_level (string) rejected", () => {
    expect(reject(setHearth("2"))).toBe(false);
  });
});

describe("Phase 3.1 — hearth_level: valid values and absence accepted", () => {
  beforeEach(() => {
    installStorage();
  });

  test("hearth_level 1, 2 and 3 accepted", () => {
    for (const level of [1, 2, 3]) {
      const payload = makeValidPayload();
      (payload.progression_flags as Record<string, unknown>).hearth_level =
        level;
      expect(validateSavePayload(payload)).toBe(true);
    }
  });

  test("absent hearth_level stays optional (Godot injects the default at load)", () => {
    // Godot SaveManager.gd:165-166 injects hearth_level = 1 AFTER parse and
    // BEFORE validate, so absent is a legitimate pre-load shape. The web
    // validator mirrors that by keeping the field optional; the default is
    // applied by the restore path (tested in save-load.test.ts).
    const payload = makeValidPayload();
    delete (payload.progression_flags as Record<string, unknown>).hearth_level;
    expect(validateSavePayload(payload)).toBe(true);
  });
});

describe("Phase 3.1 — building type: non-string values rejected", () => {
  let base: Record<string, unknown>;
  beforeEach(() => {
    installStorage();
    base = makeValidPayload();
  });

  const reject = (mutate: (p: Record<string, unknown>) => void) => {
    const payload = clone(base);
    mutate(payload);
    return validateSavePayload(payload);
  };

  const wallOf = (p: Record<string, unknown>) =>
    (p.buildings as Array<Record<string, unknown>>).find(
      (b) => b.id === "wall_east_01",
    ) as Record<string, unknown>;

  test("numeric type rejected", () => {
    expect(
      reject((p) => {
        wallOf(p).type = 123;
      }),
    ).toBe(false);
  });

  test("boolean type rejected", () => {
    expect(
      reject((p) => {
        wallOf(p).type = true;
      }),
    ).toBe(false);
  });

  test("null type rejected", () => {
    expect(
      reject((p) => {
        wallOf(p).type = null;
      }),
    ).toBe(false);
  });

  test("array type rejected", () => {
    expect(
      reject((p) => {
        wallOf(p).type = ["wooden_wall"];
      }),
    ).toBe(false);
  });

  test("object type rejected", () => {
    expect(
      reject((p) => {
        wallOf(p).type = { name: "wooden_wall" };
      }),
    ).toBe(false);
  });

  test("unknown string type rejected", () => {
    expect(
      reject((p) => {
        wallOf(p).type = "castle";
      }),
    ).toBe(false);
  });

  test("standalone validator rejects the numeric-type dict too", () => {
    expect(
      isValidSavedBuildingDict({
        id: "wall_east_01",
        type: 123, // previously coerced to "wooden_wall" and accepted
        state: "COMPLETED",
        durability: 100,
        level: 1,
      }),
    ).toBe(false);
  });
});

describe("Phase 3.1 — building type: valid values and absence fallback", () => {
  beforeEach(() => {
    installStorage();
  });

  const wallOf = (p: Record<string, unknown>) =>
    (p.buildings as Array<Record<string, unknown>>).find(
      (b) => b.id === "wall_east_01",
    ) as Record<string, unknown>;

  test("valid wooden_wall accepted", () => {
    const payload = makeValidPayload();
    expect(validateSavePayload(payload)).toBe(true);
    expect(wallOf(payload).type).toBe("wooden_wall");
  });

  test("valid stone_wall (level 2) accepted on a wall plot", () => {
    const payload = makeValidPayload();
    const wall = wallOf(payload);
    wall.type = "stone_wall";
    wall.level = 2;
    wall.max_durability = 260;
    wall.durability = 260;
    expect(validateSavePayload(payload)).toBe(true);
  });

  test("valid watchtower and farm_plot types accepted on their plots", () => {
    const payload = makeValidPayload();
    const buildings = payload.buildings as Array<Record<string, unknown>>;
    expect(
      buildings.some((b) => b.id === "watchtower_east_01" && b.type === "watchtower"),
    ).toBe(true);
    expect(
      buildings.some((b) => b.id === "farm_west_01" && b.type === "farm_plot"),
    ).toBe(true);
    expect(validateSavePayload(payload)).toBe(true);
  });

  test("absent type on a wall plot accepted (wooden_wall fallback preserved)", () => {
    const payload = makeValidPayload();
    delete wallOf(payload).type;
    expect(validateSavePayload(payload)).toBe(true);
  });

  test("absent type on a farm plot still rejected by the per-plot whitelist", () => {
    // The fallback maps an absent type to "wooden_wall", which is not
    // allowed on farm plots — unchanged existing behavior.
    const payload = makeValidPayload();
    const farm = (payload.buildings as Array<Record<string, unknown>>).find(
      (b) => b.id === "farm_west_01",
    ) as Record<string, unknown>;
    delete farm.type;
    expect(validateSavePayload(payload)).toBe(false);
  });
});
