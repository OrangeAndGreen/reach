// core.js - the pure part of Reach: tile maths, distance, height profiles,
// drive-time grids, and the KML/CSV writers. No DOM, no network, so every
// function here runs under `node --test`.

import earcut from './earcut.js';

export const EARTH_KM = 6371.0088;
const RAD = Math.PI / 180;

// ---------- distance ----------

/** Great-circle distance in km between two {lat, lon}. */
export function haversineKm(a, b) {
  const dLat = (b.lat - a.lat) * RAD;
  const dLon = (b.lon - a.lon) * RAD;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(s)));
}

/**
 * km per degree of longitude at a latitude, and per degree of latitude, on the
 * same sphere as haversineKm so the two always agree.
 */
export function kmPerDegree(lat) {
  const perDeg = EARTH_KM * RAD;
  return { lon: perDeg * Math.cos(lat * RAD), lat: perDeg };
}

// ---------- web mercator tiles ----------

/** Fractional tile coordinates of a point at zoom z. */
export function lonLatToTile(lon, lat, z) {
  const n = 2 ** z;
  const clamped = Math.max(-85.0511, Math.min(85.0511, lat));
  const x = ((lon + 180) / 360) * n;
  const r = clamped * RAD;
  const y = ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n;
  return { x, y };
}

/** The lon/lat of fractional tile coordinates at zoom z. */
export function tileToLonLat(x, y, z) {
  const n = 2 ** z;
  const lon = (x / n) * 360 - 180;
  const lat = Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) / RAD;
  return { lon, lat };
}

/** Every tile at zoom z that touches the circle of radiusKm around center. */
export function tilesForRadius(center, radiusKm, z) {
  const deg = kmPerDegree(center.lat);
  const dLat = radiusKm / deg.lat;
  const dLon = Math.min(180, radiusKm / Math.max(deg.lon, 1e-6));
  const nw = lonLatToTile(center.lon - dLon, Math.min(85, center.lat + dLat), z);
  const se = lonLatToTile(center.lon + dLon, Math.max(-85, center.lat - dLat), z);
  const n = 2 ** z;
  const tiles = [];
  const x0 = Math.floor(nw.x), x1 = Math.floor(se.x);
  const y0 = Math.max(0, Math.floor(nw.y)), y1 = Math.min(n - 1, Math.floor(se.y));
  const seen = new Set();
  for (let x = x0; x <= x1; x++) {
    const wx = ((x % n) + n) % n; // wraps across the date line
    if (seen.has(wx)) continue;
    seen.add(wx);
    for (let y = y0; y <= y1; y++) tiles.push({ x: wx, y, z });
  }
  return tiles;
}

/**
 * The most detailed zoom whose tiles over the circle stay within maxTiles.
 * Low zooms are averaged down, so the highest affordable zoom finds the
 * truest peaks.
 */
export function pickZoom(center, radiusKm, maxTiles = 120, minZoom = 3, maxZoom = 12) {
  for (let z = maxZoom; z > minZoom; z--) {
    if (tilesForRadius(center, radiusKm, z).length <= maxTiles) return z;
  }
  return minZoom;
}

/**
 * Elevation in metres from one pixel of a Terrarium-encoded tile, or NaN for a
 * height no place on Earth has. The tiles mark missing data with white pixels,
 * which decode to 32,767 m, and they come in patches, not lone pixels.
 */
export function terrariumElevation(r, g, b) {
  const m = r * 256 + g + b / 256 - 32768;
  return m > 8900 || m < -11100 ? NaN : m;
}

/**
 * Removes single-pixel glitches from a tile of elevations. The terrain tiles
 * carry the odd spike (2,375 m in the shallows off Cuba, beside 0-12 m
 * water), and a "highest point" tool finds every one of them. A pixel that
 * stands more than its own height clear of the third-highest value in its
 * 3x3 block (and at least 60 m) is replaced by that third-highest value. Real
 * peaks pass, because their neighbours are high too. The same test runs
 * across each pixel's left and right neighbours and its upper and lower ones,
 * which catches one-pixel streaks (181 m at the Port Everglades channel).
 * A missing (NaN) pixel takes the highest valid value around it, or 0 when
 * there is none. The block test also runs the other way up, for pits: where
 * the land and sea-floor sources meet, the odd pixel drops thousands of
 * metres below its neighbours (-4,348 m beside 4 m of beach at Monterey).
 * Pits can't change a highest point, so only the sea floor sees this.
 */
export function despike(elev, size = 256) {
  const out = Float32Array.from(elev);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // The three highest values in the 3x3 block, kept by hand: this runs per pixel.
      let a = -Infinity, b = -Infinity, c = -Infinity, n = 0;
      let la = Infinity, lb = Infinity, lc = Infinity; // and the three lowest
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= size) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= size) continue;
          const v = elev[yy * size + xx];
          if (Number.isNaN(v)) continue;
          n++;
          if (v > a) { c = b; b = a; a = v; } else if (v > b) { c = b; b = v; } else if (v > c) c = v;
          if (v < la) { lc = lb; lb = la; la = v; } else if (v < lb) { lc = lb; lb = v; } else if (v < lc) lc = v;
        }
      }
      const e = elev[y * size + x];
      if (Number.isNaN(e)) { out[y * size + x] = n ? a : 0; continue; }
      const spike = (ref) => ref > -Infinity && e - ref > Math.max(60, Math.abs(ref));
      const third = n >= 3 ? c : b;
      if (spike(third)) { out[y * size + x] = third; continue; }
      const thirdLow = n >= 3 ? lc : lb;
      if (thirdLow < Infinity && thirdLow - e > Math.max(60, Math.abs(thirdLow))) { out[y * size + x] = thirdLow; continue; }
      const at = (xx, yy) => (xx < 0 || yy < 0 || xx >= size || yy >= size ? NaN : elev[yy * size + xx]);
      for (const [p, q] of [[at(x - 1, y), at(x + 1, y)], [at(x, y - 1), at(x, y + 1)]]) {
        if (Number.isNaN(p) || Number.isNaN(q)) continue;
        const ref = Math.max(p, q);
        if (spike(ref)) { out[y * size + x] = ref; break; }
      }
    }
  }
  return out;
}

/** Ground size of one pixel of a 256px tile, in metres. */
export function pixelMetres(lat, z) {
  return (40075016.686 * Math.cos(lat * RAD)) / (256 * 2 ** z);
}

// ---------- distance-to-height profile ----------

/**
 * Collects the highest ground in each distance ring around center. Feed it
 * every DEM pixel with add(); read the result with finish().
 */
export function makeProfile(center, radiusKm, bins = 300) {
  return {
    center,
    radiusKm,
    bins,
    ringMax: new Float64Array(bins).fill(-Infinity),
    ringAt: new Array(bins).fill(null),
    samples: 0,
  };
}

export function addSample(profile, lon, lat, elevation) {
  const d = haversineKm(profile.center, { lon, lat });
  if (d > profile.radiusKm) return;
  const bin = Math.min(profile.bins - 1, Math.floor((d / profile.radiusKm) * profile.bins));
  profile.samples++;
  if (elevation > profile.ringMax[bin]) {
    profile.ringMax[bin] = elevation;
    profile.ringAt[bin] = { lon, lat, km: d };
  }
}

