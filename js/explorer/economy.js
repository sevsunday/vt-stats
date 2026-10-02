/* Makeshift base: scrap bank, one order per producer, charge when the build
 * starts, constructor / factory / armory / recycler menus from the ODF build
 * items. Regen follows the measured bands (red 2/s, yellow 1/s, green 1/3 s).
 * max scrap = 40 while a recycler stands, plus 20 per extractor.
 */

import { stemOf, unitNameOf, chainTerminal, numOf, odfEntry, normOdf } from './catalog.js';

const LANES = {
  recycler: 'recycler',
  factory: 'factory',
  armory: 'armory',
  constructionrig: 'constructor',
};

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function itemsOf(data) {
  const out = [];
  const take = (section) => {
    if (!section) return;
    Object.keys(section).forEach((key) => {
      const m = /^buildItem(\d+)$/i.exec(key);
      if (!m || !section[key]) return;
      out.push({ n: Number(m[1]), stem: stemOf(section[key]) });
    });
  };
  take(data.FactoryClass);
  take(data.ConstructionRigClass);
  Object.keys(data).filter((k) => /^ArmoryGroup\d+$/.test(k)).forEach((k) => take(data[k]));
  take(data.ArmoryClass);
  out.sort((a, b) => a.n - b.n);
  const seen = new Set();
  return out.filter((row) => {
    if (seen.has(row.stem)) return false;
    seen.add(row.stem);
    return true;
  });
}

function bandRate(scrap, pools, upgrades) {
  const red = 20 * upgrades;
  const yellow = 20 * Math.max(0, pools - upgrades);
  if (scrap < red) return 2;
  if (scrap < red + yellow) return 1;
  return 1 / 3;
}

