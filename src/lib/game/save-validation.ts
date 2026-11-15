// Crownfall: The Last Light — save payload validation (pure functions).
// Ported from the Godot source of truth (github.com/ridho1141haha/crownfall):
//   - SaveManager.gd validate_payload() / migrate posture
//   - EconomyLedger.gd is_exact_int_value() / MAX_RESOURCE_CAP
//   - BuildingManager.gd is_valid_saved_building_dict()
//   - NPCBuilderAgent.gd is_valid_saved_npc_dict()
//   - NightEncounterManager.gd is_valid_saved_encounter_dict()
//   - ForestTreeManager.gd is_valid_saved_tree_states()
//
// Every function here is pure: it only reads its arguments and constants.
// No engine state, no storage access, no side effects — safe to run before
// resetState()/any mutation and safe to use for UI gating (Continue Reign).

import {
  ENEMY_ARCHETYPES,
  FARM_EAST_ID,
  FARM_WEST_ID,
  HEARTH,
  KNOWN_ERA_IDS,
  NIGHT,
  NPC,
  POP,
  SAVE_SCHEMA_VERSION,
  TREES,
  WATCHTOWER_ID,
  WORLD,
} from "./data";
import type { EnemyArchetype, PlotState, ResourceId } from "./types";

/** Mirrors EconomyLedger.MAX_RESOURCE_CAP (Godot enforces this on every add). */
export const MAX_RESOURCE_CAP = 999999;

/** Longest wave schedule (ESCALATED_WAVE_TIMES) — Godot caps saved waves at 4. */
const MAX_WAVES = NIGHT.ESCALATED_WAVE_TIMES.length;
/** West scout schedule length — Godot caps west_spawned_count at 2. */
const MAX_WEST_SCOUTS = NIGHT.WEST_SCOUT_TIMES.length;
/** Brute HP is the highest any archetype can reach (Godot MAX_POSSIBLE_ENEMY_HP). */
const MAX_POSSIBLE_ENEMY_HP = Math.max(
  ...Object.values(ENEMY_ARCHETYPES).map((a) => a.hp),
);

const PLOT_STATES: PlotState[] = [
  "PLACEHOLDER",
  "UNDER_CONSTRUCTION",
  "COMPLETED",
  "DAMAGED",
  "DESTROYED",
];

const PLOT_ALLOWED_TYPES: Record<string, string[]> = {
  wall_east_01: ["wooden_wall", "stone_wall"],
  wall_west_01: ["wooden_wall", "stone_wall"],
  watchtower_east_01: ["watchtower"],
  farm_west_01: ["farm_plot"],
  farm_east_01: ["farm_plot"],
};
const PLOT_IDS = Object.keys(PLOT_ALLOWED_TYPES);

const NPC_ROLES = ["builder", "farmer", "archer", "villager"];
const NPC_STATES = [
  "UNRECRUITED",
  "IDLE",
  "MOVING_TO_TASK",
  "WORKING",
  "RETURNING_TO_SAFETY",
];
const ENEMY_ARCHETYPE_IDS = Object.keys(ENEMY_ARCHETYPES) as EnemyArchetype[];
const TRAMPLED_PLOT_WHITELIST = [WATCHTOWER_ID, FARM_EAST_ID, FARM_WEST_ID];
const ENCOUNTER_TIMERS = [
  "attack_timer",
  "light_burn_acc",
  "west_attack_timer",
  "west_burn_acc",
];
const ENCOUNTER_REQUIRED_KEYS = [
  "night_active",
  "night_elapsed",
  "spawned_wave_count",
  "enemy_active",
  "enemy_x",
  "enemy_hp",
  "settlement_breached",
  "first_night_survived",
] as const;

const SAVE_REQUIRED_KEYS = [
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
] as const;

/**
 * Port of EconomyLedger.is_exact_int_value(): accepts integers and floats
 * that equal their own rounding; rejects NaN, ±Infinity and fractions.
 */
export function isExactIntValue(val: unknown): val is number {
  if (typeof val !== "number") return false;
  if (!Number.isFinite(val)) return false;
  return val === Math.round(val);
}

const isFiniteNumber = (val: unknown): val is number =>
  typeof val === "number" && Number.isFinite(val);

const nonEmptyString = (val: unknown): val is string =>
  typeof val === "string" && val.trim().length > 0;

/**
 * Parse save JSON text defensively. Returns null for malformed JSON,
 * non-object roots (arrays, numbers, strings) — never throws.
 */
export function parseSaveJson(raw: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  return parsed as Record<string, unknown>;
}