/**
 * Swaps a coarse find for its close-up reading. The zoom-12 re-read is the
 * truth: a real summit only reads higher up close, so one that reads far
 * lower was a glitch patch in the coarse tile (1,304 m in Massachusetts,
 * 3,458 m in the sea off Wellington) and must not keep its ring.
 */
export function replacePeak(profile, at, top) {
  const bin = Math.min(profile.bins - 1, Math.floor((at.km / profile.radiusKm) * profile.bins));
  const was = profile.ringAt[bin];
  if (was && was.lon === at.lon && was.lat === at.lat) {
    profile.ringMax[bin] = -Infinity;
    profile.ringAt[bin] = null;
  }
  addSample(profile, top.lon, top.lat, top.metres);
}

/**
 * Turns ring maxima into the curve the app draws: for each distance, the
 * highest point anywhere within it, and where that point is.
 */
export function finishProfile(profile) {
  const points = [];
  let best = -Infinity;
  let at = null;
  for (let i = 0; i < profile.bins; i++) {
    if (profile.ringMax[i] > best) {
      best = profile.ringMax[i];
      at = profile.ringAt[i];
    }
    const km = ((i + 1) / profile.bins) * profile.radiusKm;
    points.push({
      km,
      ring: Number.isFinite(profile.ringMax[i]) ? profile.ringMax[i] : null,
      max: Number.isFinite(best) ? best : null,
      at,
    });
  }
  return points;
}

/** How far you must go to stand at least `metres` up, or null if never. */
export function distanceToReach(points, metres) {
  const hit = points.find((p) => p.max != null && p.max >= metres);
  return hit ? hit.km : null;
}

// ---------- drive-time grid ----------

/**
 * A square grid of n x n sample points, halfKm either side of center.
 * Row 0 is the north edge, column 0 the west edge.
 */
export function makeGrid(center, halfKm, n) {
  const deg = kmPerDegree(center.lat);
  const step = (2 * halfKm) / (n - 1);
  const points = [];
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const xKm = -halfKm + i * step;
      const yKm = halfKm - j * step;
      points.push({ i, j, xKm, yKm, lon: center.lon + xKm / deg.lon, lat: center.lat + yKm / deg.lat });
    }
  }
  return { center, halfKm, n, step, points };
}

/** How wide a grid has to be to hold the longest drive asked for. */
export function gridHalfWidthKm(maxHours, kmPerHour = 95) {
  return Math.round(maxHours * kmPerHour + 40);
}

/**
 * OSRM gives a duration in seconds (or null) and how far each point had to
 * move to reach a road. A point that had to move further than maxSnapKm is in
 * water or wilderness, so it counts as unreachable rather than as the road
 * it snapped to.
 */
export function cleanDurations(durations, snapMetres, maxSnapKm) {
  return durations.map((s, k) => {
    if (s == null || !Number.isFinite(s)) return Infinity;
    if (snapMetres[k] != null && snapMetres[k] / 1000 > maxSnapKm) return Infinity;
    return s / 3600;
  });
}

/** Splits a list into runs of at most size. */
export function chunk(list, size) {
  const out = [];
  for (let k = 0; k < list.length; k += size) out.push(list.slice(k, k + size));
  return out;
}

/** d3-contour coordinates (pixel edges, 0..n) back to lon/lat. */
export function gridToLonLat(grid, gx, gy) {
  const deg = kmPerDegree(grid.center.lat);
  const xKm = -grid.halfKm + (gx - 0.5) * grid.step;
  const yKm = grid.halfKm - (gy - 0.5) * grid.step;
  return [grid.center.lon + xKm / deg.lon, grid.center.lat + yKm / deg.lat];
}

/** A contour MultiPolygon from d3 in grid units, converted to lon/lat rings. */
export function contourToLonLat(grid, multiPolygon) {
  return multiPolygon.map((polygon) => polygon.map((ring) => ring.map(([x, y]) => gridToLonLat(grid, x, y))));
}

/** Big stand-in for "unreachable", since contouring needs finite numbers. */
export const UNREACHABLE = 1e6;

export function contourValues(hours) {
  return hours.map((h) => (Number.isFinite(h) ? h : UNREACHABLE));
}

/**
 * Drive hours at any lon/lat inside the grid: bilinear between the four
 * nearest samples, or the nearest sample alone when any of the four is
 * unreachable, so a coastline doesn't smear into the sea.
 */
export function hoursAt(grid, hours, lon, lat) {
  const deg = kmPerDegree(grid.center.lat);
  const fi = ((lon - grid.center.lon) * deg.lon + grid.halfKm) / grid.step;
  const fj = (grid.halfKm - (lat - grid.center.lat) * deg.lat) / grid.step;
  if (fi < 0 || fj < 0 || fi > grid.n - 1 || fj > grid.n - 1) return Infinity;
  const i0 = Math.min(grid.n - 2, Math.floor(fi));
  const j0 = Math.min(grid.n - 2, Math.floor(fj));
  const tx = fi - i0, ty = fj - j0;
  const v = (i, j) => hours[j * grid.n + i];
  const a = v(i0, j0), b = v(i0 + 1, j0), c = v(i0, j0 + 1), d = v(i0 + 1, j0 + 1);
  if ([a, b, c, d].every(Number.isFinite)) {
    return a * (1 - tx) * (1 - ty) + b * tx * (1 - ty) + c * (1 - tx) * ty + d * tx * ty;
  }
  return v(Math.round(fi), Math.round(fj));
}

/**
 * For each limit in hourSteps: how much ground is within that drive (km²,
 * one grid cell per reachable sample) and the farthest straight-line distance
 * reached.
 */
export function reachCurve(grid, hours, hourSteps) {
  const cell = grid.step * grid.step;
  return hourSteps.map((limit) => {
    let count = 0;
    let farthest = 0;
    let at = null;
    grid.points.forEach((p, k) => {
      if (hours[k] <= limit) {
        count++;
        const d = Math.hypot(p.xKm, p.yKm);
        if (d > farthest) {
          farthest = d;
          at = p;
        }
      }
    });
    return { hours: limit, areaKm2: count * cell, farthestKm: farthest, at };
  });
}

/**
 * Tracks the highest ground reachable within each drive-time limit, from DEM
 * pixels fed one at a time. bins are quarter hours up to maxHours.
 */
export function makeDriveHeights(maxHours, binHours = 0.25) {
  const bins = Math.ceil(maxHours / binHours);
  return { maxHours, binHours, bins, max: new Float64Array(bins).fill(-Infinity), at: new Array(bins).fill(null) };
}

export function addDriveSample(acc, h, lon, lat, elevation) {
  if (!Number.isFinite(h) || h > acc.maxHours) return;
  const bin = Math.min(acc.bins - 1, Math.floor(Math.max(0, h) / acc.binHours));
  if (elevation > acc.max[bin]) {
    acc.max[bin] = elevation;
    acc.at[bin] = { lon, lat, hours: h };
  }
}

