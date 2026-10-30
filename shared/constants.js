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
  mantleHeight: 0.72,   // in the air: climb over a ledge this far above the feet (a jump reaches ~1.4 m, so 2 m walls)
  maxFallSpeed: 45,
  headTop: 1.86,
  headBottom: 1.44,
  headHalf: 0.17,
};

export const RIFLE = {
  damage: 25,         // 4 body hits or 2 headshots
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
  falloffMin: 0.7,
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
  supportRatio: 40,      // a building piece needs a ground contact per this many voxels...
  supportLoss: 2.2,      // ...or per (its intact weight-per-contact x this), whichever is more, or it collapses
  supportMinMass: 120,   // smaller bits (signs, roof clutter) are left to the floating check
};

export const BOT_DIFFICULTY = {
  // reaction: seconds before a newly seen target is engaged; aimError: wobble (rad); turnRate: rad/s;
  // fireCone: max aim error before pulling the trigger; damage: multiplier on damage bots deal
  easy:   { reaction: 1.8, aimError: 0.32, turnRate: 1.6, fireCone: 0.06, burst: [1, 3], burstPause: 1.5, rocketChance: 0, strafe: 0.1, headshot: 0.0, lead: 0.0, viewRange: 24, damage: 0.18, missChance: 0.65, settleTime: 5 },
  medium: { reaction: 1.1, aimError: 0.2, turnRate: 2.4, fireCone: 0.055, burst: [2, 4], burstPause: 1.0, rocketChance: 0.06, strafe: 0.3, headshot: 0.02, lead: 0.15, viewRange: 34, damage: 0.27, missChance: 0.45, settleTime: 3.8 },
  hard:   { reaction: 0.6, aimError: 0.11, turnRate: 4.0, fireCone: 0.05, burst: [3, 7], burstPause: 0.6, rocketChance: 0.18, strafe: 0.6, headshot: 0.1, lead: 0.5, viewRange: 50, damage: 0.36, missChance: 0.28, settleTime: 2.8 },
};

export const MAP_ROTATION = ['skyline', 'harbor', 'downtown'];

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
