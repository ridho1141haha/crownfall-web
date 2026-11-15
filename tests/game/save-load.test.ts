// B2/B3/B5/B6 regressions: backup recovery matrix, backup self-healing,
// backup preservation during saving, Continue Reign gating, and the
// save/load round-trip. Mirrors Godot SaveManager.gd behavior.

import { describe, test, expect, beforeEach } from "bun:test";
import {
  installStorage,
  makeEngine,
  makeValidPayload,
  clone,
  seedMidGameState,
  writeSlot,
  SLOT_KEYS,
  type RecordedHooks,
} from "./helpers";
import { SAVE_BACKUP_KEY, SAVE_KEY } from "../../src/lib/game/data";
import { validateSavePayload } from "../../src/lib/game/save-validation";
import type { GameEngine } from "../../src/lib/game/engine";

/** Produce a valid primary + backup pair with distinct balances. */
function seedTwoValidSaves(engine: GameEngine) {
  // save #1 (will end up as backup): gold 5
  engine.newGame();
  engine.gold = 5;
  engine.playerX = -123.4;
  expect(engine.saveGame()).toBe(true);

  // save #2 (primary): gold 6
  engine.gold = 6;
  engine.playerX = 88.8;
  engine.day = 2;
  expect(engine.saveGame()).toBe(true);

  const primaryText = localStorage.getItem(SAVE_KEY) as string;
  const backupText = localStorage.getItem(SAVE_BACKUP_KEY) as string;
  expect(JSON.parse(primaryText).resources.gold).toBe(6);
  expect(JSON.parse(backupText).resources.gold).toBe(5);
  return { primaryText, backupText };
}

describe("B2/B6 — backup recovery matrix", () => {
  let engine: GameEngine;
  let hooks: RecordedHooks;

  beforeEach(() => {
    installStorage();
    const made = makeEngine();
    engine = made.engine;
    hooks = made.hooks;
    engine.newGame();
  });

  test("case 1: primary missing + valid backup → backup loaded, primary self-healed", () => {
    seedTwoValidSaves(engine);
    localStorage.removeItem(SAVE_KEY);

    // Distinct live state before load — must be fully replaced by backup.
    engine.gold = 111;

    expect(engine.loadGame()).toBe(true);
    expect(engine.gold).toBe(5);
    expect(engine.playerX).toBe(-123.4);
    expect(hooks.messages).toContain("Save file was corrupted — recovered from backup");
    // B6 self-heal: the primary now holds the verified backup payload.
    const healed = localStorage.getItem(SAVE_KEY);
    expect(healed).not.toBeNull();
    expect(JSON.parse(healed as string).resources.gold).toBe(5);
    expect(validateSavePayload(JSON.parse(healed as string))).toBe(true);
  });

  test("case 2: primary malformed JSON + valid backup → backup loaded, primary self-healed", () => {
    seedTwoValidSaves(engine);
    localStorage.setItem(SAVE_KEY, "{not json at all");

    expect(engine.loadGame()).toBe(true);
    expect(engine.gold).toBe(5);
    expect(JSON.parse(localStorage.getItem(SAVE_KEY) as string).resources.gold).toBe(5);
  });

  test("case 3 (B2): primary valid JSON but schema-invalid + valid backup → backup loaded", () => {
    seedTwoValidSaves(engine);
    const corrupt = JSON.parse(localStorage.getItem(SAVE_KEY) as string);
    corrupt.npcs = []; // parses fine, fails validation (empty npc array)
    localStorage.setItem(SAVE_KEY, JSON.stringify(corrupt));

    // Distinct live state must survive until a valid candidate is applied.
    engine.gold = 222;

    expect(engine.loadGame()).toBe(true);
    expect(engine.gold).toBe(5);
    expect(engine.playerX).toBe(-123.4);
    expect(hooks.messages).toContain("Save file was corrupted — recovered from backup");
    // Self-healed primary is now valid.
    const healed = JSON.parse(localStorage.getItem(SAVE_KEY) as string);
    expect(healed.resources.gold).toBe(5);
    expect(validateSavePayload(healed)).toBe(true);
  });

  test("case 4: primary parses+validates but restoration would fail → no partial state", () => {
    // The web restoration path has no failure return after validation (all
    // guarded coercions) — the equivalent guarantee is that a payload which
    // passes validation is fully applied, and any rejected payload leaves
    // the live game untouched. Covered here via a rejected-then-loaded pair.
    seedTwoValidSaves(engine);
    const bad = JSON.parse(localStorage.getItem(SAVE_KEY) as string);
    bad.buildings[0].state = "PLACEHOLDER";
    bad.buildings[0].durability = 100; // invalid: PLACEHOLDER must have 0
    localStorage.setItem(SAVE_KEY, JSON.stringify(bad));

    engine.gold = 333;
    expect(engine.loadGame()).toBe(true); // falls back to backup
    expect(engine.gold).toBe(5);
  });

  test("case 5: both saves invalid → load fails, live state untouched", () => {
    seedTwoValidSaves(engine);
    localStorage.setItem(SAVE_KEY, "GARBAGE");
    localStorage.setItem(SAVE_BACKUP_KEY, '{"day_count": 1e999}'); // Infinity

    engine.gold = 44;
    engine.day = 7;

    expect(engine.loadGame()).toBe(false);
    expect(engine.gold).toBe(44);
    expect(engine.day).toBe(7);
    expect(engine.started).toBe(true); // still in the live session
    expect(hooks.messages).not.toContain("Save file was corrupted — recovered from backup");
  });

  test("case 6: both saves valid → primary wins, backup untouched", () => {
    seedTwoValidSaves(engine);
    engine.gold = 555;

    expect(engine.loadGame()).toBe(true);
    expect(engine.gold).toBe(6);
    expect(engine.day).toBe(2);
    expect(engine.playerX).toBe(88.8);
    expect(hooks.messages).not.toContain("Save file was corrupted — recovered from backup");
  });

  test("load with no saves at all fails without mutation", () => {
    engine.newGame();
    engine.gold = 9;
    expect(engine.loadGame()).toBe(false);
    expect(engine.gold).toBe(9);
    expect(engine.started).toBe(true);
  });
});