/** Running maximum: the highest point reachable within each limit. */
export function finishDriveHeights(acc) {
  const out = [];
  let best = -Infinity;
  let at = null;
  for (let i = 0; i < acc.bins; i++) {
    if (acc.max[i] > best) {
      best = acc.max[i];
      at = acc.at[i];
    }
    out.push({ hours: (i + 1) * acc.binHours, max: Number.isFinite(best) ? best : null, at });
  }
  return out;
}

/** The entry of a running-max curve at a limit (hours or km). */
export function atLimit(curve, key, limit) {
  let hit = null;
  for (const p of curve) if (p[key] <= limit + 1e-9) hit = p;
  return hit;
}

// ---------- units ----------

export function formatDistance(km, units) {
  if (km == null) return '-';
  if (units === 'imperial') {
    const mi = km * 0.621371;
    return mi < 10 ? `${mi.toFixed(1)} mi` : `${Math.round(mi).toLocaleString('en-US')} mi`;
  }
  return km < 10 ? `${km.toFixed(1)} km` : `${Math.round(km).toLocaleString('en-US')} km`;
}

export function formatHeight(m, units) {
  if (m == null) return '-';
  if (units === 'imperial') return `${Math.round(m * 3.28084).toLocaleString('en-US')} ft`;
  return `${Math.round(m).toLocaleString('en-US')} m`;
}

export function formatArea(km2, units) {
  if (units === 'imperial') return `${Math.round(km2 * 0.386102).toLocaleString('en-US')} sq mi`;
  return `${Math.round(km2).toLocaleString('en-US')} km²`;
}

export function formatHours(h) {
  if (h == null || !Number.isFinite(h)) return '-';
  const whole = Math.floor(h);
  const min = Math.round((h - whole) * 60);
  if (min === 60) return `${whole + 1} h`;
  if (whole === 0) return `${min} min`;
  return min ? `${whole} h ${String(min).padStart(2, '0')}` : `${whole} h`;
}

// ---------- KML and CSV ----------

export function escapeXml(s) {
  return String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]);
}

/** "#2a78d6" plus an alpha 0-1 as KML's aabbggrr. */
export function kmlColor(hex, alpha = 1) {
  const h = hex.replace('#', '');
  const a = Math.round(alpha * 255).toString(16).padStart(2, '0');
  return (a + h.slice(4, 6) + h.slice(2, 4) + h.slice(0, 2)).toLowerCase();
}

const coordText = (ring) => ring.map(([lon, lat]) => `${lon.toFixed(5)},${lat.toFixed(5)},0`).join(' ');

/**
 * One KML document: a filled polygon per drive-time band (with holes), and
 * placemarks for the origin and anything else worth a pin.
 */
