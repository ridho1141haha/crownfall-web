// Crownfall: The Last Light — save payload migration pipeline (pure functions).
//
// Mirrors the Godot source of truth (github.com/ridho1141haha/crownfall):
//   - SaveManager.gd migrate_payload() + _normalize_reign_state()
//   - SaveManager.gd _read_and_validate_file(): migrate BEFORE validate
//
// ---------------------------------------------------------------------------
// Schema compatibility contract (P4-B)
// ---------------------------------------------------------------------------
// Web (this repo):
//   - Writes exactly schema_version 3 (SAVE_SCHEMA_VERSION) since the first
//     commit that introduced the constant (verified via `git log -S
//     SAVE_SCHEMA_VERSION`). Web schema 1 and 2 were NEVER produced by any
//     web release.
//   - `validateSavePayload()` accepts ONLY the current web schema (3). Legacy
//     versions must pass through `migrateSavePayload()` first — a schema
//     version is never accepted without the migration needed for it.
//
// Godot (source of truth):
//   - Writes schema_version 2 (SCHEMA_VERSION = 2, MIN_SCHEMA_VERSION = 1).
//   - Schema 1 was a real historical Godot format (commit 3e6e6e8): its
//     payload lacked `player`, `night_encounter`, `camp_vagrants_available`;
//     progression_flags held only `first_night_survived` + a `collected_nodes`
//     id array; buildings had no `level`/`type`.
//   - Godot migrates v1→v2 in migrate_payload() and runs two cross-version
//     backfills (night_encounter.current_day_number, progression_flags.era_id)
//     for every payload. Godot does NOT synthesize a `night_encounter` for v1
//     payloads — after migration its validate_payload() still requires it
//     (REQUIRED_KEYS), so a realistic v1 save FAILS validation in Godot today.
//
// Intentional cross-platform incompatibility (documented, Phase 2 audit):
//   - Web v3 and Godot v2 represent DIFFERENT platform contracts. The numbers
//     are NOT forced to align and cross-platform save import is not a goal.
//     The only historical formats ever written under version numbers 1 and 2
//     are Godot's, so this pipeline treats v1/v2 payloads as Godot-format
//     saves and mirrors Godot's migrate_payload() transforms field by field.
//     Fields whose historical meaning is NOT verified (e.g. a fabricated
//     encounter state for v1) are never invented.
//
// Outcome parity with Godot:
//   - v2 payloads (real Godot v2 saves): migrated + backfilled, then validated
//     under the web schema → loadable, progression/resources/buildings/
//     collected nodes preserved, and re-savable as web v3.
//   - v1 payloads (real Godot v1 saves): all verified legacy transforms are
//     applied (reign_state normalization, collected_nodes → node_states,
//     defaults for later fields), but the missing `night_encounter` still
//     fails validation — exactly Godot's own accept/reject outcome today.
//     The migration transforms are observable in the migration result.
//   - Unsupported versions (< 1, > 3, non-integer, missing) are rejected
//     explicitly — never silently migrated, never silently replaced by a
//     fresh reign.
//
// Every function here is pure: input is deep-cloned before mutation
// (mirrors Godot's `duplicate(true)`), no engine state, no storage access.

import { isExactIntValue } from "./save-validation";

export const MIN_SUPPORTED_SCHEMA = 1;
export const MAX_SUPPORTED_SCHEMA = 3; // SAVE_SCHEMA_VERSION — kept in sync via test
export const CURRENT_WEB_SCHEMA = 3;

export type MigrationResult =
  | { ok: true; data: Record<string, unknown>; fromVersion: number }
  | { ok: false; reason: string };

const VALID_REIGN_STATES = ["ACTIVE", "BREACH_PENALTY", "ISLAND_CLEARED"];