describe("B5 — backup protection during saving", () => {
  let engine: GameEngine;
  let hooks: RecordedHooks;

  beforeEach(() => {
    installStorage();
    const made = makeEngine();
    engine = made.engine;
    hooks = made.hooks;
    engine.newGame();
  });

  test("corrupt primary is never staged into the backup slot", () => {
    seedTwoValidSaves(engine);
    const goodBackupText = localStorage.getItem(SAVE_BACKUP_KEY) as string;
    // After two saves the backup holds the previous (gold-5) primary.
    expect(JSON.parse(goodBackupText).resources.gold).toBe(5);
    localStorage.setItem(SAVE_KEY, "SEMI-CORRUPT");

    engine.gold = 10;
    expect(engine.saveGame()).toBe(true);

    // The backup was NOT replaced with the corrupt primary text, and the
    // new primary was written.
    expect(localStorage.getItem(SAVE_BACKUP_KEY)).toBe(goodBackupText);
    expect(JSON.parse(localStorage.getItem(SAVE_KEY) as string).resources.gold).toBe(10);
  });

  test("new payload that fails validation is not written at all", () => {
    seedTwoValidSaves(engine);
    // Force an invalid payload through a state that cannot occur in normal
    // play: balances above the resource cap.
    engine.gold = 9999999;
    const primaryBefore = localStorage.getItem(SAVE_KEY);

    expect(engine.saveGame()).toBe(false);
    expect(localStorage.getItem(SAVE_KEY)).toBe(primaryBefore);
  });

  test("valid backup survives a failed primary write (storage failure)", () => {
    seedTwoValidSaves(engine);
    const primaryBefore = localStorage.getItem(SAVE_KEY) as string;
    expect(JSON.parse(primaryBefore).resources.gold).toBe(6);

    // Simulate a quota/write failure on the primary slot. The staged backup
    // write succeeds first (copying the still-valid primary), then the
    // primary write throws — the known-good payload must survive in storage.
    const originalSetItem = localStorage.setItem.bind(localStorage);
    (localStorage as { setItem: (k: string, v: string) => void }).setItem = (
      key: string,
      value: string,
    ) => {
      if (key === SAVE_KEY) {
        throw new Error("simulated quota exceeded");
      }
      originalSetItem(key, value);
    };

    engine.gold = 77;
    expect(engine.saveGame()).toBe(false);

    (localStorage as { setItem: (k: string, v: string) => void }).setItem =
      originalSetItem;

    // Primary untouched by the failed write.
    expect(localStorage.getItem(SAVE_KEY)).toBe(primaryBefore);
    // Whatever sits in the backup slot now is a VALID save — the failure
    // did not destroy the only known-good copy.
    const backup = JSON.parse(localStorage.getItem(SAVE_BACKUP_KEY) as string);
    expect(validateSavePayload(backup)).toBe(true);
    expect(backup.resources.gold).toBe(6);
  });
});

