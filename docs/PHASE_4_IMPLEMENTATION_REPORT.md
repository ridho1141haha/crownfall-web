# Crownfall Web — Phase 4 Implementation Report

**Date:** 2026-11-15
**Branch:** `fix/phase-4-parity-completion`
**Starting commit:** `f267d25` (Merge PR #1 — Web main with Phase 3 + Phase 3.1 stabilization fixes; verified against origin before work began)
**Godot source of truth:** `ridho1141haha/crownfall` @ `2c61632de046da04b0f291761574b6d900d4037d` (read-only reference; never modified; full history fetched for schema archaeology)
**Scope:** three confirmed P2 fixes (P2-A, P2-B, P2-C), remaining Phase 4 parity findings (P4-A, P4-B, P4-C, P4-D), full iterative CODE → REVIEW → DEBUG → REVIEW loop, browser E2E, CI integration. No gameplay balance changed, no `data.ts` values changed, no resource positions changed, no enemy values changed, Godot repo untouched, `main` untouched.

---

## 1. Executive Summary

All seven Phase 4 findings are implemented and verified. The suite grew from 151 tests / 516 assertions (Phase 3.1 baseline) to **201 tests / 791 assertions, 8 files, all passing**. ESLint exits clean. The production build compiles. Every required browser scenario passed in real Chromium via agent-browser, including the two highest-risk ones: a hand-injected Godot-schema-v2 save migrating through the real Continue-Reign flow, and the portal reward transaction failing at the 999,999 cap and recovering on retry.

Two complete review cycles ran; five review findings were found and fixed (Section 6). The final independent review found no unresolved P0/P1/P2 issues.

| Finding | Status | Verification |
|---|---|---|
| P2-A — portal marked looted on failed reward | **FIXED** | bun tests (6) + browser E2E (cap-fail → retry → duplicate-guard) |
| P2-B — schema v1/v2 accepted without migration | **FIXED** | bun tests (19) + browser E2E (real Godot v2 save → Continue Reign) |
| P2-C — resource additions accept unknown IDs | **FIXED** | bun tests (13) + browser E2E (no property minted, atomic bundles) |
| P4-A — six night-encounter fields not persisted (B7) | **FIXED** | bun tests (9) + browser E2E round-trip |
| P4-B — schema compatibility contract implicit | **DONE** | explicit contract in `save-migration.ts` + validator gate + tests |
| P4-C — config parity manual-only | **DONE** | `config-parity.test.ts` vs REAL Godot data in CI + fixtures locally |
| P4-D — settings parity (volume/fullscreen) | **DONE** | volume + fullscreen + mute implemented, persisted, browser-verified; audio genuinely exists (WebAudio SFX) |

---

## 2. Repository and baseline verification (performed first)

- `git fetch origin`: `origin/main` = `f267d252318235a64c22079e20ddf39b7c469029` (matches the stated baseline; PR #1 merge confirmed).
- Local `main` carried one sandbox-artifact commit (`64e2f7f`, touching only the runtime PID file `.zscripts/dev.pid`). The Phase 4 branch was created from the **remote** baseline `f267d25` to avoid dragging sandbox noise into history. The PID file change was left uncommitted in the working tree (sandbox runtime artifact, not user work).
- No pre-existing `fix/phase-4-parity-completion` branch existed (remote and local checked).
- Godot repo cloned with full history; schema evolution verified directly from commits (Section 4, P2-B).

---

## 3. P2-A — Portal reward transaction

**Root cause.** Web `GameEngine.lootPortal()` called `this.tryAddBundle(PORTAL.REWARD)` **without using its result** and then set `portalLooted = true` unconditionally. When the bundle was rejected (a balance at the 999,999 cap), the reward was lost forever while the portal still showed as scavenged. Godot (`ForgottenShoreSession.gd _on_player_loot_portal_relic`) sets `portal_relic_looted = true` **only inside the success branch** of `economy.try_add_bundle(...)` and returns false otherwise.

**Fix** (`src/lib/game/engine.ts`): `lootPortal()` returns `{ ok: false, reason: "Relic reward rejected — not enough storage capacity" }` when `tryAddBundle` fails; `portalLooted`, sfx, float text and the success message are set only after the transaction commits. `tryAddBundle` is already atomic (Phase 3), so a failed transaction changes no balance.

**State-transition verification (not just the return value):** tests assert, for every failure case, that `portalLooted` stays false, both balances are unchanged (including the gold side of a partially-fitting bundle — atomicity), sfx is not played, a retry after freeing space succeeds and grants exactly +3G/+2S, and a second collection after success is rejected with balances untouched — including after a save/load round-trip.

**Tests** (`tests/game/phase4-regressions.test.ts`): normal success; gold at cap; stone at cap; partial capacity (gold fits, stone does not → nothing commits); failed → retry success; repeat after success (incl. post-save/load) cannot duplicate.

**Browser E2E:** portal loot at x=1350 → gold 2→5, stone 1→3, `portalLooted=true`; fresh reign with `stone=999999` → `{ok:false}`, not looted, gold unchanged; `stone=999996` → retry `{ok:true}`; further attempts rejected as already-scavenged.

---

## 4. P2-B — Explicit legacy save migration (schema v1/v2)

**Root cause.** `validateSavePayload()` accepted `schema_version` 1..3 (Phase 2/3 posture mirroring Godot's MIN..MAX range), but nothing ever migrated a legacy payload — acceptance did not imply the payload was in current-schema shape. The web load path validated raw storage payloads directly.

**Verified historical facts (from both repos' actual sources — not assumed):**
1. **Web schema v1 and v2 never existed.** `git log -S SAVE_SCHEMA_VERSION` shows the constant introduced at `dbe6d77` already as `3`, and every commit since writes `schema_version: 3`. The web has exactly one schema generation.
2. **Godot schema v1 was real** (commit `3e6e6e8`): payload had NO `player`, NO `night_encounter`, NO `camp_vagrants_available`; `progression_flags` held only `first_night_survived` + `collected_nodes` (an id array); buildings had no `level`/`type`.
3. **Godot v2 is current** (`SCHEMA_VERSION = 2`): full structure including `night_encounter`.
4. Godot's load path is `validate_payload(migrate_payload(parsed))` — **migration BEFORE validation** (`_read_and_validate_file`). Its `migrate_payload()` (current commit `2c61632`) handles: numeric `reign_state` normalization (1→BREACH_PENALTY, 2→ISLAND_CLEARED, else ACTIVE), `collected_nodes` → `node_states` map, defaults for `player`/`hearth_level`/`shipwreck_stage`/`portal_relic_looted`, building `level`/`type` defaults, plus two cross-version backfills (`night_encounter.current_day_number` from `day_count`; `era_id` inferred from buildings — stone_age iff any stone_wall, iron_age never inferred).
5. **Godot never synthesizes `night_encounter` for v1 payloads**, and its validator requires that key — so Godot's own accept/reject outcome for a realistic v1 save today is *migrate → reject*.

**Fix.**
- New pure module **`src/lib/game/save-migration.ts`** — `migrateSavePayload(data)`: deep-clones (Godot `duplicate(true)` parity), rejects non-objects and missing/invalid schema versions explicitly with reasons, stamps v1 payloads through the exact Godot transform set, runs the cross-version backfills for every version (Godot runs them for every version), stamps the result to web schema 3, and returns `{ ok, data | reason }`. Fields whose historical meaning is NOT verified (e.g. a fabricated encounter dict for v1) are never invented.
- **`validateSavePayload()` now accepts ONLY the current web schema (3)** — a schema version is never accepted without the migration needed for it (the P2-B gap closed structurally). All in-repo callers migrate first (`readValidSaveCandidate`), mirroring Godot's `_read_and_validate_file`.
- `GameEngine.readValidSaveCandidate()` = parse → **migrate** → validate; used by load, backup recovery, self-heal, and Continue gating, so a legacy backup is uniformly loadable and the self-heal writes the migrated v3 payload back to the primary.
- The documented v1 outcome: all verified transforms apply (observable in the migration result) but the payload fails post-migration validation for lack of encounter data — **exactly Godot's own outcome**, never silently replaced by a fresh reign.

**Intentional schema decisions (P4-B contract, documented in the module header):**
- Web writes 3; Godot writes 2. The numbers are NOT aligned — they are different platform contracts (audit's INTENTIONAL DIFFERENCE preserved).
- Incoming v1/v2 payloads are treated as the Godot formats those version numbers verifiably belonged to (web never produced them); cross-platform import of Godot v2 saves is a *consequence* of sharing the version space, transformed field-by-field per Godot's own migration, then gated by the web validator.

**Tests** (`tests/game/save-migration.test.ts`, 19 + 3 updated in `save-validation.test.ts`): realistic Godot v1 fixture (verified structure, not a re-tagged modern payload) — all transforms asserted; v1 numeric reign_state 1/2/invalid; v1 stone_wall era inference; v1 collected_nodes edge cases; realistic v1 fails validation (Godot parity) with live state untouched; malformed v1 rejected after migration; realistic early-v2 fixture (numeric reign_state, missing era_id/current_day_number) backfilled + validated; load-path: v2 save → Continue enabled → progression/resources/nodes/buildings preserved → legacy numeric reign falls back ACTIVE (Godot String() parity); corrupt primary + v2 backup → recovery + self-heal to v3; future schema rejected by the load path; migrated reign re-saves as v3 and round-trips into a fresh engine.

**Browser E2E:** the real Godot-v2 payload injected into `crownfall_save_slot_0` → reload → "Continue Reign" enabled → load → day 4, 12G/15W/8S, hearth 2, shipwreck 1, portal looted, stone_wall/DAMAGED, node states preserved; future schema → Continue disabled, load rejected; corrupt primary + valid backup → recovery + primary healed to v3; garbage JSON → not a valid save, no fresh reign.

---

## 5. P2-C — Resource ID whitelist in additions

**Root cause.** `tryAdd()` checked amount validity but never the resource id (the `ResourceId` type is compile-time only), and `tryAddBundle()` validated amounts but not keys. A runtime caller could pass an unknown id: `tryAdd` computed `this[res] + amount` → `NaN` comparisons could pass and mint arbitrary engine properties; a bundle with one unknown key could still have committed its valid entries (Godot rejects the whole bundle).

**Fix** (`src/lib/game/engine.ts`): `VALID_RESOURCE_IDS` whitelist checked **first** in both methods (EconomyLedger `try_add`/`try_add_bundle` Phase-1 parity), before any balance math; bundle entries validated individually with all-or-nothing commit preserved (already Phase 3 behavior). All prior rejections (empty bundle, zero/negative/fractional/non-finite amounts, aggregate cap, atomicity) unchanged — existing Phase 3 economy tests still pass unmodified.

**Tests** (`tests/game/economy.test.ts`, 13 new): every valid id accepted; unknown ids rejected with no property minted; unknown id cannot dodge the cap via NaN; bundle with one unknown key commits NOTHING (valid sibling entry included); all-unknown bundle; valid multi-resource bundle commits; empty/null bundle; negative/fractional/NaN/Infinity; bundle exceeding cap → state unchanged.

**Browser E2E:** `tryAdd('mana', 5)` → false, no `mana` property; `tryAddBundle({gold:5, mana:3})` → false with gold unchanged; `tryAddBundle({mana:3})` → false.

---

## 6. P4-A — Night encounter save-state parity (audit B7)

**Root cause (as audited).** Godot `NightEncounterManager.to_save_dict()` persists six mid-combat sub-fields the web payload omitted: `attack_timer`, `light_burn_acc`, `west_attack_timer`, `west_burn_acc` (floats snapped to 0.001) and `east_trampled`, `west_trampled` (plot-id arrays). Godot's `apply_save_dict()` restores them with clamps (timers → `[0, ATTACK_INTERVAL]`, burn accumulators → `[0, 1]`) and per-side trampled filtering (east: watchtower/farm_east; west: farm_west); the web validator already accepted all six as optional fields (Phase 3), so only serialization + restoration were missing.

**Fix** (`src/lib/game/engine.ts`): `buildSavePayload()` always writes the six fields (snap-to-0.001, array copies — to_save_dict parity); `applySavePayload()` restores them with the exact Godot clamps and per-side filters; missing legacy fields default to 0 / `[]` (Godot `data.get` defaults). Note verified during review: **neither platform resets these at sunrise** — sunrise autosaves legitimately carry the finished night's dormant remainders, and both runtimes clear them at the next night start; daytime play is unaffected. Manual saves remain night-locked (restriction preserved).

**Tests** (`tests/game/phase4-regressions.test.ts`, 9): payload always contains the six fields; mid-combat state round-trips save → diverge → load (exact values); restore clamps match Godot; per-side trampled filtering; legacy saves without the fields restore to defaults; invalid types (`"soon"`, `-1`, NaN, non-array, unknown plot id) rejected with live state untouched; **no duplicate enemy attacks after restoration** (attack_timer 0.9 restored → exactly one wall hit of 15 per crossing — deterministic sim); normal non-night save still round-trips.

**Browser E2E:** all six fields seeded → manual save → diverge → load → exact restoration verified in-page.

---

## 7. P4-C — Automatic Godot↔Web configuration parity

**Root cause.** The five Godot data JSONs were mirrored into `data.ts` by hand (Phase 2 audit: all value-identical at audit time); nothing detects future divergence.

**Mechanism** (`tests/game/config-parity.test.ts` + CI):
- Field-by-field comparison of `data/buildings.json` → `PLOT_SEEDS` (+ `STONE_WALL_UPGRADE_COST`/`STONE_WALL_MAX_DURABILITY` duplicates), `enemies.json` → `ENEMY_ARCHETYPES`, `eras.json` → `ERAS`, `lighting.json` → `HEARTH_TIERS` + `WATCHTOWER_LIGHT_RADIUS`, `resource_nodes.json` → `RESOURCE_NODES`. Plots are compared **by id** (Godot's BuildingManager applies config per id; the two farms' array order differs between repos — presentation-only, documented).
- Failures print both sides (`web : {...}` / `godot : {...}`) with update instructions — a useful diff, not just a boolean.
- **CI** (`.github/workflows/ci.yml`): clones the public Godot repo, checks out the pinned commit (`GODOT_PARITY_COMMIT: 2c61632…`, re-pinned deliberately after intentional Godot changes) and runs the test with `GODOT_DATA_DIR=/tmp/crownfall-ref/data` — the comparison runs against **actual Godot source data**, not a web copy. In CI the test additionally asserts the live-repo source is in use.
- Locally (no `GODOT_DATA_DIR`) the test falls back to checked-in snapshots in `tests/fixtures/godot-data/` — **explicitly documented limitation**: fixtures can drift from Godot HEAD; CI always uses the real repository. Update procedure (documented in the test header and CI step comments): after an intentional Godot data change, mirror values into `data.ts`, refresh fixtures, re-pin `GODOT_PARITY_COMMIT`.
- The parity test was executed against the real cloned Godot repo (`GODOT_DATA_DIR=/tmp/crownfall/data`): **6 pass / 0 fail** — the CI path is validated end-to-end.
- Intentional non-compared field: web-only `ResourceNodeDef.frame` (render sprite index). Godot-only `eras.description` is unused by both runtimes; `weakened_pct` IS compared (mirrored) although neither runtime consumes it.

---

## 8. P4-D — Settings parity (volume, fullscreen, mute)

**Godot contract** (`scripts/ui/PauseMenu.gd`): Master Volume slider (0..1, step 0.05, auto-mutes the Master bus at ≤ 0.001, persisted to `settings.cfg`, restored on load) + Fullscreen check button (persisted, applied at startup).

**Web reality check:** the web DOES have real audio output (`AudioManager`, WebAudio SFX with 6 wav assets) — so a real volume control was implemented, not a fake slider.

**Implementation:**
- **`src/lib/game/audio.ts`** — `masterVolume` (0..1, clamped, NaN/±Infinity fall back safely); `play()` scales the per-sfx gain by the master volume and skips playback entirely at ≤ 0.001 (Godot's bus-mute threshold) or when the pre-existing M-key mute is on.
- **`src/lib/game/settings.ts`** (new) — persisted settings contract mirroring Godot: `volume` (default 1.0), `fullscreen` (default false), plus the pre-existing web mute toggle (web-only addition, documented; Godot expresses mute as volume 0 — both exist here because the M toggle predates Phase 4). Stored in localStorage (`crownfall_settings_v1`), defensively sanitized field-by-field, never throws.
- **`src/components/game/crownfall-game.tsx`** — pause menu gained a Settings panel (Godot structure: main panel ↔ settings panel ↔ Back): Master Volume slider (shadcn `Slider`, 0..1 step 0.05, `%` label) and a Fullscreen switch (shadcn `Switch`) wired to the Fullscreen API on the game viewport element. Fullscreen UI state is synchronized with the ACTUAL browser state via `fullscreenchange`/`fullscreenerror`; unsupported environments disable the control with a visible note; rejected requests surface a toast and leave the preference untouched. The persisted fullscreen preference is honored on the first user gesture (browser gesture policy — documented platform limit vs Godot's unconditional startup restore). Volume and mute changes persist immediately and survive reloads.
- No decorative controls: every control is wired to real functionality (gain node scaling / Fullscreen API / persisted state).

**Tests** (`tests/game/settings.test.ts`, 8): sanitizer defaults/field-independence/clamping/corrupt-data fallbacks; storage round-trip.

**Browser E2E:** settings panel renders (screenshot); slider driven to 0.50 → persisted to localStorage → **survives a full page reload** (slider re-renders at 0.5); fullscreen ON → `document.fullscreenElement` true, switch checked, pref persisted; OFF → all three revert; mute via HUD button → persisted (`muted: true`) and icon state flips; M-key toggle verified during gameplay.

---

## 9. Iteration record (CODE → REVIEW → DEBUG → REVIEW)

**Cycle 1 — CODE:** all seven findings implemented + 50 new/updated tests. Tests: 199 pass / 2 fail.

**Cycle 1 — REVIEW (independent diff review) findings:**
1. **[Test bug, P3] config parity compared plots by array index** — Godot orders farms west→east, web east→west; values identical. Fixed: compare by plot id (mirrors Godot's per-id config application).
2. **[Test bug, P3] migration test asserted the "unsupported version" reason for non-integer versions** — those correctly hit the exact-int gate ("missing-or-invalid"). Fixed: split assertions per branch.
3. **[UI, P3] double toast on fullscreen rejection** — `requestFullscreen().catch()` toasted AND the `fullscreenerror` listener toasted. Fixed: single toast source (the listener).
4. **[Lint, P2] unused eslint-disable directives (3 warnings)** → removed; removing them surfaced the real rule `react-hooks/set-state-in-effect` rejecting the effect-based settings hydration. **[Structure, P2] fixed root-cause-style**: restructured to lazy `useState` initializers (client-only, SSR falls back to defaults, no settings-dependent UI in the initial render — hydration safe). No lint rules disabled.
5. **[Comment accuracy, P3] "dormant zeros at sunrise" was wrong** — verified in both codebases that sunrise saves carry the finished night's dormant remainders (neither runtime resets at sunrise; both reset at night start). Comment corrected; behavior already parity-correct.

**Cycle 1 — DEBUG:** all five fixed; re-run: **201 pass / 0 fail**, lint exit 0.

**Cycle 2 — SECOND REVIEW (of the updated diff):**
- Sunrise reset/autosave ordering compared against Godot (`_on_sunrise_reached` → `night_mgr.on_sunrise_reached` vs web `onSunriseReached`): parity confirmed.
- All `validateSavePayload` call sites audited: every production caller now migrates first; no raw legacy path remains.
- Backup-staging in `saveGame()` re-audited: a legacy primary counts as valid (migrate+validate) and is staged to backup — Godot `_read_and_validate_file` parity.
- Full `tsc --noEmit` attribution: baseline worktree comparison proves Phase 4 introduces **zero new error categories** (details Section 11).
- Second sweep of migration edge cases (empty-string reign, explicit-null reign, non-dict buildings items, invalid hearth_level in v1, node_states-as-array, migration order of type defaults vs era inference): all mirror Godot.
- No new findings; suite/lint/build re-verified.

**Cycles completed: 2 of 5** (finished early: all tasks done, all tests pass, all browser scenarios pass, final review clean of unresolved P0/P1/P2).

---

## 10. Automated verification (actual executed commands and results)

| Command | Result |
|---|---|
| `bun test tests/game/` | **201 pass / 0 fail, 791 expect() calls, 8 files** (exit 0) |
| `bun test` (project-wide) | **201 pass / 0 fail** — no other test files interfere |
| `bun run lint` (`eslint .`) | **0 errors, 0 warnings** (exit 0) |
| `bun run build` (dev server stopped; `.next` cleared) | **✓ Compiled successfully in 8.5s** — Next.js 16.1.3 (Turbopack), routes `/`, `/_not-found`, `/api`; static pages 4/4 |
| `tsc --noEmit` (baseline `f267d25` worktree vs Phase 4 tree) | see Section 11 — zero new error categories introduced |
| `GODOT_DATA_DIR=/tmp/crownfall/data bun test tests/game/config-parity.test.ts` | **6 pass / 0 fail** (real Godot source data — the CI path) |

---

## 11. TypeScript status (honest accounting)

`next.config.ts` contains the pre-existing scaffold setting `typescript.ignoreBuildErrors: true`, so a passing build alone proves nothing about typing. A real `tsc --noEmit` was run against the baseline (via a detached worktree at `f267d25`) and against the Phase 4 tree:

- Baseline: 21 errors. Phase 4 tree: 27 error *lines*, of which every engine/renderer line is the **same pre-existing error shifted by the +92 inserted lines** (verified error-text-by-error-text).
- Genuinely new entries exist only for the **new test files**, and they repeat the **pre-existing** pattern affecting ALL test files since Phase 3 (`Cannot find module 'bun:test'` — the repo's tsconfig does not load bun types; bun's own runner is unaffected), plus the bun-specific `import.meta.dir` in the new parity test.
- One `skills/image-edit` scaffold error appears environment-dependent (SDK type resolution differs between the two installs; unrelated to game code, file untouched by Phase 4).
- The pre-existing engine/renderer errors are literal-type friction (`as const` data assigned into `number`-holding fields — e.g. `campVagrants` inferred as literal `2`) and a pre-existing narrow-role comparison; all predate Phase 3 and were consciously tolerated by prior phases.

**Decision:** removing `ignoreBuildErrors` and fixing all pre-existing type friction is out of Phase 4 scope ("no broad unrelated refactors") and would fail the build on pre-existing conditions. Reported as remaining technical debt with a recommended follow-up (type the affected engine fields as `number`, add bun types for tests, then drop the suppression).

---

## 12. Browser E2E (agent-browser, real Chromium against the dev server)

| Scenario | Result |
|---|---|
| Title screen loads | PASS (screenshot `e2e-01-title.png`) |
| New Reign starts | PASS — started=true, 2G/2W/1S, Day 1 daylight |
| Existing valid save loads | PASS (migrated v2 load via Continue Reign) |
| Invalid save cannot silently start a fresh reign | PASS — garbage/future-schema saves: Continue disabled, load rejected, state untouched |
| Backup recovery | PASS — corrupt primary + valid backup → load succeeds, primary self-heals to v3 |
| Portal reward succeeds | PASS — 2G/1S → 5G/3S, portal marked looted |
| Portal reward failure leaves portal retryable | PASS — stone at cap → reject, not looted, gold unchanged; retry after freeing space succeeds |
| Resource transactions reject unknown IDs | PASS — no property minted, valid bundle siblings not committed |
| Bundle transactions atomic | PASS (browser + unit matrix) |
| Legacy save migration preserves progression | PASS — full progression list in Section 4 |
| Night encounter state survives save-load | PASS — all six fields exact after diverge/load |
| Settings controls work | PASS — volume slider (persisted across reload), fullscreen toggle both directions with browser-state sync, mute toggle persists |
| No uncaught console errors | PASS (only HMR dev noise) |
| No uncaught page errors | PASS — zero |

Also verified: dev.log clean over the whole session (no runtime errors, no hydration warnings).

---

## 13. Files changed

| File | Change |
|---|---|
| `src/lib/game/save-migration.ts` | **NEW** — explicit migration pipeline (Godot migrate_payload parity + schema contract docs) |
| `src/lib/game/save-validation.ts` | schema gate: current-web-schema only (legacy must migrate); doc contract |
| `src/lib/game/engine.ts` | P2-A lootPortal transaction; P2-C tryAdd/tryAddBundle whitelist; P4-A six night fields (serialize + restore); readValidSaveCandidate migrate-before-validate |
| `src/lib/game/audio.ts` | master volume (Godot PauseMenu contract incl. ≤ 0.001 mute threshold) |
| `src/lib/game/settings.ts` | **NEW** — persisted settings (volume/mute/fullscreen) with defensive sanitization |
| `src/components/game/crownfall-game.tsx` | pause-menu Settings panel (volume slider, fullscreen switch), fullscreen API wiring + state sync, settings persistence |
| `tests/game/save-migration.test.ts` | **NEW** — 22 migration/schema tests |
| `tests/game/phase4-regressions.test.ts` | **NEW** — 14 portal + night-encounter tests |
| `tests/game/settings.test.ts` | **NEW** — 8 settings tests |
| `tests/game/config-parity.test.ts` | **NEW** — 6 config parity tests (live Godot data or documented fixtures) |
| `tests/game/economy.test.ts` | +13 P2-C tests |
| `tests/game/save-validation.test.ts` | schema-version expectations updated to the explicit contract (v1/v2 → migration path) |
| `tests/fixtures/godot-data/*.json` | **NEW** — 5 Godot data snapshots (local fallback; limitation documented) |
| `.github/workflows/ci.yml` | Godot clone @ pinned commit + config-parity CI step |
| `docs/PHASE_4_IMPLEMENTATION_REPORT.md` | **NEW** — this report |

**Not touched (verified via diff):** `src/lib/game/data.ts`, renderer, all other components, Prisma schema, Godot repository, remote `main`.

---

## 14. Intentional differences between Godot and Web (Phase 4 additions to the audit list)

1. **Schema version numbers differ** (web 3 / Godot 2) and are deliberately not aligned — documented platform contracts; the migration pipeline treats v1/v2 as the Godot formats those numbers verifiably belonged to.
2. **Migrated v1 saves without `night_encounter` are rejected** — identical to Godot's own current accept/reject outcome (Godot also never synthesizes encounter data for v1).
3. **Fullscreen preference is applied on the first user gesture**, not at startup — browsers require a gesture for fullscreen; Godot applies it unconditionally. The persisted preference is honored (auto-attempt once per session), the control always reflects the real browser state.
4. **Web persists a separate mute toggle** (pre-existing M-key UX) in addition to Godot's volume-as-mute; both end in the same ≤ 0.001 mute behavior.
5. **Local parity runs use checked-in fixtures** (documented limitation); CI always compares against the real Godot repository at a pinned commit.
6. Backup self-heal writes the **migrated** current-schema payload (Godot rewrites the raw backup text) — strictly safer, and the healed file re-validates.

---

## 15. Remaining technical debt / findings

- **P3 — pre-existing `tsc --noEmit` failures** (21 baseline errors: scaffold `examples/`, `skills/` script, engine/renderer literal-type friction, missing bun types for tests) tolerated by prior phases; suppression via `ignoreBuildErrors: true` is pre-existing. Recommended follow-up: type the ~8 engine fields as `number`, add bun type support, then remove the suppression.
- **P3 — night sub-fields in sunrise saves** carry the previous night's dormant remainders on BOTH platforms (verified parity, reset at night start). A future "clean sunrise snapshot" change would need to touch both runtimes to stay in parity; deliberately not done.
- **CI parity pin maintenance**: `GODOT_PARITY_COMMIT` must be re-pinned (and `data.ts` + fixtures updated) after each intentional Godot data change — documented procedure; this is the desired deliberate-update workflow rather than a silent divergence.
- No unresolved P0/P1/P2 findings from this work.

---

## 16. Acceptance checklist

- [x] Portal reward state changes only after successful transaction
- [x] Failed portal reward can be retried
- [x] Save schema v1 is genuinely migrated (verified transforms) or safely rejected (Godot-parity outcome for encounter-less v1)
- [x] No unsupported schema is silently accepted (validator = current schema only; explicit reasons)
- [x] Unknown resource IDs cannot corrupt economy state
- [x] Invalid resource bundles cannot partially change balances
- [x] All six Night encounter fields are correctly serialized/restored (Godot clamps/filters/defaults)
- [x] Web/Godot schema compatibility is explicit and tested
- [x] Configuration parity is automatically verified (real Godot data in CI; documented fixture fallback locally)
- [x] Settings parity implemented where actual browser functionality exists (real audio volume, real fullscreen, persisted)
- [x] Existing Phase 3 fixes remain intact (full pre-existing suite passes unmodified except the two schema-version expectation tests that implement P2-B)
- [x] All automated tests pass (201/791)
- [x] Production build passes
- [x] Browser E2E passes (14/14 scenarios)
- [x] Final independent code review clean of unresolved P0/P1/P2 introduced by this work
- [x] Implementation report complete (this document)
- [x] Changes committed on the dedicated branch
- [x] No changes merged into `main`
---

## 17. Independent follow-up review after the initial Phase 4 report

A separate review of the committed implementation found additional issues that were fixed before requesting a merge.

### 17.1 CI ordering defect (fixed)

The first Phase 4 CI run (commit 7f720e2, run [#43737566395](https://github.com/ridho1141haha/crownfall-web/actions/runs/43737566395)) failed because the full test suite ran before the Godot source clone. The config-parity test correctly refused to use local fixtures in CI, so 200 tests passed and the CI-source assertion failed.

**Fix:** moved the pinned Godot clone before the full test step and passed GODOT_DATA_DIR=/tmp/crownfall-ref/data to the entire suite. The parity test now runs against actual Godot source data in CI. Workflow fix commit: 72f7dd1. This is a CI orchestration defect, not a gameplay regression.

### 17.2 Legacy primary was not staged as backup during first Web re-save (fixed)

The initial Phase 4 saveGame() backup staging path called the current-schema-only validateSavePayload(existingData) directly. A structurally valid Godot v2 save therefore failed the new schema gate and would not be staged to backup when the migrated game was saved as Web v3.

**Fix:** backup staging now uses the same parse → migrateSavePayload() → validateSavePayload() pipeline as load and Continue gating. The original raw legacy bytes are kept in backup after migration-aware validation; backup recovery migrates them before applying and self-heals primary to Web v3.

Added a regression test that:
1. Writes a representative Godot v2 save to primary.
2. Loads it through the real engine path.
3. Changes progress and saves as Web v3.
4. Verifies the original Godot v2 bytes were staged to backup.
5. Corrupts primary and recovers the original v2 backup.
6. Verifies original progress is restored and primary is self-healed to v3.

Fix commit: f70a98e. Regression test commit: 56f9ee5.

### 17.3 Audio volume non-finite edge case (fixed)

AudioManager.setVolume(-Infinity) previously resolved to zero while the documented contract said all non-finite values fall back to the default volume. The implementation now clamps finite values to [0, 1] and consistently falls back to 1 for NaN and both infinities. Added a regression test.

Commits: 1da7d78 and 91952ca.

### 17.4 Fullscreen preference stale after browser-initiated exit (fixed)

The fullscreen UI reflected the actual document.fullscreenElement, but exiting fullscreen with Escape only changed UI state; the persisted preference could remain true and trigger another fullscreen attempt on the next reload.

**Fix:** the fullscreenchange handler now updates both UI state and the stored fullscreen preference from the actual browser state. It reads the latest persisted audio settings before writing, avoiding stale React closure values from overwriting a newer volume or mute preference.

Commits: 3687f93 and 19147f9.

### 17.5 Validator documentation corrected

The encounter validator comment now says the six sub-fields remain optional for backwards compatibility, while current Web payloads always serialize them. This removes stale B7 wording after P4-A completion.

Commit: f5e1111.

### Follow-up verification

The workflow was rerun after the CI ordering fix and passed on the intermediate commit 56f9ee5: ESLint, pinned Godot clone, full Bun suite (202 tests / 799 assertions), and production build all succeeded. A final run is required against the latest branch head after the subsequent audio/fullscreen/comment hardening; the final head SHA and exact counts must be taken from that run, not inferred from this earlier result.
