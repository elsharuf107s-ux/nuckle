// Heads-up display. Static widgets are DOM (bars, counters); everything that tracks something in
// the 3D world — lock-on reticle, radar, off-screen markers, damage numbers — is drawn on a 2D canvas.

import * as THREE from 'three';
import { clamp, fmtTime } from './util.js';

const $ = (id) => document.getElementById(id);
const CYAN = '#52e0ff', RED = '#ff4260', AMBER = '#ffb62e', GREEN = '#5dffa5', PINK = '#ff6ad5';

export class Hud {
  constructor(game) {
    this.game = game;
    this.canvas = $('hud2d');
    this.ctx = this.canvas.getContext('2d');
    this.el = {
      root: $('hud'), waveTitle: $('wave-title'), enemies: $('enemies-left'), score: $('score'), clock: $('clock'),
      hpFill: $('hp-fill'), hpText: $('hp-text'), hpBar: $('hp-fill').parentElement,
      enFill: $('en-fill'), enText: $('en-text'), enBar: $('en-fill').parentElement,
      barrierRow: $('barrier-row'), barrierFill: $('barrier-fill'), barrierText: $('barrier-text'), barrierBar: $('barrier-fill').parentElement,
      cannonName: $('cannon-name'),
      burstFill: $('burst-fill'), burstText: $('burst-text'), burstBar: $('burst-fill').parentElement, burstReady: $('burst-ready'),
      ammo: $('ammo-pips'), ammoCount: $('ammo-count'), missiles: $('missile-pips'), reload: $('reload-note'),
      weaponName: $('weapon-name'), weaponKey: $('weapon-key'), gunRow: $('gun-row'), saberRow: $('saber-row'),
      cannonRow: $('cannon-row'), cannonFill: $('cannon-fill'), cannon2Row: $('cannon2-row'), cannon2Fill: $('cannon2-fill'), cannon2Name: $('cannon2-name'), mechName: $('mech-name'), buildFlags: $('build-flags'),
      subRow: $('sub-row'), subName: $('sub-name'), subFill: $('sub-fill'), subState: $('sub-state'), subBar: $('sub-fill').parentElement,
      boss: $('boss-bar'), bossFill: $('boss-fill'), bossName: $('boss-name'),
      banner: $('banner'), aMissile: $('alert-missile'), aArea: $('alert-area'), aArmor: $('alert-armor'),
      dmg: $('damage-vignette'), burstV: $('burst-vignette'),
    };
    this.numbers = [];
    this.hitMarker = 0;
    this.dmgFlash = 0;
    this._v = new THREE.Vector3();
    this._w = new THREE.Vector3();
    this._c = new THREE.Vector3();
    this._s = { x: 0, y: 0, visible: false, dist: 0 };
    this._missileAlert = false;
    this._lastAmmo = -1;
    this._lastMissile = -1;
    this._bannerQueue = [];
    this._bannerT = 0;
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize() {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.w = window.innerWidth;
    this.h = window.innerHeight;
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
  }

  /** Rebuild the weapon panel for the currently equipped loadout. Call whenever the build changes. */
  configure() {
    const p = this.game.player;
    const e = this.el;
    e.mechName.textContent = p.build.name;
    e.weaponName.textContent = p.weapon.name;
    const saberOnly = p.meleeOnly;
    e.weaponKey.textContent = saberOnly ? 'LMB / RMB' : 'LMB';
    e.ammo.style.display = !saberOnly && p.magSize <= 12 ? '' : 'none';
    e.ammoCount.style.display = !saberOnly && p.magSize > 12 ? '' : 'none';
    e.reload.style.display = saberOnly ? 'none' : '';
    e.saberRow.style.display = saberOnly ? 'none' : '';
    e.cannonRow.style.display = p.mounts[0] ? '' : 'none';
    e.cannon2Row.style.display = p.mounts[1] ? '' : 'none';
    if (p.mounts[0]) e.cannonName.textContent = p.mounts[0].def.name;
    if (p.mounts[1]) e.cannon2Name.textContent = p.mounts[1].def.name;
    e.barrierRow.classList.toggle('on', p.stats.barrier > 0);
    e.subRow.style.display = p.sub ? '' : 'none';
    if (p.sub) e.subName.textContent = p.sub.name;

    // budget warnings: the build's load limit and power supply are fixed for the sortie
    const warn = [];
    if (p.stats.overload > 0) warn.push(`OVERLOADED  −${Math.round((1 - p.stats.loadFactor) * 100)}% SPEED`);
    if (p.stats.powerFactor < 1) warn.push(`POWER SHORT  −${Math.round((1 - p.stats.powerFactor) * 100)}% EN RECOVERY, FIRE RATE & COOLDOWNS`);
    e.buildFlags.textContent = warn.join('\n');
    e.buildFlags.style.whiteSpace = 'pre-line';
    e.gunRow.querySelector('.wsub')?.remove();
    if (saberOnly) {
      const sub = document.createElement('div');
      sub.className = 'wsub';
      sub.textContent = '3-hit combo · tap again to chain';
      e.gunRow.append(sub);
    }
    this._lastAmmo = -1;
    this._lastMissile = -1;
  }

  show(on) {
    this.el.root.classList.toggle('hidden', !on);
    this.canvas.style.visibility = on ? '' : 'hidden'; // belt and braces: nothing can show through even if a frame is stale
    if (!on) this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  reset() {
    this.numbers.length = 0;
    this.hitMarker = 0;
    this.dmgFlash = 0;
    this._bannerQueue.length = 0;
    this._bannerT = 0;
    this.el.banner.classList.remove('show');
    this.el.boss.classList.add('hidden');
  }

  // ------------------------------------------------------------------ events from the game

  message(text, kind = '', sub = '') {
    this._bannerQueue.push({ text, kind, sub });
  }

  damageNumber(pos, amount, kind) {
    this.numbers.push({ x: pos.x, y: pos.y, z: pos.z, amount: Math.round(amount), kind, age: 0, dx: (Math.random() - 0.5) * 30 });
    if (this.numbers.length > 40) this.numbers.shift();
  }

  playerHit(amount) {
    this.dmgFlash = clamp(0.35 + amount / 500, 0.35, 1);
  }

  enemyHit() {
    this.hitMarker = 0.18;
  }

  // ------------------------------------------------------------------ projection

  /** World point → screen pixels. `visible` is false behind the camera. */
  toScreen(p, out = this._s) {
    const cam = this.game.camera;
    const v = this._v.copy(p).applyMatrix4(cam.matrixWorldInverse);
    out.dist = Math.hypot(v.x, v.y, v.z);
    out.visible = v.z < -0.5;
    v.applyMatrix4(cam.projectionMatrix);
    out.x = (v.x * 0.5 + 0.5) * this.w;
    out.y = (-v.y * 0.5 + 0.5) * this.h;
    return out;
  }

  // ------------------------------------------------------------------ per frame

  update(dt) {
    const g = this.game;
    const player = g.player;
    const mech = player.mech;
    const e = this.el;

    // ---- text
    const m = g.missions;
    e.waveTitle.textContent = m.finished ? 'MISSION COMPLETE' : `WAVE ${m.waveNumber}/${m.total} — ${m.title}`;
    e.enemies.textContent = String(g.enemies.length);
    e.score.textContent = g.stats.score.toLocaleString('en-US');
    e.clock.textContent = fmtTime(g.stats.time);

    // ---- bars
    const hpK = mech.hp / mech.maxHp;
    e.hpFill.style.width = `${hpK * 100}%`;
    e.hpBar.classList.toggle('low', hpK < 0.25);
    e.hpText.textContent = String(Math.ceil(mech.hp));
    e.enFill.style.width = `${(mech.en / mech.maxEn) * 100}%`;
    if (mech.barrierMax > 0) {
      e.barrierFill.style.width = `${(mech.barrier / mech.barrierMax) * 100}%`;
      e.barrierText.textContent = String(Math.round(mech.barrier));
      e.barrierBar.classList.toggle('down', mech.barrier <= 0);
    }
    e.enBar.classList.toggle('overheat', mech.overheat);
    e.enText.textContent = mech.overheat ? 'HEAT' : String(Math.ceil(mech.en));
    const burstK = player.burstActive ? player.burstT / 12 : player.burst / 100;
    e.burstFill.style.width = `${burstK * 100}%`;
    e.burstText.textContent = player.burstActive ? 'ON' : `${Math.floor(player.burst)}%`;
    const ready = player.burst >= 100 && !player.burstActive;
    e.burstBar.classList.toggle('ready', ready);
    e.burstReady.classList.toggle('on', ready);

    // ---- weapon pips (rebuilt only when the count changes)
    if (player.magSize > 12) e.ammoCount.textContent = `${player.ammo} / ${player.magSize}`;
    else this._pips(e.ammo, player.ammo, player.magSize, '_lastAmmo');
    this._missilePips(player);
    const [m0, m1] = player.mounts;
    if (m0) e.cannonFill.style.width = `${(1 - m0.cd / m0.def.cooldown) * 100}%`;
    if (m1) e.cannon2Fill.style.width = `${(1 - m1.cd / m1.def.cooldown) * 100}%`;
    if (player.sub) this._updateSubRow(player);
    e.reload.classList.toggle('on', player.reloadT > 0);
    if (player.reloadT > 0) e.reload.textContent = `RELOADING ${Math.round((1 - player.reloadT / player.reloadDur) * 100)}%`;

    // ---- alerts
    const incoming = g.projectiles.incomingAt(mech);
    if (incoming > 0 && !this._missileAlert) g.audio.alert();
    this._missileAlert = incoming > 0;
    e.aMissile.classList.toggle('hidden', incoming === 0);
    e.aArea.classList.toggle('hidden', !mech.outOfBounds);
    e.aArmor.classList.toggle('hidden', hpK >= 0.2 || mech.dead);

    // ---- boss bar
    const boss = g.enemies.find((en) => en.mech.def.boss);
    e.boss.classList.toggle('hidden', !boss);
    if (boss) {
      e.bossFill.style.width = `${(boss.mech.hp / boss.mech.maxHp) * 100}%`;
      e.bossName.textContent = boss.mech.def.name;
    }

    // ---- screen overlays
    this.dmgFlash = Math.max(0, this.dmgFlash - dt * 2.2);
    e.dmg.style.opacity = String(this.dmgFlash + (hpK < 0.2 && !mech.dead ? 0.25 + 0.15 * Math.sin(g.time * 8) : 0));
    e.burstV.style.opacity = player.burstActive ? '1' : '0';

    // ---- banner queue
    this._bannerT -= dt;
    if (this._bannerT <= 0 && this._bannerQueue.length) {
      const b = this._bannerQueue.shift();
      const el = e.banner;
      el.className = '';
      void el.offsetWidth; // restart the CSS animation
      el.innerHTML = '';
      el.append(document.createTextNode(b.text));
      if (b.sub) {
        const s = document.createElement('small');
        s.textContent = b.sub;
        el.append(s);
      }
      el.className = `show ${b.kind}`;
      this._bannerT = 2.2;
    }

    this._draw(dt);
  }

  _updateSubRow(player) {
    const sub = player.sub;
    const e = this.el;
    let k = 1, text = 'READY', danger = false;
    if (sub.kind === 'vulcan') {
      k = player.subHeat;
      danger = player.subLocked;
      text = danger ? 'OVERHEATED' : k > 0.02 ? 'HEAT' : 'READY';
    } else if (sub.kind === 'flare' || sub.kind === 'injector' || sub.kind === 'pulse' || sub.kind === 'field') {
      k = 1 - player.subCd / sub.cooldown;
      text = player.subCd > 0 ? `RECHARGING ${Math.ceil(player.subCd)}s` : 'READY';
      if (sub.kind === 'field' && player.fieldT > 0) { k = player.fieldT / sub.duration; text = 'FIELD UP'; }
    } else {
      k = player.repairT > 0 ? player.repairT / sub.duration : player.repairCharges > 0 ? 1 : 0;
      text = player.repairT > 0 ? 'REPAIRING' : player.repairCharges > 0 ? `${player.repairCharges} USE LEFT` : 'USED';
    }
    e.subFill.style.width = `${clamp(k, 0, 1) * 100}%`;
    e.subBar.classList.toggle('danger', danger);
    e.subState.textContent = text;
  }

  _pips(container, count, max, key) {
    if (this[key] === count) return;
    this[key] = count;
    container.textContent = '';
    for (let i = 0; i < max; i++) {
      const d = document.createElement('div');
      d.className = `pip${i < count ? ' on' : ''}`;
      container.append(d);
    }
  }

  _missilePips(player) {
    const key = `${player.missiles}:${Math.floor(player.missileT * 4)}`;
    if (this._lastMissile === key) return;
    this._lastMissile = key;
    const c = this.el.missiles;
    c.textContent = '';
    for (let i = 0; i < player.stats.missileCharges; i++) {
      const d = document.createElement('div');
      d.className = `pip${i < player.missiles ? ' on' : ''}`;
      if (i === player.missiles) {
        const f = document.createElement('i');
        f.style.width = `${(player.missileT / 7) * 100}%`;
        d.append(f);
      }
      c.append(d);
    }
  }

  // ------------------------------------------------------------------ canvas layer

  _draw(dt) {
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);
    ctx.lineCap = 'round';

    this._drawMarkers(ctx);
    this._drawCrosshair(ctx, dt);
    this._drawRadar(ctx);
    this._drawNumbers(ctx, dt);
  }

  _drawCrosshair(ctx, dt) {
    const cx = this.w / 2, cy = this.h / 2;
    const locked = !!this.game.player.lock;
    ctx.strokeStyle = locked ? 'rgba(93,255,165,0.7)' : 'rgba(82,224,255,0.8)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(cx, cy, 11, 0, Math.PI * 2);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      ctx.moveTo(cx + dx * 15, cy + dy * 15);
      ctx.lineTo(cx + dx * 24, cy + dy * 24);
    }
    ctx.stroke();
    ctx.fillStyle = ctx.strokeStyle;
    ctx.fillRect(cx - 1, cy - 1, 2, 2);

    // soft aim (touch): a dashed ring shows which enemy your shots are being pulled toward
    const assist = this.game.player.assistTarget;
    if (assist) {
      const s = this.toScreen(assist.center(this._c), this._s);
      if (s.visible) {
        ctx.strokeStyle = 'rgba(255,182,46,0.9)';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.arc(s.x, s.y, 20, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    if (this.hitMarker > 0) {
      this.hitMarker -= dt;
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      for (const [sx, sy] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
        ctx.moveTo(cx + sx * 8, cy + sy * 8);
        ctx.lineTo(cx + sx * 17, cy + sy * 17);
      }
      ctx.stroke();
    }
  }

  /** Lock-on reticle on the target; small diamonds / edge arrows for everything else. */
  _drawMarkers(ctx) {
    const g = this.game;
    const lock = g.player.lock;
    const s = this._s;
    const margin = 46;
    const cx = this.w / 2, cy = this.h / 2;

    for (const en of g.enemies) {
      const m = en.mech;
      if (m.dead) continue;
      this.toScreen(m.center(this._c), s);
      const boss = !!m.def.boss;
      const onScreen = s.visible && s.x > margin && s.x < this.w - margin && s.y > margin && s.y < this.h - margin;

      if (m === lock && onScreen) {
        this._reticle(ctx, s, m);
      } else if (onScreen) {
        const hpK = m.hp / m.maxHp;
        ctx.strokeStyle = boss ? 'rgba(255,66,96,0.9)' : 'rgba(255,110,90,0.75)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(s.x, s.y - 9); ctx.lineTo(s.x + 7, s.y); ctx.lineTo(s.x, s.y + 9); ctx.lineTo(s.x - 7, s.y);
        ctx.closePath();
        ctx.stroke();
        ctx.fillStyle = 'rgba(0,0,0,0.5)';
        ctx.fillRect(s.x - 16, s.y + 14, 32, 3);
        ctx.fillStyle = boss ? RED : '#ff7a5a';
        ctx.fillRect(s.x - 16, s.y + 14, 32 * hpK, 3);
      } else {
        // off-screen: arrow on the screen edge pointing toward the enemy
        let ax = s.x - cx, ay = s.y - cy;
        if (!s.visible) { ax = -ax; ay = -ay; }
        const len = Math.hypot(ax, ay) || 1;
        ax /= len; ay /= len;
        const k = Math.min((this.w / 2 - margin) / Math.max(Math.abs(ax), 1e-3), (this.h / 2 - margin) / Math.max(Math.abs(ay), 1e-3));
        const px = cx + ax * k, py = cy + ay * k;
        const ang = Math.atan2(ay, ax);
        ctx.save();
        ctx.translate(px, py);
        ctx.rotate(ang);
        ctx.fillStyle = m === lock ? GREEN : boss ? RED : 'rgba(255,110,90,0.85)';
        ctx.beginPath();
        ctx.moveTo(12, 0); ctx.lineTo(-8, -9); ctx.lineTo(-3, 0); ctx.lineTo(-8, 9);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }
    }
  }

  _reticle(ctx, s, m) {
    const t = this.game.time;
    const size = clamp((m.height * 1100) / Math.max(s.dist, 60) / 2.2, 26, 110);
    ctx.save();
    ctx.translate(s.x, s.y);
    ctx.strokeStyle = GREEN;
    ctx.lineWidth = 2;
    ctx.rotate(Math.sin(t * 2) * 0.03);
    const L = size * 0.4;
    ctx.beginPath();
    for (const [sx, sy] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
      ctx.moveTo(sx * size, sy * (size - L));
      ctx.lineTo(sx * size, sy * size);
      ctx.lineTo(sx * (size - L), sy * size);
    }
    ctx.stroke();
    ctx.restore();

    ctx.font = '12px ui-monospace, Menlo, Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.fillStyle = GREEN;
    const range = this.game.player.mech.center(this._v).distanceTo(m.center(this._w));
    ctx.fillText(`${m.def.name}  ${Math.round(range)}m`, s.x, s.y - size - 10);
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(s.x - size, s.y + size + 8, size * 2, 5);
    ctx.fillStyle = m.hp / m.maxHp < 0.3 ? RED : GREEN;
    ctx.fillRect(s.x - size, s.y + size + 8, size * 2 * (m.hp / m.maxHp), 5);
  }

  /** Radar circle: smaller and tucked into the corner (clear of notches) when the touch controls are up. */
  radarGeom() {
    const t = this.game.touch;
    if (!t?.active) return { R: 72, cx: this.w - 72 - 26, cy: 72 + 26 };
    const R = Math.round(46 * Math.max(0.85, t.scale));
    return { R, cx: this.w - R - 12 - t.inset.right, cy: R + 10 + t.inset.top };
  }

  _drawRadar(ctx) {
    const g = this.game;
    const range = this.game.player.stats.radar;
    const { R, cx, cy } = this.radarGeom();
    const yaw = g.rig.yaw;
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw), rx = Math.cos(yaw), rz = -Math.sin(yaw);
    const me = g.player.mech.pos;

    ctx.save();
    ctx.fillStyle = 'rgba(8,16,26,0.7)';
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(82,224,255,0.4)';
    ctx.lineWidth = 1;
    for (const f of [1, 0.66, 0.33]) { ctx.beginPath(); ctx.arc(cx, cy, R * f, 0, Math.PI * 2); ctx.stroke(); }
    ctx.beginPath();
    ctx.moveTo(cx - R, cy); ctx.lineTo(cx + R, cy); ctx.moveTo(cx, cy - R); ctx.lineTo(cx, cy + R);
    ctx.stroke();
    // view cone
    ctx.fillStyle = 'rgba(82,224,255,0.1)';
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.arc(cx, cy, R, -Math.PI / 2 - 0.55, -Math.PI / 2 + 0.55); ctx.closePath(); ctx.fill();

    const blip = (wx, wz, color, size, shape = 'dot') => {
      const dx = wx - me.x, dz = wz - me.z;
      let u = (dx * rx + dz * rz) / range * R;
      let v = (dx * fx + dz * fz) / range * R;
      const d = Math.hypot(u, v);
      let a = 1;
      if (d > R - 4) { u *= (R - 4) / d; v *= (R - 4) / d; a = 0.55; }
      ctx.globalAlpha = a;
      ctx.fillStyle = color;
      ctx.beginPath();
      if (shape === 'dot') ctx.arc(cx + u, cy - v, size, 0, Math.PI * 2);
      else { ctx.moveTo(cx + u, cy - v - size); ctx.lineTo(cx + u + size, cy - v + size); ctx.lineTo(cx + u - size, cy - v + size); ctx.closePath(); }
      ctx.fill();
      ctx.globalAlpha = 1;
    };
    for (const en of g.enemies) {
      if (en.mech.dead) continue;
      const lock = en.mech === g.player.lock;
      blip(en.mech.pos.x, en.mech.pos.z, lock ? GREEN : en.mech.def.boss ? RED : '#ff7a5a', en.mech.def.boss ? 5 : 3.5);
    }
    for (const p of g.projectiles.list) {
      if (p.type === 'missile' && p.team === 'enemy') blip(p.pos.x, p.pos.z, AMBER, 3, 'tri');
    }
    // you
    ctx.fillStyle = CYAN;
    ctx.beginPath(); ctx.moveTo(cx, cy - 6); ctx.lineTo(cx + 5, cy + 5); ctx.lineTo(cx - 5, cy + 5); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = 'rgba(82,224,255,0.55)';
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
  }

  _drawNumbers(ctx, dt) {
    const s = this._s;
    ctx.textAlign = 'center';
    for (let i = this.numbers.length - 1; i >= 0; i--) {
      const n = this.numbers[i];
      n.age += dt;
      if (n.age > 0.95) { this.numbers.splice(i, 1); continue; }
      n.y += 14 * dt;
      this.toScreen(this._v.set(n.x, n.y, n.z), s);
      if (!s.visible) continue;
      const k = n.age / 0.95;
      ctx.globalAlpha = 1 - k * k;
      const big = clamp(n.amount / 60, 1, 2.2);
      ctx.font = `700 ${Math.round(13 * big)}px ui-monospace, Menlo, Consolas, monospace`;
      ctx.fillStyle = n.kind === 'player' ? RED : n.kind === 'saber' ? PINK : '#ffe08a';
      ctx.strokeStyle = 'rgba(0,0,0,0.6)';
      ctx.lineWidth = 3;
      const x = s.x + n.dx * k, y = s.y - k * 36;
      ctx.strokeText(String(n.amount), x, y);
      ctx.fillText(String(n.amount), x, y);
    }
    ctx.globalAlpha = 1;
  }
}
