// Crownfall: The Last Light — game data & constants
// Faithfully ported from data/*.json and GDScript constants of the original
// Godot 4 project (github.com/ridho1141haha/crownfall), v1.4.2.

import type {
  EnemyArchetype,
  Plot,
  ResourceId,
  ResourceNodeDef,
  TreeDef,
} from "./types";

export const WORLD = {
  MIN_X: -1600,
  MAX_X: 1600,
  MIN_PLAYABLE_X: -1540,
  MAX_PLAYABLE_X: 1540,
} as const;

// Camera (mirrors Player.tscn Camera2D)
export const CAMERA = {
  ZOOM: 1.5,
  Y_OFFSET: -64,
  SMOOTHING: 6,
} as const;

export const VIEW = {
  WIDTH: 1280,
  HEIGHT: 720,
} as const;

// TimeManager.gd
export const TIME = {
  DAYLIGHT_DURATION: 480.0,
  SUNSET_DURATION: 60.0,
  NIGHT_DURATION: 180.0,
  FAST_SCALE: 20.0,
} as const;

// Player.gd
export const PLAYER = {
  SPEED: 240.0,
} as const;

// EconomyLedger starting balances (ForgottenShoreSession.gd)
export const START_BALANCES: Record<ResourceId, number> = {
  gold: 2,
  wood: 2,
  stone: 1,
};

// ResourceNodeManager.gd / data/resource_nodes.json
export const RESOURCE_INTERACT_RANGE = 72.0;
export const RESOURCE_NODES: ResourceNodeDef[] = [
  {
    id: "cache_gold_west",
    resource: "gold",
    amount: 4,
    x: -480.0,
    renewable: false,
    label: "Ancient Coin Chest (+4 Gold)",
    prompt: "[E] Chest +4G",
    frame: 0,
  },
  {
    id: "timber_pile_west",
    resource: "wood",
    amount: 5,
    x: -110.0,
    renewable: true,
    label: "Fallen Timber (+5 Wood)",
    prompt: "[E] Timber +5W",
    frame: 1,
  },
  {
    id: "stone_deposit_west",
    resource: "stone",
    amount: 3,
    x: -600.0,
    renewable: true,
    label: "Stone Quarry (+3 Stone)",
    prompt: "[E] Quarry +3S",
    frame: 2,
  },
  {
    id: "stone_outcrop_east",
    resource: "stone",
    amount: 3,
    x: 190.0,
    renewable: true,
    label: "Ruined Masonry (+3 Stone)",
    prompt: "[E] Masonry +3S",
    frame: 2,
  },
  {
    id: "shrine_cache_far_west",
    resource: "gold",
    amount: 3,
    x: -780.0,
    renewable: false,
    label: "Forgotten Shrine (+3 Gold)",
    prompt: "[E] Shrine +3G",
    frame: 3,
  },
];

// ForestTreeManager.gd
export const TREE_INTERACT_RANGE = 72.0;
export const TREES: TreeDef[] = [
  { id: "tree_west_01", x: -680.0, maxHp: 3, woodYield: 4 },
  { id: "tree_west_02", x: -940.0, maxHp: 3, woodYield: 4 },
  { id: "tree_west_03", x: -1080.0, maxHp: 3, woodYield: 4 },
  { id: "tree_east_01", x: 540.0, maxHp: 3, woodYield: 4 },
  { id: "tree_east_02", x: 690.0, maxHp: 3, woodYield: 4 },
  { id: "tree_east_03", x: 960.0, maxHp: 3, woodYield: 4 },
];

// Background forest decoration trees (ForgottenShoreSession._setup_forest_visuals)
export const BG_TREES: number[] = [
  -1220.0, -1150.0, -860.0, -720.0, -540.0, 460.0, 610.0, 770.0, 880.0, 1120.0,
];

// BuildingManager.gd + data/buildings.json
export const BUILDING_INTERACT_RANGE = 96.0;
export const WALL_ID = "wall_east_01";
export const WEST_WALL_ID = "wall_west_01";
export const WATCHTOWER_ID = "watchtower_east_01";
export const FARM_WEST_ID = "farm_west_01";
export const FARM_EAST_ID = "farm_east_01";

export const STONE_WALL_UPGRADE_COST: Partial<Record<ResourceId, number>> = {
  gold: 3,
  wood: 2,
  stone: 5,
};
export const STONE_WALL_MAX_DURABILITY = 260;

type PlotSeed = Omit<Plot, "level" | "state" | "progress" | "claimedBy"> & {
  level?: number;
};

