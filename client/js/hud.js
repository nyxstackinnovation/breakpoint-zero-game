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
      timer: $('hud-timer'), dmgNumbers: $('dmg-numbers'), hint: $('weapon-hint'), kills: $('hud-kills'), kd: $('hud-kd'), killsBox: $('kills-box'), map: $('hud-map'), rank: $('hud-rank'), killfeed: $('killfeed'), center: $('center-msg'),
      hit: $('hitmarker'), dmg: $('dmg-indicators'), vignette: $('vignette'), flash: $('damage-flash'), heal: $('heal-pop'),
      crosshair: $('crosshair'), names: $('nameplates'), perf: $('perf'),
      sb: $('scoreboard'), sbBody: $('sb-body'), sbSub: $('sb-sub'), sbTitle: $('sb-title'),
      death: $('death-screen'), deathBy: $('death-by'), deathTimer: $('death-timer'),
      banner: $('kill-banner'), pulse: $('kill-pulse'), deathKiller: $('death-killer'),
      round: $('round-end'), reVictory: $('re-victory'), rePanel: $('re-panel'), reWinner: $('re-winner'), reStand: $('re-standings'), reNext: $('re-next'),
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
      // the chunk you just lost lingers in red, then drains away
      const tr = this.el.trail || (this.el.trail = document.getElementById('hud-health-trail'));
      if (tr) {
        const prev = this.trailV ?? v;
        if (v < prev) { tr.style.transition = 'none'; tr.style.width = `${prev}%`; void tr.offsetWidth; tr.style.transition = 'width .5s ease-in .35s'; }
        else tr.style.transition = 'none';
        tr.style.width = `${v}%`;
        this.trailV = v;
      }
      this.el.healthBox.classList.toggle('low', v <= 30);
      this.el.vignette.style.opacity = v <= 30 && s.alive ? String(0.4 + (30 - v) / 50) : '0';
      this.el.vignette.classList.toggle('pulse', v <= 30 && v > 0 && s.alive);
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
    if (s.kills !== undefined) {
      const prev = this.cache.kills;
      this.set('kills', s.kills, (v) => {
        this.el.kills.textContent = v;
        if (prev !== undefined && v > prev) {
          const b = this.el.killsBox;
          b.classList.remove('pop'); void b.offsetWidth; b.classList.add('pop');
        }
      });
      this.set('deaths', s.deaths, (v) => { this.el.kd.textContent = `${v} death${v === 1 ? '' : 's'}`; });
    }
    const gap = 5 + Math.round(s.spread * 900);
    this.set('gap', gap, (v) => this.el.crosshair.style.setProperty('--gap', `${v}px`));
    this.el.crosshair.style.opacity = s.alive ? String(1 - Math.min(1, (s.ads || 0) * 1.6)) : '0';   // the red dot replaces it when aiming

    if (this.hitT > 0) { this.hitT -= dt; this.el.hit.style.opacity = String(Math.min(1, this.hitT / 0.12)); }
    if (this.centerT > 0) { this.centerT -= dt; if (this.centerT <= 0) this.el.center.style.opacity = '0'; }
    if (this.flashT > 0) { this.flashT -= dt; this.el.flash.style.opacity = String(Math.max(0, this.flashT / 0.25)); }
    if (this.blastT > 0) {
      this.blastT -= dt;
      const b = this.el.blast || (this.el.blast = document.getElementById('blast-flash'));
      b.style.opacity = String(Math.max(0, this.blastT / this.blastDur) * this.blastAmt);
    }
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
    const ch = this.el.crosshair;
    ch.classList.remove('hit', 'headhit'); void ch.offsetWidth;
    ch.classList.add('hit');
    if (kind === 1) ch.classList.add('headhit');
    clearTimeout(this.chT);
    this.chT = setTimeout(() => ch.classList.remove('hit', 'headhit'), 140);
  }

  // white-out from a blast close to you (0..1)
  blast(amount) {
    this.blastAmt = Math.min(0.85, amount);
    this.blastDur = 0.35 + amount * 0.6;
    this.blastT = this.blastDur;
  }

  // Floating damage numbers over the enemy you hit. Hits on the same target in quick succession add up.
  damageNumber(id, amount, kind, worldPos) {
    this.dmgNums = this.dmgNums || [];
    let n = this.dmgNums.find((d) => d.id === id && d.t < 0.6);
    if (!n) {
      const el = document.createElement('div');
      el.className = 'dn';
      this.el.dmgNumbers.appendChild(el);
      n = { id, el, total: 0, t: 0, pos: worldPos.clone(), dx: (Math.random() - 0.5) * 30 };
      this.dmgNums.push(n);
    }
    n.total += amount;
    n.t = 0;
    n.pos.copy(worldPos);
    n.el.textContent = String(Math.round(n.total));
    n.el.className = `dn ${kind === 2 ? 'kill' : kind === 1 ? 'head' : ''}`;
    void n.el.offsetWidth;
    n.el.classList.add('pop');
  }

  updateDamageNumbers(dt, camera, w, h) {
    if (!this.dmgNums || !this.dmgNums.length) return;
    const v = this._v || (this._v = camera.position.clone());
    this.dmgNums = this.dmgNums.filter((n) => {
      n.t += dt;
      if (n.t > 1.1) { n.el.remove(); return false; }
      v.copy(n.pos).project(camera);
      if (v.z > 1) { n.el.style.opacity = '0'; return true; }
      const x = (v.x * 0.5 + 0.5) * w + n.dx, y = (-v.y * 0.5 + 0.5) * h - n.t * 70;
      n.el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -100%)`;
      n.el.style.opacity = String(Math.min(1, (1.1 - n.t) / 0.35));
      return true;
    });
  }

  weaponHint(text, cls) {
    this.set('hint', text + cls, () => {
      this.el.hint.textContent = text;
      this.el.hint.className = text ? `show ${cls || ''}` : '';
    });
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

  // animated elimination medal for the killer
  killBanner(name, color, kind, extra, streak) {
    const b = this.el.banner;
    b.querySelector('.kb-name').textContent = name;
    b.querySelector('.kb-name').style.color = color;
    b.querySelector('.kb-title').textContent = kind === 'head' ? 'HEADSHOT' : kind === 'crush' ? 'DEMOLISHED' : kind === 'rocket' ? 'BLASTED' : 'ELIMINATED';
    b.querySelector('.kb-sub').innerHTML = `${extra || ''}${streak > 1 ? `<em>${({ 2: 'DOUBLE KILL', 3: 'TRIPLE KILL', 4: 'RAMPAGE' })[streak] || 'UNSTOPPABLE'}</em>` : ''}`;
    b.className = '';
    void b.offsetWidth;
    b.className = `show ${kind || ''}`;
    const p = this.el.pulse;
    p.classList.remove('show');
    void p.offsetWidth;
    p.classList.add('show');
  }

  deathKiller(html) { this.el.deathKiller.innerHTML = html || ''; }

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

  // split HONORABLE into letters (staggered drift-in) and scatter rising embers behind it, once
  buildVictory(v) {
    if (v.dataset.built) return;
    v.dataset.built = '1';
    const main = v.querySelector('.rv-main');
    const word = main.dataset.text || main.textContent;
    main.innerHTML = [...word].map((c, i) => `<span class="ch" style="--i:${i}">${c}</span>`).join('');
    const embers = v.querySelector('.rv-embers');
    let html = '';
    for (let i = 0; i < 26; i++) {
      const left = 8 + Math.random() * 84, d = 2.2 + Math.random() * 2.4, w = 1 + Math.random() * 3.5, x = (Math.random() - .5) * 120;
      const sz = 2 + Math.random() * 4;
      html += `<i style="left:${left}%;--d:${d.toFixed(2)}s;--w:${w.toFixed(2)}s;--x:${x.toFixed(0)}px;width:${sz.toFixed(1)}px;height:${sz.toFixed(1)}px"></i>`;
    }
    embers.innerHTML = html;
  }

  showRoundEnd(on, data, meId) {
    this.el.round.classList.toggle('hidden', !on);
    clearTimeout(this.victoryTimer);
    const v = this.el.reVictory, panel = this.el.rePanel;
    if (!on || !data) { v.classList.add('hidden'); v.classList.remove('play'); panel.classList.remove('wait', 'reveal'); return; }
    const w = data.standings[0];
    // you won: a bold red "HONORABLE VICTORY" slams in first, then rises and the results slide in below it
    const won = !!(w && w.id === meId && w.k > 0);
    v.classList.toggle('hidden', !won);
    v.classList.remove('play');
    panel.classList.remove('wait', 'reveal');
    this.el.round.classList.toggle('victory', won);
    if (won) {
      this.buildVictory(v);
      void v.offsetWidth;            // restart the animation
      v.classList.add('play');
      panel.classList.add('wait');
      this.victoryTimer = setTimeout(() => { panel.classList.remove('wait'); panel.classList.add('reveal'); }, 3900);
    }
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
