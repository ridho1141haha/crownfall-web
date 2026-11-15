// Crownfall: The Last Light — game engine
// A faithful TypeScript port of the original GDScript systems:
// TimeManager, EconomyLedger, ResourceNodeManager, ForestTreeManager,
// BuildingManager, NPCBuilderAgent/NPCPopulationManager, NightEncounterManager,
// HearthSystem and ForgottenShoreSession (github.com/ridho1141haha/crownfall).

import {
  BUILDING_INTERACT_RANGE,
  ENEMY_ARCHETYPES,
  ERAS,
  FLARE,
  FARM_EAST_ID,
  FARM_WEST_ID,
  HEARTH,
  HEARTH_TIERS,
  LIGHT_RISK,
  NIGHT,
  NPC,
  POP,
  PORTAL,
  PLOT_SEEDS,
  RESOURCE_INTERACT_RANGE,
  RESOURCE_NODES,
  SAVE_BACKUP_KEY,
  SAVE_KEY,
  SAVE_SCHEMA_VERSION,
  SHIPWRECK,
  SHRINE_OFFERING,
  STONE_WALL_MAX_DURABILITY,
  STONE_WALL_UPGRADE_COST,
  START_BALANCES,
  TIME,
  TREES,
  TREE_INTERACT_RANGE,
  WALL_ID,
  WATCHTOWER_ID,
  WEST_WALL_ID,
  WORLD,
} from "./data";
import type {
  ActiveTarget,
  Agent,
  EnemyArchetype,
  EnemyState,
  FloatText,
  NpcRole,
  PaymentDot,
  Phase,
  Plot,
  PlotState,
  ReignState,
  ResourceId,
  Snapshot,
} from "./types";

type SfxName = "coin" | "build" | "hit" | "bow" | "sunset" | "night";

export interface EngineHooks {
  sfx: (name: SfxName) => void;
  message: (text: string) => void;
  victory: (title: string, subtitle: string) => void;
}

const clamp = (v: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, v));
const sign = (v: number) => (v === 0 ? 0 : Math.sign(v));
const smoothstep = (edge0: number, edge1: number, x: number) => {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
};

const COST_EMPTY = {} as Partial<Record<ResourceId, number>>;

export class GameEngine {
  // --- callbacks ---
  hooks: EngineHooks;

  // --- run state ---
  started = false;
  paused = false;

  // --- TimeManager ---
  day = 1;
  phase: Phase = "daylight";
  phaseElapsed = 0;
  timeScale = 1;

  // --- EconomyLedger ---
  gold = START_BALANCES.gold;
  wood = START_BALANCES.wood;
  stone = START_BALANCES.stone;

  // --- Player ---
  playerX = 0;
  facing = 1;
  input = { left: false, right: false };

  // --- BuildingManager (multi-plot registry) ---
  plots = new Map<string, Plot>();

  // --- ResourceNodeManager / ForestTreeManager ---
  nodeStates = new Map<string, boolean>();
  treeHp = new Map<string, number>();

  // --- NPCPopulationManager ---
  agents: Agent[] = [];
  campVagrants = POP.MAX_CAMP_VAGRANTS;

  // --- NightEncounterManager ---
  night: EnemyState = {
    active: false,
    x: NIGHT.SPAWN_X,
    hp: 0,
    maxHp: ENEMY_ARCHETYPES.raider.hp,
    archetype: "raider",
    attackTimer: 0,
    burnAccumulator: 0,
  };
  west: EnemyState = {
    active: false,
    x: NIGHT.WEST_SPAWN_X,
    hp: 0,
    maxHp: ENEMY_ARCHETYPES.raider.hp,
    archetype: "raider",
    attackTimer: 0,
    burnAccumulator: 0,
  };
  nightActive = false;
  nightElapsed = 0;
  nightDayNumber = 1;
  spawnedWaves = 0;
  westSpawned = 0;
  settlementBreached = false;
  firstNightSurvived = false;
  eastTrampled: string[] = [];
  westTrampled: string[] = [];

  // --- HearthSystem ---
  hearthLevel = 1;
  hearthBoost = 0;

  // --- Session progression flags ---
  reign: ReignState = "ACTIVE";
  shipwreckStage = 0;
  portalLooted = false;
  shrineUsedToday = false;
  flareTimer = 0;
  flareCooldown = 0;
  staggerCooldown = 0;

  // --- FX ---
  floats: FloatText[] = [];
  payments: PaymentDot[] = [];
  private paymentId = 0;
  eraIndex = 0;
  shakeTime = 0;
  shakeIntensity = 0;
  private animClock = 0;
  private floatId = 1;
  private hasSaveCache = false;

  // last resolved interaction target (for HUD prompt + [E] action)
  private activeTarget: ActiveTarget = {
    hasTarget: false,
    kind: "",
    targetId: "",
    primaryCommand: "",
    upgradeCommand: "",
    prompt: "",
  };

  constructor(hooks: EngineHooks) {
    this.hooks = hooks;
    this.resetState();
  }

  // ==========================================================================
  // Setup / reset
  // ==========================================================================

  private resetState() {
    this.day = 1;
    this.phase = "daylight";
    this.phaseElapsed = 0;
    this.timeScale = 1;
    this.gold = START_BALANCES.gold;
    this.wood = START_BALANCES.wood;
    this.stone = START_BALANCES.stone;
    this.playerX = 0;
    this.facing = 1;
    this.plots = new Map();
    for (const seed of PLOT_SEEDS) {
      this.plots.set(seed.id, {
        ...seed,
        buildCost: { ...seed.buildCost },
        repairCost: { ...seed.repairCost },
        level: 1,
        state: "PLACEHOLDER",
        progress: 0,
        claimedBy: "",
      });
    }
    this.nodeStates = new Map(RESOURCE_NODES.map((n) => [n.id, false]));
    this.treeHp = new Map(TREES.map((t) => [t.id, t.maxHp]));
    this.agents = [
      {
        id: "npc_01",
        recruited: false,
        role: "builder",
        state: "UNRECRUITED",
        x: NPC.CAMP_X,
        task: "",
        targetX: NPC.SAFE_ZONE_X,
        facing: 1,
        farmTimer: 0,
        archerCooldown: 0,
        repairAccumulator: 0,
      },
    ];
    this.campVagrants = POP.MAX_CAMP_VAGRANTS;
    this.night = {
      active: false,
      x: NIGHT.SPAWN_X,
      hp: 0,
      maxHp: ENEMY_ARCHETYPES.raider.hp,
      archetype: "raider",
      attackTimer: 0,
      burnAccumulator: 0,
    };
    this.west = {
      active: false,
      x: NIGHT.WEST_SPAWN_X,
      hp: 0,
      maxHp: ENEMY_ARCHETYPES.raider.hp,
      archetype: "raider",
      attackTimer: 0,
      burnAccumulator: 0,
    };
    this.nightActive = false;
    this.nightElapsed = 0;
    this.nightDayNumber = 1;
    this.spawnedWaves = 0;
    this.westSpawned = 0;
    this.settlementBreached = false;
    this.firstNightSurvived = false;
    this.eastTrampled = [];
    this.westTrampled = [];
    this.hearthLevel = 1;
    this.hearthBoost = 0;
    this.reign = "ACTIVE";
    this.shipwreckStage = 0;
    this.portalLooted = false;
    this.shrineUsedToday = false;
    this.flareTimer = 0;
    this.flareCooldown = 0;
    this.staggerCooldown = 0;
    this.floats = [];
    this.payments = [];
    this.eraIndex = 0;
    this.refreshHasSave();
  }

  newGame() {
    this.resetState();
    this.started = true;
    this.paused = false;
    this.hooks.message(
      "Forgotten Shore: [A/D] Move | [E] Interact | [Q] Upgrade | [R] Recruit | [B] Build | [F] Repair | [T] 20x | [K] Save | [Esc] Pause",
    );
    this.emitSnapshot();
  }

  // ==========================================================================
  // Economy ledger (atomic)
  // ==========================================================================

  private balances(): Record<ResourceId, number> {
    return { gold: this.gold, wood: this.wood, stone: this.stone };
  }

  private canSpend(cost: Partial<Record<ResourceId, number>>): boolean {
    const b = this.balances();
    return (Object.entries(cost) as Array<[ResourceId, number]>).every(
      ([k, v]) => (b[k] ?? 0) >= (v ?? 0),
    );
  }

  trySpend(cost: Partial<Record<ResourceId, number>>): boolean {
    if (!this.canSpend(cost)) return false;
    for (const [k, v] of Object.entries(cost) as Array<[ResourceId, number]>) {
      this[k] -= v;
    }
    return true;
  }

  tryAdd(res: ResourceId, amount: number): boolean {
    if (!Number.isFinite(amount) || amount < 0) return false;
    this[res] += Math.round(amount);
    return true;
  }

  tryAddBundle(bundle: Partial<Record<ResourceId, number>>): boolean {
    const staged = this.balances();
    for (const [k, v] of Object.entries(bundle) as Array<
      [ResourceId, number]
    >) {
      staged[k] += v;
    }
    this.gold = staged.gold;
    this.wood = staged.wood;
    this.stone = staged.stone;
    return true;
  }

  private refund(cost: Partial<Record<ResourceId, number>>) {
    for (const [k, v] of Object.entries(cost) as Array<[ResourceId, number]>) {
      this[k] += v;
    }
  }

  // ==========================================================================
  // TimeManager
  // ==========================================================================

  private phaseDuration(): number {
    if (this.phase === "daylight") return TIME.DAYLIGHT_DURATION;
    if (this.phase === "sunset") return TIME.SUNSET_DURATION;
    return TIME.NIGHT_DURATION;
  }

  get phaseProgress(): number {
    return clamp(this.phaseElapsed / this.phaseDuration(), 0, 1);
  }

  private advanceTime(dt: number) {
    let remaining = dt;
    let guard = 0;
    while (remaining > 0 && guard++ < 8) {
      const left = this.phaseDuration() - this.phaseElapsed;
      if (remaining < left) {
        this.phaseElapsed += remaining;
        remaining = 0;
      } else {
        remaining -= left;
        this.transitionPhase();
      }
    }
  }

  private transitionPhase() {
    this.phaseElapsed = 0;
    if (this.phase === "daylight") {
      this.phase = "sunset";
      this.onSunsetStarted();
    } else if (this.phase === "sunset") {
      this.phase = "night";
      this.onNightStarted();
    } else {
      const completedDay = this.day;
      this.day += 1;
      this.phase = "daylight";
      this.onSunriseReached(completedDay);
      this.onDaylightStarted();
    }
  }

  private onDaylightStarted() {
    this.setDuskSafety(false);
    if (this.day > 1) this.shrineUsedToday = false;
    this.hooks.message(
      `Day ${this.day} Daylight — Wood & Stone nodes refreshed! Expand Farms, Watchtower & Stone Wall.`,
    );
  }

  private onSunsetStarted() {
    this.setDuskSafety(true);
    this.hooks.sfx("sunset");
    if (this.day >= 2) {
      this.hooks.message(
        "Sunset Warning — Greedlings approach from BOTH shores tonight! Keep villagers inside the walls.",
      );
    } else {
      this.hooks.message(
        "Sunset Warning — Builder is retreating to the Town Center safe zone!",
      );
    }
  }

  private onNightStarted() {
    this.setDuskSafety(true);
    if (this.reign === "ISLAND_CLEARED") {
      this.hooks.sfx("sunset");
      this.hooks.message(
        "The island is at peace — no Greedlings remain after your victory.",
      );
      return;
    }
    if (!this.nightActive) {
      this.nightStartEncounter(this.day);
      this.hooks.sfx("night");
      if (this.day >= 2) {
        this.hooks.message(
          `Night ${this.day}! Raiders hit the East Wall — West Scouts prowl the far flank!`,
        );
      } else {
        this.hooks.message(
          "Night has fallen! Greedling Raiders approach from the East Shore!",
        );
      }
    }
  }