export function driveKml({ name, origin, bands, placemarks = [] }) {
  const styles = bands
    .map(
      (b, k) => `  <Style id="band${k}"><LineStyle><color>${kmlColor(b.color, 1)}</color><width>2</width></LineStyle>` +
        `<PolyStyle><color>${kmlColor(b.color, 0.25)}</color></PolyStyle></Style>`,
    )
    .join('\n');
  const polys = bands
    .map((b, k) => {
      const geoms = b.polygons
        .map((poly) => {
          const [outer, ...holes] = poly;
          const inner = holes.map((h) => `<innerBoundaryIs><LinearRing><coordinates>${coordText(h)}</coordinates></LinearRing></innerBoundaryIs>`).join('');
          return `<Polygon><outerBoundaryIs><LinearRing><coordinates>${coordText(outer)}</coordinates></LinearRing></outerBoundaryIs>${inner}</Polygon>`;
        })
        .join('');
      return `  <Placemark><name>${escapeXml(b.label)}</name><styleUrl>#band${k}</styleUrl><MultiGeometry>${geoms}</MultiGeometry></Placemark>`;
    })
    .join('\n');
  const pins = [{ name: origin.name || 'Start', lon: origin.lon, lat: origin.lat, description: 'Start' }, ...placemarks]
    .map(
      (p) => `  <Placemark><name>${escapeXml(p.name)}</name>${p.description ? `<description>${escapeXml(p.description)}</description>` : ''}` +
        `<Point><coordinates>${p.lon.toFixed(5)},${p.lat.toFixed(5)},0</coordinates></Point></Placemark>`,
    )
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
<Document>
  <name>${escapeXml(name)}</name>
${styles}
${polys}
${pins}
</Document>
</kml>
`;
}

/** The height curves of several places side by side, one row per distance. */
export function profilesCsv(places) {
  if (!places.length) return '';
  const header = ['km', ...places.flatMap((p) => [`${p.name} max m`, `${p.name} ring m`])];
  const rows = places[0].points.map((_, k) => [
    places[0].points[k].km.toFixed(2),
    ...places.flatMap((p) => {
      const pt = p.points[k];
      return [pt?.max == null ? '' : pt.max.toFixed(1), pt?.ring == null ? '' : pt.ring.toFixed(1)];
    }),
  ]);
  return [header, ...rows].map((r) => r.map(csvField).join(',')).join('\n') + '\n';
}

export function csvField(v) {
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** The highest point within limitKm of a place, as a pin. */
export function summitWithin(points, limitKm) {
  const p = atLimit(points, 'km', limitKm);
  return p && p.at ? { ...p.at, metres: p.max } : null;
}

/**
 * The radii of a place's height table (the distance to reach each height,
 * then the whole radius) and the highest point within each. A summit that is
 * the highest for several radii comes once, with the smallest and largest of
 * them as minKm and maxKm.
 */
export function tableRings(points, heights, radiusKm) {
  const found = heights.map((m) => distanceToReach(points, m)).filter((d) => d != null);
  const radii = [...new Set([...found, radiusKm])].sort((a, b) => a - b);
  const summits = new Map();
  for (const r of radii) {
    const s = summitWithin(points, r);
    if (!s) continue;
    const key = `${s.lon},${s.lat}`;
    if (summits.has(key)) summits.get(key).maxKm = r;
    else summits.set(key, { ...s, minKm: r, maxKm: r });
  }
  return { radii, summits: [...summits.values()] };
}

// ---------- printable terrain ----------

/** The lon/lat box of a square sideKm across, centred on center. */
export function squareBounds(center, sideKm) {
  const deg = kmPerDegree(center.lat);
  const dLon = sideKm / 2 / deg.lon;
  const dLat = sideKm / 2 / deg.lat;
  return { west: center.lon - dLon, east: center.lon + dLon, south: center.lat - dLat, north: center.lat + dLat };
}

/**
 * A lon/lat box in global pixels at zoom z (256 per tile), and the tiles that
 * cover it, each with its own top-left in the same pixels. Tile x wraps across
 * the date line; left keeps the unwrapped position so tiles still line up.
 */
export function pixelBox(bounds, z) {
  const nw = lonLatToTile(bounds.west, bounds.north, z);
  const se = lonLatToTile(bounds.east, bounds.south, z);
  const n = 2 ** z;
  const tiles = [];
  for (let ty = Math.max(0, Math.floor(nw.y)); ty <= Math.min(n - 1, Math.floor(se.y - 1e-9)); ty++) {
    for (let tx = Math.floor(nw.x); tx <= Math.floor(se.x - 1e-9); tx++) {
      tiles.push({ x: ((tx % n) + n) % n, y: ty, z, left: tx * 256, top: ty * 256 });
    }
  }
  return { left: nw.x * 256, top: nw.y * 256, width: (se.x - nw.x) * 256, height: (se.y - nw.y) * 256, tiles };
}

/** The most detailed zoom, up to maxZoom, at which the box is at most maxPx wide. */
export function mapImageZoom(bounds, maxZoom, maxPx = 2048) {
  let z = maxZoom;
  while (z > 1 && pixelBox(bounds, z).width > maxPx) z--;
  return z;
}

/** The zoom whose pixels are at least as fine as the model's grid, within a tile budget. */
export function printZoom(center, sideKm, cells, maxTiles = 64) {
  const want = (sideKm * 1000) / cells;
  let z = 3;
  while (z < 14 && pixelMetres(center.lat, z + 1) >= want * 0.5) z++;
  while (z > 3 && tilesForRadius(center, sideKm * 0.71, z).length > maxTiles) z--;
  return z;
}

/**
 * The deepest zoom whose tiles carry the sea floor. From zoom 11 on, every sea
 * pixel reads 0 (Monterey Canyon is -657 m at zoom 10 and 0 at zoom 11), and
 * lakes are their flat surface at every zoom.
 */
export const SEA_FLOOR_ZOOM = 10;

/**
 * Puts the sea floor back under a detailed reading: where the fine grid is at
 * or below sea level, the coarse one (read at SEA_FLOOR_ZOOM) wins if it is
 * deeper. Land keeps its detail, and land below sea level keeps its own depth.
 */
export function withSeaFloor(fine, coarse) {
  return fine.map((h, k) => (h > 0 ? h : Math.min(h, coarse[k])));
}

/**
 * Scales a height grid to millimetres: the model is widthMm across, the base
 * slab is baseMm thick under the lowest point, and heights are stretched by
 * exaggeration. The sea floor is cut off seaFloorM below sea level (0 cuts it
 * at sea level), and depths are stretched by depthStretch.
 */
export function printHeights(heights, { sideKm, widthMm, exaggeration = 1, baseMm = 3, seaFloorM = 0, depthStretch = exaggeration }) {
  const floor = seaFloorM ? -seaFloorM : 0; // not -0, which would show as a lowest point of "-0 m"
  const metres = heights.map((h) => Math.max(floor, h));
  let lo = Infinity, hi = -Infinity;
  for (const h of metres) { if (h < lo) lo = h; if (h > hi) hi = h; }
  const mmPerMetre = widthMm / (sideKm * 1000);
  const up = (h) => h * mmPerMetre * (h > 0 ? exaggeration : depthStretch); // mm above sea level
  const toMm = (h) => baseMm + up(Math.max(floor, h)) - up(lo);
  const mm = metres.map(toMm);
  return {
    mm, toMm, lowM: lo, highM: hi, reliefMm: up(hi) - up(lo), mmPerMetre,
    seaMm: lo < 0 ? baseMm - up(lo) : null, // where sea level sits on the model, when anything is below it
  };
}

/**
 * A KML of a print: the square as a polygon, a pin at its centre, and every
 * input and derived figure as ExtendedData, so Google Earth shows the area and
 * the settings, and parsePrintKml can rebuild the same STL from the file.
 * model is optional; without it only the inputs are written.
 */
export function printKml({ centre, set, model = null, stlFile = '', made = new Date() }) {
  const b = squareBounds(centre, set.sideKm);
  const scale = Math.round((set.sideKm * 1e6) / set.widthMm);
  const inputs = [
    ['reachFormat', 'Reach print format', PRINT_FORMAT],
    ['centreName', 'Centre', centre.name],
    ['centreLat', 'Centre latitude', centre.lat.toFixed(6)],
    ['centreLon', 'Centre longitude', centre.lon.toFixed(6)],
    ['squareKm', 'Square side (km)', set.sideKm],
    ['modelWidthMm', 'Model width (mm)', set.widthMm],
    ['gridCells', 'Detail (grid points per side)', set.cells],
    ['heightStretch', 'Height stretch (x)', set.exaggeration],
    ['baseMm', 'Base under the lowest point (mm)', set.baseMm],
    ['seaFloorM', 'Sea floor down to (m, 0 cuts it at sea level)', set.seaFloorM ?? 0],
    ['depthStretch', 'Depth stretch (x)', set.depthStretch ?? set.exaggeration],
    ['shoreMm', 'Shoreline line size (mm, 0 for none)', set.shoreMm ?? 0],
    ['shoreRidge', 'Shoreline as a ridge (1) or a groove (0)', set.shoreRidge ? 1 : 0],
    ['buildings', 'Buildings from OpenStreetMap (1 yes, 0 no)', set.buildings ? 1 : 0],
    ['buildingDefaultM', 'Building height where OSM has none (m)', set.buildingDefaultM ?? DEFAULT_BUILDING_M],
  ];
  const derived = [
    ['boundsNorth', 'North edge', b.north.toFixed(6)],
    ['boundsSouth', 'South edge', b.south.toFixed(6)],
    ['boundsEast', 'East edge', b.east.toFixed(6)],
    ['boundsWest', 'West edge', b.west.toFixed(6)],
    ['mapScale', 'Map scale', `1:${scale}`],
    ['mmPerKmAcross', 'Model mm per km across', +(set.widthMm / set.sideKm).toFixed(4)],
    ['elevationSource', 'Elevation data', 'Mapzen Terrain Tiles on AWS (Terrarium)'],
  ];
  if (model) {
    const vertical = 1 / ((set.widthMm / (set.sideKm * 1000)) * set.exaggeration);
    derived.push(
      ['elevationZoom', 'Elevation tile zoom', model.zoom],
      ['metresPerPixel', 'Elevation detail (m per pixel)', Math.round(model.pixelM)],
      ...(model.seaZoom != null ? [
        ['seaFloorZoom', 'Sea floor tile zoom', model.seaZoom],
        ['seaFloorMetresPerPixel', 'Sea floor detail (m per pixel)', Math.round(model.seaPixelM)],
      ] : []),
      ['gridSpacingM', 'Grid spacing (m)', Math.round((set.sideKm * 1000) / (set.cells - 1))],
      ['lowestM', 'Lowest point (m)', Math.round(model.lowM)],
      ['highestM', 'Highest point (m)', Math.round(model.highM)],
      ['reliefMm', 'Relief on the model (mm)', +model.reliefMm.toFixed(2)],
      ['modelHeightMm', 'Model height overall (mm)', +(set.baseMm + model.reliefMm).toFixed(2)],
      ['metresPerMmVertical', 'Metres of ground per mm of model height', +vertical.toFixed(2)],
      ['triangles', 'STL triangles', model.triangles],
    );
    if (model.buildings) {
      const b = model.buildings;
      derived.push(
        ['buildingCount', 'Buildings printed', b.count],
        ['buildingsWithHeight', 'Buildings with their own height in OSM', b.tagged],
        ['buildingsInElevation', 'Buildings already in the elevation data (flattened under)', b.inData],
        ['tallestBuildingM', 'Tallest building (m)', Math.round(b.tallestM)],
        ...(b.liftM != null ? [['groundLiftM', 'Ground under buildings above the open ground near them (m)', +b.liftM.toFixed(1)]] : []),
        ['buildingSource', 'Building data', `OpenStreetMap contributors (ODbL), read ${b.readAt}`],
      );
    }
  }
  if (stlFile) derived.push(['stlFile', 'STL file', stlFile]);
  derived.push(['made', 'Made', made.toISOString()]);

  const data = (rows) => rows.map(([k, label, v]) =>
    `      <Data name="${k}"><displayName>${escapeXml(label)}</displayName><value>${escapeXml(v)}</value></Data>`).join('\n');
  const table = (rows) => rows.filter(([k]) => k !== 'reachFormat')
    .map(([, label, v]) => `<tr><td>${escapeXml(label)}</td><td>${escapeXml(v)}</td></tr>`).join('');
  const description = `<![CDATA[<p>A ${set.sideKm} km square of terrain as a ${set.widthMm} mm model. Open this file in Reach's Print tab to build the same STL.</p>` +
    `<table>${table(inputs)}${table(derived)}</table>]]>`;
  const ring = [[b.west, b.north], [b.east, b.north], [b.east, b.south], [b.west, b.south], [b.west, b.north]];
  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
<Document>
  <name>${escapeXml(`Reach print: ${centre.name}, ${set.sideKm} km`)}</name>
  <Style id="square"><LineStyle><color>ff24548f</color><width>3</width></LineStyle><PolyStyle><color>2224548f</color></PolyStyle></Style>
  <Placemark id="reach-print">
    <name>${escapeXml(`${set.sideKm} km print area`)}</name>
    <description>${description}</description>
    <styleUrl>#square</styleUrl>
    <ExtendedData>
${data(inputs)}
${data(derived)}
    </ExtendedData>
    <Polygon><tessellate>1</tessellate><outerBoundaryIs><LinearRing><coordinates>${coordText(ring)}</coordinates></LinearRing></outerBoundaryIs></Polygon>
  </Placemark>
  <Placemark><name>${escapeXml(centre.name)}</name><Point><coordinates>${centre.lon.toFixed(6)},${centre.lat.toFixed(6)},0</coordinates></Point></Placemark>
</Document>
</kml>
`;
}

export const PRINT_FORMAT = 'reach-print-1';

const unescapeXml = (s) => s.replace(/&(lt|gt|amp|apos|quot);/g, (_, e) => ({ lt: '<', gt: '>', amp: '&', apos: "'", quot: '"' })[e]);

/**
 * The centre and settings from a KML made by printKml. Throws an Error that
 * says what is wrong when the file is not one, or a value is missing or bad.
 */
export function parsePrintKml(text) {
  const values = {};
  for (const m of text.matchAll(/<Data\s+name="([^"]+)"[^>]*>[\s\S]*?<value>([\s\S]*?)<\/value>[\s\S]*?<\/Data>/g)) {
    values[m[1]] = unescapeXml(m[2].trim());
  }
  if (values.reachFormat !== PRINT_FORMAT) throw new Error("this KML was not saved from Reach's Print tab");
  const num = (k, lo, hi) => {
    const v = Number(values[k]);
    if (values[k] == null || !Number.isFinite(v) || v < lo || v > hi) throw new Error(`the file's ${k} is missing or out of range`);
    return v;
  };
  const exaggeration = num('heightStretch', 0.1, 100);
  return {
    centre: { name: values.centreName || 'Saved print', lat: num('centreLat', -85, 85), lon: num('centreLon', -180, 180) },
    set: {
      sideKm: num('squareKm', 0.1, 1000),
      widthMm: num('modelWidthMm', 10, 1000),
      cells: Math.round(num('gridCells', 10, 1000)),
      exaggeration,
      baseMm: num('baseMm', 0, 100),
      // files from before the sea floor cut it at sea level
      seaFloorM: values.seaFloorM == null ? 0 : num('seaFloorM', 0, 11100),
      depthStretch: values.depthStretch == null ? exaggeration : num('depthStretch', 0.1, 100),
      // files from before the shoreline have none
      shoreMm: values.shoreMm == null ? 0 : num('shoreMm', 0, 10),
      shoreRidge: values.shoreRidge === '1',
      // files from before buildings have none
      buildings: values.buildings === '1',
      buildingDefaultM: values.buildingDefaultM == null ? DEFAULT_BUILDING_M : num('buildingDefaultM', 1, 100),
    },
  };
}

/**
 * Sea smaller than this many grid points draws no shoreline: below it, a
 * reading at or under sea level is a quarry, a dip in the data or a polder
 * field, not the sea.
 */
export const SHORE_MIN_SEA = 8;

/**
 * The shoreline on an n x n height grid (row 0 north): a 1 for each land
 * point (above 0 m) beside a sea point (at or below 0 m) to its north,
 * south, east or west, as a Uint8Array. Patches of sea smaller than
 * minSea points don't count.
 */
export function shorePoints(heights, n, minSea = SHORE_MIN_SEA) {
  // Label the sea in 4-connected patches, keeping the ones big enough.
  const sea = new Uint8Array(n * n);
  const seen = new Uint8Array(n * n);
  const stack = [];
  for (let start = 0; start < n * n; start++) {
    if (seen[start] || heights[start] > 0) continue;
    const patch = [];
    seen[start] = 1;
    stack.push(start);
    while (stack.length) {
      const k = stack.pop();
      patch.push(k);
      const i = k % n, j = (k - i) / n;
      for (const q of [i > 0 ? k - 1 : -1, i < n - 1 ? k + 1 : -1, j > 0 ? k - n : -1, j < n - 1 ? k + n : -1]) {
        if (q >= 0 && !seen[q] && !(heights[q] > 0)) { seen[q] = 1; stack.push(q); }
      }
    }
    if (patch.length >= minSea) for (const k of patch) sea[k] = 1;
  }
  const shore = new Uint8Array(n * n);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const k = j * n + i;
      if (!(heights[k] > 0)) continue;
      if ((i > 0 && sea[k - 1]) || (i < n - 1 && sea[k + 1]) || (j > 0 && sea[k - n]) || (j < n - 1 && sea[k + n])) shore[k] = 1;
    }
  }
  return shore;
}

