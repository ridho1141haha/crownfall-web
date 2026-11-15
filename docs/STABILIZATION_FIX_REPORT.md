# Crownfall Web — Phase 3 Stabilization Fix Report

**Date:** 2026-11-15
**Branch:** `fix/web-stabilization-phase-3` (based on `origin/main` @ `89d44ef`)
**Audited gameplay baseline:** `3f6156b` (unchanged — audit report `docs/STABILIZATION_AUDIT.md`)
**Godot source of truth:** `ridho1141haha/crownfall` (read-only reference; never modified)
**Scope:** bug fixes B1, B2, B3, B4, B5, B6, B8 + automated regression suite + CI. No gameplay features added, no balance changed, no resource-node positions changed, no enemy balance changed, no UI redesign, no unrelated refactoring.

---

## 1. Executive Summary

All six fixable findings from the Phase 2 audit are implemented and verified, plus the automated test infrastructure the audit identified as missing (G3):

| Bug | Audit classification | Status after Phase 3 | Verification |
|---|---|---|---|
| B1 — Builder auto-chop deadlock | CONFIRMED BUG (runtime) | **FIXED** | bun test (deterministic fixed-timestep) + browser E2E |
| B2 — No backup fallback on schema-invalid primary | CONFIRMED BUG (runtime) | **FIXED** | bun test (matrix cases 1–6) + browser E2E |
| B3 — Continue Reign existence-only gating | CONFIRMED BUG (runtime) | **FIXED** | bun test + browser E2E (disabled button) |
| B4 — Weak save validation | CONFIRMED BUG (runtime) | **FIXED** | bun test (70+ rejection/acceptance cases) |
| B5 — Backup clobbering in `saveGame()` | CONFIRMED BUG (static) | **FIXED** | bun test (incl. simulated write failure) |
| B6 — No primary self-heal after backup recovery | CONFIRMED BUG (static) | **FIXED** | bun test + browser E2E |
| B8 — Missing 999,999 economy cap | CONFIRMED BUG (static) | **FIXED** | bun test (cap + bundle atomicity) |
| B7 — Six encounter sub-fields not persisted | MISSING PERSISTENCE | **DEFERRED** (see §9) | not implemented, per audit low practical impact |
| G3 — No automated tests / CI | CONFIRMED BUG (coverage gap) | **FIXED** | `bun test` suite (112 tests) + GitHub Actions workflow |

---

## 2. Bugs Fixed

### B1 — Builder Auto-Chop Deadlock (P0)

**Root cause.** `GameEngine.tickIdleBuilder()` (formerly `src/lib/game/engine.ts:1148–1152`) gated auto-chop on `Math.abs(a.x - NPC.SAFE_ZONE_X) <= NPC.WORK_RANGE`. Godot's `NPCBuilderAgent._tick_idle_builder()` (`scripts/npc/NPCBuilderAgent.gd:241–259`) has **no position term**: `can_chop = resource_mgr != null and ledger != null and night_mgr != null and not night_mgr.night_active and not safety_override_active`. The extra gate made the builder oscillate at the safe-zone boundary (`targetX` ping-pong `0 ↔ -110`) because the only renewable wood node (`timber_pile_west`, x=-110) lies 82 px beyond the boundary — auto-chop could never complete anywhere on the map.

**Fix.** `canChop = !this.nightActive && this.phase === "daylight"`. The two retained terms map exactly to Godot's `not night_mgr.night_active` and `not safety_override_active` (web models dusk/night safety via `phase !== "daylight"` and the safety-override branch in `tickAgents`, which already pulls builders home — verified in the audit).

**Preserved (unchanged):** daylight-only gathering; night/dusk return-to-safety; resource collection rules (`findNearestAvailable` renewable-only + `tryCollectNode` range/cap checks); movement speed (`NPC.MOVE_SPEED` 130) and work range (`NPC.WORK_RANGE` 28); return-to-safe-idle when no node is available; economy balance and node placement (`data.ts` untouched).