  private onSunriseReached(_completedDay: number) {
    // resolve encounter outcome
    let wallHeld = this.isStanding(WALL_ID);
    const westPlot = this.plots.get(WEST_WALL_ID);
    if (westPlot && westPlot.state !== "PLACEHOLDER") {
      wallHeld = wallHeld && this.isStanding(WEST_WALL_ID);
    }
    const survived = !this.settlementBreached;
    if (survived) this.firstNightSurvived = true;
    this.nightActive = false;
    this.night.active = false;
    this.night.hp = 0;
    this.west.active = false;
    this.west.hp = 0;

    if (survived && wallHeld && this.reign !== "ISLAND_CLEARED") {
      this.hooks.message("Sunrise reached! Your defenses held the line.");
    } else if (survived && this.reign !== "ISLAND_CLEARED") {
      this.hooks.message(
        "Sunrise reached! The wall fell, but dawn broke in time.",
      );
    } else if (this.reign !== "ISLAND_CLEARED") {
      this.hooks.message(
        "Raiders breached Town Center! Half your Gold was lost; rebuild before next dusk.",
      );
    } else {
      this.hooks.message(`Dawn of Day ${this.day}! Forgotten Shore secured.`);
    }

    if (this.settlementBreached && this.reign !== "ISLAND_CLEARED") {
      this.reign = "BREACH_PENALTY";
      const penalty = Math.floor(this.gold / 2);
      if (penalty > 0) this.trySpend({ gold: penalty });
    } else if (this.reign !== "ISLAND_CLEARED") {
      this.reign = "ACTIVE";
    }

    // refresh renewables BEFORE autosave so saves record availability
    for (const n of RESOURCE_NODES) {
      if (n.renewable && this.nodeStates.get(n.id)) {
        this.nodeStates.set(n.id, false);
      }
    }
    for (const t of TREES) {
      if ((this.treeHp.get(t.id) ?? 0) < t.maxHp) this.treeHp.set(t.id, t.maxHp);
    }
    // vagrant refill at sunrise
    if (
      this.recruitedCount() + this.campVagrants <
      POP.MAX_POPULATION
    ) {
      this.campVagrants = Math.min(
        POP.MAX_CAMP_VAGRANTS,
        this.campVagrants + 1,
      );
    }
    if (this.saveGame()) {
      this.hooks.message("Kingdom state auto-saved!");
    } else {
      this.hooks.message("WARNING: Auto-save FAILED — progress may be lost!");
    }
  }

  // ==========================================================================
  // Resource nodes
  // ==========================================================================

  private isCollected(id: string) {
    return this.nodeStates.get(id) ?? false;
  }

  private findNearestAvailable(
    actorX: number,
    maxRange = RESOURCE_INTERACT_RANGE,
    resourceFilter?: ResourceId,
    renewableOnly = false,
  ): (typeof RESOURCE_NODES)[number] | null {
    let best: (typeof RESOURCE_NODES)[number] | null = null;
    let bestDist = maxRange + 0.001;
    for (const n of RESOURCE_NODES) {
      if (this.isCollected(n.id)) continue;
      if (resourceFilter && n.resource !== resourceFilter) continue;
      if (renewableOnly && !n.renewable) continue;
      const d = Math.abs(actorX - n.x);
      if (d < bestDist) {
        bestDist = d;
        best = n;
      }
    }
    return best;
  }

  private tryCollectNode(id: string, actorX: number): boolean {
    const n = RESOURCE_NODES.find((r) => r.id === id);
    if (!n) return false;
    if (this.isCollected(id)) return false;
    if (Math.abs(actorX - n.x) > RESOURCE_INTERACT_RANGE) return false;
    if (!this.tryAdd(n.resource, n.amount)) return false;
    this.nodeStates.set(id, true);
    return true;
  }

  // ==========================================================================
  // Forest trees
  // ==========================================================================

  private findNearestStandingTree(actorX: number) {
    let best: (typeof TREES)[number] | null = null;
    let bestDist = TREE_INTERACT_RANGE + 0.001;
    for (const t of TREES) {
      if ((this.treeHp.get(t.id) ?? 0) <= 0) continue;
      const d = Math.abs(actorX - t.x);
      if (d < bestDist) {
        bestDist = d;
        best = t;
      }
    }
    return best;
  }

  private tryChopTree(id: string, actorX: number): {
    ok: boolean;
    felled: boolean;
    hpLeft: number;
    wood: number;
    reason?: string;
  } {
    const t = TREES.find((r) => r.id === id);
    if (!t) return { ok: false, felled: false, hpLeft: 0, wood: 0, reason: "Unknown tree" };
    if ((this.treeHp.get(id) ?? 0) <= 0)
      return { ok: false, felled: false, hpLeft: 0, wood: 0, reason: "Tree already felled (regrows at Sunrise)" };
    if (Math.abs(actorX - t.x) > TREE_INTERACT_RANGE)
      return { ok: false, felled: false, hpLeft: 0, wood: 0, reason: "Move closer to the tree to chop" };
    const nextHp = Math.max(0, (this.treeHp.get(id) ?? 0) - 1);
    const felled = nextHp === 0;
    let wood = 0;
    if (felled) {
      if (!this.tryAdd("wood", t.woodYield))
        return { ok: false, felled: false, hpLeft: nextHp, wood: 0, reason: "Wood storage full!" };
      wood = t.woodYield;
    }
    this.treeHp.set(id, nextHp);
    return { ok: true, felled, hpLeft: nextHp, wood };
  }

  // ==========================================================================
  // Building manager (multi-plot)
  // ==========================================================================

  private plot(id: string): Plot | undefined {
    return this.plots.get(id);
  }

  isStanding(id: string): boolean {
    const p = this.plot(id);
    if (!p) return false;
    return p.state === "COMPLETED" || p.state === "DAMAGED";
  }

  isFullyOperational(id: string): boolean {
    return this.plot(id)?.state === "COMPLETED";
  }

  private isPlotNeedingWork(id: string): boolean {
    const p = this.plot(id);
    if (!p) return false;
    return p.state === "UNDER_CONSTRUCTION" || p.state === "DAMAGED";
  }

  hasDefensiveBarrier(id: string): boolean {
    const p = this.plot(id);
    if (!p) return false;
    if (
      (p.state === "COMPLETED" || p.state === "DAMAGED") &&
      p.durability > 0
    )
      return true;
    if (
      p.state === "UNDER_CONSTRUCTION" &&
      p.progress >= NIGHT.CONSTRUCTION_BARRIER_PROGRESS
    )
      return true;
    return false;
  }

  private getThornDamage(id: string): number {
    const p = this.plot(id);
    if (!p) return NIGHT.BASE_THORN_DAMAGE;
    if (p.level >= 2) return p.upgradeThornDamage ?? 20;
    return NIGHT.BASE_THORN_DAMAGE;
  }

  private getWatchtowerSupportDamage(): number {
    const p = this.plot(WATCHTOWER_ID);
    if (p && this.isFullyOperational(WATCHTOWER_ID)) {
      return p.supportDamage ?? 10;
    }
    return 0;
  }

  canUpgradeWall(actorX: number, id: string): boolean {
    const p = this.plot(id);
    if (!p) return false;
    if (p.type !== "wooden_wall") return false;
    if (p.state !== "COMPLETED") return false;
    if (p.level >= 2) return false;
    return Math.abs(actorX - p.x) <= BUILDING_INTERACT_RANGE;
  }

  private nearestActionablePlot(
    actorX: number,
    mode: "build_or_upgrade" | "repair" | "upgrade" | "any",
  ): string {
    let bestId = "";
    let bestDist = BUILDING_INTERACT_RANGE + 0.001;
    for (const p of this.plots.values()) {
      const dist = Math.abs(actorX - p.x);
      if (dist > BUILDING_INTERACT_RANGE || dist >= bestDist) continue;
      let actionable = false;
      if (mode === "build_or_upgrade") {
        actionable =
          p.state === "PLACEHOLDER" ||
          p.state === "DESTROYED" ||
          this.canUpgradeWall(actorX, p.id);
      } else if (mode === "repair") {
        actionable = p.state === "DAMAGED";
      } else if (mode === "upgrade") {
        actionable = this.canUpgradeWall(actorX, p.id);
      } else {
        actionable =
          p.state === "PLACEHOLDER" ||
          p.state === "DESTROYED" ||
          p.state === "DAMAGED" ||
          this.canUpgradeWall(actorX, p.id);
      }
      if (actionable) {
        bestDist = dist;
        bestId = p.id;
      }
    }
    return bestId;
  }

  requestStartConstruction(
    actorX: number,
    plotId: string,
  ): { ok: boolean; reason?: string } {
    const p = this.plot(plotId);
    if (!p) return { ok: false, reason: "Unknown building plot" };
    if (p.state !== "PLACEHOLDER" && p.state !== "DESTROYED") {
      return { ok: false, reason: `${plotId} is already built or under construction` };
    }
    if (Math.abs(actorX - p.x) > BUILDING_INTERACT_RANGE) {
      return { ok: false, reason: `Move closer to plot (x=${p.x}) to build` };
    }
    if (!this.trySpend(p.buildCost)) {
      return { ok: false, reason: "Insufficient resources to build" };
    }
    p.state = "UNDER_CONSTRUCTION";
    p.progress = 0;
    p.durability = 0;
    return { ok: true };
  }

  requestUpgradeWall(
    actorX: number,
    plotId: string,
  ): { ok: boolean; reason?: string } {
    const p = this.plot(plotId);
    if (!p) return { ok: false, reason: "Invalid upgrade target" };
    if (p.type !== "wooden_wall" && p.type !== "stone_wall") {
      return { ok: false, reason: "Only Wooden Wall supports Stone Tier 2 upgrade" };
    }
    if (p.level >= 2) return { ok: false, reason: "Wall is already Stone Tier 2" };
    if (p.state !== "COMPLETED") {
      return { ok: false, reason: "Wall must be COMPLETED before upgrading to Stone Tier 2" };
    }
    if (Math.abs(actorX - p.x) > BUILDING_INTERACT_RANGE) {
      return { ok: false, reason: `Move closer to Wall (x=${p.x}) to upgrade` };
    }
    // Biaya/HP/type upgrade dibaca dari konfigurasi plot (PLOT_SEEDS, cermin
    // data/buildings.json); konstanta hanya fallback untuk plot tanpa config.
    const upgCost = p.upgradeCost ?? STONE_WALL_UPGRADE_COST;
    const upgMax = p.upgradeMaxDurability ?? STONE_WALL_MAX_DURABILITY;
    if (!this.trySpend(upgCost)) {
      return {
        ok: false,
        reason: `Need ${costLabel(upgCost)} for Stone Wall Tier 2`,
      };
    }
    p.level = 2;
    p.type = p.upgradeTargetType ?? "stone_wall";
    p.maxDurability = upgMax;
    p.durability = upgMax;
    return { ok: true };
  }

  // --- Era progression (EraProgressionManager.gd + data/eras.json) ---
  eraId(): string {
    return ERAS[Math.min(this.eraIndex, ERAS.length - 1)].id;
  }

  eraName(): string {
    return ERAS[Math.min(this.eraIndex, ERAS.length - 1)].name;
  }

  private advanceEra(target: number): boolean {
    if (target <= this.eraIndex) return false;
    this.eraIndex = Math.min(target, ERAS.length - 1);
    return true;
  }

  notifyStoneWallBuilt(): boolean {
    return this.advanceEra(1);
  }

  notifyVesselReady(): boolean {
    return this.advanceEra(2);
  }

  private applySaveEra(id: string): void {
    const idx = ERAS.findIndex((e) => e.id === id);
    if (idx >= 0) this.eraIndex = idx;
  }

  private spawnPaymentFly(
    cost: Partial<Record<ResourceId, number>>,
    fromX: number,
    toX: number,
  ) {
    // Animasi pembayaran: partikel kecil per resource terbang dari aktor
    // menuju target yang dibayar (mirror _spawn_payment_fly di Godot).
    let laneDelay = 0;
    for (const res of ["gold", "wood", "stone"] as ResourceId[]) {
      const amount = cost[res] ?? 0;
      if (amount <= 0) continue;
      const dots = Math.min(amount, 4);
      for (let i = 0; i < dots; i++) {
        this.payments.push({
          id: this.paymentId++,
          fromX,
          toX,
          resource: res,
          age: 0,
          delay: laneDelay + i * 0.05,
        });
      }
      if (this.payments.length > 48) this.payments.splice(0, this.payments.length - 48);
      laneDelay += 0.08;
    }
  }

  requestRepair(
    actorX: number,
    plotId: string,
    extraCost: Partial<Record<ResourceId, number>> = {},
  ): { ok: boolean; reason?: string } {
    const p = this.plot(plotId);
    if (!p) return { ok: false, reason: "Unknown plot" };
    if (p.state !== "DAMAGED") {
      return { ok: false, reason: "Structure does not need repair right now" };
    }
    if (Math.abs(actorX - p.x) > BUILDING_INTERACT_RANGE) {
      return { ok: false, reason: "Move closer to the damaged structure to repair" };
    }
    const total: Partial<Record<ResourceId, number>> = { ...p.repairCost };
    for (const [k, v] of Object.entries(extraCost) as Array<
      [ResourceId, number]
    >) {
      total[k] = (total[k] ?? 0) + v;
    }
    if (!this.trySpend(total)) {
      return { ok: false, reason: "Insufficient repair resources" };
    }
    p.durability = p.maxDurability;
    p.state = "COMPLETED";
    return { ok: true };
  }