/**
 * Port of BuildingManager.is_valid_saved_building_dict().
 * Rejects state/durability inconsistency (PLACEHOLDER/DESTROYED must have 0
 * durability; COMPLETED/DAMAGED must have positive durability), type/level
 * inconsistency (stone_wall requires level 2; watchtower/farm_plot level 1),
 * non-integer durability/level and out-of-range progress.
 */
export function isValidSavedBuildingDict(data: unknown): boolean {
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return false;
  }
  const d = data as Record<string, unknown>;
  if (!("id" in d) || !("state" in d) || !("durability" in d)) return false;
  if (!nonEmptyString(d.id)) return false;
  const st = d.state;
  if (typeof st !== "string" || !PLOT_STATES.includes(st as PlotState)) {
    return false;
  }
  if (!isExactIntValue(d.durability)) return false;
  const dur = d.durability;
  const maxDurRaw = d.max_durability ?? 150; // Godot: REINFORCED_MAX_DURABILITY fallback
  if (!isExactIntValue(maxDurRaw)) return false;
  const maxDur = maxDurRaw;
  if (maxDur <= 0 || dur < 0 || dur > maxDur) return false;

  const prog = d.progress ?? 0;
  if (!isFiniteNumber(prog) || prog < 0 || prog > 1) return false;

  const level = d.level ?? 1;
  if (!isExactIntValue(level) || level < 1 || level > 2) return false;

  const btype = typeof d.type === "string" ? d.type : "wooden_wall";
  if (btype === "stone_wall" && level < 2) return false;
  if ((btype === "watchtower" || btype === "farm_plot") && level !== 1) {
    return false;
  }
  if ((st === "PLACEHOLDER" || st === "DESTROYED") && dur !== 0) return false;
  if ((st === "COMPLETED" || st === "DAMAGED") && dur <= 0) return false;
  return true;
}

/**
 * Port of NPCBuilderAgent.is_valid_saved_npc_dict().
 */
export function isValidSavedNpcDict(data: unknown): boolean {
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return false;
  }
  const d = data as Record<string, unknown>;
  if (!("id" in d) || !("recruited" in d) || !("role" in d) || !("state" in d)) {
    return false;
  }
  if (!nonEmptyString(d.id)) return false;
  if (typeof d.recruited !== "boolean") return false;
  if (!NPC_ROLES.includes(String(d.role))) return false;
  if (!NPC_STATES.includes(String(d.state))) return false;
  const pos = d.position_x ?? -220; // Godot: CAMP_POSITION_X fallback
  if (!isFiniteNumber(pos)) return false;
  if (pos < WORLD.MIN_PLAYABLE_X || pos > WORLD.MAX_PLAYABLE_X) return false;
  if ("farm_timer" in d) {
    if (!isFiniteNumber(d.farm_timer)) return false;
    if (d.farm_timer < 0 || d.farm_timer > NPC.FARMER_HARVEST_SEC) return false;
  }
  return true;
}

/**
 * Port of NightEncounterManager.is_valid_saved_encounter_dict().
 * The six mid-combat sub-fields (attack timers, burn accumulators, trampled
 * lists) are optional — the web payload omits them (audit B7) while saves
 * produced by legitimate flows always carry them as dormant zeros.
 */
