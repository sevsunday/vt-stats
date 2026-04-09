function buildWeaponNameResolver(odfDb) {
  const byOrdName = {};
  const byObjectClass = {};
  const byLeaderName = {};
  const dispenserToWpn = {};

  for (const [, wpn] of Object.entries(odfDb.Weapon || {})) {
    const wc = wpn.WeaponClass || {};
    const dc = wpn.DispenserClass || {};
    const tg = wpn.TargetingGunClass || {};
    const name = wc.wpnName;
    if (!name) continue;

    if (wc.ordName)       byOrdName[wc.ordName] = name;
    if (dc.objectClass)   { byObjectClass[dc.objectClass] = name; dispenserToWpn[dc.objectClass] = name; }
    if (tg.leaderName)    byLeaderName[tg.leaderName] = name;
  }

  const byExplosion = {};
  for (const [vehKey, veh] of Object.entries(odfDb.Vehicle || {})) {
    const gc = veh.GameObjectClass || {};
    const tc = veh.TorpedoClass || {};
    const vehBase = vehKey.replace(/\.odf$/i, '');
    const parentWpn = dispenserToWpn[vehBase];
    if (!parentWpn) continue;
    if (tc.xplBlast)       byExplosion[tc.xplBlast] = parentWpn;
    if (gc.explosionName)  byExplosion[gc.explosionName] = parentWpn;
  }

  return function (odfString) {
    const key = odfString.replace(/\.odf$/i, '');
    return byOrdName[key] || byObjectClass[key] || byLeaderName[key] || byExplosion[key] || key;
  };
}

function disambiguateWeaponNames(ordnanceOdfs, lookupFn) {
  const raw = {};
  for (const odf of ordnanceOdfs) {
    raw[odf] = lookupFn(odf);
  }

  const counts = {};
  for (const name of Object.values(raw)) {
    counts[name] = (counts[name] || 0) + 1;
  }

  const result = {};
  for (const [odf, name] of Object.entries(raw)) {
    const key = odf.replace(/\.odf$/i, '');
    result[odf] = counts[name] > 1 ? `${name} (${key})` : name;
  }
  return result;
}

function buildNameResolver(header) {
  const map = {};
  for (const [id, nick] of Object.entries(header.teamnumToNick)) {
    map[Number(id)] = nick;
  }
  return (id) => map[id] || 'Mystery Player';
}

