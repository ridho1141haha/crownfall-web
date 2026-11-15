# Crownfall Web — Phase 2 Stabilization Audit

**Date:** 2026-11-15
**Web repo audited:** `ridho1141haha/crownfall-web` @ `3f6156b` ("feat(v1.4.3 sync): data-driven plot config & upgrade costs, era progression, payment fly animation, night exit warning")
**Godot source of truth:** `ridho1141haha/crownfall` (cloned at same date)
**Method:** static code inspection + runtime verification in a real browser (Chromium via agent-browser, dev server `next dev`, dev-mode instrumentation hook `window.__crownfall` — read-only state dump, no gameplay effect).
**Scope:** correctness and Godot-Web parity only. No gameplay code was modified, no balance changed, no features added, no refactoring performed.

Classifications used: **CONFIRMED PASS**, **CONFIRMED BUG**, **PARTIAL**, **NOT VERIFIED**, **INTENTIONAL DIFFERENCE**.

---

## 1. Executive Summary

The v1.4.3 report's claims about *payment animations, era progression, save/load, and unsaved-progress warnings* hold up under re-verification. However, this audit does **not** establish full Godot-Web parity. Two gameplay-affecting parity bugs were confirmed at runtime, plus several save-robustness gaps:

| # | Finding | Area | Classification | Impact |
|---|---------|------|----------------|--------|
| B1 | Builder auto-chop **deadlocks** at the safe-zone boundary and never reaches the renewable wood node; wood income from auto-chop is **completely non-functional** in web | 5 | **CONFIRMED BUG** (runtime) | High (economy) |
| B2 | Load with **valid-JSON/invalid-schema primary** does **not** fall back to the backup (Godot does) | 1, 2 | **CONFIRMED BUG** (runtime) | High (data loss) |
| B3 | "Continue Reign" is enabled when saves exist but are **invalid**; clicking silently starts a fresh reign | 2 | **CONFIRMED BUG** (runtime) | Medium (surprise reset) |
| B4 | Save validation accepts semantically invalid payloads Godot rejects (`Infinity` day/gold, `PLACEHOLDER` with durability > 0, unvalidated `night_encounter`, no duplicate-ID checks) | 1 | **CONFIRMED BUG** (runtime evidence for Infinity + PLACEHOLDER cases) | Medium-High |
| B5 | `saveGame()` copies the existing primary to backup **without validating it first** — can destroy the only good backup | 2 | **CONFIRMED BUG** (static) | Medium |
| B6 | No self-heal of a corrupt primary after backup recovery (Godot rewrites the primary; web reads the corrupt primary first on every subsequent load) | 2 | **CONFIRMED BUG** (static) | Medium |
| B7 | Night-encounter sub-state (`attack_timer`, `light_burn_acc`, `west_attack_timer`, `west_burn_acc`, `east_trampled`, `west_trampled`) is not persisted by web | 3 | MISSING PERSISTENCE (low practical impact — see 4.3) | Low |
| B8 | Economy `tryAdd`/`tryAddBundle` lack the 999,999 resource cap Godot enforces | 4 | **CONFIRMED BUG** (static, edge behavior) | Low |
| G1 | Config parity: all five Godot data JSONs are reproduced **value-identical** in `data.ts` | 4 | **CONFIRMED PASS** (static) | — |
| G2 | All six backup-recovery matrix cells exercised: 4 PASS, 2 BUG (B2, B3), restoration-failure cell not reachable (4.2) | 2 | PARTIAL | — |
| G3 | No automated tests exist in the web repo (no runner, no suites, no CI workflow) | 6 | **CONFIRMED BUG** (coverage gap) | High (regression risk) |

Positive confirmations: transactional ordering (validate-before-mutate) works for the subset of fields web actually validates (runtime-verified: a rejected load left live state untouched); backup recovery works for missing/malformed primary; both-valid load restores full state; night safety for builders works; dawn autosave, unsaved-progress night warning, and config values all match Godot.

No browser console errors or page errors were recorded during any runtime test session.

---

## 2. Audit 1 — Transactional Save Loading

### 2.1 Web implementation

- `src/lib/game/engine.ts` — `loadGame()` (lines 2524–2572) → `applySavePayload(data)` (lines 2574–2736); `saveGame()` (2511–2522); `resetState()` (181–261); `refreshHasSave()` (2431–2440).
- Storage keys: `crownfall_save_slot_0` / `crownfall_save_slot_0_bak` (`data.ts` lines 441–442).

