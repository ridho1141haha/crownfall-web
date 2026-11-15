// Crownfall web port — canvas renderer.
// Recreates the Godot scene graph rendering: sky gradient, parallax bands,
// terrain, world objects with the original sprite sheets, phase tint
// (CanvasModulate), hearth light glow (PointLight2D), vignette, labels & FX.

import { ASSETS, BG_TREES, CAMERA, SKY, VIEW, WORLD_TINT } from "./data";
import type { GameEngine } from "./engine";
import type { Plot } from "./types";

type ImgMap = Record<string, HTMLImageElement | HTMLCanvasElement>;

const WALL_LABEL_COST = "2G 4W 2S";

// Sprite frame metadata: [key, frameWidth, frameHeight, offsetX, offsetY]
// offsetX/offsetY mirror the Godot Sprite2D `offset` (texture top-left anchor).
const SPR = {
  monarch: { key: "monarch", fw: 32, fh: 32, ox: 16, oy: 32 },
  npc: { key: "builder", fw: 32, fh: 32, ox: 16, oy: 32 },
  raider: { key: "raider", fw: 32, fh: 32, ox: 16, oy: 32 },
  town: { key: "townCenter", fw: 48, fh: 48, ox: 24, oy: 48 },
  tent: { key: "tent", fw: 48, fh: 32, ox: 24, oy: 32 },
  wall: { key: "wall", fw: 32, fh: 48, ox: 16, oy: 48 },
  tower: { key: "watchtower", fw: 32, fh: 48, ox: 16, oy: 48 },
  farm: { key: "farm", fw: 32, fh: 32, ox: 16, oy: 32 },
  stands: { key: "stands", fw: 32, fh: 32, ox: 16, oy: 32 },
  ship: { key: "ship", fw: 64, fh: 48, ox: 32, oy: 48 },
  portal: { key: "portal", fw: 48, fh: 48, ox: 24, oy: 48 },
  tree: { key: "tree", fw: 48, fh: 64, ox: 24, oy: 64 },
  items: { key: "items", fw: 32, fh: 32, ox: 16, oy: 32 },
} as const;

const NODE_FRAME: Record<string, number> = {
  cache_gold_west: 0,
  timber_pile_west: 1,
  stone_deposit_west: 2,
  stone_outcrop_east: 2,
  shrine_cache_far_west: 3,
};

const STAND_FRAME: Record<string, number> = {
  hammer_stand: 0,
  scythe_stand: 1,
  bow_stand: 2,
};

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}
function lerpColor(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
  t: number,
): [number, number, number] {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}
function rgbStr(c: [number, number, number]) {
  return `rgb(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])})`;
}
function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

function makeTinted(img: HTMLImageElement, color: string): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = img.width;
  c.height = img.height;
  const g = c.getContext("2d")!;
  g.drawImage(img, 0, 0);
  g.globalCompositeOperation = "source-atop";
  g.fillStyle = color;
  g.globalAlpha = 0.55;
  g.fillRect(0, 0, c.width, c.height);
  return c;
}

export class Renderer {
  images: ImgMap = {};
  tinted: ImgMap = {};
  ready = false;

  async load(onReady?: () => void) {
    const paths: Record<string, string> = {
      monarch: ASSETS.monarch,
      builder: ASSETS.builder,
      farmer: ASSETS.farmer,
      archer: ASSETS.archer,
      raider: ASSETS.raider,
      townCenter: ASSETS.townCenter,
      tent: ASSETS.tent,
      wall: ASSETS.wall,
      watchtower: ASSETS.watchtower,
      farm: ASSETS.farm,
      stands: ASSETS.stands,
      ship: ASSETS.ship,
      portal: ASSETS.portal,
      tree: ASSETS.tree,
      items: ASSETS.items,
      terrain: ASSETS.terrain,
      mountains: ASSETS.mountains,
      forestBg: ASSETS.forestBg,
    };
    const entries = Object.entries(paths);
    await Promise.all(
      entries.map(
        ([key, src]) =>
          new Promise<void>((resolve) => {
            const img = new Image();
            img.onload = () => {
              this.images[key] = img;
              resolve();
            };
            img.onerror = () => resolve();
            img.src = src;
          }),
      ),
    );
    const raider = this.images.raider;
    if (raider instanceof HTMLImageElement) {
      this.tinted.brute = makeTinted(raider, "#a05cd0");
      this.tinted.crawler = makeTinted(raider, "#e58a94");
    }
    this.ready = true;
    onReady?.();
  }

