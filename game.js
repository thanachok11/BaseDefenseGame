/* ============================================================
   Kingdom's Last Stand — game.js
   Sections:
     1. Canvas polyfills & helpers
     2. Asset Loader
     3. Constants & upgrade config
     4. Entity classes  (Base, Player, SquadUnit, Enemy, Coin,
                         SpawnPad, ResourceBuilding, Projectile, Particle)
     5. Particle helpers / VFX
     6. Input handling
     7. Wave / spawn system (10 waves)
     8. Background renderer
     9. Main game loop
    10. HUD & UI updaters
    11. Initialisation & DOM wiring
   ============================================================ */

'use strict';

// Auth / Lobby มาจาก kingshot-session.js (โหลดก่อน game.js)

// ============================================================
// SECTION 1 — POLYFILLS & SMALL MATH HELPERS
// ============================================================

if (!CanvasRenderingContext2D.prototype.roundRect) {
  CanvasRenderingContext2D.prototype.roundRect = function (x, y, w, h, r) {
    r = r || 0;
    this.moveTo(x + r, y);
    this.lineTo(x + w - r, y);
    this.quadraticCurveTo(x + w, y, x + w, y + r);
    this.lineTo(x + w, y + h - r);
    this.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    this.lineTo(x + r, y + h);
    this.quadraticCurveTo(x, y + h, x, y + h - r);
    this.lineTo(x, y + r);
    this.quadraticCurveTo(x, y, x + r, y);
    this.closePath();
  };
}

const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const dist2 = (ax, ay, bx, by) => Math.hypot(bx - ax, by - ay);
const rand = (lo, hi) => lo + Math.random() * (hi - lo);

// ============================================================
// SECTION 2 — ASSET LOADER
// ============================================================

class AssetLoader {
  constructor() {
    this._images = {};
    this._total = 0;
    this._done = 0;
    this._onProg = null;
    this._onComp = null;
  }

  load(map) {
    const entries = Object.entries(map);
    this._total = entries.length;
    if (this._total === 0) {
      setTimeout(() => this._onComp && this._onComp(this._images), 50);
      return this;
    }
    entries.forEach(([key, src]) => {
      const img = new Image();
      img.onload = () => { this._images[key] = img; this._tick(); };
      img.onerror = () => { console.warn('Asset load failed:', src); this._tick(); };
      img.src = src;
    });
    return this;
  }

  _tick() {
    this._done++;
    const p = this._done / this._total;
    this._onProg && this._onProg(p);
    if (this._done >= this._total) {
      setTimeout(() => this._onComp && this._onComp(this._images), 150);
    }
  }

  onProgress(cb) { this._onProg = cb; return this; }
  onComplete(cb) { this._onComp = cb; return this; }
}

let ASSETS = {};

/** ขยาย sprite บน canvas ให้ใหญ่และชัดขึ้น */
const DRAW_SCALE = 1.65;

function getDrawScale() {
  const m = GS?.mapMetrics;
  if (!m) return DRAW_SCALE;
  if (m.short) return Math.max(1.2, DRAW_SCALE * 0.92);
  return DRAW_SCALE;
}

function getPlayScale() {
  return GS?.mapMetrics?.playScale ?? 1;
}

function isImageReady(img) {
  return img && img.complete && (img.naturalWidth > 0 || img.width > 0);
}

function drawSprite(ctx, img, cx, cy, size, opts = {}) {
  if (!isImageReady(img)) return false;
  const nw = img.naturalWidth || img.width;
  const nh = img.naturalHeight || img.height;
  const aspect = nw / nh;
  const mul = opts.scale ?? getDrawScale();
  const baseH = (opts.h ?? size) * 2 * mul;
  const baseW = (opts.w ?? size * aspect) * 2 * mul;
  ctx.save();
  if (opts.alpha != null) ctx.globalAlpha = opts.alpha;
  ctx.drawImage(img, cx - baseW / 2, cy - baseH / 2, baseW, baseH);
  if (opts.flash > 0) {
    ctx.globalAlpha = (opts.alpha ?? 1) * opts.flash * 0.45;
    ctx.globalCompositeOperation = 'source-atop';
    ctx.fillStyle = '#fff';
    ctx.fillRect(cx - baseW / 2, cy - baseH / 2, baseW, baseH);
  }
  ctx.restore();
  return true;
}

/** Tier สกินตัวละคร — เปลี่ยนทุก 10 ด่าน (1–9→0, 10–19→10, 20–29→20, 30+→30) */
const VISUAL_TIERS = [0, 10, 20, 30];
const CHARACTER_TYPES = ['king', 'sword', 'bow', 'magic'];
const BOSS_VARIANTS = ['warlord', 'dragon', 'golem', 'necromancer', 'juggernaut', 'assassin'];
const BOSS_NAMES = {
  warlord: 'จอมทัพ',
  dragon: 'มังกร',
  golem: 'หินยักษ์',
  necromancer: 'เนโครแมนเซอร์',
  juggernaut: 'ยักษ์เกราะ',
  assassin: 'มือสังหาร',
};

function getVisualTier(wave) {
  const w = wave ?? GS?.wave ?? 1;
  return Math.min(30, Math.floor((w - 1) / 10) * 10);
}

function getCharacterAsset(type, wave) {
  const tier = getVisualTier(wave);
  const key = `${type}_${tier}`;
  const img = ASSETS[key];
  if (isImageReady(img)) return img;
  const fb = ASSETS[`${type}_0`];
  return isImageReady(fb) ? fb : null;
}

function getBossAssetKey(wave, slotIndex = 0) {
  const tierBase = Math.floor(getVisualTier(wave) / 10);
  const variant = BOSS_VARIANTS[(tierBase + slotIndex) % BOSS_VARIANTS.length];
  return `boss_${variant}`;
}

function getBossDisplayName(wave, slotIndex = 0) {
  const key = getBossAssetKey(wave, slotIndex);
  const variant = key.replace('boss_', '');
  return BOSS_NAMES[variant] || 'บอส';
}

function buildAssetMap() {
  const map = {
    base: 'assets/world/base.svg',
    coin: 'assets/world/coin.svg',
    enemy_normal: 'assets/enemies/normal.svg',
    enemy_armored: 'assets/enemies/armored.svg',
  };
  CHARACTER_TYPES.forEach(type => {
    VISUAL_TIERS.forEach(tier => {
      map[`${type}_${tier}`] = `assets/characters/${type}/tier_${tier}.svg`;
    });
  });
  BOSS_VARIANTS.forEach(variant => {
    map[`boss_${variant}`] = `assets/bosses/${variant}.svg`;
  });
  BUILDING_ORDER.forEach(type => {
    map[`building_${type}`] = `assets/buildings/${type}.svg`;
  });
  map.turret_ballista = 'assets/turrets/turret_ballista.svg';
  map.turret_elite = 'assets/turrets/turret_elite.svg';
  map.weapon_hut_sword = 'assets/base_weapons/word_hut.svg';
  map.weapon_hut_bow = 'assets/base_weapons/archery_hut.svg';
  map.weapon_hut_magic = 'assets/base_weapons/magic_hut.svg';
  return map;
}

const BASE_WEAPON_HUT_KEYS = { sword: 'weapon_hut_sword', bow: 'weapon_hut_bow', magic: 'weapon_hut_magic' };

function getBaseWeaponHutAsset(type) {
  const key = BASE_WEAPON_HUT_KEYS[type];
  const img = key ? ASSETS[key] : null;
  return isImageReady(img) ? img : null;
}

function getTurretAsset(level) {
  if (level <= 0) return null;
  const key = level >= 10 ? 'turret_elite' : 'turret_ballista';
  const img = ASSETS[key];
  if (isImageReady(img)) return img;
  const fb = ASSETS.turret_ballista;
  return isImageReady(fb) ? fb : null;
}

// ============================================================
// SECTION 3 — CONSTANTS & UPGRADE CONFIG
// ============================================================

const C = {
  accent: '#22C55E',
  accentDark: '#16A34A',
  accentLight: '#86EFAC',
  danger: '#EF4444',
  dangerDark: '#B91C1C',
  coin: '#FBBF24',
  coinDark: '#D97706',
  white: '#FFFFFF',
  textMuted: '#4A6B5A',
  grass: '#5CB85C',
  grassDark: '#3D9A3D',
  grassLight: '#8FD48F',
  sky: '#87CEEB',
  sea: '#38BDF8',
  path: '#C4A574',
  pathLight: '#D4B896',
  sand: '#D4A574',
  wood: '#8B6914',
  sword: '#F97316',
  bow: '#EAB308',
  magic: '#A78BFA',
  boss: '#7C2D12',
  stone: '#94A3B8',
};

/** อาคารรอบฐาน — แต่ละอันผลิต/สกิลไม่เหมือนกัน */
const BUILDING_DEFS = {
  goldmine: {
    name: 'เหมืองทอง',
    side: 'left',
    sideLabel: 'ฝั่งซ้าย · บน',
    icon: '🪙',
    perkIcon: '💰',
    perkName: 'สมบัติขุน',
    color: '#FBBF24',
    colorDark: '#D97706',
    bgTint: 'rgba(245,158,11,0.14)',
    bodyColor: '#3d2800',
    offsetX: -205,
    offsetY: -72,
    maxLevel: 5,
    production: lv => lv * 0.8,
    productionLabel: 'ทอง',
    perkText: lv => `+${lv * 3}% เหรียญจากศัตรูที่สังหาร`,
    upgradeCost(level) {
      if (level >= 5) return null;
      const m = Math.pow(1.85, level);
      return { coins: Math.floor(100 * m), stone: level >= 2 ? level * 8 : 0 };
    },
  },
  barracks: {
    name: 'ค่ายทหาร',
    side: 'left',
    sideLabel: 'ฝั่งซ้าย · ล่าง',
    icon: '⚔️',
    perkIcon: '🛡️',
    perkName: 'ฝึกทหาร',
    color: '#F97316',
    colorDark: '#C2410C',
    bgTint: 'rgba(249,115,22,0.12)',
    bodyColor: '#431407',
    offsetX: -205,
    offsetY: 68,
    maxLevel: 5,
    production: () => 0,
    productionLabel: null,
    perkText: lv => `ทหารในกอง +${lv * 4} ดาเมจ`,
    upgradeCost(level) {
      if (level >= 5) return null;
      const m = Math.pow(1.9, level);
      return { coins: Math.floor(85 * m), stone: level >= 1 ? level * 6 : 0 };
    },
  },
  quarry: {
    name: 'เหมืองหิน',
    side: 'right',
    sideLabel: 'ฝั่งขวา · บน',
    icon: '🪨',
    perkIcon: '🏰',
    perkName: 'กำแพงหิน',
    color: '#94A3B8',
    colorDark: '#64748B',
    bgTint: 'rgba(148,163,184,0.14)',
    bodyColor: '#192030',
    offsetX: 205,
    offsetY: -72,
    maxLevel: 5,
    production: lv => lv * 0.5,
    productionLabel: 'หิน',
    perkText: lv => `ฐานฟื้น HP +${lv * 2}/วินาที`,
    upgradeCost(level) {
      if (level >= 5) return null;
      const m = Math.pow(1.85, level);
      return { coins: Math.floor(70 * m), stone: level >= 2 ? level * 5 : 0 };
    },
  },
  forge: {
    name: 'โรงตีเหล็ก',
    side: 'right',
    sideLabel: 'ฝั่งขวา · ล่าง',
    icon: '🔨',
    perkIcon: '⚡',
    perkName: 'ตีอาวุธ',
    color: '#A78BFA',
    colorDark: '#7C3AED',
    bgTint: 'rgba(167,139,250,0.12)',
    bodyColor: '#2E1065',
    offsetX: 205,
    offsetY: 68,
    maxLevel: 5,
    production: () => 0,
    productionLabel: null,
    perkText: lv => `อาวุธที่ฐาน +${lv * 10}% ดาเมจ`,
    upgradeCost(level) {
      if (level >= 5) return null;
      const m = Math.pow(1.9, level);
      return { coins: Math.floor(95 * m), stone: level >= 1 ? level * 8 : 0 };
    },
  },
};

const BUILDING_ORDER = ['goldmine', 'barracks', 'quarry', 'forge'];

function getBuildingDef(type) {
  return BUILDING_DEFS[type] || BUILDING_DEFS.goldmine;
}

function getCoinAttractRange() {
  const bonus = GS?.coinMagnetRange || 0;
  return bonus > 0 ? 80 + bonus : 115;
}

function getCoinPickupRange() {
  const bonus = GS?.coinMagnetRange || 0;
  return bonus > 0 ? 28 + bonus * 0.35 : 24;
}

function recalcBuildingBonuses() {
  if (!GS) return;
  const b = { coinKillPct: 0, baseRegenBonus: 0, squadDmg: 0, weaponDmgPct: 0 };
  (GS.buildings || []).forEach(building => {
    if (building.level <= 0) return;
    const lv = building.level;
    switch (building.type) {
      case 'goldmine': b.coinKillPct += lv * 3; break;
      case 'quarry': b.baseRegenBonus += lv * 2; break;
      case 'barracks': b.squadDmg += lv * 4; break;
      case 'forge': b.weaponDmgPct += lv * 10; break;
    }
  });
  GS.buildingBonuses = b;
}

function pickBuildingAt(mx, my) {
  if (!GS?.buildings) return null;
  let best = null, bestD = Infinity;
  GS.buildings.forEach((b, i) => {
    const d = dist2(mx, my, b.x, b.y);
    if (d <= b.radius + 22 && d < bestD) { bestD = d; best = i; }
  });
  return best;
}

