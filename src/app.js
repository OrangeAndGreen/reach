// app.js - Reach's page: the map, the two tools and their network calls.
// The maths lives in core.js; this file fetches, wires and draws.
import * as core from './core.js';
import { lineChart, focusSeries } from './chart.js';
import * as store from './store.js';

const TERRARIUM = (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
const OSRM = 'https://router.project-osrm.org/table/v1/driving/';
const GEOCODE = 'https://geocoding-api.open-meteo.com/v1/search';
const REVERSE = 'https://nominatim.openstreetmap.org/reverse';
const OVERPASS = 'https://overpass-api.de/api/interpreter';
const MAX_PLACES = 8;
const BATCH = 299; // destinations per OSRM call, plus the start
const SERIES = ['--s1', '--s2', '--s3', '--s4', '--s5', '--s6', '--s7', '--s8'];
const BANDS = ['#1c5cab', '#3987e5', '#86b6ef', '#b7d3f6']; // map overlays sit on light tiles in either theme
const BAND_LINE = '#0d366b';

const $ = (id) => document.getElementById(id);
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// ---------- remembered settings ----------

const STORE = 'reach.v1';
function loadSettings() {
  try { return JSON.parse(localStorage.getItem(STORE)) || {}; } catch { return {}; }
}
function saveSettings() {
  try {
    localStorage.setItem(STORE, JSON.stringify({
      units: state.units,
      tab: state.tab,
      radius: state.radius,
      places: state.places.map(({ name, lat, lon, slot }) => ({ name, lat, lon, slot })),
      origin: state.origin,
      print: state.print,
      printTab: state.printTab,
      limits: $('limits').value,
      detail: $('detail').value,
    }));
  } catch { /* storage blocked: settings just aren't remembered */ }
}

// Imported tracks are kept apart, as they can run to thousands of points.
const TRACKS = 'reach.tracks';
function loadTracks() {
  try { return JSON.parse(localStorage.getItem(TRACKS)) || []; } catch { return []; }
}
function saveTracks() {
  try {
    localStorage.setItem(TRACKS, JSON.stringify(state.tracks.map(({ name, lines, levelMm }) => ({ name, lines, levelMm }))));
  } catch { /* storage blocked or full: the tracks just aren't remembered */ }
}

const saved = loadSettings();
const state = {
  units: saved.units || 'metric',
  tab: saved.tab || 'height',
  radius: saved.radius || 500,
  places: saved.places || [
    { name: 'Boston, Massachusetts', lat: 42.3601, lon: -71.0589, slot: 0 },
    { name: 'Miami, Florida', lat: 25.7617, lon: -80.1918, slot: 1 },
    { name: 'Cape Town, South Africa', lat: -33.9249, lon: 18.4241, slot: 2 },
  ],
  origin: saved.origin || { name: 'Boston, Massachusetts', lat: 42.3601, lon: -71.0589 },
  drive: null,
  driveMeasure: 'far',
  print: saved.print || { name: 'Mount Washington, New Hampshire', lat: 44.2706, lon: -71.3033 },
  printTab: saved.printTab || 'shape',
  model: null,
  busy: false,
  // { id, name, lines: [[lon, lat], ...] each, levelMm }, the id only for the list
  tracks: loadTracks().map((t, id) => ({ ...t, id })),
};
if (saved.limits) $('limits').value = saved.limits;
if (saved.detail) $('detail').value = saved.detail;
$('radius').value = String(state.radius);

// ---------- map ----------

const map = L.map('map', { worldCopyJump: true, zoomControl: true }).setView([30, -40], 3);
// credit is the attribution as plain text, for the corner of a downloaded map image.
const streets = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 18, attribution: '&copy; OpenStreetMap contributors', credit: '© OpenStreetMap contributors',
});
const topo = L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
  maxZoom: 17, attribution: 'Map: &copy; OpenTopoMap (CC-BY-SA), data &copy; OpenStreetMap contributors',
  credit: 'Map © OpenTopoMap (CC-BY-SA), data © OpenStreetMap contributors',
});
topo.addTo(map);
L.control.layers({ Terrain: topo, Streets: streets }, null, { position: 'topright' }).addTo(map);
L.control.scale({ imperial: true, metric: true }).addTo(map);
map.attributionControl.addAttribution('Elevation: Mapzen Terrain Tiles on AWS · Routing: OSRM');

const heightLayer = L.layerGroup().addTo(map);
const hoverLayer = L.layerGroup().addTo(map);
const driveLayer = L.layerGroup();
const printLayer = L.layerGroup();

// The print's step arrows sit a fixed few pixels outside it, whatever the zoom.
map.on('zoomend', () => { if (state.tab === 'print' && !drag) drawPrintSquare(false); });

map.on('click', async (e) => {
  if (justDragged) return;
  const lat = e.latlng.lat;
  const lon = ((e.latlng.lng + 540) % 360) - 180;
  const name = await placeName(lat, lon);
  if (state.tab === 'height') addPlace({ name, lat, lon });
  else if (state.tab === 'drive') setOrigin({ name, lat, lon });
  else setPrintCentre({ name, lat, lon });
});

async function placeName(lat, lon) {
  const fallback = `${lat.toFixed(3)}, ${lon.toFixed(3)}`;
  try {
    const r = await fetch(`${REVERSE}?format=jsonv2&zoom=10&lat=${lat}&lon=${lon}`, { headers: { Accept: 'application/json' } });
    const j = await r.json();
    const a = j.address || {};
    const town = a.city || a.town || a.village || a.county || j.name;
    const region = a.state || a.country;
    return town ? [town, region].filter(Boolean).join(', ') : fallback;
  } catch {
    return fallback;
  }
}

// ---------- tabs and units ----------

function setTab(tab) {
  state.tab = tab;
  for (const b of document.querySelectorAll('.tabs button')) b.setAttribute('aria-selected', String(b.dataset.tab === tab));
  for (const t of ['height', 'drive', 'print']) $(`pane-${t}`).hidden = tab !== t;
  for (const layer of [heightLayer, hoverLayer, driveLayer, printLayer]) map.removeLayer(layer);
  if (tab !== 'print') setPreviewBig(false);
  if (tab === 'height') {
    heightLayer.addTo(map);
    hoverLayer.addTo(map);
    fitPlaces();
  } else if (tab === 'drive') {
    driveLayer.addTo(map);
    drawDrive();
    fitDrive();
  } else {
    printLayer.addTo(map);
    drawPrintSquare(true);
    if (!state.model) buildModel();
  }
  saveSettings();
}
document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));

// the print settings split in two: the piece's shape, and what is drawn on it
const subtabs = [...document.querySelectorAll('.subtabs button')];
function setPrintTab(tab) {
  state.printTab = tab;
  for (const b of subtabs) {
    const on = b.dataset.subtab === tab;
    b.setAttribute('aria-selected', String(on));
    b.tabIndex = on ? 0 : -1;
    $(b.getAttribute('aria-controls')).hidden = !on;
  }
  saveSettings();
}
subtabs.forEach((b, i) => {
  b.addEventListener('click', () => setPrintTab(b.dataset.subtab));
  b.addEventListener('keydown', (e) => {
    const step = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
    if (!step) return;
    const next = subtabs[(i + step + subtabs.length) % subtabs.length];
    setPrintTab(next.dataset.subtab);
    next.focus();
  });
});

function setUnits(units) {
  state.units = units;
  for (const b of document.querySelectorAll('.units button')) b.setAttribute('aria-pressed', String(b.dataset.units === units));
  for (const o of $('radius').options) o.textContent = core.formatDistance(Number(o.value), units).replace(/\.0 /, ' ');
  for (const o of $('print-sea').options) {
    const m = Number(o.value);
    if (m > 0 && m < 11000) o.textContent = `Down to ${core.formatHeight(m, units)}`;
  }
  for (const o of $('print-default').options) {
    o.textContent = `${o.textContent.split(' (')[0]} (${core.formatHeight(Number(o.value), units)})`;
  }
  renderHeight();
  renderDrive();
  renderPrintTable();
  saveSettings();
}
document.querySelectorAll('.units button').forEach((b) => b.addEventListener('click', () => setUnits(b.dataset.units)));

const xFactor = () => (state.units === 'imperial' ? 0.621371 : 1);
const yFactor = () => (state.units === 'imperial' ? 3.28084 : 1);
const distUnit = () => (state.units === 'imperial' ? 'mi' : 'km');
const heightUnit = () => (state.units === 'imperial' ? 'ft' : 'm');

// ---------- search ----------

function searchBox(inputId, listId, onPick) {
  const input = $(inputId);
  const list = $(listId);
  let timer = null;
  let results = [];
  let active = -1;
  const close = () => { list.hidden = true; active = -1; };
  const pick = (r) => {
    const name = [r.name, r.admin1 || r.country].filter(Boolean).join(', ');
    onPick({ name, lat: r.latitude, lon: r.longitude });
    input.value = '';
    close();
  };
  const show = () => {
    list.innerHTML = '';
    results.forEach((r, k) => {
      const li = document.createElement('li');
      li.innerHTML = `${escapeHtml(r.name)} <small>${escapeHtml([r.admin1, r.country].filter(Boolean).join(', '))}</small>`;
      if (k === active) li.className = 'active';
      li.addEventListener('mousedown', (e) => { e.preventDefault(); pick(r); });
      list.append(li);
    });
    list.hidden = results.length === 0;
  };
  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) { results = []; close(); return; }
    timer = setTimeout(async () => {
      try {
        const r = await fetch(`${GEOCODE}?name=${encodeURIComponent(q)}&count=6&language=en`);
        results = (await r.json()).results || [];
      } catch { results = []; }
      active = -1;
      show();
    }, 250);
  });
  input.addEventListener('keydown', (e) => {
    if (list.hidden) return;
    if (e.key === 'ArrowDown') { active = Math.min(results.length - 1, active + 1); show(); e.preventDefault(); }
    if (e.key === 'ArrowUp') { active = Math.max(0, active - 1); show(); e.preventDefault(); }
    if (e.key === 'Enter' && results.length) { pick(results[Math.max(0, active)]); e.preventDefault(); }
    if (e.key === 'Escape') close();
  });
  input.addEventListener('blur', () => setTimeout(close, 150));
}

// ---------- elevation tiles ----------

const tileCache = new Map();
let inFlight = 0;
const waiting = [];
async function limited(fn) {
  if (inFlight >= 6) await new Promise((r) => waiting.push(r));
  inFlight++;
  try { return await fn(); } finally { inFlight--; waiting.shift()?.(); }
}

/** The most elevation tiles kept between visits (a few hundred MB at most); past it the oldest go first. */
const TILES_KEPT = 3000;
let tilesKept = null, keptTimer = 0;
/** One tile's PNG, from those kept between visits or else fetched and kept. The tiles don't change, so a kept one never goes stale. */
async function tileBlob(key) {
  const saved = await store.get('tiles', key);
  if (saved?.blob) return saved.blob;
  const blob = await limited(async () => {
    const res = await fetch(TERRARIUM(...key.split('/')));
    if (!res.ok) throw new Error(`elevation tile ${key}: ${res.status}`);
    return res.blob();
  });
  keepTile(key, blob);
  return blob;
}

async function keepTile(key, blob) {
  if (!(await store.putMany('tiles', [[key, { blob, savedAt: Date.now() }]]))) return;
  tilesKept = (tilesKept ?? await store.count('tiles')) + 1;
  if (tilesKept > TILES_KEPT) {
    const drop = Math.round(TILES_KEPT / 10);
    tilesKept -= drop;
    await store.dropOldest('tiles', 'savedAt', drop);
  }
  clearTimeout(keptTimer);
  keptTimer = setTimeout(showKept, 1000); // once a run of tiles settles, not for each
}

/** Elevations of one tile as a Float32Array of 256 x 256 metres. */
function elevationTile(z, x, y) {
  const key = `${z}/${x}/${y}`;
  if (!tileCache.has(key)) {
    const p = (async () => {
      const bmp = await createImageBitmap(await tileBlob(key));
      const canvas = new OffscreenCanvas(256, 256);
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(bmp, 0, 0);
      const px = ctx.getImageData(0, 0, 256, 256).data;
      const out = new Float32Array(256 * 256);
      for (let k = 0; k < out.length; k++) out[k] = core.terrariumElevation(px[k * 4], px[k * 4 + 1], px[k * 4 + 2]);
      return core.despike(out);
    })();
    p.catch(() => tileCache.delete(key));
    tileCache.set(key, p);
    if (tileCache.size > 600) tileCache.delete(tileCache.keys().next().value);
  }
  return tileCache.get(key);
}

/** Calls visit(lon, lat, metres) for every pixel of every tile, with progress. */
async function eachPixel(tiles, visit, onProgress) {
  let done = 0;
  await Promise.all(tiles.map(async (t) => {
    const elev = await elevationTile(t.z, t.x, t.y);
    const lons = new Float64Array(256);
    const lats = new Float64Array(256);
    for (let k = 0; k < 256; k++) {
      lons[k] = core.tileToLonLat(t.x + (k + 0.5) / 256, 0, t.z).lon;
      lats[k] = core.tileToLonLat(0, t.y + (k + 0.5) / 256, t.z).lat;
    }
    for (let py = 0; py < 256; py++) {
      const lat = lats[py];
      for (let px = 0; px < 256; px++) visit(lons[px], lat, elev[py * 256 + px]);
    }
    onProgress(++done, tiles.length);
    await new Promise((r) => setTimeout(r)); // let the page breathe between tiles
  }));
}

// ---------- height tool ----------

function placeColor(p) { return cssVar(SERIES[p.slot]); }

function addPlace(place) {
  if (state.places.length >= MAX_PLACES) {
    status('height', `Eight places at most. Remove one to add ${place.name}.`, true);
    return;
  }
  const used = new Set(state.places.map((p) => p.slot));
  const slot = SERIES.findIndex((_, s) => !used.has(s));
  state.places.push({ ...place, slot });
  renderPlaces();
  saveSettings();
  measure();
}