  private frame(
    sheet: HTMLImageElement | HTMLCanvasElement | undefined,
    meta: { fw: number; fh: number; ox: number; oy: number },
    frame: number,
    worldX: number,
    camLeft: number,
    camTop: number,
    zoom: number,
    opts: { scale?: number; scaleY?: number; alpha?: number; flip?: boolean } = {},
  ) {
    if (!sheet) return;
    const { fw, fh, ox, oy } = meta;
    const scale = opts.scale ?? 1;
    const scaleY = opts.scaleY ?? scale;
    const w = fw * zoom * scale;
    const h = fh * zoom * scaleY;
    const leftWorld = worldX - ox * scale;
    const topWorld = -(oy * scaleY);
    const sx = (leftWorld - camLeft) * zoom;
    const sy = (topWorld - camTop) * zoom;
    const alpha = opts.alpha ?? 1;
    if (alpha <= 0) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = alpha;
    if (opts.flip) {
      ctx.translate(sx + w, sy);
      ctx.scale(-1, 1);
      ctx.drawImage(sheet, frame * fw, 0, fw, fh, 0, 0, w, h);
    } else {
      ctx.drawImage(sheet, frame * fw, 0, fw, fh, sx, sy, w, h);
    }
    ctx.restore();
  }

  private ctx!: CanvasRenderingContext2D;
  private canvasW = VIEW.WIDTH;
  private canvasH = VIEW.HEIGHT;
  private camLeft = 0;
  private camTop = 0;
  private zoom = CAMERA.ZOOM;

  private w2sX(wx: number) {
    return (wx - this.camLeft) * this.zoom;
  }
  private w2sY(wy: number) {
    return (wy - this.camTop) * this.zoom;
  }

  private label(
    wx: number,
    wy: number,
    text: string,
    color = "#ffffff",
    opts: { bg?: boolean; size?: number; alpha?: number; maxWidth?: number } = {},
  ) {
    const ctx = this.ctx;
    const size = opts.size ?? 11;
    ctx.save();
    ctx.globalAlpha = opts.alpha ?? 1;
    ctx.font = `${size}px "Courier New", monospace`;
    ctx.textAlign = "center";
    const lines = text.split("\n");
    const lineH = size + 2;
    const x = this.w2sX(wx);
    const y0 = this.w2sY(wy);
    lines.forEach((line, i) => {
      const y = y0 + i * lineH;
      if (opts.bg !== false) {
        const w = Math.min(ctx.measureText(line).width + 8, opts.maxWidth ?? 1000);
        ctx.fillStyle = "rgba(8, 10, 16, 0.72)";
        ctx.fillRect(x - w / 2, y - size - 1, w, lineH);
        ctx.strokeStyle = "rgba(255,255,255,0.14)";
        ctx.lineWidth = 1;
        ctx.strokeRect(x - w / 2, y - size - 1, w, lineH);
      }
      ctx.fillStyle = color;
      ctx.fillText(line, x, y);
    });
    ctx.restore();
  }

  private bar(
    wx: number,
    wy: number,
    widthPx: number,
    ratio: number,
    fg: string,
    bg = "rgba(0,0,0,0.6)",
  ) {
    const ctx = this.ctx;
    const x = this.w2sX(wx) - widthPx / 2;
    const y = this.w2sY(wy);
    ctx.save();
    ctx.fillStyle = bg;
    ctx.fillRect(x, y, widthPx, 5);
    ctx.fillStyle = fg;
    ctx.fillRect(x, y, widthPx * Math.max(0, Math.min(1, ratio)), 5);
    ctx.restore();
  }

