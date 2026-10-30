// Application shell: menus, lobby, settings, pause, networking and the render loop.

import { Net } from './net.js';
import { Input } from './input.js';
import { AudioEngine } from './audio.js';
import { Hud } from './hud.js';
import { SceneManager } from './scene.js';
import { CharacterFactory } from './characters.js';
import { ClientGame } from './game.js';
import { settings, QUALITY } from './settings.js';
import { TouchControls } from './touch.js';
import { PLAYER_COLORS, PROTOCOL_VERSION } from '/shared/constants.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const hex = (c) => '#' + c.toString(16).padStart(6, '0');

class App {
  constructor() {
    this.canvas = $('view');
    this.net = new Net();
    this.input = new Input(this.canvas);
    if (this.input.touch) {
      document.body.classList.add('touch');
      const sens = $('opt-sens').parentElement.firstChild;
      if (sens && sens.nodeType === 3) sens.textContent = 'LOOK SENSITIVITY ';
      this.input.touchControls = new TouchControls(this.input, $('touch-controls'), {
        onPause: () => { if (this.screen === 'hud' && this.input.locked) this.input.unlock(); },
        onScoreboard: (down) => {
          if (this.screen !== 'hud') return;
          this.scoreboardOpen = down;
          this.hud.showScoreboard(down || this.game.serverState === 'intermission');
        },
      });
    }
    this.audio = new AudioEngine();
    this.audio.setVolume(settings.get('volume'));
    this.hud = new Hud();
    this.sceneManager = new SceneManager(this.canvas, QUALITY[settings.get('quality')] || QUALITY.medium);
    this.characterFactory = new CharacterFactory();
    this.game = new ClientGame(this);
    this.room = null;
    this.myId = 0;
    this.paused = false;
    this.scoreboardOpen = false;
    this.screen = 'menu';
    this.fps = 60;
    this.inMatch = false;
    this.bindUi();
    this.bindNet();
    this.characterFactory.load();
    this.net.connect();
    this.last = performance.now();
    requestAnimationFrame((t) => this.loop(t));
    window.__bpz = this; // handy for debugging / automated tests
  }

  // ---------------------------------------------------------------- screens

  show(screen) {
    this.screen = screen;
    for (const id of ['screen-menu', 'screen-lobby', 'screen-loading', 'hud']) $(id).classList.remove('active');
    const map = { menu: 'screen-menu', lobby: 'screen-lobby', loading: 'screen-loading', hud: 'hud' };
    $(map[screen]).classList.add('active');
    document.body.classList.toggle('in-match', screen === 'hud' || (screen === 'loading' && !!this.inMatch));
    if (screen !== 'hud') {
      $('click-to-play').classList.add('hidden');
      $('pause-menu').classList.add('hidden');
      this.input.enabled = false;
      // keep the pointer captured while the next map of a running match loads
      if (screen !== 'loading' || !this.inMatch) this.input.unlock();
    }
  }

  showLoading(name) {
    this.show('loading');
    $('loading-map').textContent = name;
    $('loading-bar').style.width = '0%';
    $('loading-text').textContent = 'BUILDING WORLD…';
  }

  loadingProgress(p) {
    $('loading-bar').style.width = `${Math.round(p * 100)}%`;
    if (p >= 1) $('loading-text').textContent = 'DEPLOYING…';
  }

  showHud() {
    this.show('hud');
    this.input.enabled = true;
    this.inMatch = true;
    // touch screens have no mouse to capture: go straight into play (unless the pause menu is open)
    if (this.input.touch) { if (!this.paused) this.input.lock(); }
    else if (!this.input.locked) $('click-to-play').classList.remove('hidden');
    this.updatePauseMenu();
  }

  toast(msg, kind = '') {
    const t = document.createElement('div');
    t.className = `toast ${kind}`;
    t.textContent = msg;
    $('toasts').appendChild(t);
    setTimeout(() => t.remove(), 3200);
  }

  // ---------------------------------------------------------------- ui wiring