describe("B3 — Continue Reign validation", () => {
  let engine: GameEngine;
  let hooks: RecordedHooks;

  beforeEach(() => {
    installStorage();
    const made = makeEngine();
    engine = made.engine;
    hooks = made.hooks;
    engine.newGame();
  });

  test("hasSave is false when both saves exist but are invalid", () => {
    localStorage.setItem(SAVE_KEY, "GARBAGE");
    localStorage.setItem(SAVE_BACKUP_KEY, "ALSO GARBAGE");
    engine.refreshHasSave();
    expect(engine.hasSave).toBe(false);
  });

  test("hasSave is false when nothing is stored", () => {
    engine.refreshHasSave();
    expect(engine.hasSave).toBe(false);
  });

  test("hasSave is true with a valid primary, even alongside an invalid backup", () => {
    seedMidGameState(engine);
    expect(engine.saveGame()).toBe(true);
    localStorage.setItem(SAVE_BACKUP_KEY, "GARBAGE");
    engine.refreshHasSave();
    expect(engine.hasSave).toBe(true);
  });

  test("hasSave is true with an invalid primary but a valid backup", () => {
    // Two saves so the backup slot holds a valid payload.
    seedMidGameState(engine);
    expect(engine.saveGame()).toBe(true);
    engine.gold = 13;
    expect(engine.saveGame()).toBe(true);
    localStorage.setItem(SAVE_KEY, "GARBAGE");
    engine.refreshHasSave();
    expect(engine.hasSave).toBe(true); // valid backup still counts
  });

  test("validation is pure: refreshHasSave does not mutate the live game or storage", () => {
    seedMidGameState(engine);
    engine.saveGame();
    engine.gold = 21;
    engine.saveGame(); // backup now holds the first valid save
    localStorage.setItem(SAVE_KEY, "GARBAGE");
    const before = localStorage.getItem(SAVE_BACKUP_KEY);
    const goldBefore = engine.gold;
    const dayBefore = engine.day;

    engine.refreshHasSave();

    expect(engine.hasSave).toBe(true);
    expect(localStorage.getItem(SAVE_BACKUP_KEY)).toBe(before);
    expect(localStorage.getItem(SAVE_KEY)).toBe("GARBAGE"); // not repaired by the check
    expect(engine.gold).toBe(goldBefore);
    expect(engine.day).toBe(dayBefore);
    expect(engine.phase).toBe("sunset"); // unchanged by validation (seeded phase)
  });
});