export function isValidSavedEncounterDict(data: unknown): boolean {
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return false;
  }
  const d = data as Record<string, unknown>;
  for (const key of ENCOUNTER_REQUIRED_KEYS) {
    if (!(key in d)) return false;
  }
  if (
    typeof d.night_active !== "boolean" ||
    typeof d.enemy_active !== "boolean"
  ) {
    return false;
  }
  if (
    typeof d.settlement_breached !== "boolean" ||
    typeof d.first_night_survived !== "boolean"
  ) {
    return false;
  }
  if (!isExactIntValue(d.spawned_wave_count) || !isExactIntValue(d.enemy_hp)) {
    return false;
  }
  const waves = d.spawned_wave_count;
  const hp = d.enemy_hp;
  if (waves < 0 || waves > MAX_WAVES || hp < 0 || hp > MAX_POSSIBLE_ENEMY_HP) {
    return false;
  }
  if (!isFiniteNumber(d.night_elapsed) || d.night_elapsed < 0) return false;
  if (!isFiniteNumber(d.enemy_x)) return false;
  if (d.enemy_active && hp <= 0) return false;

  if ("enemy_archetype" in d) {
    if (!ENEMY_ARCHETYPE_IDS.includes(d.enemy_archetype as EnemyArchetype)) {
      return false;
    }
  }
  if ("enemy_max_hp" in d) {
    if (!isExactIntValue(d.enemy_max_hp)) return false;
    const emax = d.enemy_max_hp;
    if (emax <= 0 || emax > MAX_POSSIBLE_ENEMY_HP || hp > emax) return false;
  }
  if ("current_day_number" in d) {
    if (!isExactIntValue(d.current_day_number) || d.current_day_number < 1) {
      return false;
    }
  }
  if ("west_spawned_count" in d) {
    if (!isExactIntValue(d.west_spawned_count)) return false;
    if (d.west_spawned_count < 0 || d.west_spawned_count > MAX_WEST_SCOUTS) {
      return false;
    }
  }
  if ("west_enemy_active" in d && typeof d.west_enemy_active !== "boolean") {
    return false;
  }
  if ("west_enemy_x" in d && !isFiniteNumber(d.west_enemy_x)) return false;
  if ("west_enemy_hp" in d) {
    if (!isExactIntValue(d.west_enemy_hp)) return false;
    const whp = d.west_enemy_hp;
    if (whp < 0 || whp > MAX_POSSIBLE_ENEMY_HP) return false;
    if (
      (d.west_enemy_active ?? false) &&
      whp <= 0
    ) {
      return false;
    }
  }
  if ("west_enemy_max_hp" in d) {
    if (!isExactIntValue(d.west_enemy_max_hp)) return false;
    const wmax = d.west_enemy_max_hp;
    if (wmax <= 0 || wmax > MAX_POSSIBLE_ENEMY_HP) return false;
    if ("west_enemy_hp" in d && (d.west_enemy_hp as number) > wmax) {
      return false;
    }
  }
  for (const timerKey of ENCOUNTER_TIMERS) {
    if (timerKey in d) {
      if (!isFiniteNumber(d[timerKey]) || (d[timerKey] as number) < 0) {
        return false;
      }
    }
  }
  for (const trampledKey of ["east_trampled", "west_trampled"]) {
    if (trampledKey in d) {
      const arr = d[trampledKey];
      if (!Array.isArray(arr)) return false;
      for (const pid of arr) {
        if (!TRAMPLED_PLOT_WHITELIST.includes(String(pid))) return false;
      }
    }
  }
  return true;
}

/**
 * Port of ForestTreeManager.is_valid_saved_tree_states(): every key must be a
 * known tree id and every value an exact integer HP within [0, tree maxHp].
 */
export function isValidSavedTreeStates(data: unknown): boolean {
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return false;
  }
  const knownMax = new Map(TREES.map((t) => [t.id, t.maxHp]));
  const d = data as Record<string, unknown>;
  for (const key of Object.keys(d)) {
    if (!knownMax.has(key)) return false;
    if (!isExactIntValue(d[key])) return false;
    const hp = d[key];
    if (hp < 0 || hp > (knownMax.get(key) as number)) return false;
  }
  return true;
}

/**
 * Port of SaveManager.gd validate_payload(), adapted to the Web save schema.
 *
 * Schema note (intentional platform difference preserved from the audit):
 * the web writes schema_version 3 while Godot writes 2. Versions 1..3 are
 * accepted here — the web payload has always been version 3, and the range
 * mirrors Godot's MIN_SCHEMA_VERSION..SCHEMA_VERSION pattern without
 * cross-platform save import.
 *
 * Rejects (among others): non-finite numbers, fractional values where exact
 * integers are required, out-of-range resources (negative or above the
 * 999,999 cap), invalid building/NPC/encounter semantics, duplicate ids and
 * invalid progression data. A true return value means the payload is safe to
 * apply; callers must still treat it as the only gate before mutating state.
 */
