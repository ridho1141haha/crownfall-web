// B8 regression: EconomyLedger parity — 999,999 resource cap on every add,
// exact-integer amounts only, and atomic (all-or-nothing) bundle commits.

import { describe, test, expect, beforeEach } from "bun:test";
import { installStorage, makeEngine } from "./helpers";
import { MAX_RESOURCE_CAP } from "../../src/lib/game/save-validation";
import type { GameEngine } from "../../src/lib/game/engine";
import type { ResourceId } from "../../src/lib/game/types";

describe("B8 — tryAdd cap parity", () => {
  let engine: GameEngine;

  beforeEach(() => {
    installStorage();
    engine = makeEngine().engine;
    engine.newGame();
  });

  test("add below the cap commits", () => {
    expect(engine.tryAdd("gold", 4)).toBe(true);
    expect(engine.gold).toBe(6); // 2 start + 4
  });

  test("add that would exceed the 999,999 cap is rejected without partial commit", () => {
    engine.gold = MAX_RESOURCE_CAP - 1;
    expect(engine.tryAdd("gold", 2)).toBe(false);
    expect(engine.gold).toBe(MAX_RESOURCE_CAP - 1);

    engine.gold = MAX_RESOURCE_CAP;
    expect(engine.tryAdd("gold", 1)).toBe(false);
    expect(engine.gold).toBe(MAX_RESOURCE_CAP);
  });

  test("cap boundary: exactly reaching the cap commits", () => {
    engine.gold = MAX_RESOURCE_CAP - 1;
    expect(engine.tryAdd("gold", 1)).toBe(true);
    expect(engine.gold).toBe(MAX_RESOURCE_CAP);
  });

  test("non-finite amounts rejected", () => {
    engine.wood = 5;
    expect(engine.tryAdd("wood", Number.NaN)).toBe(false);
    expect(engine.tryAdd("wood", Number.POSITIVE_INFINITY)).toBe(false);
    expect(engine.tryAdd("wood", Number.NEGATIVE_INFINITY)).toBe(false);
    expect(engine.wood).toBe(5);
  });

  test("fractional amounts rejected", () => {
    engine.wood = 5;
    expect(engine.tryAdd("wood", 2.5)).toBe(false);
    expect(engine.wood).toBe(5);
  });

  test("zero and negative amounts rejected", () => {
    engine.stone = 3;
    expect(engine.tryAdd("stone", 0)).toBe(false);
    expect(engine.tryAdd("stone", -2)).toBe(false);
    expect(engine.stone).toBe(3);
  });

  test("cap is enforced per resource, not globally", () => {
    engine.gold = MAX_RESOURCE_CAP;
    expect(engine.tryAdd("wood", 1)).toBe(true);
    expect(engine.gold).toBe(MAX_RESOURCE_CAP);
    expect(engine.wood).toBe(3);
  });
});

describe("B8 — tryAddBundle atomicity", () => {
  let engine: GameEngine;

  beforeEach(() => {
    installStorage();
    engine = makeEngine().engine;
    engine.newGame();
  });

  test("valid bundle commits every resource", () => {
    expect(engine.tryAddBundle({ gold: 3, stone: 2 })).toBe(true);
    expect(engine.gold).toBe(5);
    expect(engine.stone).toBe(3);
    expect(engine.wood).toBe(2);
  });

  test("bundle exceeding the cap on one resource commits NOTHING", () => {
    engine.stone = MAX_RESOURCE_CAP; // cap only on stone
    expect(engine.tryAddBundle({ gold: 3, stone: 2 })).toBe(false);
    expect(engine.gold).toBe(2); // unchanged
    expect(engine.stone).toBe(MAX_RESOURCE_CAP); // unchanged
    expect(engine.wood).toBe(2); // unchanged
  });

  test("aggregate cap counts repeated adds of the same resource", () => {
    engine.gold = MAX_RESOURCE_CAP - 2;
    expect(engine.tryAddBundle({ gold: 2, wood: 1 })).toBe(true);
    expect(engine.gold).toBe(MAX_RESOURCE_CAP);
    expect(engine.wood).toBe(3);
    // One more gold would exceed the cap now.
    expect(engine.tryAddBundle({ gold: 1 })).toBe(false);
    expect(engine.gold).toBe(MAX_RESOURCE_CAP);
  });

  test("invalid entries reject the whole bundle", () => {
    engine.gold = 10;
    engine.wood = 10;
    expect(engine.tryAddBundle({ gold: Number.NaN, wood: 1 })).toBe(false);
    expect(engine.tryAddBundle({ gold: Number.POSITIVE_INFINITY, wood: 1 })).toBe(false);
    expect(engine.tryAddBundle({ gold: 1.5, wood: 1 })).toBe(false);
    expect(engine.tryAddBundle({ gold: -1, wood: 1 })).toBe(false);
    expect(engine.tryAddBundle({ gold: 0, wood: 1 })).toBe(false);
    expect(engine.gold).toBe(10);
    expect(engine.wood).toBe(10);
  });

  test("empty bundle rejected", () => {
    expect(engine.tryAddBundle({})).toBe(false);
  });

  test("bundle exactly reaching the cap commits", () => {
    engine.stone = MAX_RESOURCE_CAP - 2;
    expect(engine.tryAddBundle({ stone: 2 })).toBe(true);
    expect(engine.stone).toBe(MAX_RESOURCE_CAP);
  });
});