  private applyEnemyDamage(amount: number, plotId: string): number {
    if (amount <= 0) return 0;
    const p = this.plot(plotId);
    if (!p) return 0;
    if (p.state === "UNDER_CONSTRUCTION" && p.progress >= NIGHT.CONSTRUCTION_BARRIER_PROGRESS) {
      p.durability = Math.max(
        NIGHT.MAKESHIFT_MIN_HP,
        Math.round(p.progress * NIGHT.MAKESHIFT_HP_FACTOR),
      );
      p.state = "DAMAGED";
    }
    if (p.state !== "COMPLETED" && p.state !== "DAMAGED") return 0;
    const applied = Math.min(p.durability, amount);
    p.durability -= applied;
    if (p.durability <= 0) {
      p.durability = 0;
      p.state = "DESTROYED";
    } else {
      p.state = "DAMAGED";
    }
    return applied;
  }

  private advanceConstruction(dt: number, plotId: string): boolean {
    const p = this.plot(plotId);
    if (!p || dt <= 0) return false;
    if (p.state !== "UNDER_CONSTRUCTION") return false;
    p.progress = clamp(p.progress + dt / p.buildDuration, 0, 1);
    if (p.progress >= 1) {
      p.state = "COMPLETED";
      p.durability = p.maxDurability;
    }
    return true;
  }

  private builderRepairStep(points: number, plotId: string): boolean {
    if (points <= 0) return false;
    const p = this.plot(plotId);
    if (!p || p.state !== "DAMAGED") return false;
    p.durability = Math.min(p.maxDurability, p.durability + points);
    if (p.durability >= p.maxDurability) p.state = "COMPLETED";
    return true;
  }

  private claimPlot(plotId: string, npcId: string): boolean {
    const p = this.plot(plotId);
    if (!p || !npcId) return false;
    if (p.claimedBy && p.claimedBy !== npcId) return false;
    p.claimedBy = npcId;
    return true;
  }

  private releasePlotClaim(plotId: string, npcId = "") {
    const p = this.plot(plotId);
    if (!p) return;
    if (!npcId || p.claimedBy === npcId) p.claimedBy = "";
  }

  private selectHighestPriorityTask(
    fromX: number,
    claimantId: string,
  ): Plot | null {
    let best: Plot | null = null;
    let bestRank = 999;
    let bestDist = Infinity;
    for (const p of this.plots.values()) {
      if (!this.isPlotNeedingWork(p.id)) continue;
      if (claimantId && p.claimedBy && p.claimedBy !== claimantId) continue;
      let rank = 3;
      if (p.state === "DAMAGED") rank = 1;
      else if (p.state === "UNDER_CONSTRUCTION" && p.progress > 0) rank = 2;
      const dist = Math.abs(p.x - fromX);
      if (rank < bestRank || (rank === bestRank && dist < bestDist)) {
        bestRank = rank;
        bestDist = dist;
        best = p;
      }
    }
    return best;
  }

  private selectAvailableFarmPlot(fromX: number, claimantId: string): Plot | null {
    let best: Plot | null = null;
    let bestDist = Infinity;
    for (const p of this.plots.values()) {
      if (p.type !== "farm_plot") continue;
      if (p.state !== "COMPLETED") continue;
      if (p.claimedBy && p.claimedBy !== claimantId) continue;
      const dist = Math.abs(p.x - fromX);
      if (dist < bestDist) {
        bestDist = dist;
        best = p;
      }
    }
    return best;
  }

  // ==========================================================================
  // Hearth system
  // ==========================================================================

  private hearthTier() {
    return HEARTH_TIERS[Math.min(this.hearthLevel, HEARTH_TIERS.length) - 1];
  }

  hearthRadius(): number {
    return this.hearthTier().radiusPx;
  }

  hearthBurnDps(): number {
    return this.hearthTier().burnDps;
  }

  private isBoostActive(): boolean {
    return this.hearthBoost > 0;
  }

  private hearthEffectiveRadius(): number {
    return (
      this.hearthRadius() * (this.isBoostActive() ? HEARTH.BOOST_RADIUS_MULT : 1)
    );
  }

  private hearthEffectiveBurnDps(): number {
    return (
      this.hearthBurnDps() +
      (this.isBoostActive() ? HEARTH.BOOST_BURN_ADD : 0)
    );
  }

  private isInLight(x: number): boolean {
    return Math.abs(x - HEARTH.X) <= this.hearthEffectiveRadius();
  }

  tryStoke(actorX: number): { ok: boolean; reason?: string } {
    if (Math.abs(actorX - HEARTH.X) > HEARTH.INTERACT_RANGE) {
      return { ok: false, reason: "Move closer to Town Center Hearth (x=0) to stoke the fire" };
    }
    if (this.isBoostActive()) {
      return { ok: false, reason: `The stoked fire is already burning (${Math.round(this.hearthBoost)}s left)` };
    }
    if (!this.trySpend(HEARTH.BOOST_COST)) {
      return { ok: false, reason: "Stoke Fire needs 1 Wood" };
    }
    this.hearthBoost = HEARTH.BOOST_DURATION_SEC;
    return { ok: true };
  }

  canUpgradeHearth(): boolean {
    return this.hearthLevel < HEARTH_TIERS.length;
  }

  tryUpgradeHearth(actorX: number): { ok: boolean; reason?: string } {
    if (Math.abs(actorX - HEARTH.X) > HEARTH.INTERACT_RANGE) {
      return { ok: false, reason: "Move closer to Town Center Hearth (x=0) to upgrade" };
    }
    if (!this.canUpgradeHearth()) {
      return { ok: false, reason: "Solar Brazier is already at maximum Tier 3" };
    }
    const cost = HEARTH_TIERS[this.hearthLevel].upgradeCost;
    if (!this.trySpend(cost)) {
      return { ok: false, reason: "Insufficient resources to upgrade Hearth" };
    }
    this.hearthLevel += 1;
    return { ok: true };
  }

  // ==========================================================================
  // NPC population
  // ==========================================================================

  private recruitedCount(): number {
    return this.agents.filter((a) => a.recruited).length;
  }

  private setDuskSafety(unsafe: boolean) {
    for (const a of this.agents) {
      if (!a.recruited) continue;
      if (unsafe && a.role !== "archer") {
        if (a.task) {
          this.releasePlotClaim(a.task, a.id);
          a.task = "";
        }
        a.state = "RETURNING_TO_SAFETY";
        a.targetX = NPC.SAFE_ZONE_X;
      }
    }
  }

  private moveAgentToward(a: Agent, targetX: number, dt: number) {
    const diff = targetX - a.x;
    const step = NPC.MOVE_SPEED * dt;
    if (Math.abs(diff) <= step) {
      a.x = targetX;
    } else {
      a.x += sign(diff) * step;
    }
    if (Math.abs(diff) > 0.05) a.facing = sign(diff) >= 0 ? 1 : -1;
  }

  private tickAgents(dt: number) {
    for (const a of this.agents) {
      if (!a.recruited || dt <= 0) continue;
      if (a.role === "archer") {
        this.tickArcher(a, dt);
        continue;
      }

      // enemy grab check (tool confiscation)
      if (
        this.nightActive &&
        a.role !== "villager" &&
        Math.abs(a.x - NPC.SAFE_ZONE_X) > NPC.WORK_RANGE
      ) {
        const nearest = this.nearestActiveEnemy(a.x);
        if (nearest && Math.abs(nearest.x - a.x) <= NPC.ENEMY_GRAB_RANGE) {
          const former = a.role;
          a.role = "villager";
          a.task = "";
          a.state = "IDLE";
          this.hooks.sfx("hit");
          this.spawnFloat(a.x, `-${former}!`, "#e06c5a");
          this.hooks.message(
            `Greedlings caught ${a.id} outside the walls — ${former} tools lost! Re-assign at the Tool Stands tomorrow.`,
          );
          continue;
        }
      }

      // dusk/night safety override
      if (a.state === "RETURNING_TO_SAFETY" || this.phase !== "daylight") {
        if (a.role !== "archer") {
          if (a.task) {
            this.releasePlotClaim(a.task, a.id);
            a.task = "";
          }
          a.targetX = NPC.SAFE_ZONE_X;
          this.moveAgentToward(a, NPC.SAFE_ZONE_X, dt);
          if (Math.abs(a.x - NPC.SAFE_ZONE_X) <= NPC.WORK_RANGE) {
            a.state = "IDLE";
          } else {
            a.state = "RETURNING_TO_SAFETY";
          }
          continue;
        }
      }

      if (a.role === "farmer") {
        this.tickFarmer(a, dt);
        continue;
      }

      if (a.role === "villager") {
        this.moveAgentToSafeIdle(a, dt);
        continue;
      }

      // Builder AI
      let task = a.task ? this.plot(a.task) : null;
      const valid =
        task &&
        (task.claimedBy === a.id || !task.claimedBy) &&
        this.isPlotNeedingWork(task.id);
      if (!valid) {
        if (task) this.releasePlotClaim(task.id, a.id);
        a.task = "";
        const next = this.selectHighestPriorityTask(a.x, a.id);
        if (next && this.claimPlot(next.id, a.id)) {
          a.task = next.id;
          a.targetX = next.x;
          task = next;
        } else {
          task = null;
        }
      }

      if (task) {
        a.targetX = task.x;
        if (Math.abs(a.x - task.x) > NPC.WORK_RANGE) {
          a.state = "MOVING_TO_TASK";
          this.moveAgentToward(a, task.x, dt);
          continue;
        }
        a.state = "WORKING";
        if (task.state === "UNDER_CONSTRUCTION") {
          this.advanceConstruction(dt, task.id);
        } else if (task.state === "DAMAGED") {
          a.repairAccumulator += dt * NPC.REPAIR_RATE_PER_SEC;
          const pts = Math.floor(a.repairAccumulator);
          if (pts >= 1) {
            a.repairAccumulator -= pts;
            this.builderRepairStep(pts, task.id);
          }
        }
        if (!this.isPlotNeedingWork(task.id)) {
          this.releasePlotClaim(task.id, a.id);
          a.task = "";
          a.state = "IDLE";
        }
        continue;
      }

      this.tickIdleBuilder(a, dt);
    }
  }

  private moveAgentToSafeIdle(a: Agent, dt: number) {
    a.targetX = NPC.SAFE_ZONE_X;
    if (Math.abs(a.x - NPC.SAFE_ZONE_X) > NPC.WORK_RANGE) {
      a.state = "MOVING_TO_TASK";
      this.moveAgentToward(a, NPC.SAFE_ZONE_X, dt);
    } else {
      a.state = "IDLE";
    }
  }

  private tickFarmer(a: Agent, dt: number) {
    if (!a.task) {
      const farm = this.selectAvailableFarmPlot(a.x, a.id);
      if (farm && this.claimPlot(farm.id, a.id)) {
        a.task = farm.id;
        a.targetX = farm.x;
      }
    }
    if (a.task) {
      const farm = this.plot(a.task);
      if (!farm || farm.state !== "COMPLETED") {
        this.releasePlotClaim(a.task, a.id);
        a.task = "";
      } else {
        a.targetX = farm.x;
        if (Math.abs(a.x - farm.x) > NPC.WORK_RANGE) {
          a.state = "MOVING_TO_TASK";
          this.moveAgentToward(a, farm.x, dt);
        } else {
          a.state = "WORKING";
          a.farmTimer += dt;
          const interval = farm.harvestInterval ?? NPC.FARMER_HARVEST_SEC;
          const yieldAmt = farm.goldYield ?? NPC.FARMER_GOLD_YIELD;
          while (a.farmTimer >= interval) {
            a.farmTimer -= interval;
            if (this.tryAdd("gold", yieldAmt)) {
              this.hooks.sfx("coin");
              this.spawnFloat(a.x, `+${yieldAmt} Gold`, "#ffe074");
              this.hooks.message(
                `Farmer ${a.id} harvested +${yieldAmt} Gold!`,
              );
            }
          }
        }
        return;
      }
    }
    this.moveAgentToSafeIdle(a, dt);
  }

