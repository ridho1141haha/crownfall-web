// Crownfall: The Last Light — Godot ↔ Web configuration parity (P4-C).
//
// Compares the ACTUAL Godot data JSON files against the web `data.ts`
// constants, field by field. This is NOT a snapshot test of two web copies:
//
//   - In CI (`.github/workflows/ci.yml`) the Godot repository
//     (github.com/ridho1141haha/crownfall) is cloned and `GODOT_DATA_DIR`
//     points at its `data/` folder — the check runs against real Godot
//     source data, so any upstream balance change fails CI with a diff.
//   - Locally, without `GODOT_DATA_DIR`, the test falls back to the
//     checked-in fixtures in `tests/fixtures/godot-data/` (snapshots of the
//     Godot data at commit 2c61632de046da04b0f291761574b6d900d4037d).
//     DOCUMENTED LIMITATION: fixtures can drift from the live Godot repo —
//     they exist so the suite runs without a clone. CI always uses the real
//     repository. After an intentional Godot data change, re-copy the JSONs
//     and update `data.ts` (see docs/PHASE_4_IMPLEMENTATION_REPORT.md).
//
// Intentional, documented web-only fields (not compared): ResourceNodeDef
// `frame` (render sprite index — presentation only), plot `title`-derived
// UI labels already mirrored verbatim, and Godot-only fields unused by its
// own runtime (`eras.description`, `weakened_pct` is COMPARED because web
// mirrors it, even though neither runtime consumes it).

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  ERAS,
  ENEMY_ARCHETYPES,
  HEARTH_TIERS,
  PLOT_SEEDS,
  RESOURCE_NODES,
  STONE_WALL_MAX_DURABILITY,
  STONE_WALL_UPGRADE_COST,
  WATCHTOWER_LIGHT_RADIUS,
} from "../../src/lib/game/data";

const FIXTURE_DIR = path.join(import.meta.dir, "..", "fixtures", "godot-data");
const GODOT_DATA_DIR =
  process.env.GODOT_DATA_DIR && process.env.GODOT_DATA_DIR.length > 0
    ? process.env.GODOT_DATA_DIR
    : FIXTURE_DIR;

const usingLiveGodotRepo = GODOT_DATA_DIR !== FIXTURE_DIR;

function readGodotJson(name: string): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(path.join(GODOT_DATA_DIR, name), "utf8"));
  } catch (err) {
    if (!usingLiveGodotRepo) throw err;
    throw new Error(
      `Cannot read Godot data file ${name} from GODOT_DATA_DIR=${GODOT_DATA_DIR}. ` +
        `Clone github.com/ridho1141haha/crownfall and point GODOT_DATA_DIR at its data/ folder.`,
    );
  }
}

/** Small deep-equality helper with a readable diff message. */
function expectEqual(actual: unknown, expected: unknown, label: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(
      `CONFIG PARITY FAILURE (${label})\n` +
        `  web     : ${a}\n` +
        `  godot   : ${e}\n` +
        `Update src/lib/game/data.ts (and tests/fixtures/godot-data/) after an ` +
        `intentional Godot config change.`,
    );
  }
}

// resource_nodes.json → RESOURCE_NODES (web-only `frame` field excluded)
test("resource_nodes.json matches RESOURCE_NODES", () => {
  const json = readGodotJson("resource_nodes.json") as {
    nodes: Array<Record<string, unknown>>;
  };
  expect(json.nodes).toHaveLength(RESOURCE_NODES.length);
  json.nodes.forEach((n, i) => {
    const w = RESOURCE_NODES[i];
    expectEqual(
      {
        id: n.id,
        resource: n.resource,
        amount: n.amount,
        x: n.x,
        renewable: n.renewable,
        label: n.label,
        prompt: n.prompt,
      },
      {
        id: w.id,
        resource: w.resource,
        amount: w.amount,
        x: w.x,
        renewable: w.renewable,
        label: w.label,
        prompt: w.prompt,
      },
      `resource node #${i} (${w.id})`,
    );
  });
});

// enemies.json → ENEMY_ARCHETYPES
test("enemies.json matches ENEMY_ARCHETYPES", () => {
  const json = readGodotJson("enemies.json") as {
    archetypes: Record<string, Record<string, unknown>>;
  };
  const ids = Object.keys(json.archetypes);
  expectEqual(ids, Object.keys(ENEMY_ARCHETYPES), "archetype ids/order");
  for (const id of ids) {
    const g = json.archetypes[id];
    const w = ENEMY_ARCHETYPES[id as keyof typeof ENEMY_ARCHETYPES];
    expectEqual(
      { name: g.name, hp: g.hp, speed: g.speed, damage: g.damage },
      { name: w.name, hp: w.hp, speed: w.speed, damage: w.damage },
      `enemy archetype ${id}`,
    );
  }
});