### B2 — Backup Fallback on Schema-Invalid Primary + B6 — Self-Heal (P0)

**Root cause.** `loadGame()` only fell back to the backup when the primary was *missing* or *failed JSON.parse*. A primary that parsed but failed `applySavePayload` validation returned `false` immediately without consulting the backup — diverging from `SaveManager.gd load_state()` (`scripts/save/SaveManager.gd:100–132`), which falls back on **any** `_read_and_validate_file` failure (missing/empty/malformed/schema-invalid) and then self-heals the primary from the verified backup (`_restore_from_backup_file`, 415–423).

**Fix.** `loadGame()` rewritten:
1. Read + parse + validate the primary (`readValidSaveCandidate`).
2. On any failure (missing / malformed JSON / schema-invalid) read + parse + validate the backup **independently**.
3. Apply only a valid candidate (`applySavePayload` re-validates before any mutation).
4. On backup recovery, emit the recovery message and **self-heal the primary** by rewriting it with the verified backup payload (best-effort: a failed heal write — e.g. quota — is swallowed and never invalidates the successful load).
5. Both-invalid ⇒ `return false` with **zero mutation** of live state.

### B3 — Continue Reign Validation (P1)

**Root cause.** `refreshHasSave()` enabled Continue whenever either storage key merely *existed* (`localStorage.getItem(...) ?? ...`). Godot's `Main.gd refresh_continue_state()` (`scripts/core/Main.gd:15–19`) enables Continue only when `SaveManager.has_valid_save()` passes (full parse + migrate + validate). Result: two invalid saves produced an enabled button whose click silently started a fresh reign.

**Fix (engine + UI):**
- `refreshHasSave()` now sets `hasSaveCache = hasAnyValidSave()` — true iff at least one slot parses **and** passes `validateSavePayload()`. Pure: no storage writes, no game-state mutation.
- `continueGame()` in `src/components/game/crownfall-game.tsx` revalidates at the moment of choice (`eng.refreshHasSave()`); if no valid save exists it toasts "No valid save found — start a New Reign instead." and **stays on the title screen** — the silent `startNew()` fallback is removed. The load-failure path (unreachable while the gate holds) also fails safe without auto-starting.

### B4 — Strengthened Save Validation (P1)

**Root cause.** `applySavePayload()` validated a small subset of fields with loose `typeof`/`Number()` coercions: `Infinity` day/gold, `PLACEHOLDER` with `durability: 100`, unvalidated `night_encounter`, no duplicate-ID checks, no exact-integer checks, no world/island ids — all accepted what Godot's `SaveManager.validate_payload()` (210–361) plus per-manager validators reject.

**Fix.** New pure module **`src/lib/game/save-validation.ts`** (no state, no storage, no side effects):
- `validateSavePayload()` — port of `SaveManager.validate_payload` for the Web schema: required top-level keys; exact-int `schema_version` in **1..3**; non-empty `world_id`/`island_id`; exact-int `day_count ≥ 1`; finite `world_time ≥ 0`; phase enum; resources as exact ints in `[0, 999999]`; buildings non-empty with per-plot type whitelist, finite in-bounds positions and Godot's state↔durability & type↔level consistency rules; NPCs non-empty, `≤ MAX_POPULATION`, role/state whitelists, finite in-bounds positions, `farm_timer` in `[0, FARMER_HARVEST_SEC]`; full encounter validation (required 8 fields, wave/hp caps, active⇒hp>0, archetype whitelist, finite positions/timers, trampled-plot whitelist, west-scout rules, `current_day_number ≤ day_count`); player position/facing; progression flags (hearth 1..3, reign enum, shipwreck 0..3, bool-only node_states, tree_states id+range check, era whitelist, hearth_boost ≤ 60); camp vagrants range.
- `isValidSavedBuildingDict()` — port of `BuildingManager.is_valid_saved_building_dict` (731–767), incl. `REINFORCED_MAX_DURABILITY` 150 fallback semantics.
- `isValidSavedNpcDict()` — port of `NPCBuilderAgent.is_valid_saved_npc_dict` (332–358).
- `isValidSavedEncounterDict()` — port of `NightEncounterManager.is_valid_saved_encounter_dict` (422–501); the six mid-combat sub-fields stay **optional** (web payload omits them — B7 deferral).
- `isValidSavedTreeStates()` — port of `ForestTreeManager.is_valid_saved_tree_states` (103–119).
- `isExactIntValue()` — port of `EconomyLedger.is_exact_int_value` (finite + integral).
- `parseSaveJson()` — defensive parse; rejects malformed JSON and non-object roots without throwing.