  private tickIdleBuilder(a: Agent, dt: number) {
    const canChop =
      !this.nightActive &&
      this.phase === "daylight" &&
      Math.abs(a.x - NPC.SAFE_ZONE_X) <= NPC.WORK_RANGE;
    if (canChop) {
      const node = this.findNearestAvailable(a.x, Infinity, "wood", true);
      if (node) {
        a.targetX = node.x;
        if (Math.abs(a.x - node.x) > NPC.WORK_RANGE) {
          a.state = "MOVING_TO_TASK";
          this.moveAgentToward(a, node.x, dt);
          return;
        }
        if (this.tryCollectNode(node.id, a.x)) {
          this.hooks.sfx("coin");
          this.spawnFloat(a.x, `+${node.amount} Wood`, "#ffe074");
          this.hooks.message(
            `Builder ${a.id} chopped +${node.amount} Wood while idle!`,
          );
        }
        a.state = "IDLE";
        return;
      }
    }
    this.moveAgentToSafeIdle(a, dt);
  }

  private tickArcher(a: Agent, dt: number) {
    let onTower = false;
    let guardX = NPC.SAFE_ZONE_X;
    const defendWest =
      this.nightActive && this.west.active && !this.night.active;
    if (defendWest) {
      const westPlot = this.plot(WEST_WALL_ID);
      if (westPlot && this.isStanding(WEST_WALL_ID)) {
        guardX = Math.max(
          westPlot.x + 36,
          clamp(
            this.west.x + NPC.ARCHER_PURSUIT_GAP,
            NPC.ARCHER_PURSUIT_WEST_LIMIT,
            NPC.SAFE_ZONE_X,
          ),
        );
      } else {
        guardX = clamp(
          this.west.x + NPC.ARCHER_PURSUIT_GAP,
          NPC.ARCHER_PURSUIT_WEST_LIMIT,
          NPC.SAFE_ZONE_X,
        );
      }
    } else {
      const tower = this.plot(WATCHTOWER_ID);
      if (tower && this.isFullyOperational(WATCHTOWER_ID)) {
        if (!tower.claimedBy || tower.claimedBy === a.id) {
          this.claimPlot(WATCHTOWER_ID, a.id);
          a.task = WATCHTOWER_ID;
        }
        guardX = tower.x;
        onTower = Math.abs(a.x - guardX) <= 12;
      }
      if (!onTower && this.isStanding(WALL_ID)) {
        guardX = (this.plot(WALL_ID)?.x ?? 380) - 36;
      }
    }

    if (Math.abs(a.x - guardX) > 12) {
      a.state = "MOVING_TO_TASK";
      this.moveAgentToward(a, guardX, dt);
    } else {
      a.state = this.nightActive ? "WORKING" : "IDLE";
    }

    a.archerCooldown = Math.max(0, a.archerCooldown - dt);
    if (a.archerCooldown <= 0) {
      const range = onTower ? NPC.ARCHER_TOWER_RANGE : NPC.ARCHER_GROUND_RANGE;
      const tgt = this.nearestActiveEnemy(a.x);
      if (tgt && Math.abs(tgt.x - a.x) <= range) {
        const dmg = NPC.ARCHER_BASE_DAMAGE * (onTower ? 2 : 1);
        const hit = this.damageNearestEnemy(a.x, range, dmg);
        if (hit) {
          a.archerCooldown = NPC.ARCHER_FIRE_INTERVAL;
          this.hooks.sfx("bow");
          this.spawnFloat(tgt.x, `-${dmg}`, "#e07373");
          this.hooks.message(
            `Archer volley (${dmg}${onTower ? " from Watchtower" : ""})!`,
          );
        }
      }
    }
  }

  // ==========================================================================
  // Night encounter
  // ==========================================================================

  private waveSchedule(day: number): number[] {
    return day <= 1
      ? [...NIGHT.WAVE_SPAWN_TIMES]
      : [...NIGHT.ESCALATED_WAVE_TIMES];
  }

  private waveArchetype(day: number, idx: number): EnemyArchetype {
    if (day <= 1) return "raider";
    if (day === 2) return idx % 2 === 1 ? "crawler" : "raider";
    if (idx === 3) return "brute";
    if (idx >= 1) return "crawler";
    return "raider";
  }

  getNightForecast(day: number): string {
    if (day <= 1) return "Tonight (East): 3 Waves • Greedling Raider";
    if (day === 2) return "Tonight (East & West): 4 East + 2 West Scouts";
    return "Tonight (Both Sides): Raider, Crawler, Brute + West Scouts";
  }

  private nightStartEncounter(dayNum: number) {
    this.nightDayNumber = Math.max(1, dayNum);
    this.nightActive = true;
    this.nightElapsed = 0;
    this.spawnedWaves = 0;
    this.westSpawned = 0;
    this.west.active = false;
    this.west.hp = 0;
    this.settlementBreached = false;
    this.eastTrampled = [];
    this.westTrampled = [];
    this.spawnNextWave();
  }

  private spawnNextWave() {
    const schedule = this.waveSchedule(this.nightDayNumber);
    const arch = this.waveArchetype(this.nightDayNumber, this.spawnedWaves);
    const stats = ENEMY_ARCHETYPES[arch];
    this.spawnedWaves += 1;
    this.night.active = true;
    this.night.x = NIGHT.SPAWN_X;
    this.night.archetype = arch;
    this.night.maxHp = stats.hp;
    this.night.hp = stats.hp;
    this.night.attackTimer = 0;
    this.night.burnAccumulator = 0;
    this.eastTrampled = [];
    this.westTrampled = [];
  }

  private spawnWestScout() {
    const stats = ENEMY_ARCHETYPES.raider;
    this.westSpawned += 1;
    this.west.active = true;
    this.west.x = NIGHT.WEST_SPAWN_X;
    this.west.archetype = "raider";
    this.west.maxHp = stats.hp;
    this.west.hp = stats.hp;
    this.west.attackTimer = 0;
    this.west.burnAccumulator = 0;
    this.westTrampled = [];
  }

  private nearestActiveEnemy(fromX: number): { x: number; isWest: boolean } | null {
    let best: { x: number; isWest: boolean } | null = null;
    let bestD = Infinity;
    if (this.night.active) {
      bestD = Math.abs(this.night.x - fromX);
      best = { x: this.night.x, isWest: false };
    }
    if (this.west.active) {
      const d = Math.abs(this.west.x - fromX);
      if (d < bestD) {
        bestD = d;
        best = { x: this.west.x, isWest: true };
      }
    }
    return best;
  }

  private applyExternalDamage(amount: number): boolean {
    if (!this.night.active || amount <= 0) return false;
    this.night.hp = Math.max(0, this.night.hp - amount);
    if (this.night.hp <= 0) {
      this.night.active = false;
      this.onEnemyDefeated(this.night.archetype, this.night.x);
    }
    return true;
  }

  private applyWestExternalDamage(amount: number): boolean {
    if (!this.west.active || amount <= 0) return false;
    this.west.hp = Math.max(0, this.west.hp - amount);
    if (this.west.hp <= 0) {
      this.west.active = false;
      this.onEnemyDefeated("raider", this.west.x);
    }
    return true;
  }

  private damageNearestEnemy(
    fromX: number,
    maxRange: number,
    amount: number,
  ): boolean {
    const tgt = this.nearestActiveEnemy(fromX);
    if (!tgt || amount <= 0) return false;
    if (Math.abs(tgt.x - fromX) > maxRange) return false;
    return tgt.isWest
      ? this.applyWestExternalDamage(amount)
      : this.applyExternalDamage(amount);
  }

  private onEnemyDefeated(archetype: string, x: number) {
    if (this.tryAdd("gold", NIGHT.KILL_GOLD_REWARD)) {
      this.hooks.sfx("coin");
      this.spawnFloat(x, `+${NIGHT.KILL_GOLD_REWARD}G`, "#ffe074");
      this.hooks.message(
        `${ENEMY_ARCHETYPES[archetype as EnemyArchetype]?.name ?? "Raider"} defeated! +${NIGHT.KILL_GOLD_REWARD} Gold`,
      );
    }
  }

  private trampleInterior(
    prevX: number,
    newX: number,
    plotIds: string[],
    trampled: string[],
    dmg: number,
    isWest: boolean,
  ) {
    if (dmg <= 0) return;
    const segMin = Math.min(prevX, newX);
    const segMax = Math.max(prevX, newX);
    for (const pid of plotIds) {
      if (trampled.includes(pid) || !this.isStanding(pid)) continue;
      const p = this.plot(pid);
      if (!p) continue;
      if (p.x < segMin - NIGHT.ATTACK_RANGE || p.x > segMax + NIGHT.ATTACK_RANGE)
        continue;
      trampled.push(pid);
      const applied = this.applyEnemyDamage(dmg, pid);
      if (applied > 0) {
        this.hooks.sfx("hit");
        this.spawnFloat(p.x, `-${applied} ${p.type.replace("_", " ")}!`, "#e0594d");
        if (pid === WEST_WALL_ID) {
          this.hooks.message("West Wall is under attack by a West Scout!");
        } else if (p.type === "farm_plot") {
          this.hooks.message("Greedlings trampled one of our Farms! Repair it at dawn.");
        } else if (p.type === "watchtower") {
          this.hooks.message("Our Watchtower is under attack!");
        } else {
          this.hooks.message(isWest ? "Our West Wall is under attack!" : "Our East Wall is under attack!");
        }
      }
    }
  }

  private tickNight(dt: number) {
    if (!this.nightActive || dt <= 0) return;
    this.nightElapsed += dt;
    const schedule = this.waveSchedule(this.nightDayNumber);
    const lightMult = this.flareTimer > 0 ? FLARE.LIGHT_MULT : 1.0;
    const radius = this.hearthEffectiveRadius();
    const burn = this.hearthEffectiveBurnDps();

    if (
      !this.night.active &&
      !this.settlementBreached &&
      this.spawnedWaves < schedule.length
    ) {
      if (this.nightElapsed >= schedule[this.spawnedWaves]) {
        this.spawnNextWave();
      }
    }
    if (
      this.nightDayNumber >= 2 &&
      !this.west.active &&
      !this.settlementBreached &&
      this.westSpawned < NIGHT.WEST_SCOUT_TIMES.length
    ) {
      if (this.nightElapsed >= NIGHT.WEST_SCOUT_TIMES[this.westSpawned]) {
        this.spawnWestScout();
      }
    }

    if (this.night.active) this.tickEastEnemy(dt, radius, burn, lightMult);
    if (this.west.active) this.tickWestEnemy(dt, radius, burn, lightMult);
  }

  private tickEastEnemy(
    dt: number,
    hearthRadius: number,
    hearthBurn: number,
    lightMult: number,
  ) {
    const stats = ENEMY_ARCHETYPES[this.night.archetype];
    const spd = stats.speed;
    const baseDmg = stats.damage;
    const inLight = Math.abs(this.night.x - NIGHT.TOWN_CENTER_X) <= hearthRadius;

    if (inLight) {
      this.night.burnAccumulator += dt * hearthBurn * lightMult;
      const pts = Math.floor(this.night.burnAccumulator);
      if (pts >= 1) {
        this.night.burnAccumulator -= pts;
        this.night.hp = Math.max(0, this.night.hp - pts);
        if (this.night.hp <= 0) {
          this.night.active = false;
          this.onEnemyDefeated(this.night.archetype, this.night.x);
          return;
        }
      }
    }

    const effectiveDmg = inLight ? Math.round(baseDmg * 0.8) : baseDmg;

    if (this.hasDefensiveBarrier(WALL_ID)) {
      const stopX = (this.plot(WALL_ID)?.x ?? 380) + NIGHT.ATTACK_RANGE;
      if (this.night.x > stopX) {
        this.night.x = Math.max(stopX, this.night.x - spd * dt);
      } else {
        this.night.attackTimer += dt;
        while (
          this.night.attackTimer >= NIGHT.ATTACK_INTERVAL &&
          this.hasDefensiveBarrier(WALL_ID) &&
          this.night.active
        ) {
          this.night.attackTimer -= NIGHT.ATTACK_INTERVAL;
          const applied = this.applyEnemyDamage(effectiveDmg, WALL_ID);
          if (applied > 0) {
            this.hooks.sfx("hit");
            this.spawnFloat(this.night.x, `-${applied} East Wall!`, "#e0594d");
            if (this.wasWallJustDestroyed(WALL_ID)) {
              this.hooks.message("Our East Wall has been destroyed!");
            } else {
              this.hooks.message("Our East Wall is under attack!");
            }
          }
          const towerDmg = Math.round(this.getWatchtowerSupportDamage() * lightMult);
          this.night.hp = Math.max(
            0,
            this.night.hp - this.getThornDamage(WALL_ID) - towerDmg,
          );
          if (this.night.hp <= 0) {
            this.night.active = false;
            this.onEnemyDefeated(this.night.archetype, this.night.x);
            return;
          }
        }
      }
      return;
    }

    if (this.night.x > NIGHT.TOWN_CENTER_X) {
      const prevX = this.night.x;
      this.night.x = Math.max(NIGHT.TOWN_CENTER_X, this.night.x - spd * dt);
      this.trampleInterior(
        prevX,
        this.night.x,
        [WATCHTOWER_ID, FARM_EAST_ID],
        this.eastTrampled,
        effectiveDmg,
        false,
      );
      if (this.night.x <= NIGHT.TOWN_CENTER_X + NIGHT.BREACH_EPSILON) {
        this.settlementBreached = true;
        this.night.active = false;
      }
    }
  }

