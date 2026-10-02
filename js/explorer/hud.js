/* Cockpit overlay laid out like the game's bzgame_*.cfg panels.
 *
 * Bottom-left: the 260 x 140 radar dish (Play_CockpitRadarWidth/Height),
 * heading-up, compass letters on the rim, player diamond at centre.
 * Bottom-right: StatusPanel (138 px in from the edge; the game's box is
 * 90 x 90, ours is GAUGE_W x GAUGE_H): the left half of a wide oval,
 * segmented, open to the right. Hull on the top half (HULLGAUGE green /
 * yellow / red by state) and ammo on the bottom half (AMMOGAUGE blue),
 * both filling from 9 o'clock out to 12 and 6 o'clock, with the numbers
 * just right of the open ends. Right of it: WeaponPanel (128 x 70),
 * four 16 px pill rows of icon badge, name and shots left. Colours come
 * from the harvested bzgame_init_color palette as scoped custom properties;
 * CSS falls back to theme tokens.
 */

import { dataUrl } from './catalog.js';

const HULL_WARN = 0.5;        // HULLGAUGE state 1 (yellow) below this ratio
const HULL_BAD = 0.25;        // state 2 (red) below this ratio
const RADAR_W = 260;
const RADAR_H = 140;
const RADAR_DEFAULT_RANGE = 300;   // CraftClass.rangeScan when the ODF has none
const HP_ICONS = { GUN: 'gun', CANN: 'cannon', MORT: 'mortar', ROCK: 'rocket', SPEC: 'special', SHIE: 'shield', HAND: 'hand', PACK: 'pack' };
const SLOT_WORDS = { GUN: 'Gun', CANN: 'Cannon', MORT: 'Mortar', ROCK: 'Rocket', SPEC: 'Special', SHIE: 'Shield', HAND: 'Hand', PACK: 'Pack' };
// Gauge geometry in the StatusPanel box. The viewBox is GAUGE_W x GAUGE_H
// and .vt-xp-gaugepanel in css/explorer.css is the same box in px, so one
// unit here is one (scaled) px there. The oval is drawn wide: with the
// 13 px stroke its outer box is about 1.3x as wide as tall, so the "C"
// reads as an elongated arc, and the number column sits in the box to
// the right of the open ends.
const GAUGE_W = 164;
const GAUGE_H = 90;
const GAUGE_CX = 116;
const GAUGE_CY = 45;
const GAUGE_RX = 108;         // wide oval: the drawn arc is its left half
const GAUGE_RY = 40;
const GAUGE_OPEN = 90;        // ends at 12 and 6 o'clock: a half oval, open to the right
const TOAST_MS = 1200;
const SVG_NS = 'http://www.w3.org/2000/svg';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function svgEl(tag, attrs) {
  const node = document.createElementNS(SVG_NS, tag);
  Object.keys(attrs || {}).forEach((k) => node.setAttribute(k, attrs[k]));
  return node;
}

function rgba(c, alphaOverride) {
  if (!Array.isArray(c) || c.length < 3) return '';
  const a = alphaOverride != null ? alphaOverride : (c.length > 3 ? c[3] / 255 : 1);
  return `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${a.toFixed(3)})`;
}

/** Arc path on an axis-aligned ellipse: angles in degrees, 0 = 3 o'clock,
 * counter-clockwise positive. */