`applySavePayload()` now gates all mutation on `validateSavePayload(data)` (validation precedes `resetState()`), replacing the old hand-rolled block.

**Schema decision (intentional platform difference preserved).** Web writes `schema_version: 3`; Godot writes 2. Per instructions the version was **not** changed; the validator accepts exact ints 1..3, which keeps every legitimate web save (all v3) valid and mirrors Godot's MIN..MAX range pattern without cross-platform import. Verified: `saveGame()` of a real engine state passes the validator (tested), and the round-trip test asserts `schema_version === 3` survives.

### B5 — Backup Protection During Saving (P1)

**Root cause.** `saveGame()` copied the existing primary text into the backup slot **without validating it** — a corrupt primary would overwrite the last good backup on the next save; combined with a failed primary write, both slots could be lost. Godot stages the backup only after `_read_and_validate_file(save_path)` succeeds (`SaveManager.gd:71–86`) and aborts the save on staging failure.

**Fix.** `saveGame()`:
1. Builds the payload and **validates it before any write** (mirrors Godot's pre-write validation).
2. Stages the backup **only if the existing primary parses and validates**; when the primary is invalid the existing backup is left untouched.
3. Writes backup-first, primary-last; any `localStorage` failure aborts with `return false` leaving the previous known-good pair intact.

### B8 — Economy Cap Parity (P2)

**Root cause.** `tryAdd()` had no cap and accepted `0`/`-0` amounts; `tryAddBundle()` validated nothing and always committed. Godot's `EconomyLedger.try_add` (58–78) / `try_add_bundle` (80–121) enforce exact-int positive amounts and `MAX_RESOURCE_CAP = 999999` per resource, rejecting atomically.

**Fix.** `tryAdd()`: exact-int + positive + cap check before commit. `tryAddBundle()`: empty bundle rejected; every entry validated (exact-int, positive, aggregate cap per resource) into a staged map; commit happens only after all entries pass — invalid bundles change nothing. Normal gameplay amounts (3–5 node yields, 2-gold farmer/kill rewards, portal +3G+2S) are unaffected; spend side (`trySpend`) untouched.

---

## 3. Files Changed

| File | Change |
|---|---|
| `src/lib/game/save-validation.ts` | **NEW** — pure validation module (B4) + `MAX_RESOURCE_CAP` + `isExactIntValue` + `parseSaveJson` |
| `src/lib/game/engine.ts` | B1 (`tickIdleBuilder`), B2/B6 (`loadGame` rewrite + `readValidSaveCandidate`/`hasAnyValidSave`/`readStorage` helpers), B3 (`refreshHasSave`), B4 (`applySavePayload` validation gate), B5 (`saveGame`), B8 (`tryAdd`/`tryAddBundle`) |
| `src/components/game/crownfall-game.tsx` | B3 — `continueGame()` revalidation + no silent fresh reign |
| `tests/game/helpers.ts` | **NEW** — browser-free harness: MemoryStorage shim, hooks recorder, fixed-timestep stepper, mid-game state seeder, canonical valid-payload factory |
| `tests/game/auto-chop.test.ts` | **NEW** — B1 regression (6 deterministic tests) |
| `tests/game/save-load.test.ts` | **NEW** — backup matrix (6 cases + no-save), B5 protection (3), B3 gating (5), round-trip (6) |
| `tests/game/save-validation.test.ts` | **NEW** — B4 rejection/acceptance table (~50 tests) |
| `tests/game/economy.test.ts` | **NEW** — B8 cap/atomicity (15 tests) |
| `package.json` | added `"test": "bun test"` (only change) |
| `.github/workflows/ci.yml` | **NEW** — Bun install → ESLint → `bun test tests/game/` → production build |
| `e2e-evidence/phase3-*.png` | **NEW** — 5 browser E2E screenshots |
| `docs/STABILIZATION_FIX_REPORT.md` | **NEW** — this report |

**Not touched:** `src/lib/game/data.ts` (all balance/config identical — verified via `git diff --stat`), renderer, audio, all other components, the Godot repository.

---

## 4. Design Decisions

1. **Pure validator module, not a class method.** `validateSavePayload()` must be callable from `refreshHasSave()` (Continue gating) without mutating engine state, and from tests without constructing an engine. Godot reaches the same property via static per-manager validators; a free-function module is the TS equivalent.
2. **`schema_version` stays 3; validator accepts 1..3.** Explicitly instructed to treat the version difference as an existing platform-specific difference. Range acceptance mirrors Godot's `MIN_SCHEMA_VERSION..SCHEMA_VERSION` posture; v1/v2 never existed in web saves (verified via `git log -S SAVE_SCHEMA_VERSION` — v3 since `dbe6d77`), so nothing legitimate is rejected.
3. **Validation is the single gate; restore keeps its defensive clamps.** The restore code below `resetState()` keeps its guarded coercions/clamps (all unreachable failure paths). Removing them would be refactoring; keeping them costs nothing and matches Godot's clamp-on-apply behavior.
4. **`refreshHasSave()` does not self-heal.** Godot's `has_valid_save()` → `load_state()` incidentally repairs the primary during the check; the web check stays pure (writes happen only in `loadGame()`'s recovery path and `saveGame()`). Player-visible behavior (button state) is identical; storage mutation timing differs and is documented in §9.
5. **Self-heal writes the verified payload, best-effort.** Godot rewrites the primary from backup text via tmp-file + atomic rename; localStorage has no atomic rename, so the heal is a single `setItem` of the validated payload, wrapped in try/catch per the "failed heal must not invalidate the load" requirement.
6. **Backup staging order: backup-first, primary-last.** Mirrors Godot's stage-then-commit order as closely as localStorage allows; verified with a simulated primary-write failure.
7. **Bun's built-in test runner.** The project already uses Bun (`bun.lock`, `bun-types`); zero new dev dependencies, zero config. Vitest would have required Vite config work for no benefit; Playwright is unnecessary because `engine.ts` is framework-free.
8. **Tests assert observable behavior.** Tests drive public API (`update(dt)`, `saveGame`, `loadGame`, `refreshHasSave`, `tryAdd`, interactions) and public state fields; the valid-payload baseline is *produced by a real engine run*, not hand-written, so the suite cannot silently overfit to implementation details.

