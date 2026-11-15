// B8 regression: EconomyLedger parity — 999,999 resource cap on every add,
// exact-integer amounts only, and atomic (all-or-nothing) bundle commits.

import { describe, test, expect, beforeEach } from "bun:test";
import { installStorage, makeEngine } from "./helpers";
import { MAX_RESOURCE_CAP } from "../../src/lib/game/save-validation";
import type { GameEngine } from "../../src/lib/game/engine";

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