export function ellipseArcPath(cx, cy, rx, ry, a0, a1) {
  const rad = (d) => (d * Math.PI) / 180;
  const x0 = cx + rx * Math.cos(rad(a0));
  const y0 = cy - ry * Math.sin(rad(a0));
  const x1 = cx + rx * Math.cos(rad(a1));
  const y1 = cy - ry * Math.sin(rad(a1));
  const sweep = a1 - a0;
  const large = Math.abs(sweep) > 180 ? 1 : 0;
  const dir = sweep > 0 ? 0 : 1;   // SVG sweep flag: 1 = clockwise in screen space
  return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${rx} ${ry} 0 ${large} ${dir} ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

export function createHud(root, reticles, hudArt) {
  const hud = el('div', 'vt-xp-hud');
  root.append(hud);

  // Palette from the game's bzgame_init_color.cfg, when harvested.
  fetch(dataUrl('ui/explorer/palette.json')).then((r) => (r.ok ? r.json() : null)).then((pal) => {
    if (!pal) return;
    const hullG = pal.HULLGAUGE || {};
    const ammoG = pal.AMMOGAUGE || {};
    const textG = pal.COMMANDTEXT || {};
    const set = (name, value) => { if (value) hud.style.setProperty(name, value); };
    set('--vt-xp-hull-ok', rgba(hullG.foreground_0, 0.9));
    set('--vt-xp-hull-warn', rgba(hullG.foreground_1, 0.9));
    set('--vt-xp-hull-bad', rgba(hullG.foreground_2, 0.9));
    set('--vt-xp-ammo', rgba(ammoG.foreground_0, 0.9));
    set('--vt-xp-hud-text', rgba(textG.foreground_0, 1));
    set('--vt-xp-panel', rgba(textG.background_0, 0.5));
    set('--vt-xp-radar', rgba(ammoG.foreground_0, 0.55));
  }).catch(() => {});

  // ---- radar ---------------------------------------------------------------
  const radar = document.createElement('canvas');
  radar.className = 'vt-xp-radar';
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  radar.width = RADAR_W * dpr;
  radar.height = RADAR_H * dpr;
  hud.append(radar);
  const rctx = radar.getContext('2d');

  // ---- status "C" gauge + weapon panel ---------------------------------------
  const statusPanel = el('div', 'vt-xp-gaugepanel');
  const svg = svgEl('svg', { viewBox: `0 0 ${GAUGE_W} ${GAUGE_H}`, class: 'vt-xp-gauge' });
  const arc = (a0, a1) => ellipseArcPath(GAUGE_CX, GAUGE_CY, GAUGE_RX, GAUGE_RY, a0, a1);
  const trackTop = svgEl('path', { class: 'vt-xp-gauge-track', d: arc(180, GAUGE_OPEN) });
  const trackBot = svgEl('path', { class: 'vt-xp-gauge-track', d: arc(180, 360 - GAUGE_OPEN) });
  const hullArc = svgEl('path', { class: 'vt-xp-gauge-hull', d: '' });
  const ammoArc = svgEl('path', { class: 'vt-xp-gauge-ammo', d: '' });
  svg.append(trackTop, trackBot, hullArc, ammoArc);
  const hullText = el('span', 'vt-xp-hull-text', '');
  const ammoText = el('span', 'vt-xp-ammo-text', '');
  statusPanel.append(svg, hullText, ammoText);
  const weapons = el('div', 'vt-xp-weapons');
  hud.append(statusPanel, weapons);

  // ---- centre reticle, target line, chips -----------------------------------
  const reticle = document.createElement('img');
  reticle.className = 'vt-xp-reticle';
  reticle.alt = '';
  reticle.hidden = true;
  const target = el('div', 'vt-xp-target');
  const chip = el('p', 'vt-xp-chip', 'Click to take control \u00b7 Esc releases the mouse');
  chip.hidden = true;
  const dead = el('p', 'vt-xp-chip vt-xp-chip-dead', 'Hull destroyed \u2014 R to respawn');
  dead.hidden = true;
  const toastEl = el('p', 'vt-xp-chip vt-xp-chip-toast', '');
  toastEl.hidden = true;
  const hint = el('p', 'vt-xp-hint',
    'Mouse steers \u00b7 W/S throttle \u00b7 A/D strafe \u00b7 LMB fire \u00b7 wheel / RMB weapons \u00b7 arrows orbit \u00b7 '
    + 'Q add \u00b7 B build \u00b7 V enter \u00b7 C camera \u00b7 Space jump \u00b7 -/= volume \u00b7 M mute');
  const hintClose = el('button', 'vt-xp-hint-close', '\u00d7');
  hintClose.type = 'button';
  hintClose.setAttribute('aria-label', 'Dismiss');
  hintClose.addEventListener('click', () => { hint.hidden = true; });
  hint.append(hintClose);
  hud.append(reticle, target, chip, dead, toastEl, hint);

  let lastFrame = '';
  let toastTimer = 0;
  const nameCache = new Map();
  const costCache = new Map();

  function reticleSrc(frame) {
    if (!frame || !reticles || !reticles.frames) return '';
    const hit = reticles.frames[frame] || reticles.frames[frame + '.0'];
    return hit && hit.file ? dataUrl('ui/reticles/' + hit.file) : '';
  }

  function weaponName(db, stem) {
    if (!stem) return '';
    if (nameCache.has(stem)) return nameCache.get(stem);
    const key = String(stem).toLowerCase().replace(/\.odf$/, '') + '.odf';
    const entry = db && db.Weapon && db.Weapon[key];
    const wc = entry && entry.WeaponClass;
    const name = (wc && wc.wpnName) ? String(wc.wpnName).replace(/"/g, '') : stem;
    nameCache.set(stem, name);
    return name;
  }

  function weaponCost(db, stem) {
    if (!stem) return 0;
    if (costCache.has(stem)) return costCache.get(stem);
    const key = String(stem).toLowerCase().replace(/\.odf$/, '') + '.odf';
    const entry = db && db.Weapon && db.Weapon[key];
    const wc = entry && entry.WeaponClass;
    const ordName = wc && wc.ordName ? String(wc.ordName).toLowerCase().replace(/\.odf$/, '') + '.odf' : '';
    const ord = ordName && db.Ordnance && db.Ordnance[ordName];
    const oc = ord && ord.OrdnanceClass;
    let cost = oc && oc.ammoCost != null ? parseFloat(String(oc.ammoCost)) : NaN;
    if (!Number.isFinite(cost)) cost = 0;
    costCache.set(stem, cost);
    return cost;
  }

  function paintGauge(player, sim) {
    const hullFrac = player && player.maxHp ? Math.max(0, Math.min(1, player.hp / player.maxHp)) : 0;
    const ammoFrac = sim && sim.maxAmmo ? Math.max(0, Math.min(1, sim.ammo / sim.maxAmmo)) : 0;
    const span = 180 - GAUGE_OPEN;
    hullArc.setAttribute('d', hullFrac > 0.002 ? arc(180, 180 - span * hullFrac) : '');
    ammoArc.setAttribute('d', ammoFrac > 0.002 ? arc(180, 180 + span * ammoFrac) : '');
    hullArc.classList.toggle('is-warn', hullFrac < HULL_WARN && hullFrac >= HULL_BAD);
    hullArc.classList.toggle('is-bad', hullFrac < HULL_BAD);
    hullText.textContent = player ? String(Math.ceil(player.hp)) : '';
    ammoText.textContent = sim ? String(Math.floor(sim.ammo)) : '';
  }

  function paintWeapons(state) {
    const player = state.player;
    const groups = state.groups || [];
    weapons.replaceChildren();
    const ammo = state.sim ? state.sim.ammo : 0;
    groups.slice(0, 5).forEach((g, i) => {
      const empty = !g.weaponOdf;
      const row = el('div', 'vt-xp-wpn' + (player && i === player.slot ? ' is-on' : '') + (empty ? ' is-empty' : ''));
      const badge = el('span', 'vt-xp-wpn-badge');
      const icon = document.createElement('img');
      icon.alt = SLOT_WORDS[g.category] || g.category || '';
      icon.src = dataUrl('ui/hud/hp_' + (HP_ICONS[g.category] || 'gun') + '.png');
      badge.append(icon);
      row.append(badge);
      if (empty) {
        row.append(el('span', 'vt-xp-wpn-name', ''), el('span', 'vt-xp-wpn-shots', '\u2297'));
      } else {
        const name = weaponName(state.db, g.weaponOdf);
        const cost = weaponCost(state.db, g.weaponOdf);
        const shots = cost > 0 ? String(Math.floor(ammo / cost)) : '\u221e';
        row.append(el('span', 'vt-xp-wpn-name', name), el('span', 'vt-xp-wpn-shots', shots));
      }
      weapons.append(row);
    });
  }

  function paintRadar(state) {
    const player = state.player;
    const w = RADAR_W;
    const h = RADAR_H;
    const style = getComputedStyle(hud);
    const dish = style.getPropertyValue('--vt-xp-radar').trim() || style.getPropertyValue('--kb-primary').trim();
    const textCol = style.getPropertyValue('--vt-xp-hud-text').trim() || style.getPropertyValue('--kb-text-primary').trim();
    const friend = style.getPropertyValue('--vt-xp-hull-ok').trim() || style.getPropertyValue('--kb-success').trim();
    const foe = style.getPropertyValue('--vt-xp-hull-bad').trim() || style.getPropertyValue('--kb-danger').trim();
    const warn = style.getPropertyValue('--vt-xp-hull-warn').trim() || style.getPropertyValue('--kb-warning').trim();
    rctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    rctx.clearRect(0, 0, w, h);
    const cx = w / 2;
    const cy = h / 2 + 4;
    const rx = w / 2 - 6;
    const ry = h / 2 - 10;

    // Dish: translucent blue ellipse with a perspective grid.
    rctx.save();
    rctx.beginPath();
    rctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    rctx.fillStyle = dish;
    rctx.globalAlpha = 0.28;
    rctx.fill();
    rctx.globalAlpha = 0.85;
    rctx.lineWidth = 1;
    rctx.strokeStyle = dish;
    rctx.stroke();
    rctx.globalAlpha = 0.45;
    for (let i = 1; i <= 3; i++) {
      rctx.beginPath();
      rctx.ellipse(cx, cy, (rx * i) / 4, (ry * i) / 4, 0, 0, Math.PI * 2);
      rctx.stroke();
    }
    for (let i = 0; i < 8; i++) {
      const a = (i * Math.PI) / 4;
      rctx.beginPath();
      rctx.moveTo(cx, cy);
      rctx.lineTo(cx + Math.cos(a) * rx, cy + Math.sin(a) * ry);
      rctx.stroke();
    }
    rctx.restore();
    if (!player) return;

    // Heading-up: raw +X (east) is yaw 0; north is +Z. The dish rotates so
    // the hull's nose is at the top.
    const yaw = player.body.yaw || 0;
    const range = state.radarRange || RADAR_DEFAULT_RANGE;
    const toDish = (dx, dz) => {
      const fwd = dx * Math.cos(yaw) + dz * Math.sin(yaw);      // along the nose
      const left = -dx * Math.sin(yaw) + dz * Math.cos(yaw);    // toward raw +Z side (left)
      return { x: cx - (left / range) * rx, y: cy - (fwd / range) * ry };
    };

    // Compass letters on the rim. World bearings: E = +X, N = +Z.
    rctx.save();
    rctx.font = 'bold 13px var(--vt-font-system, system-ui, sans-serif)';
    rctx.textAlign = 'center';
    rctx.textBaseline = 'middle';
    [['N', 0, 1], ['E', 1, 0], ['S', 0, -1], ['W', -1, 0]].forEach(([letter, dx, dz]) => {
      const p = toDish(dx * range * 0.86, dz * range * 0.86);
      rctx.fillStyle = letter === 'N' ? warn : textCol;
      rctx.fillText(letter, p.x, p.y);
    });
    rctx.restore();

    // Units.
    (state.units || []).forEach((u) => {
      if (!u.alive || u === player) return;
      const dx = u.body.x - player.body.x;
      const dz = u.body.z - player.body.z;
      if (Math.hypot(dx, dz) > range) return;
      const p = toDish(dx, dz);
      rctx.fillStyle = u.team === player.team ? friend : foe;
      const s = u.role === 'building' || u.role === 'turret' ? 5 : 4;
      if (u.role === 'building' || u.role === 'turret') rctx.fillRect(p.x - s / 2, p.y - s / 2, s, s);
      else {
        rctx.beginPath();
        rctx.arc(p.x, p.y, s / 2, 0, Math.PI * 2);
        rctx.fill();
      }
    });

    // Player diamond.
    rctx.fillStyle = textCol;
    rctx.beginPath();
    rctx.moveTo(cx, cy - 6);
    rctx.lineTo(cx + 4, cy);
    rctx.lineTo(cx, cy + 6);
    rctx.lineTo(cx - 4, cy);
    rctx.closePath();
    rctx.fill();
  }

  /** Short-lived centre notice (volume, quick add). */
  function toast(text, ms) {
    toastEl.textContent = text;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.hidden = true; }, ms || TOAST_MS);
  }

  function update(state) {
    const player = state.player;
    paintGauge(player, state.sim);
    paintWeapons(state);
    paintRadar(state);

    const src = reticleSrc(state.sim && state.sim.reticleFrame);
    if (src && src !== lastFrame) {
      lastFrame = src;
      reticle.src = src;
    }
    reticle.hidden = !src || !state.locked || state.dead;

    const tgt = state.target;
    target.textContent = tgt ? `${tgt.name}  ${Math.ceil(tgt.hp)} / ${Math.ceil(tgt.maxHp)}` : '';

    if (state.placing) {
      chip.hidden = state.dead;
      chip.textContent = state.locked
        ? 'Click to place at the crosshair \u00b7 Esc cancels'
        : 'Click to take control, then click to place \u00b7 Esc cancels';
    } else {
      chip.hidden = !state.lockChip;
      chip.textContent = 'Click to take control \u00b7 Esc releases the mouse';
    }
    dead.hidden = !state.dead;
    if (!state.fine) hint.textContent = 'This view needs a mouse and keyboard to drive.';
  }

  return { update, toast, el: hud };
}