  draw(engine: GameEngine, ctx: CanvasRenderingContext2D, w: number, h: number) {
    this.ctx = ctx;
    this.canvasW = w;
    this.canvasH = h;
    const zoom = CAMERA.ZOOM;
    this.zoom = zoom;
    const viewW = w / zoom;
    const viewH = h / zoom;

    // --- camera ---
    const half = viewW / 2;
    let camX = engine.playerX;
    camX = Math.max(WORLD_MIN + half, Math.min(WORLD_MAX - half, camX));
    const camY = CAMERA.Y_OFFSET;
    let shakeX = 0;
    let shakeY = 0;
    if (engine.shakeTime > 0) {
      const i = engine.shakeIntensity;
      shakeX = (Math.random() * 2 - 1) * i;
      shakeY = (Math.random() * 2 - 1) * i;
    }
    this.camLeft = camX - half + shakeX / zoom;
    this.camTop = camY - viewH / 2 + shakeY / zoom;
    const camLeft = this.camLeft;
    const camTop = this.camTop;

    // --- phase color logic (SkyAtmosphere.gd) ---
    const prog = engine.phaseProgress;
    const DAY = hexToRgb(SKY.DAY);
    const SUNSET = hexToRgb(SKY.SUNSET);
    const NIGHT = hexToRgb(SKY.NIGHT);
    const DAY_T = WORLD_TINT.DAY;
    const SUNSET_T = WORLD_TINT.SUNSET;
    const NIGHT_T = WORLD_TINT.NIGHT;
    let sky: [number, number, number];
    let tint: [number, number, number];
    if (engine.phase === "daylight") {
      const k = smoothstep(0.75, 1, prog);
      sky = lerpColor(DAY, SUNSET, k);
      tint = lerpColor(DAY_T, SUNSET_T, k);
    } else if (engine.phase === "sunset") {
      sky = lerpColor(SUNSET, NIGHT, prog);
      tint = lerpColor(SUNSET_T, NIGHT_T, prog);
    } else {
      const k = smoothstep(0.82, 1, prog);
      sky = lerpColor(NIGHT, DAY, k);
      tint = lerpColor(NIGHT_T, DAY_T, k);
    }

    ctx.imageSmoothingEnabled = false;

    // --- sky ---
    const skyGrad = ctx.createLinearGradient(0, 0, 0, h);
    skyGrad.addColorStop(0, rgbStr(sky));
    skyGrad.addColorStop(1, rgbStr(sky.map((v) => Math.min(255, v * 1.18)) as [number, number, number]));
    ctx.fillStyle = skyGrad;
    ctx.fillRect(0, 0, w, h);

    // --- parallax: mountains (motion 0.18) & forest (motion 0.42) ---
    this.drawParallax(this.images.mountains, 0.18, -130, 256, 96, 1.4, 0.9);
    this.drawParallax(this.images.forestBg, 0.42, -96, 256, 96, 1.0, 1.0);

    // --- ground ---
    const terrain = this.images.terrain;
    const tileW = 32 * zoom;
    const groundTop = this.w2sY(0);
    const tileH = 32 * zoom;
    const startTile = Math.floor(camLeft / 32) * 32;
    for (let wx = startTile; wx < camLeft + viewW + 32; wx += 32) {
      const sx = (wx - camLeft) * zoom;
      if (terrain) {
        ctx.drawImage(terrain, sx, groundTop, tileW, tileH);
      } else {
        ctx.fillStyle = "#7a6a4f";
        ctx.fillRect(sx, groundTop, tileW, tileH);
      }
    }
    // deep soil
    ctx.fillStyle = "#382820";
    ctx.fillRect(0, groundTop + tileH, w, Math.max(0, h - groundTop - tileH));
    // ground edge line
    ctx.fillStyle = "rgba(0,0,0,0.25)";
    ctx.fillRect(0, groundTop, w, 2);

    // --- background forest decoration (z_index -1) ---
    for (const dx of BG_TREES) {
      if (dx < camLeft - 60 || dx > camLeft + viewW + 60) continue;
      this.frame(this.images.tree, SPR.tree, 0, dx, camLeft, camTop, zoom, {
        scale: 0.85,
        alpha: 0.72,
      });
    }

    // --- choppable trees (z_index 1, behind objects) ---
    for (const t of engine.treeStatesForRender()) {
      if (t.x < camLeft - 60 || t.x > camLeft + viewW + 60) continue;
      this.frame(this.images.tree, SPR.tree, t.felled ? 1 : 0, t.x, camLeft, camTop, zoom, {
        alpha: t.felled ? 0.5 : 1,
      });
    }

    // --- town center ---
    const townFrame = Math.floor(engine.animTime * 6) % 4;
    this.frame(this.images.townCenter, SPR.town, townFrame, 0, camLeft, camTop, zoom);

    // --- vagrant camp tent ---
    this.frame(this.images.tent, SPR.tent, 0, -220, camLeft, camTop, zoom);

    // --- resource nodes ---
    for (const n of engine.resourceNodesForRender()) {
      if (n.x < camLeft - 60 || n.x > camLeft + viewW + 60) continue;
      this.frame(this.images.items, SPR.items, n.frame, n.x, camLeft, camTop, zoom, {
        alpha: n.collected ? 0.25 : 1,
      });
    }

    // --- tool stands ---
    for (const [sid, sx] of Object.entries(STAND_FRAME)) {
      const wx = sid === "hammer_stand" ? -45 : sid === "scythe_stand" ? -90 : 45;
      if (wx < camLeft - 60 || wx > camLeft + viewW + 60) continue;
      this.frame(this.images.stands, SPR.stands, sx, wx, camLeft, camTop, zoom);
    }

    // --- building plots ---
    for (const p of engine.plots.values()) {
      if (p.x < camLeft - 80 || p.x > camLeft + viewW + 80) continue;
      this.drawPlot(p);
    }

    // --- shipwreck & portal ---
    this.frame(this.images.ship, SPR.ship, Math.min(engine.shipwreckStage, 3), -1350, camLeft, camTop, zoom);
    this.frame(
      this.images.portal,
      SPR.portal,
      engine.reign === "ISLAND_CLEARED" ? 1 : 0,
      1350,
      camLeft,
      camTop,
      zoom,
    );

    // --- NPCs ---
    for (const a of engine.agentsForRender()) {
      const sheetKey =
        a.role === "farmer" ? "farmer" : a.role === "archer" ? "archer" : "builder";
      const sheet = this.images[sheetKey] ?? this.images.builder;
      let frame = 0;
      if (a.state === "WORKING") frame = 4 + (Math.floor(engine.animTime * 8) % 4);
      else if (a.state === "MOVING_TO_TASK" || a.state === "RETURNING_TO_SAFETY")
        frame = Math.floor(engine.animTime * 8) % 4;
      this.frame(sheet, SPR.npc, frame, a.x, camLeft, camTop, zoom, { flip: a.facing < 0 });
      if (a.state === "WORKING" || a.state === "RETURNING_TO_SAFETY") {
        this.label(
          a.x,
          -40,
          a.state === "WORKING" ? `${a.role}: Working` : "Retreating!",
          a.state === "RETURNING_TO_SAFETY" ? "#ffb347" : "#d7e8d0",
          { size: 9, bg: true },
        );
      }
    }

    // --- enemies ---
    if (engine.night.active) {
      this.drawEnemy(engine.night.archetype, engine.night.x, engine.night.hp, engine.night.maxHp, "Greedling");
    }
    if (engine.west.active) {
      this.drawEnemy("raider", engine.west.x, engine.west.hp, engine.west.maxHp, "West Scout", true);
    }

    // --- player ---
    const moving = engine.input.left || engine.input.right;
    let pFrame: number;
    if (moving) pFrame = 4 + (Math.floor(engine.animTime * 10) % 4);
    else pFrame = Math.floor(engine.animTime * 5) % 4;
    this.frame(this.images.monarch, SPR.monarch, pFrame, engine.playerX, camLeft, camTop, zoom, {
      flip: engine.facing < 0,
    });

    // --- phase tint (CanvasModulate) ---
    ctx.save();
    ctx.globalCompositeOperation = "multiply";
    ctx.fillStyle = rgbStr(tint);
    ctx.fillRect(0, 0, w, h);
    ctx.restore();

    // --- hearth light glow (PointLight2D) ---
    const inDay = engine.phase === "daylight";
    const flicker = Math.sin(engine.animTime * 9) * 0.12;
    const energy = (inDay ? 0.75 : 1.45) + flicker;
    const hearthScreenX = this.w2sX(0);
    const hearthScreenY = this.w2sY(-14);
    const radius = engine.hearthEffectiveRadius() * zoom;
    const boostActive = engine.hearthBoostRemaining() > 0;
    ctx.save();
    ctx.globalCompositeOperation = "screen";
    const glow = ctx.createRadialGradient(
      hearthScreenX,
      hearthScreenY,
      0,
      hearthScreenX,
      hearthScreenY,
      radius,
    );
    const a = Math.min(1, (inDay ? 0.16 : 0.5) * energy);
    glow.addColorStop(0, `rgba(255, 214, 140, ${a})`);
    glow.addColorStop(0.45, `rgba(255, 170, 70, ${a * 0.5})`);
    glow.addColorStop(1, "rgba(255, 150, 50, 0)");
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, w, h);