  private wasWallJustDestroyed(plotId: string): boolean {
    return this.plot(plotId)?.state === "DESTROYED";
  }

  private tickWestEnemy(
    dt: number,
    hearthRadius: number,
    hearthBurn: number,
    lightMult: number,
  ) {
    const stats = ENEMY_ARCHETYPES.raider;
    const spd = stats.speed;
    const baseDmg = stats.damage;
    const inLight = Math.abs(this.west.x - NIGHT.TOWN_CENTER_X) <= hearthRadius;

    if (inLight) {
      this.west.burnAccumulator += dt * hearthBurn * lightMult;
      const pts = Math.floor(this.west.burnAccumulator);
      if (pts >= 1) {
        this.west.burnAccumulator -= pts;
        this.west.hp = Math.max(0, this.west.hp - pts);
        if (this.west.hp <= 0) {
          this.west.active = false;
          this.onEnemyDefeated("raider", this.west.x);
          return;
        }
      }
    }

    const effDmg = inLight ? Math.round(baseDmg * 0.8) : baseDmg;

    if (this.hasDefensiveBarrier(WEST_WALL_ID)) {
      const westX = this.plot(WEST_WALL_ID)?.x ?? -400;
      const stopX = westX - NIGHT.ATTACK_RANGE;
      if (this.west.x < stopX) {
        this.west.x = Math.min(stopX, this.west.x + spd * dt);
      } else {
        this.west.attackTimer += dt;
        while (
          this.west.attackTimer >= NIGHT.ATTACK_INTERVAL &&
          this.hasDefensiveBarrier(WEST_WALL_ID) &&
          this.west.active
        ) {
          this.west.attackTimer -= NIGHT.ATTACK_INTERVAL;
          const applied = this.applyEnemyDamage(effDmg, WEST_WALL_ID);
          if (applied > 0) {
            this.hooks.sfx("hit");
            this.spawnFloat(this.west.x, `-${applied} West Wall!`, "#e0594d");
            this.hooks.message("West Wall is under attack by a West Scout!");
          }
          this.west.hp = Math.max(0, this.west.hp - this.getThornDamage(WEST_WALL_ID));
          if (this.west.hp <= 0) {
            this.west.active = false;
            this.onEnemyDefeated("raider", this.west.x);
            return;
          }
        }
      }
      return;
    }

    if (this.west.x < NIGHT.TOWN_CENTER_X) {
      const prevX = this.west.x;
      this.west.x = Math.min(NIGHT.TOWN_CENTER_X, this.west.x + spd * dt);
      this.trampleInterior(
        prevX,
        this.west.x,
        [FARM_WEST_ID],
        this.westTrampled,
        effDmg,
        true,
      );
      if (this.west.x >= NIGHT.TOWN_CENTER_X - NIGHT.BREACH_EPSILON) {
        this.settlementBreached = true;
        this.west.active = false;
      }
    }
  }

  // ==========================================================================
  // Interaction resolver (port of InteractionResolver.gd)
  // ==========================================================================

  private resolveTarget(actorX: number): ActiveTarget {
    const best: ActiveTarget = {
      hasTarget: false,
      kind: "",
      targetId: "",
      primaryCommand: "",
      upgradeCommand: "",
      prompt: "",
    };
    let bestDist = Infinity;

    // 1. resource nodes
    const node = this.findNearestAvailable(actorX);
    if (node) {
      const d = Math.abs(actorX - node.x);
      bestDist = d;
      Object.assign(best, {
        hasTarget: true,
        kind: "resource",
        targetId: node.id,
        primaryCommand: "collect",
        upgradeCommand: "",
        prompt: node.prompt,
      });
    }

    // 1b. shrine offering
    if (
      this.isCollected("shrine_cache_far_west") &&
      !this.shrineUsedToday
    ) {
      const d = Math.abs(actorX - SHRINE_OFFERING.X);
      if (d <= RESOURCE_INTERACT_RANGE && d < bestDist) {
        bestDist = d;
        Object.assign(best, {
          hasTarget: true,
          kind: "shrine_offering",
          targetId: "shrine_cache_far_west",
          primaryCommand: "shrine_offering",
          upgradeCommand: "",
          prompt: "[E] Shrine Offering (4W 2S -> +2G)",
        });
      }
    }

    // 2. tool stands
    let standId = "";
    let standDist = POP.STAND_RANGE + 0.001;
    for (const [sid, stand] of Object.entries(POP.TOOL_STANDS)) {
      const d = Math.abs(actorX - stand.x);
      if (d < standDist) {
        standDist = d;
        standId = sid;
      }
    }
    if (standId) {
      const stand = POP.TOOL_STANDS[standId as keyof typeof POP.TOOL_STANDS];
      if (standDist < bestDist) {
        bestDist = standDist;
        const costStr =
          stand.role === "archer" && this.agents.every((a) => !(a.recruited && a.role === "archer"))
            ? "Free 1st"
            : standCostLabel(stand.cost);
        Object.assign(best, {
          hasTarget: true,
          kind: "tool_stand",
          targetId: standId,
          primaryCommand: "assign_tool",
          upgradeCommand: "",
          prompt: `[E] Assign ${stand.role} (${costStr})`,
        });
      }
    }

    // 3. vagrant camp
    if (this.campVagrants > 0) {
      const d = Math.abs(actorX - NPC.CAMP_X);
      if (d <= POP.CAMP_RANGE && d < bestDist) {
        bestDist = d;
        Object.assign(best, {
          hasTarget: true,
          kind: "camp",
          targetId: "vagrant_camp",
          primaryCommand: "recruit",
          upgradeCommand: "",
          prompt: "Vagrant [E/R: 2G]",
        });
      }
    }

    // 4. building plots
    const pid = this.nearestActionablePlot(actorX, "any");
    if (pid) {
      const p = this.plot(pid)!;
      const d = Math.abs(actorX - p.x);
      let pCmd = "";
      let uCmd = "";
      if (p.state === "PLACEHOLDER" || p.state === "DESTROYED") pCmd = "build";
      else if (p.state === "DAMAGED") pCmd = "repair";
      if (this.canUpgradeWall(actorX, pid)) uCmd = "upgrade_building";
      if ((pCmd || uCmd) && d < bestDist) {
        bestDist = d;
        const title = plotTitle(pid);
        const cost = costLabel(p.buildCost);
        let prompt: string;
        if (p.state === "DAMAGED") {
          const rc = costLabel(p.repairCost);
          prompt = `Repair ${title} [E/F] (${rc})`;
        } else if (uCmd && !pCmd) {
          const upgCost = p.upgradeCost ?? STONE_WALL_UPGRADE_COST;
          const upgLabel = p.upgradeCostLabel ?? costLabel(upgCost);
          prompt = `${title} [Q] Stone Lv2: ${upgLabel}`;
        } else {
          prompt = `Build ${title} [E/B] (${cost})`;
        }
        Object.assign(best, {
          hasTarget: true,
          kind: "building",
          targetId: pid,
          primaryCommand: pCmd,
          upgradeCommand: uCmd,
          prompt,
        });
      }
    }

    // 5. shipwreck & portal
    const dShip = Math.abs(actorX - SHIPWRECK.X);
    if (dShip <= SHIPWRECK.RANGE && dShip < bestDist) {
      bestDist = dShip;
      Object.assign(best, {
        hasTarget: true,
        kind: "shipwreck",
        targetId: "shipwreck",
        primaryCommand: "shipwreck",
        upgradeCommand: "",
        prompt:
          this.shipwreckStage >= 3
            ? "Vessel Ready! [E] Set Sail"
            : `Shipwreck [E] Stage ${this.shipwreckStage + 1}/3`,
      });
    }

    if (!this.portalLooted) {
      const dPort = Math.abs(actorX - PORTAL.X);
      if (dPort <= PORTAL.RANGE && dPort < bestDist) {
        bestDist = dPort;
        Object.assign(best, {
          hasTarget: true,
          kind: "portal",
          targetId: "greed_portal",
          primaryCommand: "loot_portal",
          upgradeCommand: "",
          prompt: "Greed Portal [E]",
        });
      }
    }

    // 5b. trees
    const tree = this.findNearestStandingTree(actorX);
    if (tree) {
      const d = Math.abs(actorX - tree.x);
      if (d < bestDist) {
        bestDist = d;
        Object.assign(best, {
          hasTarget: true,
          kind: "tree",
          targetId: tree.id,
          primaryCommand: "chop_tree",
          upgradeCommand: "",
          prompt: `[E] Chop Tree (${this.treeHp.get(tree.id)}/${tree.maxHp})`,
        });
      }
    }

    // 6. hearth
    const dHearth = Math.abs(actorX - HEARTH.X);
    if (dHearth <= HEARTH.INTERACT_RANGE && dHearth < bestDist) {
      Object.assign(best, {
        hasTarget: true,
        kind: "hearth",
        targetId: "town_hearth",
        primaryCommand: "boost_hearth",
        upgradeCommand: this.canUpgradeHearth() ? "upgrade_hearth" : "",
        prompt: this.canUpgradeHearth()
          ? "Hearth [E] Stoke Fire (1W) | [Q] Upgrade"
          : "Hearth [E] Stoke Fire (1W)",
      });
    }

    return best;
  }

  // ==========================================================================
  // World commands (port of ForgottenShoreSession.execute_world_command)
  // ==========================================================================