function removePlace(k) {
  state.places.splice(k, 1);
  renderPlaces();
  renderHeight();
  saveSettings();
}

function renderPlaces() {
  const ul = $('places');
  ul.innerHTML = '';
  state.places.forEach((p, k) => {
    const li = document.createElement('li');
    li.innerHTML = `<span class="swatch" style="background:${placeColor(p)}"></span>
      <span class="name">${escapeHtml(p.name)}</span><span class="coords">${p.lat.toFixed(2)}, ${p.lon.toFixed(2)}</span>
      <button aria-label="Remove ${escapeHtml(p.name)}">×</button>`;
    li.querySelector('button').addEventListener('click', () => removePlace(k));
    li.addEventListener('pointerenter', () => focusSeries($('height-chart'), p.name));
    li.addEventListener('pointerleave', () => focusSeries($('height-chart'), null));
    ul.append(li);
  });
  heightLayer.clearLayers();
  // A shaded circle for each radius in the table, largest first; nested ones darken toward the place.
  const rings = state.places.map((p) => (p.points ? core.tableRings(p.points, tableHeights(), p.radius) : null));
  state.places.forEach((p, k) => {
    for (const r of [...(rings[k]?.radii || [])].reverse()) {
      L.circle([p.lat, p.lon], { radius: r * 1000, color: placeColor(p), weight: 1, opacity: 0.6, fillColor: placeColor(p), fillOpacity: 0.06, interactive: false })
        .addTo(heightLayer);
    }
  });
  state.places.forEach((p, k) => {
    L.circleMarker([p.lat, p.lon], { radius: 7, color: '#fff', weight: 2, fillColor: placeColor(p), fillOpacity: 1 })
      .bindTooltip(p.name).addTo(heightLayer);
    for (const top of rings[k]?.summits || []) {
      L.circleMarker([top.lat, top.lon], { radius: 5, color: placeColor(p), weight: 2, fillColor: '#fff', fillOpacity: 1 })
        .bindTooltip(`Highest within ${distanceRange(top.minKm, top.maxKm)} of ${p.name.split(',')[0]}: ${core.formatHeight(top.metres, state.units)}`)
        .addTo(heightLayer);
    }
  });
}

/** The heights the table asks about, round numbers in the units on show. */
function tableHeights() {
  return state.units === 'imperial' ? [500, 1000, 3000, 5000, 10000].map((ft) => ft / 3.28084) : [100, 500, 1000, 2000, 3000];
}

/** "40 km", or "40–100 km" when a summit is the highest over a span of radii. */
function distanceRange(minKm, maxKm) {
  const hi = core.formatDistance(maxKm, state.units);
  if (minKm === maxKm) return hi;
  return `${core.formatDistance(minKm, state.units).replace(/ (km|mi)$/, '')}–${hi}`;
}

function fitPlaces() {
  if (!state.places.length) return;
  const bounds = L.latLngBounds(state.places.map((p) => [p.lat, p.lon]));
  if (state.places.length === 1) map.setView(bounds.getCenter(), 7);
  else map.fitBounds(bounds.pad(0.25));
}

let measureRun = 0;
async function measure() {
  const run = ++measureRun;
  const radius = Number($('radius').value);
  state.radius = radius;
  saveSettings();
  $('measure').disabled = true;
  try {
    for (const [k, p] of state.places.entries()) {
      if (p.points && p.radius === radius) continue;
      const z = core.pickZoom(p, radius, 160);
      const tiles = core.tilesForRadius(p, radius, z);
      const profile = core.makeProfile(p, radius, 300);
      const res = Math.round(core.pixelMetres(p.lat, z));
      await eachPixel(tiles, (lon, lat, m) => core.addSample(profile, lon, lat, m), (done, total) => {
        if (run !== measureRun) return;
        progress('height', `Reading the ground around ${p.name.split(',')[0]} (${k + 1} of ${state.places.length}) at ${res} m per pixel`, done / total);
      });
      if (run !== measureRun) return;
      // Sharpen each step of the running maximum, the points the curve and table are made of.
      // A step that was a glitch drops out, which can expose new steps, so go round until
      // every step has been read up close.
      const seen = new Set();
      for (let round = 0; round < 6; round++) {
        const steps = [...new Map(core.finishProfile(profile).filter((q) => q.at).map((q) => [`${q.at.lon},${q.at.lat}`, q.at])).entries()]
          .filter(([key]) => !seen.has(key)).slice(-25);
        if (!steps.length) break;
        for (const [s, [key, c]] of steps.entries()) {
          if (run !== measureRun) return;
          progress('height', `Sharpening the peaks around ${p.name.split(',')[0]}: ${s + 1} of ${steps.length}`, s / steps.length);
          const top = await refinePeak(c, z);
          core.replacePeak(profile, c, top);
          seen.add(key);
          seen.add(`${top.lon},${top.lat}`);
        }
      }
      p.points = core.finishProfile(profile);
      p.radius = radius;
      p.zoom = z;
      renderHeight();
    }
    status('height', state.places.length ? `Elevation from the Mapzen terrain tiles on AWS. Each step of the curve is re-read at about 30 m, so summits come out true.` : '');
  } catch (err) {
    status('height', `Couldn't read the elevation tiles (${err.message}). Check the connection and press Measure again.`, true);
  } finally {
    if (run === measureRun) $('measure').disabled = false;
  }
}
$('measure').addEventListener('click', () => {
  for (const p of state.places) p.points = null;
  measure();
});
$('radius').addEventListener('change', measure);
$('xscale').addEventListener('change', renderHeight);

function renderHeight() {
  renderPlaces();
  const xf = xFactor(), yf = yFactor();
  const ready = state.places.filter((p) => p.points);
  const log = $('xscale').value === 'log';
  $('height-legend').innerHTML = ready.map((p) => `<span data-name="${escapeHtml(p.name)}"><i style="background:${placeColor(p)}"></i>${escapeHtml(p.name)}</span>`).join('');
  for (const span of $('height-legend').children) {
    span.addEventListener('pointerenter', () => focusSeries($('height-chart'), span.dataset.name));
    span.addEventListener('pointerleave', () => focusSeries($('height-chart'), null));
  }
  lineChart($('height-chart'), {
    series: ready.map((p) => ({
      name: p.name,
      color: placeColor(p),
      points: p.points.map((q) => ({ x: q.km * xf, y: q.max == null ? null : q.max * yf })),
    })),
    x: { label: `Distance from the place (${distUnit()})`, log, format: (d, exact) => fmtNum(d, exact) + (exact ? ` ${distUnit()}` : '') },
    y: { label: `Highest point (${heightUnit()})`, format: (d, exact) => fmtNum(d, exact) + (exact ? ` ${heightUnit()}` : ` ${heightUnit()}`) },
    steps: true,
    empty: 'Add a place and press Measure.',
    onHover: (xv) => showHeightHover(xv == null ? null : xv / xf),
  });

  // Distance needed to reach each height, and the top within the whole radius.
  const heights = tableHeights();
  const head = `<thead><tr><th>To stand this high</th>${ready.map((p) => `<th>${escapeHtml(p.name.split(',')[0])}</th>`).join('')}</tr></thead>`;
  const rows = heights.map((m) => `<tr><td>${core.formatHeight(m, state.units)}</td>${ready.map((p) => {
    const d = core.distanceToReach(p.points, m);
    return d == null ? `<td class="none" title="Not within ${core.formatDistance(p.radius, state.units)}">&gt; ${core.formatDistance(p.radius, state.units)}</td>` : `<td>${core.formatDistance(d, state.units)}</td>`;
  }).join('')}</tr>`).join('');
  const top = `<tr><td>Highest within ${core.formatDistance(state.radius, state.units)}</td>${ready.map((p) => {
    const s = core.summitWithin(p.points, p.radius);
    return `<td>${s ? `${core.formatHeight(s.metres, state.units)}<br><small>${core.formatDistance(s.km, state.units)} away</small>` : '-'}</td>`;
  }).join('')}</tr>`;
  $('height-table').innerHTML = ready.length ? head + `<tbody>${rows}${top}</tbody>` : '';
}

function showHeightHover(km) {
  hoverLayer.clearLayers();
  if (km == null) return;
  for (const p of state.places) {
    if (!p.points) continue;
    const s = core.summitWithin(p.points, km);
    L.circle([p.lat, p.lon], { radius: km * 1000, color: placeColor(p), weight: 1.5, fill: false, dashArray: '4 4', interactive: false }).addTo(hoverLayer);
    if (s) {
      L.marker([s.lat, s.lon], {
        interactive: false,
        icon: L.divIcon({ className: 'peak-pin', html: '▲', iconSize: [18, 18], iconAnchor: [9, 12] }),
      }).addTo(hoverLayer);
      L.tooltip({ permanent: true, direction: 'top', offset: [0, -10] })
        .setLatLng([s.lat, s.lon]).setContent(core.formatHeight(s.metres, state.units)).addTo(hoverLayer);
    }
  }
}

$('height-csv').addEventListener('click', () => {
  const ready = state.places.filter((p) => p.points);
  if (ready.length) download('reach-heights.csv', core.profilesCsv(ready), 'text/csv');
});

// ---------- drive tool ----------

function setOrigin(origin) {
  state.origin = origin;
  state.drive = null;
  $('origin-name').textContent = `Starting from ${origin.name}.`;
  saveSettings();
  drawDrive();
  renderDrive();
  map.setView([origin.lat, origin.lon], Math.max(map.getZoom(), 6));
}

function parseLimits() {
  const limits = $('limits').value.split(/[,\s]+/).map(Number).filter((h) => h > 0 && h <= 24);
  return [...new Set(limits)].sort((a, b) => a - b).slice(0, 4);
}

function cacheKey(grid) {
  return `reach.osrm.${grid.center.lat.toFixed(3)},${grid.center.lon.toFixed(3)},${grid.halfKm},${grid.n}`;
}

async function runDrive() {
  const limits = parseLimits();
  if (!limits.length) {
    status('drive', 'Give one to four drive times in hours, like "4, 8, 12".', true);
    return;
  }
  const n = Number($('detail').value);
  const grid = core.makeGrid(state.origin, core.gridHalfWidthKm(limits.at(-1)), n);
  $('drive-run').disabled = true;
  saveSettings();
  try {
    let hours = null;
    try { hours = JSON.parse(localStorage.getItem(cacheKey(grid)))?.map((h) => (h == null ? Infinity : h)); } catch { /* no cache */ }
    if (!hours || hours.length !== grid.points.length) {
      const batches = core.chunk(grid.points, BATCH);
      const durations = [];
      const snaps = [];
      for (const [k, batch] of batches.entries()) {
        progress('drive', `Asking OSRM for road times: batch ${k + 1} of ${batches.length}`, k / batches.length);
        const coords = [state.origin, ...batch].map((p) => `${p.lon.toFixed(5)},${p.lat.toFixed(5)}`).join(';');
        const res = await fetchRetry(`${OSRM}${coords}?sources=0`);
        const j = await res.json();
        if (j.code !== 'Ok') throw new Error(j.message || j.code);
        durations.push(...j.durations[0].slice(1));
        snaps.push(...j.destinations.slice(1).map((d) => d.distance));
        if (k < batches.length - 1) await new Promise((r) => setTimeout(r, 700)); // gentle on the demo server
      }
      hours = core.cleanDurations(durations, snaps, Math.min(20, grid.step * 0.5));
      try { localStorage.setItem(cacheKey(grid), JSON.stringify(hours.map((h) => (Number.isFinite(h) ? +h.toFixed(4) : null)))); } catch { /* full */ }
    }
    state.drive = buildDrive(grid, hours, limits);
    status('drive', `${grid.points.length.toLocaleString('en-US')} points ${core.formatDistance(grid.step, state.units)} apart. Find the high ground for the tallest point in each band.`);
    drawDrive();
    fitDrive();
    renderDrive();
  } catch (err) {
    status('drive', `Routing failed (${err.message}). The OSRM demo server may be busy; try again in a minute.`, true);
  } finally {
    $('drive-run').disabled = false;
  }
}
$('drive-run').addEventListener('click', runDrive);

async function fetchRetry(url, tries = 3) {
  for (let k = 1; ; k++) {
    try {
      const res = await fetch(url);
      if (res.status === 429 && k < tries) throw new Error('rate limited');
      return res;
    } catch (err) {
      if (k >= tries) throw err;
      await new Promise((r) => setTimeout(r, 1500 * k));
    }
  }
}

function buildDrive(grid, hours, limits) {
  const values = core.contourValues(hours).map((v) => -v);
  const contours = d3.contours().size([grid.n, grid.n]).thresholds(limits.map((h) => -h))(values);
  const bands = limits.map((h, k) => ({
    hours: h,
    label: `${core.formatHours(h)} drive`,
    color: BANDS[k],
    // d3 sorts thresholds, so match each contour by its value, not its position.
    polygons: core.contourToLonLat(grid, contours.find((c) => c.value === -h).coordinates),
  }));
  const steps = [];
  for (let h = 0.25; h <= limits.at(-1) + 1e-9; h += 0.25) steps.push(+h.toFixed(2));
  return { grid, hours, limits, bands, curve: core.reachCurve(grid, hours, steps), heights: null };
}

function drawDrive() {
  driveLayer.clearLayers();
  L.circleMarker([state.origin.lat, state.origin.lon], { radius: 7, color: '#fff', weight: 2, fillColor: cssVar('--accent'), fillOpacity: 1 })
    .bindTooltip(state.origin.name).addTo(driveLayer);
  const d = state.drive;
  if (!d) return;
  // Widest band first, so the nearer ones paint on top and the colours stack.
  [...d.bands].reverse().forEach((b) => {
    const latlngs = b.polygons.map((poly) => poly.map((ring) => ring.map(([lon, lat]) => [lat, lon])));
    L.polygon(latlngs, { color: BAND_LINE, weight: 1.5, fillColor: b.color, fillOpacity: 0.28, interactive: false }).addTo(driveLayer);
  });
  for (const pin of drivePins()) {
    L.marker([pin.lat, pin.lon], {
      icon: L.divIcon({ className: pin.peak ? 'peak-pin' : 'band-label', html: pin.peak ? '▲' : escapeHtml(pin.short), iconSize: null }),
    }).bindTooltip(`${pin.name}: ${pin.description}`).addTo(driveLayer);
  }
}

