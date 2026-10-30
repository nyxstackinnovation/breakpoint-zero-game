# BREAKPOINT ZERO

A browser-based multiplayer first-person shooter with destructible voxel buildings, built with
**Three.js**, **vanilla JavaScript**, **Node.js** and **WebSockets**.

Up to eight players (humans + bots) fight free-for-all on three maps. Rockets blow real holes
in buildings. Cut through a structure's supports and the part above breaks off, falls,
crushes anyone underneath, then settles as rubble.

---

## Quick start

Requirements: **Node.js 18.17 or newer** (Node 20/22 LTS recommended) and a modern desktop browser
(Chrome, Edge or Firefox) with WebGL 2.

```bash
cd E:\nyxstack\games\breakpoint-zero
npm install
npm start
```

Open **http://localhost:3001** in your browser. The server also prints your LAN address
(for example `http://192.168.1.20:3001`). Other people on your network can join through that address.

* Change the port: `set PORT=4000 && npm start` (Windows cmd), `$env:PORT=4000; npm start` (PowerShell), or `PORT=4000 npm start` (macOS/Linux).
* Auto-restart while editing server code: `npm run dev`.
* Run the test suite: `npm test`.

To play over the internet, forward TCP port 3001 on your router to the machine running the
server and share `http://<your-public-ip>:3001`. You can also put it behind a reverse proxy;
the client switches to `wss://` automatically when the page is served over HTTPS.

---

## How to play

| Control | Action |
| --- | --- |
| **W A S D** | Move |
| **Mouse** | Look / aim |
| **Space** | Jump (hold to keep hopping) |
| **Left mouse** | Automatic rifle |
| **Right mouse** (or Q) | Rocket launcher |
| **R** | Reload rifle (it also reloads by itself when empty) |
| **Tab** (hold) | Scoreboard |
| **Esc** | Menu (resume, settings, leave; host controls in private rooms) |

* **Free-for-all, 4-minute rounds.** The most kills wins. After a 10-second results screen
  the next map in the rotation loads.
* **Kills restore 50 health** to the killer. There is no passive regeneration.
* **Respawn** 3 seconds after death, at the spawn point farthest from enemies, with 1.5 s of spawn protection.
  Protection ends as soon as you fire.
* **Rifle:** 600 rpm, 30-round magazine, 25 damage per hit (4 body hits or 2 headshots), spread grows with
  sustained fire, movement and jumping. Recoil kicks your aim, so pull down to control it.
* **Rockets:** 4 rockets that regenerate one every 2.4 s. They do splash damage and knockback, and
  they carve out a sphere of voxels.
* **Rocket jump:** jump and fire a rocket at your feet. You take reduced self-damage (35%) and get
  a big boost of upward speed.
* **Demolition:** anything that loses its connection to the ground collapses as a rigid
  chunk, deals crushing damage to anyone it falls on (credited to whoever caused it, shown as
  `CRUSHED`), then breaks into rubble that stays in the map.

### Modes

* **Quick Match:** joins the busiest public room, or creates one. Public rooms are always
  running and are filled with 5 **easy** bots. A bot leaves whenever a human joins, so the room never goes over 8 players.
* **Private room:** creates a lobby with a 5-character code. Friends join with **Join → code**.
  The host picks the start map, bot count (0–7), bot difficulty (easy / medium / hard) and map
  rotation (easy bots are slow to notice you, turn slowly, miss most shots, never fire rockets
  and do about 4 damage per hit; medium bots about 7 and hard bots about 9, with faster aim and more rockets), can kick players, start the match, skip to the next map, or end the match and return everyone to
  the lobby. If the host leaves, host rights pass to another player.

### Maps

| Map | Theme |
| --- | --- |
| **Skyline** | Colourful rooftops, sky bridges and a central fountain plaza under a sunset sky |
| **Harbor** | Stacked shipping containers, warehouses, piers and a giant dock crane over the water |
| **Downtown** | Multi-storey offices, a parking garage with ramps, parked cars and an elevated walkway |

Each round generates its map from a fresh random seed, so building layout and colours vary every round.

### Settings

Mouse sensitivity, field of view, master volume, graphics quality (low / medium / high:
pixel ratio, shadows, particle density, antialiasing), invert Y, nameplates, FPS/ping
counter and screen shake. Settings are saved in the browser.
Antialiasing changes take effect after reloading the page.

---

## Architecture