describe("save/load round-trip", () => {
  let engine: GameEngine;
  let hooks: RecordedHooks;

  beforeEach(() => {
    installStorage();
    const made = makeEngine();
    engine = made.engine;
    hooks = made.hooks;
  });

  test("full state survives save → mutate → load", () => {
    engine.newGame();
    seedMidGameState(engine);
    expect(engine.saveGame()).toBe(true);

    // Diverge the live state completely.
    engine.gold = 1;
    engine.wood = 1;
    engine.stone = 1;
    engine.day = 9;
    engine.phase = "daylight";
    engine.playerX = 0;
    engine.hearthLevel = 1;
    engine.agents[0].recruited = false;
    engine.nodeStates.set("timber_pile_west", false);
    engine.treeHp.set("tree_west_01", 3);

    expect(engine.loadGame()).toBe(true);
    expect(engine.gold).toBe(7);
    expect(engine.wood).toBe(9);
    expect(engine.stone).toBe(4);
    expect(engine.day).toBe(3);
    expect(engine.phase).toBe("sunset");
    expect(engine.phaseElapsed).toBeCloseTo(12.5, 5);
    expect(engine.playerX).toBeCloseTo(123.4, 5);
    expect(engine.facing).toBe(-1);
    expect(engine.hearthLevel).toBe(2);
    expect(engine.shipwreckStage).toBe(1);
    expect(engine.portalLooted).toBe(true);
    expect(engine.eraId()).toBe("stone_age");
    expect(engine.campVagrants).toBe(1);
    expect(engine.agents[0].recruited).toBe(true);
    expect(engine.agents[0].role).toBe("builder");
    expect(engine.nodeStates.get("timber_pile_west")).toBe(true);
    expect(engine.treeHp.get("tree_west_01")).toBe(1);
    const farm = engine.plots.get("farm_west_01");
    expect(farm?.state).toBe("COMPLETED");
    expect(farm?.durability).toBe(64);
    const wall = engine.plots.get("wall_east_01");
    expect(wall?.state).toBe("DAMAGED");
    expect(wall?.durability).toBe(90);
  });

  test("hand-crafted invalid payloads never touch the live state", () => {
    engine.newGame();
    seedMidGameState(engine);
    engine.saveGame();
    const liveGold = engine.gold;

    const payload = makeValidPayload();
    // Infinity via raw JSON text (JSON.stringify cannot produce it).
    const raw = JSON.stringify(payload).replace(
      '"day_count":3',
      '"day_count":1e999',
    );
    localStorage.setItem(SAVE_KEY, raw);
    localStorage.removeItem(SAVE_BACKUP_KEY);

    engine.gold = 100; // diverge live state again
    expect(engine.loadGame()).toBe(false);
    expect(engine.gold).toBe(100);
    expect(engine.day).toBe(3); // unchanged
    expect(liveGold).toBe(7);
  });

  test("rejected load leaves every mutable gameplay field untouched", () => {
    engine.newGame();
    seedMidGameState(engine);
    engine.saveGame();
    const snapshot = {
      gold: engine.gold,
      wood: engine.wood,
      stone: engine.stone,
      day: engine.day,
      phase: engine.phase,
      phaseElapsed: engine.phaseElapsed,
      playerX: engine.playerX,
      hearthLevel: engine.hearthLevel,
      shipwreckStage: engine.shipwreckStage,
      reign: engine.reign,
      campVagrants: engine.campVagrants,
      agentX: engine.agents[0].x,
      agentRole: engine.agents[0].role,
    };

    localStorage.removeItem(SAVE_BACKUP_KEY);
    localStorage.setItem(SAVE_KEY, "TOTAL GARBAGE");
    expect(engine.loadGame()).toBe(false);

    expect(engine.gold).toBe(snapshot.gold);
    expect(engine.wood).toBe(snapshot.wood);
    expect(engine.stone).toBe(snapshot.stone);
    expect(engine.day).toBe(snapshot.day);
    expect(engine.phase).toBe(snapshot.phase);
    expect(engine.phaseElapsed).toBe(snapshot.phaseElapsed);
    expect(engine.playerX).toBe(snapshot.playerX);
    expect(engine.hearthLevel).toBe(snapshot.hearthLevel);
    expect(engine.shipwreckStage).toBe(snapshot.shipwreckStage);
    expect(engine.reign).toBe(snapshot.reign);
    expect(engine.campVagrants).toBe(snapshot.campVagrants);
    expect(engine.agents[0].x).toBe(snapshot.agentX);
    expect(engine.agents[0].role).toBe(snapshot.agentRole);
  });

  test("web payload schema version stays at 3 (intentional platform difference)", () => {
    engine.newGame();
    seedMidGameState(engine);
    engine.saveGame();
    const payload = JSON.parse(localStorage.getItem(SAVE_KEY) as string);
    expect(payload.schema_version).toBe(3);
    expect(validateSavePayload(payload)).toBe(true);
  });

  test("payload structure is preserved exactly through a round-trip", () => {
    engine.newGame();
    seedMidGameState(engine);
    engine.saveGame();
    const written = JSON.parse(localStorage.getItem(SAVE_KEY) as string);

    engine.gold = 1;
    expect(engine.loadGame()).toBe(true);

    // Primary was valid, so the load did not rewrite it — the storage
    // payload must equal exactly what was written.
    const reloaded = JSON.parse(localStorage.getItem(SAVE_KEY) as string);
    expect(reloaded).toEqual(written);
  });
});

// ---------------------------------------------------------------------------
// Phase 3.1 — restore hardening (hearth_level + building type)
// ---------------------------------------------------------------------------