/** The placemarks a drive run earns: the farthest point in each band, and its highest ground. */
function drivePins() {
  const d = state.drive;
  if (!d) return [];
  const pins = [];
  for (const h of d.limits) {
    const far = core.atLimit(d.curve, 'hours', h);
    if (far?.at) {
      pins.push({ name: `Farthest within ${core.formatHours(h)}`, short: core.formatHours(h), lon: far.at.lon, lat: far.at.lat,
        description: `${core.formatDistance(far.farthestKm, state.units)} in a straight line` });
    }
    const high = d.heights && core.atLimit(d.heights, 'hours', h);
    if (high?.at) {
      pins.push({ name: `Highest within ${core.formatHours(h)}`, peak: true, lon: high.at.lon, lat: high.at.lat,
        description: `${core.formatHeight(high.max, state.units)}, ${core.formatHours(high.at.hours)} away` });
    }
  }
  return pins;
}

function fitDrive() {
  const d = state.drive;
  if (!d) { map.setView([state.origin.lat, state.origin.lon], 6); return; }
  const outer = d.bands.at(-1).polygons.flat(2).map(([lon, lat]) => [lat, lon]);
  if (outer.length) map.fitBounds(L.latLngBounds(outer).pad(0.05));
}

document.querySelectorAll('.seg button').forEach((b) => b.addEventListener('click', () => {
  state.driveMeasure = b.dataset.measure;
  for (const o of document.querySelectorAll('.seg button')) o.setAttribute('aria-pressed', String(o === b));
  renderDrive();
}));

function renderDrive() {
  $('origin-name').textContent = `Starting from ${state.origin.name}.`;
  const d = state.drive;
  const m = state.driveMeasure;
  const titles = { far: 'Farthest point reached, straight line', area: 'Ground within reach', high: 'Highest point within reach' };
  $('drive-chart-title').textContent = titles[m];
  const xf = xFactor(), yf = yFactor();
  let points = [];
  let yLabel = '';
  let yFormat = (v) => fmtNum(v);
  if (d && m === 'far') {
    points = [{ x: 0, y: 0 }, ...d.curve.map((c) => ({ x: c.hours, y: c.farthestKm * xf }))];
    yLabel = distUnit();
    yFormat = (v, exact) => fmtNum(v, exact) + ` ${distUnit()}`;
  } else if (d && m === 'area') {
    const af = state.units === 'imperial' ? 0.386102 : 1;
    points = [{ x: 0, y: 0 }, ...d.curve.map((c) => ({ x: c.hours, y: c.areaKm2 * af }))];
    yFormat = (v, exact) => (exact ? core.formatArea(v / af, state.units) : fmtNum(v));
  } else if (d?.heights && m === 'high') {
    points = d.heights.map((c) => ({ x: c.hours, y: c.max == null ? null : c.max * yf }));
    yFormat = (v, exact) => fmtNum(v, exact) + ` ${heightUnit()}`;
  }
  lineChart($('drive-chart'), {
    series: [{ name: state.origin.name, color: cssVar('--s1'), points }],
    x: { label: 'Hours of driving', format: (v, exact) => (exact ? core.formatHours(v) : `${fmtNum(v)} h`) },
    y: { label: yLabel, format: yFormat },
    steps: m === 'high',
    empty: !d ? 'Press "Map drive times" to route from the start.' : 'Press "Find the high ground" to read the elevation inside each band.',
  });

  if (!d) { $('drive-table').innerHTML = ''; $('drive-kml').disabled = true; $('drive-high').disabled = true; return; }
  $('drive-kml').disabled = false;
  $('drive-high').disabled = false;
  const head = `<thead><tr><th>Within</th><th>Ground</th><th>Farthest</th><th>Highest</th></tr></thead>`;
  const rows = d.limits.map((h) => {
    const c = core.atLimit(d.curve, 'hours', h);
    const high = d.heights && core.atLimit(d.heights, 'hours', h);
    return `<tr><td>${core.formatHours(h)}</td><td>${core.formatArea(c.areaKm2, state.units)}</td><td>${core.formatDistance(c.farthestKm, state.units)}</td>` +
      `<td${high ? '' : ' class="none"'}>${high ? core.formatHeight(high.max, state.units) : 'not read yet'}</td></tr>`;
  }).join('');
  $('drive-table').innerHTML = head + `<tbody>${rows}</tbody>`;
}

$('drive-high').addEventListener('click', async () => {
  const d = state.drive;
  if (!d) return;
  $('drive-high').disabled = true;
  try {
    const z = core.pickZoom(d.grid.center, d.grid.halfKm, 320);
    const tiles = core.tilesForRadius(d.grid.center, d.grid.halfKm, z);
    const acc = core.makeDriveHeights(d.limits.at(-1));
    await eachPixel(tiles, (lon, lat, m) => core.addDriveSample(acc, core.hoursAt(d.grid, d.hours, lon, lat), lon, lat, m),
      (done, total) => progress('drive', `Reading the ground: tile ${done} of ${total}`, done / total));
    // The coarse pass finds where the high ground is; re-read each candidate up close for its true top.
    const candidates = [...new Map(acc.at.filter(Boolean).map((c) => [`${c.lon},${c.lat}`, c])).values()];
    for (const [k, c] of candidates.entries()) {
      progress('drive', `Sharpening the peaks: ${k + 1} of ${candidates.length}`, k / candidates.length);
      const top = await refinePeak(c, z);
      core.addDriveSample(acc, core.hoursAt(d.grid, d.hours, top.lon, top.lat), top.lon, top.lat, top.metres);
    }
    d.heights = core.finishDriveHeights(acc);
    status('drive', `Found the high ground at ${Math.round(core.pixelMetres(d.grid.center.lat, z))} m per pixel, then re-read each peak at about 30 m. Hover a ▲ on the map for its height.`);
    state.driveMeasure = 'high';
    for (const o of document.querySelectorAll('.seg button')) o.setAttribute('aria-pressed', String(o.dataset.measure === 'high'));
    drawDrive();
    renderDrive();
  } catch (err) {
    status('drive', `Couldn't read the elevation tiles (${err.message}).`, true);
  } finally {
    $('drive-high').disabled = false;
  }
});

/**
 * The highest pixel near a coarse find, read at zoom 12 (about 30 m). A coarse
 * pixel is an average, so a summit inside it reads low until looked at closely.
 */
async function refinePeak(c, coarseZoom) {
  const radiusKm = core.pixelMetres(c.lat, coarseZoom) / 1000;
  const z = Math.min(12, coarseZoom + 5);
  let best = { lon: c.lon, lat: c.lat, metres: -Infinity };
  await eachPixel(core.tilesForRadius(c, radiusKm, z), (lon, lat, m) => {
    if (m > best.metres && core.haversineKm(c, { lon, lat }) <= radiusKm) best = { lon, lat, metres: m };
  }, () => {});
  return best;
}

$('drive-kml').addEventListener('click', () => {
  const d = state.drive;
  if (!d) return;
  const kml = core.driveKml({ name: `Drive times from ${state.origin.name}`, origin: state.origin, bands: d.bands, placemarks: drivePins() });
  const slug = state.origin.name.split(',')[0].toLowerCase().replace(/[^a-z0-9]+/g, '-');
  download(`reach-drive-${slug}.kml`, kml, 'application/vnd.google-earth.kml+xml');
});

// ---------- print tool ----------

function printSettings() {
  const widthMm = Number($('print-width').value), pitchMm = Number($('print-pitch').value);
  // Only a square splits into pieces; every other shape is one.
  const [cols, rows] = $('print-shape').value === 'square' ? $('print-pieces').value.split('x').map(Number) : [1, 1];
  return {
    sideKm: Number($('print-side').value),
    widthMm,
    cells: core.gridCells(widthMm, pitchMm),
    pitchMm,
    exaggeration: stretch(),
    baseMm: Number($('print-base').value),
    seaFloorM: Number($('print-sea').value),
    depthStretch: Number($('print-depth').value),
    ...shoreSetting($('print-shore').value),
    label: ['on', 'both'].includes($('print-label').value),
    labelText: ['text', 'both'].includes($('print-label').value) ? $('print-text').value : '',
    cornerMm: Number($('print-corner').value),
    shape: $('print-shape').value,
    aspect: Number($('print-aspect').value),
    bearing: Number($('print-turn').value),
    buildings: $('print-buildings').value === 'osm' && Number($('print-side').value) <= core.BUILDINGS_MAX_KM,
    buildingDefaultM: Number($('print-default').value),
    roadMm: $('print-roads').value === 'osm' && Number($('print-side').value) <= core.ROADS_MAX_KM ? levelsOf('road', core.ROAD_CLASSES) : core.NO_ROADS,
    waterMm: $('print-water').value === 'osm' && Number($('print-side').value) <= core.WATER_MAX_KM ? levelsOf('water', core.WATER_KINDS) : core.NO_WATER,
    tracks: state.tracks.filter((t) => t.levelMm).map(({ name, lines, levelMm }) => ({ name, lines, levelMm })),
    cols,
    rows,
  };
}

/**
 * A print's outline on the map as one shape: a set of pieces is a rectangle
 * around them all, so it outlines, drags and steps as one.
 */
function wholeShape(set) {
  if (set.cols * set.rows === 1) return set;
  return { ...set, widthMm: set.widthMm * set.cols, shape: 'rectangle', aspect: set.cols / set.rows, cols: 1, rows: 1 };
}

/** The level selects of roads or water (prefix), as { class or kind: mm }. */
function levelsOf(prefix, kinds) {
  return Object.fromEntries(Object.keys(kinds).map((k) => [k, Number($(`print-${prefix}-${k}`).value)]));
}

/** "Raised 0.8 mm", "Sunk 0.6 mm" or "Left out", for a level select or the table. */
function levelText(mm) {
  return mm > 0 ? `Raised ${mm} mm` : mm < 0 ? `Sunk ${-mm} mm` : 'Left out';
}

/** The shoreline select's value, "groove-0.4" or "ridge-0.8" or "0", as settings. */
function shoreSetting(value) {
  const [style, size] = value.split('-');
  return { shoreMm: Number(size) || 0, shoreRidge: style === 'ridge' };
}

function setPrintCentre(place, fit = true) {
  state.print = place;
  saveSettings();
  drawPrintSquare(fit);
  buildModel();
}

/** The print's outline on the map, as Leaflet lat/lngs: the shape, turned. */
function printOutline(set, centre) {
  set = wholeShape(set);
  const frame = core.printFrame(centre, set.sideKm, set.widthMm, set.bearing);
  const { ring } = core.shapeOutline(set.shape, set.widthMm, { aspect: set.aspect, cornerMm: set.shape === 'square' ? 0 : set.cornerMm });
  return ring.map(([x, y]) => { const p = frame.toLonLat(x, y); return [p.lat, p.lon]; });
}

function drawPrintSquare(fit) {
  printLayer.clearLayers();
  // While the outline is dragged it shows where it would go, and how big.
  const set = { ...printSettings(), ...drag?.now };
  const centre = drag?.now?.centre || state.print;
  $('print-name').textContent = !drag?.now ? `Centred on ${state.print.name}.`
    : set.shape === 'rectangle' ? `${core.formatSide(set.sideKm, state.units)} × ${core.formatSide(set.sideKm / set.aspect, state.units)}`
    : `${core.formatSide(set.sideKm, state.units)} across`;
  const outline = printOutline(set, centre);
  // A white casing under the line keeps the outline readable over busy city maps.
  L.polygon(outline, { color: '#ffffff', weight: 7, opacity: 0.9, fill: false, interactive: false }).addTo(printLayer);
  const rect = L.polygon(outline, { color: cssVar('--accent'), weight: 3, fill: true, fillOpacity: 0.06, interactive: false });
  rect.addTo(printLayer);
  // The lines between pieces, thin, so the set still reads as one print.
  if (set.cols * set.rows > 1) {
    const plan = core.piecePlan(centre, set), w = set.widthMm;
    const at = (x, y) => { const p = plan.frame.toLonLat(x, y); return [p.lat, p.lon]; };
    const lines = [];
    for (let c = 1; c < set.cols; c++) lines.push([at(c * w, plan.bottomMm), at(c * w, plan.bottomMm + plan.downMm)]);
    for (let r = 1; r < set.rows; r++) lines.push([at(0, plan.bottomMm + r * w), at(plan.acrossMm, plan.bottomMm + r * w)]);
    L.polyline(lines, { color: cssVar('--accent'), weight: 1.5, dashArray: '5 5', interactive: false }).addTo(printLayer);
  }
  // Every imported track, printed or left out, so it's plain where each runs against the print.
  for (const t of state.tracks) {
    const lines = t.lines.map((line) => line.map(([lon, lat]) => [lat, lon]));
    L.polyline(lines, { color: '#ffffff', weight: 5, opacity: 0.8, interactive: false }).addTo(printLayer);
    L.polyline(lines, { color: core.TRACK_COLOUR, weight: 2.5, dashArray: t.levelMm ? null : '4 5', interactive: false }).addTo(printLayer);
  }
  L.circleMarker([centre.lat, centre.lon], { radius: 5, color: '#fff', weight: 2, fillColor: cssVar('--accent'), fillOpacity: 1, interactive: false })
    .addTo(printLayer);
  // Wider, unseen grips over the line and the dot, so a finger can take hold of them.
  const edge = L.polygon(outline, { opacity: 0, weight: 18, fill: false, className: 'print-grip print-edge' }).addTo(printLayer);
  edge.getElement().addEventListener('pointerdown', (e) => startDrag(e, false));
  const dot = L.circleMarker([centre.lat, centre.lon], { radius: 14, opacity: 0, fillOpacity: 0, className: 'print-grip print-dot' }).addTo(printLayer);
  dot.getElement().addEventListener('pointerdown', (e) => startDrag(e, true));
  if (!drag && (set.shape === 'square' || set.shape === 'rectangle')) drawStepArrows(wholeShape(set), centre);
  if (fit) map.fitBounds(rect.getBounds().pad(0.6));
}