/**
 * Marks the shore (from shorePoints) on a millimetre grid: a V-groove sizeMm
 * deep, never leaving less than minMm of model under it, or with ridge set,
 * a ridge sizeMm high. Either is still a height grid, so the STL stays closed.
 */
export function markShore(mm, shore, sizeMm, ridge = false, minMm = 0.6) {
  return mm.map((z, k) => (!shore[k] ? z : ridge ? z + sizeMm : Math.max(Math.min(z, minMm), z - sizeMm)));
}

/**
 * A closed, printable binary STL of an n x n height grid (row 0 north): the
 * terrain on top, four walls down to z = 0, and a bottom fanned from its centre.
 * Every edge is shared by exactly two triangles, so slicers take it as solid.
 * extra is more triangles (three points each) to write after the terrain's,
 * such as buildingTriangles.
 */
export function terrainStl(zMm, n, widthMm, extra = []) {
  const step = widthMm / (n - 1);
  const X = (i) => i * step;
  const Y = (j) => (n - 1 - j) * step; // north is +y
  const Z = (i, j) => zMm[j * n + i];
  const tris = [];
  const tri = (a, b, c) => tris.push(a, b, c);
  // top, counter-clockwise seen from above
  for (let j = 0; j < n - 1; j++) {
    for (let i = 0; i < n - 1; i++) {
      const a = [X(i), Y(j), Z(i, j)], b = [X(i + 1), Y(j), Z(i + 1, j)];
      const c = [X(i), Y(j + 1), Z(i, j + 1)], d = [X(i + 1), Y(j + 1), Z(i + 1, j + 1)];
      tri(a, c, b);
      tri(b, c, d);
    }
  }
  // the perimeter, walked counter-clockwise from above: south edge west to east, east edge, north edge, west edge
  const ring = [];
  for (let i = 0; i < n - 1; i++) ring.push([i, n - 1]);
  for (let j = n - 1; j > 0; j--) ring.push([n - 1, j]);
  for (let i = n - 1; i > 0; i--) ring.push([i, 0]);
  for (let j = 0; j < n - 1; j++) ring.push([0, j]);
  const centre = [widthMm / 2, widthMm / 2, 0];
  for (let k = 0; k < ring.length; k++) {
    const [i0, j0] = ring[k];
    const [i1, j1] = ring[(k + 1) % ring.length];
    const top0 = [X(i0), Y(j0), Z(i0, j0)], top1 = [X(i1), Y(j1), Z(i1, j1)];
    const bot0 = [X(i0), Y(j0), 0], bot1 = [X(i1), Y(j1), 0];
    tri(bot0, bot1, top1); // wall, facing outward
    tri(bot0, top1, top0);
    tri(centre, bot1, bot0); // bottom, facing down
  }
  for (const p of extra) tris.push(p);
  const count = tris.length / 3;
  const buf = new ArrayBuffer(84 + count * 50);
  const view = new DataView(buf);
  const header = 'Reach terrain STL';
  for (let k = 0; k < header.length; k++) view.setUint8(k, header.charCodeAt(k));
  view.setUint32(80, count, true);
  let o = 84;
  for (let t = 0; t < count; t++) {
    const [a, b, c] = [tris[t * 3], tris[t * 3 + 1], tris[t * 3 + 2]];
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const nx = u[1] * v[2] - u[2] * v[1], ny = u[2] * v[0] - u[0] * v[2], nz = u[0] * v[1] - u[1] * v[0];
    const len = Math.hypot(nx, ny, nz) || 1;
    for (const val of [nx / len, ny / len, nz / len, ...a, ...b, ...c]) { view.setFloat32(o, val, true); o += 4; }
    o += 2; // attribute byte count
  }
  return buf;
}