function processMatchData(raw, odfDb) {
  const header = raw.header;
  const events = raw.eventStream;
  const resolve = buildNameResolver(header);
  const tickRate = header.tickRate || 20;

  const ordnanceOdfs = new Set();
  for (const evt of events) {
    if (evt.damageDealt)    ordnanceOdfs.add(evt.damageDealt.ordnanceOdf);
    if (evt.damageReceived) ordnanceOdfs.add(evt.damageReceived.ordnanceOdf);
  }

  let weaponNameMap;
  if (odfDb) {
    const lookup = buildWeaponNameResolver(odfDb);
    weaponNameMap = disambiguateWeaponNames(ordnanceOdfs, lookup);
  }
  const resolveWeapon = (odf) => (weaponNameMap && weaponNameMap[odf]) || odf.replace(/\.odf$/i, '');

  const playerStats = {};
  const rivalryMatrix = {};
  const weaponTotals = {};
  let minTick = Infinity, maxTick = 0;

  function ensurePlayer(name) {
    if (!playerStats[name]) {
      playerStats[name] = {
        dealt: 0,
        received: 0,
        weaponDealt: {},
        weaponsUsed: new Set(),
      };
    }
  }

  for (let i = 0; i < events.length; i++) {
    const evt = events[i];

    if (evt.damageDealt) {
      const d = evt.damageDealt;
      const shooter = resolve(d.shooter);
      const weapon = resolveWeapon(d.ordnanceOdf);
      const amount = d.amount;
      const tick = d.tick;

      ensurePlayer(shooter);
      playerStats[shooter].dealt += amount;
      playerStats[shooter].weaponDealt[weapon] = (playerStats[shooter].weaponDealt[weapon] || 0) + amount;
      playerStats[shooter].weaponsUsed.add(weapon);

      weaponTotals[weapon] = (weaponTotals[weapon] || 0) + amount;

      if (tick < minTick) minTick = tick;
      if (tick > maxTick) maxTick = tick;

      const victim = findPairedVictim(events, i, tick, amount, resolve);
      if (victim) {
        if (!rivalryMatrix[shooter]) rivalryMatrix[shooter] = {};
        rivalryMatrix[shooter][victim] = (rivalryMatrix[shooter][victim] || 0) + amount;
      }
    }

    if (evt.damageReceived) {
      const d = evt.damageReceived;
      const victim = resolve(d.victim);
      ensurePlayer(victim);
      playerStats[victim].received += d.amount;

      if (d.tick < minTick) minTick = d.tick;
      if (d.tick > maxTick) maxTick = d.tick;
    }
  }

  const bucketSizeTicks = 10 * tickRate;
  const timeline = buildTimeline(events, resolve, tickRate, minTick, maxTick, bucketSizeTicks);

  const durationSec = (maxTick - minTick) / tickRate;
  const allNames = Object.keys(playerStats);

  const leaderboard = allNames.map(name => {
    const s = playerStats[name];
    const net = s.dealt - s.received;
    const ratio = s.received > 0 ? s.dealt / s.received : s.dealt > 0 ? Infinity : 0;
    let favWeapon = '—';
    let favMax = 0;
    for (const [w, dmg] of Object.entries(s.weaponDealt)) {
      if (dmg > favMax) { favMax = dmg; favWeapon = w; }
    }
    return { name, dealt: s.dealt, received: s.received, net, ratio, favWeapon, weaponCount: s.weaponsUsed.size };
  }).sort((a, b) => b.dealt - a.dealt);

  const weaponMeta = Object.entries(weaponTotals)
    .map(([weapon, damage]) => ({ weapon, damage }))
    .sort((a, b) => b.damage - a.damage);

  const totalDamage = weaponMeta.reduce((s, w) => s + w.damage, 0);
  const topRivalries = computeTopRivalries(rivalryMatrix, 5);

  return {
    matchInfo: {
      map: header.map,
      date: header.startTime,
      durationSec,
      playerCount: allNames.length,
    },
    leaderboard,
    playerStats,
    rivalryMatrix,
    timeline,
    weaponMeta,
    totalDamage,
    topRivalries,
    allNames,
  };
}

function findPairedVictim(events, dealIdx, tick, amount, resolve) {
  for (let offset = -3; offset <= 3; offset++) {
    if (offset === 0) continue;
    const neighbor = events[dealIdx + offset];
    if (!neighbor || !neighbor.damageReceived) continue;
    const r = neighbor.damageReceived;
    if (r.tick === tick && Math.abs(r.amount - amount) < 0.001) {
      return resolve(r.victim);
    }
  }
  return null;
}

function buildTimeline(events, resolve, tickRate, minTick, maxTick, bucketSize) {
  const playerBuckets = {};

  for (const evt of events) {
    if (!evt.damageDealt) continue;
    const d = evt.damageDealt;
    const bucketIdx = Math.floor((d.tick - minTick) / bucketSize);
    const name = resolve(d.shooter);

    if (!playerBuckets[name]) playerBuckets[name] = {};
    if (!playerBuckets[name][bucketIdx]) playerBuckets[name][bucketIdx] = 0;
    playerBuckets[name][bucketIdx] += d.amount;
  }

  const totalBuckets = Math.floor((maxTick - minTick) / bucketSize) + 1;
  const labels = [];
  for (let i = 0; i < totalBuckets; i++) {
    const sec = (i * bucketSize) / tickRate;
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    labels.push(`${m}:${String(s).padStart(2, '0')}`);
  }

  return { labels, playerBuckets, totalBuckets };
}

function computeTopRivalries(matrix, count) {
  const pairs = {};
  for (const [shooter, victims] of Object.entries(matrix)) {
    for (const [victim, dmg] of Object.entries(victims)) {
      if (shooter === victim) continue;
      const key = [shooter, victim].sort().join('\0');
      if (!pairs[key]) {
        const a = shooter < victim ? shooter : victim;
        const b = shooter < victim ? victim : shooter;
        pairs[key] = { a, b, aToB: 0, bToA: 0 };
      }
      if (shooter < victim) pairs[key].aToB += dmg;
      else pairs[key].bToA += dmg;
    }
  }
  return Object.values(pairs)
    .map(p => ({ ...p, total: p.aToB + p.bToA }))
    .sort((a, b) => b.total - a.total)
    .slice(0, count);
}
