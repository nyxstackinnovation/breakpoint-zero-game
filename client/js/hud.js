// DOM heads-up display: health, ammo, rockets, timer, kill feed, hit markers, damage
// direction, nameplates with health bars, scoreboard, death and round-end screens.

import { PLAYER_COLORS, RIFLE, ROCKET, WEAPON } from '/shared/constants.js';
import { ROCKET_REGEN_TICKS, RELOAD_TICKS } from '/shared/weapons.js';

const $ = (id) => document.getElementById(id);
const hex = (c) => '#' + c.toString(16).padStart(6, '0');
const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const WNAME = { [WEAPON.RIFLE]: ['RIFLE', ''], [WEAPON.ROCKET]: ['ROCKET', 'rocket'], [WEAPON.CRUSH]: ['CRUSHED', 'crush'], [WEAPON.FALL]: ['FELL', 'fall'] };

export class Hud {
  constructor() {
    this.el = {
      health: $('hud-health'), healthBar: $('hud-health-bar'), healthBox: $('health-box'),
      ammo: $('hud-ammo'), ammoBox: $('ammo-box'), reload: $('hud-reload').firstElementChild, rockets: $('hud-rockets'),
      timer: $('hud-timer'), map: $('hud-map'), rank: $('hud-rank'), killfeed: $('killfeed'), center: $('center-msg'),
      hit: $('hitmarker'), dmg: $('dmg-indicators'), vignette: $('vignette'), flash: $('damage-flash'), heal: $('heal-pop'),
      crosshair: $('crosshair'), names: $('nameplates'), perf: $('perf'),
      sb: $('scoreboard'), sbBody: $('sb-body'), sbSub: $('sb-sub'), sbTitle: $('sb-title'),
      death: $('death-screen'), deathBy: $('death-by'), deathTimer: $('death-timer'),
      round: $('round-end'), reWinner: $('re-winner'), reStand: $('re-standings'), reNext: $('re-next'),
    };
    this.rocketPips = [];
    for (let i = 0; i < ROCKET.maxAmmo; i++) {
      const d = document.createElement('div');
      d.className = 'rk';
      const f = document.createElement('div');
      f.className = 'fill';
      d.appendChild(f);
      this.el.rockets.appendChild(d);
      this.rocketPips.push(d);
    }
    this.hitT = 0;
    this.centerT = 0;
    this.flashT = 0;
    this.plates = new Map();
    this.cache = {};
  }

  set(key, value, fn) {
    if (this.cache[key] === value) return;
    this.cache[key] = value;
    fn(value);
  }

  colorOf(id) { return hex(PLAYER_COLORS[(id - 1) % PLAYER_COLORS.length]); }

  update(dt, s) {
    // s: { health, ammo, reload, rockets, rocketRegen, spread, timer, mapName, rank, alive }
    this.set('health', Math.max(0, Math.ceil(s.health)), (v) => {
      this.el.health.textContent = v;
      this.el.healthBar.style.width = `${v}%`;
      this.el.healthBox.classList.toggle('low', v <= 30);
      this.el.vignette.style.opacity = v <= 30 && s.alive ? String(0.4 + (30 - v) / 50) : '0';
    });
    this.set('ammo', s.ammo, (v) => { this.el.ammo.textContent = v; this.el.ammoBox.classList.toggle('empty', v === 0); });
    const rp = s.reload > 0 ? Math.round((1 - s.reload / RELOAD_TICKS) * 100) : 0;
    this.set('reload', rp, (v) => { this.el.reload.style.width = `${v}%`; });
    const regen = Math.round((s.rocketRegen / ROCKET_REGEN_TICKS) * 20);
    this.set('rockets', s.rockets * 100 + regen, () => {
      this.rocketPips.forEach((p, i) => {
        p.classList.toggle('full', i < s.rockets);
        p.firstElementChild.style.height = i === s.rockets ? `${(regen / 20) * 100}%` : '0%';
      });
    });
    const secs = Math.max(0, Math.ceil(s.timer));
    this.set('timer', secs, (v) => {
      this.el.timer.textContent = `${Math.floor(v / 60)}:${String(v % 60).padStart(2, '0')}`;
      this.el.timer.classList.toggle('low', v <= 30 && s.playing);
    });
    this.set('map', s.mapName, (v) => { this.el.map.textContent = v; });
    this.set('rank', s.rank, (v) => { this.el.rank.textContent = v; });
    const gap = 5 + Math.round(s.spread * 900);
    this.set('gap', gap, (v) => this.el.crosshair.style.setProperty('--gap', `${v}px`));
    this.el.crosshair.style.opacity = s.alive ? '1' : '0';

    if (this.hitT > 0) { this.hitT -= dt; this.el.hit.style.opacity = String(Math.min(1, this.hitT / 0.12)); }
    if (this.centerT > 0) { this.centerT -= dt; if (this.centerT <= 0) this.el.center.style.opacity = '0'; }
    if (this.flashT > 0) { this.flashT -= dt; this.el.flash.style.opacity = String(Math.max(0, this.flashT / 0.25)); }
    for (const ind of [...this.el.dmg.children]) {
      ind._t -= dt;
      ind.style.opacity = String(Math.max(0, ind._t / 1.2));
      if (ind._t <= 0) ind.remove();
      else if (ind._update) ind._update();
    }
  }

  hitmarker(kind) {
    // kind: 0 body, 1 head, 2 kill
    this.el.hit.className = kind === 2 ? 'kill' : kind === 1 ? 'head' : '';
    this.hitT = kind === 2 ? 0.4 : 0.22;
    this.el.hit.style.opacity = '1';
  }