// ---------- stepping the print one over ----------
// An arrow just outside each side of a square or rectangle moves the print
// one whole shape across that side, so the two print to sit edge to edge.

const STEP_GAP_PX = 22; // how far outside the side its arrow sits
const STEP_NAMES = { left: 'left', right: 'right', top: 'up', bottom: 'down' };

function drawStepArrows(set, centre) {
  const frame = core.printFrame(centre, set.sideKm, set.widthMm, set.bearing);
  const c = set.widthMm / 2, h = set.shape === 'rectangle' ? set.widthMm / set.aspect : set.widthMm;
  const mids = { left: [0, c], right: [set.widthMm, c], top: [c, c + h / 2], bottom: [c, c - h / 2] };
  const middle = map.latLngToContainerPoint([centre.lat, centre.lon]);
  for (const [side, [x, y]] of Object.entries(mids)) {
    const p = frame.toLonLat(x, y);
    const at = map.latLngToContainerPoint([p.lat, p.lon]);
    const out = at.subtract(middle);
    const len = out.distanceTo(L.point(0, 0)) || 1;
    const spot = map.containerPointToLatLng(at.add(out.multiplyBy(STEP_GAP_PX / len)));
    const turn = (Math.atan2(out.y, out.x) * 180) / Math.PI;
    const icon = L.divIcon({
      className: 'print-step', iconSize: [28, 28],
      html: `<svg viewBox="0 0 24 24" style="transform: rotate(${turn}deg)"><path d="M9 5l7 7-7 7"/></svg>`,
    });
    L.marker(spot, { icon, title: `Move the print one over, ${STEP_NAMES[side]}`, alt: `Move the print one over, ${STEP_NAMES[side]}` })
      .on('click', () => stepPrint(side))
      .addTo(printLayer);
  }
}

function stepPrint(side) {
  const set = wholeShape(printSettings());
  const next = core.neighbourCentre({ centre: state.print, sideKm: set.sideKm, widthMm: set.widthMm, bearing: set.bearing, aspect: set.aspect }, set.shape, side);
  // When the print steps out of view the map follows it as far, so the arrow stays under the pointer.
  const shift = map.latLngToContainerPoint([next.lat, next.lon]).subtract(map.latLngToContainerPoint([state.print.lat, state.print.lon]));
  const seen = map.getBounds().contains(L.latLngBounds(printOutline(set, next)));
  movePrint(next);
  if (!seen) map.panBy(shift);
}

// ---------- dragging the outline ----------
// The centre dot moves the whole print. The outline resizes it about its
// centre, except a rectangle, whose side moves alone. Sizes snap (core.snapSideKm),
// and the model is built once the pointer lets go.

let drag = null; // { edge, start, from, print, now } while the outline is held
let justDragged = false; // swallows the click that ends a drag, so it doesn't re-centre the print

function startDrag(e, centreDot) {
  if (e.button > 0) return;
  e.preventDefault();
  e.stopPropagation();
  map.dragging.disable();
  const set = printSettings();
  const at = map.mouseEventToLatLng(e);
  const from = { lat: at.lat, lon: at.lng };
  const print = { centre: state.print, sideKm: set.sideKm, widthMm: set.widthMm, bearing: set.bearing, aspect: set.aspect };
  const edge = centreDot ? 'centre'
    : core.outlineEdge(set.shape, set.widthMm, set.aspect, core.printFrame(state.print, set.sideKm, set.widthMm, set.bearing).toMm(from.lon, from.lat));
  drag = { edge, start: map.mouseEventToContainerPoint(e), from, print, now: null };
  map.getContainer().classList.add('print-dragging');
  document.addEventListener('pointermove', moveDrag);
  document.addEventListener('pointerup', endDrag);
  document.addEventListener('pointercancel', endDrag);
}

function moveDrag(e) {
  // A press that wanders a few pixels is still a tap, not a drag.
  if (!drag.now && map.mouseEventToContainerPoint(e).distanceTo(drag.start) < 4) return;
  const at = map.mouseEventToLatLng(e);
  const to = { lat: at.lat, lon: at.lng };
  const { print, from } = drag;
  drag.now = drag.edge === 'centre'
    ? { centre: { lat: Math.max(-85, Math.min(85, print.centre.lat + to.lat - from.lat)), lon: print.centre.lon + to.lon - from.lon } }
    : core.dragOutline(print, drag.edge, from, to);
  drawPrintSquare(false);
}

function endDrag() {
  document.removeEventListener('pointermove', moveDrag);
  document.removeEventListener('pointerup', endDrag);
  document.removeEventListener('pointercancel', endDrag);
  map.getContainer().classList.remove('print-dragging');
  map.dragging.enable();
  const { now, print } = drag;
  drag = null;
  if (!now) return;
  justDragged = true;
  setTimeout(() => { justDragged = false; }, 0);
  const set = printSettings();
  if (now.sideKm && now.sideKm !== set.sideKm) {
    addSide(now.sideKm, null, true);
    lastSide = $('print-side').value;
    $('print-side-field').hidden = true;
    showBuildingControls();
  }
  if (now.aspect && now.aspect !== set.aspect) addAspect(now.aspect);
  if (now.centre === print.centre) {
    drawPrintSquare(false);
    buildModel();
    return;
  }
  movePrint(now.centre);
}

/** Centres the print on a point moved to on the map, named once the lookup answers. */
function movePrint(centre) {
  const lat = centre.lat, lon = ((centre.lon + 540) % 360) - 180;
  const place = { name: `${lat.toFixed(3)}, ${lon.toFixed(3)}`, lat, lon };
  setPrintCentre(place, false);
  // The name follows when the lookup answers, unless the print has moved on by then.
  placeName(lat, lon).then((name) => {
    if (state.print !== place) return;
    place.name = name;
    saveSettings();
    if (!drag) $('print-name').textContent = `Centred on ${name}.`;
  });
}

/** Chooses a rectangle's aspect dragged on the map, which replaces the last one dragged in the list. */
function addAspect(aspect) {
  const el = $('print-aspect');
  for (const o of [...el.options]) if (o.dataset.dragged && Number(o.value) !== aspect) o.remove();
  let option = [...el.options].find((o) => Number(o.value) === aspect);
  if (!option) {
    option = new Option(`${Number(aspect.toFixed(2))} : 1`, aspect);
    option.dataset.dragged = '1';
    el.insertBefore(option, [...el.options].find((o) => Number(o.value) > aspect));
  }
  el.value = option.value;
}

/** Elevation at fractional global pixel coordinates, bilinear across tile edges. */
function sampler(tiles, z) {
  const n = 2 ** z;
  const get = (gx, gy) => {
    const tx = Math.floor(gx / 256), ty = Math.floor(gy / 256);
    const t = tiles.get(`${z}/${((tx % n) + n) % n}/${ty}`);
    if (!t) return 0;
    return t[(gy - ty * 256) * 256 + (gx - tx * 256)];
  };
  return (fx, fy) => {
    const x0 = Math.floor(fx - 0.5), y0 = Math.floor(fy - 0.5);
    const tx = fx - 0.5 - x0, ty = fy - 0.5 - y0;
    return get(x0, y0) * (1 - tx) * (1 - ty) + get(x0 + 1, y0) * tx * (1 - ty) +
      get(x0, y0 + 1) * (1 - tx) * ty + get(x0 + 1, y0 + 1) * tx * ty;
  };
}

/**
 * The print square's n x n grid of heights (row 0 along the model's top,
 * north unless it is turned), sampled from the zoom-z tiles at frame's points.
 * centre and set.sideKm say which tiles to read. Returns null when a newer
 * build has started meanwhile.
 */
async function readPrintGrid(frame, centre, set, z, run, what) {
  const list = core.tilesForRadius(centre, set.sideKm * 0.71, z);
  const tiles = new Map();
  let done = 0;
  await Promise.all(list.map(async (t) => {
    tiles.set(`${t.z}/${t.x}/${t.y}`, await elevationTile(t.z, t.x, t.y));
    if (run === modelRun) progress('print', `Reading the ${what}: tile ${++done} of ${list.length}`, done / list.length);
  }));
  if (run !== modelRun) return null;
  const at = sampler(tiles, z);
  const n = set.cells, step = set.widthMm / (n - 1);
  const heights = new Array(n * n);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const { lon, lat } = frame.toLonLat(i * step, (n - 1 - j) * step);
      const p = core.lonLatToTile(lon, lat, z);
      heights[j * n + i] = at(p.x * 256, p.y * 256);
    }
  }
  return heights;
}

const osmCache = new Map();
/** An Overpass query's reply from OpenStreetMap, as { osm, readAt }. Kept for the session. */
function overpass(query) {
  if (!osmCache.has(query)) {
    const p = (async () => {
      const res = await fetch(OVERPASS, { method: 'POST', body: new URLSearchParams({ data: query }) });
      if ([429, 502, 504].includes(res.status)) throw new Error(`Overpass is busy (${res.status}), try again in a minute`);
      if (!res.ok) throw new Error(`Overpass ${res.status}`);
      return { osm: await res.json(), readAt: new Date().toISOString().slice(0, 10) };
    })();
    p.catch(() => osmCache.delete(query));
    osmCache.set(query, p);
  }
  return osmCache.get(query);
}

const OSM_QUERY = { buildings: core.overpassBuildingsQuery, roads: core.overpassRoadsQuery, water: core.overpassWaterQuery };
/**
 * OpenStreetMap's buildings, roads or water in a lon/lat box, as { osm, readAt }:
 * the cells kept from earlier visits, with only the ones missing or older
 * than core.OSM_CELL_DAYS asked of Overpass (onFetch is called first), and
 * kept in turn. readAt is the oldest cell's.
 */
async function osmArea(kind, bounds, onFetch) {
  const z = core.OSM_CELL_ZOOM[kind];
  const cells = core.cellsForBounds(bounds, z);
  const keyOf = (c) => `${kind}/${z}/${c.x}/${c.y}`;
  const saved = await store.getMany('osm', cells.map(keyOf));
  const today = new Date().toISOString().slice(0, 10);
  // water cells kept from before river lines were fetched, or lakes told from rivers' areas, are read again
  const missing = cells.filter((c, i) => !saved[i] || core.cellStale(saved[i].readAt, today) || (kind === 'water' && !saved[i].kinds));
  if (missing.length) {
    onFetch?.();
    const { osm, readAt } = await overpass(OSM_QUERY[kind](core.cellBoxes(missing, z)));
    const parts = (kind === 'water' ? core.waterByCell : core.elementsByCell)(osm, missing, z);
    const fresh = missing.map((c) => [keyOf(c), { elements: parts.get(`${c.x}/${c.y}`), readAt, ...(kind === 'water' && { kinds: true }) }]);
    const got = new Map(fresh);
    cells.forEach((c, i) => { saved[i] = got.get(keyOf(c)) || saved[i]; });
    store.putMany('osm', fresh).then(showKept);
  }
  return {
    osm: core.mergeElements(saved.map((s) => s.elements)),
    readAt: saved.map((s) => s.readAt).sort()[0],
  };
}

/** The line under the Print tool that says how much is kept between visits. */
async function showKept() {
  const [tiles, cells] = await Promise.all([store.count('tiles'), store.count('osm')]);
  tilesKept = tiles;
  $('kept-text').textContent = tiles || cells
    ? `Kept for next time: ${tiles.toLocaleString()} elevation tile${tiles === 1 ? '' : 's'} and ${cells.toLocaleString()} OpenStreetMap area${cells === 1 ? '' : 's'}.`
    : 'Nothing kept for next time yet.';
  $('kept-clear').hidden = !(tiles || cells);
}
$('kept-clear').addEventListener('click', async () => {
  await Promise.all([store.clear('tiles'), store.clear('osm')]);
  osmCache.clear();
  showKept();
});
showKept();
try { navigator.storage?.persist?.(); } catch { /* best effort */ }

