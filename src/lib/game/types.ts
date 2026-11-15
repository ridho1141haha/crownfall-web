// Crownfall: The Last Light — web port shared types
// Ported from the original Godot 4 project (github.com/ridho1141haha/crownfall)

export type Phase = "daylight" | "sunset" | "night";

export type PlotState =
  | "PLACEHOLDER"
  | "UNDER_CONSTRUCTION"
  | "COMPLETED"
  | "DAMAGED"
  | "DESTROYED";

export type ResourceId = "gold" | "wood" | "stone";

export type NpcRole = "villager" | "builder" | "farmer" | "archer";

export type NpcState =
  | "UNRECRUITED"
  | "IDLE"
  | "MOVING_TO_TASK"
  | "WORKING"
  | "RETURNING_TO_SAFETY";

export type ReignState = "ACTIVE" | "BREACH_PENALTY" | "ISLAND_CLEARED";

export type EnemyArchetype = "raider" | "crawler" | "brute";

export interface Plot {
  id: string;
  type: string;
  x: number;
  level: number;
  state: PlotState;
  progress: number;
  durability: number;
  maxDurability: number;
  buildDuration: number;
  buildCost: Partial<Record<ResourceId, number>>;
  repairCost: Partial<Record<ResourceId, number>>;
  supportDamage?: number;
  harvestInterval?: number;
  goldYield?: number;
  upgradeThornDamage?: number;
  claimedBy: string;
}

export interface ResourceNodeDef {
  id: string;
  resource: ResourceId;
  amount: number;
  x: number;
  renewable: boolean;
  label: string;
  prompt: string;
  frame: number;
}

export interface TreeDef {
  id: string;
  x: number;
  maxHp: number;
  woodYield: number;
}

export interface Agent {
  id: string;
  recruited: boolean;
  role: NpcRole;
  state: NpcState;
  x: number;
  task: string;
  targetX: number;
  facing: number;
  farmTimer: number;
  archerCooldown: number;
  repairAccumulator: number;
}

export interface EnemyState {
  active: boolean;
  x: number;
  hp: number;
  maxHp: number;
  archetype: EnemyArchetype;
  attackTimer: number;
  burnAccumulator: number;
}

export interface FloatText {
  id: number;
  x: number;
  text: string;
  color: string;
  age: number;
}

export interface ActiveTarget {
  hasTarget: boolean;
  kind: string;
  targetId: string;
  primaryCommand: string;
  upgradeCommand: string;
  prompt: string;
}

export interface Snapshot {
  started: boolean;
  paused: boolean;
  day: number;
  phase: Phase;
  phaseProgress: number;
  timeScale: number;
  gold: number;
  wood: number;
  stone: number;
  reign: ReignState;
  hearthLevel: number;
  hearthTierName: string;
  hearthBoost: number;
  flareActive: boolean;
  flareCooldown: number;
  shipwreckStage: number;
  portalLooted: boolean;
  shrineUsedToday: boolean;
  campVagrants: number;
  firstNightSurvived: boolean;
  nightActive: boolean;
  forecast: string;
  alert: string;
  population: string;
  prompt: string;
  promptKey: string;
  promptUpgradeKey: string;
  promptUpgradeText: string;
  agents: Array<{
    id: string;
    role: NpcRole;
    state: NpcState;
    recruited: boolean;
  }>;
  hasSave: boolean;
}