/** Reads a binary STL back into triangles, for tests and the preview. */
export function readStl(buf) {
  const view = new DataView(buf);
  const count = view.getUint32(80, true);
  const tris = [];
  for (let t = 0, o = 84; t < count; t++, o += 50) {
    const f = (k) => view.getFloat32(o + k * 4, true);
    tris.push({ normal: [f(0), f(1), f(2)], v: [[f(3), f(4), f(5)], [f(6), f(7), f(8)], [f(9), f(10), f(11)]] });
  }
  return tris;
}

// ---------- buildings ----------

/** Metres a storey adds, for buildings that give floors but no height. */
export const STOREY_M = 3;
/** A building's height when OSM gives neither height nor floors, unless chosen otherwise: two floors. */
export const DEFAULT_BUILDING_M = 7;
/** Buildings come from OpenStreetMap only on squares this size or smaller: past it most are too small to print. */
export const BUILDINGS_MAX_KM = 2;
/**
 * When the ground under the buildings stands this far above the open ground
 * near them, the elevation data holds the city's buildings. Measured on 2 km
 * squares: Manhattan 0.2 m, Dubai Marina 1.3 m, Mong Kok 8 m.
 */
export const LIFTED_M = 4;
/** Footprints smaller than this on the model (mm²) are left out, as too small to print. */
export const MIN_FOOTPRINT_MM2 = 0.4;

/** The Overpass query for every building in a lon/lat box, with its outline. */
export function overpassBuildingsQuery(b) {
  const box = [b.south, b.west, b.north, b.east].map((v) => v.toFixed(6)).join(',');
  return `[out:json][timeout:90];(way["building"](${box});relation["building"]["type"="multipolygon"](${box}););out geom;`;
}

/** Metres from an OSM length ("12", "12.5 m", "40 ft", "40'", "12'6\""), or null. */
export function parseMetres(v) {
  if (v == null) return null;
  const s = String(v).trim().replace(',', '.');
  let m = s.match(/^(\d+(?:\.\d+)?)\s*(?:m|metres?|meters?)?$/i);
  if (m) return Number(m[1]);
  m = s.match(/^(\d+(?:\.\d+)?)\s*(?:ft|feet|')$/i);
  if (m) return Number(m[1]) * 0.3048;
  m = s.match(/^(\d+)'\s*(\d+(?:\.\d+)?)"$/);
  if (m) return Number(m[1]) * 0.3048 + Number(m[2]) * 0.0254;
  return null;
}

/**
 * A building's height in metres from its OSM tags: height, or else its floors
 * (building:levels plus roof:levels) at STOREY_M each. null when it has neither.
 */
export function buildingHeight(tags = {}) {
  const h = parseMetres(tags.height);
  if (h > 0) return h;
  const levels = Number(String(tags['building:levels'] ?? '').replace(',', '.'));
  if (levels > 0) return (levels + (Number(tags['roof:levels']) || 0)) * STOREY_M;
  return null;
}

/**
 * Closed rings from ways that meet end to end, as a multipolygon's members do.
 * Points are [x, y] pairs matched exactly; a ring that never closes is dropped.
 */
export function joinRings(ways) {
  const same = (a, b) => a[0] === b[0] && a[1] === b[1];
  const left = ways.filter((w) => w.length > 1);
  const rings = [];
  while (left.length) {
    let ring = left.shift();
    while (!same(ring[0], ring[ring.length - 1])) {
      const end = ring[ring.length - 1];
      const k = left.findIndex((w) => same(w[0], end) || same(w[w.length - 1], end));
      if (k < 0) break;
      const [w] = left.splice(k, 1);
      ring = ring.concat(same(w[0], end) ? w.slice(1) : w.slice(0, -1).reverse());
    }
    if (ring.length >= 4 && same(ring[0], ring[ring.length - 1])) rings.push(ring);
  }
  return rings;
}

/** Twice the signed area of a ring (no repeated last point): positive when counter-clockwise. */
export function ringArea2(ring) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += (ring[j][0] - ring[i][0]) * (ring[j][1] + ring[i][1]);
  return a;
}

/** Whether point p is inside a ring, by ray casting. */
export function inRing(p, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** The distance from point p to a ring's outline. */
export function distanceToRing(p, ring) {
  let best = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [ax, ay] = ring[j], [bx, by] = ring[i];
    const dx = bx - ax, dy = by - ay;
    const t = dx || dy ? Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy) / (dx * dx + dy * dy))) : 0;
    best = Math.min(best, Math.hypot(p[0] - ax - t * dx, p[1] - ay - t * dy));
  }
  return best;
}