let modelRun = 0;
/** The edge skew past which a print says its square isn't square on the ground. */
const SKEW_WARN = 0.05;
async function buildModel() {
  const run = ++modelRun;
  const set = printSettings();
  const centre = state.print;
  $('print-run').disabled = true;
  try {
    // A print in pieces is a print of each piece's ground, all read through the set's one frame.
    const plan = core.piecePlan(centre, set);
    const split = plan.pieces.length > 1;
    const pieceSet = { ...set, sideKm: plan.pieceKm };
    const n = set.cells;
    // One zoom for every piece, so the side two pieces share is read alike.
    const z = core.printZoom(centre, pieceSet.sideKm, n);
    const pixel = core.pixelMetres(centre.lat, z);
    // Past zoom 10 the tiles have no sea floor, so it comes from zoom 10, under the detailed land.
    const seaZoom = set.seaFloorM > 0 ? Math.min(z, core.SEA_FLOOR_ZOOM) : null;
    // A square keeps the whole grid and its own rounded corners; any other shape is cut from the grid.
    const outline = set.shape === 'square' ? null : core.shapeOutline(set.shape, set.widthMm, set);
    const cut = outline && core.shapeCells(outline.ring, n, set.widthMm);
    let reply = null, missed = '';
    if (set.buildings) {
      const corner = plan.pieces.flatMap(({ frame: { bounds: b } }) => [{ lon: b.west, lat: b.south }, { lon: b.east, lat: b.north }]);
      try {
        reply = await osmArea('buildings', core.lonLatBounds(corner), () => status('print', 'Fetching the buildings from OpenStreetMap…'));
      } catch (err) {
        missed = ` Couldn't fetch the buildings (${err.message}), so this is the terrain alone.`;
      }
      if (run !== modelRun) return;
    }
    let roadReply = null;
    if (core.anyLevel(set.roadMm)) {
      const corner = plan.pieces.flatMap(({ frame: { bounds: b } }) => [{ lon: b.west, lat: b.south }, { lon: b.east, lat: b.north }]);
      try {
        roadReply = await osmArea('roads', core.lonLatBounds(corner), () => status('print', 'Fetching the roads from OpenStreetMap…'));
      } catch (err) {
        missed += ` Couldn't fetch the roads (${err.message}), so the print has none.`;
      }
      if (run !== modelRun) return;
    }
    let waterReply = null;
    if (core.anyLevel(set.waterMm)) {
      const corner = plan.pieces.flatMap(({ frame: { bounds: b } }) => [{ lon: b.west, lat: b.south }, { lon: b.east, lat: b.north }]);
      try {
        waterReply = await osmArea('water', core.lonLatBounds(corner), () => status('print', 'Fetching the lakes and rivers from OpenStreetMap…'));
      } catch (err) {
        missed += ` Couldn't fetch the lakes and rivers (${err.message}), so the print has none.`;
      }
      if (run !== modelRun) return;
    }
    const read = [];
    for (const piece of plan.pieces) {
      const where = split ? { ...piece.centre, name: centre.name } : centre;
      const of = split ? ` of ${piece.name}` : '';
      let heights = await readPrintGrid(piece.frame, where, pieceSet, z, run, `terrain${of}`);
      if (!heights) return;
      if (seaZoom != null && seaZoom < z) {
        const floor = await readPrintGrid(piece.frame, where, pieceSet, seaZoom, run, `sea floor${of}`);
        if (!floor) return;
        heights = core.withSeaFloor(heights, floor);
      }
      let placed = null, buildings = null;
      if (reply) {
        const { osm, readAt } = reply;
        const footprints = core.buildingFootprints(osm, piece.frame.bounds, set.widthMm, { frame: piece.frame, pieces: outline?.pieces });
        // Around a building the terrain may hold, its surroundings are read a pixel and a half out, clear of the blur.
        placed = core.placeBuildings(footprints, heights, n, { ...pieceSet, padM: 1.5 * pixel, defaultM: set.buildingDefaultM });
        heights = placed.heights;
        const list = placed.buildings;
        buildings = {
          count: list.length, tagged: list.filter((b) => b.tagged).length, inData: list.filter((b) => b.inData).length,
          tallestM: list.reduce((m, b) => Math.max(m, b.heightM), 0), liftM: placed.liftM, readAt, triangles: 0,
        };
      }
      read.push({ piece, heights, placed, buildings });
    }
    // Every piece stands on the base under the lowest point of them all, so their sides meet at one height.
    const lowM = Math.min(...read.map((r) => core.printHeights(r.heights, pieceSet, cut?.used).lowM));
    const pieces = read.map(({ piece, heights, placed, buildings }) => {
      const scaled = core.printHeights(heights, { ...pieceSet, lowM }, cut?.used);
      const shore = set.shoreMm > 0 ? core.shorePoints(heights, n) : null;
      if (shore) scaled.mm = core.markShore(scaled.mm, shore, set.shoreMm, set.shoreRidge);
      // Water and sunk roads are cut before the buildings and raised roads are stood on the ground, so they reach down into it rather than float.
      let water = null;
      if (waterReply) {
        const level = set.waterMm;
        const { lakes, wide } = core.waterKinds(waterReply.osm, heights, n, set.widthMm, piece.frame);
        const areas = lakes.map((v, k) => v | wide[k]);
        let rivers = { mm: scaled.mm, mask: new Uint8Array(n * n), km: 0 };
        if (level.narrow) {
          rivers = core.carveRivers(scaled.mm, core.riverLines(waterReply.osm, piece.frame), n,
            { widthMm: set.widthMm, mmPerMetre: scaled.mmPerMetre, depthMm: -level.narrow, skip: areas, heights });
        }
        let mm = rivers.mm;
        if (level.lakes) mm = core.carveWater(mm, lakes, n, -level.lakes);
        if (level.wide) mm = core.carveWater(mm, wide, n, -level.wide);
        scaled.mm = mm;
        // blue in the preview: the water printed
        const mask = areas.map((_, k) => (level.lakes && lakes[k]) || (level.wide && wide[k]) || rivers.mask[k] ? 1 : 0);
        const cellKm = set.widthMm / (n - 1) / scaled.mmPerMetre / 1000;
        const km2 = (points) => points.reduce((s, v) => s + v, 0) * cellKm * cellKm;
        water = { mask, areas, lakesKm2: level.lakes ? km2(lakes) : 0, wideKm2: level.wide ? km2(wide) : 0, riverKm: rivers.km, readAt: waterReply.readAt };
      }
      let ways = null, roadMask = null;
      if (roadReply) {
        ways = core.roadLines(roadReply.osm, piece.frame.bounds, set.widthMm, { frame: piece.frame, pieces: outline?.pieces })
          .filter(({ cls }) => set.roadMm[cls]);
        const sunk = core.carveRoads(scaled.mm, ways, n, { ...pieceSet, ...scaled, levels: set.roadMm, skip: water?.areas, heights });
        scaled.mm = sunk.mm;
        roadMask = sunk.mask;
      }
      let trackWays = null, trackMask = null;
      if (set.tracks.length) {
        trackWays = core.trackLines(set.tracks, { frame: piece.frame, widthMm: set.widthMm, pieces: outline?.pieces });
        const sunk = core.carveRoads(scaled.mm, trackWays, n, { ...pieceSet, ...scaled, skip: water?.areas, heights });
        scaled.mm = sunk.mm;
        trackMask = sunk.mask;
      }
      const extra = placed ? core.buildingTriangles(placed.buildings, scaled.mm, n, { ...pieceSet, ...scaled }) : [];
      if (buildings) buildings.triangles = extra.length / 3;
      let roads = null;
      if (ways) {
        const roadTris = core.roadTriangles(ways, scaled.mm, n, { ...pieceSet, ...scaled, levels: set.roadMm });
        for (const p of roadTris) extra.push(p);
        const km = {};
        for (const { cls, line } of ways) km[cls] = (km[cls] || 0) + core.lineLength(line) / scaled.mmPerMetre / 1000;
        roads = { count: ways.length, km, triangles: roadTris.length / 3, mask: roadMask, readAt: roadReply.readAt };
      }
      // written last, after the roads, so the preview finds them at the end
      let tracks = null;
      if (trackWays) {
        const trackTris = core.roadTriangles(trackWays, scaled.mm, n, { ...pieceSet, ...scaled });
        for (const p of trackTris) extra.push(p);
        const km = set.tracks.map(() => 0);
        for (const { track, line } of trackWays) km[track] += core.lineLength(line) / scaled.mmPerMetre / 1000;
        tracks = { km, triangles: trackTris.length / 3, mask: trackMask };
      }
      const { lines, wrap } = core.labelLines(centre, set, split ? piece.name : null);
      const label = lines.length ? core.bottomLabel(lines, scaled.mm, n, set.widthMm, outline, set.bearing, wrap) : null;
      const cutLabel = label?.why ? null : label;
      let stl, top = 2 * (n - 1) ** 2;
      if (cut) {
        const mesh = core.shapeMesh(scaled.mm, cut, extra, cutLabel);
        stl = core.writeStl(mesh.tris);
        top = mesh.top;
      } else {
        stl = core.terrainStl(scaled.mm, n, set.widthMm, extra, cutLabel, set.cornerMm, split ? piece.corners : null);
      }
      return { name: piece.name, col: piece.col, row: piece.row, corners: piece.corners, stl, top, outline, scaled, set: pieceSet, buildings, roads, water, tracks, shore, label };
    });
    state.model = {
      set, centre, plan, pieces, zoom: z, pixel, seaZoom, seaPixel: seaZoom == null ? null : core.pixelMetres(centre.lat, seaZoom),
      lowM, highM: Math.max(...pieces.map((p) => p.scaled.highM)), reliefMm: Math.max(...pieces.map((p) => p.scaled.reliefMm)),
      buildings: sumBuildings(pieces),
      roads: sumRoads(pieces),
      water: sumWater(pieces),
      tracks: sumTracks(pieces),
    };
    showPieceChoice();
    showModel();
    const sea = seaZoom != null && seaZoom < z ? `, the sea floor at ${Math.round(state.model.seaPixel)} m,` : '';
    const lifted = state.model.buildings?.liftM > core.LIFTED_M
      ? ` The elevation data here holds the buildings: the ground under them reads about ${core.formatHeight(state.model.buildings.liftM, state.units)} above the open ground nearby, so the land prints lumpy under them.`
      : '';
    // Under about 40 pixels across, the ground is a smooth blur of a few readings.
    const across = Math.round((pieceSet.sideKm * 1000) / pixel);
    const smooth = across < 40
      ? ` The ${split ? 'piece' : 'square'} is only ${across} pixels of elevation data across, so its ground prints smooth: a square this small is for buildings.`
      : '';
    const skew = core.edgeSkew(centre, set.sideKm);
    const pole = centre.lat >= 0 ? 'north' : 'south', equator = centre.lat >= 0 ? 'south' : 'north';
    const skewed = skew <= SKEW_WARN ? ''
      : set.shape === 'square' && !set.bearing && !split
        ? ` The square is even in latitude and longitude, so on the ground its ${pole} edge is ${Math.round(skew * 100)}% shorter than its ${equator} edge, and the print stretches it to match.`
        : ` The print is even in latitude and longitude, so on the ground its ${pole}ern part is up to ${Math.round(skew * 100)}% narrower east to west than its ${equator}ern part, and the print stretches it to match.`;
    const grid = split
      ? `sampled on ${pieces.length} pieces of ${n} × ${n}, each with its base under ${core.formatHeight(lowM, state.units)}, the lowest point of the set, so their sides meet.`
      : `sampled on a ${n} × ${n} grid.`;
    status('print', `Terrain read at ${Math.round(pixel)} m per pixel${sea} and ${grid}${smooth}${skewed}${lifted}${missed}`, Boolean(missed));
    $('print-stl').disabled = false;
    $('print-kml').disabled = false;
  } catch (err) {
    status('print', `Couldn't build the model (${err.message}).`, true);
  } finally {
    if (run === modelRun) $('print-run').disabled = false;
  }
}

/** The buildings of every piece together, or null without them. A building on a seam counts in both pieces. */
function sumBuildings(pieces) {
  const all = pieces.map((p) => p.buildings).filter(Boolean);
  if (!all.length) return null;
  const sum = (k) => all.reduce((s, b) => s + b[k], 0);
  const lifts = all.map((b) => b.liftM).filter((v) => v != null);
  return {
    count: sum('count'), tagged: sum('tagged'), inData: sum('inData'), triangles: sum('triangles'),
    tallestM: Math.max(...all.map((b) => b.tallestM)), liftM: lifts.length ? Math.max(...lifts) : null, readAt: all[0].readAt,
  };
}

/** The roads of every piece together, or null without them. */
function sumRoads(pieces) {
  const all = pieces.map((p) => p.roads).filter(Boolean);
  if (!all.length) return null;
  const km = {};
  for (const r of all) for (const [cls, v] of Object.entries(r.km)) km[cls] = (km[cls] || 0) + v;
  return { count: all.reduce((s, r) => s + r.count, 0), km, triangles: all.reduce((s, r) => s + r.triangles, 0), readAt: all[0].readAt };
}

/** The lakes and rivers of every piece together, or null without them. */
function sumWater(pieces) {
  const all = pieces.map((p) => p.water).filter(Boolean);
  if (!all.length) return null;
  const sum = (k) => all.reduce((s, w) => s + w[k], 0);
  return { lakesKm2: sum('lakesKm2'), wideKm2: sum('wideKm2'), riverKm: sum('riverKm'), readAt: all[0].readAt };
}

/** The length of each track printed, over every piece together (km), or null without tracks. */
function sumTracks(pieces) {
  const all = pieces.map((p) => p.tracks).filter(Boolean);
  if (!all.length) return null;
  return { km: all[0].km.map((_, k) => all.reduce((s, t) => s + t.km[k], 0)) };
}

/** The preview's piece list: the whole set, then each piece. Hidden for a print in one piece. */
function showPieceChoice() {
  const el = $('print-view'), { pieces } = state.model;
  const was = el.value;
  el.hidden = pieces.length < 2;
  el.replaceChildren(new Option('All pieces', 'all'), ...pieces.map((p, k) => new Option(`Piece ${p.name}`, String(k))));
  el.value = [...el.options].some((o) => o.value === was) ? was : 'all';
}
$('print-view').addEventListener('change', showModel);
$('print-run').addEventListener('click', buildModel);
// "Your own…" opens a box for a side typed by hand, which joins the list in order.
let lastSide = $('print-side').value;
function sideChanged() {
  lastSide = $('print-side').value;
  drawPrintSquare(true);
  showBuildingControls();
  showRoadControls();
  showWaterControls();
  buildModel();
}
function addSide(km, label, dragged) {
  const el = $('print-side');
  // A size dragged on the map replaces the last one dragged, so drags don't pile up in the list.
  if (dragged) for (const o of [...el.options]) if (o.dataset.dragged && Number(o.value) !== km) o.remove();
  let option = [...el.options].find((o) => Number(o.value) === km);
  if (!option) {
    label ||= km < 1 ? `${Number((km * 1000).toPrecision(4))} m` : `${Number(km.toPrecision(4))} km`;
    option = new Option(label, km);
    option.dataset[dragged ? 'dragged' : 'own'] = '1';
    el.insertBefore(option, [...el.options].find((o) => o.value === 'custom' || Number(o.value) > km));
  }
  el.value = option.value;
}
$('print-side').addEventListener('change', () => {
  const el = $('print-side');
  if (el.value === 'custom') {
    el.value = lastSide;
    $('print-side-field').hidden = false;
    $('print-side-own').value = el.selectedOptions[0].textContent;
    $('print-side-own').focus();
    $('print-side-own').select();
    return;
  }
  $('print-side-field').hidden = !el.selectedOptions[0].dataset.own;
  $('print-side-hint').hidden = true;
  sideChanged();
});
$('print-side-own').addEventListener('change', () => {
  const side = core.parseSide($('print-side-own').value, state.units);
  const hint = $('print-side-hint');
  hint.hidden = !!side;
  if (!side) {
    const [lo, hi] = [core.SIDE_MIN_KM, core.SIDE_MAX_KM].map((km) => core.formatSide(km, state.units));
    hint.textContent = `A size across reads as a number, in ${distUnit()} or with m, km, ft or mi after it, from ${lo} to ${hi}.`;
    return;
  }
  addSide(side.km, side.label);
  sideChanged();
});
// The slider moves through stops, so x1-x10 keeps its quarter steps beside x50.
let stretchStops = core.STRETCH_STOPS;
$('print-exag').max = String(stretchStops.length - 1);
function stretch() { return stretchStops[Number($('print-exag').value)]; }
function setStretch(value) {
  stretchStops = core.withStop(stretchStops, value);
  $('print-exag').max = String(stretchStops.length - 1);
  $('print-exag').value = String(stretchStops.indexOf(value));
  $('print-exag-value').textContent = `× ${value}`;
}
$('print-exag').addEventListener('input', () => { $('print-exag-value').textContent = `× ${stretch()}`; });
$('print-exag').addEventListener('change', buildModel);
for (const id of ['print-pitch', 'print-base', 'print-default']) $(id).addEventListener('change', buildModel);