export const PLOT_SEEDS: PlotSeed[] = [
  {
    id: WALL_ID,
    type: "wooden_wall",
    x: 380.0,
    durability: 0,
    maxDurability: 150,
    buildDuration: 4.0,
    buildCost: { gold: 2, wood: 4, stone: 2 },
    repairCost: { wood: 2, stone: 1 },
    upgradeThornDamage: 20,
  },
  {
    id: WATCHTOWER_ID,
    type: "watchtower",
    x: 210.0,
    durability: 0,
    maxDurability: 120,
    buildDuration: 3.5,
    buildCost: { gold: 3, wood: 3, stone: 3 },
    repairCost: { wood: 2, stone: 1 },
    supportDamage: 10,
  },
  {
    id: FARM_EAST_ID,
    type: "farm_plot",
    x: 120.0,
    durability: 0,
    maxDurability: 80,
    buildDuration: 3.5,
    buildCost: { gold: 3, wood: 4 },
    repairCost: { wood: 2 },
    harvestInterval: 60.0,
    goldYield: 2,
  },
  {
    id: FARM_WEST_ID,
    type: "farm_plot",
    x: -310.0,
    durability: 0,
    maxDurability: 80,
    buildDuration: 3.5,
    buildCost: { gold: 3, wood: 4 },
    repairCost: { wood: 2 },
    harvestInterval: 60.0,
    goldYield: 2,
  },
  {
    id: WEST_WALL_ID,
    type: "wooden_wall",
    x: -400.0,
    durability: 0,
    maxDurability: 150,
    buildDuration: 4.0,
    buildCost: { gold: 2, wood: 4, stone: 2 },
    repairCost: { wood: 2, stone: 1 },
    upgradeThornDamage: 20,
  },
];

// data/enemies.json
export const ENEMY_ARCHETYPES: Record<
  EnemyArchetype,
  { name: string; hp: number; speed: number; damage: number }
> = {
  raider: { name: "Greedling Raider", hp: 45, speed: 95.0, damage: 15 },
  crawler: { name: "Shadow Crawler", hp: 45, speed: 135.0, damage: 12 },
  brute: { name: "Gloom Brute", hp: 160, speed: 55.0, damage: 35 },
};

export const NIGHT = {
  SPAWN_X: 820.0,
  WEST_SPAWN_X: -820.0,
  TOWN_CENTER_X: 0.0,
  ATTACK_RANGE: 26.0,
  ATTACK_INTERVAL: 1.0,
  WALL_THORN_DAMAGE: 15,
  BASE_THORN_DAMAGE: 5,
  KILL_GOLD_REWARD: 1,
  WAVE_SPAWN_TIMES: [0.0, 55.0, 110.0],
  ESCALATED_WAVE_TIMES: [0.0, 42.0, 84.0, 126.0],
  WEST_SCOUT_TIMES: [20.0, 90.0],
  BREACH_EPSILON: 8.0,
  MAKESHIFT_MIN_HP: 15,
  MAKESHIFT_HP_FACTOR: 80.0,
  CONSTRUCTION_BARRIER_PROGRESS: 0.25,
} as const;

// HearthSystem.gd + data/lighting.json
export const HEARTH = {
  X: 0.0,
  INTERACT_RANGE: 80.0,
  BOOST_RADIUS_MULT: 1.3,
  BOOST_BURN_ADD: 2.0,
  BOOST_DURATION_SEC: 60.0,
  BOOST_COST: { wood: 1 } as Partial<Record<ResourceId, number>>,
} as const;

export const HEARTH_TIERS = [
  {
    level: 1,
    name: "Ember Hearth",
    radiusPx: 180.0,
    textureScale: 2.6,
    burnDps: 2.0,
    weakenedPct: 0.2,
    upgradeCost: {} as Partial<Record<ResourceId, number>>,
  },
  {
    level: 2,
    name: "Beacon Fire",
    radiusPx: 320.0,
    textureScale: 4.2,
    burnDps: 2.0,
    weakenedPct: 0.2,
    upgradeCost: { gold: 4, wood: 4, stone: 2 } as Partial<
      Record<ResourceId, number>
    >,
  },
  {
    level: 3,
    name: "Solar Brazier",
    radiusPx: 460.0,
    textureScale: 5.8,
    burnDps: 4.0,
    weakenedPct: 0.2,
    upgradeCost: { gold: 6, wood: 5, stone: 4 } as Partial<
      Record<ResourceId, number>
    >,
  },
] as const;

export const WATCHTOWER_LIGHT_RADIUS = 110.0;

// NPCBuilderAgent.gd
export const NPC = {
  RECRUIT_COST: { gold: 2 } as Partial<Record<ResourceId, number>>,
  CAMP_X: -220.0,
  SAFE_ZONE_X: 0.0,
  MOVE_SPEED: 130.0,
  WORK_RANGE: 28.0,
  REPAIR_RATE_PER_SEC: 18.0,
  FARMER_HARVEST_SEC: 60.0,
  FARMER_GOLD_YIELD: 2,
  ARCHER_FIRE_INTERVAL: 1.0,
  ARCHER_BASE_DAMAGE: 20,
  ARCHER_GROUND_RANGE: 240.0,
  ARCHER_TOWER_RANGE: 360.0,
  ARCHER_PURSUIT_GAP: 190.0,
  ARCHER_PURSUIT_WEST_LIMIT: -600.0,
  ENEMY_GRAB_RANGE: 24.0,
  RECRUIT_RANGE: 96.0,
} as const;