---

## 5. Automated Tests Added

Suite: `bun test` (Bun's built-in runner). 4 files, **112 tests, 384 assertions**, all deterministic (fixed time steps, Map-backed storage, recorded hooks — no randomness, no timers, no network).

Coverage mapped to the 13 required areas:

| # | Required area | Tests |
|---|---|---|
| 1 | Builder auto-chop progression | `auto-chop.test.ts` — reach + collect distant renewable node (wood 2→7), multi-tick movement with `targetX` tracking, return-to-safe-idle after collection, next-day re-chop after sunrise refresh, night safety (no chop, retreat home), dusk override mid-approach |
| 2 | Save/load round-trip | `save-load.test.ts` — full state (balances, day/phase/time, player, hearth, shipwreck, portal, era, vagrants, agent, node/tree states, plot states) survives save → diverge → load; payload equality before/after |
| 3 | Primary missing + valid backup | matrix case 1 — backup loaded, live state replaced, primary self-healed |
| 4 | Primary malformed + valid backup | matrix case 2 |
| 5 | Primary schema-invalid + valid backup | matrix case 3 (the B2 repro: `npcs: []`) + case 4 (PLACEHOLDER/durability 100) |
| 6 | Both saves invalid | matrix case 5 + no-save case — `loadGame()` false, every mutable field unchanged |
| 7 | Backup self-healing | cases 1/2/3 assert healed primary parses + validates + carries backup data |
| 8 | Backup preservation when primary corrupt | `saveGame()` with corrupt primary leaves backup byte-identical; invalid new payload writes nothing; simulated primary-write failure keeps a valid save in storage |
| 9 | Continue Reign validation | hasSave false/true combinations, purity (no storage/game mutation), invalid-primary + valid-backup counts |
| 10 | Non-finite & fractional rejection | Infinity day/gold/encounter-x (incl. raw `1e999` JSON route), NaN wood/timer, fractional day/resource/level/durability |
| 11 | Invalid building states & duplicate IDs | PLACEHOLDER/DESTROYED≠0, COMPLETED/DAMAGED=0, dur>max, level/type consistency, per-plot type whitelist, unknown/duplicate plot ids, duplicate npc ids, population cap, farm_timer range |
| 12 | Invalid encounter payloads | 8 required fields, wave/hp caps, active⇒hp>0, archetype, timers, trampled whitelist, west rules, `current_day_number` |
| 13 | Economy cap & bundle atomicity | cap reject/boundary per resource, cap-exceeding bundle commits nothing, invalid-entry bundle commits nothing, empty bundle, aggregate cap, normal-play adds unaffected |

Regression philosophy: the B1/B2/B3/B4/B5 behaviors correspond one-to-one to audit repros R1–R5; each corrected contract is asserted positively (not by asserting internal call graphs).

---

## 6. Commands Executed & Results

All commands actually executed in this session, from `/home/z/my-project`:

| Command | Result |
|---|---|
| `bun test tests/game/` (first run, pre-fix-expectation fixes) | 107 pass / 5 fail — all 5 failures were incorrect *test expectations* (backup slot semantics, missing second save in fixtures, re-chop timing), engine behavior correct; fixed and re-run |
| `bun test tests/game/` (final) | **112 pass, 0 fail, 384 expect() calls, 4 files** (exit 0) |
| `bun test` (project-wide) | **112 pass, 0 fail** — confirms no other test files interfere |
| `bun run lint` | clean — **no errors, no warnings** (exit 0) |
| `bunx tsc --noEmit` | 14 errors, **all pre-existing** on untouched code (`renderer.ts`, `data.ts` const-literal typing, `examples/`, `skills/`; project sets `typescript.ignoreBuildErrors: true`). **Zero errors in new/modified code.** |
| `bun run build` (dev server stopped first; `.next` cleared) | **✓ Compiled successfully in 15.9s** — Next.js 16.1.3 (Turbopack), routes `/`, `/_not-found`, `/api`; static pages 4/4. Build is secrets-free → included in CI. |
| `bun run dev` (restart after build) | Ready in 902ms; `GET / 200` |
| Browser E2E (agent-browser, Chromium, dev server) | 5/5 scenarios pass (§7); **`agent-browser errors` empty; console clean** (only framework noise filtered: React DevTools banner) |

---

## 7. Browser E2E Results

Executed against `http://localhost:3000/` (dev server) with the read-only `window.__crownfall` dev hook; screenshots in `e2e-evidence/`:

| Scenario | Steps executed | Result |
|---|---|---|
| Builder actually collecting wood | New Reign → teleport player to camp (playerX=-220) → [R] recruit (gold 2→0) → wait ~5 s real time | **PASS** — wood 2→**7**, `timber_pile_west` in `nodesCollected`, builder walked to the node then returned to safe idle (x=-27, IDLE). Evidence: `phase3-b1-autochop-collecting.png` |
| Invalid primary recovering from valid backup | Two saves (primary gold=55, backup gold=33) → overwrite primary with valid-JSON/invalid-schema (`npcs: []`) → diverge live gold=999 → `loadGame()` | **PASS** — load ok, gold restored to **33**, primary **self-healed** (gold 33, npcs restored, validates). Evidence: `phase3-b2-backup-recovery.png` |
| Continue disabled when both saves are invalid | Both slots set to `GARBAGE` → reload → title screen | **PASS** — button renders **"No Save Found"** with `disabled: true` (pre-fix it showed enabled "Continue Reign"). Evidence: `phase3-b3-continue-disabled.png` |
| Valid save round-trip | Seed gold=42/wood=13/stone=6/day=2/playerX=234.5 → [K] save → diverge (gold=1, day=1) → Esc → Load Last Save | **PASS** — restored exactly gold=42, wood=13, stone=6, day=2, playerX=234.5. Evidence: `phase3-roundtrip-loaded.png` |
| Live state unchanged after rejected loads | Both slots garbage → pause menu → Load Last Save | **PASS** — toast "Load failed — save may be corrupted."; gold/wood/day/phase/playerX/recruited all unchanged (before === after). Evidence: `phase3-final-state.png` |
| Console & runtime errors | `agent-browser errors` + console review after all scenarios | **PASS** — zero page errors, zero console errors |
| B5 staging spot-check (in-browser) | Valid primary → `saveGame()` → backup == previous primary text; corrupt primary → `saveGame()` → backup untouched | **PASS** (also covered by unit tests) |

Not browser-verified (covered deterministically by unit tests instead): night-cycle re-chop timing, quota-failure paths, autosave-at-sunrise.

---

## 8. Known Limitations & Deferred Findings

1. **B7 — encounter sub-state persistence (DEFERRED, not implemented).** `attack_timer`, `light_burn_acc`, `west_attack_timer`, `west_burn_acc`, `east_trampled`, `west_trampled` are still not written to the web payload. Per the audit (§4.3) this is dormant: manual saves are night-locked and the only autosave fires at sunrise, so legitimate saves always carry these as zeros. The validator accepts them as optional fields (Godot parity), so a future payload extension needs no schema change. Implementing it now would have required touching `buildSavePayload`/restore mid-combat semantics — deliberately out of scope per "keep changes focused".
2. **`refreshHasSave()` purity vs Godot.** Godot's continue-state check can incidentally repair a corrupt primary (its `load_state` self-heals during validation). Web's check is pure; healing happens on actual load. No player-visible difference.
3. **localStorage has no atomic rename.** Godot's tmp-file + `.old` rollback dance is approximated by validate-before-write + backup-first ordering. The quota-failure test proves the practical invariant (a valid save always survives).
4. **Cross-platform saves remain mutually rejected.** Web v3 payloads fail Godot's v2-capped validator and vice versa — unchanged intentional difference, documented in the audit.
5. **Pre-existing TypeScript strictness errors** in `renderer.ts`/`engine.ts` const-literal typing (14) are untouched — the project builds with `ignoreBuildErrors: true`; fixing them is unrelated refactoring.
6. **CI build step** was verified locally (compiles clean, no secrets needed) and included; first CI run on GitHub has not been observed yet (branch push triggers it — see below).

---

## 9. Verification Status Summary

| Check | Command | Status |
|---|---|---|
| Automated gameplay tests | `bun test` | **112 pass / 0 fail** (executed) |
| ESLint | `bun run lint` | **clean** (executed) |
| Production build | `bun run build` | **success** (executed) |
| Browser E2E | agent-browser, 5 scenarios | **5/5 pass, 0 console errors** (executed) |
| Git diff hygiene | `git diff` / `git status` review | only intended files; `data.ts` untouched |
| Balance/feature change check | manual diff review | none — all constants/config identical |