/** Names each detail with the grid it makes at the chosen width. */
function labelPitches() {
  const widthMm = Number($('print-width').value);
  for (const o of $('print-pitch').options) {
    if (!o.dataset.name) continue;
    const n = core.gridCells(widthMm, Number(o.value));
    o.textContent = `${o.dataset.name}, ${o.value} mm (${n} × ${n})`;
  }
}
labelPitches();
// The width sets the corner radius against the outline, so the map's outline follows it.
$('print-width').addEventListener('change', () => { labelPitches(); showShapeControls(); drawPrintSquare(false); buildModel(); });
$('print-shore').addEventListener('change', () => { $('print-shore-hint').hidden = $('print-shore').value === '0'; buildModel(); });
$('print-label').addEventListener('change', () => { showLabelControls(); buildModel(); });
$('print-text').addEventListener('input', showLabelControls);
$('print-text').addEventListener('change', buildModel);
function showLabelControls() {
  const mode = $('print-label').value;
  const own = mode === 'text' || mode === 'both';
  $('print-text-field').hidden = !own;
  $('print-label-hint').hidden = mode === 'none';
  const what = { on: 'The centre, the ground covered and the height stretch', text: 'Your text', both: 'Your text, then the centre, the ground covered and the height stretch,' }[mode];
  const missing = own ? core.unprintable($('print-text').value) : [];
  $('print-label-hint').textContent = `${what} under an arrow pointing north, cut 0.6 mm up into the underside and mirrored, so it reads when the print is turned over. Print it flat side down as usual: each letter is a short bridge. Turn the preview over to see it.` +
    (own ? ` The letters are capitals; the font has digits and . , - : ' ! ? & / ( ) + # ° ×.` : '') +
    (missing.length ? ` It has no ${missing.join(' ')}, which print as spaces.` : '');
}
showLabelControls();
$('print-corner').addEventListener('change', () => { showShapeControls(); drawPrintSquare(false); buildModel(); });
function showShapeControls() {
  const shape = $('print-shape').value;
  $('print-aspect-field').hidden = shape !== 'rectangle';
  $('print-pieces-field').hidden = shape !== 'square';
  const [cols, rows] = $('print-pieces').value.split('x').map(Number);
  const split = shape === 'square' && cols * rows > 1, w = Number($('print-width').value);
  $('print-pieces-hint').hidden = !split;
  $('print-pieces-hint').textContent = `${cols} across by ${rows} down. Size across is the whole set's ground, and each piece is the model width, so together they are ${cols * w} × ${rows * w} mm. ` +
    'Every piece stands on the base under the lowest point of the whole set, so their sides meet at the same height, and the label underneath names each one (A1 at the top left). Only the outside corners are rounded.';
  $('print-corner-field').hidden = shape === 'circle';
  $('print-corner-hint').hidden = shape === 'circle' || $('print-corner').value === '0';
  $('print-corner-hint').textContent = shape === 'square'
    ? 'Rounded corners are slower to lift off the bed as the print cools. The ground within a corner is squeezed to fit, by up to 0.4 of the radius.'
    : 'Rounded corners are slower to lift off the bed as the print cools. The ground beyond the curve is left off.';
  const turn = Number($('print-turn').value);
  $('print-turn-value').textContent = turn ? `${(turn + 360) % 360}° (${compass(turn)})` : 'north up';
}
for (const id of ['print-shape', 'print-aspect', 'print-pieces']) $(id).addEventListener('change', () => { showShapeControls(); drawPrintSquare(false); buildModel(); });
// The outline turns on the map as the slider moves; the model builds once it is let go.
$('print-turn').addEventListener('input', () => { showShapeControls(); drawPrintSquare(false); });
$('print-turn').addEventListener('change', buildModel);
showShapeControls();
setStretch(1.5);
function showSeaControls() {
  const on = Number($('print-sea').value) > 0;
  $('print-depth-field').hidden = !on;
  $('print-sea-hint').hidden = !on;
  $('print-depth-value').textContent = `× ${$('print-depth').value}`;
}
$('print-sea').addEventListener('change', () => { showSeaControls(); buildModel(); });
$('print-depth').addEventListener('input', showSeaControls);
$('print-depth').addEventListener('change', buildModel);
showSeaControls();
function showBuildingControls() {
  const wanted = $('print-buildings').value === 'osm';
  const fits = Number($('print-side').value) <= core.BUILDINGS_MAX_KM;
  $('print-default-field').hidden = !wanted || !fits;
  $('print-buildings-hint').hidden = !wanted;
  $('print-buildings-hint').textContent = fits
    ? 'Each building is its own solid, raised from the ground under it by its height in OpenStreetMap, or its floors at 3 m each, at the same height stretch as the land. Where the elevation data already holds a building, the ground under it is flattened first.'
    : `Buildings need a square of ${core.BUILDINGS_MAX_KM} km or less, so this one is the terrain alone.`;
}
$('print-buildings').addEventListener('change', () => { showBuildingControls(); buildModel(); });
showBuildingControls();
// Every level select offers the same levels, starting at its own default.
for (const el of document.querySelectorAll('select.level')) {
  el.replaceChildren(...core.LEVELS_MM.map((mm) => new Option(levelText(mm), String(mm))));
  el.value = el.dataset.level;
  el.addEventListener('change', () => { showRoadControls(); showWaterControls(); buildModel(); });
}
function showRoadControls() {
  const fits = Number($('print-side').value) <= core.ROADS_MAX_KM;
  const wanted = $('print-roads').value === 'osm';
  const c = core.ROAD_CLASSES, level = levelsOf('road', c);
  $('print-road-levels').hidden = !wanted || !fits;
  $('print-roads-hint').hidden = !wanted;
  const raised = Object.values(level).some((v) => v > 0), sunk = Object.values(level).some((v) => v < 0);
  $('print-roads-hint').textContent = !fits
    ? `Roads need a print of ${core.ROADS_MAX_KM} km or less across, so this one has none.`
    : !raised && !sunk ? 'Every class is left out, so the print has no roads.'
    : [`Motorways, trunk and primary roads are ${c.motorway.widthMm}, ${c.trunk.widthMm} and ${c.primary.widthMm} mm wide, each class at its own level over or under the ground along it, smoothed so it reads as graded.`,
      raised && 'A raised road is its own solid standing on the ground.',
      sunk && 'A sunk road is a groove cut into the ground, which leaves the water it crosses alone.',
      'Tunnels and ramps are left out.'].filter(Boolean).join(' ');
}
$('print-roads').addEventListener('change', () => { showRoadControls(); buildModel(); });
showRoadControls();
function showWaterControls() {
  const fits = Number($('print-side').value) <= core.WATER_MAX_KM;
  const wanted = $('print-water').value === 'osm';
  const level = levelsOf('water', core.WATER_KINDS);
  $('print-water-levels').hidden = !wanted || !fits;
  $('print-water-hint').hidden = !wanted;
  const how = (mm) => (mm > 0 ? `raised ${mm} mm over` : `sunk ${-mm} mm under`);
  $('print-water-hint').textContent = !fits
    ? `Lakes and rivers need a print of ${core.WATER_MAX_KM} km or less across, so this one has none.`
    : !core.anyLevel(level) ? 'Every kind is left out, so the print has no water.'
    : [level.lakes && `Lakes, ponds and reservoirs are ${how(level.lakes)} the lowest water near each point, so each prints as one flat level.`,
      level.wide && `Rivers and canals mapped as areas are ${how(level.wide)} the lowest water near each point, so they step down their valleys.`,
      (level.lakes || level.wide) && `Islands stay land, and water under ${core.WATER_MIN_MM2} mm² on the model is left out.`,
      level.narrow && `Rivers mapped only as lines are ${level.narrow > 0 ? 'ridges' : 'channels'} at least ${core.RIVER_WIDTH_MM} mm wide, ${how(level.narrow)} the lowest ground upstream, so they never climb.`,
      'Raised water only lifts the ground; it never cuts it. Streams are left out.'].filter(Boolean).join(' ');
}
$('print-water').addEventListener('change', () => { showWaterControls(); buildModel(); });
showWaterControls();

// Tracks of your own, from KML files: each in the list with its level and a button to take it out.
let nextTrack = state.tracks.length;
function renderTracks() {
  const ul = $('print-tracks');
  ul.innerHTML = '';
  ul.hidden = !state.tracks.length;
  for (const t of state.tracks) {
    const li = document.createElement('li');
    li.innerHTML = `<span class="swatch" style="background:${core.TRACK_COLOUR}"></span>
      <span class="name" title="${escapeHtml(t.name)}">${escapeHtml(t.name)}</span><span class="coords">${trackLength(core.trackKm(t))}</span>
      <select aria-label="Level of ${escapeHtml(t.name)}"></select>
      <button type="button" aria-label="Remove ${escapeHtml(t.name)}" title="Remove from the model">×</button>`;
    const level = li.querySelector('select');
    level.replaceChildren(...core.LEVELS_MM.map((mm) => new Option(levelText(mm), String(mm))));
    if (!core.LEVELS_MM.includes(t.levelMm)) level.append(new Option(levelText(t.levelMm), String(t.levelMm)));
    level.value = String(t.levelMm);
    level.addEventListener('change', () => { t.levelMm = Number(level.value); tracksChanged(); });
    li.querySelector('button').addEventListener('click', () => {
      state.tracks = state.tracks.filter((x) => x !== t);
      tracksChanged();
    });
    ul.append(li);
  }
  const printed = state.tracks.filter((t) => t.levelMm);
  $('print-tracks-hint').textContent = !state.tracks.length
    ? 'Lines from a KML file (a hike, a ride, a route drawn in Google Earth) printed on the ground, each raised or sunk by its own amount.'
    : !printed.length ? 'Every track is left out, so the print has none. Left out, a track is dashed on the map.'
    : `Each track is ${core.TRACK_WIDTH_MM} mm wide, at its level over or under the ground along it, smoothed so it reads as graded. `
      + 'A raised track is its own solid standing on the ground; a sunk one is a groove, which leaves the water it crosses alone. The heights in the file are not used.';
}
function trackLength(km) {
  return state.units === 'imperial' ? `${(km / 1.609344).toFixed(1)} mi` : `${km.toFixed(1)} km`;
}
function tracksChanged() {
  saveTracks();
  renderTracks();
  drawPrintSquare(false);
  buildModel();
}
$('print-track-add').addEventListener('click', () => $('print-track-file').click());
$('print-track-file').addEventListener('change', async () => {
  const files = [...$('print-track-file').files];
  $('print-track-file').value = '';
  const added = [], empty = [];
  for (const file of files) {
    let found = [];
    try {
      found = core.parseTrackKml(await file.text(), file.name.replace(/\.kml$/i, ''));
    } catch { /* unreadable: counts as no lines */ }
    if (!found.length) empty.push(file.name);
    for (const { name, lines } of found) added.push({ id: nextTrack++, name, lines, levelMm: core.TRACK_LEVEL_MM });
  }
  state.tracks.push(...added);
  const none = empty.length ? ` No lines in ${empty.join(', ')}.` : '';
  if (!added.length) { status('print', `No tracks imported.${none}`, true); return; }
  status('print', `Imported ${added.length === 1 ? added[0].name : `${added.length} tracks`}.${none}`, Boolean(empty.length));
  tracksChanged();
});
renderTracks();

// Enlarged, the preview moves into the map's place (the whole screen on a phone),
// and the settings stay beside it. Its ResizeObserver sizes the view to fit.
const previewHome = $('print-preview').parentElement;
function setPreviewBig(big) {
  const el = $('print-preview');
  if (big === el.classList.contains('big')) return;
  el.classList.toggle('big', big);
  (big ? document.querySelector('.map-wrap') : previewHome).append(el);
  const b = $('print-preview-size');
  const what = big ? 'Put the map back' : 'Enlarge the preview';
  b.setAttribute('aria-pressed', String(big));
  b.setAttribute('aria-label', what);
  b.title = what;
  $('print-preview-hint').textContent = big ? '(in place of the map: Esc puts it back)' : '(drag to turn, scroll to zoom)';
}
$('print-preview-size').addEventListener('click', () => setPreviewBig(!$('print-preview').classList.contains('big')));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setPreviewBig(false); });