// NPCPopulationManager.gd
export const POP = {
  MAX_POPULATION: 6,
  MAX_CAMP_VAGRANTS: 2,
  STAND_RANGE: 64.0,
  CAMP_RANGE: 90.0,
  TOOL_STANDS: {
    hammer_stand: { x: -45.0, role: "builder" as const, cost: {} },
    scythe_stand: {
      x: -90.0,
      role: "farmer" as const,
      cost: { gold: 1, stone: 1 } as Partial<Record<ResourceId, number>>,
    },
    bow_stand: {
      x: 45.0,
      role: "archer" as const,
      cost: { gold: 1, wood: 1 } as Partial<Record<ResourceId, number>>,
    },
  },
} as const;

// Landmarks (ForgottenShoreSession.gd)
export const SHIPWRECK = {
  X: -1350.0,
  RANGE: 96.0,
  COSTS: [
    { gold: 2, wood: 3, stone: 1 },
    { gold: 2, wood: 3, stone: 2 },
    { gold: 2, wood: 2, stone: 1 },
  ] as Array<Partial<Record<ResourceId, number>>>,
} as const;

export const PORTAL = {
  X: 1350.0,
  RANGE: 96.0,
  REWARD: { gold: 3, stone: 2 } as Partial<Record<ResourceId, number>>,
} as const;

export const SHRINE_OFFERING = {
  X: -780.0,
  COST: { wood: 4, stone: 2 } as Partial<Record<ResourceId, number>>,
  REWARD: 2,
} as const;

// Kindle flare (session)
export const FLARE = {
  ACTIVE_SEC: 8.0,
  COOLDOWN_SEC: 25.0,
  COST: { wood: 1 } as Partial<Record<ResourceId, number>>,
  LIGHT_MULT: 1.5,
} as const;

// Monarch light risk (session)
export const LIGHT_RISK = {
  STAGGER_COOLDOWN: 2.0,
  ENEMY_PROXIMITY: 44.0,
  PUSH_DISTANCE: 48.0,
} as const;

// WorldConstants
export const MIN_PLAYABLE_X = WORLD.MIN_PLAYABLE_X;
export const MAX_PLAYABLE_X = WORLD.MAX_PLAYABLE_X;

// Sky palette (SkyAtmosphere.gd)
export const SKY = {
  DAY: "#386b9e",
  SUNSET: "#944238",
  NIGHT: "#0d1224",
} as const;

export const WORLD_TINT = {
  DAY: { r: 255, g: 255, b: 255 },
  SUNSET: { r: 242, g: 173, b: 143 },
  NIGHT: { r: 71, g: 87, b: 133 },
} as const;

// Asset paths (public/)
export const ASSETS = {
  monarch: "/assets/characters/player/player_monarch_sheet.png",
  builder: "/assets/characters/npc/npc_builder_sheet.png",
  farmer: "/assets/characters/npc/npc_farmer_sheet.png",
  archer: "/assets/characters/npc/npc_archer_sheet.png",
  raider: "/assets/enemies/first_enemy/enemy_greedling_raider_sheet.png",
  townCenter: "/assets/buildings/town_center/building_town_center_sheet.png",
  tent: "/assets/buildings/camp/building_vagrant_tent.png",
  wall: "/assets/buildings/wooden_wall/building_wooden_wall_states.png",
  watchtower: "/assets/buildings/watchtower/building_watchtower_states.png",
  farm: "/assets/buildings/farm_plot/building_farm_plot_states.png",
  stands: "/assets/buildings/tool_stands/props_tool_stands.png",
  ship: "/assets/buildings/shipwreck/building_shipwreck_stages.png",
  portal: "/assets/environment/landmarks/env_greed_portal.png",
  tree: "/assets/environment/vegetation/env_pine_tree_states.png",
  items: "/assets/items/resources/items_resources_sheet.png",
  terrain: "/assets/environment/terrain/terrain_shore_tile.png",
  mountains: "/assets/environment/backgrounds/bg_mountains_far.png",
  forestBg: "/assets/environment/backgrounds/bg_forest_mid.png",
  sfxCoin: "/assets/audio/sfx_coin.wav",
  sfxBuild: "/assets/audio/sfx_build.wav",
  sfxHit: "/assets/audio/sfx_hit.wav",
  sfxBow: "/assets/audio/sfx_bow.wav",
  sfxSunset: "/assets/audio/sfx_sunset.wav",
  sfxNight: "/assets/audio/sfx_night.wav",
} as const;

export const SAVE_SCHEMA_VERSION = 3;
export const SAVE_KEY = "crownfall_save_slot_0";
export const SAVE_BACKUP_KEY = "crownfall_save_slot_0_bak";
