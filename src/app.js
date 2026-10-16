// app.js - Reach's page: the map, the two tools and their network calls.
// The maths lives in core.js; this file fetches, wires and draws.
import * as core from './core.js';
import { lineChart, focusSeries } from './chart.js';

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
      limits: $('limits').value,
      detail: $('detail').value,
    }));
  } catch { /* storage blocked: settings just aren't remembered */ }
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
  model: null,
  busy: false,
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

map.on('click', async (e) => {
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

/** Elevations of one tile as a Float32Array of 256 x 256 metres. */
function elevationTile(z, x, y) {
  const key = `${z}/${x}/${y}`;
  if (!tileCache.has(key)) {
    const p = limited(async () => {
      const res = await fetch(TERRARIUM(z, x, y));
      if (!res.ok) throw new Error(`elevation tile ${key}: ${res.status}`);
      const bmp = await createImageBitmap(await res.blob());
      const canvas = new OffscreenCanvas(256, 256);
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(bmp, 0, 0);
      const px = ctx.getImageData(0, 0, 256, 256).data;
      const out = new Float32Array(256 * 256);
      for (let k = 0; k < out.length; k++) out[k] = core.terrariumElevation(px[k * 4], px[k * 4 + 1], px[k * 4 + 2]);
      return core.despike(out);
    });
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
  return {
    sideKm: Number($('print-side').value),
    widthMm: Number($('print-width').value),
    cells: Number($('print-cells').value),
    exaggeration: Number($('print-exag').value),
    baseMm: Number($('print-base').value),
    seaFloorM: Number($('print-sea').value),
    depthStretch: Number($('print-depth').value),
    buildings: $('print-buildings').value === 'osm' && Number($('print-side').value) <= core.BUILDINGS_MAX_KM,
    buildingDefaultM: Number($('print-default').value),
  };
}

function setPrintCentre(place) {
  state.print = place;
  saveSettings();
  drawPrintSquare(true);
  buildModel();
}

function drawPrintSquare(fit) {
  printLayer.clearLayers();
  $('print-name').textContent = `Centred on ${state.print.name}.`;
  const b = core.squareBounds(state.print, Number($('print-side').value));
  const corners = [[b.south, b.west], [b.north, b.east]];
  // A white casing under the line keeps the square readable over busy city maps.
  L.rectangle(corners, { color: '#ffffff', weight: 7, opacity: 0.9, fill: false, interactive: false }).addTo(printLayer);
  const rect = L.rectangle(corners, { color: cssVar('--accent'), weight: 3, fill: true, fillOpacity: 0.06, interactive: false });
  rect.addTo(printLayer);
  // The centre, so a small nudge is a click just beside it. Not interactive: a click on it still re-centres.
  L.circleMarker([state.print.lat, state.print.lon], { radius: 5, color: '#fff', weight: 2, fillColor: cssVar('--accent'), fillOpacity: 1, interactive: false })
    .addTo(printLayer);
  if (fit) map.fitBounds(rect.getBounds().pad(0.6));
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
 * The print square's n x n grid of heights (row 0 north), sampled from the
 * zoom-z tiles. Returns null when a newer build has started meanwhile.
 */
async function readPrintGrid(centre, set, z, run, what) {
  const list = core.tilesForRadius(centre, set.sideKm * 0.71, z);
  const tiles = new Map();
  let done = 0;
  await Promise.all(list.map(async (t) => {
    tiles.set(`${t.z}/${t.x}/${t.y}`, await elevationTile(t.z, t.x, t.y));
    if (run === modelRun) progress('print', `Reading the ${what}: tile ${++done} of ${list.length}`, done / list.length);
  }));
  if (run !== modelRun) return null;
  const b = core.squareBounds(centre, set.sideKm);
  const at = sampler(tiles, z);
  const n = set.cells;
  const heights = new Array(n * n);
  for (let j = 0; j < n; j++) {
    const lat = b.north - (j / (n - 1)) * (b.north - b.south);
    for (let i = 0; i < n; i++) {
      const lon = b.west + (i / (n - 1)) * (b.east - b.west);
      const p = core.lonLatToTile(lon, lat, z);
      heights[j * n + i] = at(p.x * 256, p.y * 256);
    }
  }
  return heights;
}

const osmCache = new Map();
/** Every building in a lon/lat box from OpenStreetMap, through Overpass. Kept for the session. */
function osmBuildings(bounds) {
  const query = core.overpassBuildingsQuery(bounds);
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

let modelRun = 0;
async function buildModel() {
  const run = ++modelRun;
  const set = printSettings();
  const centre = state.print;
  $('print-run').disabled = true;
  try {
    const z = core.printZoom(centre, set.sideKm, set.cells);
    let heights = await readPrintGrid(centre, set, z, run, 'terrain');
    if (!heights) return;
    // Past zoom 10 the tiles have no sea floor, so it comes from zoom 10, under the detailed land.
    const seaZoom = set.seaFloorM > 0 ? Math.min(z, core.SEA_FLOOR_ZOOM) : null;
    if (seaZoom != null && seaZoom < z) {
      const floor = await readPrintGrid(centre, set, seaZoom, run, 'sea floor');
      if (!floor) return;
      heights = core.withSeaFloor(heights, floor);
    }
    const n = set.cells;
    const pixel = core.pixelMetres(centre.lat, z);
    let placed = null, buildings = null, missed = '';
    if (set.buildings) {
      status('print', 'Fetching the buildings from OpenStreetMap…');
      const bounds = core.squareBounds(centre, set.sideKm);
      let reply = null;
      try {
        reply = await osmBuildings(bounds);
      } catch (err) {
        missed = ` Couldn't fetch the buildings (${err.message}), so this is the terrain alone.`;
      }
      if (run !== modelRun) return;
      if (reply) {
        const { osm, readAt } = reply;
        const footprints = core.buildingFootprints(osm, bounds, set.widthMm);
        // Around a building the terrain may hold, its surroundings are read a pixel and a half out, clear of the blur.
        placed = core.placeBuildings(footprints, heights, n, { ...set, padM: 1.5 * pixel, defaultM: set.buildingDefaultM });
        heights = placed.heights;
        const list = placed.buildings;
        buildings = {
          count: list.length, tagged: list.filter((b) => b.tagged).length, inData: list.filter((b) => b.inData).length,
          tallestM: list.reduce((m, b) => Math.max(m, b.heightM), 0), liftM: placed.liftM, readAt, triangles: 0,
        };
      }
    }
    const scaled = core.printHeights(heights, set);
    const extra = placed ? core.buildingTriangles(placed.buildings, scaled.mm, n, { ...set, ...scaled }) : [];
    if (buildings) buildings.triangles = extra.length / 3;
    const stl = core.terrainStl(scaled.mm, n, set.widthMm, extra);
    state.model = {
      stl, scaled, set, centre, zoom: z, pixel, buildings,
      seaZoom, seaPixel: seaZoom == null ? null : core.pixelMetres(centre.lat, seaZoom),
    };
    showModel();
    const sea = seaZoom != null && seaZoom < z ? `, the sea floor at ${Math.round(state.model.seaPixel)} m,` : '';
    const lifted = buildings?.liftM > core.LIFTED_M
      ? ` The elevation data here holds the buildings: the ground under them reads about ${core.formatHeight(buildings.liftM, state.units)} above the open ground nearby, so the land prints lumpy under them.`
      : '';
    status('print', `Terrain read at ${Math.round(pixel)} m per pixel${sea} and sampled on a ${n} × ${n} grid.${lifted}${missed}`, Boolean(missed));
    $('print-stl').disabled = false;
    $('print-kml').disabled = false;
  } catch (err) {
    status('print', `Couldn't build the model (${err.message}).`, true);
  } finally {
    if (run === modelRun) $('print-run').disabled = false;
  }
}
$('print-run').addEventListener('click', buildModel);
$('print-side').addEventListener('change', () => { drawPrintSquare(true); showBuildingControls(); buildModel(); });
$('print-exag').addEventListener('input', () => { $('print-exag-value').textContent = `× ${$('print-exag').value}`; });
$('print-exag').addEventListener('change', buildModel);
for (const id of ['print-width', 'print-cells', 'print-base', 'print-default']) $(id).addEventListener('change', buildModel);
$('print-exag-value').textContent = `× ${$('print-exag').value}`;
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
    el.innerHTML = '';
    el.append(renderer.domElement);
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
  const view = new DataView(m.stl);
  const count = view.getUint32(80, true);
  const pos = new Float32Array(count * 9);
  const nrm = new Float32Array(count * 9);
  for (let t = 0, o = 84; t < count; t++, o += 50) {
    for (let k = 0; k < 9; k++) pos[t * 9 + k] = view.getFloat32(o + 12 + k * 4, true);
    for (let v = 0; v < 3; v++) for (let k = 0; k < 3; k++) nrm[t * 9 + v * 3 + k] = view.getFloat32(o + k * 4, true);
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geom.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  // The sea floor in blue: top-surface vertices below sea level (the top comes first in the STL).
  // Buildings, written last, in grey.
  const colours = new Float32Array(count * 9);
  const land = new THREE.Color(0xc9b79c), sea = new THREE.Color(0x6f9bc7), built = new THREE.Color(0x9a9da3);
  const topVertices = 2 * (m.set.cells - 1) ** 2 * 3;
  const firstBuilt = (count - (m.buildings?.triangles || 0)) * 3;
  for (let v = 0; v < count * 3; v++) {
    const c = v >= firstBuilt ? built
      : m.scaled.seaMm != null && v < topVertices && pos[v * 3 + 2] < m.scaled.seaMm - 1e-3 ? sea : land;
    colours[v * 3] = c.r; colours[v * 3 + 1] = c.g; colours[v * 3 + 2] = c.b;
  }
  geom.setAttribute('color', new THREE.BufferAttribute(colours, 3));
  geom.rotateX(-Math.PI / 2); // STL is z-up, three is y-up: north (+y) becomes -z, away from the camera
  geom.translate(-m.set.widthMm / 2, 0, m.set.widthMm / 2);
  if (viewer.mesh) { viewer.scene.remove(viewer.mesh); viewer.mesh.geometry.dispose(); }
  viewer.mesh = new THREE.Mesh(geom, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0 }));
  viewer.scene.add(viewer.mesh);
  const w = m.set.widthMm;
  viewer.camera.position.set(0, w * 0.95, w * 1.35);
  viewer.controls.target.set(0, m.set.baseMm + m.scaled.reliefMm / 3, 0);
  viewer.controls.update();
  renderPrintTable();
}

function renderPrintTable() {
  const m = state.model;
  if (!m) { $('print-table').innerHTML = ''; return; }
  const { set, scaled } = m;
  const tallMm = set.baseMm + scaled.reliefMm;
  const scale = Math.round((set.sideKm * 1e6) / set.widthMm);
  const rows = [
    ['Ground covered', `${core.formatDistance(set.sideKm, state.units)} square`],
    ['Model', `${set.widthMm} × ${set.widthMm} × ${tallMm.toFixed(1)} mm`],
    ['Lowest to highest', `${core.formatHeight(scaled.lowM, state.units)} to ${core.formatHeight(scaled.highM, state.units)}`],
    ['Map scale', `1 : ${scale.toLocaleString('en-US')}`],
    ['Height stretch', `× ${set.exaggeration}, so 1 mm of model is ${core.formatHeight(1 / (scaled.mmPerMetre * set.exaggeration), state.units)}`],
    ...(set.seaFloorM > 0 ? [['Sea floor', seaFloorText(set, scaled)]] : []),
    ...(m.buildings ? [['Buildings', buildingsText(m)]] : []),
    ['STL', `${(m.stl.byteLength / 1048576).toFixed(1)} MB, ${new DataView(m.stl).getUint32(80, true).toLocaleString('en-US')} triangles`],
  ];
  $('print-table').innerHTML = `<tbody>${rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('')}</tbody>`;
}

function seaFloorText(set, scaled) {
  const limit = set.seaFloorM >= 11000 ? 'Full depth' : `Down to ${core.formatHeight(set.seaFloorM, state.units)}`;
  const stretch = `× ${set.depthStretch}, so 1 mm of model is ${core.formatHeight(1 / (scaled.mmPerMetre * set.depthStretch), state.units)}`;
  const level = scaled.seaMm != null ? `sea level is ${scaled.seaMm.toFixed(1)} mm up` : 'nothing here is below sea level';
  return `${limit} at ${stretch}; ${level}`;
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

function printFileName(m, ext) {
  const slug = m.centre.name.split(',')[0].toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'print';
  return `reach-${slug}-${m.set.sideKm}km.${ext}`;
}

$('print-stl').addEventListener('click', () => {
  const m = state.model;
  if (!m) return;
  download(printFileName(m, 'stl'), m.stl, 'model/stl');
});

$('print-kml').addEventListener('click', () => {
  const m = state.model;
  if (!m) return;
  const kml = core.printKml({
    centre: m.centre,
    set: m.set,
    model: { zoom: m.zoom, pixelM: m.pixel, seaZoom: m.seaZoom, seaPixelM: m.seaPixel, lowM: m.scaled.lowM, highM: m.scaled.highM, reliefMm: m.scaled.reliefMm, triangles: new DataView(m.stl).getUint32(80, true), buildings: m.buildings },
    stlFile: printFileName(m, 'stl'),
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
 * The map layer on show, cropped to the print square, as a PNG: tiles fetched
 * at the most detailed zoom that keeps the square within 2,048 px.
 */
$('print-map').addEventListener('click', async () => {
  const layer = map.hasLayer(streets) ? streets : topo;
  const set = printSettings();
  const b = core.squareBounds(state.print, set.sideKm);
  const z = core.mapImageZoom(b, layer.options.maxZoom);
  const box = core.pixelBox(b, z);
  const w = Math.round(box.width), h = Math.round(box.height);
  $('print-map').disabled = true;
  try {
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d');
    let done = 0;
    await Promise.all(box.tiles.map((t, k) => limited(async () => {
      const url = L.Util.template(layer._url, { s: 'abc'[k % 3], z: t.z, x: t.x, y: t.y });
      const res = await fetch(url);
      if (!res.ok) throw new Error(`map tile ${t.z}/${t.x}/${t.y}: ${res.status}`);
      ctx.drawImage(await createImageBitmap(await res.blob()), t.left - box.left, t.top - box.top);
      progress('print', `Fetching the map: tile ${++done} of ${box.tiles.length}`, done / box.tiles.length);
    })));
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
  choose('print-side', set.sideKm, `${set.sideKm} km`);
  choose('print-width', set.widthMm, `${set.widthMm} mm`);
  choose('print-cells', set.cells, `${set.cells} × ${set.cells}`);
  choose('print-base', set.baseMm, `${set.baseMm} mm`);
  const exag = $('print-exag');
  if (set.exaggeration > Number(exag.max)) exag.max = String(set.exaggeration);
  exag.value = String(set.exaggeration);
  $('print-exag-value').textContent = `× ${exag.value}`;
  choose('print-sea', set.seaFloorM, `Down to ${core.formatHeight(set.seaFloorM, state.units)}`);
  const depth = $('print-depth');
  if (set.depthStretch > Number(depth.max)) depth.max = String(set.depthStretch);
  depth.value = String(set.depthStretch);
  showSeaControls();
  $('print-buildings').value = set.buildings ? 'osm' : 'none';
  choose('print-default', set.buildingDefaultM, core.formatHeight(set.buildingDefaultM, state.units));
  showBuildingControls();
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
setTab(state.tab);
measure();

// For poking at a run from the browser console.
window.reach = { state, map, core };