    // kindle flare flash
    if (engine.flareActiveRemaining() > 0) {
      const fa = 0.35 + Math.sin(engine.animTime * 14) * 0.08;
      const fg = ctx.createRadialGradient(
        hearthScreenX,
        hearthScreenY,
        0,
        hearthScreenX,
        hearthScreenY,
        radius * 1.4,
      );
      fg.addColorStop(0, `rgba(255, 240, 190, ${fa})`);
      fg.addColorStop(1, "rgba(255, 210, 120, 0)");
      ctx.fillStyle = fg;
      ctx.fillRect(0, 0, w, h);
    }
    if (boostActive) {
      const bg = ctx.createRadialGradient(
        hearthScreenX,
        hearthScreenY,
        0,
        hearthScreenX,
        hearthScreenY,
        radius * 1.3,
      );
      bg.addColorStop(0, "rgba(255, 200, 90, 0.10)");
      bg.addColorStop(1, "rgba(255, 180, 60, 0)");
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, w, h);
    }
    ctx.restore();

    // --- vignette ---
    let vig = 0.16;
    if (engine.phase === "sunset") vig = lerp(0.28, 0.42, prog);
    else if (engine.phase === "night") vig = lerp(0.42, 0.16, prog);
    const vg = ctx.createRadialGradient(
      w / 2,
      h / 2,
      Math.min(w, h) * 0.36,
      w / 2,
      h / 2,
      Math.max(w, h) * 0.72,
    );
    vg.addColorStop(0, "rgba(0,0,0,0)");
    vg.addColorStop(1, `rgba(4, 6, 14, ${vig})`);
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, w, h);

    // --- world labels & prompts (screen-crisp) ---
    this.drawLabels(engine);

    // --- flying payment particles (resources/gold to target) ---
    const PAYMENT_COLORS: Record<string, string> = {
      gold: "#ffd647",
      wood: "#9e6b38",
      stone: "#9ea8b3",
    };
    for (const d of engine.payments) {
      const t = Math.min(1, Math.max(0, (d.age - d.delay) / 0.55));
      if (d.age < d.delay) continue;
      const ease = t * t * (3 - 2 * t);
      const wx = d.fromX + (d.toX - d.fromX) * ease;
      const wy = -38 - 8 * Math.sin(Math.PI * t);
      const alpha = d.age >= d.delay + 0.55 ? Math.max(0, 1 - (d.age - d.delay - 0.55) / 0.12) : 1;
      if (alpha <= 0) continue;
      const sx = this.w2sX(wx);
      const sy = this.w2sY(wy);
      const size = Math.max(4, Math.round(7 * this.zoom * 0.66));
      ctx.globalAlpha = alpha;
      ctx.fillStyle = PAYMENT_COLORS[d.resource] ?? "#ffffff";
      ctx.fillRect(sx - size / 2, sy - size / 2, size, size);
      ctx.globalAlpha = 1;
    }

    // --- floating texts ---
    for (const f of engine.floats) {
      const wy = -48 - (f.age / 0.85) * 30;
      this.label(f.x, wy, f.text, f.color, { size: 11, bg: false, alpha: 1 - f.age / 0.85 });
    }
  }

  private drawParallax(
    img: HTMLImageElement | HTMLCanvasElement | undefined,
    motion: number,
    topWorldY: number,
    tw: number,
    th: number,
    scale: number,
    alpha: number,
  ) {
    if (!img) return;
    const ctx = this.ctx;
    const tileW = tw * this.zoom * scale;
    const tileH = th * this.zoom * scale;
    const sy = this.w2sY(topWorldY);
    const shift = ((-1800 - this.camLeft * motion) * this.zoom) % tileW;
    ctx.save();
    ctx.globalAlpha = alpha;
    for (let x = shift - tileW; x < this.canvasW + tileW; x += tileW) {
      ctx.drawImage(img, x, sy, tileW, tileH);
    }
    ctx.restore();
  }

  private drawPlot(p: Plot) {
    const engine = this.engineRef!;
    const zoom = this.zoom;
    switch (p.type) {
      case "wooden_wall":
      case "stone_wall": {
        let frame = 0;
        switch (p.state) {
          case "UNDER_CONSTRUCTION":
            frame = 1;
            break;
          case "COMPLETED":
            frame = 2;
            break;
          case "DAMAGED":
            frame = 3;
            break;
          default:
            frame = 0;
        }
        const alpha =
          p.state === "PLACEHOLDER" ? 0.75 : p.state === "DESTROYED" ? 0.65 : 1;
        this.frame(this.images.wall, SPR.wall, frame, p.x, this.camLeft, this.camTop, zoom, {
          alpha,
        });
        break;
      }
      case "watchtower": {
        let frame = 0;
        switch (p.state) {
          case "UNDER_CONSTRUCTION":
            frame = 1;
            break;
          case "COMPLETED":
            frame = 2;
            break;
          case "DAMAGED":
            frame = 3;
            break;
          default:
            frame = 0;
        }
        const alpha =
          p.state === "PLACEHOLDER" ? 0.75 : p.state === "DESTROYED" ? 0.65 : 1;
        this.frame(this.images.watchtower, SPR.tower, frame, p.x, this.camLeft, this.camTop, zoom, {
          alpha,
        });
        break;
      }
      case "farm_plot": {
        let frame = 0;
        switch (p.state) {
          case "UNDER_CONSTRUCTION":
            frame = 1;
            break;
          case "COMPLETED":
            frame = 2;
            break;
          case "DAMAGED":
            frame = 3;
            break;
          default:
            frame = 0;
        }
        const alpha =
          p.state === "PLACEHOLDER" ? 0.75 : p.state === "DESTROYED" ? 0.65 : 1;
        this.frame(this.images.farm, SPR.farm, frame, p.x, this.camLeft, this.camTop, zoom, {
          alpha,
        });
        break;
      }
    }
    void engine;
  }

  private drawEnemy(
    archetype: string,
    x: number,
    hp: number,
    maxHp: number,
    title: string,
    west = false,
  ) {
    const zoom = this.zoom;
    const sheet =
      archetype === "brute"
        ? this.tinted.brute
        : archetype === "crawler"
          ? this.tinted.crawler
          : this.images.raider;
    const frame = Math.floor(this.engineRef!.animTime * 8) % 4;
    this.frame(sheet, SPR.raider, frame, x, this.camLeft, this.camTop, zoom, {
      scale: archetype === "brute" ? 1.45 : archetype === "crawler" ? 0.9 : 1,
      scaleY: archetype === "crawler" ? 0.85 : archetype === "brute" ? 1.45 : 1,
      flip: west,
    });
    this.bar(x, -44, 40, hp / maxHp, archetype === "brute" ? "#c07ae8" : "#e0594d");
    this.label(x, -58, `${title} ${hp}/${maxHp}`, "#ffb0a6", { size: 9 });
  }

  private drawLabels(engine: GameEngine) {
    const tgt = engine.getActiveTarget();
    // building status labels (always visible when under construction / damaged;
    // otherwise only when it is the active target — mirrors _update_proximity_prompts)
    for (const p of engine.plots.values()) {
      const isActive = tgt.hasTarget && tgt.kind === "building" && tgt.targetId === p.id;
      const always = p.state === "UNDER_CONSTRUCTION" || p.state === "DAMAGED";
      if (!isActive && !always) continue;
      const col = isActive ? "#fff28c" : "#e8e2cf";
      const cost =
        p.type === "watchtower"
          ? "3G 3W 3S"
          : p.type === "farm_plot"
            ? "3G 4W"
            : WALL_LABEL_COST;
      let text = "";
      switch (p.state) {
        case "PLACEHOLDER":
          text = `${plotDisplayName(p.id)} [E/B]\n${cost}`;
          break;
        case "UNDER_CONSTRUCTION":
          text = `Building ${plotDisplayName(p.id)}...\n${Math.round(p.progress * 100)}%`;
          break;
        case "COMPLETED":
          if (p.id === "wall_east_01" && p.level >= 2)
            text = `Stone Wall Lv.2\nHP ${p.durability}/${p.maxDurability}`;
          else if (p.id === "wall_east_01" && p.level === 1)
            text = `Wooden Wall [Q: Stone Lv2]\nHP ${p.durability}/${p.maxDurability} (3G 2W 5S)`;
          else
            text = `${plotDisplayName(p.id)}\nHP ${p.durability}/${p.maxDurability}`;
          break;
        case "DAMAGED":
          text = `Damaged ${plotDisplayName(p.id)} [E/F]\nHP ${p.durability}/${p.maxDurability}`;
          break;
        case "DESTROYED":
          text = `Destroyed ${plotDisplayName(p.id)} [E/B]\nRebuild: ${cost}`;
          break;
      }
      const height = p.type === "farm_plot" ? 44 : 60;
      this.label(p.x, -height - 16, text, col, { size: 9 });
    }

    // landmark prompts when active
    if (tgt.hasTarget && tgt.kind === "shipwreck") {
      const text =
        engine.shipwreckStage >= 3
          ? "Vessel Ready! [E] Set Sail"
          : `Shipwreck [E] Stage ${engine.shipwreckStage + 1}/3\n${shipCost(engine.shipwreckStage)}`;
      this.label(-1350, -64, text, "#fff28c", { size: 9 });
    }
    if (tgt.hasTarget && tgt.kind === "portal") {
      this.label(1350, -64, "Greed Portal [E]\nScavenge Relic (+3G +2S)", "#fff28c", { size: 9 });
    }
    if (tgt.hasTarget && tgt.kind === "resource" && !engine.isNodeCollected(tgt.targetId)) {
      this.label(nodeX(tgt.targetId), -44, nodePrompt(tgt.targetId), "#fff28c", { size: 9 });
    }
    if (tgt.hasTarget && tgt.kind === "tree") {
      const t = engine.treeById(tgt.targetId);
      if (t && !t.felled) {
        this.label(t.x, -76, `[E] Chop (${t.hp}/${t.maxHp})`, "#fff28c", { size: 9 });
      }
    }
    if (tgt.hasTarget && tgt.kind === "camp") {
      this.label(-220, -44, engine.campVagrants > 0 ? "Vagrant [E/R: 2G]" : "", "#fff28c", { size: 9 });
    }
    if (tgt.hasTarget && tgt.kind === "tool_stand") {
      const wx = tgt.targetId === "hammer_stand" ? -45 : tgt.targetId === "scythe_stand" ? -90 : 45;
      const cost =
        tgt.targetId === "hammer_stand"
          ? "Free"
          : tgt.targetId === "scythe_stand"
            ? "1G 1S"
            : engine.archerCount() === 0
              ? "Free 1st"
              : "1G 1W";
      this.label(wx, -44, `[E] ${roleName(tgt.targetId)} (${cost})`, "#fff28c", { size: 9 });
    }
    if (tgt.hasTarget && tgt.kind === "shrine_offering") {
      this.label(-780, -44, "[E] Shrine Offering (4W 2S -> +2G)", "#fff28c", { size: 9 });
    }
    if (tgt.hasTarget && tgt.kind === "hearth") {
      const q = engine.canUpgradeHearth()
        ? ` | [Q] ${engine.hearthLevel === 1 ? "Beacon Lv2: 4G 4W 2S" : "Solar Lv3: 6G 5W 4S"}`
        : "";
      this.label(0, -60, `Town Center (Hearth Lv.${engine.hearthLevel})\n[E] Stoke (1W)${q}`, "#fff28c", { size: 9 });
    }
  }

  engineRef: GameEngine | null = null;

  render(engine: GameEngine, ctx: CanvasRenderingContext2D, w: number, h: number) {
    this.engineRef = engine;
    this.draw(engine, ctx, w, h);
  }
}