  executeWorldCommand(command: string, targetId = ""): { ok: boolean; reason?: string } {
    const actorX = this.playerX;
    let resolvedTarget = targetId;

    switch (command) {
      case "collect": {
        if (!resolvedTarget) {
          const n = this.findNearestAvailable(actorX);
          resolvedTarget = n?.id ?? "";
        }
        if (this.tryCollectNode(resolvedTarget, actorX)) {
          const n = RESOURCE_NODES.find((r) => r.id === resolvedTarget)!;
          this.hooks.sfx("coin");
          this.spawnFloat(n.x, `+${n.amount} ${n.resource}`, "#ffe074");
          this.hooks.message(`Collected: ${n.label}`);
          return { ok: true };
        }
        return { ok: false, reason: "Collection failed" };
      }

      case "assign_tool": {
        if (!resolvedTarget) {
          resolvedTarget = this.nearestToolStand(actorX);
        }
        return this.assignToolStand(resolvedTarget);
      }

      case "recruit": {
        const agent = this.recruitNextVagrant(actorX);
        if (!agent) return { ok: false, reason: "Recruit failed" };
        this.spawnPaymentFly(NPC.RECRUIT_COST, actorX, NPC.CAMP_X);
        if (agent.role === "villager") {
          this.hooks.message(
            `Recruited Villager! Assign a role at the Hammer/Scythe/Bow Stand near Town Center. Total NPCs: ${this.recruitedCount()}`,
          );
        } else {
          this.hooks.message(
            `Recruited ${agent.id} (${agent.role})! Total NPCs: ${this.recruitedCount()}`,
          );
        }
        return { ok: true };
      }

      case "build": {
        if (!resolvedTarget) {
          resolvedTarget =
            this.nearestActionablePlot(actorX, "build_or_upgrade") ||
            this.nearestAnyPlot(actorX) ||
            WALL_ID;
        }
        const res = this.requestStartConstruction(actorX, resolvedTarget);
        if (res.ok) {
          this.hooks.sfx("build");
          const p = this.plot(resolvedTarget)!;
          this.spawnFloat(p.x, "Blueprint funded", "#9be0a6");
          this.spawnPaymentFly(p.buildCost, actorX, p.x);
          this.hooks.message(
            `${plotTitle(resolvedTarget)} blueprint funded! Builder will construct it.`,
          );
        }
        return res;
      }

      case "repair": {
        if (!resolvedTarget) {
          resolvedTarget =
            this.nearestActionablePlot(actorX, "repair") ||
            this.nearestAnyPlot(actorX) ||
            WALL_ID;
        }
        const extra =
          this.phase === "night" ? { wood: 1 } : COST_EMPTY;
        const res = this.requestRepair(actorX, resolvedTarget, extra);
        if (res.ok) {
          this.hooks.sfx("build");
          const repPlot = this.plot(resolvedTarget);
          if (repPlot) {
            const repTotal: Partial<Record<ResourceId, number>> = {
              ...repPlot.repairCost,
            };
            for (const [k, v] of Object.entries(extra) as Array<
              [ResourceId, number]
            >) {
              repTotal[k] = (repTotal[k] ?? 0) + v;
            }
            this.spawnPaymentFly(repTotal, actorX, repPlot.x);
          }
          this.hooks.message(
            `${plotTitle(resolvedTarget)} repaired to full durability!`,
          );
        }
        return res;
      }

      case "upgrade_building": {
        if (!resolvedTarget) {
          resolvedTarget =
            this.nearestActionablePlot(actorX, "upgrade") ||
            this.nearestAnyPlot(actorX) ||
            WALL_ID;
        }
        const res = this.requestUpgradeWall(actorX, resolvedTarget);
        if (res.ok) {
          this.hooks.sfx("build");
          const upgPlot = this.plot(resolvedTarget);
          this.spawnPaymentFly(
            upgPlot?.upgradeCost ?? STONE_WALL_UPGRADE_COST,
            actorX,
            upgPlot?.x ?? actorX,
          );
          const eraNote = this.notifyStoneWallBuilt()
            ? " The Stone Age has begun!"
            : "";
          this.hooks.message(
            `Upgraded to ${plotTitle(resolvedTarget)} (${upgPlot?.maxDurability ?? STONE_WALL_MAX_DURABILITY} HP, ${this.getThornDamage(resolvedTarget)} thorn dmg)!${eraNote}`,
          );
        }
        return res;
      }

      case "upgrade_hearth": {
        const res = this.tryUpgradeHearth(actorX);
        if (res.ok) {
          this.hooks.sfx("build");
          this.spawnPaymentFly(
            HEARTH_TIERS[this.hearthLevel]?.upgradeCost ?? {},
            actorX,
            HEARTH.X,
          );
          this.spawnFloat(0, `Hearth Lv.${this.hearthLevel}!`, "#ffc75a");
          this.hooks.message(
            `Hearth upgraded to Lv.${this.hearthLevel} (${this.hearthTier().name}, Light radius: ${Math.round(this.hearthRadius())} px)!`,
          );
        }
        return res;
      }

      case "boost_hearth": {
        const res = this.tryStoke(actorX);
        if (res.ok) {
          this.hooks.sfx("sunset");
          this.spawnPaymentFly(HEARTH.BOOST_COST, actorX, HEARTH.X);
          this.spawnFloat(0, "STOKED!", "#ffc75a");
          this.hooks.message(
            `Fire stoked! Light radius +30% and burn +2 DPS for ${HEARTH.BOOST_DURATION_SEC} seconds!`,
          );
        }
        return res;
      }

      case "shipwreck":
        return this.shipwreckInteract(actorX);

      case "loot_portal": {
        if (Math.abs(actorX - PORTAL.X) > PORTAL.RANGE) {
          return { ok: false, reason: `Move closer to Greed Portal (x=${PORTAL.X})` };
        }
        return this.lootPortal();
      }

      case "shrine_offering": {
        if (Math.abs(actorX - SHRINE_OFFERING.X) > RESOURCE_INTERACT_RANGE) {
          return { ok: false, reason: `Move closer to Forgotten Shrine (x=${SHRINE_OFFERING.X})` };
        }
        if (this.shrineUsedToday) {
          return { ok: false, reason: "Shrine Offering already used today" };
        }
        if (!this.trySpend(SHRINE_OFFERING.COST)) {
          return { ok: false, reason: "Shrine Offering needs 4 Wood, 2 Stone" };
        }
        if (!this.tryAdd("gold", SHRINE_OFFERING.REWARD)) {
          this.refund(SHRINE_OFFERING.COST);
          return { ok: false, reason: "Shrine Offering failed — ledger rejected the reward" };
        }
        this.shrineUsedToday = true;
        this.hooks.sfx("coin");
        this.spawnPaymentFly(SHRINE_OFFERING.COST, actorX, SHRINE_OFFERING.X);
        this.spawnFloat(SHRINE_OFFERING.X, "+2G Offering", "#ffe074");
        this.hooks.message("Shrine Offering accepted: 4W + 2S -> +2 Gold!");
        return { ok: true };
      }

      case "kindle_flare": {
        if (this.phase !== "night") {
          return { ok: false, reason: "Kindle Flare [Space] can only be used at Night" };
        }
        if (this.flareCooldown > 0) {
          return { ok: false, reason: `Kindle Flare on cooldown (${Math.ceil(this.flareCooldown)}s)` };
        }
        if (!this.trySpend(FLARE.COST)) {
          return { ok: false, reason: "Kindle Flare needs 1 Wood" };
        }
        this.flareTimer = FLARE.ACTIVE_SEC;
        this.flareCooldown = FLARE.COOLDOWN_SEC;
        this.hooks.sfx("sunset");
        this.spawnPaymentFly(FLARE.COST, actorX, HEARTH.X);
        this.spawnFloat(actorX, "KINDLE FLARE +50%!", "#ffc75a");
        this.hooks.message(
          "Kindle Flare active! Hearth burn & Watchtower dmg +50% for 8s!",
        );
        return { ok: true };
      }

      case "chop_tree": {
        if (!resolvedTarget) {
          const t = this.findNearestStandingTree(actorX);
          resolvedTarget = t?.id ?? "";
        }
        const res = this.tryChopTree(resolvedTarget, actorX);
        if (res.ok) {
          this.hooks.sfx("build");
          const t = TREES.find((r) => r.id === resolvedTarget)!;
          if (res.felled) {
            this.spawnFloat(t.x, `+${res.wood} Wood`, "#ffe074");
            this.hooks.message(`Tree felled! +${res.wood} Wood`);
          } else {
            this.spawnFloat(t.x, `Chop (${res.hpLeft}/${t.maxHp})`, "#ffe074");
          }
        }
        return { ok: res.ok, reason: res.reason };
      }

      case "save_game":
        return { ok: this.manualSave() };

      default:
        return { ok: false, reason: `Unknown world command: ${command}` };
    }
  }

  private nearestAnyPlot(actorX: number): string {
    let bestId = "";
    let bestDist = BUILDING_INTERACT_RANGE + 0.001;
    for (const p of this.plots.values()) {
      const d = Math.abs(actorX - p.x);
      if (d < bestDist) {
        bestDist = d;
        bestId = p.id;
      }
    }
    return bestId;
  }

  private nearestToolStand(actorX: number): string {
    let bestId = "";
    let bestDist = POP.STAND_RANGE + 0.001;
    for (const [sid, stand] of Object.entries(POP.TOOL_STANDS)) {
      const d = Math.abs(actorX - stand.x);
      if (d < bestDist) {
        bestDist = d;
        bestId = sid;
      }
    }
    return bestId;
  }

  private assignToolStand(standId: string): { ok: boolean; reason?: string } {
    const stand = POP.TOOL_STANDS[standId as keyof typeof POP.TOOL_STANDS];
    if (!stand) return { ok: false, reason: "Unknown tool stand" };
    const idle = this.agents.find((a) => a.recruited && a.role === "villager");
    if (!idle) {
      return { ok: false, reason: "Recruit a Villager at Vagrant Camp [R: 2G] first!" };
    }
    let firstArcherFree = stand.role === "archer";
    if (this.agents.some((a) => a.recruited && a.role === "archer")) {
      firstArcherFree = false;
    }
    if (!firstArcherFree && Object.keys(stand.cost).length > 0) {
      if (!this.trySpend(stand.cost)) {
        return { ok: false, reason: `Insufficient resources for ${standId}` };
      }
    }
    // release claims when switching roles
    if (idle.task) {
      this.releasePlotClaim(idle.task, idle.id);
      idle.task = "";
    }
    idle.role = stand.role;
    idle.state = "IDLE";
    this.hooks.message(`${idle.id} assigned as ${stand.role}!`);
    return { ok: true };
  }

  private recruitNextVagrant(actorX: number): Agent | null {
    const primary = this.agents[0];
    if (!primary.recruited) {
      if (Math.abs(actorX - NPC.CAMP_X) > NPC.RECRUIT_RANGE) {
        this.hooks.message(
          `Move closer to Vagrant Camp (x=${NPC.CAMP_X}) to recruit`,
        );
        return null;
      }
      if (!this.trySpend(NPC.RECRUIT_COST)) {
        this.hooks.message("Need 2 Gold to recruit Villager");
        return null;
      }
      primary.recruited = true;
      primary.role = "builder";
      primary.state = "IDLE";
      primary.targetX = NPC.SAFE_ZONE_X;
      this.campVagrants = Math.max(0, this.campVagrants - 1);
      return primary;
    }

    if (this.recruitedCount() >= POP.MAX_POPULATION) {
      this.hooks.message(
        `Kingdom population cap (${POP.MAX_POPULATION}) reached`,
      );
      return null;
    }
    if (this.campVagrants <= 0) {
      this.hooks.message("No Vagrants at Camp right now (refills at Sunrise)");
      return null;
    }
    if (Math.abs(actorX - NPC.CAMP_X) > NPC.RECRUIT_RANGE) {
      this.hooks.message(
        `Move closer to Vagrant Camp (x=${NPC.CAMP_X}) to recruit`,
      );
      return null;
    }
    if (!this.trySpend(NPC.RECRUIT_COST)) {
      this.hooks.message("Need 2 Gold to recruit Villager");
      return null;
    }
    const newcomer: Agent = {
      id: `npc_${String(this.agents.length + 1).padStart(2, "0")}`,
      recruited: true,
      role: "villager",
      state: "IDLE",
      x: NPC.CAMP_X,
      task: "",
      targetX: NPC.SAFE_ZONE_X,
      facing: 1,
      farmTimer: 0,
      archerCooldown: 0,
      repairAccumulator: 0,
    };
    this.agents.push(newcomer);
    this.campVagrants = Math.max(0, this.campVagrants - 1);
    return newcomer;
  }

  private shipwreckInteract(actorX: number): { ok: boolean; reason?: string } {
    if (Math.abs(actorX - SHIPWRECK.X) > SHIPWRECK.RANGE) {
      return { ok: false, reason: `Move closer to the Shipwreck (x=${SHIPWRECK.X})` };
    }
    if (this.shipwreckStage >= 3) {
      this.nightActive = false;
      this.night.active = false;
      this.west.active = false;
      this.reign = "ISLAND_CLEARED";
      if (!this.saveGame()) {
        this.hooks.message("Island cleared, but auto-save FAILED — progress may be lost");
      }
      this.hooks.sfx("coin");
      this.hooks.victory(
        "ISLAND CLEARED",
        "The vessel sets sail from Forgotten Shore toward Eldergrove Forest!",
      );
      this.hooks.message(
        "Ship repaired! Setting sail from Forgotten Shore toward Eldergrove Forest!",
      );
      return { ok: true };
    }
    const cost = SHIPWRECK.COSTS[this.shipwreckStage];
    if (!this.trySpend(cost)) {
      return {
        ok: false,
        reason: `Shipwreck Stage ${this.shipwreckStage + 1}/3 needs ${cost.gold}G ${cost.wood}W ${cost.stone}S`,
      };
    }
    this.shipwreckStage += 1;
    this.hooks.sfx("build");
    this.spawnPaymentFly(cost, actorX, SHIPWRECK.X);
    this.spawnFloat(SHIPWRECK.X, `Ship Stage ${this.shipwreckStage}/3`, "#9be0a6");
    if (this.shipwreckStage >= 3 && this.notifyVesselReady()) {
      this.hooks.message(
        `Shipwreck repaired to Stage ${this.shipwreckStage}/3! The Iron Age has begun — heavy craft powers the great voyage.`,
      );
    } else {
      this.hooks.message(`Shipwreck repaired to Stage ${this.shipwreckStage}/3!`);
    }
    return { ok: true };
  }