let viewer = null;
function showModel() {
  const m = state.model;
  const el = $('print-preview');
  if (!window.THREE) {
    el.innerHTML = '<div class="empty">The 3D preview needs three.js, which did not load.</div>';
    renderPrintTable();
    return;
  }
  if (!viewer) {
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(2, devicePixelRatio));
    el.prepend(renderer.domElement);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(35, 1, 1, 5000);
    scene.add(new THREE.HemisphereLight(0xffffff, 0x445544, 0.55));
    const sun = new THREE.DirectionalLight(0xffffff, 0.85);
    sun.position.set(-1, 1.2, -1.4); // low from the north-west, like a shaded relief map
    scene.add(sun);
    const controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    viewer = { renderer, scene, camera, controls, mesh: null };
    const size = () => {
      const w = el.clientWidth || 300, h = el.clientHeight || 300;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    new ResizeObserver(size).observe(el);
    size();
    const loop = () => { controls.update(); renderer.render(scene, camera); requestAnimationFrame(loop); };
    loop();
  }
  const shown = previewGeometry(m);
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(shown.pos, 3));
  geom.setAttribute('normal', new THREE.BufferAttribute(shown.nrm, 3));
  geom.setAttribute('color', new THREE.BufferAttribute(shown.colours, 3));
  geom.rotateX(-Math.PI / 2); // STL is z-up, three is y-up: north (+y) becomes -z, away from the camera
  geom.translate(-shown.acrossMm / 2, 0, shown.downMm / 2);
  if (viewer.mesh) { viewer.scene.remove(viewer.mesh); viewer.mesh.geometry.dispose(); }
  viewer.mesh = new THREE.Mesh(geom, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0 }));
  viewer.scene.add(viewer.mesh);
  const w = Math.max(shown.acrossMm, shown.downMm);
  viewer.camera.position.set(0, w * 0.95, w * 1.35);
  viewer.controls.target.set(0, m.set.baseMm + m.reliefMm / 3, 0);
  viewer.controls.update();
  renderPrintTable();
}

/** About this many grid points across a whole set in the preview keeps it near a million triangles. */
const PREVIEW_POINTS = 700;
/** The gap between pieces laid out in the preview, so each one shows. */
const PREVIEW_GAP_MM = 1;

/**
 * What the preview shows: the print, one piece picked from a set, or the
 * whole set laid out. Laid out, a set too fine for the preview shows each
 * piece's ground on a lighter grid, without its buildings or label.
 */
function previewGeometry(m) {
  const view = m.pieces.length > 1 ? $('print-view').value : '0';
  if (view !== 'all') {
    const p = m.pieces[Number(view)];
    return { ...pieceGeometry(p), acrossMm: p.set.widthMm, downMm: p.set.widthMm };
  }
  const { cols, rows, widthMm: w, cells: n } = m.set;
  const lite = Math.min(n, Math.floor(PREVIEW_POINTS / Math.max(cols, rows)));
  const step = w + PREVIEW_GAP_MM;
  const parts = m.pieces.map((p) => {
    const q = lite >= n ? p : {
      ...p, top: 2 * (lite - 1) ** 2, set: { ...p.set, cells: lite }, shore: null, water: null, label: null, buildings: null, roads: null,
      stl: core.terrainStl(core.resampleGrid(p.scaled.mm, n, lite), lite, w, [], null, p.set.cornerMm, p.corners),
    };
    return { ...pieceGeometry(q), x: p.col * step, y: (rows - 1 - p.row) * step };
  });
  const size = parts.reduce((s, p) => s + p.pos.length, 0);
  const pos = new Float32Array(size), nrm = new Float32Array(size), colours = new Float32Array(size);
  let at = 0;
  for (const part of parts) {
    for (let k = 0; k < part.pos.length; k += 3) {
      pos[at + k] = part.pos[k] + part.x;
      pos[at + k + 1] = part.pos[k + 1] + part.y;
      pos[at + k + 2] = part.pos[k + 2];
    }
    nrm.set(part.nrm, at);
    colours.set(part.colours, at);
    at += part.pos.length;
  }
  return { pos, nrm, colours, acrossMm: cols * step - PREVIEW_GAP_MM, downMm: rows * step - PREVIEW_GAP_MM };
}

/** One piece's STL as the preview's points, normals and colours. */
function pieceGeometry(m) {
  const view = new DataView(m.stl);
  const count = view.getUint32(80, true);
  const pos = new Float32Array(count * 9);
  const nrm = new Float32Array(count * 9);
  for (let t = 0, o = 84; t < count; t++, o += 50) {
    for (let k = 0; k < 9; k++) pos[t * 9 + k] = view.getFloat32(o + 12 + k * 4, true);
    for (let v = 0; v < 3; v++) for (let k = 0; k < 3; k++) nrm[t * 9 + v * 3 + k] = view.getFloat32(o + k * 4, true);
  }
  // The sea floor in blue: top-surface vertices below sea level (the top comes first in the STL).
  // The shoreline line dark, lakes and rivers blue like the sea, sunk roads dark grey, sunk tracks in their colour, buildings in grey,
  // then raised roads darker, and raised tracks, written last, in their colour.
  const colours = new Float32Array(count * 9);
  const land = new THREE.Color(0xc9b79c), sea = new THREE.Color(0x6f9bc7), built = new THREE.Color(0x9a9da3), groove = new THREE.Color(0x4a3f33), road = new THREE.Color(0x55595f), trail = new THREE.Color(core.TRACK_COLOUR);
  const n = m.set.cells, step = m.set.widthMm / (n - 1);
  const topVertices = m.top * 3;
  const firstTrack = (count - (m.tracks?.triangles || 0)) * 3;
  const firstRoad = firstTrack - (m.roads?.triangles || 0) * 3;
  const firstBuilt = firstRoad - (m.buildings?.triangles || 0) * 3;
  const gridIndex = (v) => (n - 1 - Math.round(pos[v * 3 + 1] / step)) * n + Math.round(pos[v * 3] / step);
  const onShore = (v) => m.shore[gridIndex(v)];
  const onWater = (v) => m.water.mask[gridIndex(v)];
  const onRoad = (v) => m.roads.mask[gridIndex(v)];
  const onTrack = (v) => m.tracks.mask[gridIndex(v)];
  // a label pocket: a triangle with no point above the pocket's depth, and one off the bed
  const depth = m.label?.depthMm;
  const inPocket = (t) => depth && [0, 1, 2].every((k) => pos[(t * 3 + k) * 3 + 2] <= depth + 1e-4) && [0, 1, 2].some((k) => pos[(t * 3 + k) * 3 + 2] > 1e-4);
  for (let v = 0; v < count * 3; v++) {
    const c = v >= firstTrack ? trail : v >= firstRoad ? road : v >= firstBuilt ? built
      : (m.shore && v < topVertices && onShore(v)) || (v >= topVertices && inPocket(Math.floor(v / 3))) ? groove
      : m.tracks?.mask && v < topVertices && onTrack(v) ? trail
      : m.roads?.mask && v < topVertices && onRoad(v) ? road
      : (m.scaled.seaMm != null && v < topVertices && pos[v * 3 + 2] < m.scaled.seaMm - 1e-3) || (m.water && v < topVertices && onWater(v)) ? sea : land;
    colours[v * 3] = c.r; colours[v * 3 + 1] = c.g; colours[v * 3 + 2] = c.b;
  }
  return { pos, nrm, colours };
}

function renderPrintTable() {
  const m = state.model;
  if (!m) { $('print-table').innerHTML = ''; return; }
  const { set, pieces } = m;
  const split = pieces.length > 1, first = pieces[0], scaled = first.scaled;
  const tallMm = set.baseMm + m.reliefMm;
  const acrossMm = set.widthMm * set.cols, downMm = set.widthMm * set.rows;
  const scale = Math.round((set.sideKm * 1e6) / acrossMm);
  const side = (km) => core.formatSide(km, state.units);
  const ground = split ? `${side(set.sideKm)} × ${side((set.sideKm * set.rows) / set.cols)}`
    : set.shape === 'rectangle' ? `${side(set.sideKm)} × ${side(set.sideKm / set.aspect)} rectangle` : `${side(set.sideKm)} ${set.shape}`;
  const ring = first.outline ? first.outline.ring : [[0, 0], [set.widthMm, set.widthMm]];
  const across = (k) => +(Math.max(...ring.map((p) => p[k])) - Math.min(...ring.map((p) => p[k]))).toFixed(1);
  const corners = set.cornerMm && set.shape !== 'circle' ? `, ${split ? 'outside ' : ''}corners rounded ${set.cornerMm} mm` : '';
  const tallest = pieces.reduce((a, b) => (b.scaled.reliefMm > a.scaled.reliefMm ? b : a));
  const stlMb = pieces.reduce((s, p) => s + p.stl.byteLength, 0) / 1048576;
  const triangles = pieces.reduce((s, p) => s + new DataView(p.stl).getUint32(80, true), 0);
  const rows = [
    ['Ground covered', `${ground}${set.bearing ? `, its top facing ${(set.bearing + 360) % 360}° (${compass(set.bearing)})` : ''}`],
    ['Model', split
      ? `${set.cols} × ${set.rows} pieces of ${set.widthMm} × ${set.widthMm} mm, ${acrossMm} × ${downMm} mm together; the tallest ${tallMm.toFixed(1)} mm (${tallest.name})${corners}`
      : `${across(0)} × ${across(1)} × ${tallMm.toFixed(1)} mm${corners}`],
    ...(split ? [['Base', `${set.baseMm} mm under ${core.formatHeight(m.lowM, state.units)}, the lowest point of the set, on every piece, so their sides meet at the same height`]] : []),
    ['Lowest to highest', `${core.formatHeight(m.lowM, state.units)} to ${core.formatHeight(m.highM, state.units)}`],
    ['Map scale', `1 : ${scale.toLocaleString('en-US')}`],
    ['Height stretch', `× ${set.exaggeration}, so 1 mm of model is ${core.formatHeight(1 / (scaled.mmPerMetre * set.exaggeration), state.units)}${suggestText(m)}`],
    ...(set.seaFloorM > 0 ? [['Sea floor', seaFloorText(set, scaled)]] : []),
    ...(set.shoreMm > 0 ? [['Shoreline', shoreText(set, pieces.some((p) => p.shore.includes(1)))]] : []),
    ...(first.label ? [['Label underneath', `${split ? `On ${first.name}: ` : ''}${labelText(first.label)}`]] : []),
    ...(m.buildings ? [['Buildings', buildingsText(m)]] : []),
    ...(m.roads ? [['Roads', roadsText(m)]] : []),
    ...(m.water ? [['Lakes and rivers', waterText(m)]] : []),
    ...(m.tracks ? [['Tracks', tracksText(m)]] : []),
    ['STL', `${split ? `${pieces.length} files in one ZIP, ` : ''}${stlMb.toFixed(1)} MB, ${triangles.toLocaleString('en-US')} triangles`],
  ];
  $('print-table').innerHTML = `<tbody>${rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('')}</tbody>`;
}

/** The stretch this ground suggests, with a button to use it, or nothing when it is already in use. */
function suggestText({ set, lowM, highM }) {
  // Only the land counts: the sea floor has its own stretch.
  const want = core.suggestStretch(highM - Math.max(lowM, 0), set.sideKm);
  if (want == null) return '';
  if (want === set.exaggeration) return '; the stretch suggested for ground this steep';
  return `; ground this steep suggests × ${want} <button type="button" class="suggest" data-stretch="${want}">Use × ${want}</button>`;
}
$('print-table').addEventListener('click', (e) => {
  const value = Number(e.target.closest('button.suggest')?.dataset.stretch);
  if (!value) return;
  setStretch(value);
  buildModel();
});