/** A ring cut to the square from 0 to w on both axes (Sutherland-Hodgman), without repeated points. */
export function clipToSquare(ring, w) {
  const cut = (pts, k, lim, above) => {
    const inside = (p) => (above ? p[k] >= lim : p[k] <= lim);
    const out = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      if (inside(a)) out.push(a);
      if (inside(a) !== inside(b)) {
        const t = (lim - a[k]) / (b[k] - a[k]);
        out.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]);
      }
    }
    return out;
  };
  let pts = ring;
  for (const [k, lim, above] of [[0, 0, true], [0, w, false], [1, 0, true], [1, w, false]]) pts = cut(pts, k, lim, above);
  const out = pts.filter((p, i) => {
    const q = pts[(i + 1) % pts.length];
    return Math.abs(p[0] - q[0]) > 1e-6 || Math.abs(p[1] - q[1]) > 1e-6;
  });
  return out.length >= 3 ? out : null;
}

const NOT_BUILT = new Set(['no', 'roof', 'construction', 'proposed', 'demolished', 'destroyed']);

/**
 * Building footprints from an Overpass reply, in model millimetres (x east, y
 * north, the square's south-west corner at 0,0) and cut to the square. Each is
 * { rings, heightM }: the outline counter-clockwise, then any courtyards
 * clockwise, with heightM null where OSM has no height. Roofs on posts,
 * underground buildings and footprints too small to print are left out.
 */
export function buildingFootprints(osm, bounds, widthMm) {
  const toMm = (g) => [((g.lon - bounds.west) / (bounds.east - bounds.west)) * widthMm,
    ((g.lat - bounds.south) / (bounds.north - bounds.south)) * widthMm];
  const open = (ring) => ring.slice(0, -1); // drop the repeated closing point
  const out = [];
  for (const el of osm.elements || []) {
    const tags = el.tags || {};
    if (!tags.building || NOT_BUILT.has(tags.building) || tags.location === 'underground') continue;
    let outers = [], inners = [];
    if (el.type === 'way') {
      const g = (el.geometry || []).map(toMm);
      if (g.length >= 4 && g[0][0] === g[g.length - 1][0] && g[0][1] === g[g.length - 1][1]) outers = [open(g)];
    } else if (el.type === 'relation') {
      const role = (r) => joinRings((el.members || [])
        .filter((m) => m.type === 'way' && (m.role || 'outer') === r && m.geometry)
        .map((m) => m.geometry.map(toMm))).map(open);
      outers = role('outer');
      inners = role('inner');
    }
    const heightM = buildingHeight(tags);
    for (const outer of outers) {
      const shell = clipToSquare(outer, widthMm);
      if (!shell) continue;
      // A courtyard the square's edge cuts would touch the cut outline, so it is filled in instead.
      const holes = inners.filter((h) => inRing(h[0], outer) && h.every(([x, y]) => x > 0 && x < widthMm && y > 0 && y < widthMm));
      const area = Math.abs(ringArea2(shell)) / 2 - holes.reduce((s, h) => s + Math.abs(ringArea2(h)) / 2, 0);
      if (area < MIN_FOOTPRINT_MM2) continue;
      if (ringArea2(shell) < 0) shell.reverse();
      for (const h of holes) if (ringArea2(h) > 0) h.reverse();
      out.push({ rings: [shell, ...holes], heightM });
    }
  }
  return out;
}

const quantile = (values, q) => {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};

/**
 * Stands each footprint on the n x n terrain grid (metres, row 0 north) and
 * finds the buildings the elevation data already holds.
 *
 * A building's ground is the terrain inside its footprint (the median of the
 * grid there), since the elevation data is bare earth under the buildings
 * OpenStreetMap maps in every city tried: Sunny Isles Beach, Midtown Miami,
 * Manhattan and Dubai Marina. A building is in the data when the terrain
 * inside it stands more than max(4 m, 40% of its height) above the upper
 * quartile of the terrain round a box padM outside it: a bump above nearly
 * everything around, which water or a highway ramp on one side can't fake.
 * Its ground is then the median of that ring instead, and the grid within
 * padM of it is lowered to that, so the building doesn't stand twice.
 *
 * Returns the grid, flattened where needed, liftM (how far the ground under
 * the buildings stands above the open ground near them, the median over
 * buildings, or null with too few to tell: over LIFTED_M, the elevation data
 * holds the whole city) and per building { rings, heightM, tagged, groundM,
 * inData }, heightM falling back to defaultM.
 */