  private lootPortal(): { ok: boolean; reason?: string } {
    if (this.portalLooted) {
      return { ok: false, reason: "Portal Relic already scavenged" };
    }
    this.tryAddBundle(PORTAL.REWARD);
    this.portalLooted = true;
    this.hooks.sfx("coin");
    this.spawnFloat(PORTAL.X, "+3G +2S Relic", "#ffe074");
    this.hooks.message("Scavenged Ancient Relic near Greed Portal (+3 Gold, +2 Stone)!");
    return { ok: true };
  }

  manualSave(): boolean {
    if (this.phase === "night") {
      this.hooks.message("Manual save [K] is disabled during active Night combat");
      return false;
    }
    if (this.saveGame()) {
      this.hooks.message("Kingdom state saved to browser storage (slot 0)");
      return true;
    }
    this.hooks.message("Manual save failed");
    return false;
  }

  // ==========================================================================
  // Public actions (wired to keyboard / touch UI)
  // ==========================================================================

  interact() {
    if (!this.canAct()) return;
    const tgt = this.resolveTarget(this.playerX);
    this.activeTarget = tgt;
    if (!tgt.hasTarget) {
      this.hooks.message(
        `Nothing to collect or interact with at x=${Math.round(this.playerX)}.`,
      );
      return;
    }
    if (!tgt.primaryCommand) {
      if (tgt.upgradeCommand) {
        this.hooks.message(`Press [Q] to upgrade ${tgt.targetId}`);
      } else {
        this.hooks.message(`No action available for ${tgt.targetId}`);
      }
      return;
    }
    const res = this.executeWorldCommand(tgt.primaryCommand, tgt.targetId);
    if (!res.ok && res.reason) this.hooks.message(res.reason);
  }

  upgradeAction() {
    if (!this.canAct()) return;
    const tgt = this.resolveTarget(this.playerX);
    if (tgt.hasTarget && tgt.upgradeCommand) {
      const res = this.executeWorldCommand(tgt.upgradeCommand, tgt.targetId);
      if (!res.ok && res.reason) this.hooks.message(res.reason);
      return;
    }
    if (
      Math.abs(this.playerX - HEARTH.X) <= HEARTH.INTERACT_RANGE &&
      this.canUpgradeHearth()
    ) {
      const res = this.executeWorldCommand("upgrade_hearth", "town_hearth");
      if (!res.ok && res.reason) this.hooks.message(res.reason);
      return;
    }
    this.hooks.message(`Nothing to upgrade near x=${Math.round(this.playerX)}.`);
  }

  recruitAction() {
    if (!this.canAct()) return;
    const res = this.executeWorldCommand("recruit", "vagrant_camp");
    if (!res.ok && res.reason) this.hooks.message(res.reason);
  }

  buildAction() {
    if (!this.canAct()) return;
    const target =
      this.nearestActionablePlot(this.playerX, "build_or_upgrade") ||
      this.nearestAnyPlot(this.playerX) ||
      WALL_ID;
    if (this.canUpgradeWall(this.playerX, target)) {
      const res = this.executeWorldCommand("upgrade_building", target);
      if (!res.ok && res.reason) this.hooks.message(res.reason);
      return;
    }
    const res = this.executeWorldCommand("build", target);
    if (!res.ok && res.reason) this.hooks.message(res.reason);
  }

  repairAction() {
    if (!this.canAct()) return;
    const target =
      this.nearestActionablePlot(this.playerX, "repair") ||
      this.nearestAnyPlot(this.playerX) ||
      WALL_ID;
    const res = this.executeWorldCommand("repair", target);
    if (!res.ok && res.reason) this.hooks.message(res.reason);
  }

  flareAction() {
    if (!this.canAct()) return;
    const res = this.executeWorldCommand("kindle_flare", "");
    if (!res.ok && res.reason) this.hooks.message(res.reason);
  }

  toggleTimeScale() {
    this.timeScale = Math.abs(this.timeScale - TIME.FAST_SCALE) < 0.01 ? 1 : TIME.FAST_SCALE;
    this.hooks.message(`Clock speed set to ${Math.round(this.timeScale)}x`);
  }

  private canAct(): boolean {
    return this.started && !this.paused;
  }

  // ==========================================================================
  // Monarch light risk (port of _tick_monarch_light_risk)
  // ==========================================================================

  private tickLightRisk(dt: number) {
    this.staggerCooldown = Math.max(0, this.staggerCooldown - dt);
    if (this.phase !== "night" || this.staggerCooldown > 0) return;
    if (!this.night.active && !this.west.active) return;
    const nearest = this.nearestActiveEnemy(this.playerX);
    if (!nearest || this.isInLight(this.playerX)) return;
    if (Math.abs(this.playerX - nearest.x) > LIGHT_RISK.ENEMY_PROXIMITY) return;
    this.staggerCooldown = LIGHT_RISK.STAGGER_COOLDOWN;
    const away = sign(this.playerX - nearest.x) || -1;
    this.playerX = clamp(
      this.playerX + away * LIGHT_RISK.PUSH_DISTANCE,
      WORLD.MIN_PLAYABLE_X,
      WORLD.MAX_PLAYABLE_X,
    );
    if (this.gold > 0) this.trySpend({ gold: 1 });
    this.hooks.message("Shadow Stagger! Stay inside the Light at Night (-1 Gold)!");
  }

  // ==========================================================================
  // Main tick
  // ==========================================================================

  update(dtReal: number) {
    if (!this.started || this.paused) return;
    this.animClock += dtReal;

    // player movement is real-time (not scaled by clock speed)
    const dir = (this.input.right ? 1 : 0) - (this.input.left ? 1 : 0);
    if (dir !== 0) {
      this.facing = dir;
      this.playerX = clamp(
        this.playerX + dir * PLAYER_SPEED * dtReal,
        WORLD.MIN_PLAYABLE_X,
        WORLD.MAX_PLAYABLE_X,
      );
    }

    const simDt = dtReal * this.timeScale;
    this.advanceTime(simDt);
    this.tickAgents(simDt);
    this.flareTimer = Math.max(0, this.flareTimer - simDt);
    this.flareCooldown = Math.max(0, this.flareCooldown - simDt);
    if (this.phase !== "daylight") {
      this.hearthBoost = Math.max(0, this.hearthBoost - simDt);
    }
    this.tickNight(simDt);
    this.tickLightRisk(simDt);

    // fx housekeeping (real-time)
    for (const f of this.floats) f.age += dtReal;
    this.floats = this.floats.filter((f) => f.age < 0.85);
    for (const d of this.payments) d.age += dtReal;
    this.payments = this.payments.filter(
      (d) => d.age < d.delay + 0.67,
    );
    if (this.shakeTime > 0) this.shakeTime -= dtReal;

    // refresh active target for prompts
    this.activeTarget = this.resolveTarget(this.playerX);
  }

  get animTime(): number {
    return this.animClock;
  }

  // --- render bridge helpers ---
  hearthBoostRemaining(): number {
    return this.hearthBoost;
  }

  flareActiveRemaining(): number {
    return this.flareTimer;
  }

  resourceNodesForRender(): Array<{ x: number; frame: number; collected: boolean }> {
    return RESOURCE_NODES.map((n) => ({
      x: n.x,
      frame: n.frame,
      collected: this.isCollected(n.id),
    }));
  }

  treeStatesForRender(): Array<{ id: string; x: number; felled: boolean; hp: number; maxHp: number }> {
    return TREES.map((t) => ({
      id: t.id,
      x: t.x,
      felled: (this.treeHp.get(t.id) ?? 0) <= 0,
      hp: this.treeHp.get(t.id) ?? 0,
      maxHp: t.maxHp,
    }));
  }

  treeById(id: string): { x: number; felled: boolean; hp: number; maxHp: number } | null {
    const t = this.treeStatesForRender().find((r) => r.id === id);
    return t ?? null;
  }

  isNodeCollected(id: string): boolean {
    return this.isCollected(id);
  }

  agentsForRender(): Array<{ id: string; role: NpcRole; state: string; x: number; facing: number }> {
    return this.agents.map((a) => ({
      id: a.id,
      role: a.role,
      state: a.state,
      x: a.x,
      facing: a.facing,
    }));
  }

  archerCount(): number {
    return this.agents.filter((a) => a.recruited && a.role === "archer").length;
  }


  spawnFloat(x: number, text: string, color: string) {
    this.floats.push({ id: this.floatId++, x, text, color, age: 0 });
    if (this.floats.length > 24) this.floats.shift();
  }

  shake(intensity = 4, duration = 0.14) {
    this.shakeIntensity = intensity;
    this.shakeTime = duration;
  }

  // ==========================================================================
  // Save / load (localStorage with .bak recovery, mirrors SaveManager.gd)
  // ==========================================================================

  refreshHasSave() {
    try {
      this.hasSaveCache = Boolean(
        typeof window !== "undefined" &&
          (localStorage.getItem(SAVE_KEY) ?? localStorage.getItem(SAVE_BACKUP_KEY)),
      );
    } catch {
      this.hasSaveCache = false;
    }
  }

  get hasSave(): boolean {
    return this.hasSaveCache;
  }

  buildSavePayload(): Record<string, unknown> {
    return {
      schema_version: SAVE_SCHEMA_VERSION,
      world_id: "aetherion",
      island_id: "forgotten_shore",
      day_count: this.day,
      world_time: Math.round(this.phaseElapsed * 1000) / 1000,
      world_phase: this.phase,
      player: {
        position_x: Math.round(this.playerX * 10) / 10,
        facing_direction: this.facing,
      },
      resources: this.balances(),
      buildings: [...this.plots.values()].map((p) => ({
        id: p.id,
        type: p.type,
        position_x: p.x,
        level: p.level,
        state: p.state,
        progress: Math.round(p.progress * 1000) / 1000,
        durability: p.durability,
        max_durability: p.maxDurability,
      })),
      npcs: this.agents.map((a) => ({
        id: a.id,
        recruited: a.recruited,
        role: a.role,
        state: a.state,
        position_x: Math.round(a.x * 10) / 10,
        farm_timer: Math.round(a.farmTimer * 1000) / 1000,
      })),
      camp_vagrants_available: this.campVagrants,
      night_encounter: {
        night_active: this.nightActive,
        night_elapsed: Math.round(this.nightElapsed * 1000) / 1000,
        spawned_wave_count: this.spawnedWaves,
        enemy_active: this.night.active,
        enemy_x: Math.round(this.night.x * 10) / 10,
        enemy_hp: this.night.hp,
        enemy_max_hp: this.night.maxHp,
        enemy_archetype: this.night.archetype,
        current_day_number: this.nightDayNumber,
        west_spawned_count: this.westSpawned,
        west_enemy_active: this.west.active,
        west_enemy_x: Math.round(this.west.x * 10) / 10,
        west_enemy_hp: this.west.hp,
        west_enemy_max_hp: this.west.maxHp,
        settlement_breached: this.settlementBreached,
        first_night_survived: this.firstNightSurvived,
      },
      progression_flags: {
        first_night_survived: this.firstNightSurvived,
        node_states: Object.fromEntries(this.nodeStates),
        tree_states: Object.fromEntries(this.treeHp),
        reign_state: this.reign,
        hearth_level: this.hearthLevel,
        hearth_boost_remaining: Math.round(this.hearthBoost * 100) / 100,
        shipwreck_stage: this.shipwreckStage,
        portal_relic_looted: this.portalLooted,
        shrine_offering_used_today: this.shrineUsedToday,
        era_id: this.eraId(),
      },
    };
  }

  saveGame(): boolean {
    try {
      const payload = JSON.stringify(this.buildSavePayload());
      const existing = localStorage.getItem(SAVE_KEY);
      if (existing) localStorage.setItem(SAVE_BACKUP_KEY, existing);
      localStorage.setItem(SAVE_KEY, payload);
      this.hasSaveCache = true;
      return true;
    } catch {
      return false;
    }
  }

  loadGame(): boolean {
    let raw: string | null = null;
    let recoveredFromBackup = false;
    try {
      raw = localStorage.getItem(SAVE_KEY);
      if (!raw) {
        raw = localStorage.getItem(SAVE_BACKUP_KEY);
        recoveredFromBackup = raw != null;
      }
    } catch {
      raw = null;
    }
    if (!raw) return false;

    let data: Record<string, unknown>;
    try {
      data = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      // primary corrupted — try backup
      try {
        const bak = localStorage.getItem(SAVE_BACKUP_KEY);
        if (bak) {
          data = JSON.parse(bak) as Record<string, unknown>;
          recoveredFromBackup = true;
        } else {
          return false;
        }
      } catch {
        return false;
      }
    }

    const ok = this.applySavePayload(data);
    if (ok && recoveredFromBackup) {
      this.hooks.message("Save file was corrupted — recovered from backup");
    }
    if (ok) {
      this.started = true;
      this.paused = false;
      const unsafe = this.phase !== "daylight";
      if (unsafe) this.setDuskSafety(true);
      this.hooks.message(
        recoveredFromBackup
          ? "Loaded saved kingdom state from backup"
          : "Loaded saved kingdom state from browser storage (slot 0)",
      );
    }
    return ok;
  }