function selectBuilding(idx, openPanel = true) {
  if (!GS?.buildings || idx == null || idx < 0) return;
  GS.selectedBuildingIdx = idx;
  GS.selectedTurretIdx = null;
  if (openPanel) {
    document.getElementById('upgrade-panel')?.classList.add('hidden');
    const panel = document.getElementById('base-panel');
    panel?.classList.remove('hidden');
    buildBasePanelUI();
    requestAnimationFrame(() => {
      const card = document.querySelector(`.building-card[data-idx="${idx}"]`);
      card?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
  }
}

const TURRET_PLACE_WPS = [1, 2, 3, 4];
const TURRET_BASE_COST = 50;
const TURRET_EXTRA_COST = 25;

const TURRET_SLOT_LAYOUT = [
  ...TURRET_PLACE_WPS.map((wpIdx, i) => ({ pathIndex: 0, wpIdx, offsetX: 0, offsetY: 0, order: i + 1 })),
  { pathIndex: 1, wpIdx: 1, offsetX: -52, offsetY: 6, order: 1 },
  { pathIndex: 1, wpIdx: 2, offsetX: 52, offsetY: 6, order: 2 },
  { pathIndex: 1, wpIdx: 3, offsetX: -52, offsetY: -24, order: 3 },
  { pathIndex: 1, wpIdx: 4, offsetX: 52, offsetY: -52, order: 4 },
  ...TURRET_PLACE_WPS.map((wpIdx, i) => ({ pathIndex: 2, wpIdx, offsetX: 0, offsetY: 0, order: i + 1 })),
];

function createTurretSlots() {
  return TURRET_SLOT_LAYOUT.map(def => new PathTurret(def));
}

function restoreTurrets(saveTurrets) {
  const slots = createTurretSlots();
  (saveTurrets || []).forEach(d => {
    const wpIdx = d.wpIdx ?? (d.slot === 0 ? 2 : d.slot === 1 ? 3 : null);
    if (wpIdx == null) return;
    const slot = slots.find(t => t.pathIndex === d.pathIndex && t.wpIdx === wpIdx);
    if (slot) slot.level = d.level || 0;
  });
  return slots;
}

function pickTurretAt(mx, my) {
  if (!GS?.turrets) return null;
  let best = null, bestD = Infinity;
  GS.turrets.forEach((t, i) => {
    const d = dist2(mx, my, t.x, t.y);
    const hitR = t.level > 0 ? 30 : 26;
    if (d <= hitR && d < bestD) { bestD = d; best = i; }
  });
  return best;
}

function selectTurret(idx, openPanel = true) {
  if (!GS?.turrets || idx == null || idx < 0) return;
  GS.selectedTurretIdx = idx;
  GS.selectedBuildingIdx = null;
  if (openPanel) {
    document.getElementById('upgrade-panel')?.classList.add('hidden');
    const panel = document.getElementById('base-panel');
    panel?.classList.remove('hidden');
    buildBasePanelUI();
    requestAnimationFrame(() => {
      const card = document.querySelector(`.turret-card[data-idx="${idx}"]`);
      card?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
  }
}

function handleTurretTap(idx) {
  selectTurret(idx);
}

const UPGRADES_DEF = [
  /* ─── ฐาน & กษัตริย์ ─── */
  {
    category: 'base',
    id: 'baseMaxHP', name: 'กำแพงแข็งแกร่ง', icon: '🏰',
    desc: 'HP สูงสุดของฐาน +100 และฟื้น HP ทันทีเท่ากัน',
    baseCost: 80,
    apply(gs) { gs.base.maxHp += 100; gs.base.hp = Math.min(gs.base.hp + 100, gs.base.maxHp); },
  },
  {
    category: 'base',
    id: 'baseRegen', name: 'น้ำพุโบราณ', icon: '💚',
    desc: 'ฐานฟื้น HP +1/วินาที',
    baseCost: 60,
    apply(gs) { gs.base.regen += 1; },
  },
  {
    category: 'base',
    id: 'playerSpeed', name: 'รองเท้าวิเศษ', icon: '👟',
    desc: 'ความเร็วเคลื่อนที่ของกษัตริย์ +40',
    baseCost: 50,
    apply(gs) { gs.player.speed += 40; },
  },
  {
    category: 'base',
    id: 'squadDamage', name: 'คลังอาวุธคม', icon: '⚔️',
    desc: 'ดาเมจทหารในกองทั้งหมด +10',
    baseCost: 90,
    apply(gs) {
      gs.globalSquadDmgBonus += 10;
      gs.squadUnits.forEach(u => { u.dmgBonus += 10; });
    },
  },
  {
    category: 'base',
    id: 'maxSquad', name: 'สภาทหาร', icon: '👥',
    desc: 'จำนวนทหารในกองสูงสุด +1',
    baseCost: 150,
    apply(gs) { gs.maxSquadSize++; },
  },
  {
    category: 'base',
    id: 'kingDmg', name: 'พิโรธกษัตริย์', icon: '👑',
    desc: 'ดาเมจดาบกษัตริย์ +15 และความเร็วโจมตี +0.15/วิ',
    baseCost: 75,
    apply(gs) { gs.player.dmgBonus += 15; gs.player.atkSpeed += 0.15; },
  },
  {
    category: 'base',
    id: 'kingRange', name: 'เขตแดนราชา', icon: '🌀',
    desc: 'ระยะโจมตีของกษัตริย์ +30',
    baseCost: 65,
    apply(gs) { gs.player.atkRange += 30; },
  },
  {
    category: 'base',
    id: 'coinMagnet', name: 'แม่เหล็กเก็บเหรียญ', icon: '🧲',
    desc: 'เก็บเหรียญอัตโนมัติ · ระยะดึง +40',
    baseCost: 55,
    apply(gs) { gs.coinMagnetRange = (gs.coinMagnetRange || 0) + 40; },
  },

  /* ─── ดาบ ─── */
  {
    category: 'sword',
    id: 'swordDmg', name: 'ฝึกดาบ', icon: '⚔️',
    desc: 'ดาเมจทหารดาบ +15 (ใช้กับทหารเดิมและใหม่)',
    baseCost: 80,
    apply(gs) {
      gs.weaponBonuses.sword.dmg += 15;
      gs.squadUnits.filter(u => u.type === 'sword').forEach(u => u.baseDmg += 15);
    },
  },
  {
    category: 'sword',
    id: 'swordHp', name: 'เกราะเหล็ก', icon: '🛡️',
    desc: 'HP สูงสุดทหารดาบ +30',
    baseCost: 70,
    apply(gs) {
      gs.weaponBonuses.sword.hp += 30;
      gs.squadUnits.filter(u => u.type === 'sword').forEach(u => {
        u.maxHp += 30; u.hp = Math.min(u.hp + 30, u.maxHp);
      });
    },
  },
  {
    category: 'sword',
    id: 'swordSpeed', name: 'คลั่งรบ', icon: '🌪️',
    desc: 'ความเร็วโจมตีทหารดาบ +0.3/วิ',
    baseCost: 90,
    apply(gs) {
      gs.weaponBonuses.sword.atkSpeed += 0.3;
      gs.squadUnits.filter(u => u.type === 'sword').forEach(u => u.atkSpeed += 0.3);
    },
  },

  /* ─── ธนู ─── */
  {
    category: 'bow',
    id: 'bowDmg', name: 'ลูกธนูคม', icon: '🏹',
    desc: 'ดาเมจทหารธนู +12',
    baseCost: 75,
    apply(gs) {
      gs.weaponBonuses.bow.dmg += 12;
      gs.squadUnits.filter(u => u.type === 'bow').forEach(u => u.baseDmg += 12);
    },
  },
  {
    category: 'bow',
    id: 'bowRange', name: 'ตาเหยี่ยว', icon: '🎯',
    desc: 'ระยะโจมตีทหารธนู +35',
    baseCost: 65,
    apply(gs) {
      gs.weaponBonuses.bow.range += 35;
      gs.squadUnits.filter(u => u.type === 'bow').forEach(u => u.range += 35);
    },
  },
  {
    category: 'bow',
    id: 'bowSpeed', name: 'ยิงถี่', icon: '⚡',
    desc: 'ความเร็วยิงทหารธนู +0.3/วิ',
    baseCost: 85,
    apply(gs) {
      gs.weaponBonuses.bow.atkSpeed += 0.3;
      gs.squadUnits.filter(u => u.type === 'bow').forEach(u => u.atkSpeed += 0.3);
    },
  },

  /* ─── เวท ─── */
  {
    category: 'magic',
    id: 'magicDmg', name: 'พลังเวท', icon: '✨',
    desc: 'ดาเมจทหารเวท +20',
    baseCost: 90,
    apply(gs) {
      gs.weaponBonuses.magic.dmg += 20;
      gs.squadUnits.filter(u => u.type === 'magic').forEach(u => u.baseDmg += 20);
    },
  },
  {
    category: 'magic',
    id: 'magicAoe', name: 'ระเบิดกว้าง', icon: '💥',
    desc: 'รัศมีระเบิดเวท +15',
    baseCost: 85,
    apply(gs) { gs.weaponBonuses.magic.aoe += 15; },
  },
  {
    category: 'magic',
    id: 'magicSpeed', name: 'กระแสมานา', icon: '🔮',
    desc: 'ความเร็วร่ายเวท +0.15/วิ',
    baseCost: 100,
    apply(gs) {
      gs.weaponBonuses.magic.atkSpeed += 0.15;
      gs.squadUnits.filter(u => u.type === 'magic').forEach(u => u.atkSpeed += 0.15);
    },
  },
];

// ============================================================
// SECTION 4 — ENTITY CLASSES
// ============================================================

/* ── BASE ─────────────────────────────────────────────── */
class Base {
  constructor(x, y) {
    this.x = x; this.y = y;
    this.hp = 200; this.maxHp = 200;
    this.regen = 0.5;
    this.radius = 54;
    this.hitFlash = 0;
    this._angle = 0;
  }

  update(dt) {
    this.hp = Math.min(this.maxHp, this.hp + (this.regen + (GS.buildingBonuses?.baseRegenBonus || 0)) * dt);
    if (this.hitFlash > 0) this.hitFlash -= dt * 4;
    this._angle += dt * 0.3;
  }

  takeDamage(amt) {
    this.hp -= amt;
    this.hitFlash = 1;
    spawnHitParticles(GS.particles, this.x, this.y, C.danger, 8);
    if (this.hp <= 0) { this.hp = 0; triggerGameOver(); }
  }

  draw(ctx) {
    const { x, y, radius } = this;

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(this._angle);
    const dashes = 12;
    for (let i = 0; i < dashes; i++) {
      const a = (i / dashes) * Math.PI * 2;
      const ia = a + Math.PI / dashes;
      ctx.beginPath();
      ctx.arc(0, 0, radius + 10, a, ia);
      ctx.strokeStyle = this.hitFlash > 0
        ? `rgba(239,68,68,${0.6 * this.hitFlash})`
        : `rgba(16,185,129,${0.45})`;
      ctx.lineWidth = 3;
      ctx.stroke();
    }
    ctx.restore();

    if (!drawSprite(ctx, ASSETS.base, x, y, radius * 1.1, { flash: this.hitFlash })) {
      ctx.save();
      ctx.translate(x, y);
      const sides = 8;
      ctx.beginPath();
      for (let i = 0; i < sides; i++) {
        const a = (i / sides) * Math.PI * 2 - Math.PI / sides;
        const px = Math.cos(a) * radius, py = Math.sin(a) * radius;
        i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fillStyle = '#6B4423';
      ctx.fill();
      ctx.restore();
    }
  }
}

/* ── PLAYER ───────────────────────────────────────────── */
class Player {
  constructor(x, y) {
    this.x = x; this.y = y;
    this.speed = 200;
    this.squadRadius = 112;
    this.size = 30;
    this._phase = 0;
    this.atkRange = 145;
    this.atkDmg = 22;
    this.atkSpeed = 0.9;
    this.atkTimer = 0;
    this.atkFlash = 0;
    this.dmgBonus = 0;
    this.moveTargetX = null;
    this.moveTargetY = null;
  }

  setMoveTarget(x, y) {
    this.moveTargetX = x;
    this.moveTargetY = y;
  }

  clearMoveTarget() {
    this.moveTargetX = null;
    this.moveTargetY = null;
  }

  get totalDmg() { return this.atkDmg + this.dmgBonus; }

  _attackTarget() {
    const t = GS.manualTarget;
    if (t && !t.dead) {
      if (dist2(this.x, this.y, t.x, t.y) <= this.atkRange) return t;
      return null;
    }
    let best = null, bestD = this.atkRange;
    GS.enemies.forEach(e => {
      if (e.dead) return;
      const d = dist2(this.x, this.y, e.x, e.y);
      if (d <= bestD) { bestD = d; best = e; }
    });
    return best;
  }

  update(dt) {
    let destX = null;
    let destY = null;
    let stopAt = 6;

    const t = GS.manualTarget;
    if (t && !t.dead) {
      const d = dist2(this.x, this.y, t.x, t.y);
      if (d > this.atkRange * 0.9) {
        destX = t.x;
        destY = t.y;
        stopAt = this.atkRange * 0.85;
      }
    } else if (this.moveTargetX != null && this.moveTargetY != null) {
      destX = this.moveTargetX;
      destY = this.moveTargetY;
    }

    if (destX != null && destY != null) {
      const dx = destX - this.x;
      const dy = destY - this.y;
      const d = Math.hypot(dx, dy);
      if (d > stopAt) {
        const ps = getPlayScale();
        const s = Math.min(this.speed * ps, d * 12 * ps) * dt;
        this.x += (dx / d) * s;
        this.y += (dy / d) * s;
      } else if (!t || t.dead) {
        this.clearMoveTarget();
      }
    }

    const W = canvas.width, H = canvas.height;
    this.x = clamp(this.x, this.size + 2, W - this.size - 2);
    this.y = clamp(this.y, this.size + 2, H - this.size - 2);

    this._phase += dt * 2.5;
    if (this.atkFlash > 0) this.atkFlash -= dt * 4;

    this.atkTimer += dt;
    if (this.atkTimer >= 1 / this.atkSpeed) {
      this.atkTimer = 0;
      const t = this._attackTarget();
      if (t) {
        GS.projectiles.push(new Projectile(this.x, this.y, t.x, t.y, this.totalDmg, 'royal'));
        this.atkFlash = 1;
        spawnHitParticles(GS.particles, this.x, this.y, C.coin, 3);
      }
    }
  }

  draw(ctx) {
    const { x, y, size, squadRadius } = this;
    const bob = Math.sin(this._phase) * 1.5;

    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, this.atkRange, 0, Math.PI * 2);
    ctx.strokeStyle = this.atkFlash > 0
      ? `rgba(251,191,36,${0.55 * this.atkFlash})`
      : 'rgba(251,191,36,0.10)';
    ctx.lineWidth = this.atkFlash > 0 ? 2 : 1;
    ctx.stroke();
    ctx.restore();

    if (this.atkFlash > 0) {
      ctx.save();
      const bloom = ctx.createRadialGradient(x, y, 0, x, y, 30 * this.atkFlash);
      bloom.addColorStop(0, `rgba(251,191,36,${0.35 * this.atkFlash})`);
      bloom.addColorStop(1, 'rgba(251,191,36,0)');
      ctx.beginPath(); ctx.arc(x, y, 30 * this.atkFlash, 0, Math.PI * 2);
      ctx.fillStyle = bloom; ctx.fill();
      ctx.restore();
    }

    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, squadRadius, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(16,185,129,0.18)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 6]);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();

    ctx.save();
    ctx.translate(x, y + bob);
    if (!drawSprite(ctx, getCharacterAsset('king', GS.wave), 0, 0, size * 1.2, { flash: this.atkFlash })) {
      ctx.shadowColor = C.accent;
      ctx.shadowBlur = 18;
      ctx.beginPath();
      ctx.arc(0, 0, size, 0, Math.PI * 2);
      ctx.fillStyle = '#CBD5E1';
      ctx.fill();
      ctx.strokeStyle = C.accent;
      ctx.lineWidth = 2.5;
      ctx.stroke();
      ctx.shadowBlur = 0;
    }
    ctx.restore();
  }
}

/* ── SQUAD UNIT ───────────────────────────────────────── */
class SquadUnit {
  constructor(type, slotIndex) {
    this.type = type;
    this.slot = slotIndex;
    this.x = GS.player.x;
    this.y = GS.player.y;
    this.orbitAngle = (slotIndex / 6) * Math.PI * 2 + Math.random() * 0.5;
    this.orbitDist = 62 + slotIndex * 10;
    this.attackTimer = 0;
    this.dmgBonus = GS.globalSquadDmgBonus;
    this.hitFlash = 0;
    this._phase = Math.random() * Math.PI * 2;

    const wb = GS.weaponBonuses || { sword: {}, bow: {}, magic: {} };

    switch (type) {
      case 'sword':
        this.range = 58;
        this.baseDmg = 28 + (wb.sword.dmg || 0);
        this.atkSpeed = 1.2 + (wb.sword.atkSpeed || 0);
        this.size = 26;
        this.maxHp = 80 + (wb.sword.hp || 0);
        this.hp = this.maxHp;
        this.color = C.sword;
        break;
      case 'bow':
        this.range = 195 + (wb.bow.range || 0);
        this.baseDmg = 16 + (wb.bow.dmg || 0);
        this.atkSpeed = 1.9 + (wb.bow.atkSpeed || 0);
        this.size = 26;
        this.maxHp = 55;
        this.hp = this.maxHp;
        this.color = C.bow;
        break;
      case 'magic':
        this.range = 135;
        this.baseDmg = 48 + (wb.magic.dmg || 0);
        this.atkSpeed = 0.55 + (wb.magic.atkSpeed || 0);
        this.size = 26;
        this.maxHp = 65;
        this.hp = this.maxHp;
        this.color = C.magic;
        break;
    }
  }

  get dmg() {
    return this.baseDmg + this.dmgBonus + (GS.buildingBonuses?.squadDmg || 0);
  }

  update(dt) {
    this.orbitAngle += dt * (0.6 + this.slot * 0.08);
    const tx = GS.player.x + Math.cos(this.orbitAngle) * this.orbitDist;
    const ty = GS.player.y + Math.sin(this.orbitAngle) * this.orbitDist;
    this.x = lerp(this.x, tx, dt * 6);
    this.y = lerp(this.y, ty, dt * 6);

    this._phase += dt * 3;
    if (this.hitFlash > 0) this.hitFlash -= dt * 4;

    this.attackTimer += dt;
    if (this.attackTimer >= 1 / this.atkSpeed) {
      this.attackTimer = 0;
      this._doAttack();
    }
  }

  _doAttack() {
    let t = GS.manualTarget;
    if (t && (t.dead || dist2(this.x, this.y, t.x, t.y) > this.range)) t = null;
    if (!t) {
      let best = null, bestD = this.range;
      GS.enemies.forEach(e => {
        if (e.dead) return;
        const d = dist2(this.x, this.y, e.x, e.y);
        if (d <= bestD) { bestD = d; best = e; }
      });
      t = best;
    }
    if (!t) return;

    if (this.type === 'sword') {
      if (dist2(this.x, this.y, t.x, t.y) <= this.range) {
        t.takeDamage(this.dmg);
        spawnSlash(GS.particles, this.x, this.y);
        spawnHitParticles(GS.particles, this.x, this.y, C.sword, 5);
      }
    } else if (dist2(this.x, this.y, t.x, t.y) <= this.range) {
      GS.projectiles.push(new Projectile(this.x, this.y, t.x, t.y, this.dmg, this.type));
    }
  }

  draw(ctx) {
    const { x, y, size, type, color } = this;
    const bob = Math.sin(this._phase) * 1.2;

    ctx.save();
    ctx.translate(x, y + bob);

    if (this.hitFlash > 0) { ctx.shadowColor = C.white; ctx.shadowBlur = 10; }
    else { ctx.shadowColor = color; ctx.shadowBlur = 6; }

    if (!drawSprite(ctx, getCharacterAsset(type, GS.wave), 0, 0, size * 1.25, { flash: this.hitFlash })) {
      ctx.beginPath();
      ctx.arc(0, 0, size, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
    }
    ctx.shadowBlur = 0;
    ctx.restore();

    if (this.hp < this.maxHp) {
      const bw = 26, bh = 4, bx = x - bw / 2, by = y + size + 3;
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.beginPath(); ctx.roundRect(bx, by, bw, bh, 2); ctx.fill();
      ctx.fillStyle = color;
      ctx.beginPath(); ctx.roundRect(bx, by, bw * (this.hp / this.maxHp), bh, 2); ctx.fill();
    }
  }
}

/* ── ENEMY ────────────────────────────────────────────── */
class Enemy {
  constructor(type, pathIndex, wave, opts = {}) {
    this.type = type;
    this.pathIndex = pathIndex;
    this.waypointIdx = 0;
    const path = GS.mapPaths[pathIndex];
    this.x = path[0].x; this.y = path[0].y;
    this.attackTimer = 0;
    this.hitFlash = 0;
    this.dead = false;
    this._angle = 0;
    this._wobble = 0;
    this.reachedBase = false;

    const waveMult = 1 + (wave - 1) * 0.12;
    const timeMult = 1 + (GS.timeSurvived || 0) * 0.004;
    const scale = waveMult * timeMult;

    switch (type) {
      case 'normal':
        this.hp = Math.round(32 * scale); this.maxHp = this.hp;
        this.speed = 80 + (wave - 1) * 2; this.atk = 8 * (1 + (wave - 1) * 0.08) * timeMult;
        this.atkRate = 1.0; this.radius = 24;
        this.coinDrop = 3; this.score = 10;
        break;
      case 'armored':
        this.hp = Math.round(95 * scale); this.maxHp = this.hp;
        this.speed = 52 + (wave - 1) * 1.5; this.atk = 16 * (1 + (wave - 1) * 0.08) * timeMult;
        this.atkRate = 0.65; this.radius = 34;
        this.coinDrop = 8; this.score = 28;
        break;
      case 'boss':
        this.hp = Math.round(650 * scale); this.maxHp = this.hp;
        this.speed = 34 + (wave - 1); this.atk = 28 * (1 + (wave - 1) * 0.06) * timeMult;
        this.atkRate = 0.45; this.radius = 68;
        this.coinDrop = 60; this.score = 220;
        this.bossKey = opts.bossKey || getBossAssetKey(wave, opts.bossSlot || 0);
        break;
    }
  }

  takeDamage(amt) {
    this.hp -= amt;
    this.hitFlash = 1;
    if (this.hp <= 0) { this.dead = true; }
    return this.dead;
  }

  update(dt) {
    const base = GS.base;
    if (this.hitFlash > 0) this.hitFlash -= dt * 5;
    this._wobble += dt * 4;

    if (!this.reachedBase) {
      const path = GS.mapPaths[this.pathIndex];
      const target = path[this.waypointIdx + 1];
      if (!target) { this.reachedBase = true; return; }

      const dx = target.x - this.x, dy = target.y - this.y;
      const d = Math.hypot(dx, dy);
      this._angle = Math.atan2(dy, dx);

      if (d < 10) {
        this.waypointIdx++;
        if (this.waypointIdx >= path.length - 1) this.reachedBase = true;
      } else {
        const ps = getPlayScale();
        const wobble = Math.sin(this._wobble) * 4;
        const wx = -Math.sin(this._angle) * wobble * 0.04;
        const wy = Math.cos(this._angle) * wobble * 0.04;
        this.x += ((dx / d) + wx) * this.speed * ps * dt;
        this.y += ((dy / d) + wy) * this.speed * ps * dt;
      }
    } else {
      const dx = base.x - this.x, dy = base.y - this.y;
      const d = Math.hypot(dx, dy);
      const stopR = base.radius + this.radius - 4;
      if (d > stopR) {
        const ps = getPlayScale();
        this.x += (dx / d) * this.speed * ps * dt;
        this.y += (dy / d) * this.speed * ps * dt;
      } else {
        this.attackTimer += dt;
        if (this.attackTimer >= 1 / this.atkRate) {
          this.attackTimer = 0;
          base.takeDamage(this.atk);
        }
      }
    }
  }

  draw(ctx) {
    const { x, y, radius, type, hitFlash } = this;
    const enemyImg = type === 'boss'
      ? ASSETS[this.bossKey || getBossAssetKey(GS.wave, 0)]
      : ASSETS[{ normal: 'enemy_normal', armored: 'enemy_armored' }[type]];

    ctx.save();
    if (type === 'boss') { ctx.shadowColor = C.danger; ctx.shadowBlur = 18; }

    const drawn = drawSprite(ctx, enemyImg, x, y, radius * 1.2, { flash: hitFlash });
    ctx.shadowBlur = 0;

    if (!drawn) {
      ctx.translate(x, y);
      ctx.beginPath();
      ctx.arc(0, 0, radius, 0, Math.PI * 2);
      ctx.fillStyle = type === 'boss' ? C.boss : C.danger;
      ctx.fill();
      ctx.translate(-x, -y);
    }

    ctx.restore();

    const isBoss = type === 'boss';
    const bw = isBoss ? 88 : radius * 2.2;
    const bh = isBoss ? 9 : 5;
    const bx = x - bw / 2, by = y - radius - (isBoss ? 20 : 12);
    const ratio = this.hp / this.maxHp;

    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.beginPath(); ctx.roundRect(bx - 1, by - 1, bw + 2, bh + 2, 3); ctx.fill();
    ctx.fillStyle = '#1E293B';
    ctx.beginPath(); ctx.roundRect(bx, by, bw, bh, 2); ctx.fill();
    ctx.fillStyle = ratio > 0.5 ? C.danger : '#F97316';
    ctx.beginPath(); ctx.roundRect(bx, by, bw * ratio, bh, 2); ctx.fill();

    if (GS.manualTarget === this) {
      ctx.strokeStyle = '#FBBF24';
      ctx.lineWidth = 3;
      ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.arc(x, y, radius + 10, 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash([]);
    }
  }
}

/* ── COIN ENTITY ──────────────────────────────────────── */
class CoinEntity {
  constructor(x, y) {
    this.x = x + rand(-20, 20);
    this.y = y + rand(-20, 20);
    this.vx = rand(-60, 60);
    this.vy = rand(-90, -10);
    this.radius = 11;
    this.collected = false;
    this.attracted = false;
    this.life = 18;
    this._phase = Math.random() * Math.PI * 2;
  }

  update(dt) {
    if (this.collected) return;
    this.life -= dt;
    if (this.life <= 0) { this.collected = true; return; }

    this.x += this.vx * dt; this.y += this.vy * dt;
    this.vx *= 1 - dt * 6; this.vy = this.vy * (1 - dt * 6) + 60 * dt;
    this._phase += dt * 4;

    const p = GS.player;
    const d = dist2(this.x, this.y, p.x, p.y);
    const attractR = getCoinAttractRange();
    const pickupR = getCoinPickupRange();
    if (d < attractR) this.attracted = true;

    if (this.attracted && d > 1) {
      const speed = lerp(180, 420, 1 - d / attractR);
      const dx = p.x - this.x, dy = p.y - this.y;
      const mag = Math.hypot(dx, dy);
      this.x += (dx / mag) * speed * dt;
      this.y += (dy / mag) * speed * dt;
    }

    if (d < pickupR) {
      this.collected = true;
      GS.coins++;
      GS.totalCoins++;
      spawnHitParticles(GS.particles, this.x, this.y, C.coin, 3);
    }
  }

  draw(ctx) {
    if (this.collected) return;
    const { x, y, radius, life } = this;
    const alpha = life < 3 ? life / 3 : 1;
    const pulse = 1 + Math.sin(this._phase) * 0.12;
    const size = radius * pulse;

    if (!drawSprite(ctx, ASSETS.coin, x, y, size, { alpha })) {
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.beginPath();
      ctx.arc(x, y, size, 0, Math.PI * 2);
      ctx.fillStyle = C.coin;
      ctx.fill();
      ctx.restore();
    }
  }
}

/* ── BASE WEAPON (at fortress) ────────────────────────── */
class BaseWeapon {
  constructor(x, y, type) {
    this.x = x; this.y = y;
    this.type = type;
    this.level = 0;
    this.maxLevel = 10;
    this.atkTimer = 0;
    this._phase = Math.random() * Math.PI * 2;
    this._flash = 0;
  }

  get color() { return { sword: C.sword, bow: C.bow, magic: C.magic }[this.type]; }
  get label() { return { sword: 'ดาบ', bow: 'ธนู', magic: 'เวท' }[this.type]; }

  stats() {
    if (this.level <= 0) return null;
    const b = { sword: { dmg: 20, range: 70, rate: 0.9 }, bow: { dmg: 15, range: 200, rate: 1.3 }, magic: { dmg: 40, range: 130, rate: 0.5 } }[this.type];
    const lv = this.level;
    const fp = getFortressPower();
    const wBonus = 1 + (GS.buildingBonuses?.weaponDmgPct || 0) / 100;
    return {
      dmg: Math.round((b.dmg + (lv - 1) * 10) * fp * wBonus),
      range: (b.range + (lv - 1) * 15) * Math.min(fp, 1.6),
      rate: (b.rate + (lv - 1) * 0.07) * Math.min(fp, 1.4),
    };
  }

  upgradeCost() {
    if (this.level >= this.maxLevel) return null;
    if (this.level === 0) return { coins: { sword: 35, bow: 30, magic: 45 }[this.type], stone: 0 };
    return { coins: Math.floor(40 * Math.pow(1.5, this.level)), stone: this.level >= 4 ? this.level * 2 : 0 };
  }

  tryUpgrade() {
    const cost = this.upgradeCost();
    if (!cost || GS.coins < cost.coins || GS.stone < cost.stone) return false;
    GS.coins -= cost.coins;
    GS.stone = Math.max(0, GS.stone - cost.stone);
    this.level++;
    this._flash = 1;
    spawnRecruitParticles(GS.particles, this.x, this.y, this.color);
    if (this.level === 1) GS.squadUnits.push(new SquadUnit(this.type, GS.squadUnits.length));
    return true;
  }

  update(dt) {
    this._phase += dt * 1.5;
    if (this._flash > 0) this._flash -= dt * 3;
    if (this.level <= 0) return;
    const st = this.stats();
    this.atkTimer += dt;
    if (this.atkTimer < 1 / st.rate) return;
    this.atkTimer = 0;
    let best = null, bestD = st.range;
    GS.enemies.forEach(e => {
      const d = dist2(this.x, this.y, e.x, e.y);
      if (d < bestD) { bestD = d; best = e; }
    });
    if (!best) return;
    this._flash = 0.8;
    if (this.type === 'sword') {
      GS.enemies.forEach(e => {
        if (dist2(this.x, this.y, e.x, e.y) <= st.range) e.takeDamage(st.dmg);
      });
      spawnSlash(GS.particles, this.x, this.y);
    } else {
      GS.projectiles.push(new Projectile(this.x, this.y - 12, best.x, best.y, st.dmg, this.type));
    }
  }

  draw(ctx) {
    const { x, y, type, level } = this;
    const color = this.color;
    const locked = level === 0;
    const bScale = GS.mapMetrics?.bScale ?? 1;
    const spriteSize = 32 * Math.max(0.92, bScale);
    const anchorY = y + 6;
    ctx.save();

    ctx.font = `bold ${Math.max(9, 10 * bScale)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillText(this.label, x + 1, anchorY - spriteSize - 4);
    ctx.fillStyle = locked ? '#78716C' : color;
    ctx.fillText(this.label, x, anchorY - spriteSize - 5);

    const sprite = getBaseWeaponHutAsset(type);
    const drawn = drawSprite(ctx, sprite, x, anchorY, spriteSize, {
      alpha: locked ? 0.72 : 1,
      flash: this._flash,
      scale: Math.max(1.05, getDrawScale() * 0.88),
    });

    if (!drawn) {
      const hutW = 34 * bScale;
      const hutH = 26 * bScale;
      ctx.fillStyle = locked ? '#A8A29E' : C.wood;
      ctx.fillRect(x - hutW / 2, y - hutH / 2, hutW, hutH);
      ctx.beginPath();
      ctx.moveTo(x - hutW / 2 - 4, y - hutH / 2);
      ctx.lineTo(x, y - hutH / 2 - 14 * bScale);
      ctx.lineTo(x + hutW / 2 + 4, y - hutH / 2);
      ctx.closePath();
      ctx.fillStyle = locked ? '#D6D3D1' : color;
      ctx.fill();
      const icons = { sword: '⚔', bow: '🏹', magic: '✨' };
      ctx.font = `${Math.max(12, 14 * bScale)}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(icons[type], x, y - 2);
    }

    ctx.font = `bold ${Math.max(8, 9 * bScale)}px sans-serif`;
    ctx.fillStyle = locked ? '#57534E' : '#fff';
    ctx.strokeStyle = 'rgba(0,0,0,0.45)';
    ctx.lineWidth = 2;
    const lvlText = locked ? 'ล็อก' : `ระดับ ${level}`;
    ctx.strokeText(lvlText, x, anchorY + spriteSize * 0.62);
    ctx.fillText(lvlText, x, anchorY + spriteSize * 0.62);
    const cost = this.upgradeCost();
    const can = cost && GS.coins >= cost.coins && GS.stone >= (cost.stone || 0);
    if (cost) drawPriceLabel(ctx, x, anchorY + spriteSize * 0.62 + 18 * bScale, formatCost(cost), can);
    ctx.restore();
  }
}

/* ── PATH TURRET (ป้อมปืนตามเส้นทาง) ─────────────────── */
class PathTurret {
  constructor(def) {
    this.x = 0; this.y = 0;
    this.pathIndex = def.pathIndex;
    this.wpIdx = def.wpIdx;
    this.offsetX = def.offsetX || 0;
    this.offsetY = def.offsetY || 0;
    this.order = def.order ?? def.wpIdx + 1;
    this.level = 0;
    this.maxLevel = 10;
    this.atkTimer = 0;
    this._phase = Math.random() * Math.PI * 2;
    this._flash = 0;
    this._justUpgraded = 0;
  }

  get labelBelow() {
    return this.pathIndex !== 1 || this.order <= 2;
  }

  tagLabelY(baseY) {
    return this.labelBelow ? baseY + 22 : baseY - 22;
  }

  priceLabelY(baseY) {
    return this.labelBelow ? baseY + 36 : baseY - 38;
  }

  countOnPath() {
    return (GS.turrets || []).filter(t => t.pathIndex === this.pathIndex && t.level > 0).length;
  }

  buildCost() {
    if (this.level > 0) return null;
    const n = this.countOnPath();
    return { coins: TURRET_BASE_COST + n * TURRET_EXTRA_COST, stone: 0 };
  }

  stats() {
    if (this.level <= 0) return null;
    const fp = getFortressPower();
    const lv = this.level;
    return {
      dmg: Math.round((12 + (lv - 1) * 8) * fp),
      range: (95 + (lv - 1) * 12) * Math.min(fp, 1.5),
      rate: (0.7 + (lv - 1) * 0.08) * Math.min(fp, 1.3),
    };
  }

  upgradeCost() {
    if (this.level <= 0) return this.buildCost();
    if (this.level >= this.maxLevel) return null;
    return { coins: Math.floor(50 * Math.pow(1.45, this.level)), stone: this.level >= 3 ? this.level * 3 : 0 };
  }

  tryPlace() {
    const cost = this.buildCost();
    if (!cost || GS.coins < cost.coins || GS.stone < (cost.stone || 0)) return false;
    GS.coins -= cost.coins;
    GS.stone = Math.max(0, GS.stone - (cost.stone || 0));
    this.level = 1;
    this._flash = 1;
    spawnRecruitParticles(GS.particles, this.x, this.y, C.accent);
    return true;
  }

  tryUpgrade() {
    if (this.level <= 0) return this.tryPlace();
    const cost = this.upgradeCost();
    if (!cost || GS.coins < cost.coins || GS.stone < cost.stone) return false;
    GS.coins -= cost.coins;
    GS.stone = Math.max(0, GS.stone - cost.stone);
    const wasMaxEvolve = this.level === 9;
    this.level++;
    this._flash = 1;
    this._justUpgraded = wasMaxEvolve ? 1.4 : 0.85;
    spawnRecruitParticles(GS.particles, this.x, this.y, wasMaxEvolve ? '#FBBF24' : C.accent);
    if (wasMaxEvolve) {
      for (let i = 0; i < 16; i++) {
        const a = (i / 16) * Math.PI * 2;
        GS.particles.push(new Particle(this.x, this.y, Math.cos(a) * 90, Math.sin(a) * 90,
          i % 2 ? '#FBBF24' : C.accent, rand(3, 5), rand(0.5, 0.8), 0));
      }
    }
    return true;
  }

  drawProcedural(ctx, x, y, level) {
    const elite = level >= 10;
    const r = elite ? 17 : 14;
    ctx.fillStyle = elite ? '#4B5563' : '#6B7280';
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = elite ? '#1F2937' : '#374151';
    if (elite) {
      ctx.fillRect(x - 8, y - 22, 5, 16);
      ctx.fillRect(x + 3, y - 22, 5, 16);
    } else {
      ctx.fillRect(x - 3, y - 18, 6, 14);
    }
    ctx.fillStyle = elite ? '#111827' : '#1F2937';
    ctx.beginPath(); ctx.arc(x, y, elite ? 10 : 8, 0, Math.PI * 2); ctx.fill();
    if (elite) {
      ctx.strokeStyle = '#FBBF24'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(x, y, r + 4 + Math.sin(this._phase * 2) * 1.5, 0, Math.PI * 2); ctx.stroke();
      ctx.strokeStyle = C.accent;
      ctx.beginPath(); ctx.arc(x, y, r + 8 + Math.sin(this._phase * 1.5) * 2, 0, Math.PI * 2); ctx.stroke();
    } else {
      ctx.strokeStyle = C.accent; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(x, y, r + 2 + Math.sin(this._phase * 2) * 1.5, 0, Math.PI * 2); ctx.stroke();
    }
  }

  drawBuilt(ctx, x, y, level) {
    const selected = GS.selectedTurretIdx === GS.turrets.indexOf(this);
    const elite = level >= 10;
    const bScale = GS.mapMetrics?.bScale ?? 1;
    const spriteSize = (elite ? 26 : 30) * Math.max(0.92, bScale);
    const anchorY = y + (elite ? 4 : 8);

    if (this._justUpgraded > 0) {
      ctx.beginPath();
      ctx.arc(x, anchorY, spriteSize + 6, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(134,239,172,${this._justUpgraded})`;
      ctx.lineWidth = 4;
      ctx.stroke();
    }

    if (selected) {
      ctx.beginPath();
      ctx.arc(x, anchorY, spriteSize + 4, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(34,197,94,0.85)';
      ctx.lineWidth = 2.5;
      ctx.setLineDash([5, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    const sprite = getTurretAsset(level);
    const drawn = drawSprite(ctx, sprite, x, anchorY, spriteSize, {
      flash: this._flash,
      scale: Math.max(1.05, getDrawScale() * 0.88),
    });
    if (!drawn) this.drawProcedural(ctx, x, anchorY, level);

    ctx.font = `bold ${elite ? 9 : 8}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillStyle = elite ? '#FDE68A' : '#fff';
    ctx.strokeStyle = 'rgba(0,0,0,0.5)';
    ctx.lineWidth = 2;
    const lvlText = elite ? `★ ${level}` : `ระดับ ${level}`;
    const labelY = anchorY + spriteSize * 0.72;
    ctx.strokeText(lvlText, x, labelY);
    ctx.fillText(lvlText, x, labelY);
  }

  update(dt) {
    this._phase += dt;
    if (this._flash > 0) this._flash -= dt * 3;
    if (this._justUpgraded > 0) this._justUpgraded -= dt * 1.8;
    if (this.level <= 0) return;
    const st = this.stats();
    this.atkTimer += dt;
    if (this.atkTimer < 1 / st.rate) return;
    this.atkTimer = 0;
    let best = null, bestD = st.range;
    GS.enemies.forEach(e => {
      if (e.pathIndex !== this.pathIndex) return;
      const d = dist2(this.x, this.y, e.x, e.y);
      if (d < bestD) { bestD = d; best = e; }
    });
    if (!best) return;
    this._flash = 0.7;
    GS.projectiles.push(new Projectile(this.x, this.y - 10, best.x, best.y, st.dmg, 'bow'));
  }

  draw(ctx) {
    const { x, y, level } = this;
    const selected = GS.selectedTurretIdx === GS.turrets.indexOf(this);
    ctx.save();

    if (this.pathIndex === 1 && GS.mapPaths?.[1]?.[this.wpIdx]) {
      const pathX = GS.mapPaths[1][this.wpIdx].x;
      ctx.strokeStyle = level > 0 ? 'rgba(74,163,212,0.35)' : 'rgba(148,163,184,0.28)';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([3, 4]);
      ctx.beginPath();
      ctx.moveTo(pathX, y);
      ctx.lineTo(x, y);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    if (level <= 0) {
      const cost = this.buildCost();
      const can = cost && GS.coins >= cost.coins && GS.stone >= (cost.stone || 0);
      const pulse = 0.55 + Math.sin(this._phase * 2) * 0.12;

      if (selected) {
        ctx.beginPath();
        ctx.arc(x, y, 24, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(34,197,94,0.9)';
        ctx.lineWidth = 2.5;
        ctx.setLineDash([5, 4]);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      ctx.beginPath();
      ctx.arc(x, y, 16, 0, Math.PI * 2);
      ctx.fillStyle = can ? `rgba(251,191,36,${0.18 * pulse})` : 'rgba(148,163,184,0.12)';
      ctx.fill();
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = can ? `rgba(251,191,36,${0.65 + pulse * 0.2})` : 'rgba(148,163,184,0.45)';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.font = 'bold 14px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = can ? '#FBBF24' : '#94A3B8';
      ctx.fillText('+', x, y - 1);

      ctx.font = 'bold 8px sans-serif';
      ctx.fillStyle = '#64748B';
      ctx.fillText('วางป้อม', x, this.tagLabelY(y));

      if (cost) drawPriceLabel(ctx, x, this.priceLabelY(y), formatCost(cost), can);
      ctx.restore();
      return;
    }

    this.drawBuilt(ctx, x, y, level);
    const cost = this.upgradeCost();
    const can = cost && GS.coins >= cost.coins && GS.stone >= (cost.stone || 0);
    if (cost) drawPriceLabel(ctx, x, this.priceLabelY(y), formatCost(cost), can);
    ctx.restore();
  }
}

/* ── ALLY PLAYER (multiplayer / AI) ───────────────────── */
class AllyPlayer {
  constructor(x, y, name, color) {
    this.x = x; this.y = y;
    this.name = name;
    this.color = color;
    this.speed = 160;
    this.size = 22;
    this.atkRange = 120;
    this.atkDmg = 18;
    this.atkSpeed = 0.75;
    this.atkTimer = 0;
    this._phase = Math.random() * Math.PI * 2;
    this.isAI = true;
  }

  update(dt) {
    this._phase += dt * 2;
    const base = GS.base;
    const orbitA = this._phase * 0.4;
    const tx = base.x + Math.cos(orbitA + this.name.length) * 55;
    const ty = base.y + Math.sin(orbitA + this.name.length) * 40 - 20;
    this.x = lerp(this.x, tx, dt * 2.5);
    this.y = lerp(this.y, ty, dt * 2.5);

    this.atkTimer += dt;
    if (this.atkTimer >= 1 / this.atkSpeed) {
      this.atkTimer = 0;
      const t = GS.manualTarget;
      if (t && !t.dead && dist2(this.x, this.y, t.x, t.y) <= this.atkRange) {
        GS.projectiles.push(new Projectile(this.x, this.y, t.x, t.y, this.atkDmg, 'royal'));
      }
    }
  }

  draw(ctx) {
    const { x, y, size, color, name } = this;
    ctx.save();
    ctx.translate(x, y);
    ctx.beginPath(); ctx.arc(0, 0, size, 0, Math.PI * 2);
    ctx.fillStyle = color; ctx.fill();
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke();
    ctx.font = 'bold 8px sans-serif'; ctx.textAlign = 'center';
    ctx.fillStyle = '#1E293B';
    ctx.fillText(name.slice(0, 6), 0, size + 10);
    ctx.restore();
  }
}

/* ── SPAWN PAD (legacy recruit near base weapons) ─────── */
class SpawnPad {
  constructor() { /* removed from map — kept stub */ }
  update() { }
  draw() { }
}

/* ── RESOURCE BUILDING ────────────────────────────────── */
class ResourceBuilding {
  constructor(x, y, type) {
    this.x = x; this.y = y;
    this.type = type;
    this.level = 0;
    this.radius = 46;
    this._phase = Math.random() * Math.PI * 2;
    this._cooldown = 0;
    this._produceTimer = 0;
    this._justUpgraded = 0;
  }

  get def() { return getBuildingDef(this.type); }
  get maxLevel() { return this.def.maxLevel; }

  productionPerSec() {
    if (this.level === 0) return 0;
    return this.def.production(this.level);
  }

  upgradeCost() {
    return this.def.upgradeCost(this.level);
  }

  update(dt) {
    this._phase += dt * 1.5;
    if (this._cooldown > 0) this._cooldown -= dt;
    if (this._justUpgraded > 0) this._justUpgraded -= dt;

    if (this.level > 0 && this.def.productionLabel) {
      this._produceTimer += dt;
      if (this._produceTimer >= 1.0) {
        this._produceTimer -= 1.0;
        const rate = this.productionPerSec();
        if (this.type === 'goldmine') {
          const amt = Math.max(1, Math.floor(rate));
          GS.coins += amt;
          GS.totalCoins += amt;
          for (let i = 0; i < Math.min(amt, 2); i++) {
            GS.coinEntities.push(new CoinEntity(this.x + rand(-8, 8), this.y + rand(-8, 8)));
          }
        } else if (this.type === 'quarry') {
          GS.stone += rate;
          spawnHitParticles(GS.particles, this.x, this.y, C.stone, 2);
        }
      }
    }
  }

  tryUpgrade() {
    if (this.level >= this.maxLevel) return false;
    const cost = this.upgradeCost();
    if (!cost || GS.coins < cost.coins || GS.stone < cost.stone) return false;
    GS.coins -= cost.coins;
    GS.stone = Math.max(0, GS.stone - cost.stone);
    this.level++;
    this._justUpgraded = 0.9;
    recalcBuildingBonuses();
    spawnRecruitParticles(GS.particles, this.x, this.y, this.def.color);
    return true;
  }

  draw(ctx) {
    const { x, y, radius, type, level } = this;
    const def = this.def;
    const color = def.color;
    const locked = level === 0;
    const maxed = level >= this.maxLevel;
    const cost = this.upgradeCost();
    const canUp = !maxed && cost &&
      GS.coins >= cost.coins && GS.stone >= cost.stone;
    const selected = GS.selectedBuildingIdx === GS.buildings.indexOf(this);
    const sprite = ASSETS[`building_${type}`];
    const labelY = y + radius + 14;

    ctx.save();

    if (selected) {
      ctx.beginPath();
      ctx.arc(x, y, radius + 16, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(34,197,94,0.9)';
      ctx.lineWidth = 3;
      ctx.setLineDash([7, 5]);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    if (canUp) {
      ctx.beginPath();
      ctx.arc(x, y, radius + 8 + Math.sin(this._phase * 2) * 2, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(251,191,36,${0.35 + Math.sin(this._phase * 2) * 0.15})`;
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    if (this._justUpgraded > 0) {
      ctx.beginPath();
      ctx.arc(x, y, radius + 10, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(134,239,172,${this._justUpgraded})`;
      ctx.lineWidth = 4;
      ctx.stroke();
    }

    if (locked && !canUp) ctx.filter = 'grayscale(0.75) brightness(0.65)';
    const drawn = drawSprite(ctx, sprite, x, y - 2, radius * 1.05, {
      alpha: locked && !canUp ? 0.75 : 1,
      flash: this._justUpgraded,
    });
    ctx.filter = 'none';

    if (!drawn) {
      ctx.beginPath();
      ctx.arc(x, y, radius * 0.7, 0, Math.PI * 2);
      ctx.fillStyle = locked ? '#374151' : def.bodyColor;
      ctx.fill();
      ctx.font = '22px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(def.icon, x, y);
    }

    if (!locked) {
      const dotStep = Math.max(5, 7 * (GS.mapMetrics?.bScale ?? 1));
      const dotStart = -((this.maxLevel - 1) * dotStep) / 2;
      for (let i = 0; i < this.maxLevel; i++) {
        ctx.beginPath();
        ctx.arc(x + dotStart + i * dotStep, y + radius - 4, 2.5, 0, Math.PI * 2);
        ctx.fillStyle = i < level ? color : 'rgba(255,255,255,0.15)';
        ctx.fill();
      }
    }

    const fs = GS.mapMetrics?.short ? 9 : 11;
    ctx.font = `bold ${fs}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillText(def.name, x + 1, labelY + 1);
    ctx.fillStyle = color;
    ctx.fillText(def.name, x, labelY);

    if (!GS.mapMetrics?.short) {
      ctx.font = `${Math.max(8, 9 * (GS.mapMetrics?.bScale ?? 1))}px sans-serif`;
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      const prod = this.productionPerSec();
      const subLine = level > 0 && def.productionLabel
        ? `+${prod.toFixed(1)} ${def.productionLabel}/วิ · ${def.perkIcon}`
        : `${def.perkIcon} ${def.perkName}`;
      ctx.fillText(subLine, x + 1, labelY + 13);
      ctx.fillStyle = locked ? '#94A3B8' : '#E2E8F0';
      ctx.fillText(subLine, x, labelY + 12);
    }

    if (cost) {
      drawPriceLabel(ctx, x, labelY + (GS.mapMetrics?.short ? 18 : 34), maxed ? '★ เต็ม' : formatCost(cost), canUp);
    }

    ctx.restore();
  }
}

/* ── PROJECTILE ───────────────────────────────────────── */
class Projectile {
  constructor(ox, oy, tx, ty, damage, type) {
    this.x = ox; this.y = oy;
    this.damage = damage;
    this.type = type;
    this.active = true;
    this.life = 3.5;

    const dx = tx - ox, dy = ty - oy;
    const d = Math.hypot(dx, dy) || 1;
    const spd = type === 'bow' ? 430 : type === 'royal' ? 380 : 270;
    this.vx = (dx / d) * spd;
    this.vy = (dy / d) * spd;
    this.angle = Math.atan2(dy, dx);
    this.size = type === 'bow' ? 5 : type === 'royal' ? 7 : 9;
    const aoeBonus = (GS.weaponBonuses && GS.weaponBonuses.magic)
      ? (GS.weaponBonuses.magic.aoe || 0) : 0;
    this.aoe = type === 'magic' ? 48 + aoeBonus : 0;
    this._spin = 0;
  }

  update(dt) {
    this.x += this.vx * dt;
    this.y += this.vy * dt;
    this.life -= dt;
    this._spin += dt * 12;

    if (this.life <= 0 ||
      this.x < -80 || this.x > canvas.width + 80 ||
      this.y < -80 || this.y > canvas.height + 80) {
      this.active = false; return;
    }

    for (const e of GS.enemies) {
      if (e.dead) continue;
      if (dist2(this.x, this.y, e.x, e.y) < e.radius + this.size) {
        if (this.aoe > 0) {
          spawnExplosion(GS.particles, this.x, this.y, this.aoe);
          GS.enemies.forEach(en => {
            if (!en.dead && dist2(this.x, this.y, en.x, en.y) <= this.aoe) {
              en.takeDamage(this.damage);
            }
          });
        } else {
          e.takeDamage(this.damage);
          const hitCol = this.type === 'bow' ? C.bow
            : this.type === 'royal' ? C.coin
              : C.magic;
          spawnHitParticles(GS.particles, this.x, this.y, hitCol, 5);
          if (this.type === 'royal') {
            spawnHitParticles(GS.particles, this.x, this.y, '#FDE68A', 4);
          }
        }
        this.active = false;
        return;
      }
    }
  }

  draw(ctx) {
    if (!this.active) return;
    ctx.save();
    ctx.translate(this.x, this.y);
    ctx.rotate(this.angle);

    if (this.type === 'royal') {
      ctx.shadowColor = C.coin; ctx.shadowBlur = 14;
      ctx.rotate(this._spin);
      ctx.restore();
      ctx.save();
      ctx.translate(this.x, this.y);
      ctx.rotate(this.angle);
      const tr = ctx.createLinearGradient(-this.size * 3, 0, 0, 0);
      tr.addColorStop(0, 'rgba(253,230,138,0)');
      tr.addColorStop(1, 'rgba(253,230,138,0.55)');
      ctx.fillStyle = tr;
      ctx.beginPath();
      ctx.ellipse(-this.size * 1.5, 0, this.size * 2.2, this.size * 0.35, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      ctx.save();
      ctx.translate(this.x, this.y);
      ctx.rotate(this._spin);
      ctx.shadowColor = C.coin; ctx.shadowBlur = 12;
      const pts = 4;
      ctx.beginPath();
      for (let i = 0; i < pts * 2; i++) {
        const a = (i / (pts * 2)) * Math.PI * 2;
        const r = i % 2 === 0 ? this.size : this.size * 0.38;
        i === 0 ? ctx.moveTo(Math.cos(a) * r, Math.sin(a) * r)
          : ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
      }
      ctx.closePath();
      const sg = ctx.createRadialGradient(0, 0, 0, 0, 0, this.size);
      sg.addColorStop(0, '#FEF3C7');
      sg.addColorStop(0.6, '#F59E0B');
      sg.addColorStop(1, '#D97706');
      ctx.fillStyle = sg; ctx.fill();
      ctx.strokeStyle = '#92400E'; ctx.lineWidth = 1; ctx.stroke();

    } else if (this.type === 'bow') {
      ctx.shadowColor = C.bow; ctx.shadowBlur = 6;
      ctx.strokeStyle = '#B45309'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(-12, 0); ctx.lineTo(4, 0); ctx.stroke();
      ctx.fillStyle = '#F59E0B';
      ctx.beginPath();
      ctx.moveTo(-12, 0); ctx.lineTo(-16, -4); ctx.lineTo(-10, 0);
      ctx.lineTo(-16, 4); ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#E5E7EB';
      ctx.beginPath();
      ctx.moveTo(8, 0); ctx.lineTo(1, -3); ctx.lineTo(1, 3);
      ctx.closePath(); ctx.fill();

    } else {
      ctx.shadowColor = C.magic; ctx.shadowBlur = 16;
      const tr = ctx.createLinearGradient(-this.size * 3.5, 0, 0, 0);
      tr.addColorStop(0, 'rgba(167,139,250,0)');
      tr.addColorStop(1, 'rgba(167,139,250,0.6)');
      ctx.fillStyle = tr;
      ctx.beginPath();
      ctx.ellipse(-this.size * 1.8, 0, this.size * 2.2, this.size * 0.4, 0, 0, Math.PI * 2);
      ctx.fill();
      const og = ctx.createRadialGradient(0, 0, 0, 0, 0, this.size);
      og.addColorStop(0, '#fff'); og.addColorStop(0.5, C.magic); og.addColorStop(1, 'rgba(167,139,250,0)');
      ctx.beginPath();
      ctx.arc(0, 0, this.size, 0, Math.PI * 2);
      ctx.fillStyle = og; ctx.fill();
    }

    ctx.restore();
  }
}

/* ── PARTICLE ─────────────────────────────────────────── */
class Particle {
  constructor(x, y, vx, vy, color, size, life, gravity = 60) {
    this.x = x; this.y = y;
    this.vx = vx; this.vy = vy;
    this.color = color;
    this.size = size;
    this.life = life; this.maxLife = life;
    this.gravity = gravity;
  }
  update(dt) {
    this.x += this.vx * dt; this.y += this.vy * dt;
    this.vx *= 1 - dt * 2.5;
    this.vy = this.vy * (1 - dt * 2.5) + this.gravity * dt;
    this.life -= dt;
  }
  draw(ctx) {
    const a = clamp(this.life / this.maxLife, 0, 1);
    ctx.save();
    ctx.globalAlpha = a;
    ctx.shadowColor = this.color; ctx.shadowBlur = 4;
    ctx.fillStyle = this.color;
    ctx.beginPath();
    ctx.arc(this.x, this.y, this.size * a + 0.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

class RingParticle {
  constructor(x, y, maxRadius, color) {
    this.x = x; this.y = y;
    this.maxRadius = maxRadius;
    this.color = color;
    this.life = 0.5; this.maxLife = 0.5;
  }
  update(dt) { this.life -= dt; }
  draw(ctx) {
    const t = 1 - (this.life / this.maxLife);
    const r = this.maxRadius * t;
    const a = this.life / this.maxLife;
    ctx.save();
    ctx.globalAlpha = a * 0.8;
    ctx.beginPath(); ctx.arc(this.x, this.y, r, 0, Math.PI * 2);
    ctx.strokeStyle = this.color; ctx.lineWidth = 3; ctx.stroke();
    ctx.restore();
  }
}

// ============================================================
// SECTION 5 — PARTICLE HELPERS / VFX
// ============================================================

function spawnHitParticles(pool, x, y, color, n = 6) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2;
    const s = rand(50, 130);
    pool.push(new Particle(x, y, Math.cos(a) * s, Math.sin(a) * s,
      color, rand(2, 4.5), rand(0.3, 0.55)));
  }
}

function spawnSlash(pool, x, y) {
  for (let i = 0; i < 10; i++) {
    const a = Math.random() * Math.PI * 2;
    const s = rand(70, 160);
    pool.push(new Particle(
      x + rand(-14, 14), y + rand(-14, 14),
      Math.cos(a) * s, Math.sin(a) * s,
      C.sword, rand(2, 4), 0.28, 0));
  }
}

function spawnRecruitParticles(pool, x, y, color) {
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    const s = rand(80, 160);
    pool.push(new Particle(x, y, Math.cos(a) * s, Math.sin(a) * s,
      color, rand(3, 6), rand(0.7, 1.1)));
  }
}

function spawnDeathParticles(pool, x, y, type) {
  const n = type === 'boss' ? 35 : type === 'armored' ? 16 : 11;
  const cols = {
    normal: [C.danger, '#FCA5A5', '#fff'],
    armored: ['#B91C1C', '#7F1D1D', '#FF8888'],
    boss: ['#7C2D12', C.danger, '#fff', '#FF8888'],
  }[type];
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2;
    const s = rand(60, 200);
    pool.push(new Particle(x, y, Math.cos(a) * s, Math.sin(a) * s,
      cols[Math.floor(Math.random() * cols.length)],
      rand(2.5, 7), rand(0.5, 0.9)));
  }
}

function getFortressPower() {
  if (!GS || !GS.wave) return 1;
  return 1 + (GS.wave - 1) * 0.06 + (GS.timeSurvived || 0) * 0.0015;
}

function isBossWave(wave) { return wave > 0 && wave % 5 === 0; }

function drawPriceLabel(ctx, x, y, text, canAfford) {
  ctx.save();
  const bScale = GS.mapMetrics?.bScale ?? 1;
  const fs = Math.max(11, 13 * bScale);
  ctx.font = `bold ${fs}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const w = ctx.measureText(text).width + 22;
  const h = Math.max(20, 24 * bScale);
  ctx.fillStyle = 'rgba(0,0,0,0.82)';
  ctx.beginPath(); ctx.roundRect(x - w / 2, y - h / 2, w, h, 8); ctx.fill();
  ctx.fillStyle = canAfford ? '#FDE68A' : '#FCA5A5';
  ctx.strokeStyle = canAfford ? '#D97706' : '#B91C1C';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.fillText(text, x, y + 1);
  ctx.restore();
}

function formatCost(cost) {
  if (!cost) return '';
  return cost.stone > 0 ? `🪙${cost.coins} 🪨${cost.stone}` : `🪙${cost.coins}`;
}

function pickEnemyAt(mx, my) {
  let best = null, bestD = Infinity;
  GS.enemies.forEach(e => {
    if (e.dead) return;
    const d = dist2(mx, my, e.x, e.y);
    const hitR = e.radius + 32;
    if (d <= hitR && d < bestD) { bestD = d; best = e; }
  });
  return best;
}

function refreshOpenPanels() {
  const key = `${Math.floor(GS.coins)}|${Math.floor(GS.stone || 0)}`;
  if (key === GS._panelCoinKey) return;
  GS._panelCoinKey = key;
  const basePanel = document.getElementById('base-panel');
  const upgPanel = document.getElementById('upgrade-panel');
  if (basePanel && !basePanel.classList.contains('hidden')) buildBasePanelUI();
  if (upgPanel && !upgPanel.classList.contains('hidden')) buildUpgradeUI();
}

function spawnExplosion(pool, x, y, radius) {
  for (let i = 0; i < 22; i++) {
    const a = Math.random() * Math.PI * 2;
    const s = rand(50, radius * 2.5);
    pool.push(new Particle(x, y, Math.cos(a) * s, Math.sin(a) * s,
      i % 4 === 0 ? '#fff' : C.magic, rand(3, 6), rand(0.4, 0.7), 0));
  }
  pool.push(new RingParticle(x, y, radius, C.magic));
}

// ============================================================
// SECTION 6 — INPUT HANDLING
// ============================================================

let inputBound = false;
let _dragging = false;
let _dragMoved = false;
let _dragStartX = 0;
let _dragStartY = 0;
let _pendingEnemy = null;
const DRAG_THRESHOLD = 10;

const joystick = { active: false, dx: 0, dy: 0, pointerId: null };
const JOYSTICK_MAX = 42;
let _landscapeGatePaused = false;

function isMobilePlay() {
  const el = document.documentElement;
  if (el.classList.contains('touch-device')) return true;
  if (!isTouchDevice()) return false;
  return window.matchMedia('(pointer: coarse)').matches
    || window.matchMedia('(max-width: 960px)').matches
    || Math.min(window.innerWidth, window.innerHeight) <= 520;
}

function markTouchDevice() {
  if (isTouchDevice()) document.documentElement.classList.add('touch-device');
}

function isPortrait() {
  return window.innerHeight > window.innerWidth;
}

function useMobileJoystick() {
  const c = document.getElementById('game-container');
  return c && c.classList.contains('mobile-mode') && c.classList.contains('landscape-ready');
}

function applyJoystickMovement() {
  if (!useMobileJoystick() || !GS.player || GS.paused) return;
  if (!joystick.active) {
    if (!GS.manualTarget) GS.player.clearMoveTarget();
    return;
  }
  const mag = Math.hypot(joystick.dx, joystick.dy);
  if (mag < 0.12) return;
  const nx = joystick.dx / mag;
  const ny = joystick.dy / mag;
  const reach = Math.max(160, Math.min(canvas.width, canvas.height) * 0.55);
  GS.player.setMoveTarget(GS.player.x + nx * reach, GS.player.y + ny * reach);
}

function resetJoystick() {
  joystick.active = false;
  joystick.dx = 0;
  joystick.dy = 0;
  joystick.pointerId = null;
  const stick = document.getElementById('joystick-stick');
  if (stick) stick.style.transform = 'translate(-50%, -50%)';
}

function setupMobileJoystick() {
  const zone = document.getElementById('move-joystick');
  const stick = document.getElementById('joystick-stick');
  if (!zone || !stick) return;

  const base = zone.querySelector('.joystick-base');
  let centerX = 0;
  let centerY = 0;

  const handleMove = (clientX, clientY) => {
    const dx = clientX - centerX;
    const dy = clientY - centerY;
    const dist = Math.hypot(dx, dy);
    const clamped = Math.min(dist, JOYSTICK_MAX);
    const nx = dist > 0 ? dx / dist : 0;
    const ny = dist > 0 ? dy / dist : 0;
    stick.style.transform = `translate(calc(-50% + ${nx * clamped}px), calc(-50% + ${ny * clamped}px))`;
    joystick.dx = dist > 0 ? (nx * clamped / JOYSTICK_MAX) : 0;
    joystick.dy = dist > 0 ? (ny * clamped / JOYSTICK_MAX) : 0;
    joystick.active = dist > 8;
  };

  zone.addEventListener('pointerdown', e => {
    if (GS.phase !== 'playing' || GS.paused) return;
    e.preventDefault();
    zone.setPointerCapture(e.pointerId);
    joystick.pointerId = e.pointerId;
    const r = base.getBoundingClientRect();
    centerX = r.left + r.width / 2;
    centerY = r.top + r.height / 2;
    handleMove(e.clientX, e.clientY);
  });

  zone.addEventListener('pointermove', e => {
    if (joystick.pointerId !== e.pointerId) return;
    e.preventDefault();
    handleMove(e.clientX, e.clientY);
  });

  const end = e => {
    if (joystick.pointerId !== e.pointerId) return;
    resetJoystick();
    try { zone.releasePointerCapture(e.pointerId); } catch (_) { /* noop */ }
  };
  zone.addEventListener('pointerup', end);
  zone.addEventListener('pointercancel', end);
}

async function tryLockLandscape() {
  if (!isMobilePlay()) return;
  try {
    if (screen.orientation && screen.orientation.lock) {
      await screen.orientation.lock('landscape');
    }
  } catch (_) { /* บางเบราว์เซอร์ (เช่น iOS) ล็อกไม่ได้ */ }
}

function unlockLandscape() {
  try {
    if (screen.orientation && screen.orientation.unlock) {
      screen.orientation.unlock();
    }
  } catch (_) { /* noop */ }
}

function updateMobilePlayLayout() {
  const container = document.getElementById('game-container');
  const controls = document.getElementById('mobile-controls');
  const rotate = document.getElementById('rotate-overlay');
  if (!container) return;

  const inGame = !container.classList.contains('hidden');
  const mobile = isMobilePlay() && inGame;
  const landscape = !isPortrait();

  container.classList.toggle('mobile-mode', mobile);
  container.classList.toggle('landscape-ready', landscape);

  if (rotate) rotate.classList.toggle('hidden', !(mobile && isPortrait()));
  if (controls) {
    const showJoystick = mobile && landscape;
    controls.classList.toggle('hidden', !showJoystick);
    controls.classList.toggle('joystick-visible', showJoystick);
    controls.setAttribute('aria-hidden', showJoystick ? 'false' : 'true');
  }

  if (mobile && isPortrait() && GS.phase === 'playing') {
    if (!GS.paused) {
      GS.paused = true;
      cancelAnimationFrame(animId);
      animId = null;
      _landscapeGatePaused = true;
    }
    document.getElementById('pause-overlay')?.classList.add('hidden');
  } else if (_landscapeGatePaused && landscape && GS.phase === 'playing' && GS.paused) {
    _landscapeGatePaused = false;
    GS.paused = false;
    document.getElementById('pause-overlay')?.classList.add('hidden');
    document.getElementById('pause-btn').textContent = '⏸ หยุด';
    lastTs = performance.now();
    animId = requestAnimationFrame(gameLoop);
  }
}

function enterMobilePlay() {
  markTouchDevice();
  updateMobileHints();
  tryLockLandscape();
  updateMobilePlayLayout();
  requestAnimationFrame(() => updateMobilePlayLayout());
}

function exitMobilePlay() {
  resetJoystick();
  _landscapeGatePaused = false;
  unlockLandscape();
  const container = document.getElementById('game-container');
  if (container) {
    container.classList.remove('mobile-mode', 'landscape-ready');
  }
  document.getElementById('mobile-controls')?.classList.add('hidden');
  document.getElementById('mobile-controls')?.classList.remove('joystick-visible');
  document.getElementById('rotate-overlay')?.classList.add('hidden');
}

function setupInput() {
  if (inputBound) return;
  inputBound = true;

  const getPos = (clientX, clientY) => {
    const r = canvas.getBoundingClientRect();
    const sx = canvas.width / r.width;
    const sy = canvas.height / r.height;
    GS.mouseX = (clientX - r.left) * sx;
    GS.mouseY = (clientY - r.top) * sy;
  };

  const endDrag = () => {
    if (!_dragging) return;
    _dragging = false;
    if (!_dragMoved && _pendingEnemy) {
      GS.manualTarget = _pendingEnemy;
      GS.player.clearMoveTarget();
    } else if (!_dragMoved) {
      const tIdx = pickTurretAt(GS.mouseX, GS.mouseY);
      if (tIdx != null) {
        handleTurretTap(tIdx);
      } else {
        const bIdx = pickBuildingAt(GS.mouseX, GS.mouseY);
        if (bIdx != null) {
          selectBuilding(bIdx);
        } else {
          GS.player.clearMoveTarget();
        }
      }
    } else {
      GS.player.clearMoveTarget();
    }
    _pendingEnemy = null;
    _dragMoved = false;
  };

  const startDrag = () => {
    if (GS.phase !== 'playing' || GS.paused) return;
    _dragging = true;
    _dragMoved = false;
    _dragStartX = GS.mouseX;
    _dragStartY = GS.mouseY;
    _pendingEnemy = pickEnemyAt(GS.mouseX, GS.mouseY);
  };

  const moveDrag = () => {
    if (!_dragging || useMobileJoystick()) return;
    const dist = Math.hypot(GS.mouseX - _dragStartX, GS.mouseY - _dragStartY);
    if (dist >= DRAG_THRESHOLD) {
      _dragMoved = true;
      GS.manualTarget = null;
      GS.player.setMoveTarget(GS.mouseX, GS.mouseY);
    }
  };

  canvas.addEventListener('mousedown', e => {
    getPos(e.clientX, e.clientY);
    startDrag();
  });
  canvas.addEventListener('mousemove', e => {
    getPos(e.clientX, e.clientY);
    moveDrag();
  });
  canvas.addEventListener('mouseup', endDrag);
  canvas.addEventListener('mouseleave', endDrag);

  canvas.addEventListener('touchstart', e => {
    e.preventDefault();
    getPos(e.touches[0].clientX, e.touches[0].clientY);
    startDrag();
  }, { passive: false });
  canvas.addEventListener('touchmove', e => {
    e.preventDefault();
    getPos(e.touches[0].clientX, e.touches[0].clientY);
    moveDrag();
  }, { passive: false });
  canvas.addEventListener('touchend', e => {
    if (e.changedTouches[0]) {
      getPos(e.changedTouches[0].clientX, e.changedTouches[0].clientY);
    }
    endDrag();
  });
  canvas.addEventListener('touchcancel', endDrag);

  window.addEventListener('mouseup', endDrag);
}

// ============================================================
// SECTION 7 — WAVE / SPAWN SYSTEM (ENDLESS)
// ============================================================

function buildSpawnQueue(wave) {
  const cycle = ((wave - 1) % 5) + 1;
  const tier = Math.floor((wave - 1) / 5);
  const tm = 1 + tier * 0.45;

  let normal = Math.floor((6 + cycle * 2) * tm);
  let armored = Math.floor(Math.max(0, cycle - 1) * 2 * tm);
  let boss = cycle === 5 ? Math.min(1 + tier, 4) : 0;

  let queue = [];
  for (let i = 0; i < boss; i++) queue.push({ type: 'boss', path: i % 3, bossSlot: i });
  for (let i = 0; i < normal; i++) queue.push({ type: 'normal', path: Math.floor(Math.random() * 3) });
  for (let i = 0; i < armored; i++) queue.push({ type: 'armored', path: Math.floor(Math.random() * 3) });
  for (let i = queue.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [queue[i], queue[j]] = [queue[j], queue[i]];
  }
  return queue;
}

function getSpawnInterval(wave) {
  return Math.max(0.35, 2.0 - wave * 0.06);
}

function spawnEnemyOnPath(entry) {
  GS.enemies.push(new Enemy(entry.type, entry.path, GS.wave, { bossSlot: entry.bossSlot }));
}

function tickWave(dt) {
  if (GS.wavePhase === 'rest') {
    GS.restTimer -= dt;
    const cdEl = document.getElementById('wave-countdown');
    const numEl = document.getElementById('countdown-num');
    numEl.textContent = Math.ceil(Math.max(0, GS.restTimer));

    if (GS.restTimer <= 0) {
      cdEl.classList.add('hidden');
      GS.wavePhase = 'spawning';
      GS.wave++;
      GS.spawnQueue = buildSpawnQueue(GS.wave);
      GS.spawnIdx = 0;
      GS.spawnTimer = 0;
      GS.spawnInterval = getSpawnInterval(GS.wave);
      showWaveAnnouncement(GS.wave);
    }
    return;
  }

  if (GS.spawnIdx < GS.spawnQueue.length) {
    GS.spawnTimer += dt;
    if (GS.spawnTimer >= GS.spawnInterval) {
      GS.spawnTimer = 0;
      spawnEnemyOnPath(GS.spawnQueue[GS.spawnIdx++]);
    }
  }

  if (GS.spawnIdx >= GS.spawnQueue.length && GS.enemies.length === 0) {
    GS.score += GS.wave * 50;
    GS.wavePhase = 'rest';
    GS.restTimer = 5;
    document.getElementById('wave-countdown').classList.remove('hidden');
  }
}

// ============================================================
// SECTION 7b — MAP PATHS (3 routes)
// ============================================================

function getMapMetrics(W, H) {
  const aspect = W / Math.max(H, 1);
  const short = H < 420 || aspect > 1.55;
  const bScale = Math.max(0.86, Math.min(1.05, (W / 760 + H / 400) / 2));
  const playScale = Math.max(0.5, Math.min(1, Math.min(W, H) / 680));
  const bx = W * 0.5;
  const by = short ? H * 0.76 : H * 0.78;
  return { bx, by, short, bScale, playScale, aspect, W, H };
}

function buildMapPaths(W, H, bx, by, metrics) {
  const short = metrics?.short ?? (H < 420 || W / Math.max(H, 1) > 1.55);
  const norm = short ? [
    [{ x: 0.03, y: 0.05 }, { x: 0.09, y: 0.17 }, { x: 0.16, y: 0.30 }, { x: 0.24, y: 0.43 }, { x: 0.32, y: 0.56 }, { x: 0.38, y: 0.67 }],
    [{ x: 0.50, y: 0.03 }, { x: 0.50, y: 0.15 }, { x: 0.50, y: 0.27 }, { x: 0.50, y: 0.39 }, { x: 0.50, y: 0.51 }, { x: 0.50, y: 0.63 }],
    [{ x: 0.97, y: 0.05 }, { x: 0.91, y: 0.17 }, { x: 0.84, y: 0.30 }, { x: 0.76, y: 0.43 }, { x: 0.68, y: 0.56 }, { x: 0.62, y: 0.67 }],
  ] : [
    [{ x: 0.05, y: 0.05 }, { x: 0.09, y: 0.20 }, { x: 0.14, y: 0.36 }, { x: 0.20, y: 0.52 }, { x: 0.28, y: 0.66 }],
    [{ x: 0.50, y: 0.02 }, { x: 0.50, y: 0.18 }, { x: 0.50, y: 0.34 }, { x: 0.50, y: 0.50 }, { x: 0.50, y: 0.66 }],
    [{ x: 0.95, y: 0.05 }, { x: 0.91, y: 0.20 }, { x: 0.86, y: 0.36 }, { x: 0.80, y: 0.52 }, { x: 0.72, y: 0.66 }],
  ];
  const approach = short ? 30 : 38;
  return norm.map(p => {
    const pts = p.map(pt => ({ x: pt.x * W, y: pt.y * H }));
    pts.push({ x: bx, y: by - approach * (metrics?.bScale ?? 1) });
    return pts;
  });
}

function rebuildMapLayout() {
  const W = canvas.width, H = canvas.height;
  const metrics = getMapMetrics(W, H);
  GS.mapMetrics = metrics;
  const { bx, by, bScale } = metrics;
  GS.base.x = bx; GS.base.y = by;
  GS.mapPaths = buildMapPaths(W, H, bx, by, metrics);

  const wOff = [{ x: -108, y: 28 }, { x: 108, y: 5 }, { x: 0, y: -145 }];
  GS.baseWeapons.forEach((w, i) => {
    w.x = bx + wOff[i].x * bScale;
    w.y = by + wOff[i].y * bScale;
  });

  GS.turrets.forEach((t) => {
    const pt = GS.mapPaths[t.pathIndex][t.wpIdx];
    t.x = pt.x + t.offsetX * bScale;
    t.y = pt.y + t.offsetY * bScale;
  });

  GS.buildings.forEach(b => {
    const def = b.def;
    b.x = bx + def.offsetX * bScale;
    b.y = by + def.offsetY * bScale;
    b.radius = Math.max(30, 46 * bScale);
  });

  if (GS.player) {
    GS.player.x = bx;
    GS.player.y = by - 42 * bScale;
    GS.player.size = Math.max(26, 30 * Math.max(bScale, 0.92));
    GS.player.clearMoveTarget();
  }
}

function drawMapPaths(ctx, paths) {
  const W = canvas.width;
  const lw = Math.max(12, Math.min(42, W * 0.038));
  paths.forEach((path, idx) => {
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    ctx.strokeStyle = 'rgba(60,45,20,0.35)';
    ctx.lineWidth = lw * 1.18;
    ctx.beginPath();
    path.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
    ctx.stroke();

    ctx.strokeStyle = C.path;
    ctx.lineWidth = lw;
    ctx.beginPath();
    path.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
    ctx.stroke();

    ctx.strokeStyle = C.pathLight;
    ctx.lineWidth = lw * 0.62;
    ctx.beginPath();
    path.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
    ctx.stroke();

    const spawn = path[0];
    const spawnR = Math.max(10, lw * 0.55);
    ctx.fillStyle = 'rgba(239,68,68,0.18)';
    ctx.beginPath();
    ctx.arc(spawn.x, spawn.y, spawnR, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(239,68,68,0.45)';
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.fillStyle = '#5C4A1F';
    ctx.font = 'bold 11px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(['← ซ้าย', '↑ กลาง', 'ขวา →'][idx], spawn.x, spawn.y - 24);
    ctx.restore();
  });
}

function drawGrassTexture(ctx, W, H) {
  ctx.save();
  for (let i = 0; i < 55; i++) {
    const x = (i * 97 + 13) % W;
    const y = H * 0.25 + (i * 53) % (H * 0.72);
    ctx.fillStyle = i % 3 === 0 ? 'rgba(61,154,61,0.12)' : 'rgba(92,184,92,0.08)';
    ctx.beginPath();
    ctx.ellipse(x, y, 8 + (i % 4) * 2, 4 + (i % 3), 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawBuildingPads(ctx, bx, by) {
  if (!GS?.buildings?.length) return;
  const bScale = GS.mapMetrics?.bScale ?? 1;
  GS.buildings.forEach(b => {
    const def = b.def;
    const px = b.x;
    const py = b.y;
    const active = b.level > 0;

    const padG = ctx.createRadialGradient(px, py, 2, px, py + 4, 58 * bScale);
    padG.addColorStop(0, active ? `${def.color}44` : 'rgba(255,255,255,0.08)');
    padG.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = padG;
    ctx.beginPath();
    ctx.ellipse(px, py + 8 * bScale, 54 * bScale, 20 * bScale, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = active ? `${def.color}55` : 'rgba(255,255,255,0.18)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 5]);
    ctx.beginPath();
    ctx.ellipse(px, py + 8 * bScale, 50 * bScale, 17 * bScale, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = active ? def.color : 'rgba(148,163,184,0.7)';
    ctx.font = `bold ${Math.max(7, 8 * bScale)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText(def.side === 'left' ? '◀' : '▶', px, py - 38 * bScale);
  });
}

function drawBaseCourtyard(ctx, bx, by) {
  const bScale = GS.mapMetrics?.bScale ?? 1;
  const courtG = ctx.createRadialGradient(bx, by, 20 * bScale, bx, by + 10, 210 * bScale);
  courtG.addColorStop(0, 'rgba(255,255,255,0.22)');
  courtG.addColorStop(0.55, 'rgba(143,212,143,0.18)');
  courtG.addColorStop(1, 'rgba(92,184,92,0)');
  ctx.fillStyle = courtG;
  ctx.beginPath();
  ctx.ellipse(bx, by + 12 * bScale, 240 * bScale, 108 * bScale, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = 'rgba(255,255,255,0.25)';
  ctx.lineWidth = 2;
  ctx.setLineDash([10, 8]);
  ctx.beginPath();
  ctx.ellipse(bx, by + 12 * bScale, 225 * bScale, 95 * bScale, 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);

  drawBuildingPads(ctx, bx, by);
}

function drawForestDecor(ctx, W, H) {
  const trees = [
    [0.06, 0.32], [0.12, 0.48], [0.18, 0.22], [0.94, 0.32], [0.88, 0.48], [0.82, 0.22],
    [0.22, 0.12], [0.78, 0.12], [0.04, 0.62], [0.96, 0.62],
  ];
  trees.forEach(([nx, ny], i) => {
    const tx = nx * W, ty = ny * H;
    const scale = 0.85 + (i % 3) * 0.12;
    ctx.fillStyle = 'rgba(0,0,0,0.08)';
    ctx.beginPath(); ctx.ellipse(tx, ty + 10, 12 * scale, 5 * scale, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = C.grassDark;
    ctx.beginPath(); ctx.arc(tx, ty + 8, 10 * scale, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = i % 2 ? '#276749' : '#2D6A4F';
    ctx.beginPath();
    ctx.moveTo(tx, ty - 20 * scale);
    ctx.lineTo(tx - 13 * scale, ty + 7 * scale);
    ctx.lineTo(tx + 13 * scale, ty + 7 * scale);
    ctx.closePath();
    ctx.fill();
  });

  const bushes = [[0.30, 0.28], [0.70, 0.28], [0.38, 0.58], [0.62, 0.58]];
  bushes.forEach(([nx, ny]) => {
    const bx = nx * W, by = ny * H;
    ctx.fillStyle = '#3D9A3D';
    ctx.beginPath(); ctx.arc(bx - 6, by, 7, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(bx + 6, by, 7, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(bx, by - 4, 8, 0, Math.PI * 2); ctx.fill();
  });

  const seaG = ctx.createLinearGradient(0, 0, 0, H * 0.2);
  seaG.addColorStop(0, C.sea);
  seaG.addColorStop(0.7, 'rgba(56,189,248,0.35)');
  seaG.addColorStop(1, 'rgba(56,189,248,0)');
  ctx.fillStyle = seaG;
  ctx.fillRect(0, 0, W, H * 0.2);

  ctx.fillStyle = 'rgba(255,255,255,0.12)';
  for (let i = 0; i < 6; i++) {
    ctx.beginPath();
    ctx.ellipse(0.12 * W + i * 0.14 * W, 0.06 * H + (i % 2) * 12, 28 + i * 6, 10, 0, 0, Math.PI * 2);
    ctx.fill();
  }
}

// ============================================================
// SECTION 8 — BACKGROUND RENDERER
// ============================================================

function drawBackground(ctx, W, H) {
  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, C.sky);
  bg.addColorStop(0.20, C.grassLight);
  bg.addColorStop(0.55, C.grass);
  bg.addColorStop(1, '#4CAF50');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  drawForestDecor(ctx, W, H);
  drawGrassTexture(ctx, W, H);
  if (GS.mapPaths) drawMapPaths(ctx, GS.mapPaths);

  const base = GS.base;
  drawBaseCourtyard(ctx, base.x, base.y);

  const bScale = GS.mapMetrics?.bScale ?? 1;
  const platG = ctx.createRadialGradient(base.x, base.y, 10 * bScale, base.x, base.y, 78 * bScale);
  platG.addColorStop(0, 'rgba(255,255,255,0.42)');
  platG.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = platG;
  ctx.beginPath(); ctx.ellipse(base.x, base.y + 8 * bScale, 78 * bScale, 30 * bScale, 0, 0, Math.PI * 2); ctx.fill();

  ctx.strokeStyle = 'rgba(255,255,255,0.55)';
  ctx.lineWidth = 2.5;
  ctx.beginPath(); ctx.ellipse(base.x, base.y - 18 * bScale, 52 * bScale, 52 * bScale, 0, 0, Math.PI * 2); ctx.stroke();
}

// ============================================================
// SECTION 9 — MAIN GAME LOOP
// ============================================================

let canvas, ctx;
let animId = null;
let lastTs = 0;
let GS = {};

function gameLoop(ts) {
  if (GS.phase !== 'playing') return;

  const dt = clamp((ts - lastTs) / 1000, 0, 0.05);
  lastTs = ts;
  GS.timeSurvived += dt;
  GS.totalKills = GS.totalKills || 0;

  const W = canvas.width, H = canvas.height;

  /* ── UPDATE ── */
  applyJoystickMovement();
  GS.base.update(dt);
  GS.player.update(dt);
  GS.allies.forEach(a => a.update(dt));
  GS.squadUnits.forEach(u => u.update(dt));
  GS.baseWeapons.forEach(w => w.update(dt));
  GS.turrets.forEach(t => t.update(dt));
  GS.buildings.forEach(b => b.update(dt));
  GS.enemies.forEach(e => e.update(dt));

  GS.projectiles = GS.projectiles.filter(p => p.active);
  GS.projectiles.forEach(p => p.update(dt));

  GS.coinEntities = GS.coinEntities.filter(c => !c.collected);
  GS.coinEntities.forEach(c => c.update(dt));

  GS.particles = GS.particles.filter(p => p.life > 0);
  GS.particles.forEach(p => p.update(dt));

  const killed = GS.enemies.filter(e => e.dead);
  killed.forEach(e => {
    GS.score += e.score;
    GS.totalKills++;
    const bonusPct = GS.buildingBonuses?.coinKillPct || 0;
    const extraCoins = bonusPct > 0 ? Math.max(1, Math.floor(e.coinDrop * bonusPct / 100)) : 0;
    const totalDrop = e.coinDrop + extraCoins;
    for (let i = 0; i < totalDrop; i++) GS.coinEntities.push(new CoinEntity(e.x, e.y));
    spawnDeathParticles(GS.particles, e.x, e.y, e.type);
  });
  GS.enemies = GS.enemies.filter(e => !e.dead);
  if (GS.manualTarget && GS.manualTarget.dead) GS.manualTarget = null;

  tickWave(dt);

  /* ── DRAW ── */
  ctx.clearRect(0, 0, W, H);
  drawBackground(ctx, W, H);

  GS.buildings.forEach(b => b.draw(ctx));
  GS.turrets.forEach(t => t.draw(ctx));
  GS.baseWeapons.forEach(w => w.draw(ctx));
  GS.coinEntities.forEach(c => c.draw(ctx));
  GS.base.draw(ctx);
  GS.enemies.forEach(e => e.draw(ctx));
  GS.projectiles.forEach(p => p.draw(ctx));
  GS.squadUnits.forEach(u => u.draw(ctx));
  GS.allies.forEach(a => a.draw(ctx));
  GS.player.draw(ctx);
  GS.particles.forEach(p => p.draw(ctx));

  updateHUD();

  GS._saveTimer = (GS._saveTimer || 0) + dt;
  if (GS._saveTimer >= 3) { GS._saveTimer = 0; saveGameState(); }

  animId = requestAnimationFrame(gameLoop);
}

// ============================================================
// SECTION 10 — HUD & UI UPDATERS
// ============================================================

function updateHUD() {
  const gs = GS;

  const m = Math.floor(gs.timeSurvived / 60);
  const s = Math.floor(gs.timeSurvived % 60);
  document.getElementById('hud-time').textContent =
    `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;

  const isBoss = isBossWave(gs.wave);
  const badge = document.getElementById('wave-badge');
  badge.textContent = isBoss
    ? `⚠ ${getBossDisplayName(gs.wave)} W${gs.wave}`
    : `WAVE ${gs.wave}`;
  badge.style.background = isBoss
    ? 'linear-gradient(135deg,#B91C1C,#EF4444)'
    : 'linear-gradient(135deg,#059669,#10B981)';

  const remaining = gs.spawnQueue.length - gs.spawnIdx + gs.enemies.length;
  const enemyLine = gs.wavePhase === 'rest'
    ? 'พัก ✓'
    : `ศัตรู ${Math.max(0, remaining)}${gs.manualTarget ? ' · 🎯' : ''}`;
  document.getElementById('wave-sub').textContent = enemyLine;

  document.getElementById('hud-score').textContent = gs.score.toLocaleString();
  document.getElementById('hud-coins').textContent = Math.floor(gs.coins);
  document.getElementById('hud-stone').textContent = Math.floor(gs.stone || 0);

  const mpEl = document.getElementById('mp-players');
  if (mpEl) {
    mpEl.innerHTML = '';
    const session = Auth.current();
    if (session) {
      const badge = document.createElement('span');
      badge.className = 'mp-badge you';
      badge.textContent = '👑 ' + session.username;
      mpEl.appendChild(badge);
    }
    (gs.allies || []).forEach(a => {
      const b = document.createElement('span');
      b.className = 'mp-badge';
      b.textContent = '🤝 ' + a.name;
      mpEl.appendChild(b);
    });
  }

  const ratio = gs.base.hp / gs.base.maxHp;
  document.getElementById('base-hp-fill').style.width = `${ratio * 100}%`;
  document.getElementById('base-hp-fill').style.background =
    ratio > 0.5 ? 'linear-gradient(90deg,#059669,#34D399)' :
      ratio > 0.25 ? 'linear-gradient(90deg,#D97706,#FBBF24)' :
        'linear-gradient(90deg,#B91C1C,#EF4444)';
  document.getElementById('hud-hp-text').textContent =
    `${Math.ceil(gs.base.hp)} / ${gs.base.maxHp}`;

  refreshOpenPanels();
}

const CATEGORY_LABELS = {
  base: { label: '🏰 ฐาน & กษัตริย์', color: '#10B981' },
  sword: { label: '⚔️ ทหารดาบ', color: '#F97316' },
  bow: { label: '🏹 ทหารธนู', color: '#FBBF24' },
  magic: { label: '✨ ทหารเวท', color: '#A78BFA' },
};

function buildBasePanelUI() {
  const list = document.getElementById('base-panel-list');
  if (!list) return;
  list.innerHTML = '';

  const hdr1 = document.createElement('div');
  hdr1.className = 'upg-category-header';
  hdr1.style.color = C.accentDark;
  hdr1.style.borderColor = C.accentDark + '40';
  hdr1.textContent = '🏰 อาวุธที่ฐาน';
  list.appendChild(hdr1);

  GS.baseWeapons.forEach(w => {
    const cost = w.upgradeCost();
    const maxed = !cost;
    const can = cost && GS.coins >= cost.coins && GS.stone >= (cost.stone || 0);
    const card = document.createElement('div');
    card.className = 'base-card';
    const st = w.stats();
    card.innerHTML = `
      <div class="upg-top">
        <span class="upg-name">${w.label}</span>
        <span class="upg-lvl">${w.level === 0 ? 'ล็อก' : 'ระดับ ' + w.level}</span>
      </div>
      <div class="upg-desc">${w.level === 0 ? 'ปลดล็อกเพื่อสร้างทหารและโจมตีอัตโนมัติ' :
        `ดาเมจ ${st.dmg} · ระยะ ${Math.round(st.range)} · ${st.rate.toFixed(1)}/s`}</div>
      <div class="upg-footer">
        <span class="upg-cost">${maxed ? '★ เต็ม' : `🪙${cost.coins}${cost.stone ? ' 🪨' + cost.stone : ''}`}</span>
        <button class="btn-buy btn-base-up" data-type="${w.type}" ${can ? '' : 'disabled'}>
          ${w.level === 0 ? 'ปลดล็อก' : 'อัพเกรด'}
        </button>
      </div>`;
    list.appendChild(card);
  });

  const hdr2 = document.createElement('div');
  hdr2.className = 'upg-category-header';
  hdr2.style.color = '#4BA3D4';
  hdr2.style.borderColor = '#4BA3D440';
  hdr2.innerHTML = '🔫 ป้อมตามเส้นทาง <span class="cat-hint">แตะจุดบนแผนที่แล้วกดวาง/อัพเกรดในเมนู · ป้อมเพิ่มจ่ายแพงขึ้น</span>';
  list.appendChild(hdr2);

  const pathNames = ['ซ้าย', 'กลาง', 'ขวา'];
  let lastPath = -1;

  GS.turrets.forEach((t, i) => {
    if (t.pathIndex !== lastPath) {
      lastPath = t.pathIndex;
      const pathHdr = document.createElement('div');
      pathHdr.className = 'building-side-header';
      pathHdr.textContent = `เส้นทาง${pathNames[t.pathIndex]}`;
      list.appendChild(pathHdr);
    }

    const cost = t.upgradeCost();
    const maxed = !cost;
    const can = cost && GS.coins >= cost.coins && GS.stone >= (cost.stone || 0);
    const pathName = pathNames[t.pathIndex];
    const selected = GS.selectedTurretIdx === i;
    const built = t.level > 0;
    const orderOnPath = built ? t.countOnPath() : t.countOnPath() + 1;
    const card = document.createElement('div');
    card.className = `base-card turret-card${selected ? ' selected' : ''}${!built ? ' turret-empty' : ''}`;
    card.dataset.idx = String(i);
    const st = t.stats();
    card.innerHTML = `
      <div class="upg-top">
        <span class="upg-name">ป้อม ${pathName} · จุด ${t.order}</span>
        <span class="upg-lvl">${built ? `ระดับ ${t.level}/${t.maxLevel}` : 'ว่าง'}</span>
      </div>
      <div class="upg-desc">${!built
        ? `ป้อมลำดับที่ ${orderOnPath} ของเส้นทาง · แตะเลือกแล้วกดวางป้อม`
        : `${t.level >= 10 ? '★ ร่างสูงสุด · ' : ''}ดาเมจ ${st.dmg} · ระยะ ${Math.round(st.range)} · ${st.rate.toFixed(1)}/วิ`}</div>
      ${built ? `<div class="building-level-bar">${Array.from({ length: t.maxLevel }, (_, j) =>
        `<span class="building-lvl-dot${j < t.level ? ' filled' : ''}${j === 9 ? ' elite-dot' : ''}"></span>`).join('')}</div>` : ''}
      <div class="upg-footer">
        <span class="upg-cost">${maxed ? '★ เต็ม' : `🪙${cost.coins}${cost.stone ? ' 🪨' + cost.stone : ''}`}</span>
        <button class="btn-buy btn-turret-up" data-idx="${i}" ${can ? '' : 'disabled'}>
          ${!built ? 'วางป้อม' : 'อัพเกรด'}
        </button>
      </div>`;
    list.appendChild(card);

    card.addEventListener('click', (ev) => {
      if (ev.target.closest('.btn-turret-up')) return;
      selectTurret(i, false);
      buildBasePanelUI();
    });
  });

  list.querySelectorAll('.btn-base-up:not([disabled])').forEach(btn => {
    btn.addEventListener('click', () => {
      const w = GS.baseWeapons.find(x => x.type === btn.dataset.type);
      if (w && w.tryUpgrade()) { buildBasePanelUI(); buildUpgradeUI(); updateHUD(); }
    });
  });
  list.querySelectorAll('.btn-turret-up:not([disabled])').forEach(btn => {
    btn.addEventListener('click', () => {
      const t = GS.turrets[+btn.dataset.idx];
      if (t && t.tryUpgrade()) { buildBasePanelUI(); updateHUD(); }
    });
  });

  const hdr3 = document.createElement('div');
  hdr3.className = 'upg-category-header';
  hdr3.style.color = C.coinDark;
  hdr3.style.borderColor = C.coinDark + '40';
  hdr3.innerHTML = '⛏️ อาคารรอบฐาน <span class="cat-hint">แตะบนแผนที่เพื่อเลือก</span>';
  list.appendChild(hdr3);

  const leftHdr = document.createElement('div');
  leftHdr.className = 'building-side-header building-side-left';
  leftHdr.textContent = '◀ ฝั่งซ้าย';
  list.appendChild(leftHdr);

  GS.buildings.forEach((b, i) => {
    const def = b.def;
    if (i === 2) {
      const rightHdr = document.createElement('div');
      rightHdr.className = 'building-side-header building-side-right';
      rightHdr.textContent = 'ฝั่งขวา ▶';
      list.appendChild(rightHdr);
    }

    const cost = b.upgradeCost();
    const maxed = !cost;
    const can = cost && GS.coins >= cost.coins && GS.stone >= (cost.stone || 0);
    const selected = GS.selectedBuildingIdx === i;
    const prod = b.productionPerSec();
    const card = document.createElement('div');
    card.className = `base-card building-card building-side-${def.side}${selected ? ' selected' : ''}`;
    card.dataset.idx = String(i);
    card.style.setProperty('--building-color', def.color);
    card.style.setProperty('--building-color-dark', def.colorDark);

    const prodLine = def.productionLabel
      ? (b.level > 0 ? `ผลิต +${prod.toFixed(1)} ${def.productionLabel}/วินาที` : `ผลิต ${def.productionLabel} อัตโนมัติ`)
      : 'ไม่ผลิตทรัพยากร — สกิลพิเศษเท่านั้น';
    const perkLine = b.level > 0 ? def.perkText(b.level) : `ปลดล็อกเพื่อ: ${def.perkText(1)}`;
    const nextPerk = !maxed && b.level > 0 ? def.perkText(b.level + 1) : (b.level === 0 ? def.perkText(1) : null);

    card.innerHTML = `
      <div class="building-card-head">
        <span class="building-card-icon">${def.icon}</span>
        <div class="building-card-titles">
          <span class="upg-name">${def.name}</span>
          <span class="building-side-tag">${def.sideLabel}</span>
        </div>
        <span class="upg-lvl">${b.level === 0 ? 'ล็อก' : 'ระดับ ' + b.level + '/' + b.maxLevel}</span>
      </div>
      <div class="building-perk-row">
        <span class="building-perk-chip">${def.perkIcon} ${def.perkName}</span>
        <span class="building-prod-chip">${prodLine}</span>
      </div>
      <div class="upg-desc building-perk-desc">${perkLine}${nextPerk && !maxed ? `<br><span class="next-perk">ถัดไป: ${nextPerk}</span>` : ''}</div>
      <div class="building-level-bar">${Array.from({ length: b.maxLevel }, (_, j) =>
        `<span class="building-lvl-dot${j < b.level ? ' filled' : ''}"></span>`).join('')}</div>
      <div class="upg-footer">
        <span class="upg-cost">${maxed ? '★ เต็ม' : formatCost(cost)}</span>
        <button class="btn-buy btn-building-up" data-idx="${i}" ${can ? '' : 'disabled'}>
          ${b.level === 0 ? 'ปลดล็อก' : 'อัพเกรด'}
        </button>
      </div>`;
    list.appendChild(card);

    card.addEventListener('click', (ev) => {
      if (ev.target.closest('.btn-building-up')) return;
      selectBuilding(i, false);
      buildBasePanelUI();
    });
  });

  list.querySelectorAll('.btn-building-up:not([disabled])').forEach(btn => {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const b = GS.buildings[+btn.dataset.idx];
      if (b && b.tryUpgrade()) { buildBasePanelUI(); updateHUD(); }
    });
  });
}

function buildUpgradeUI() {
  const list = document.getElementById('upgrade-list');
  list.innerHTML = '';

  let lastCategory = null;

  UPGRADES_DEF.forEach(def => {
    const cat = def.category || 'base';

    if (cat !== lastCategory) {
      lastCategory = cat;
      const info = CATEGORY_LABELS[cat] || { label: cat, color: '#fff' };
      const hdr = document.createElement('div');
      hdr.className = 'upg-category-header';
      hdr.style.color = info.color;
      hdr.style.borderColor = info.color + '40';
      hdr.textContent = info.label;
      list.appendChild(hdr);
    }

    const lvl = GS.upgradeLevels[def.id] || 0;
    const cost = Math.floor(def.baseCost * Math.pow(1.6, lvl));
    const can = GS.coins >= cost;
    let desc = def.desc;
    if (def.id === 'coinMagnet') {
      const nextRange = (GS.coinMagnetRange || 0) + 40;
      const attract = 80 + nextRange;
      const pickup = Math.round(28 + nextRange * 0.35);
      desc = lvl > 0
        ? `ระยะดึง ~${attract}px · เก็บอัตโนมัติ ~${pickup}px · อัพครั้งถัดไป +40`
        : `ปลดล็อกเก็บเหรียญอัตโนมัติ · ระยะดึง ~${attract}px`;
    }

    const card = document.createElement('div');
    card.className = 'upg-card';
    card.innerHTML = `
      <div class="upg-top">
        <span class="upg-name">${def.icon} ${def.name}</span>
        <span class="upg-lvl">ระดับ ${lvl}</span>
      </div>
      <div class="upg-desc">${desc}</div>
      <div class="upg-footer">
        <span class="upg-cost">🪙 ${cost.toLocaleString()}</span>
        <button class="btn-buy" data-id="${def.id}" data-cost="${cost}" ${can ? '' : 'disabled'}>
          อัพเกรด
        </button>
      </div>`;
    list.appendChild(card);
  });

  list.querySelectorAll('.btn-buy:not([disabled])').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.id;
      const cost = parseInt(btn.dataset.cost, 10);
      if (GS.coins < cost) return;
      GS.coins -= cost;
      const def = UPGRADES_DEF.find(d => d.id === id);
      if (def) { def.apply(GS); GS.upgradeLevels[id] = (GS.upgradeLevels[id] || 0) + 1; }
      buildUpgradeUI();
      updateHUD();
    });
  });
}

function showWaveAnnouncement(wave) {
  const el = document.getElementById('wave-announcement');
  const txt = document.getElementById('wave-ann-text');
  const boss = isBossWave(wave);

  txt.textContent = boss
    ? `⚠ BOSS: ${getBossDisplayName(wave)} — WAVE ${wave} ⚠`
    : `— WAVE ${wave} —`;
  txt.className = boss ? 'boss-wave' : '';

  el.classList.remove('hidden');
  txt.style.animation = 'none';
  void txt.offsetWidth;
  txt.style.animation = '';

  setTimeout(() => el.classList.add('hidden'), 2800);
}

function parseHudTime(text) {
  const parts = String(text || '0:00').split(':').map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return 0;
}

async function persistScore(result) {
  if (typeof Auth === 'undefined' || !Auth.saveScore) return;
  const session = Auth.current();
  if (!session || session.guest) return;

  const timeText = document.getElementById('hud-time')?.textContent || '0:00';
  await Auth.saveScore({
    score: GS.score,
    wave: GS.wave,
    kills: GS.totalKills || 0,
    timeSeconds: parseHudTime(timeText),
    result,
    mode: GS.mode || 'solo',
  });
}

function triggerGameOver() {
  if (GS.phase === 'game_over' || GS.phase === 'victory') return;
  GS.phase = 'game_over';
  clearGameSave();
  cancelAnimationFrame(animId);

  setTimeout(async () => {
    document.getElementById('final-time').textContent =
      document.getElementById('hud-time').textContent;
    document.getElementById('final-waves').textContent = GS.wave;
    document.getElementById('final-kills').textContent = (GS.totalKills || 0).toLocaleString();
    document.getElementById('final-score').textContent = GS.score.toLocaleString();
    document.getElementById('game-over-screen').classList.remove('hidden');
    await persistScore('defeat');
  }, 800);
}

function triggerVictory() {
  if (GS.phase === 'victory' || GS.phase === 'game_over') return;
  GS.phase = 'victory';
  clearGameSave();
  cancelAnimationFrame(animId);

  setTimeout(async () => {
    document.getElementById('victory-time').textContent =
      document.getElementById('hud-time').textContent;
    document.getElementById('victory-kills').textContent = (GS.totalKills || 0).toLocaleString();
    document.getElementById('victory-score').textContent = GS.score.toLocaleString();
    document.getElementById('victory-screen').classList.remove('hidden');
    await persistScore('victory');
  }, 600);
}

function pauseGame() {
  if (GS.phase !== 'playing' || GS.paused) return;
  GS.paused = true;
  cancelAnimationFrame(animId);
  animId = null;
  document.getElementById('pause-overlay').classList.remove('hidden');
  document.getElementById('pause-btn').textContent = '▶ เล่นต่อ';
}

function resumeGame() {
  if (!GS.paused) return;
  if (_landscapeGatePaused && isPortrait()) return;
  GS.paused = false;
  document.getElementById('pause-overlay').classList.add('hidden');
  document.getElementById('pause-btn').textContent = '⏸ หยุด';
  updateMobileHints();
  lastTs = performance.now();
  animId = requestAnimationFrame(gameLoop);
}

function exitToMenuFromPause() {
  if (GS.phase !== 'playing') return;
  saveGameState();
  GS.paused = false;
  cancelAnimationFrame(animId);
  animId = null;
  document.getElementById('pause-overlay').classList.add('hidden');
  document.getElementById('upgrade-panel').classList.add('hidden');
  document.getElementById('base-panel').classList.add('hidden');
  document.getElementById('wave-countdown').classList.add('hidden');
  document.getElementById('pause-btn').textContent = '⏸ หยุด';
  if (typeof Lobby !== 'undefined') Lobby.leaveRoom();
  refreshContinueButton();
  exitMobilePlay();
  showScreen('main-menu');
}

function refreshContinueButton() {
  const btn = document.getElementById('continue-btn');
  if (!btn) return;
  const save = loadGameSave();
  const session = typeof Auth !== 'undefined' ? Auth.current() : null;
  const canContinue = save && save.phase === 'playing' && session && save.playerId === session.id;
  btn.classList.toggle('hidden', !canContinue);
}

// ============================================================
// GAME SAVE / RESTORE (รีเฟรช = หยุดเกม ไม่กลับหน้า login)
// ============================================================

const GAME_SAVE_KEY = 'kls_game_save';

function clearGameSave() {
  localStorage.removeItem(GAME_SAVE_KEY);
}

function loadGameSave() {
  try {
    const raw = localStorage.getItem(GAME_SAVE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function saveGameState() {
  if (!GS || GS.phase !== 'playing') return;
  const session = typeof Auth !== 'undefined' ? Auth.current() : null;
  if (!session || session.guest) return;

  const manualTargetIdx = GS.manualTarget
    ? GS.enemies.indexOf(GS.manualTarget)
    : -1;

  const data = {
    version: 1,
    playerId: session.id,
    phase: 'playing',
    mode: GS.mode,
    score: GS.score,
    coins: GS.coins,
    stone: GS.stone,
    totalCoins: GS.totalCoins,
    totalKills: GS.totalKills,
    timeSurvived: GS.timeSurvived,
    upgradeLevels: GS.upgradeLevels,
    globalSquadDmgBonus: GS.globalSquadDmgBonus,
    maxSquadSize: GS.maxSquadSize,
    coinMagnetRange: GS.coinMagnetRange || 0,
    weaponBonuses: GS.weaponBonuses,
    wave: GS.wave,
    wavePhase: GS.wavePhase,
    restTimer: GS.restTimer,
    spawnQueue: GS.spawnQueue,
    spawnIdx: GS.spawnIdx,
    spawnTimer: GS.spawnTimer,
    spawnInterval: GS.spawnInterval,
    manualTargetIdx,
    base: { hp: GS.base.hp, maxHp: GS.base.maxHp, regen: GS.base.regen },
    player: {
      x: GS.player.x, y: GS.player.y,
      speed: GS.player.speed, dmgBonus: GS.player.dmgBonus,
      atkSpeed: GS.player.atkSpeed, atkRange: GS.player.atkRange,
    },
    baseWeapons: GS.baseWeapons.map(w => ({ type: w.type, level: w.level })),
    turrets: GS.turrets.map(t => ({ pathIndex: t.pathIndex, wpIdx: t.wpIdx, level: t.level })),
    buildings: GS.buildings.map(b => ({
      type: b.type, level: b.level, _produceTimer: b._produceTimer || 0,
    })),
    squadUnits: GS.squadUnits.map(u => ({
      type: u.type, slot: u.slot, hp: u.hp, maxHp: u.maxHp,
      x: u.x, y: u.y, orbitAngle: u.orbitAngle, orbitDist: u.orbitDist,
      baseDmg: u.baseDmg, atkSpeed: u.atkSpeed, range: u.range, size: u.size,
      color: u.color,
    })),
    enemies: GS.enemies.filter(e => !e.dead).map(e => ({
      type: e.type, pathIndex: e.pathIndex, waypointIdx: e.waypointIdx,
      x: e.x, y: e.y, hp: e.hp, maxHp: e.maxHp,
      speed: e.speed, atk: e.atk, atkRate: e.atkRate, radius: e.radius,
      coinDrop: e.coinDrop, score: e.score,
      reachedBase: e.reachedBase, attackTimer: e.attackTimer,
      bossKey: e.bossKey,
    })),
    savedAt: Date.now(),
  };

  try { localStorage.setItem(GAME_SAVE_KEY, JSON.stringify(data)); } catch { /* quota */ }
}

function restoreBuildings(saveBuildings) {
  const byType = {};
  (saveBuildings || []).forEach(d => { byType[d.type] = d; });
  return BUILDING_ORDER.map(type => {
    const d = byType[type] || { type, level: 0, _produceTimer: 0 };
    const b = new ResourceBuilding(0, 0, type);
    b.level = d.level || 0;
    b._produceTimer = d._produceTimer || 0;
    return b;
  });
}

function restoreEnemy(d) {
  const e = new Enemy(d.type, d.pathIndex, GS.wave);
  Object.assign(e, d);
  e.dead = false;
  e.hitFlash = 0;
  return e;
}

function restoreSquadUnit(d) {
  const u = new SquadUnit(d.type, d.slot);
  Object.assign(u, d);
  return u;
}

function restoreGameFromSave(save) {
  const mode = save.mode || 'solo';
  const W = canvas.width, H = canvas.height;
  const { bx, by } = getMapMetrics(W, H);

  GS = {
    phase: 'playing',
    paused: false,
    mode,
    score: save.score || 0,
    coins: save.coins ?? 80,
    stone: save.stone || 0,
    totalCoins: save.totalCoins ?? save.coins ?? 80,
    totalKills: save.totalKills || 0,
    timeSurvived: save.timeSurvived || 0,
    upgradeLevels: save.upgradeLevels || {},
    globalSquadDmgBonus: save.globalSquadDmgBonus || 0,
    maxSquadSize: save.maxSquadSize || 4,
    coinMagnetRange: save.coinMagnetRange ?? ((save.upgradeLevels?.coinMagnet || 0) * 40),
    weaponBonuses: save.weaponBonuses || {
      sword: { dmg: 0, hp: 0, atkSpeed: 0 },
      bow: { dmg: 0, range: 0, atkSpeed: 0 },
      magic: { dmg: 0, aoe: 0, atkSpeed: 0 },
    },
    wave: save.wave || 1,
    wavePhase: save.wavePhase || 'spawning',
    restTimer: save.restTimer || 0,
    spawnQueue: save.spawnQueue || buildSpawnQueue(save.wave || 1),
    spawnIdx: save.spawnIdx || 0,
    spawnTimer: save.spawnTimer || 0,
    spawnInterval: save.spawnInterval || getSpawnInterval(save.wave || 1),
    mapPaths: buildMapPaths(W, H, bx, by),
    base: new Base(bx, by),
    player: new Player(bx, by - 45),
    allies: [],
    squadUnits: [],
    enemies: [],
    coinEntities: [],
    projectiles: [],
    particles: [],
    baseWeapons: (save.baseWeapons || []).map(d => {
      const w = new BaseWeapon(0, 0, d.type);
      w.level = d.level;
      return w;
    }),
    turrets: restoreTurrets(save.turrets),
    buildings: restoreBuildings(save.buildings),
    spawnPads: [],
    manualTarget: null,
    selectedBuildingIdx: null,
    selectedTurretIdx: null,
    buildingBonuses: { coinKillPct: 0, baseRegenBonus: 0, squadDmg: 0, weaponDmgPct: 0 },
    _panelCoinKey: '',
    mouseX: bx,
    mouseY: by - 45,
    _saveTimer: 0,
  };

  Object.assign(GS.base, save.base);
  Object.assign(GS.player, save.player);
  GS.player.clearMoveTarget();

  GS.squadUnits = (save.squadUnits || []).map(restoreSquadUnit);
  GS.enemies = (save.enemies || []).map(restoreEnemy);

  rebuildMapLayout();
  recalcBuildingBonuses();
  GS.allies = createAllies(mode);

  const idx = save.manualTargetIdx;
  if (typeof idx === 'number' && idx >= 0 && idx < GS.enemies.length) {
    GS.manualTarget = GS.enemies[idx];
  }
}

function renderGameFrame() {
  if (GS.phase !== 'playing') return;
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  drawBackground(ctx, W, H);
  GS.buildings.forEach(b => b.draw(ctx));
  GS.turrets.forEach(t => t.draw(ctx));
  GS.baseWeapons.forEach(w => w.draw(ctx));
  GS.coinEntities.forEach(c => c.draw(ctx));
  GS.base.draw(ctx);
  GS.enemies.forEach(e => e.draw(ctx));
  GS.projectiles.forEach(p => p.draw(ctx));
  GS.squadUnits.forEach(u => u.draw(ctx));
  GS.allies.forEach(a => a.draw(ctx));
  GS.player.draw(ctx);
  GS.particles.forEach(p => p.draw(ctx));
  updateHUD();
}

function resumeSavedGame(save) {
  showScreen('game-container');
  document.getElementById('game-over-screen').classList.add('hidden');
  document.getElementById('victory-screen').classList.add('hidden');
  document.getElementById('upgrade-panel').classList.add('hidden');
  document.getElementById('base-panel').classList.add('hidden');
  document.getElementById('wave-countdown').classList.add('hidden');
  cancelAnimationFrame(animId);
  resizeCanvas();
  restoreGameFromSave(save);
  setupInput();
  enterMobilePlay();
  resizeCanvas();
  requestAnimationFrame(() => resizeCanvas());
  renderGameFrame();
  GS.paused = true;
  animId = null;
  document.getElementById('pause-overlay').classList.remove('hidden');
  document.getElementById('pause-btn').textContent = '▶ เล่นต่อ';
  const hint = document.querySelector('.pause-hint');
  if (hint) hint.textContent = 'เกมหยุดหลังรีเฟรช — กด Space หรือ Esc เพื่อเล่นต่อ';
}

// ============================================================
// SECTION 11 — INITIALISATION & DOM WIRING
// ============================================================

function getViewportSize() {
  const vv = window.visualViewport;
  if (vv) return { width: vv.width, height: vv.height };
  return { width: window.innerWidth, height: window.innerHeight };
}

function isTouchDevice() {
  return 'ontouchstart' in window || navigator.maxTouchPoints > 0;
}

function updateMobileHints() {
  const pauseHint = document.getElementById('pause-hint');
  if (pauseHint) {
    pauseHint.textContent = isTouchDevice()
      ? 'แตะปุ่มเล่นต่อ หรือกด ⏸ อีกครั้ง'
      : 'กด Space หรือ Esc เพื่อเล่นต่อ';
  }
}

function resizeCanvas() {
  const playArea = document.getElementById('game-play-area');
  const rect = playArea ? playArea.getBoundingClientRect() : canvas.getBoundingClientRect();
  const w = Math.max(320, Math.floor(rect.width));
  const h = Math.max(200, Math.floor(rect.height));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  if (GS.base) rebuildMapLayout();
}

function bindViewportResize() {
  const onResize = () => {
    updateMobilePlayLayout();
    requestAnimationFrame(() => {
      if (GS.phase === 'playing') resizeCanvas();
    });
  };
  window.addEventListener('resize', onResize);
  window.addEventListener('orientationchange', onResize);
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', onResize);
    window.visualViewport.addEventListener('scroll', onResize);
  }
}

function createAllies(mode) {
  const colors = ['#3B82F6', '#EC4899', '#8B5CF6'];
  const allies = [];
  if (mode === 'multi' && typeof Lobby !== 'undefined') {
    Lobby.getCoopNames().forEach((name, i) => {
      allies.push(new AllyPlayer(GS.base.x + 30 * (i + 1), GS.base.y - 30, name, colors[i % 3]));
    });
  }
  while (allies.length < 1 && mode === 'multi') {
    allies.push(new AllyPlayer(GS.base.x - 40, GS.base.y - 30, 'AI Ally', colors[0]));
  }
  return allies;
}

function initGameState(mode) {
  mode = mode || 'solo';
  const W = canvas.width, H = canvas.height;
  const { bx, by } = getMapMetrics(W, H);

  GS = {
    phase: 'playing',
    paused: false,
    mode: mode,
    score: 0,
    coins: 80,
    stone: 0,
    totalCoins: 80,
    totalKills: 0,
    timeSurvived: 0,

    upgradeLevels: {},
    globalSquadDmgBonus: 0,
    maxSquadSize: 4,
    coinMagnetRange: 0,

    weaponBonuses: {
      sword: { dmg: 0, hp: 0, atkSpeed: 0 },
      bow: { dmg: 0, range: 0, atkSpeed: 0 },
      magic: { dmg: 0, aoe: 0, atkSpeed: 0 },
    },

    wave: 1,
    wavePhase: 'spawning',
    restTimer: 0,
    spawnQueue: buildSpawnQueue(1),
    spawnIdx: 0,
    spawnTimer: 0,
    spawnInterval: getSpawnInterval(1),

    mapPaths: buildMapPaths(W, H, bx, by),

    base: new Base(bx, by),
    player: new Player(bx, by - 45),
    allies: [],
    squadUnits: [],
    enemies: [],
    coinEntities: [],
    projectiles: [],
    particles: [],

    baseWeapons: [
      new BaseWeapon(bx - 75, by + 5, 'sword'),
      new BaseWeapon(bx + 75, by + 5, 'bow'),
      new BaseWeapon(bx, by - 50, 'magic'),
    ],

    turrets: createTurretSlots(),

    buildings: BUILDING_ORDER.map(type => new ResourceBuilding(0, 0, type)),

    spawnPads: [],

    manualTarget: null,
    selectedBuildingIdx: null,
    selectedTurretIdx: null,
    buildingBonuses: { coinKillPct: 0, baseRegenBonus: 0, squadDmg: 0, weaponDmgPct: 0 },
    _panelCoinKey: '',

    mouseX: bx,
    mouseY: by - 45,
  };

  GS.player.clearMoveTarget();

  rebuildMapLayout();
  recalcBuildingBonuses();
  GS.allies = createAllies(mode);
}

function triggerLoginAnimations() {
  const screen = document.getElementById('login-screen');
  if (!screen) return;
  screen.classList.remove('login-animate');
  void screen.offsetWidth;
  screen.classList.add('login-animate');
}

function showScreen(id) {
  ['loading-screen', 'login-screen', 'main-menu', 'lobby-screen', 'game-container'].forEach(s => {
    document.getElementById(s).classList.toggle('hidden', s !== id);
  });
  if (id !== 'game-container') exitMobilePlay();
  if (id === 'main-menu') refreshContinueButton();
  if (id === 'login-screen') {
    triggerLoginAnimations();
    refreshLeaderboard();
  }
  updateMobilePlayLayout();
}

function startGame(mode) {
  clearGameSave();
  showScreen('game-container');
  document.getElementById('game-over-screen').classList.add('hidden');
  document.getElementById('victory-screen').classList.add('hidden');
  document.getElementById('upgrade-panel').classList.add('hidden');
  document.getElementById('base-panel').classList.add('hidden');
  document.getElementById('wave-countdown').classList.add('hidden');
  document.getElementById('pause-overlay').classList.add('hidden');
  document.getElementById('pause-btn').textContent = '⏸ หยุด';
  cancelAnimationFrame(animId);
  resizeCanvas();
  initGameState(mode);
  setupInput();
  enterMobilePlay();
  resizeCanvas();
  requestAnimationFrame(() => resizeCanvas());
  showWaveAnnouncement(1);
  lastTs = performance.now();
  animId = requestAnimationFrame(gameLoop);
}

function formatLeaderboardTime(totalSeconds) {
  const sec = Math.max(0, Math.floor(totalSeconds || 0));
  const h = Math.floor(sec / 3600);
  let m = Math.floor((sec % 3600) / 60);
  if (h === 0 && m === 0 && sec > 0) m = 1;
  if (h > 0) return `${h} ชม. ${m} น.`;
  return `${m} น.`;
}

async function refreshLeaderboard() {
  const list = document.getElementById('leaderboard-list');
  if (!list || typeof Auth === 'undefined' || !Auth.getLeaderboard) return;

  list.innerHTML = '';
  const loading = document.createElement('li');
  loading.className = 'score-board-empty score-board-loading';
  loading.innerHTML = '<span class="load-dots">กำลังโหลด</span>';
  list.appendChild(loading);

  const r = await Auth.getLeaderboard(5);
  list.innerHTML = '';

  if (!r.ok || !r.rows.length) {
    const li = document.createElement('li');
    li.className = 'score-board-empty lb-row-enter';
    li.textContent = r.ok ? 'ยังไม่มีคะแนน — เป็นคนแรกที่ขึ้นป้าย!' : 'โหลดอันดับไม่ได้';
    list.appendChild(li);
    return;
  }

  const rankIcons = ['🥇', '🥈', '🥉', '4', '5'];

  r.rows.forEach((row, i) => {
    const li = document.createElement('li');
    li.className = `rank-${i + 1} lb-row-enter`;
    li.style.animationDelay = `${0.12 + i * 0.1}s`;

    const rank = document.createElement('span');
    rank.className = 'score-board-rank';
    rank.textContent = rankIcons[i] || String(i + 1);

    const body = document.createElement('div');
    body.className = 'score-board-body';

    const name = document.createElement('span');
    name.className = 'score-board-name';
    name.textContent = row.username;
    name.title = row.username;

    const meta = document.createElement('div');
    meta.className = 'score-board-meta';
    const plays = Number(row.play_count) || 0;
    const time = formatLeaderboardTime(row.total_time_seconds);
    meta.innerHTML =
      `<span class="meta-chip meta-time">⏱ ${time}</span>` +
      `<span class="meta-chip meta-plays">🎮 ${plays.toLocaleString()} ครั้ง</span>`;

    body.appendChild(name);
    body.appendChild(meta);

    const scoreWrap = document.createElement('div');
    scoreWrap.className = 'score-board-score-wrap';
    const score = document.createElement('span');
    score.className = 'score-board-score score-pop';
    score.style.animationDelay = `${0.22 + i * 0.1}s`;
    score.textContent = Number(row.total_score ?? row.score ?? 0).toLocaleString();
    scoreWrap.appendChild(score);

    li.appendChild(rank);
    li.appendChild(body);
    li.appendChild(scoreWrap);
    list.appendChild(li);
  });
}

function refreshLobbyUI() {
  const panel = document.getElementById('room-panel');
  const list = document.getElementById('player-list');
  const codeEl = document.getElementById('room-code-display');
  const startBtn = document.getElementById('start-mp-btn');
  if (!Lobby.roomCode) {
    panel.classList.add('hidden');
    return;
  }
  panel.classList.remove('hidden');
  codeEl.textContent = Lobby.roomCode;
  list.innerHTML = '';
  const me = Auth.current();
  Lobby.players.forEach(p => {
    const li = document.createElement('li');
    li.className = (p.host ? 'host ' : '') + (p.id === me?.id ? 'you' : '');
    li.textContent = p.name + (p.host ? ' (Host)' : '');
    list.appendChild(li);
  });
  if (Lobby.isHost) startBtn.classList.remove('hidden');
  else startBtn.classList.add('hidden');
}

window.addEventListener('load', () => {
  canvas = document.getElementById('game-canvas');
  ctx = canvas.getContext('2d');

  const loadingBar = document.getElementById('loading-bar');
  const loadingText = document.getElementById('loading-text');
  const loginErr = document.getElementById('login-error');
  const showLoginErr = (msg) => { loginErr.textContent = msg; loginErr.classList.remove('hidden'); };

  if (typeof Auth === 'undefined') {
    console.error('kingshot-session.js ไม่โหลด');
    loadingText.textContent = 'โหลดระบบ login ไม่สำเร็จ';
    showLoginErr('โหลดระบบ login ไม่สำเร็จ — ลองรีเฟรชหน้า');
    setTimeout(() => showScreen('login-screen'), 350);
    return;
  }

  new AssetLoader()
    .onProgress(p => {
      loadingBar.style.width = `${p * 100}%`;
      loadingText.textContent = `โหลด… ${Math.floor(p * 100)}%`;
    })
    .onComplete(async (images) => {
      ASSETS = images || {};
      loadingBar.style.width = '100%';
      loadingText.textContent = 'พร้อมแล้ว!';
      let session = null;
      try {
        session = await Auth.restoreSession();
      } catch (err) {
        console.error('restoreSession failed:', err);
      }
      setTimeout(() => {
        const save = loadGameSave();
        if (session && save && save.playerId === session.id && save.phase === 'playing') {
          document.getElementById('menu-username').textContent = session.username;
          resumeSavedGame(save);
        } else if (session) {
          if (save && save.playerId !== session.id) clearGameSave();
          document.getElementById('menu-username').textContent = session.username;
          showScreen('main-menu');
        } else {
          clearGameSave();
          showScreen('login-screen');
        }
      }, 350);
    })
    .load(buildAssetMap());

  document.getElementById('login-btn').addEventListener('click', async () => {
    const u = document.getElementById('login-username').value;
    const p = document.getElementById('login-password').value;
    const btn = document.getElementById('login-btn');
    btn.disabled = true;
    const r = await Auth.login(u, p);
    btn.disabled = false;
    if (!r.ok) return showLoginErr(r.msg);
    loginErr.classList.add('hidden');
    document.getElementById('menu-username').textContent = r.session.username;
    showScreen('main-menu');
  });

  document.getElementById('register-btn').addEventListener('click', async () => {
    const u = document.getElementById('login-username').value;
    const p = document.getElementById('login-password').value;
    const btn = document.getElementById('register-btn');
    btn.disabled = true;
    const r = await Auth.register(u, p);
    btn.disabled = false;
    if (!r.ok) return showLoginErr(r.msg);
    loginErr.classList.add('hidden');
    document.getElementById('menu-username').textContent = r.session.username;
    showScreen('main-menu');
  });

  document.getElementById('guest-btn').addEventListener('click', () => {
    const r = Auth.guest();
    document.getElementById('menu-username').textContent = r.session.username;
    showScreen('main-menu');
  });

  document.getElementById('logout-btn').addEventListener('click', async () => {
    clearGameSave();
    await Auth.logout();
    Lobby.leaveRoom();
    document.getElementById('login-username').value = '';
    document.getElementById('login-password').value = '';
    document.getElementById('menu-username').textContent = 'Guest';
    loginErr.classList.add('hidden');
    showScreen('login-screen');
  });

  document.getElementById('solo-btn').addEventListener('click', () => startGame('solo'));

  document.getElementById('multi-btn').addEventListener('click', () => {
    showScreen('lobby-screen');
    refreshLobbyUI();
  });

  document.getElementById('back-menu-btn').addEventListener('click', () => {
    Lobby.leaveRoom();
    showScreen('main-menu');
  });

  document.getElementById('create-room-btn').addEventListener('click', () => {
    const r = Lobby.createRoom();
    const err = document.getElementById('lobby-error');
    if (!r.ok) { err.textContent = r.msg; err.classList.remove('hidden'); return; }
    err.classList.add('hidden');
    refreshLobbyUI();
  });

  document.getElementById('join-room-btn').addEventListener('click', () => {
    const code = document.getElementById('room-code-input').value;
    const r = Lobby.joinRoom(code);
    const err = document.getElementById('lobby-error');
    if (!r.ok) { err.textContent = r.msg; err.classList.remove('hidden'); return; }
    err.classList.add('hidden');
    refreshLobbyUI();
  });

  document.getElementById('leave-room-btn').addEventListener('click', () => {
    Lobby.leaveRoom();
    refreshLobbyUI();
  });

  document.getElementById('start-mp-btn').addEventListener('click', () => {
    if (Lobby.startGame()) startGame('multi');
  });

  Lobby.onUpdate = refreshLobbyUI;
  window.onLobbyStart = () => startGame('multi');

  function restartGame() {
    const mode = GS.mode || 'solo';
    startGame(mode);
  }
  document.getElementById('restart-btn').addEventListener('click', restartGame);
  document.getElementById('victory-restart-btn').addEventListener('click', restartGame);

  document.getElementById('pause-btn').addEventListener('click', () => {
    if (GS.paused) resumeGame();
    else pauseGame();
  });
  document.getElementById('pause-resume-btn').addEventListener('click', resumeGame);
  document.getElementById('pause-quit-btn').addEventListener('click', exitToMenuFromPause);

  document.getElementById('continue-btn').addEventListener('click', () => {
    const save = loadGameSave();
    if (save) resumeSavedGame(save);
  });

  document.addEventListener('keydown', e => {
    if (e.code === 'Space' || e.code === 'Escape') {
      e.preventDefault();
      if (GS.phase === 'playing') {
        if (GS.paused) resumeGame();
        else pauseGame();
      }
    }
  });

  document.getElementById('upgrade-btn').addEventListener('click', () => {
    const panel = document.getElementById('upgrade-panel');
    document.getElementById('base-panel').classList.add('hidden');
    const isHidden = panel.classList.toggle('hidden');
    if (!isHidden) buildUpgradeUI();
  });

  document.getElementById('base-upgrade-btn').addEventListener('click', () => {
    const panel = document.getElementById('base-panel');
    document.getElementById('upgrade-panel').classList.add('hidden');
    const isHidden = panel.classList.toggle('hidden');
    if (!isHidden) buildBasePanelUI();
  });

  document.getElementById('close-upgrades').addEventListener('click', () => {
    document.getElementById('upgrade-panel').classList.add('hidden');
  });

  document.getElementById('close-base-panel').addEventListener('click', () => {
    document.getElementById('base-panel').classList.add('hidden');
  });

  bindViewportResize();
  setupMobileJoystick();
  markTouchDevice();
  updateMobileHints();
  document.addEventListener('touchstart', markTouchDevice, { once: true, passive: true });

  window.addEventListener('beforeunload', () => saveGameState());
});