describe("Phase 3.1 — hearth_level restore (Godot flags.get default parity)", () => {
  beforeEach(() => {
    installStorage();
  });

  test("missing hearth_level restores as level 1, never NaN", () => {
    const payload = makeValidPayload(); // seeded engine wrote hearth_level: 2
    delete (payload.progression_flags as Record<string, unknown>).hearth_level;
    writeSlot(SLOT_KEYS.primary, JSON.stringify(payload));

    const { engine } = makeEngine();
    engine.newGame();
    engine.hearthLevel = 3; // distinct live state — must be replaced
    expect(engine.loadGame()).toBe(true);
    expect(engine.hearthLevel).toBe(1); // Godot: flags.get("hearth_level", 1)
    expect(Number.isNaN(engine.hearthLevel)).toBe(false);
  });

  test("valid hearth_level values 1, 2 and 3 restore exactly", () => {
    for (const level of [1, 2, 3]) {
      const payload = makeValidPayload();
      (payload.progression_flags as Record<string, unknown>).hearth_level =
        level;
      writeSlot(SLOT_KEYS.primary, JSON.stringify(payload));

      const { engine } = makeEngine();
      engine.newGame();
      expect(engine.loadGame()).toBe(true);
      expect(engine.hearthLevel).toBe(level);
    }
  });

  test("invalid hearth_level values reject the load and leave live state untouched", () => {
    const invalidValues: Array<Record<string, unknown>> = [];
    // In-memory payloads can carry true NaN; JSON-route payloads carry the
    // 0 / 4 / fractional / Infinity shapes a corrupted file actually has.
    for (const v of [0, 4, 2.5]) {
      invalidValues.push({ hearth_level: v });
    }
    invalidValues.push({ hearth_level: Number.NaN });

    for (const flagPatch of invalidValues) {
      const payload = makeValidPayload();
      Object.assign(
        payload.progression_flags as Record<string, unknown>,
        flagPatch,
      );
      writeSlot(SLOT_KEYS.primary, JSON.stringify(payload));

      const { engine } = makeEngine();
      engine.newGame();
      engine.gold = 77; // live divergence — must survive the rejected load
      engine.hearthLevel = 2;
      expect(engine.loadGame()).toBe(false);
      expect(engine.gold).toBe(77);
      expect(engine.hearthLevel).toBe(2);
      expect(Number.isNaN(engine.hearthLevel)).toBe(false);
    }

    // Infinity via the raw JSON text route (1e999 parses to Infinity).
    const payload = makeValidPayload();
    const raw = JSON.stringify(payload).replace(
      '"hearth_level":2',
      '"hearth_level":1e999',
    );
    expect(raw).toContain("1e999");
    writeSlot(SLOT_KEYS.primary, raw);
    const { engine } = makeEngine();
    engine.newGame();
    engine.gold = 77;
    expect(engine.loadGame()).toBe(false);
    expect(engine.gold).toBe(77);
  });
});

describe("Phase 3.1 — building type restore (no blind String() coercion)", () => {
  beforeEach(() => {
    installStorage();
  });

  test("numeric building type is rejected at load; live state and plot types unchanged", () => {
    // The pre-fix exploit: validation coerced 123 into "wooden_wall" and
    // passed the wall-plot whitelist, while the restore path then stored
    // String(123) === "123" as the plot type.
    const payload = makeValidPayload();
    const wall = (payload.buildings as Array<Record<string, unknown>>).find(
      (b) => b.id === "wall_east_01",
    ) as Record<string, unknown>;
    wall.type = 123;
    writeSlot(SLOT_KEYS.primary, JSON.stringify(payload));

    const { engine } = makeEngine();
    engine.newGame();
    engine.gold = 77;
    const typeBefore = engine.plots.get("wall_east_01")?.type;
    expect(engine.loadGame()).toBe(false);
    expect(engine.gold).toBe(77);
    expect(engine.plots.get("wall_east_01")?.type).toBe(typeBefore);
    expect(engine.plots.get("wall_east_01")?.type).toBe("wooden_wall");
  });

  test("a valid string-typed save still restores plot types exactly", () => {
    const payload = makeValidPayload();
    const wall = (payload.buildings as Array<Record<string, unknown>>).find(
      (b) => b.id === "wall_east_01",
    ) as Record<string, unknown>;
    wall.type = "stone_wall";
    wall.level = 2;
    wall.max_durability = 260;
    wall.durability = 260;
    writeSlot(SLOT_KEYS.primary, JSON.stringify(payload));

    const { engine } = makeEngine();
    engine.newGame();
    expect(engine.loadGame()).toBe(true);
    expect(engine.plots.get("wall_east_01")?.type).toBe("stone_wall");
  });
});