/** A bearing as the nearest of the 16 compass points. */
function compass(deg) {
  const names = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  return names[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
}

function seaFloorText(set, scaled) {
  const limit = set.seaFloorM >= 11000 ? 'Full depth' : `Down to ${core.formatHeight(set.seaFloorM, state.units)}`;
  const stretch = `× ${set.depthStretch}, so 1 mm of model is ${core.formatHeight(1 / (scaled.mmPerMetre * set.depthStretch), state.units)}`;
  const level = scaled.seaMm != null ? `sea level is ${scaled.seaMm.toFixed(1)} mm up` : 'nothing here is below sea level';
  return `${limit} at ${stretch}; ${level}`;
}

function shoreText(set, coast) {
  const what = set.shoreRidge ? 'ridge' : 'groove';
  if (!coast) return `No coast in this print, so no ${what}`;
  const wide = set.widthMm / (set.cells - 1);
  return set.shoreRidge
    ? `A ridge ${set.shoreMm} mm high along the coast, ${wide.toFixed(2)} mm from each side to its top`
    : `A groove ${set.shoreMm} mm deep along the coast, ${wide.toFixed(2)} mm from each side to its bottom`;
}

function labelText(label) {
  if (label.why) return `None: ${label.why}`;
  return `${label.lines.map(escapeHtml).join(' / ')} under a north arrow, letters ${(label.pxMm * 7).toFixed(1)} mm tall, ${label.depthMm.toFixed(1)} mm deep`;
}

function buildingsText({ buildings: b, set }) {
  if (!b.count) return 'None in OpenStreetMap here';
  const fmt = (v) => v.toLocaleString('en-US');
  const rest = b.count - b.tagged;
  const parts = [`${fmt(b.count)} from OpenStreetMap, the tallest ${core.formatHeight(b.tallestM, state.units)}`,
    rest ? `${fmt(rest)} with no height there, so ${core.formatHeight(set.buildingDefaultM, state.units)}` : 'every one with its own height'];
  if (b.inData) parts.push(`${fmt(b.inData)} already in the elevation data, flattened under`);
  if (b.liftM > core.LIFTED_M) parts.push(`the elevation data holds the city, about ${core.formatHeight(b.liftM, state.units)} up under the buildings`);
  return parts.join('; ');
}

function roadsText({ roads: r, set }) {
  if (!r.count) return 'No road of the classes printed in OpenStreetMap here';
  const length = (km) => (state.units === 'imperial' ? `${(km / 1.609344).toFixed(1)} mi` : `${km.toFixed(1)} km`);
  return Object.entries(core.ROAD_CLASSES).filter(([cls]) => r.km[cls])
    .map(([cls, c]) => `${cls} ${length(r.km[cls])}, ${c.widthMm} mm wide, ${levelText(set.roadMm[cls]).toLowerCase()}`).join('; ');
}

function waterText(m) {
  const { lakesKm2, wideKm2, riverKm } = m.water, level = m.set.waterMm;
  const area = (km2) => (state.units === 'imperial' ? `${(km2 / 2.589988).toFixed(2)} sq mi` : `${km2.toFixed(2)} km²`);
  const length = state.units === 'imperial' ? `${(riverKm / 1.609344).toFixed(1)} mi` : `${riverKm.toFixed(1)} km`;
  const parts = [lakesKm2 >= 1e-9 && `${area(lakesKm2)} of lake ${levelText(level.lakes).toLowerCase()}`,
    wideKm2 >= 1e-9 && `${area(wideKm2)} of wide river ${levelText(level.wide).toLowerCase()}`,
    riverKm >= 0.05 && `${length} of narrow river ${levelText(level.narrow).toLowerCase()}`].filter(Boolean);
  return parts.length ? parts.join('; ') : 'None of the kinds printed in OpenStreetMap here, or none big enough to show';
}

function tracksText({ tracks: t, set }) {
  const length = (km) => (state.units === 'imperial' ? `${(km / 1.609344).toFixed(1)} mi` : `${km.toFixed(1)} km`);
  return set.tracks.map((track, k) => `${escapeHtml(track.name)}: ${t.km[k] < 0.005 ? 'not on the print'
    : `${length(t.km[k])}, ${core.TRACK_WIDTH_MM} mm wide, ${levelText(track.levelMm).toLowerCase()}`}`).join('; ');
}

/** A print's file name; a set of pieces adds its layout, and one piece of it its name. */
function printFileName(m, ext, piece = '') {
  const slug = m.centre.name.split(',')[0].toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'print';
  const shape = m.set.shape && m.set.shape !== 'square' ? `-${m.set.shape}` : '';
  const layout = m.set.cols * m.set.rows > 1 ? `-${m.set.cols}x${m.set.rows}` : '';
  return `reach-${slug}-${m.set.sideKm}km${shape}${layout}${piece ? `-${piece}` : ''}.${ext}`;
}

/** A print in pieces downloads as one ZIP of their STLs. */
const stlFileName = (m) => printFileName(m, m.pieces.length > 1 ? 'zip' : 'stl');

$('print-stl').addEventListener('click', () => {
  const m = state.model;
  if (!m) return;
  if (m.pieces.length === 1) {
    download(stlFileName(m), m.pieces[0].stl, 'model/stl');
    return;
  }
  const zip = core.zipFiles(m.pieces.map((p) => ({ name: printFileName(m, 'stl', p.name), data: new Uint8Array(p.stl) })));
  download(stlFileName(m), zip, 'application/zip');
});

$('print-kml').addEventListener('click', () => {
  const m = state.model;
  if (!m) return;
  const triangles = m.pieces.reduce((s, p) => s + new DataView(p.stl).getUint32(80, true), 0);
  const kml = core.printKml({
    centre: m.centre,
    set: m.set,
    // a set's label differs piece to piece, so only a print in one piece keeps it
    model: { zoom: m.zoom, pixelM: m.pixel, seaZoom: m.seaZoom, seaPixelM: m.seaPixel, lowM: m.lowM, highM: m.highM, reliefMm: m.reliefMm, triangles, buildings: m.buildings, roads: m.roads, water: m.water && { lakesKm2: m.water.lakesKm2, wideKm2: m.water.wideKm2, riverKm: m.water.riverKm, readAt: m.water.readAt }, label: m.pieces.length === 1 ? m.pieces[0].label : null },
    stlFile: stlFileName(m),
  });
  download(printFileName(m, 'kml'), kml, 'application/vnd.google-earth.kml+xml');
});

/** Selects value in a <select>, adding it as an option when a saved file asks for one the list lacks. */
function choose(id, value, label) {
  const el = $(id);
  if (![...el.options].some((o) => Number(o.value) === value)) el.append(new Option(label, value));
  el.value = [...el.options].find((o) => Number(o.value) === value).value;
}

/**
 * The map layer on show, cropped to the print, as a PNG: tiles fetched at the
 * most detailed zoom that keeps the print within 2,048 px. A turned print's
 * map is turned to match, its top at the image's top, and a shape other than
 * a square leaves the image clear outside it.
 */
$('print-map').addEventListener('click', async () => {
  const layer = map.hasLayer(streets) ? streets : topo;
  const set = printSettings();
  // A set of pieces is one image of the whole set, from the frame its pieces share.
  const plan = core.piecePlan(state.print, set), frame = plan.frame;
  const lowY = plan.bottomMm, highY = plan.bottomMm + plan.downMm, W = plan.acrossMm;
  const b = core.lonLatBounds([[0, lowY], [W, lowY], [W, highY], [0, highY]].map(([x, y]) => frame.toLonLat(x, y)));
  const z = core.mapImageZoom(b, layer.options.maxZoom);
  const box = core.pixelBox(b, z);
  $('print-map').disabled = true;
  try {
    const tiles = new OffscreenCanvas(Math.round(box.width), Math.round(box.height));
    const tctx = tiles.getContext('2d');
    let done = 0;
    await Promise.all(box.tiles.map((t, k) => limited(async () => {
      const url = L.Util.template(layer._url, { s: 'abc'[k % 3], z: t.z, x: t.x, y: t.y });
      const res = await fetch(url);
      if (!res.ok) throw new Error(`map tile ${t.z}/${t.x}/${t.y}: ${res.status}`);
      tctx.drawImage(await createImageBitmap(await res.blob()), t.left - box.left, t.top - box.top);
      progress('print', `Fetching the map: tile ${++done} of ${box.tiles.length}`, done / box.tiles.length);
    })));
    // Where the model's corners fall among the tiles: its top left, top right and bottom left.
    const at = (x, y) => { const g = frame.toLonLat(x, y), p = core.lonLatToTile(g.lon, g.lat, z); return [p.x * 256 - box.left, p.y * 256 - box.top]; };
    const [o, u, v] = [at(0, highY), at(W, highY), at(0, lowY)];
    const w = Math.round(Math.hypot(u[0] - o[0], u[1] - o[1])), h = Math.round(Math.hypot(v[0] - o[0], v[1] - o[1]));
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d');
    ctx.save();
    if (set.shape !== 'square') {
      const { ring } = core.shapeOutline(set.shape, W, set);
      ctx.beginPath();
      ring.forEach(([x, y], k) => ctx[k ? 'lineTo' : 'moveTo']((x / W) * w, ((W - y) / W) * h));
      ctx.closePath();
      ctx.clip();
    }
    // The image's pixels to the tiles' is the turn; drawing the tiles takes its inverse.
    ctx.setTransform(new DOMMatrix([(u[0] - o[0]) / w, (u[1] - o[1]) / w, (v[0] - o[0]) / h, (v[1] - o[1]) / h, o[0], o[1]]).inverse());
    ctx.drawImage(tiles, 0, 0);
    ctx.restore();
    // A set of pieces shows where it splits, dashed like the outline's seams on the map.
    if (plan.pieces.length > 1) {
      const pw = (set.widthMm / W) * w, ph = h / set.rows;
      ctx.save();
      ctx.strokeStyle = cssVar('--accent');
      ctx.lineWidth = Math.max(2, Math.round(w / 500));
      ctx.setLineDash([ctx.lineWidth * 4, ctx.lineWidth * 4]);
      ctx.beginPath();
      for (let c = 1; c < set.cols; c++) { ctx.moveTo(c * pw, 0); ctx.lineTo(c * pw, h); }
      for (let r = 1; r < set.rows; r++) { ctx.moveTo(0, r * ph); ctx.lineTo(w, r * ph); }
      ctx.stroke();
      ctx.restore();
    }
    // The tiles' licence asks for the credit on the image.
    const credit = layer.options.credit;
    ctx.font = `${Math.max(11, Math.round(w / 110))}px sans-serif`;
    const pad = 4, tw = ctx.measureText(credit).width, th = parseInt(ctx.font, 10);
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.fillRect(w - tw - pad * 2, h - th - pad * 2, tw + pad * 2, th + pad * 2);
    ctx.fillStyle = '#333';
    ctx.textBaseline = 'bottom';
    ctx.fillText(credit, w - tw - pad, h - pad);
    const name = printFileName({ centre: state.print, set }, 'png').replace(/\.png$/, '-map.png');
    download(name, await canvas.convertToBlob({ type: 'image/png' }), 'image/png');
    status('print', `Saved ${name}: ${w} × ${h} px, about ${(set.sideKm * 1000 / w).toFixed(1)} m per pixel.`);
  } catch (err) {
    status('print', `Couldn't make the map image (${err.message}).`, true);
  } finally {
    $('print-map').disabled = false;
  }
});

$('print-open').addEventListener('click', () => $('print-file').click());
$('print-file').addEventListener('change', async () => {
  const file = $('print-file').files[0];
  $('print-file').value = '';
  if (!file) return;
  let saved;
  try {
    saved = core.parsePrintKml(await file.text());
  } catch (err) {
    status('print', `Couldn't open ${file.name}: ${err.message}.`, true);
    return;
  }
  const { centre, set } = saved;
  addSide(set.sideKm);
  lastSide = $('print-side').value;
  $('print-side-field').hidden = !$('print-side').selectedOptions[0].dataset.own;
  choose('print-width', set.widthMm, `${set.widthMm} mm`);
  labelPitches();
  // A file whose count no detail here makes keeps it, as the pitch that makes exactly that count.
  const pitch = core.gridCells(set.widthMm, set.pitchMm) === set.cells ? set.pitchMm : set.widthMm / (set.cells - 1);
  choose('print-pitch', pitch, `${set.cells} × ${set.cells}, from the file`);
  choose('print-base', set.baseMm, `${set.baseMm} mm`);
  setStretch(set.exaggeration);
  choose('print-sea', set.seaFloorM, `Down to ${core.formatHeight(set.seaFloorM, state.units)}`);
  const depth = $('print-depth');
  if (set.depthStretch > Number(depth.max)) depth.max = String(set.depthStretch);
  depth.value = String(set.depthStretch);
  showSeaControls();
  const shoreValue = set.shoreMm ? `${set.shoreRidge ? 'ridge' : 'groove'}-${set.shoreMm}` : '0';
  if (![...$('print-shore').options].some((o) => o.value === shoreValue)) {
    $('print-shore').append(new Option(set.shoreRidge ? `Ridge ${set.shoreMm} mm high` : `Groove ${set.shoreMm} mm deep`, shoreValue));
  }
  $('print-shore').value = shoreValue;
  $('print-shore-hint').hidden = set.shoreMm === 0;
  $('print-text').value = set.labelText;
  $('print-label').value = set.labelText.trim() ? (set.label ? 'both' : 'text') : set.label ? 'on' : 'none';
  showLabelControls();
  choose('print-corner', set.cornerMm, set.cornerMm ? `Rounded ${set.cornerMm} mm` : 'Square');
  $('print-shape').value = set.shape;
  choose('print-aspect', set.aspect, `${set.aspect} : 1`);
  const layout = `${set.cols}x${set.rows}`;
  if (![...$('print-pieces').options].some((o) => o.value === layout)) $('print-pieces').append(new Option(`${set.cols} × ${set.rows}`, layout));
  $('print-pieces').value = layout;
  $('print-turn').value = String(Math.max(-90, Math.min(90, set.bearing)));
  showShapeControls();
  $('print-buildings').value = set.buildings ? 'osm' : 'none';
  choose('print-default', set.buildingDefaultM, core.formatHeight(set.buildingDefaultM, state.units));
  showBuildingControls();
  // a file with every class or kind left out keeps the selects at their defaults
  $('print-roads').value = core.anyLevel(set.roadMm) ? 'osm' : 'none';
  if (core.anyLevel(set.roadMm)) for (const [cls, mm] of Object.entries(set.roadMm)) choose(`print-road-${cls}`, mm, levelText(mm));
  showRoadControls();
  $('print-water').value = core.anyLevel(set.waterMm) ? 'osm' : 'none';
  if (core.anyLevel(set.waterMm)) for (const [kind, mm] of Object.entries(set.waterMm)) choose(`print-water-${kind}`, mm, levelText(mm));
  showWaterControls();
  // the file's tracks take the place of the ones imported here, so the model is the file's
  state.tracks = set.tracks.map((t) => ({ ...t, id: nextTrack++ }));
  saveTracks();
  renderTracks();
  setPrintCentre(centre);
  status('print', `Opened ${file.name}. Building the same model.`);
});


// ---------- small helpers ----------

function status(which, text, error = false) {
  const el = $(`${which}-status`);
  el.className = error ? 'status error' : 'status';
  el.textContent = text;
}

function progress(which, text, fraction) {
  const el = $(`${which}-status`);
  el.className = 'status';
  el.innerHTML = `${escapeHtml(text)}<div class="progress"><div style="width:${Math.round(fraction * 100)}%"></div></div>`;
}

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function fmtNum(v, exact) {
  if (v == null) return '-';
  const abs = Math.abs(v);
  const digits = exact ? (abs < 10 ? 1 : 0) : (abs < 10 && abs % 1 ? 1 : 0);
  return v.toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: 0 });
}

function escapeHtml(s) {
  return String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]);
}

// Re-colour on a theme change, since series colours come from CSS variables.
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { renderHeight(); renderDrive(); });

// ---------- start ----------

searchBox('place-search', 'place-results', addPlace);
searchBox('origin-search', 'origin-results', setOrigin);
searchBox('print-search', 'print-results', setPrintCentre);
setUnits(state.units);
setPrintTab(state.printTab);
setTab(state.tab);
measure();

// For poking at a run from the browser console.
window.reach = { state, map, core };
