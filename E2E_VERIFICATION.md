# Crownfall: The Last Light — Web Port E2E Verification (Task 8)

End-to-end verification of the playable web port (Next.js + Canvas re-implementation of the
Godot 4 vertical slice). Executed with a headless browser driving real keyboard/pointer
input, reading engine state through a dev-only, read-only debug hook (`window.__crownfall`,
stripped from production builds). Evidence screenshots in `e2e-evidence/task8/`.

**Result: all major gameplay systems verified working. 0 console errors, 0 page errors,
0 runtime exceptions across the whole session.**

## Test Matrix

| # | System | How verified | Evidence |
|---|--------|--------------|----------|
| 1 | Title screen / no-save state | Buttons render; "Continue Reign" disabled + labelled "No Save Found" after storage clear; enabled when a save exists | 01, 01b |
| 2 | New Reign bootstrap | Day 1 daylight, 2G/2W/1S start balances, 5 plots PLACEHOLDER, 1 unrecruited NPC at camp, 2 vagrants | 02 |
| 3 | Movement | Held ArrowRight: x 0→252→496 (~240 px/s = PLAYER_SPEED), stops on keyup; clamped at world edge x=1540; touch hold-and-release verified | 02, 25 |
| 4 | Resource gathering | Timber +5W, Masonry +3S, Quarry +3S, Chest +4G, Shrine +3G, tree chop 3 hits → felled +4W on final hit; nodes/trees flagged collected | 03, 03b |
| 5 | Economy ledger | Every cost/reward matched expected deltas exactly (recruit 2G, farm 3G4W, tower 3G3W3S, wall 2G4W2S, stone upgrade 3G2W5S, hearth tiers, ship stages 6G8W4S total, flare 1W, stoke 1W, portal +3G2S, kill +1G, farmer +2G/60s, breach penalty floor(gold/2)) | multiple |
| 6 | Recruiting | R at camp: -2G, vagrant consumed (2→0), npc_02 spawned as Villager; 3rd recruit correctly rejected at 0 vagrants | 04 |
| 7 | Role assignment | First archer free; farmer costs 1G 1S; villager→role conversion; archer auto-walks to man watchtower; farmer claims farm, harvests +2G per 60 game-s (observed repeatedly); 3rd-stand rejection when no villager ("Recruit a Villager first") | 12, 25 |
| 8 | NPC behaviour | Builder auto-claims construction (walk→WORKING→COMPLETED→return), auto-repairs trampled/damaged buildings at dawn; villagers+farmers retreat to Town Center safe zone at dusk (tool-confiscation guard present); archer mans tower, IDLE by day / guards by night | 05, 09 |
| 9 | Building | Fund → UNDER_CONSTRUCTION → builder constructs → COMPLETED with correct durability (wall 150, tower 120, farm 80); dual B behavior: B on completed wall upgrades to Stone Tier 2 (260 HP) | 05, 09, 10, 11 |
| 10 | Repairing | F on full wall rejected ("does not need repair"); night repair costs base 2W 1S + 1 extra Wood at night, restores 120→150 | 18 |
| 11 | Day/night cycle | Daylight 480s → Sunset 60s → Night 180s → sunrise; 20x clock (T) skips phases; verified across days 1–9; renewables (nodes/trees) regrow at each sunrise, non-renewable caches persist | 02, 08 |
| 12 | Greedling waves | Day 1: 3 waves at t=0/55/110; Day 2+: 4 waves (0/42/84/126) + 2 West Scouts (20/90); sequential spawn gate; after breach no further waves that night; post-victory nights peaceful (no encounter) | 13, 15 |
| 13 | Combat | Archer tower volleys killed waves before wall contact (45 HP raider vs 40 dmg/shot); stone-wall thorn 20 + tower support 10 kill attackers at the wall (+1G reward each); West Scouts attack west wall (150→120 observed); enemies trample interior buildings on path; breach when raider reaches Town Center | 13, 15, 17 |
| 14 | Kindle Flare | Space at night: -1W, 8s active, 25s cooldown | 19 |
| 15 | Hearth system | Stoke (E, 1W → +30% radius/+2 DPS 60s); Q upgrade to Tier 2 "Beacon Fire" (4G 4W 2S, radius 320) | 12, 21 |
| 16 | Shadow Stagger | Monarch in darkness within 44px of raider: pushed exactly +48px away, -1 Gold | 17 |
| 17 | Breach penalty | Raider reached Town Center (no wall, day 1): reign→BREACH_PENALTY, gold halved at dawn (11→6, floor rule); message chain correct | 08 |
| 18 | Pause / resume | Esc freezes simulation (phaseElapsed frozen across 3s), menu with Resume/Save/Load/Help/Save&Title/Abandon; resume continues clock | 20 |
| 19 | Save / load | K saves payload (day/resources/buildings/NPCs/progression); page reload + Continue Reign restored day, 65G, all 5 plots incl. Stone Wall L2 260/260, 3 NPC roles, player x; autosave at every dawn (saveDay verified); menu Save/Load buttons work | 16, 26 |
| 20 | Shipwreck & victory | 3 stages funded (exact costs) → "Vessel Ready" → Set Sail → ISLAND_CLEARED banner + reign state; night afterwards peaceful | 22, 23 |
| 21 | Portal / shrine | Portal relic looted (+3G +2S, one-time); shrine cache collected; both prompts resolve by nearest-target priority | 06 |
| 22 | Help / UI | Help dialog opens (H) with controls/roles/night rules, closes; mute toggle; footer sticky | 24 |
| 23 | Mobile layout | 390×844: touch controls row (◀ ▶ E Q R B F ␣) visible & functional (pointer events move the Monarch), compact HUD, on-screen hint, no layout breakage | 25 |

## Bugs found

**None blocking.** No reproducible gameplay bug surfaced; all resource deltas, state
transitions and rules matched the ported design constants exactly. Two non-bug
observations:

1. **B-side upgrade affordance**: standing at a *completed* wall, B silently upgrades it
   to Stone Tier 2 while the context prompt shows nothing (Q is documented for upgrades).
   Logic is intentional (`build_or_upgrade`); UX could be more explicit. Not changed
   (would alter gameplay presentation).
2. **Tree wood on felling only**: 3 chop hits, wood granted on the final (felling) hit —
   deliberate implementation with progress shown in the prompt ("[E] Chop Tree (2/3)").

## Known limitations

- Sound output itself cannot be asserted in a headless run (no audio device); audio
  pipeline produced no errors and mute/unmute + first-gesture unlock paths executed.
- Full-wave combat observation (brute/crawler archetypes) was verified in aggregate
  (forecast labels, spawn counters, kill rewards) rather than frame-by-frame; wave 1
  with an archer present dies before wall contact, which limits mid-flight observation.

## Dev instrumentation note

`src/components/game/crownfall-game.tsx` exposes `window.__crownfall.read()` — a
read-only state dump used for this verification, compiled only when
`NODE_ENV !== "production"`. It has no gameplay effect.