  bindUi() {
    const nameInput = $('name-input');
    nameInput.value = settings.get('name') || `Player${Math.floor(Math.random() * 900 + 100)}`;
    nameInput.addEventListener('change', () => settings.set('name', nameInput.value.trim().slice(0, 16)));
    const name = () => { const n = nameInput.value.trim().slice(0, 16) || 'Player'; settings.set('name', n); return n; };
    const click = (id, fn) => $(id).addEventListener('click', (e) => { this.audio.unlock(); this.audio.ui(); this.mobileFullscreen(id); fn(e); });

    // bot skill for Quick Match, remembered between visits
    const skillBtns = [...document.querySelectorAll('#quick-skill button')];
    const showSkill = () => { for (const b of skillBtns) b.classList.toggle('on', b.dataset.v === settings.get('botSkill')); };
    for (const b of skillBtns) b.addEventListener('click', () => { settings.set('botSkill', b.dataset.v); showSkill(); this.audio.ui?.(); });
    showSkill();
    const mapBtns = [...document.querySelectorAll('#quick-map button')];
    if (!mapBtns.some((b) => b.dataset.v === settings.get('quickMap'))) settings.set('quickMap', 'any'); // a removed map was saved
    const showMap = () => { for (const b of mapBtns) b.classList.toggle('on', b.dataset.v === settings.get('quickMap')); };
    for (const b of mapBtns) b.addEventListener('click', () => { settings.set('quickMap', b.dataset.v); showMap(); this.audio.ui?.(); });
    showMap();
    click('btn-quick', () => { if (!this.requireConn()) return; this.net.send({ t: 'quick', name: name(), difficulty: settings.get('botSkill'), map: settings.get('quickMap') }); this.showLoading('FINDING MATCH'); });
    click('btn-create', () => { if (!this.requireConn()) return; this.net.send({ t: 'create', name: name() }); });
    click('btn-join', () => {
      if (!this.requireConn()) return;
      const code = $('code-input').value.trim().toUpperCase();
      if (code.length < 4) { this.toast('Enter a room code'); return; }
      this.net.send({ t: 'join', code, name: name() });
    });
    $('code-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btn-join').click(); });
    click('btn-settings', () => this.openSettings());
    // full screen from the main menu (the browser only allows it from a click)
    const fsBtn = $('btn-fullscreen');
    const fsLabel = () => { fsBtn.firstElementChild.textContent = document.fullscreenElement ? 'EXIT FULL SCREEN' : 'FULL SCREEN'; };
    fsBtn.addEventListener('click', () => {
      if (document.fullscreenElement) document.exitFullscreen?.();
      else (document.documentElement.requestFullscreen?.({ navigationUI: 'hide' }) || Promise.resolve()).catch(() => this.toast('Full screen is not allowed here'));
    });
    document.addEventListener('fullscreenchange', () => {
      fsLabel();
      // keep Esc for the pause menu while in full screen (hold Esc to leave full screen; Chrome / Edge)
      if (document.fullscreenElement) navigator.keyboard?.lock?.(['Escape']).catch(() => {});
      else navigator.keyboard?.unlock?.();
    });
    click('btn-pause-settings', () => this.openSettings());
    click('btn-settings-close', () => this.closeSettings());
    click('btn-copy', () => {
      const code = this.room?.code || '';
      navigator.clipboard?.writeText(code).then(() => this.toast(`Copied ${code}`, 'info'), () => this.toast(code, 'info'));
    });
    click('btn-leave-lobby', () => this.leave());
    click('btn-start', () => this.net.send({ t: 'host', action: 'start' }));
    click('btn-resume', () => this.resume());
    click('btn-leave', () => this.leave());
    click('btn-host-lobby', () => this.net.send({ t: 'host', action: 'lobby' }));
    click('btn-host-skip', () => { this.net.send({ t: 'host', action: 'skip' }); this.resume(); });
    $('click-to-play').addEventListener('click', () => { this.audio.unlock(); this.resume(); });
    this.canvas.addEventListener('click', () => { if (this.screen === 'hud' && !this.input.locked && !this.paused) this.resume(); });

    // lobby settings
    $('set-bots').addEventListener('input', (e) => { $('set-bots-val').textContent = e.target.value; });
    $('set-bots').addEventListener('change', (e) => this.hostSettings({ bots: Number(e.target.value) }));
    $('set-diff').addEventListener('click', (e) => { const v = e.target.dataset.v; if (v) this.hostSettings({ difficulty: v }); });
    $('set-rotation').addEventListener('change', (e) => this.hostSettings({ rotation: e.target.checked }));

    this.input.onLockChange = (locked, reason) => {
      if (this.screen !== 'hud') return;
      if (locked) {
        this.paused = false;
        $('pause-menu').classList.add('hidden');
        $('click-to-play').classList.add('hidden');
      } else if (reason === 'focus') {
        // switched to another window: no pause menu, just a prompt to click back in
        if (!this.paused) $('click-to-play').classList.remove('hidden');
      } else if ($('settings-modal').classList.contains('hidden')) {
        this.paused = true;
        $('pause-menu').classList.remove('hidden');
        $('click-to-play').classList.add('hidden');
        this.updatePauseMenu();
      }
    };
    this.input.onKey = (code, down, e) => {
      if (code === 'Tab' && this.screen === 'hud') {
        this.scoreboardOpen = down;
        this.hud.showScoreboard(down || this.game.serverState === 'intermission');
      }
      if (code === 'Escape' && down && this.screen === 'hud' && this.input.locked) {
        // full screen holds Esc for the game (keyboard lock), so it opens the menu instead of leaving full screen
        this.input.unlock();
      } else if (code === 'Escape' && down && this.screen === 'hud' && !this.input.locked) {
        if (!$('settings-modal').classList.contains('hidden')) this.closeSettings();
        else if (this.paused) this.resume();
      }
      void e;
    };

    // settings controls
    const bindRange = (id, key, fmt) => {
      const el = $(id), out = $(`${id}-v`);
      el.value = settings.get(key);
      out.textContent = fmt(settings.get(key));
      el.addEventListener('input', () => { const v = Number(el.value); settings.set(key, v); out.textContent = fmt(v); if (key === 'volume') this.audio.setVolume(v); });
    };
    bindRange('opt-sens', 'sensitivity', (v) => v.toFixed(2));
    bindRange('opt-fov', 'fov', (v) => `${v}°`);
    bindRange('opt-vol', 'volume', (v) => `${Math.round(v * 100)}%`);
    const bindCheck = (id, key) => { const el = $(id); el.checked = !!settings.get(key); el.addEventListener('change', () => settings.set(key, el.checked)); };
    bindCheck('opt-invert', 'invertY');
    bindCheck('opt-names', 'showNames');
    bindCheck('opt-fps', 'showFps');
    bindCheck('opt-shake', 'shake');
    const q = $('opt-quality');
    q.value = settings.get('quality');
    q.addEventListener('change', () => { settings.set('quality', q.value); this.game.applyQuality(); });
  }

  // Phones: going into a match from a tap asks for full screen and landscape (both need a user gesture).
  mobileFullscreen(id) {
    if (!this.input.touch) return;
    if (!['btn-quick', 'btn-create', 'btn-join', 'btn-start', 'btn-resume'].includes(id)) return;
    const el = document.documentElement;
    const orient = () => screen.orientation?.lock?.('landscape').catch(() => {});
    if (!document.fullscreenElement && el.requestFullscreen) {
      el.requestFullscreen({ navigationUI: 'hide' }).then(orient, () => {});
    } else orient();
  }

  requireConn() {
    if (!this.net.connected) { this.toast('Not connected to server'); return false; }
    return true;
  }

  openSettings() {
    $('settings-modal').classList.remove('hidden');
    $('pause-menu').classList.add('hidden');
  }

  closeSettings() {
    $('settings-modal').classList.add('hidden');
    if (this.screen === 'hud') {
      if (this.paused) $('pause-menu').classList.remove('hidden');
    }
  }

  resume() {
    if (this.screen !== 'hud') return;
    this.audio.unlock();
    this.input.lock();
  }

  leave() {
    this.net.send({ t: 'leave' });
    this.game.stop();
    this.room = null;
    this.inMatch = false;
    this.paused = false;
    this.show('menu');
  }

  hostSettings(s) { this.net.send({ t: 'host', action: 'settings', settings: s }); }

  updatePauseMenu() {
    const isHost = this.room && !this.room.public && this.room.host === this.myId;
    for (const el of document.querySelectorAll('.host-only')) el.classList.toggle('hidden', !isHost);
    $('pause-code').innerHTML = this.room && !this.room.public ? `ROOM CODE <b>${esc(this.room.code)}</b>` : `QUICK MATCH · ${esc(String(this.room?.settings?.difficulty || 'easy').toUpperCase())} BOTS${this.room?.settings?.quickMap && this.room.settings.quickMap !== 'any' ? ' · ' + esc(this.room.settings.quickMap.toUpperCase()) : ''}`;
  }

  renderLobby() {
    const r = this.room;
    if (!r) return;
    const isHost = r.host === this.myId;
    $('lobby-code').textContent = r.code;
    $('lobby-count').textContent = `${r.players.length} / ${r.max}`;
    document.querySelector('.lobby-panel').classList.toggle('guest', !isHost);
    $('btn-start').disabled = !isHost;
    $('host-note').textContent = isHost ? 'You are the host. Share the code, pick a map and start when ready.' : 'Waiting for the host to start the match…';
    $('lobby-list').innerHTML = r.players.map((p) => `<li><span class="sw" style="background:${hex(PLAYER_COLORS[(p.id - 1) % PLAYER_COLORS.length])}"></span>${esc(p.name)}${p.id === r.host ? '<span class="tag">HOST</span>' : ''}${p.bot ? '<span class="tag bot">BOT</span>' : ''}${p.id === this.myId ? '<span class="tag bot">YOU</span>' : ''}${isHost && p.id !== this.myId && !p.bot ? `<button class="btn small kick" data-kick="${p.id}"><span>KICK</span></button>` : ''}</li>`).join('')
      + (r.settings.bots ? `<li style="opacity:.6">+ ${Math.min(r.settings.bots, r.max - r.players.length)} bots join on start (${r.settings.difficulty})</li>` : '');
    for (const b of document.querySelectorAll('[data-kick]')) b.addEventListener('click', () => this.net.send({ t: 'host', action: 'kick', id: Number(b.dataset.kick) }));
    $('map-grid').innerHTML = r.maps.map((m) => `<button class="map-card ${m.id === r.settings.map ? 'sel' : ''}" data-map="${m.id}"><b>${m.name}</b><small>${esc(m.blurb)}</small></button>`).join('');
    for (const c of document.querySelectorAll('.map-card')) c.addEventListener('click', () => { if (isHost) this.hostSettings({ map: c.dataset.map }); });
    $('set-bots').value = r.settings.bots;
    $('set-bots-val').textContent = r.settings.bots;
    for (const b of $('set-diff').children) b.classList.toggle('sel', b.dataset.v === r.settings.difficulty);
    $('set-rotation').checked = r.settings.rotation;
  }

  // ---------------------------------------------------------------- network

  bindNet() {
    const n = this.net;
    n.on('open', () => {
      $('conn-status').textContent = 'CONNECTED';
      $('conn-status').className = 'conn ok';
      n.send({ t: 'hello', name: settings.get('name'), version: PROTOCOL_VERSION });
    });
    n.on('close', (was) => {
      $('conn-status').textContent = 'DISCONNECTED — RETRYING…';
      $('conn-status').className = 'conn bad';
      if (was && this.screen !== 'menu') {
        this.toast('Connection lost');
        this.game.stop();
        this.room = null;
        this.inMatch = false;
        this.show('menu');
      }
    });
    n.on('hello', (m) => { if (m.version !== PROTOCOL_VERSION) this.toast('Server version mismatch — refresh the page'); });
    n.on('joined', (m) => {
      this.myId = m.id;
      this.game.setMyId(m.id);
      this.room = m.room;
      if (m.room.state === 'lobby') { this.show('lobby'); this.renderLobby(); }
    });
    n.on('room', (m) => {
      const prev = this.room;
      this.room = m.room;
      if (m.room.state === 'lobby') {
        if (this.inMatch || this.screen !== 'lobby') {
          if (this.inMatch) this.toast('Host ended the match', 'info');
          this.game.stop();
          this.inMatch = false;
          this.show('lobby');
        }
        this.renderLobby();
      }
      this.updatePauseMenu();
      if (prev && prev.host !== m.room.host && m.room.host === this.myId && !m.room.public) this.toast('You are now the host', 'info');
    });
    n.on('map', (m) => { this.game.loadMap(m); });
    n.on('roster', (m) => this.game.onRoster(m));
    n.on('ev', (m) => this.game.onEvents(m.l));
    n.on('snapshot', (s) => this.game.onSnapshot(s));
    n.on('scores', (m) => this.game.onScores(m));
    n.on('error', (m) => { this.toast(m.msg); if (this.screen === 'loading' && !this.inMatch) this.show(this.room ? 'lobby' : 'menu'); });
    n.on('kicked', () => { this.toast('You were kicked from the room'); this.game.stop(); this.room = null; this.inMatch = false; this.show('menu'); });
    n.on('left', () => {});
  }

  // ---------------------------------------------------------------- loop

  loop(t) {
    const dt = Math.min(0.25, (t - this.last) / 1000);
    this.last = t;
    if (dt > 0) this.fps += (1 / dt - this.fps) * 0.05;
    if (this.game.frame(dt)) { this.sceneManager.adapt(dt); this.game.render(); }
    else this.renderIdle(dt);
    requestAnimationFrame((tt) => this.loop(tt));
  }

  renderIdle(dt) {
    // slow sky pan behind the menus
    const sm = this.sceneManager;
    sm.camera.position.set(0, 2, 0);
    sm.camera.rotation.set(0.18, (sm.time * 0.03) % (Math.PI * 2), 0);
    sm.update(dt);
    sm.renderer.clear();
    sm.renderer.render(sm.scene, sm.camera);
  }
}

new App();