export function placeBuildings(footprints, heights, n, { sideKm, widthMm, padM, defaultM }) {
  const step = widthMm / (n - 1);
  const mmPerM = widthMm / (sideKm * 1000);
  const padMm = padM * mmPerM;
  const node = (i, j) => heights[j * n + i];
  const at = (x, y) => { // bilinear on the grid, clamped to the square
    const gi = Math.max(0, Math.min(n - 1, x / step)), gj = Math.max(0, Math.min(n - 1, n - 1 - y / step));
    const i0 = Math.min(n - 2, Math.floor(gi)), j0 = Math.min(n - 2, Math.floor(gj));
    const ti = gi - i0, tj = gj - j0;
    return node(i0, j0) * (1 - ti) * (1 - tj) + node(i0 + 1, j0) * ti * (1 - tj) +
      node(i0, j0 + 1) * (1 - ti) * tj + node(i0 + 1, j0 + 1) * ti * tj;
  };
  // the grid nodes within a box, as [i, j, x, y]
  const nodesIn = (x0, y0, x1, y1) => {
    const list = [];
    for (let i = Math.max(0, Math.ceil(x0 / step)); i <= Math.min(n - 1, Math.floor(x1 / step)); i++) {
      for (let j = Math.max(0, Math.ceil(n - 1 - y1 / step)); j <= Math.min(n - 1, Math.floor(n - 1 - y0 / step)); j++) {
        list.push([i, j, i * step, (n - 1 - j) * step]);
      }
    }
    return list;
  };
  const placed = footprints.map(({ rings, heightM }) => {
    const outer = rings[0];
    const xs = outer.map((p) => p[0]), ys = outer.map((p) => p[1]);
    const box = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    const [x0, y0, x1, y1] = [box[0] - padMm, box[1] - padMm, box[2] + padMm, box[3] + padMm];
    const around = [];
    for (let k = 0; k < 4; k++) {
      const t = k / 4;
      around.push(at(x0 + t * (x1 - x0), y0), at(x1, y0 + t * (y1 - y0)), at(x1 - t * (x1 - x0), y1), at(x0, y1 - t * (y1 - y0)));
    }
    const inside = nodesIn(...box).filter(([, , x, y]) => inRing([x, y], outer)).map(([i, j]) => node(i, j));
    const mid = outer.reduce((s, p) => [s[0] + p[0] / outer.length, s[1] + p[1] / outer.length], [0, 0]);
    const insideM = inside.length ? quantile(inside, 0.5) : at(...mid);
    const h = heightM ?? defaultM;
    const inData = insideM - quantile(around, 0.75) > Math.max(4, 0.4 * h);
    const groundM = inData ? quantile(around, 0.5) : insideM;
    return { rings, heightM: h, tagged: heightM != null, groundM, inData, box: [x0, y0, x1, y1], mid, insideM, measured: inside.length >= 2 };
  });
  const flat = heights.slice();
  for (const b of placed) {
    if (!b.inData) continue;
    for (const [i, j, x, y] of nodesIn(...b.box)) {
      if (inRing([x, y], b.rings[0]) || distanceToRing([x, y], b.rings[0]) <= padMm) {
        flat[j * n + i] = Math.min(flat[j * n + i], b.groundM);
      }
    }
  }
  // A city the elevation holds as a surface model lifts every building's
  // surroundings too, so no one building stands out (Mong Kok reads 11 to 52 m
  // over ground near 5 m). So compare the ground under each building with the
  // open ground, nothing built within 30 m, inside 150 m of it.
  const clearMm = 30 * mmPerM, nearMm = 150 * mmPerM;
  const built = new Uint8Array(n * n);
  for (const { rings: [outer] } of placed) {
    const xs = outer.map((p) => p[0]), ys = outer.map((p) => p[1]);
    for (const [i, j, x, y] of nodesIn(Math.min(...xs) - clearMm, Math.min(...ys) - clearMm, Math.max(...xs) + clearMm, Math.max(...ys) + clearMm)) {
      if (!built[j * n + i] && (inRing([x, y], outer) || distanceToRing([x, y], outer) < clearMm)) built[j * n + i] = 1;
    }
  }
  const lifts = [];
  for (const b of placed) {
    if (!b.measured) continue;
    const open = nodesIn(b.mid[0] - nearMm, b.mid[1] - nearMm, b.mid[0] + nearMm, b.mid[1] + nearMm)
      .filter(([i, j]) => !built[j * n + i]).map(([i, j]) => node(i, j));
    if (open.length >= 5) lifts.push(b.insideM - quantile(open, 0.5));
  }
  const liftM = lifts.length >= 5 ? quantile(lifts, 0.5) : null;
  return { heights: flat, liftM, buildings: placed.map(({ box, mid, insideM, measured, ...b }) => b) };
}

/** The convex hull of points, counter-clockwise (Andrew's monotone chain). */
export function convexHull(points) {
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const half = (list) => {
    const h = [];
    for (const p of list) {
      while (h.length >= 2 && cross(h[h.length - 2], h[h.length - 1], p) <= 0) h.pop();
      h.push(p);
    }
    h.pop();
    return h;
  };
  return [...half(pts), ...half(pts.reverse())];
}

/** Whether triangles (three points each) close up: every edge in two of them, once each way. */
export function isClosed(tris) {
  const edges = new Map();
  for (let t = 0; t < tris.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      const a = tris[t + k].join(','), b = tris[t + (k + 1) % 3].join(',');
      edges.set(`${a}>${b}`, (edges.get(`${a}>${b}`) || 0) + 1);
    }
  }
  for (const [e, count] of edges) {
    const [a, b] = e.split('>');
    if (count !== 1 || edges.get(`${b}>${a}`) !== 1) return false;
  }
  return tris.length > 0;
}

/**
 * A footprint raised from bottom to top as triangles: the roof and floor
 * from earcut, and the walls. The outline runs counter-clockwise and
 * courtyards clockwise, so every wall faces out of the solid.
 */
function prism(rings, bottom, top) {
  const tris = [];
  const tri = (a, b, c) => tris.push(a, b, c);
  const flat = [], holes = [];
  for (const r of rings) {
    if (flat.length) holes.push(flat.length / 2);
    for (const p of r) flat.push(p[0], p[1]);
  }
  const idx = earcut(flat, holes);
  if (!idx.length) return tris; // no roof, no solid: only walls, folded flat
  const pt = (k, z) => [flat[k * 2], flat[k * 2 + 1], z];
  for (let t = 0; t < idx.length; t += 3) {
    let [a, b, c] = [idx[t], idx[t + 1], idx[t + 2]];
    // earcut doesn't promise a winding: make the roof counter-clockwise from above
    const cross = (flat[b * 2] - flat[a * 2]) * (flat[c * 2 + 1] - flat[a * 2 + 1]) - (flat[c * 2] - flat[a * 2]) * (flat[b * 2 + 1] - flat[a * 2 + 1]);
    if (cross < 0) [b, c] = [c, b];
    tri(pt(a, top), pt(b, top), pt(c, top));
    tri(pt(a, bottom), pt(c, bottom), pt(b, bottom));
  }
  for (const r of rings) {
    for (let k = 0; k < r.length; k++) {
      const p = r[k], q = r[(k + 1) % r.length];
      const b0 = [p[0], p[1], bottom], b1 = [q[0], q[1], bottom], t0 = [p[0], p[1], top], t1 = [q[0], q[1], top];
      tri(b0, b1, t1);
      tri(b0, t1, t0);
    }
  }
  return tris;
}

/**
 * Each placed building as its own closed solid, as STL triangles (three
 * points each) to add to the terrain's. The solid's floor sits just under the
 * lowest terrain beneath it, and its roof is its ground plus its height, at
 * the land's height stretch. zMm is the terrain in mm and toMm turns metres
 * into model height the same way (both from printHeights).
 */
export function buildingTriangles(buildings, zMm, n, { widthMm, toMm, mmPerMetre, exaggeration }) {
  const step = widthMm / (n - 1);
  const tris = [];
  for (const { rings, heightM, groundM } of buildings) {
    const outer = rings[0];
    const xs = outer.map((p) => p[0]), ys = outer.map((p) => p[1]);
    // the terrain over a grid cell is never below its lowest corner
    let low = Infinity;
    for (let i = Math.max(0, Math.floor(Math.min(...xs) / step)); i <= Math.min(n - 1, Math.ceil(Math.max(...xs) / step)); i++) {
      for (let j = Math.max(0, Math.floor(n - 1 - Math.max(...ys) / step)); j <= Math.min(n - 1, Math.ceil(n - 1 - Math.min(...ys) / step)); j++) {
        low = Math.min(low, zMm[j * n + i]);
      }
    }
    const bottom = Math.max(0, low - 0.2);
    const top = Math.max(bottom + 0.4, toMm(groundM) + heightM * mmPerMetre * exaggeration);
    // A broken outline in OSM (crossing itself, or courtyards touching it) can't be
    // closed: try it without its courtyards, then as the outline's convex hull.
    // A sliver with no area closes no way at all, and is left out.
    const solid = [rings, [rings[0]], [convexHull(rings[0])]].map((r) => prism(r, bottom, top)).find(isClosed) || [];
    for (const p of solid) tris.push(p);
  }
  return tris;
}