const WORLD_MIN = -1600;
const WORLD_MAX = 1600;

function smoothstep(edge0: number, edge1: number, x: number) {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function plotDisplayName(id: string): string {
  switch (id) {
    case "wall_east_01":
      return "Wall Plot";
    case "wall_west_01":
      return "West Wall";
    case "watchtower_east_01":
      return "Watchtower";
    default:
      return "Farm Plot";
  }
}

function shipCost(stage: number): string {
  const costs = [
    { gold: 2, wood: 3, stone: 1 },
    { gold: 2, wood: 3, stone: 2 },
    { gold: 2, wood: 2, stone: 1 },
  ];
  const c = costs[Math.min(stage, 2)];
  return `${c.gold}G ${c.wood}W ${c.stone}S`;
}

function nodeX(id: string): number {
  const map: Record<string, number> = {
    cache_gold_west: -480,
    timber_pile_west: -110,
    stone_deposit_west: -600,
    stone_outcrop_east: 190,
    shrine_cache_far_west: -780,
  };
  return map[id] ?? 0;
}

function nodePrompt(id: string): string {
  const map: Record<string, string> = {
    cache_gold_west: "[E] Chest +4G",
    timber_pile_west: "[E] Timber +5W",
    stone_deposit_west: "[E] Quarry +3S",
    stone_outcrop_east: "[E] Masonry +3S",
    shrine_cache_far_west: "[E] Shrine +3G",
  };
  return map[id] ?? "[E] Collect";
}

function roleName(standId: string): string {
  const map: Record<string, string> = {
    hammer_stand: "Builder",
    scythe_stand: "Farmer",
    bow_stand: "Archer",
  };
  return map[standId] ?? standId;
}