```
breakpoint-zero/
├── server/
│   ├── index.js        HTTP static server + WebSocket endpoint (/ws), fixed 60 Hz loop, port 3001
│   ├── rooms.js        Quick Match, private rooms/codes, host controls, bot filling
│   ├── game.js         Authoritative simulation: movement, weapons, lag-compensated hitscan,
│   │                   rockets, explosions, destruction, collapse + crushing, rounds, rotation
│   ├── bot.js          Bot AI (perception, aiming, strafing, rockets, wall breaching, unsticking)
│   └── nav.js          A* pathfinding over the live voxel grid (walk / step / jump / drop)
├── shared/             Runs unchanged on server and client (client-side prediction)
│   ├── constants.js    Tuning: tick rate, weapons, physics, rounds, bot difficulty
│   ├── voxelWorld.js   Voxel grid, DDA raycast, deterministic carving, floating-cluster
│   │                   detection, falling-chunk simulation, RLE serialisation
│   ├── physics.js      Player movement: quake-style accel, AABB-vs-voxel collision, step-up
│   ├── weapons.js      Tick-exact weapon timing, deterministic spread
│   ├── protocol.js     Binary input and snapshot encoding
│   ├── maps.js         Four seeded procedural map generators
│   └── util.js         Hashing, PRNG, base64, maths
├── client/
│   ├── index.html, css/style.css     Arcade UI (menus, lobby, HUD, overlays)
│   ├── js/main.js       App shell: screens, lobby, settings, pause, render loop
│   ├── js/game.js       Prediction + reconciliation, interpolation, events, camera
│   ├── js/voxels.js     Chunked greedy mesher with baked AO + voxel detail shader
│   ├── js/characters.js Rigged human soldiers: skeletal animation, aim, arm IK, deaths
│   ├── js/viewmodel.js  First-person arms + weapons: sway, bob, recoil, reload, swaps, brass
│   ├── js/weaponModels.js  Detailed procedural rifle / rocket launcher / projectile models
│   ├── js/effects.js    Particles, debris, tracers, decals, explosions, rockets
│   ├── js/audio.js      Procedural WebAudio sound with HRTF spatialisation
│   ├── js/hud.js        HUD, kill feed, hit markers, damage direction, nameplates, scoreboard
│   ├── js/scene.js      Renderer, sky, lighting, shadows, backdrops, water
│   ├── js/input.js, net.js, settings.js
│   ├── assets/models/soldier.glb      Rigged, animated human soldier
│   └── dev/viewer.html  Model viewer for characters / first-person weapons
└── tests/              node:test suite (55 tests)
```

### Networking

* **Authoritative server.** Clients send inputs only: button bits, yaw/pitch, a sequence number
  and the server tick they were viewing. The server runs the same physics and weapon code at
  60 Hz and decides every hit, every explosion and every voxel removed.
* **Client-side prediction.** The client runs the shared movement and weapon code immediately
  for its own player. Each 20 Hz snapshot carries the last processed input. The client rewinds to
  the server state, replays the inputs the server hasn't processed yet, and blends out any error so corrections don't snap.
* **Smooth remote movement.** Other players are interpolated about 115 ms in the past between
  snapshots, with short extrapolation if packets are late. The client tracks the server clock continuously.
* **Lag compensation.** Hitscan shots rewind targets to the tick the shooter was looking at
  (up to 1 s of history).
* **Reliable world sync.** Explosions are sent as a centre and radius. Clients reproduce the
  exact same carve with a deterministic integer algorithm. Collapsing chunks are sent as voxel lists, and a
  landing event tells clients the exact drop distance. Late joiners get a compressed copy of the current grid,
  including any chunks still falling.
* **Compact traffic.** Inputs are 17 bytes per tick. Snapshots are 37 bytes per player and are
  binary and uncompressed. Large JSON messages (maps) use permessage-deflate. The server limits input
  rate (no speed hacks), message rate and payload size.

### Destruction

1. A rocket carves a noisy sphere of voxels. Bedrock and the arena wall can't be destroyed.
2. Solid voxels next to the hole are flood-filled; the search heads downward first, so it reaches the ground quickly.
   Anything that can't reach bedrock is a floating cluster. Props don't count as support.
3. Buildings also need enough support. For each building the map remembers how much weight each ground
   contact carried when it was intact. If too much of its base is shot away, so that it stands only on its
   stairs, an inner column or a sky bridge, the rest of the ground floor crumbles and everything above
   drops as one chunk.
4. Clusters are removed from the grid and fall as rigid bodies. They stop when any of their bottom voxels
   meets solid ground. Debris left underneath can hold a chunk up partway, as it would in reality.
5. While falling, a chunk deals crushing damage to anyone it passes through. On impact about 35%
   of its voxels shatter into debris, and the rest are written back into the grid as rubble.
6. Bot pathfinding reads the live grid, so bots walk through new holes and climb over rubble.

### Rendering

* World is meshed in 16³ chunks with greedy merging and per-vertex ambient occlusion. Only the chunks
  touched by a change are re-meshed. A shader adds per-voxel colour variation and fine
  grid lines without breaking greedy merging.
* Shadow-mapped sun, hemisphere light, gradient sky with clouds, distance fog, themed
  backdrops (city skyline, sea, mesas), water.