export function createEconomy(root, catalog, units) {
  const teams = {
    1: { scrap: 0, orders: [] },
    2: { scrap: 0, orders: [] },
  };
  const panel = el('aside', 'vt-xp-build');
  panel.hidden = true;
  const titleRow = el('div', 'vt-xp-panel-titlerow');
  titleRow.append(el('h2', 'vt-xp-palette-title', 'Build'));
  const closeBtn = el('button', 'vt-xp-close', '\u00d7');
  closeBtn.type = 'button';
  closeBtn.title = 'Close (Esc)';
  closeBtn.setAttribute('aria-label', 'Close');
  titleRow.append(closeBtn);
  const scrapLine = el('p', 'vt-xp-scrap', '');
  const list = el('div', 'vt-xp-palette-list');
  const status = el('p', 'vt-xp-palette-note', 'Place a recycler, then build from it.');
  panel.append(titleRow, scrapLine, list, status);
  root.append(panel);
  closeBtn.addEventListener('click', () => { panel.hidden = true; });

  let onSpawn = async () => {};

  function census(team) {
    const live = units.living().filter((u) => u.team === team);
    const recycler = live.find((u) => chainTerminal({ data: u.data }) === 'recycler');
    const pools = live.filter((u) => chainTerminal({ data: u.data }) === 'extractor');
    const upgrades = pools.filter((u) => numOf(u.data.ExtractorClass, 'scrapDelay', 1) <= 0.5).length;
    let supply = 0;
    let demand = 0;
    live.forEach((u) => {
      const cost = numOf(u.data.GameObjectClass, 'powerCost', 0);
      if (cost < 0) supply += -cost;
      else demand += cost;
    });
    return {
      recycler,
      pools: pools.length,
      upgrades,
      max: (recycler ? 40 : 0) + 20 * pools.length,
      powered: supply >= demand,
      supply,
      demand,
    };
  }

  function producer(team) {
    const player = units.player();
    const live = units.living().filter((u) => u.team === team);
    const near = live
      .map((u) => ({ u, lane: LANES[chainTerminal({ data: u.data })] || '' }))
      .filter((row) => row.lane);
    if (player) {
      const closest = near.slice().sort((a, b) => {
        const da = Math.hypot(a.u.body.x - player.body.x, a.u.body.z - player.body.z);
        const db = Math.hypot(b.u.body.x - player.body.x, b.u.body.z - player.body.z);
        return da - db;
      })[0];
      if (closest && Math.hypot(closest.u.body.x - player.body.x, closest.u.body.z - player.body.z) < 80) return closest;
    }
    return near[0] || null;
  }

  function requirementMet(team, data) {
    const go = data.GameObjectClass || {};
    for (let i = 1; i <= 6; i++) {
      const text = go['requireText' + i];
      if (!text) continue;
      const need = String(text).replace(/^build\s+/i, '').toLowerCase();
      const have = units.living().some((u) => u.team === team && u.name.toLowerCase().includes(need));
      if (!have) return String(text);
    }
    return '';
  }

  function paint() {
    const team = (units.player() && units.player().team) || 1;
    const info = census(team);
    const bank = teams[team];
    scrapLine.textContent = info.recycler || info.pools
      ? `Scrap ${Math.floor(bank.scrap)} / ${info.max} · pools ${info.pools} · power ${info.supply - info.demand}`
      : 'No recycler yet. Place one from Add object.';
    list.replaceChildren();
    const prod = producer(team);
    if (!prod) {
      status.textContent = 'Place a recycler, factory, armory or constructor.';
      return;
    }
    status.textContent = `${prod.u.name} · ${prod.lane}`;
    const busy = bank.orders.find((o) => o.lane === prod.lane && o.team === team);
    itemsOf(prod.u.data).forEach((item) => {
      const found = odfEntry(catalog.db, item.stem);
      if (!found) return;
      const go = found.data.GameObjectClass || {};
      const cost = numOf(go, 'scrapCost', 0);
      const time = numOf(go, 'buildTime', 5);
      const missing = requirementMet(team, found.data);
      const btn = el('button', 'vt-xp-card', '');
      btn.type = 'button';
      btn.append(el('span', 'vt-xp-card-name', unitNameOf(found)));
      btn.append(el('span', 'vt-xp-card-meta', missing || `${cost} scrap · ${time}s`));
      btn.disabled = !!busy || !!missing || bank.scrap < cost || !info.powered && numOf(go, 'powerCost', 0) > 0;
      btn.addEventListener('click', () => queue(team, prod, found, cost, time));
      list.append(btn);
    });
    if (busy) {
      const cancel = el('button', 'vt-xp-chip is-on', `Cancel ${busy.name}`);
      cancel.type = 'button';
      cancel.addEventListener('click', () => cancelOrder(busy));
      list.prepend(cancel);
    }
  }

  function queue(team, prod, found, cost, time) {
    const bank = teams[team];
    if (bank.orders.some((o) => o.lane === prod.lane)) return;
    if (bank.scrap < cost) return;
    bank.scrap -= cost;
    bank.orders.push({
      team,
      lane: prod.lane,
      producer: prod.u,
      odf: found.filename,
      name: unitNameOf(found),
      cost,
      time: Math.max(0.5, time),
      elapsed: 0,
      refund: prod.lane === 'armory' ? 0 : 0.5,
    });
    paint();
  }

  function cancelOrder(order) {
    const bank = teams[order.team];
    bank.scrap += order.cost * order.refund;
    bank.orders = bank.orders.filter((o) => o !== order);
    paint();
  }

  function update(dt) {
    for (const team of [1, 2]) {
      const info = census(team);
      const bank = teams[team];
      if (info.recycler && !bank.seeded) {
        bank.scrap = Math.max(bank.scrap, Math.min(40, info.max));
        bank.seeded = true;
      }
      if (info.max > 0) {
        const rate = bandRate(bank.scrap, info.pools, info.upgrades);
        bank.scrap = Math.min(info.max, bank.scrap + rate * dt);
      }
      bank.orders.forEach((order) => { order.elapsed += dt; });
      const done = bank.orders.filter((o) => o.elapsed >= o.time);
      bank.orders = bank.orders.filter((o) => o.elapsed < o.time);
      done.forEach((order) => {
        const ang = Math.random() * Math.PI * 2;
        onSpawn({
          odf: order.odf,
          x: order.producer.body.x + Math.cos(ang) * 14,
          z: order.producer.body.z + Math.sin(ang) * 14,
          team: order.team,
          yaw: order.producer.body.yaw,
        });
      });
    }
    if (!panel.hidden) paint();
  }

  return {
    el: panel,
    toggle() { panel.hidden = !panel.hidden; if (!panel.hidden) paint(); },
    close() { panel.hidden = true; },
    get isOpen() { return !panel.hidden; },
    update,
    scrap(team) { return teams[team] ? teams[team].scrap : 0; },
    powered(team) { return census(team).powered; },
    onSpawn(fn) { onSpawn = fn; },
    grant(team, amount) {
      const info = census(team);
      teams[team].scrap = Math.min(info.max || 40, teams[team].scrap + amount);
    },
  };
}