// eras.json → ERAS (id/name/order; Godot-only `description` unused by both runtimes)
test("eras.json matches ERAS", () => {
  const json = readGodotJson("eras.json") as {
    eras: Array<Record<string, unknown>>;
  };
  expect(json.eras).toHaveLength(ERAS.length);
  json.eras.forEach((g, i) => {
    const w = ERAS[i];
    expectEqual(
      { id: g.id, name: g.name, order: g.order },
      { id: w.id, name: w.name, order: i + 1 },
      `era #${i} (${w.id})`,
    );
  });
});

// lighting.json → HEARTH_TIERS + WATCHTOWER_LIGHT_RADIUS
test("lighting.json matches HEARTH_TIERS and WATCHTOWER_LIGHT_RADIUS", () => {
  const json = readGodotJson("lighting.json") as {
    hearth_tiers: Array<Record<string, unknown>>;
    watchtower_light_radius_px: number;
  };
  expect(json.hearth_tiers).toHaveLength(HEARTH_TIERS.length);
  json.hearth_tiers.forEach((g, i) => {
    const w = HEARTH_TIERS[i];
    expectEqual(
      {
        level: g.level,
        name: g.name,
        radius_px: g.radius_px,
        texture_scale: g.texture_scale,
        burn_dps: g.burn_dps,
        weakened_pct: g.weakened_pct,
        upgrade_cost: g.upgrade_cost,
      },
      {
        level: w.level,
        name: w.name,
        radius_px: w.radiusPx,
        texture_scale: w.textureScale,
        burn_dps: w.burnDps,
        weakened_pct: w.weakenedPct,
        upgrade_cost: w.upgradeCost,
      },
      `hearth tier ${w.level}`,
    );
  });
  expectEqual(
    json.watchtower_light_radius_px,
    WATCHTOWER_LIGHT_RADIUS,
    "watchtower light radius",
  );
});

// buildings.json → PLOT_SEEDS (+ the duplicated stone-wall fallback constants)
test("buildings.json matches PLOT_SEEDS and stone-wall constants", () => {
  const json = readGodotJson("buildings.json") as {
    plots: Array<Record<string, unknown>>;
  };
  expect(json.plots).toHaveLength(PLOT_SEEDS.length);
  // Compare by plot id, not array position — Godot's BuildingManager applies
  // config per id; the web array order (farm east/west) is presentation-only.
  const byId = new Map(json.plots.map((p) => [String(p.id), p]));
  expectEqual(
    [...byId.keys()].sort(),
    PLOT_SEEDS.map((p) => p.id).sort(),
    "plot id set",
  );
  for (const w of PLOT_SEEDS) {
    const g = byId.get(w.id) as Record<string, unknown>;
    expectEqual(
      {
        id: g.id,
        type: g.type,
        position_x: g.position_x,
        build_cost: g.build_cost,
        repair_cost: g.repair_cost,
        build_duration: g.build_duration,
        max_durability: g.max_durability,
        cost_label: g.cost_label,
        support_damage: g.support_damage ?? null,
        harvest_interval: g.harvest_interval ?? null,
        gold_yield: g.gold_yield ?? null,
        upgrade: g.upgrade
          ? {
              target_type: (g.upgrade as Record<string, unknown>).target_type,
              cost: (g.upgrade as Record<string, unknown>).cost,
              max_durability: (g.upgrade as Record<string, unknown>)
                .max_durability,
              thorn_damage: (g.upgrade as Record<string, unknown>)
                .thorn_damage,
              cost_label: (g.upgrade as Record<string, unknown>).cost_label,
            }
          : null,
      },
      {
        id: w.id,
        type: w.type,
        position_x: w.x,
        build_cost: w.buildCost,
        repair_cost: w.repairCost,
        build_duration: w.buildDuration,
        max_durability: w.maxDurability,
        cost_label: w.costLabel,
        support_damage: "supportDamage" in w ? w.supportDamage : null,
        harvest_interval: "harvestInterval" in w ? w.harvestInterval : null,
        gold_yield: "goldYield" in w ? w.goldYield : null,
        upgrade: w.upgradeCost
          ? {
              target_type: w.upgradeTargetType,
              cost: w.upgradeCost,
              max_durability: w.upgradeMaxDurability,
              thorn_damage: w.upgradeThornDamage,
              cost_label: w.upgradeCostLabel,
            }
          : null,
      },
      `plot (${w.id})`,
    );
  }
  // The audit flagged STONE_WALL_UPGRADE_COST / STONE_WALL_MAX_DURABILITY as
  // duplicates of the PLOT_SEEDS upgrade values — keep them in lockstep.
  const wall = json.plots.find((p) => p.id === "wall_east_01") as Record<
    string,
    unknown
  >;
  const upgrade = wall.upgrade as Record<string, unknown>;
  expectEqual(STONE_WALL_UPGRADE_COST, upgrade.cost, "stone wall upgrade cost constant");
  expectEqual(STONE_WALL_MAX_DURABILITY, upgrade.max_durability, "stone wall max durability constant");
});

test("parity source is the real Godot repo in CI", () => {
  // Documents which source the run used; in CI this must be the live clone.
  if (process.env.CI) {
    expect(usingLiveGodotRepo).toBe(true);
  }
});