* Characters are the five operators from the reference sheets in `client/assets/character/`,
  modelled, rigged and animated in Blender (see *3D assets* below):
  * **Viper:** black tank top, scarf, plate carrier, elbow pads, boots, ponytail.
  * **Ranger:** olive field jacket over a hoodie, dog tags, backpack, sneakers.
  * **Nova:** white cropped jacket with red stripes, backpack, sneakers, ponytail.
  * **Ghost:** black hoodie, coyote plate carrier, over-ear headset, tan boots.
  * **Blaze:** black and red jacket, chest rig, sunglasses, sneakers.

  Their faces are the face close-ups from the sheets, projected onto the head
  (`client/assets/textures/faces.png`, made by `tools/textures/face_atlas.py`). Each player always
  plays the same operator, picked from their id, with a team-coloured shoulder patch. Each operator
  is one skinned mesh, so it costs only 2 draw calls.

  Idle, walk, run, back-pedal, strafe-left/right and jump clips are blended 8-way by velocity, and
  the spine and neck bend with the aim. Three death animations (forward, backward, headshot) are
  picked from the hit direction, and explosive deaths fling the body instead.
* Maps use a voxel texture array (brick, concrete, wood, metal, sand, grass… with normal maps),
  and are dressed with 22 kinds of Blender props (cars, crates, barrels, lamps, benches, plants,
  barriers…). Props block movement and bullets, and break when a blast hits them or the floor
  under them is destroyed.
* Effects: GPU point particles (fire, smoke, sparks, dust, blood), up to 1,400 instanced
  physical debris cubes that collide with the world, instanced tracers, bullet-hole decals that
  disappear with the wall behind them, dynamic explosion/muzzle lights, shock rings, rocket trails.
* Bullets: tracers with heat glow, per-material impacts (sparks on metal, splinters on wood,
  dust on stone and sand, splashes on water), shell casings, bullet whizzes when shots pass
  close to you.
* First-person rifle, launcher and gloved arms come from Blender and render in a separate pass so
  they never clip into walls.
* Kill feedback: when you eliminate someone, a skull medallion and ribbon show the victim
  (ELIMINATED / HEADSHOT / BLASTED / DEMOLISHED), the health you got back and streaks
  (double kill, triple kill, rampage…), with a short kill-zoom and a gold screen pulse.
  When you die, the death screen shows who killed you and how much health they had left.

### Sound

All sound is synthesised with WebAudio: layered rifle shots, rocket launch and flight loop,
explosions with debris rumble, per-material bullet impacts and footsteps, bullet whizzes,
hit-marker / headshot / kill confirmation tones, streak stingers, reload and shell sounds,
heartbeat at low health. Sounds are positioned in 3D (HRTF), muffled by distance and by walls
between you and the source, delayed by the speed of sound at range, and played through a
reverb tuned per map.

### 3D assets (Blender)

The characters (`build_operators.py`), first-person arms, weapons and props are generated by
Python scripts in `tools/blender/` and exported to `client/assets/models/*.glb`. The built files are included,
so you only need Blender to change them. To rebuild (Blender 4.2 or newer):

```
tools\blender\build_assets.bat
```

or from a terminal: `blender --background --factory-startup --python tools/blender/run_all.py`.
The game falls back to procedural models if the `.glb` files are missing.
If you change the face crops, run `python tools/textures/face_atlas.py` (needs numpy and Pillow) before
rebuilding the operators.

---

## Tests

`npm test` runs 59 tests covering:

* voxel raycasting, carving determinism, RLE/base64 serialisation
* structural collapse (floating cluster detection, overhangs, falling, settling, deterministic shattering)
* props breaking under blasts, losing their collision and syncing to clients
* crushing a player with a collapsing slab and crediting the kill
* movement physics (landing, walls, step-up, jump apex, ceilings, rocket impulse, determinism, unburying)
* weapon timing (600 rpm, auto-reload, rocket cooldown/regen, spread)
* building support (a building on its stairs collapses, one damaged wall doesn't)
* combat (hit damage, headshots, lag compensation, rocket jump, explosions, respawn, kill heal,
  round timer, intermission, map rotation, input-rate limiting, 8-bot matches at all difficulties)
* rooms (Quick Match fill/bot swapping, private codes, host-only controls, kicking, host migration,
  room full, name sanitising)
* all three maps (determinism, bedrock, spawn validity, destructibility, A* paths between spawns)
* integration over real sockets (static files, two clients in Quick Match, server-side movement from
  binary inputs, private room flow)

---

## Troubleshooting

* **Black screen or "WebGL" errors:** enable hardware acceleration in your browser settings and update your GPU drivers.
* **Low frame rate:** set graphics quality to Low in Settings (turns off shadows and lowers resolution).
* **The mouse doesn't turn the camera:** click the game window. The browser only captures the mouse after a click,
  and Esc releases it.
* **Friends can't connect:** allow Node.js through Windows Firewall on private networks and check that they use
  your LAN IP and port 3001.
* **Port already in use:** start with a different port (see Quick start).

## Credits

* Rendering: [three.js](https://threejs.org) r170 (MIT).
* Networking: [ws](https://github.com/websockets/ws) (MIT).
* Characters, arms, weapons and props: generated procedurally in Blender by the scripts in `tools/blender/`.
* Fallback soldier (used only if the Blender characters are missing): the rigged "Vanguard" soldier from Mixamo,
  as distributed with the three.js examples (`examples/models/gltf/Soldier.glb`).
* Everything else (maps, textures, effects, sound, UI) is procedurally generated in code.
