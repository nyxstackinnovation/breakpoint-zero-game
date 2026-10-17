// Shared tuning constants. Imported by both the Node server and the browser client
// so that client-side prediction runs exactly the same rules as the server.

export const PROTOCOL_VERSION = 3;

export const TICK_RATE = 60;            // simulation steps per second (server + client prediction)
export const DT = 1 / TICK_RATE;
export const SNAPSHOT_EVERY = 3;        // server sends a snapshot every N ticks (20 Hz)
export const INTERP_DELAY_TICKS = 7;    // remote entities are rendered ~115 ms in the past
export const HISTORY_TICKS = 60;        // lag compensation window (1 s)

export const VOXEL = 0.5;               // metres per voxel
export const WORLD_X = 128;
export const WORLD_Y = 64;
export const WORLD_Z = 128;

export const MAX_PLAYERS = 8;           // humans + bots per room
export const ROUND_SECONDS = 240;       // four minute rounds
export const INTERMISSION_SECONDS = 10;
export const RESPAWN_SECONDS = 3;
export const SPAWN_PROTECT_SECONDS = 1.5;
export const KILL_HEAL = 50;            // health restored to the killer
export const MAX_HEALTH = 100;

export const PLAYER = {
  radius: 0.3,          // half width of the collision box
  height: 1.8,
  eye: 1.62,
  walkSpeed: 7.2,
  groundAccel: 11,      // quake-style acceleration factor
  airAccel: 2.2,
  airSpeedCap: 1.4,     // wish speed cap in air (allows strafing without infinite gain)
  friction: 7.5,
  stopSpeed: 2.0,
  gravity: 24,
  jumpVelocity: 8.4,
  stepHeight: 0.51,     // automatic step up one voxel
  maxFallSpeed: 45,
  headTop: 1.86,
  headBottom: 1.44,
  headHalf: 0.17,
};

export const RIFLE = {
  damage: 15,
  headMultiplier: 2.0,
  fireInterval: 0.1,     // 600 rpm
  magazine: 30,
  reloadTime: 1.7,
  range: 160,
  spreadBase: 0.0035,
  spreadMove: 0.018,
  spreadAir: 0.04,
  spreadPerShot: 0.0035,
  spreadMax: 0.045,
  spreadRecovery: 0.12,  // radians per second
  recoilPitch: 0.0085,   // view kick applied by the client (part of the real aim)
  recoilYaw: 0.0035,
  falloffStart: 30,
  falloffEnd: 90,
  falloffMin: 0.6,
};

export const ROCKET = {
  speed: 36,
  radius: 4.2,            // splash radius (m)
  damage: 105,
  minDamage: 12,
  directHitBonus: 20,
  selfDamageMultiplier: 0.35,
  knockback: 15.5,        // velocity added at the centre of the blast
  selfKnockMultiplier: 1.25,
  upBias: 0.35,
  carveRadius: 2.2,       // destruction radius (m)
  cooldown: 0.8,
  maxAmmo: 4,
  regenTime: 2.4,
  lifetime: 6,
  hitRadius: 0.25,
};

export const CRUSH = {
  minSpeed: 2.5,
  baseDamage: 45,
  speedDamage: 6,
  cooldown: 0.25,
  shatterFraction: 0.35,  // portion of a collapsed chunk that breaks into debris on landing
  minClusterForFall: 6,
  maxClusterSearch: 120000,
};

export const BOT_DIFFICULTY = {
  easy:   { reaction: 0.65, aimError: 0.11, turnRate: 3.2, fireCone: 0.09, burst: [3, 5], burstPause: 0.55, rocketChance: 0.15, strafe: 0.35, headshot: 0.05, lead: 0.0, viewRange: 45 },
  medium: { reaction: 0.38, aimError: 0.055, turnRate: 6.0, fireCone: 0.06, burst: [5, 9], burstPause: 0.3, rocketChance: 0.35, strafe: 0.65, headshot: 0.2, lead: 0.5, viewRange: 60 },
  hard:   { reaction: 0.2, aimError: 0.022, turnRate: 10.0, fireCone: 0.04, burst: [8, 16], burstPause: 0.15, rocketChance: 0.55, strafe: 1.0, headshot: 0.45, lead: 1.0, viewRange: 80 },
};

export const MAP_ROTATION = ['skyline', 'harbor', 'quarry', 'downtown'];

// Button bitmask used in input packets.
export const BTN = {
  FORWARD: 1,
  BACK: 2,
  LEFT: 4,
  RIGHT: 8,
  JUMP: 16,
  FIRE: 32,
  ROCKET: 64,
  RELOAD: 128,
};

export const PLAYER_COLORS = [
  0xff3b5c, 0x2ec4ff, 0xffc93c, 0x7dff5a, 0xb36bff, 0xff8a2b, 0x26f0c8, 0xff5fd2,
  0xe8e8e8, 0x5a7dff,
];

export const WEAPON = { RIFLE: 1, ROCKET: 2, CRUSH: 3, FALL: 4 };
export const WEAPON_NAMES = { 1: 'RIFLE', 2: 'ROCKET', 3: 'CRUSHED', 4: 'FALL' };