export function validateSavePayload(data: unknown): boolean {
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return false;
  }
  const dict = data as Record<string, unknown>;
  for (const key of SAVE_REQUIRED_KEYS) {
    if (!(key in dict)) return false;
  }

  // schema_version: exact int within the supported web range.
  if (!isExactIntValue(dict.schema_version)) return false;
  const ver = dict.schema_version;
  if (ver < 1 || ver > SAVE_SCHEMA_VERSION) return false;

  // world / island identifiers
  if (!nonEmptyString(dict.world_id) || !nonEmptyString(dict.island_id)) {
    return false;
  }

  // clock
  if (!isExactIntValue(dict.day_count) || dict.day_count < 1) return false;
  if (!isFiniteNumber(dict.world_time) || dict.world_time < 0) return false;
  const phase = dict.world_phase;
  if (
    typeof phase !== "string" ||
    !["daylight", "sunset", "night"].includes(phase)
  ) {
    return false;
  }

  // resources: exact ints in [0, MAX_RESOURCE_CAP]
  const res = dict.resources;
  if (res === null || typeof res !== "object" || Array.isArray(res)) {
    return false;
  }
  const resDict = res as Record<string, unknown>;
  for (const rKey of ["gold", "wood", "stone"] as ResourceId[]) {
    if (!(rKey in resDict)) return false;
    if (!isExactIntValue(resDict[rKey])) return false;
    const rVal = resDict[rKey];
    if (rVal < 0 || rVal > MAX_RESOURCE_CAP) return false;
  }

  // buildings: non-empty, each valid, unique known plot ids with allowed types
  const buildings = dict.buildings;
  if (!Array.isArray(buildings) || buildings.length === 0) return false;
  const seenPlotIds = new Set<string>();
  for (const item of buildings) {
    if (!isValidSavedBuildingDict(item)) return false;
    const b = item as Record<string, unknown>;
    const plotId = String(b.id);
    if (!PLOT_IDS.includes(plotId) || seenPlotIds.has(plotId)) return false;
    seenPlotIds.add(plotId);
    const btype = typeof b.type === "string" ? b.type : "wooden_wall";
    if (!PLOT_ALLOWED_TYPES[plotId].includes(btype)) return false;
    if ("position_x" in b) {
      const bpx = b.position_x;
      if (
        !isFiniteNumber(bpx) ||
        bpx < WORLD.MIN_PLAYABLE_X ||
        bpx > WORLD.MAX_PLAYABLE_X
      ) {
        return false;
      }
    }
  }

  // npcs: non-empty, capped population, valid dicts, unique ids
  const npcs = dict.npcs;
  if (!Array.isArray(npcs) || npcs.length === 0) return false;
  if (npcs.length > POP.MAX_POPULATION) return false;
  const seenNpcIds = new Set<string>();
  for (const item of npcs) {
    if (!isValidSavedNpcDict(item)) return false;
    const npcId = String((item as Record<string, unknown>).id);
    if (seenNpcIds.has(npcId)) return false;
    seenNpcIds.add(npcId);
  }

  // night encounter
  if (!isValidSavedEncounterDict(dict.night_encounter)) return false;
  const ne = dict.night_encounter as Record<string, unknown>;
  if ("current_day_number" in ne) {
    if ((ne.current_day_number as number) > (dict.day_count as number)) {
      return false;
    }
  }

  // player (optional)
  if ("player" in dict) {
    const p = dict.player;
    if (p === null || typeof p !== "object" || Array.isArray(p)) return false;
    const pDict = p as Record<string, unknown>;
    const px = pDict.position_x ?? 0;
    if (
      !isFiniteNumber(px) ||
      px < WORLD.MIN_PLAYABLE_X ||
      px > WORLD.MAX_PLAYABLE_X
    ) {
      return false;
    }
    if ("facing_direction" in pDict) {
      if (!isExactIntValue(pDict.facing_direction)) return false;
      const fd = pDict.facing_direction;
      if (fd !== -1 && fd !== 1) return false;
    }
  }

  // progression flags
  const flags = dict.progression_flags;
  if (flags === null || typeof flags !== "object" || Array.isArray(flags)) {
    return false;
  }
  const pf = flags as Record<string, unknown>;
  if ("hearth_level" in pf) {
    if (!isExactIntValue(pf.hearth_level)) return false;
    const hl = pf.hearth_level;
    if (hl < 1 || hl > 3) return false;
  }
  if ("reign_state" in pf && typeof pf.reign_state === "string") {
    if (
      !["ACTIVE", "BREACH_PENALTY", "ISLAND_CLEARED"].includes(pf.reign_state)
    ) {
      return false;
    }
  }
  if ("shipwreck_stage" in pf) {
    if (!isExactIntValue(pf.shipwreck_stage)) return false;
    const sw = pf.shipwreck_stage;
    if (sw < 0 || sw > 3) return false;
  }
  if ("node_states" in pf) {
    const ns = pf.node_states;
    if (ns === null || typeof ns !== "object" || Array.isArray(ns)) {
      return false;
    }
    for (const v of Object.values(ns as Record<string, unknown>)) {
      if (typeof v !== "boolean") return false;
    }
  }
  if ("era_id" in pf) {
    if (typeof pf.era_id !== "string") return false;
    if (!KNOWN_ERA_IDS.includes(pf.era_id as (typeof KNOWN_ERA_IDS)[number])) {
      return false;
    }
  }
  if ("tree_states" in pf && !isValidSavedTreeStates(pf.tree_states)) {
    return false;
  }
  if ("hearth_boost_remaining" in pf) {
    const hbr = pf.hearth_boost_remaining;
    if (
      !isFiniteNumber(hbr) ||
      hbr < 0 ||
      hbr > HEARTH.BOOST_DURATION_SEC
    ) {
      return false;
    }
  }

  // camp vagrants (optional)
  if ("camp_vagrants_available" in dict) {
    if (!isExactIntValue(dict.camp_vagrants_available)) return false;
    const cva = dict.camp_vagrants_available;
    if (cva < 0 || cva > POP.MAX_CAMP_VAGRANTS) return false;
  }

  return true;
}
