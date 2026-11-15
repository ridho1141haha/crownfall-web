// B1 regression: builder auto-chop must reach the distant renewable wood
// node, collect it across multiple update ticks, return to safe idle when no
// node is available, and hold night safety (Godot NPCBuilderAgent
// _tick_idle_builder parity). Deterministic: fixed time steps, no randomness.

import { describe, test, expect, beforeEach } from "bun:test";
import {
  installStorage,
  makeEngine,
  step,
  type RecordedHooks,
} from "./helpers";
import { NPC } from "../../src/lib/game/data";
import type { GameEngine } from "../../src/lib/game/engine";

describe("B1 — builder auto-chop progression", () => {
  let engine: GameEngine;
  let hooks: RecordedHooks;

  beforeEach(() => {
    installStorage();
    const made = makeEngine();
    engine = made.engine;
    hooks = made.hooks;
    engine.newGame();
    // recruit the builder: player must stand at the Vagrant Camp
    engine.playerX = NPC.CAMP_X;
    engine.recruitAction();
    expect(engine.agents[0].recruited).toBe(true);
  });

  test("idle recruited builder walks to the distant renewable wood node and collects it", () => {
    // Builder spawns at the camp (x=-220); the only renewable wood node
    // (timber_pile_west) sits at x=-110 — far outside the old safe-zone gate.
    const builder = engine.agents[0];
    const startWood = engine.wood; // 2

    // One tick alone must NOT collect (distance 110 px > WORK_RANGE).
    step(engine, 0.1, 1);
    expect(engine.wood).toBe(startWood);

    // Fixed-timestep progression: the builder crosses the map in ~1 s of
    // simulated time (MOVE_SPEED 130 px/s), collects, then walks home.
    step(engine, 0.1, 60);

    expect(engine.wood).toBe(startWood + 5); // timber_pile_west amount
    expect(engine.nodeStates.get("timber_pile_west")).toBe(true);
    expect(hooks.messages.some((m) => m.includes("chopped +5 Wood"))).toBe(true);
    expect(Math.abs(builder.x - NPC.SAFE_ZONE_X)).toBeLessThanOrEqual(
      NPC.WORK_RANGE,
    );
    expect(builder.state).toBe("IDLE");
  });

  test("movement spans multiple update ticks with targetX tracking the node", () => {
    const builder = engine.agents[0];
    step(engine, 0.05, 3); // 0.15 s — well short of the 110 px journey
    expect(builder.state).toBe("MOVING_TO_TASK");
    expect(builder.targetX).toBe(-110); // the wood node position
    expect(builder.x).toBeGreaterThan(-220); // progressed from camp
    expect(builder.x).toBeLessThan(-110); // not there yet
    expect(engine.wood).toBe(2); // nothing collected yet
  });

  test("after collection the builder returns to safe idle (node exhausted for today)", () => {
    step(engine, 0.1, 60); // reach + collect
    expect(engine.wood).toBe(7);
    // No other renewable wood node exists — the builder must walk home.
    step(engine, 0.1, 200);
    const builder = engine.agents[0];
    expect(Math.abs(builder.x - NPC.SAFE_ZONE_X)).toBeLessThanOrEqual(NPC.WORK_RANGE);
    expect(builder.state).toBe("IDLE");
    // node stays consumed until sunrise refresh
    expect(engine.nodeStates.get("timber_pile_west")).toBe(true);
    expect(engine.wood).toBe(7);
  });

  test("wood collected the previous day is gathered again after sunrise refresh", () => {
    step(engine, 0.1, 60); // collect on day 1
    expect(engine.wood).toBe(7);
    // Walk the clock exactly to the night→sunrise boundary (180 s of night,
    // dt=0.5 is exact in binary). The transition tick refreshes renewables
    // BEFORE the builder moves, so the node is observable as available.
    engine.phase = "night";
    engine.phaseElapsed = 0;
    step(engine, 0.5, 360);
    expect(engine.day).toBe(2);
    expect(engine.phase).toBe("daylight");
    expect(engine.nodeStates.get("timber_pile_west")).toBe(false); // refreshed
    expect(engine.wood).toBe(7); // not yet re-collected
    // The builder then walks back out and chops again.
    step(engine, 0.5, 5);
    expect(engine.wood).toBe(12);
    expect(engine.nodeStates.get("timber_pile_west")).toBe(true);
    // And returns home with the node consumed for the day.
    step(engine, 0.1, 120);
    expect(engine.wood).toBe(12);
    expect(Math.abs(engine.agents[0].x - NPC.SAFE_ZONE_X)).toBeLessThanOrEqual(
      NPC.WORK_RANGE,
    );
  });

  test("night safety: builder retreats to the safe zone and never chops at night", () => {
    // Mid-walk toward the node when dusk hits.
    step(engine, 0.1, 3);
    const builder = engine.agents[0];
    expect(builder.x).toBeLessThan(-180);

    engine.phase = "night";
    engine.phaseElapsed = 0;
    step(engine, 0.1, 120);

    expect(Math.abs(builder.x - NPC.SAFE_ZONE_X)).toBeLessThanOrEqual(NPC.WORK_RANGE);
    expect(builder.state).toBe("IDLE");
    expect(engine.wood).toBe(2); // no night chopping
    expect(
      engine.nodeStates.get("timber_pile_west"),
    ).toBe(false);
  });

  test("dusk safety override interrupts an in-progress chop approach", () => {
    step(engine, 0.1, 3); // walking toward the node
    engine.phase = "sunset";
    engine.phaseElapsed = 0;
    step(engine, 0.1, 120);
    const builder = engine.agents[0];
    expect(Math.abs(builder.x - NPC.SAFE_ZONE_X)).toBeLessThanOrEqual(NPC.WORK_RANGE);
    expect(builder.state).toBe("IDLE");
    expect(engine.wood).toBe(2);
  });
});