describe("B8 — economy flows that consume the ledger stay functional", () => {
  let engine: GameEngine;

  beforeEach(() => {
    installStorage();
    engine = makeEngine().engine;
    engine.newGame();
  });

  test("normal gameplay adds still work after the cap change", () => {
    // Player collects the +4 gold chest.
    engine.playerX = -480;
    engine.interact();
    expect(engine.gold).toBe(6);
    // Builder chops the timber pile.
    engine.playerX = -110;
    engine.interact();
    expect(engine.wood).toBe(7);
  });

  test("spending still validates against the balance", () => {
    expect(engine.trySpend({ gold: 3 })).toBe(false);
    expect(engine.trySpend({ gold: 2 })).toBe(true);
    expect(engine.gold).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Phase 3.1 — trySpend/canSpend hardening (EconomyLedger.try_spend parity)
// ---------------------------------------------------------------------------

describe("Phase 3.1 — trySpend cost validation", () => {
  let engine: GameEngine;

  beforeEach(() => {
    installStorage();
    engine = makeEngine().engine;
    engine.newGame();
    engine.gold = 10;
    engine.wood = 10;
    engine.stone = 10;
  });

  test("empty cost object rejected", () => {
    expect(engine.trySpend({})).toBe(false);
    expect(engine.gold).toBe(10);
    expect(engine.wood).toBe(10);
    expect(engine.stone).toBe(10);
  });

  test("unknown resource id rejected and leaves balances unchanged", () => {
    const bad = { food: 5 } as unknown as Partial<Record<ResourceId, number>>;
    expect(engine.trySpend(bad)).toBe(false);
    // Prototype-chain keys must not pass as resource ids either.
    const proto = {
      toString: 5,
    } as unknown as Partial<Record<ResourceId, number>>;
    expect(engine.trySpend(proto)).toBe(false);
    expect(engine.gold).toBe(10);
    expect(engine.wood).toBe(10);
    expect(engine.stone).toBe(10);
  });

  test("zero amounts rejected", () => {
    expect(engine.trySpend({ gold: 0 })).toBe(false);
    expect(engine.trySpend({ gold: 5, wood: 0 })).toBe(false); // one bad entry poisons the bundle
    expect(engine.gold).toBe(10);
    expect(engine.wood).toBe(10);
  });

  test("negative amounts rejected and can never increase a balance", () => {
    expect(engine.trySpend({ gold: -5 })).toBe(false);
    expect(engine.gold).toBe(10); // NOT 15
    expect(engine.trySpend({ gold: 1, wood: -2 })).toBe(false);
    expect(engine.gold).toBe(10); // valid entry must not commit either (atomic)
    expect(engine.wood).toBe(10);
  });

  test("fractional amounts rejected and can never create fractional balances", () => {
    expect(engine.trySpend({ stone: 2.5 })).toBe(false);
    expect(engine.stone).toBe(10); // NOT 7.5
    expect(engine.trySpend({ gold: 1, wood: 1.5 })).toBe(false);
    expect(engine.gold).toBe(10);
    expect(engine.wood).toBe(10);
    expect(Number.isInteger(engine.gold)).toBe(true);
    expect(Number.isInteger(engine.wood)).toBe(true);
    expect(Number.isInteger(engine.stone)).toBe(true);
  });

  test("non-finite amounts rejected", () => {
    expect(engine.trySpend({ gold: Number.NaN })).toBe(false);
    expect(engine.trySpend({ gold: Number.POSITIVE_INFINITY })).toBe(false);
    expect(engine.trySpend({ gold: Number.NEGATIVE_INFINITY })).toBe(false);
    expect(engine.gold).toBe(10);
  });

  test("valid multi-resource spend commits every deduction atomically", () => {
    expect(engine.trySpend({ gold: 3, wood: 4, stone: 2 })).toBe(true);
    expect(engine.gold).toBe(7);
    expect(engine.wood).toBe(6);
    expect(engine.stone).toBe(8);
  });

  test("spend beyond the balance is rejected with balances unchanged", () => {
    expect(engine.trySpend({ gold: 11 })).toBe(false);
    expect(engine.trySpend({ gold: 5, wood: 11 })).toBe(false);
    expect(engine.gold).toBe(10);
    expect(engine.wood).toBe(10);
  });

  test("normal gameplay costs still spend correctly", () => {
    // Wall plot build cost (2G 4W 2S) and shipwreck stage 1 (2G 3W 1S).
    expect(engine.trySpend({ gold: 2, wood: 4, stone: 2 })).toBe(true);
    expect(engine.gold).toBe(8);
    expect(engine.wood).toBe(6);
    expect(engine.stone).toBe(8);
    expect(engine.trySpend({ gold: 2, wood: 3, stone: 1 })).toBe(true);
    expect(engine.gold).toBe(6);
    expect(engine.wood).toBe(3);
    expect(engine.stone).toBe(7);
  });

  test("hearth upgrade spend path still works (non-empty tier costs)", () => {
    engine.gold = 4;
    engine.wood = 4;
    engine.stone = 2;
    const res = engine.tryUpgradeHearth(0); // HEARTH.X = 0
    expect(res.ok).toBe(true);
    expect(engine.hearthLevel).toBe(2);
    expect(engine.gold).toBe(0);
    expect(engine.wood).toBe(0);
    expect(engine.stone).toBe(0);
  });
});

describe("Phase 3.1 — canSpend agrees with the transaction rules", () => {
  let engine: GameEngine;
  let canSpend: (cost: Partial<Record<ResourceId, number>>) => boolean;

  beforeEach(() => {
    installStorage();
    engine = makeEngine().engine;
    engine.newGame();
    engine.gold = 10;
    engine.wood = 10;
    engine.stone = 10;
    // canSpend is the private affordability gate — exercise it directly so
    // UI affordability can never drift from the transaction rules.
    canSpend = (cost) =>
      (
        engine as unknown as {
          canSpend: (c: Partial<Record<ResourceId, number>>) => boolean;
        }
      ).canSpend(cost);
  });

  test("affordable valid cost → true; trySpend then succeeds", () => {
    expect(canSpend({ gold: 3, wood: 4, stone: 2 })).toBe(true);
    expect(engine.trySpend({ gold: 3, wood: 4, stone: 2 })).toBe(true);
  });

  test("unaffordable valid cost → false; trySpend also fails", () => {
    expect(canSpend({ gold: 11 })).toBe(false);
    expect(engine.trySpend({ gold: 11 })).toBe(false);
  });

  test("invalid costs are false regardless of balance", () => {
    expect(canSpend({})).toBe(false);
    expect(canSpend({ gold: 0 })).toBe(false);
    expect(canSpend({ gold: -1 })).toBe(false);
    expect(canSpend({ gold: 1.5 })).toBe(false);
    expect(canSpend({ gold: Number.NaN })).toBe(false);
    expect(
      canSpend({ food: 1 } as unknown as Partial<Record<ResourceId, number>>),
    ).toBe(false);
    // ...and trySpend mirrors every one of them.
    expect(engine.trySpend({})).toBe(false);
    expect(engine.trySpend({ gold: 0 })).toBe(false);
    expect(engine.trySpend({ gold: -1 })).toBe(false);
    expect(engine.trySpend({ gold: 1.5 })).toBe(false);
    expect(engine.trySpend({ gold: Number.NaN })).toBe(false);
    expect(
      engine.trySpend({
        food: 1,
      } as unknown as Partial<Record<ResourceId, number>>),
    ).toBe(false);
    expect(engine.gold).toBe(10);
    expect(engine.wood).toBe(10);
    expect(engine.stone).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// Phase 4 P2-C — resource additions reject unknown resource IDs
// (EconomyLedger.try_add / try_add_bundle Phase 1 parity: the whitelist gate
// runs BEFORE any balance math; a rejected transaction changes nothing.)
// ---------------------------------------------------------------------------

describe("Phase 4 P2-C — tryAdd rejects unknown resource IDs", () => {
  let engine: GameEngine;

  beforeEach(() => {
    installStorage();
    engine = makeEngine().engine;
    engine.newGame();
  });

  test("every valid resource ID is still accepted", () => {
    for (const id of ["gold", "wood", "stone"] as ResourceId[]) {
      expect(engine.tryAdd(id, 1)).toBe(true);
    }
    expect(engine.gold).toBe(3);
    expect(engine.wood).toBe(3);
    expect(engine.stone).toBe(2); // 1 start + 1
  });

  test("unknown resource ID is rejected and no property is minted", () => {
    const before = { gold: engine.gold, wood: engine.wood, stone: engine.stone };
    expect(
      engine.tryAdd("mana" as unknown as ResourceId, 5),
    ).toBe(false);
    expect(
      engine.tryAdd("gems" as unknown as ResourceId, 5),
    ).toBe(false);
    expect(engine.gold).toBe(before.gold);
    expect(engine.wood).toBe(before.wood);
    expect(engine.stone).toBe(before.stone);
    expect((engine as unknown as Record<string, unknown>).mana).toBeUndefined();
    expect((engine as unknown as Record<string, unknown>).gems).toBeUndefined();
  });

  test("unknown ID cannot dodge the cap via NaN arithmetic", () => {
    engine.gold = MAX_RESOURCE_CAP;
    // Pre-fix, an unknown id hit `this[k] + amount > CAP` with undefined →
    // NaN → false → "passed" and wrote NaN into the engine.
    expect(
      engine.tryAdd("elixir" as unknown as ResourceId, MAX_RESOURCE_CAP),
    ).toBe(false);
    expect(engine.gold).toBe(MAX_RESOURCE_CAP);
    expect(
      (engine as unknown as Record<string, unknown>).elixir,
    ).toBeUndefined();
  });
});

describe("Phase 4 P2-C — tryAddBundle rejects unknown resource IDs", () => {
  let engine: GameEngine;

  beforeEach(() => {
    installStorage();
    engine = makeEngine().engine;
    engine.newGame();
  });

  test("bundle containing an unknown ID is rejected atomically", () => {
    const before = { gold: engine.gold, wood: engine.wood, stone: engine.stone };
    expect(
      engine.tryAddBundle({
        gold: 5,
        mana: 3,
      } as unknown as Partial<Record<ResourceId, number>>),
    ).toBe(false);
    // the VALID entry (gold +5) must NOT commit when a sibling entry is unknown
    expect(engine.gold).toBe(before.gold);
    expect(engine.wood).toBe(before.wood);
    expect(engine.stone).toBe(before.stone);
    expect((engine as unknown as Record<string, unknown>).mana).toBeUndefined();
  });

  test("all-unknown bundle rejected without side effects", () => {
    expect(
      engine.tryAddBundle({
        mana: 1,
        gems: 2,
      } as unknown as Partial<Record<ResourceId, number>>),
    ).toBe(false);
    expect(engine.gold).toBe(2);
    expect(engine.wood).toBe(2);
    expect(engine.stone).toBe(1);
  });

  test("valid multi-resource bundle still commits", () => {
    expect(
      engine.tryAddBundle({ gold: 2, wood: 3, stone: 1 }),
    ).toBe(true);
    expect(engine.gold).toBe(4);
    expect(engine.wood).toBe(5);
    expect(engine.stone).toBe(2);
  });

  test("empty bundle still rejected (Phase 3 behavior preserved)", () => {
    expect(engine.tryAddBundle({})).toBe(false);
    expect(engine.tryAddBundle(null as unknown as Partial<Record<ResourceId, number>>)).toBe(false);
  });

  test("negative / fractional / non-finite amounts still rejected after unknown-ID fix", () => {
    const before = { gold: engine.gold, wood: engine.wood, stone: engine.stone };
    expect(engine.tryAdd("gold", -3)).toBe(false);
    expect(engine.tryAdd("gold", 1.5)).toBe(false);
    expect(engine.tryAdd("gold", Number.NaN)).toBe(false);
    expect(engine.tryAdd("gold", Number.POSITIVE_INFINITY)).toBe(false);
    expect(
      engine.tryAddBundle({ gold: -1, wood: 2 } as Partial<Record<ResourceId, number>>),
    ).toBe(false);
    expect(
      engine.tryAddBundle({ wood: 0.5 } as Partial<Record<ResourceId, number>>),
    ).toBe(false);
    expect(engine.gold).toBe(before.gold);
    expect(engine.wood).toBe(before.wood);
    expect(engine.stone).toBe(before.stone);
  });

  test("bundle exceeding the cap is rejected atomically (state unchanged)", () => {
    engine.stone = MAX_RESOURCE_CAP;
    const before = { gold: engine.gold, wood: engine.wood, stone: engine.stone };
    expect(
      engine.tryAddBundle({ gold: 5, stone: 2 }),
    ).toBe(false);
    expect(engine.gold).toBe(before.gold);
    expect(engine.stone).toBe(before.stone);
  });
});