/** Deep clone for plain JSON payloads (structuredClone with JSON fallback). */
function deepClone(value: Record<string, unknown>): Record<string, unknown> {
  if (typeof structuredClone === "function") {
    return structuredClone(value) as Record<string, unknown>;
  }
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

/**
 * Port of SaveManager._normalize_reign_state(): a string is accepted when it
 * is one of the three known states (upper-cased, mirroring Godot's
 * `String(raw).to_upper()` without trimming); a legacy numeric value maps
 * 1 → BREACH_PENALTY, 2 → ISLAND_CLEARED; anything else falls back to ACTIVE.
 */
export function normalizeReignState(raw: unknown): string {
  if (typeof raw === "string") {
    const s = raw.toUpperCase();
    if (VALID_REIGN_STATES.includes(s)) return s;
    return "ACTIVE";
  }
  if (isExactIntValue(raw)) {
    const idx = Math.round(raw);
    if (idx === 1) return "BREACH_PENALTY";
    if (idx === 2) return "ISLAND_CLEARED";
  }
  return "ACTIVE";
}

function isPlainObject(val: unknown): val is Record<string, unknown> {
  return val !== null && typeof val === "object" && !Array.isArray(val);
}

/**
 * Port of the Godot v1 block of migrate_payload() (SaveManager.gd, 2c61632):
 *   - default `player` when missing/not a dict
 *   - progression_flags: reign_state normalization (numeric → string),
 *     hearth_level/shipwreck_stage/portal_relic_looted defaults,
 *     collected_nodes array → node_states map when node_states is absent
 *   - buildings: level/type defaults
 * Guarded skips (progression_flags missing → untouched) mirror Godot.
 */
function migrateV1(d: Record<string, unknown>): void {
  if (!isPlainObject(d.player)) {
    d.player = { position_x: 0, facing_direction: 1 };
  }
  if (isPlainObject(d.progression_flags)) {
    const pf = d.progression_flags;
    pf.reign_state = normalizeReignState(pf.reign_state ?? "ACTIVE");
    if (!("hearth_level" in pf)) pf.hearth_level = 1;
    if (!("shipwreck_stage" in pf)) pf.shipwreck_stage = 0;
    if (!("portal_relic_looted" in pf)) pf.portal_relic_looted = false;
    if (!isPlainObject(pf.node_states)) {
      const ns: Record<string, boolean> = {};
      const collected = pf.collected_nodes;
      if (Array.isArray(collected)) {
        for (const item of collected) {
          ns[String(item)] = true;
        }
      }
      pf.node_states = ns;
    }
  }
  if (Array.isArray(d.buildings)) {
    for (const b of d.buildings) {
      if (isPlainObject(b)) {
        if (!("level" in b)) b.level = 1;
        if (!("type" in b)) b.type = "wooden_wall";
      }
    }
  }
  d.schema_version = 2;
}

/**
 * Port of Godot's cross-version backfills (run for every migrated payload):
 *   - night_encounter.current_day_number ← max(1, day_count) when absent
 *     (mid-night saves from older days would otherwise replay day-1 waves)
 *   - progression_flags.era_id ← inferred era when absent/empty
 *     (stone_age when any building is a stone_wall, else wood_age; iron_age
 *     is never inferred — only reachable via saved shipwreck stage 3)
 */
function applyCrossVersionBackfills(d: Record<string, unknown>): void {
  if (isPlainObject(d.night_encounter)) {
    const ne = d.night_encounter;
    if (!("current_day_number" in ne) && isExactIntValue(d.day_count)) {
      ne.current_day_number = Math.max(1, Math.round(d.day_count));
    }
  }
  if (isPlainObject(d.progression_flags)) {
    const pf = d.progression_flags;
    const eraMissing =
      !("era_id" in pf) ||
      typeof pf.era_id !== "string" ||
      (pf.era_id as string).length === 0;
    if (eraMissing) {
      let inferred = "wood_age";
      if (Array.isArray(d.buildings)) {
        for (const b of d.buildings) {
          if (
            isPlainObject(b) &&
            typeof b.type === "string" &&
            b.type === "stone_wall"
          ) {
            inferred = "stone_age";
            break;
          }
        }
      }
      pf.era_id = inferred;
    }
  }
}

/**
 * Explicit migration pipeline: bring a parsed legacy payload up to the
 * current web schema BEFORE validation (mirrors Godot's
 * `_read_and_validate_file` = validate_payload(migrate_payload(parsed))).
 *
 * Returns `{ ok: false, reason }` for non-object roots and unsupported or
 * invalid schema versions; `{ ok: true, data }` (deep-cloned, stamped to the
 * current web schema) otherwise. Migration NEVER validates semantics — the
 * caller must run `validateSavePayload()` on the result and reject it when
 * validation fails (no fabricated data, no fresh-reign fallback).
 */
export function migrateSavePayload(data: unknown): MigrationResult {
  if (!isPlainObject(data)) {
    return { ok: false, reason: "payload is not a JSON object" };
  }
  if (!isExactIntValue(data.schema_version)) {
    return {
      ok: false,
      reason: "schema_version is missing or not an exact integer",
    };
  }
  const ver = data.schema_version;
  if (ver < MIN_SUPPORTED_SCHEMA || ver > MAX_SUPPORTED_SCHEMA) {
    return {
      ok: false,
      reason: `unsupported schema_version ${ver} (supported: ${MIN_SUPPORTED_SCHEMA}..${MAX_SUPPORTED_SCHEMA})`,
    };
  }

  const d = deepClone(data);
  let fromVersion = ver;
  if (ver === 1) {
    migrateV1(d);
    fromVersion = 1;
  }
  // Godot's cross-version backfills run for EVERY version (including the
  // current one) — mirrored here: v2 payloads and pass-through v3 payloads
  // both get them. They only fill ABSENT optional fields, so current-schema
  // saves are unaffected.
  applyCrossVersionBackfills(d);
  // Web adaptation (documented): the pipeline stamps the CURRENT web schema.
  // Godot stamps 2 (its current). The structural transforms are identical.
  d.schema_version = CURRENT_WEB_SCHEMA;
  return { ok: true, data: d, fromVersion };
}