  damage(angleFn) {
    this.flashT = 0.25;
    const d = document.createElement('div');
    d.className = 'dmg-ind';
    d._t = 1.2;
    d._update = () => { d.style.transform = `rotate(${angleFn()}rad)`; };
    d._update();
    this.el.dmg.appendChild(d);
    while (this.el.dmg.children.length > 6) this.el.dmg.firstElementChild.remove();
  }

  centerMessage(html, dur = 1.6) {
    this.el.center.innerHTML = html;
    this.el.center.style.opacity = '1';
    this.centerT = dur;
  }

  heal(amount) {
    if (amount <= 0) return;
    const e = this.el.heal;
    e.textContent = `+${amount} HP`;
    e.classList.remove('show');
    void e.offsetWidth;
    e.classList.add('show');
  }

  killfeed(killer, victim, weapon, head, meId, names) {
    const row = document.createElement('div');
    row.className = 'kf' + (killer === meId || victim === meId ? ' me' : '');
    const [wn, wc] = WNAME[weapon] || ['?', ''];
    const kName = killer ? esc(names(killer)) : '';
    const vName = esc(names(victim));
    row.innerHTML = (killer ? `<span style="color:${this.colorOf(killer)}">${kName}</span>` : '') +
      `<span class="w ${wc}">${wn}</span>${head ? '<span class="hs">HEADSHOT</span>' : ''}<span style="color:${this.colorOf(victim)}">${vName}</span>`;
    this.el.killfeed.prepend(row);
    setTimeout(() => { row.style.opacity = '0'; }, 5500);
    setTimeout(() => row.remove(), 6000);
    while (this.el.killfeed.children.length > 6) this.el.killfeed.lastElementChild.remove();
  }

  showScoreboard(on) { this.el.sb.classList.toggle('hidden', !on); }

  renderScoreboard(rows, meId, title, sub) {
    this.el.sbTitle.textContent = title;
    this.el.sbSub.textContent = sub;
    this.el.sbBody.innerHTML = rows.map((r, i) => `<tr class="${r.id === meId ? 'me' : ''}"><td>${i + 1}</td><td class="l"><span class="sw" style="background:${this.colorOf(r.id)}"></span>${esc(r.name)}${r.bot ? '<span class="bot">BOT</span>' : ''}</td><td>${r.k}</td><td>${r.d}</td><td>${(r.k / Math.max(1, r.d)).toFixed(2)}</td><td>${r.bot ? '—' : r.ping}</td></tr>`).join('');
  }

  showDeath(on, killerName, weapon) {
    this.el.death.classList.toggle('hidden', !on);
    if (on) {
      const wn = (WNAME[weapon] || ['?'])[0];
      this.el.deathBy.innerHTML = killerName ? `BY <span style="color:var(--yellow)">${esc(killerName)}</span> · ${wn}` : (weapon === WEAPON.CRUSH ? 'CRUSHED BY RUBBLE' : weapon === WEAPON.FALL ? 'FELL OUT OF THE WORLD' : 'SELF-INFLICTED');
    }
  }

  deathTimer(secs) { this.el.deathTimer.textContent = secs > 0 ? `RESPAWN IN ${Math.ceil(secs)}` : 'RESPAWNING…'; }

  showRoundEnd(on, data, meId) {
    this.el.round.classList.toggle('hidden', !on);
    if (!on || !data) return;
    const w = data.standings[0];
    this.el.reWinner.textContent = w && w.k > 0 ? `${w.name} WINS` : 'NO WINNER';
    this.el.reStand.innerHTML = data.standings.slice(0, 8).map((s) => `<li class="${s.id === meId ? 'me' : ''}"><span style="color:${this.colorOf(s.id)}">${esc(s.name)}${s.bot ? ' <small>BOT</small>' : ''}</span><span>${s.k} / ${s.d}</span></li>`).join('');
  }

  roundCountdown(secs, nextName) { this.el.reNext.textContent = `NEXT: ${nextName} IN ${Math.max(0, Math.ceil(secs))}`; }

  // nameplates projected from 3D
  plate(id) {
    let p = this.plates.get(id);
    if (!p) {
      const el = document.createElement('div');
      el.className = 'np';
      el.innerHTML = '<span class="n"></span><span class="bot"></span><div class="bar"><i></i></div>';
      this.el.names.appendChild(el);
      p = { el, name: el.querySelector('.n'), bot: el.querySelector('.bot'), bar: el.querySelector('.bar i'), last: '' };
      this.plates.set(id, p);
    }
    return p;
  }

  updatePlate(id, visible, x, y, name, color, health, isBot, scale) {
    const p = this.plate(id);
    if (!visible) { if (p.el.style.display !== 'none') p.el.style.display = 'none'; return; }
    p.el.style.display = '';
    p.el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -100%) scale(${scale.toFixed(2)})`;
    const key = name + health + isBot;
    if (p.last !== key) {
      p.last = key;
      p.name.textContent = name;
      p.name.style.color = color;
      p.bot.textContent = isBot ? 'BOT' : '';
      p.bar.style.width = `${Math.max(0, health)}%`;
      p.bar.classList.toggle('low', health <= 35);
    }
  }

  removePlate(id) { const p = this.plates.get(id); if (p) { p.el.remove(); this.plates.delete(id); } }
  clearPlates() { for (const id of [...this.plates.keys()]) this.removePlate(id); }

  perf(text) { this.el.perf.textContent = text; }
}