Load flow: read primary → on missing/JSON-parse-failure read backup → `applySavePayload()` runs **pre-mutation validation** (lines 2575–2609) → `this.resetState()` (line 2612) → unguarded restoration of every field (2614–2733).

### 2.2 Godot implementation (source of truth)

- `scripts/save/SaveManager.gd` — `load_state()` (100–132) reads + **migrates + validates** via `_read_and_validate_file()` (431–441) before any data is handed to the session; full schema validation in `validate_payload()` (210–361).
- `scripts/world/ForgottenShoreSession.gd` — `load_game_state()` (1333–1351): takes a **live snapshot** `build_save_payload()` *before* mutating, then `_apply_loaded_payload(data)` (1354–1406) whose every sub-step (night encounter, clock, economy, buildings, NPCs) returns `false` on failure → snapshot re-applied (`_apply_loaded_payload(snapshot)`, line 1345) + `_sync_all_presentations()`. Explicit comment: "Transaksional: snapshot state hidup saat ini SEBELUM ada mutasi."

### 2.3 Findings

| Requirement | Web status | Classification |
|---|---|---|
| Current state preserved if loading fails | Yes for the validated subset — runtime-verified: a schema-invalid payload (`npcs` missing) was rejected with live `gold` unchanged (7, not the payload's 999). No rollback exists, but post-validation restoration contains no failure paths (all guarded coercions), so partial application is not reachable via JSON today. | **PARTIAL** |
| Parsing & validation before mutating active state | Yes (validation block precedes `resetState()`), but validation coverage is a small subset of Godot's. | **PARTIAL** |
| Failed restore can leave partially applied state | Not reachable today (see above); no rollback mechanism exists if future code introduces a failure path. Godot re-verifies and rolls back. | **PARTIAL** |
| Rollback covers every mutable gameplay field | Web: none (relies on validate-first). Godot: full snapshot rollback of player, flags, encounter, clock, economy, buildings, NPCs, vagrants. | **PARTIAL** |
| Malformed / semantically invalid payloads rejected | **No.** Runtime-confirmed acceptances (see 2.4 / repro R4). | **CONFIRMED BUG** |

### 2.4 Validation-strength gaps (web vs Godot), with evidence

Every item cites the web line that accepts what Godot's `SaveManager.gd validate_payload()` (210–361) rejects:

1. **Non-finite numbers accepted.** Web checks only `typeof x === "number"` (e.g. `day_count`, engine.ts:2575; `res.gold`, 2580). `JSON.parse('{"day_count": 1e999}')` yields `Infinity` → `this.day = Infinity` (2695), `gold = Infinity` (2699). Runtime evidence: load succeeded with "Loaded saved kingdom state" toast; `__crownfall.read()` returned `day: Infinity`, `gold: Infinity`. Godot rejects: `is_exact_int_value()` fails for inf/NaN, plus explicit `is_nan/is_inf` checks (SaveManager.gd:218–229, 239–244).
2. **`night_encounter` has zero validation in web** (engine.ts:2665–2693 applies raw `Number()`/`Boolean()` coercions). Godot validates all 22 fields (`NightEncounterManager.gd is_valid_saved_encounter_dict`, 422–501): wave counts ≤ 4, HP ≤ 160, finite positions, `active ⇒ hp > 0`, archetype whitelist, timer finiteness, trampled-plot whitelist, `current_day_number ≤ day_count`. Runtime evidence: payload with `enemy_x: 1e999` (`Infinity`) + `enemy_active: true` was accepted.
3. **Building semantic consistency unchecked.** Web accepts `PLACEHOLDER` with `durability: 100` (engine.ts:2584–2596 only checks enum/finite/ranges). Godot rejects (`PLACEHOLDER`/`DESTROYED` ⇒ durability 0; `COMPLETED`/`DAMAGED` ⇒ durability > 0; `stone_wall` ⇒ level 2; `watchtower`/`farm_plot` ⇒ level 1 — `BuildingManager.gd is_valid_saved_building_dict`, 731–767). Runtime evidence: `PLACEHOLDER`+`durability 100` applied (`read().plots[0] = {state: "PLACEHOLDER", durability: 100}`).
4. **No duplicate-ID rejection** for buildings/NPCs (Godot: SaveManager.gd:258–287 rejects duplicates; web map-set/overwrite silently, engine.ts:2585, 2716–2727).
5. **`schema_version`, `world_id`, `island_id` not validated at all** in web; Godot requires exact int 1..2 and non-empty ids (SaveManager.gd:218–224).
6. **`resources.wood`/`stone` unvalidated** (only `gold` typeof-checked, engine.ts:2580); NaN reaches `wood = NaN` via `Math.round(NaN)` (2699–2701). Godot requires exact ints in `[0, MAX_RESOURCE_CAP]` for all three.
7. **NPC `farm_timer` unvalidated** — NaN survives `clamp()` (`Math.max(0, NaN) = NaN`), silently stalls the farmer yield loop (engine.ts:2723). Godot: finite check + range `[0, FARMER_HARVEST_SEC]` (NPCBuilderAgent.gd:352–357).
8. **No integer checks** — `day_count: 3.5` is accepted by web (`Math.round` to 4); Godot requires exact ints.

### 2.5 Continue-gating parity

- Web `refreshHasSave()` (engine.ts:2431–2440): enabled if **either key merely exists**. Title button: `crownfall-game.tsx` lines 535–544 (`disabled={!hasSave}`).
- Godot `Main.gd refresh_continue_state()` (15–19): enabled only if `has_valid_save()` = full parse+migrate+validate pass.
- Runtime evidence for the resulting divergence: see repro R3.

---

## 3. Audit 2 — Backup Recovery

Web fallback logic: `loadGame()` engine.ts:2524–2554 (read primary → on *missing* or *JSON-parse-throw* read backup). There is **no fallback when the primary parses but fails `applySavePayload` validation** (line 2556: `const ok = this.applySavePayload(data); if (!ok) return false;`).

Godot fallback logic: `SaveManager.gd load_state()` 100–132 — fallback happens on **any** `_read_and_validate_file` failure (missing, empty, malformed, invalid schema) and the corrupt primary is then **self-healed** from the verified backup (`_restore_from_backup_file`, 415–423).

### 3.1 Matrix results (runtime unless noted)

| # | Case | Web result | Classification |
|---|------|-----------|----------------|
| 1 | Primary missing, backup valid | Backup loaded; toasts "Save file was corrupted — recovered from backup" + "Loaded saved kingdom state from backup"; restored `gold=7`, `playerX=123.4` | **CONFIRMED PASS** |
| 2 | Primary malformed JSON, backup valid | Backup loaded; same recovery toasts; state restored | **CONFIRMED PASS** |
| 3 | Primary valid JSON, invalid schema, backup valid | **"Load failed — save may be corrupted."** Backup NOT consulted (Godot: falls back). Live state preserved (gold stayed 7). | **CONFIRMED BUG** (repro R2) |
| 4 | Primary parses+validates but fails during restoration | Not reachable: web restoration has no failure return after validation (all guarded coercions, engine.ts:2614–2733). Godot can fail at 5 apply steps and rolls back via snapshot (ForgottenShoreSession.gd:1342–1347). | **PARTIAL** (no reachable failure; no rollback safety net) |
| 5 | Both saves invalid | Load fails without crash; **but title screen still enables "Continue Reign"** (existence-only `hasSave`) and clicking starts a fresh reign with toast "No usable save found — starting a fresh reign." | **CONFIRMED BUG** (gating, repro R3) |
| 6 | Both saves valid | Continue loads primary state fully (`gold=11`, `wood=9`, `stone=4`, `playerX=123.4`, day/phase) | **CONFIRMED PASS** |

### 3.2 Additional structural gaps (static)

- **B5 — backup clobbering.** Web `saveGame()` (engine.ts:2511–2522): `if (existing) localStorage.setItem(SAVE_BACKUP_KEY, existing)` copies the existing primary to the backup **without validating it**. If the primary is corrupt while the backup is good, the next save overwrites the good backup with the corrupt text; if the subsequent primary write then throws (quota), both slots are corrupt. Godot stages the backup only after `_read_and_validate_file(save_path)` succeeds and aborts the whole save leaving everything untouched (SaveManager.gd:71–86).
- **B6 — no self-heal.** After a backup recovery, web never rewrites the primary. The corrupt primary remains, so every later load hits the same corrupt primary first. Godot `_restore_from_backup_file` (415–423) repairs the active slot.
- Cosmetic parity note (not a bug): case 1's "corrupted" wording for a *missing* primary matches Godot's behavior (it emits `load_recovered_from_backup` in both missing and corrupt cases).

---

## 4. Audit 3 — Save Payload Parity

Payload producers: Godot `ForgottenShoreSession.build_save_payload()` (1274–1311) + managers' `to_save_*`; web `GameEngine.buildSavePayload()` (engine.ts:2446–2509). Field lists below were verified against an actual runtime dump of the web payload.

### 4.1 Top-level and per-entity fields

| Group | Verdict |
|---|---|
| Top-level keys | Identical set (`schema_version, world_id, island_id, day_count, world_time, world_phase, player, resources, buildings, npcs, camp_vagrants_available, night_encounter, progression_flags`). `schema_version` **value** differs: web writes **3** (`data.ts:440`), Godot writes **2** (`SaveManager.gd:9`). | **INTENTIONAL DIFFERENCE** — self-consistent per platform, but cross-platform save files are mutually rejected (Godot `validate_payload` caps version at 2). |
| player, resources, camp_vagrants_available | Identical fields, same rounding (0.1 px / int balances). Restore clamps equivalent (Godot `clampf` / web `clamp`), bounds identical (`WorldConstants` vs `WORLD`). | **Equivalent behavior** |
| buildings | Both persist `{id, type, position_x, level, state, progress, durability, max_durability}`. Godot validates type/level/state↔durability consistency and rejects duplicates; web validates enum + numeric ranges only (see 2.4.3). | Equivalent behavior for well-formed saves; validation strength differs |
| npcs | Both persist `{id, recruited, role, state, position_x, farm_timer}`. Both clear task on restore and let AI re-acquire (Godot `apply_save_dict` sets `assigned_task_id=""`; web sets `base.task=""`, `targetX=SAFE_ZONE_X`). Godot additionally stages probe agents before commit (`NPCPopulationManager.apply_save_array` 128–151); web rebuilds the list directly. Godot validates `farm_timer` finite range; web clamps (NaN survives, 2.4.7). | **Equivalent behavior** (restoration semantics), validation differs |
| node / tree states | Godot `progression_flags` contains both `collected_nodes` (legacy array) and `node_states` (map); web writes **only** `node_states`. Restore: both reset-then-apply, unknown keys ignored, per-tree clamp to maxHp (Godot `ForestTreeManager.apply_save_state` 122–132 / web engine.ts:2655–2663). Renewable/tree regrow at sunrise *before* autosave in both (Godot `_on_sunrise_reached` 771–793 / web `onSunriseReached` 450–473). | Equivalent behavior; `collected_nodes` omission = **INTENTIONAL DIFFERENCE** (legacy v1-import support not implemented in web) |
| hearth, era, reign, shipwreck, portal, shrine | `hearth_level` (1..3), `hearth_boost_remaining` (0..60), `reign_state` (3-enum), `shipwreck_stage` (0..3), `portal_relic_looted`, `shrine_offering_used_today`, `era_id` — persisted and restored equivalently (web clamps: engine.ts:2625–2632; Godot validates: SaveManager.gd:314–352). Era inference fallback for era-less saves identical (stone wall present ⇒ stone_age; engine.ts:2633–2647 vs `migrate_payload` 194–206). | **Equivalent behavior** |

### 4.2 Encounter persistence detail

Godot `NightEncounterManager.to_save_dict()` (395–419) writes **22** fields; web writes **16** (`buildSavePayload` 2478–2495). The six web-omitted fields:

| Godot field | Web runtime state exists? | Persisted? | Restored? |
|---|---|---|---|
| `attack_timer` | yes (`night.attackTimer`, engine.ts:116) | no | no |
| `light_burn_acc` | yes (`night.burnAccumulator`) | no | no |
| `west_attack_timer` | yes (`west.attackTimer`) | no | no |
| `west_burn_acc` | yes (`west.burnAccumulator`) | no | no |
| `east_trampled` | yes (`eastTrampled`, engine.ts:135) | no | no |
| `west_trampled` | yes (`westTrampled`, engine.ts:136) | no | no |

Classified: **MISSING PERSISTENCE** (B7).

### 4.3 Practical impact of B7 — bounded

Manual save is night-locked on **both** platforms (web `manualSave()` engine.ts:2193–2197; Godot `_on_manual_save()` ForgottenShoreSession.gd:659–667) and the only autosave fires at sunrise (`onSunriseReached` / `_on_sunrise_reached`), when the encounter is fully resolved. Therefore every save produced through legitimate flows stores timers/accumulators as 0 and trampled arrays as empty — the six fields are dormant in practice. They would matter only if a midnight save path were ever introduced, or for hand-crafted saves, which web additionally accepts unvalidated (2.4.2).

Encounter-state fields that **are** persisted equivalently: `night_active`, `night_elapsed` (+wave re-derivation from `WAVE_SPAWN_TIMES`/`ESCALATED_WAVE_TIMES` — schedules identical), `spawned_wave_count`, east/west enemy `{active, x, hp, max_hp, archetype}` (archetype whitelist on restore: web engine.ts:2674–2677, Godot validation 445–448), `current_day_number` (with the same day_count backfill fallback for legacy saves — web 2678–2686 vs `migrate_payload` 187–193), `west_spawned_count`, `settlement_breached`, `first_night_survived`.

**Unverified items in this audit:** none — every payload field listed above was compared against both implementations' code, and the web field list was additionally confirmed from a live payload dump.

---

## 5. Audit 4 — Configuration Parity

Compared `data/buildings.json`, `data/enemies.json`, `data/eras.json`, `data/lighting.json`, `data/resource_nodes.json` (Godot) against `src/lib/game/data.ts` (web). No other engine configuration file exists in the web repo (`engine.ts` imports only `./data` and `./types`).

### 5.1 Value-by-value result

| Config | Result |
|---|---|
| `buildings.json` (5 plots) → `PLOT_SEEDS` (data.ts:156–240) | **CONFIRMED PASS** — ids, types, positions (380 / 210 / 120 / -310 / -400), build+repair costs, durations (4.0 / 3.5), max durability (150 / 120 / 80), support_damage 10, harvest 60 s / yield 2, upgrade blocks (3G 2W 5S → 260 HP, thorn 20, labels) all identical, both wall plots included |
| `enemies.json` → `ENEMY_ARCHETYPES` (data.ts:243–250) | **CONFIRMED PASS** — raider/crawler/brute hp 45/45/160, speed 95/135/55, damage 15/12/35 identical |
| `eras.json` → `ERAS` (data.ts:139–150) | **CONFIRMED PASS** — ids/names/order identical; Godot-only `description` field is unused by Godot gameplay too (`EraProgressionManager` reads id/name/order only) — present-but-unused in both |
| `lighting.json` → `HEARTH` + `HEARTH_TIERS` + `WATCHTOWER_LIGHT_RADIUS` (data.ts:271–314) | **CONFIRMED PASS** — tiers 180/320/460 px, scale 2.6/4.2/5.8, dps 2/2/4, upgrade costs identical; `weakened_pct` present in both, consumed by **neither** runtime (Godot `get_weakened_pct()` has zero callers) — dead field in both |
| `resource_nodes.json` → `RESOURCE_NODES` (data.ts:54–105) | **CONFIRMED PASS** — 5 nodes, ids/resources/amounts/x/renewable/labels/prompts identical; web-only `frame` field = render sprite index (**INTENTIONAL DIFFERENCE**, presentation-only) |

Non-JSON constants cross-checked against Godot scripts: `TIME` (480/60/180 = TimeManager.gd:15–17), `NIGHT` (all spawn/wave/thorn/makeshift values = NightEncounterManager.gd:10–23 + session), `NPC`/`POP` (= NPCBuilderAgent.gd:21–36, NPCPopulationManager.gd:7–15), `WORLD` (= WorldConstants.gd), `SHIPWRECK`/`PORTAL`/`SHRINE_OFFERING`/`FLARE`/`LIGHT_RISK` (= ForgottenShoreSession.gd:15–19, 866–888, 459–486), `START_BALANCES` {2,2,1} (= ForgottenShoreSession.gd:23). All **CONFIRMED PASS**.

### 5.2 Loading architecture difference

Godot loads the JSONs at runtime with per-field validation and fallbacks (`BuildingManager.apply_data_configs` 121–153 + `_apply_json_config_to_plot` 176–196 + `_apply_config_extras` 199–220, `ResourceNodeManager.load_from_data`, `HearthSystem.get_validated_tiers`, `EraProgressionManager.load_from_data`, `NightEncounterManager.load_archetypes_from_data`). Web embeds the same values as compile-time constants in `data.ts`; **no runtime JSON is read by the web engine**. **INTENTIONAL DIFFERENCE** (platform data embedding). Consequence: editing the Godot JSONs changes Godot balance but not the web port — acceptable for a port snapshot, but any future balance change must be mirrored manually.

### 5.3 Duplicated / dead values in web

- `STONE_WALL_UPGRADE_COST` / `STONE_WALL_MAX_DURABILITY` (data.ts:131–136) duplicate the `PLOT_SEEDS` upgrade values. Used only as fallbacks in `requestUpgradeWall` (engine.ts:695–696) — mirrors Godot's own constants-as-fallback pattern (BuildingManager.gd:30, 47–51, 476–477). Equivalent pattern, no divergence today.
- `Plot.costLabel` seed field is **present but unused** in web (prompts are built from `costLabel(p.buildCost)` helper, engine.ts:1702/2833; `upgradeCostLabel` *is* used at 1709). Godot does consume `cost_label` (`get_plot_cost_label`, session line 915). Web's copy is dead weight, not a behavior gap.
- Economy cap: Godot `EconomyLedger` enforces `MAX_RESOURCE_CAP = 999999` on every add (`try_add` 58–78, `try_add_bundle` 80–121) and `set_balances_from_dict` (169–181); web `tryAdd` (engine.ts:296–300) and `tryAddBundle` (302–313) have **no cap** and `tryAddBundle` validates nothing (always commits). **CONFIRMED BUG (B8, static)** — only observable at extreme balances (e.g. after B4's Infinity acceptance), no normal-play divergence.

---

## 6. Audit 5 — Builder Auto-Chop

Godot reference: `NPCBuilderAgent._tick_idle_builder()` (scripts/npc/NPCBuilderAgent.gd:241–259). `can_chop` = resource manager + ledger present, **not** `night_mgr.night_active`, **not** `safety_override_active` — *no position gate*. The agent walks **directly** from its current position to the nearest renewable wood node, collects within `WORK_RANGE`, returns to safe idle when none available.

Web: `GameEngine.tickIdleBuilder()` (engine.ts:1148–1174), invoked from `tickAgents()` (1049–1094) when no plot task is claimed.

### 6.1 Findings

| Test | Result | Classification |
|---|---|---|
| Distant renewable wood node (timber_pile_west, x=-110; builder starts at camp x=-220) | **Builder never reaches the node.** It walks toward the safe zone, then deadlocks oscillating at the `WORK_RANGE` (28 px) boundary of x=0 | **CONFIRMED BUG** (runtime, repro R1) |
| Movement across multiple update ticks | `targetX` ping-pongs `0 ↔ -110`; `x` oscillates `-27.3 ↔ -29.3`; state pinned `MOVING_TO_TASK` | **CONFIRMED BUG** |
| Collection after reaching the node | Never happens: wood remained **2** for the entire multi-day session | **CONFIRMED BUG** |
| Night begins | Builder correctly returns to safe zone (`x=0.0`, `IDLE`) and does not chop at night; verified at real 20× clock through dusk→night→sunrise | **CONFIRMED PASS** |
| Resource node exhausted | Not runtime-reachable (blocked by the deadlock). Static: after collection `findNearestAvailable` returns null → `moveAgentToSafeIdle` (engine.ts:1153–1173) — mirrors Godot's empty-node → `_move_to_safe_idle` fallback | **NOT VERIFIED** (static analysis indicates equivalent) |
| Another agent claims the node | Nodes are claim-free in **both** implementations (no claim mechanism on resource nodes; first collector wins, other agent re-evaluates next tick). Runtime not testable while the deadlock exists | **NOT VERIFIED** (static analysis indicates equivalent) |

### 6.2 Root cause

engine.ts:1148–1152:

```ts
const canChop =
  !this.nightActive &&
  this.phase === "daylight" &&
  Math.abs(a.x - NPC.SAFE_ZONE_X) <= NPC.WORK_RANGE;   // ← safe-zone gate, not in Godot
```

When the gate passes, the builder starts walking toward the node (outside the safe zone); the next tick the gate fails and `moveAgentToSafeIdle()` pulls it back — a permanent limit-cycle at the gate boundary. The only renewable wood node (x=-110) is 82 px beyond the boundary, so **auto-chop can never complete anywhere on the map**. Godot's `can_chop` (NPCBuilderAgent.gd:242) contains no position term; dusk/night behavior is handled by `safety_override_active`, which the web already models separately (night branch in `tickAgents`, engine.ts:1022–1037, verified working).

The earlier v1.4.3 claim that auto-chop was verified is therefore **not reproducible** on `3f6156b`.

---

## 7. Audit 6 — Automated Testing

### 7.1 Web repo state (static inspection, `3f6156b`)

- `package.json` scripts: `dev`, `build`, `start`, `lint`, `db:*` only. **No `test` script.**
- `devDependencies`: eslint, tailwind, types tooling — **no vitest / jest / playwright / cypress**.
- No `*.test.*` / `*.spec.*` files anywhere in `src/`; `tests/` contains only unrelated shell scripts.
- `.github/workflows` — none (no CI on the web repo at all; Godot's CI is in the original repo).
- What exists instead: ESLint, a dev-only read-only instrumentation hook `window.__crownfall` (crownfall-game.tsx:96–166), and manual agent-browser E2E with screenshot evidence (`e2e-evidence/`, `E2E_VERIFICATION.md`).

Per the audit's rule, none of these count as automated gameplay regression tests.

### 7.2 Coverage matrix

| Area | Automated test? |
|---|---|
| Save/load round-trip | none |
| Backup recovery matrix (6 cases) | none |
| Save payload validation (semantically invalid inputs) | none |
| Builder auto-chop | none |
| Encounter restoration | none |
| Configuration parity (data.ts vs canonical JSON) | none |
| Economy & building operations | none |

**Classification: CONFIRMED BUG (coverage gap)** — B1/B2/B3/B4 would all have been caught by minimal suites.

### 7.3 Recommended minimal maintainable setup

1. **Vitest** (zero-config with Vite-based Next.js, jsdom not even required) targeting `src/lib/game/engine.ts`, which is framework-free: `localStorage` stubbed with a 10-line Map shim, `EngineHooks` stubbed with recorders, `window` guarded (`typeof window !== "undefined"` already in `refreshHasSave`).
2. Suites (all deterministic, no browser):
   - `save-load.test.ts`: build payload → save → mutate → load (round-trip); the 6 backup-matrix cases; validation-rejection table (Infinity, NaN-via-strings, PLACEHOLDER+durability, duplicate ids, bad archetype, missing schema_version) — currently documents *buggy* behavior; flip assertions when B2/B4 are fixed.
   - `auto-chop.test.ts`: fake timers / fixed `dt` loop; recruit builder at camp; assert node reached and wood +5 within N ticks (currently fails — encodes B1).
   - `config-parity.test.ts`: snapshot-compare `data.ts` values against JSON fixtures copied from the Godot repo (`data/*.json` checked into web `tests/fixtures/`), plus a drift alarm if Godot files change.
   - `economy.test.ts`: spend/add atomicity, cap enforcement (currently documents B8).
   - `encounter.test.ts`: wave schedule/archetypes by day, midnight-save payload rejection (currently documents B7/B4).
3. One GitHub Actions workflow on the web repo: `bun install && bun run lint && vitest run` — restores CI visibility (Godot repo already runs 4 headless suites via `tests/run_all.sh`).

---

## 8. Reproduction Steps for Confirmed Bugs

All repros executed on `3f6156b`, dev server, Chromium. `__crownfall.read()` is the dev instrumentation hook.

### R1 — Builder auto-chop deadlock (B1)
1. Clear storage, reload, click **New Reign**.
2. Walk/teleport player near the Vagrant Camp (`playerX ≈ -200`) and recruit (gold 2 → 0).
3. Observe builder over ~10 s: `targetX` alternates `0 ↔ -110`, `x` oscillates `-27.3 ↔ -29.3`, state stays `MOVING_TO_TASK`.
4. Wood stays at starting value (2) through day 1 → night → day 2 (verified across a full 20× clock day cycle).
Evidence: `e2e-evidence/audit-5-autochop-deadlock.png`; console dumps quoted in §6.1.

### R2 — No backup fallback on schema-invalid primary (B2)
1. Produce two valid saves via [K] (primary gold=6, backup gold=5).
2. Overwrite primary with `JSON.stringify({...goodSave, npcs: undefined, resources: {gold: 999, wood: 0, stone: 0}})` — parses fine, fails `applySavePayload` (npcs missing).
3. Esc → **Load Last Save** → toast "Load failed — save may be corrupted."; valid backup untouched and unread; live state preserved (gold still 6).
4. Godot contrast: `SaveManager.gd load_state()` (100–132) falls back to `.bak` on validation failure and self-heals the primary.

### R3 — Continue enabled for invalid saves, silent fresh reign (B3)
1. `localStorage.setItem('crownfall_save_slot_0','GARBAGE')` and same for `_bak`.
2. Reload → title shows **"Continue Reign"** (enabled), not "No Save Found".
3. Click it → toast "No usable save found — starting a fresh reign." → new game starts automatically.
4. Godot contrast: `Main.gd refresh_continue_state()` keeps the button disabled unless `has_valid_save()` passes.

### R4 — Semantically invalid payload accepted (B4)
1. Two valid [K] saves as in R2. Overwrite primary with raw text containing literal `1e999` (note: `JSON.stringify(Infinity)` yields `null`, so patch the raw string): `day_count: 1e999`, `resources.gold: 1e999`, `night_encounter.enemy_x: 1e999` + `enemy_active: true`, and set `buildings[0].state='PLACEHOLDER'` with `durability: 100` (≤ max_durability 150 so the numeric range check passes).
2. Esc → **Load Last Save** → toast "Loaded saved kingdom state from browser storage (slot 0)" — the load **succeeds**.
3. `__crownfall.read()` → `day: Infinity`, `gold: Infinity`, `plots[0] = {state: "PLACEHOLDER", durability: 100}`.
4. Godot contrast: `validate_payload` rejects at four independent points (exact-int day_count; resource bounds; building state↔durability consistency; finite encounter fields).

### R5 — Backup clobbering (B5, static — code inspection)
Path: `engine.ts saveGame()` 2511–2522. Precondition: primary corrupt + backup valid (reachable after R2/R4). Next [K] save copies the corrupt primary into `_bak`, destroying the last good copy; if the primary write then fails (quota), both slots are corrupt. Godot aborts safely (`SaveManager.gd:71–86`). Not runtime-executed (quota failure not triggerable in-session) — classified by code inspection.

---

## 9. Missing Tests (summary)

See §7.3. Minimum set before any fix lands: backup-matrix suite, validation-rejection suite, auto-chop progression test, config-parity snapshot test, plus a CI workflow. Each currently-confirmed bug should land together with a failing-first test that documents the corrected contract.

---

## 10. Prioritized Implementation Recommendations

1. **P0 — Fix B1 (auto-chop deadlock).** Remove the safe-zone term from `canChop` (engine.ts:1152) so behavior matches `NPCBuilderAgent.gd:241–259` (gate on `!nightActive` only; the existing night/dusk branch in `tickAgents` already provides safety). Add the `auto-chop.test.ts` progression test. Movement-path-only change; no balance impact.
2. **P0 — Fix B2 (backup fallback + self-heal).** In `loadGame()`, attempt the backup whenever `applySavePayload(primary)` returns false, and after a successful backup recovery rewrite the primary (mirrors `SaveManager.gd:100–132` + `_restore_from_backup_file`). No balance impact.
3. **P1 — Fix B3 (Continue gating).** Make `refreshHasSave()` validate (parse + `applySavePayload`-style schema probe without mutating — e.g. a static `validateSavePayload(data)` extracted from lines 2575–2609) instead of existence-only, mirroring `Main.gd:15–19`.
4. **P1 — Tighten validation to Godot's schema (B4).** Port `SaveManager.validate_payload` (210–361) + `is_valid_saved_building_dict` + `is_valid_saved_encounter_dict` checks into a `validateSavePayload()` used before `resetState()`. This also neutralizes the B7/B8 exploit surface for hand-crafted saves. No balance change — pure rejection of impossible states.
5. **P1 — Fix B5 (validate-before-backup-copy) in `saveGame()`**, mirroring `SaveManager.gd:71–86`.
6. **P2 — Persist + restore the six encounter sub-fields (B7)** for exact payload parity (cheap; dormant in practice today).
7. **P2 — Economy cap parity (B8):** add `MAX_RESOURCE_CAP` enforcement to `tryAdd`/`tryAddBundle`/load-restoration.
8. **P2 — Testing + CI per §7.3.**
9. **P3 — Documentation/config hygiene:** keep `data.ts` in sync when Godot JSONs change (config-parity test enforces); decide whether web `schema_version: 3` should align to 2 if cross-platform save import is ever desired; remove or wire the dead `Plot.costLabel` seed field.

---

## 11. Verification-Method Footnote

- Static conclusions cite exact files/methods/lines in both repos as listed per section.
- Runtime conclusions were executed in Chromium against `http://localhost:3000/` (dev server, `next dev`): every claimed PASS/BUG in the matrices §3.1, §6.1 and repros R1–R4 was actually executed this session; screenshot evidence `e2e-evidence/audit-5-autochop-deadlock.png`, `e2e-evidence/audit-title.png`.
- No console errors or page errors were observed in any session (`agent-browser errors` empty throughout).
- Items explicitly **not** verified at runtime: B5 (quota-failure path), auto-chop node-exhausted/claim-collision cells (blocked by B1), Godot-side runtime behavior (Godot repo inspected statically only — its CI suites are the platform's own verification).