  private applySavePayload(data: Record<string, unknown>): boolean {
    if (typeof data.day_count !== "number" || data.day_count < 1) return false;
    if (typeof data.world_phase !== "string") return false;
    if (!["daylight", "sunset", "night"].includes(data.world_phase)) return false;

    const res = data.resources as Partial<Record<ResourceId, number>> | undefined;
    if (!res || typeof res.gold !== "number") return false;

    const buildings = data.buildings as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(buildings) || buildings.length === 0) return false;
    for (const b of buildings) {
      if (typeof b.id !== "string" || !this.plots.has(b.id)) return false;
      const st = String(b.state);
      if (
        !["PLACEHOLDER", "UNDER_CONSTRUCTION", "COMPLETED", "DAMAGED", "DESTROYED"].includes(st)
      )
        return false;
      const dur = Number(b.durability ?? 0);
      const maxDur = Number(b.max_durability ?? 1);
      if (!Number.isFinite(dur) || dur < 0 || dur > maxDur) return false;
      const prog = Number(b.progress ?? 0);
      if (!Number.isFinite(prog) || prog < 0 || prog > 1) return false;
    }

    const npcs = data.npcs as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(npcs) || npcs.length === 0 || npcs.length > POP.MAX_POPULATION)
      return false;
    for (const n of npcs) {
      if (!["builder", "farmer", "archer", "villager"].includes(String(n.role)))
        return false;
      const px = Number(n.position_x ?? 0);
      if (px < WORLD.MIN_PLAYABLE_X || px > WORLD.MAX_PLAYABLE_X) return false;
    }

    const flags = data.progression_flags as Record<string, unknown> | undefined;
    if (!flags || typeof flags.hearth_level !== "number") return false;

    // --- restore ---
    this.resetState();

    const player = data.player as { position_x?: number; facing_direction?: number } | undefined;
    if (player) {
      this.playerX = clamp(Number(player.position_x ?? 0), WORLD.MIN_PLAYABLE_X, WORLD.MAX_PLAYABLE_X);
      this.facing = Number(player.facing_direction ?? 1) >= 0 ? 1 : -1;
    }

    this.firstNightSurvived = Boolean(flags.first_night_survived);
    const reign = String(flags.reign_state ?? "ACTIVE");
    this.reign = (["ACTIVE", "BREACH_PENALTY", "ISLAND_CLEARED"].includes(reign)
      ? reign
      : "ACTIVE") as ReignState;
    this.hearthLevel = clamp(Math.round(Number(flags.hearth_level)), 1, HEARTH_TIERS.length);
    const boost = Number(flags.hearth_boost_remaining ?? 0);
    this.hearthBoost = Number.isFinite(boost)
      ? clamp(boost, 0, HEARTH.BOOST_DURATION_SEC)
      : 0;
    this.shipwreckStage = clamp(Math.round(Number(flags.shipwreck_stage ?? 0)), 0, 3);
    this.portalLooted = Boolean(flags.portal_relic_looted);
    this.shrineUsedToday = Boolean(flags.shrine_offering_used_today);
    // Era: pakai era tersimpan; save lama (sebelum sistem era) diinferensi dari
    // bangunan batu — Iron Age tidak pernah diinferensi (hanya lewat Shipwreck 3).
    const savedEra = String(flags.era_id ?? "");
    if (savedEra) {
      this.applySaveEra(savedEra);
    } else {
      const buildingsArr = Array.isArray(data.buildings) ? data.buildings : [];
      const hasStoneWall = buildingsArr.some(
        (b) =>
          b &&
          typeof b === "object" &&
          (b as Record<string, unknown>).type === "stone_wall",
      );
      this.applySaveEra(hasStoneWall ? "stone_age" : "wood_age");
    }

    const nodeStates = flags.node_states as Record<string, boolean> | undefined;
    if (nodeStates && typeof nodeStates === "object") {
      for (const [k, v] of Object.entries(nodeStates)) {
        if (this.nodeStates.has(k)) this.nodeStates.set(k, Boolean(v));
      }
    }
    const treeStates = flags.tree_states as Record<string, number> | undefined;
    if (treeStates && typeof treeStates === "object") {
      for (const [k, v] of Object.entries(treeStates)) {
        if (this.treeHp.has(k)) {
          const t = TREES.find((r) => r.id === k)!;
          this.treeHp.set(k, clamp(Math.round(Number(v)), 0, t.maxHp));
        }
      }
    }

    const nightSave = data.night_encounter as Record<string, unknown> | undefined;
    if (nightSave) {
      this.nightActive = Boolean(nightSave.night_active);
      this.nightElapsed = Math.max(0, Number(nightSave.night_elapsed ?? 0));
      this.spawnedWaves = clamp(Math.round(Number(nightSave.spawned_wave_count ?? 0)), 0, 4);
      this.night.active = Boolean(nightSave.enemy_active);
      this.night.x = Number(nightSave.enemy_x ?? NIGHT.SPAWN_X);
      this.night.hp = Math.max(0, Math.round(Number(nightSave.enemy_hp ?? 0)));
      this.night.maxHp = Math.max(1, Math.round(Number(nightSave.enemy_max_hp ?? 45)));
      const arch = String(nightSave.enemy_archetype ?? "raider");
      this.night.archetype = (["raider", "crawler", "brute"].includes(arch)
        ? arch
        : "raider") as EnemyArchetype;
      this.nightDayNumber = Math.max(
        1,
        Math.round(
          Number(
            nightSave.current_day_number ??
              Math.max(1, Math.round(Number(data.day_count ?? 1))),
          ),
        ),
      );
      this.westSpawned = clamp(Math.round(Number(nightSave.west_spawned_count ?? 0)), 0, 2);
      this.west.active = Boolean(nightSave.west_enemy_active);
      this.west.x = Number(nightSave.west_enemy_x ?? NIGHT.WEST_SPAWN_X);
      this.west.hp = Math.max(0, Math.round(Number(nightSave.west_enemy_hp ?? 0)));
      this.west.maxHp = Math.max(1, Math.round(Number(nightSave.west_enemy_max_hp ?? 45)));
      this.settlementBreached = Boolean(nightSave.settlement_breached);
    }

    this.day = Math.round(Number(data.day_count));
    this.phase = data.world_phase as Phase;
    this.phaseElapsed = clamp(Number(data.world_time ?? 0), 0, this.phaseDuration());

    this.gold = Math.max(0, Math.round(Number(res.gold)));
    this.wood = Math.max(0, Math.round(Number(res.wood ?? 0)));
    this.stone = Math.max(0, Math.round(Number(res.stone ?? 0)));

    for (const b of buildings) {
      const p = this.plot(String(b.id));
      if (!p) continue;
      p.state = String(b.state) as PlotState;
      p.level = clamp(Math.round(Number(b.level ?? 1)), 1, 2);
      p.type = String(b.type ?? p.type);
      p.progress = clamp(Number(b.progress ?? 0), 0, 1);
      p.maxDurability = Math.max(1, Math.round(Number(b.max_durability ?? p.maxDurability)));
      p.durability = clamp(Math.round(Number(b.durability ?? 0)), 0, p.maxDurability);
    }

    const primary = this.agents[0];
    const restoredAgents: Agent[] = [];
    for (const n of npcs) {
      const base = restoredAgents.length === 0 ? primary : { ...primary };
      base.id = String(n.id);
      base.recruited = Boolean(n.recruited);
      base.role = String(n.role) as NpcRole;
      base.state = String(n.state) as Agent["state"];
      base.x = Number(n.position_x ?? NPC.CAMP_X);
      base.farmTimer = clamp(Number(n.farm_timer ?? 0), 0, NPC.FARMER_HARVEST_SEC);
      base.task = "";
      base.targetX = NPC.SAFE_ZONE_X;
      restoredAgents.push(base);
    }
    this.agents = restoredAgents;
    this.campVagrants = clamp(
      Math.round(Number(data.camp_vagrants_available ?? POP.MAX_CAMP_VAGRANTS)),
      0,
      POP.MAX_CAMP_VAGRANTS,
    );

    return true;
  }

  // ==========================================================================
  // HUD snapshot
  // ==========================================================================

  private populationSummary(): string {
    const counts = new Map<NpcRole, number>();
    let idle = 0;
    for (const a of this.agents) {
      if (!a.recruited) continue;
      counts.set(a.role, (counts.get(a.role) ?? 0) + 1);
      if (a.state === "IDLE") idle += 1;
    }
    const parts: string[] = [];
    for (const role of ["builder", "farmer", "archer", "villager"] as NpcRole[]) {
      const c = counts.get(role);
      if (c) parts.push(`${c} ${role.charAt(0).toUpperCase()}${role.slice(1)}`);
    }
    const detail = parts.length ? parts.join(", ") : "none";
    return `NPCs: ${this.recruitedCount()} (${detail}) | Idle: ${idle} | Vagrants: ${this.campVagrants}`;
  }

  getActiveTarget(): ActiveTarget {
    return this.activeTarget;
  }

  getSnapshot(): Snapshot {
    const tgt = this.activeTarget;
    let alert = "";
    if (this.night.active) {
      alert = `ALERT: ${ENEMY_ARCHETYPES[this.night.archetype].name} (${this.night.hp}/${this.night.maxHp} HP) at x=${Math.round(this.night.x)}`;
    } else if (this.west.active) {
      alert = "ALERT: Greedling raiders inbound!";
    }
    if (this.west.active) {
      alert += ` | West Scout (${this.west.hp}/${this.west.maxHp} HP) at x=${Math.round(this.west.x)}`;
    }
    let promptKey = "";
    let promptUpgradeText = "";
    if (tgt.hasTarget && tgt.primaryCommand) {
      promptKey = "E";
      promptUpgradeText = tgt.prompt;
    } else if (tgt.hasTarget && tgt.upgradeCommand) {
      promptKey = "Q";
      promptUpgradeText = tgt.prompt;
    }
    return {
      started: this.started,
      paused: this.paused,
      day: this.day,
      phase: this.phase,
      phaseProgress: this.phaseProgress,
      timeScale: this.timeScale,
      gold: this.gold,
      wood: this.wood,
      stone: this.stone,
      reign: this.reign,
      hearthLevel: this.hearthLevel,
      hearthTierName: this.hearthTier().name,
      hearthBoost: this.hearthBoost,
      flareActive: this.flareTimer > 0,
      flareCooldown: this.flareCooldown,
      shipwreckStage: this.shipwreckStage,
      portalLooted: this.portalLooted,
      shrineUsedToday: this.shrineUsedToday,
      campVagrants: this.campVagrants,
      firstNightSurvived: this.firstNightSurvived,
      nightActive: this.nightActive,
      forecast: this.getNightForecast(this.day),
      alert,
      population: this.populationSummary(),
      prompt: promptUpgradeText,
      promptKey,
      promptUpgradeKey: tgt.hasTarget && tgt.upgradeCommand ? "Q" : "",
      promptUpgradeText: tgt.hasTarget && tgt.upgradeCommand ? `Press [Q] to upgrade ${tgt.targetId}` : "",
      agents: this.agents
        .filter((a) => a.recruited)
        .map((a) => ({ id: a.id, role: a.role, state: a.state, recruited: a.recruited })),
      era: this.eraName(),
      hasSave: this.hasSaveCache,
    };
  }

  emitSnapshot() {
    this.activeTarget = this.resolveTarget(this.playerX);
  }
}

const PLAYER_SPEED = 240.0;

function plotTitle(plotId: string): string {
  // Title dari konfigurasi plot (PLOT_SEEDS, cermin data/buildings.json).
  const seed = PLOT_SEEDS.find((s) => s.id === plotId);
  return seed?.title ?? plotId;
}

function costLabel(cost: Partial<Record<ResourceId, number>>): string {
  const parts: string[] = [];
  if (cost.gold) parts.push(`${cost.gold}G`);
  if (cost.wood) parts.push(`${cost.wood}W`);
  if (cost.stone) parts.push(`${cost.stone}S`);
  return parts.length ? parts.join(" ") : "Free";
}

function standCostLabel(cost: Partial<Record<ResourceId, number>>): string {
  return costLabel(cost);
}
