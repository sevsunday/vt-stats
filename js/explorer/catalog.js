/* Shared catalogs for the Game Explorer. Fetches are module-relative so the
 * page URL does not matter. odf.min.json values are strings.
 */

const DATA = new URL('../../data/', import.meta.url);

export function dataUrl(rel) {
  return new URL(rel, DATA).href;
}

function loadJson(rel) {
  return fetch(dataUrl(rel)).then((res) => {
    if (!res.ok) throw new Error(`${rel} HTTP ${res.status}`);
    return res.json();
  });
}

let indexP = null;
let odfP = null;
let reticleP = null;
let hudP = null;
let registryP = null;

export function loadModelIndex() {
  if (!indexP) indexP = loadJson('models/index.json');
  return indexP;
}

export function loadOdfDb() {
  if (!odfP) odfP = loadJson('odf.min.json');
  return odfP;
}

export function loadReticles() {
  if (!reticleP) {
    reticleP = loadJson('ui/reticles/index.json').catch(() => ({ frames: {}, stems: {} }));
  }
  return reticleP;
}

export function loadExplorerHud() {
  if (!hudP) {
    hudP = loadJson('ui/explorer/index.json').catch(() => null);
  }
  return hudP;
}

/** Map-browser registry (title, author, thumbnail). Missing file degrades
 * to an empty object so the finder can still list stems from the render
 * manifest. */
export function loadMapRegistry() {
  if (!registryP) registryP = loadJson('map-registry.json').catch(() => ({}));
  return registryP;
}

export function normOdf(name) {
  let s = String(name || '').trim().toLowerCase();
  if (!s) return '';
  if (!s.endsWith('.odf')) s += '.odf';
  return s;
}

export function stemOf(name) {
  return normOdf(name).replace(/\.odf$/, '');
}

export function odfEntry(db, name) {
  const key = normOdf(name);
  if (!db || !key) return null;
  for (const bucket of Object.keys(db)) {
    const table = db[bucket];
    if (table && table[key]) return { bucket, filename: key, data: table[key] };
  }
  return null;
}

export function modelForOdf(index, name) {
  const key = normOdf(name);
  const bare = key.replace(/_vsr\.odf$/, '.odf').replace(/vsr\.odf$/, '.odf');
  const models = (index && index.models) || [];
  const match = (odf) => {
    const n = normOdf(odf);
    return n === key || n === bare;
  };
  return models.find((m) => match(m.primaryOdf) || (m.odfs || []).some(match)) || null;
}

export function unitNameOf(entry) {
  const go = entry && entry.data && entry.data.GameObjectClass;
  if (go && go.unitName) return String(go.unitName);
  return stemOf(entry && entry.filename);
}

export function chainTerminal(entry) {
  const chain = entry && entry.data && entry.data.inheritanceChain;
  if (!Array.isArray(chain) || !chain.length) return '';
  return String(chain[chain.length - 1]).toLowerCase();
}

export function numOf(obj, key, fallback) {
  if (!obj || obj[key] == null || obj[key] === '') return fallback;
  const n = parseFloat(String(obj[key]).replace(/f$/i, ''));
  return Number.isFinite(n) ? n : fallback;
}
