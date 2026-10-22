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
 * Where a print's model lies on the ground: a square sideKm across centred on
 * centre, modelled widthMm across, its top turned to face bearing (degrees
 * clockwise from north). toLonLat takes model mm (x east before the turn, y
 * north, 0 to widthMm) to a {lon, lat}, and toMm takes a lon/lat back to
 * [x, y]. bounds is the lon/lat box the turned square fits in. Like
 * squareBounds, it is even in degrees at the centre's latitude.
 */
export function printFrame(centre, sideKm, widthMm, bearing = 0) {
  const deg = kmPerDegree(centre.lat);
  const kmPerMm = sideKm / widthMm, mid = widthMm / 2;
  const s = Math.sin(bearing * RAD), c = Math.cos(bearing * RAD);
  const toLonLat = (x, y) => {
    const u = (x - mid) * kmPerMm, v = (y - mid) * kmPerMm; // km right and up on the model
    return { lon: centre.lon + (u * c + v * s) / deg.lon, lat: centre.lat + (v * c - u * s) / deg.lat };
  };
  const toMm = (lon, lat) => {
    const e = (lon - centre.lon) * deg.lon, n = (lat - centre.lat) * deg.lat;
    return [(e * c - n * s) / kmPerMm + mid, (e * s + n * c) / kmPerMm + mid];
  };
  const corners = [[0, 0], [widthMm, 0], [widthMm, widthMm], [0, widthMm]].map(([x, y]) => toLonLat(x, y));
  const bounds = {
    west: Math.min(...corners.map((p) => p.lon)), east: Math.max(...corners.map((p) => p.lon)),
    south: Math.min(...corners.map((p) => p.lat)), north: Math.max(...corners.map((p) => p.lat)),
  };
  return { toLonLat, toMm, bounds };
}

/**
 * How much shorter on the ground the square's poleward edge is than its other
 * edge, as a fraction. The box is even in degrees, so both edges span the same
 * longitude: at 45 degrees about 3% at 200 km and 7.5% at 500 km.
 */
export function edgeSkew(center, sideKm) {
  const b = squareBounds(center, sideKm);
  const [lo, hi] = [Math.abs(b.south), Math.abs(b.north)].sort((x, y) => x - y);
  // a box across the equator: its widest line is the equator, not an edge
  const widest = b.south < 0 && b.north > 0 ? 0 : lo;
  return 1 - Math.cos(Math.min(hi, 89.9) * RAD) / Math.cos(widest * RAD);
}

/** A square's side for the page: metres under 1 km, feet under half a mile. */
export function formatSide(km, units) {
  if (units === 'imperial') {
    const mi = km * 0.621371;
    return mi < 0.5 ? `${(Math.round(mi * 528) * 10).toLocaleString('en-US')} ft` : formatDistance(km, units);
  }
  return km < 1 ? `${Math.round(km * 1000)} m` : formatDistance(km, units);
}

/** The smallest and largest side the print takes, in km. */
export const SIDE_MIN_KM = 0.05;
export const SIDE_MAX_KM = 500;
const SIDE_UNITS = { m: 0.001, km: 1, ft: 0.0003048, mi: 1.609344 };

/**
 * A side typed by hand, "3.5", "3.5 km", "800 m", "2 mi" or "1500 ft", as km
 * and a label in the unit typed. A bare number is km, or miles in imperial.
 * Null when it doesn't read or falls outside SIDE_MIN_KM to SIDE_MAX_KM.
 */
export function parseSide(text, units) {
  const m = String(text).trim().toLowerCase().replace(/,/g, '').match(/^(\d*\.?\d+)\s*(m|km|ft|mi)?$/);
  if (!m) return null;
  const unit = m[2] || (units === 'imperial' ? 'mi' : 'km');
  const value = Number(m[1]);
  const km = value * SIDE_UNITS[unit];
  if (!(km >= SIDE_MIN_KM && km <= SIDE_MAX_KM)) return null;
  return { km, label: `${Number(value.toPrecision(4)).toLocaleString('en-US')} ${unit}` };
}

/**
 * A size dragged on the map, rounded to a step that suits it: 10 m under
 * 1 km, 100 m under 10 km and 1 km above, within SIDE_MIN_KM to SIDE_MAX_KM.
 */
export function snapSideKm(km) {
  const step = km < 1 ? 0.01 : km < 10 ? 0.1 : 1;
  return Math.min(SIDE_MAX_KM, Math.max(SIDE_MIN_KM, Number((Math.round(km / step) * step).toPrecision(6))));
}

/** The squarest and longest a rectangle dragged on the map gets, long side over short. */
export const ASPECT_MIN = 1;
export const ASPECT_MAX = 5;

/**
 * Which part of a print's outline a press at model point [x, y] (mm) takes
 * hold of: a rectangle's nearest side ('left', 'right', 'bottom' or 'top'),
 * or 'outline' for a shape that grows and shrinks about its centre.
 */
export function outlineEdge(shape, widthMm, aspect, [x, y]) {
  if (shape !== 'rectangle') return 'outline';
  const c = widthMm / 2, h = widthMm / aspect;
  const gaps = { left: Math.abs(x), right: Math.abs(x - widthMm), bottom: Math.abs(y - (c - h / 2)), top: Math.abs(y - (c + h / 2)) };
  return Object.keys(gaps).reduce((a, b) => (gaps[b] < gaps[a] ? b : a));
}

/**
 * A print reshaped by dragging its outline (taken hold of at edge, from
 * outlineEdge) from one {lat, lon} to another. print is { centre, sideKm,
 * widthMm, bearing, aspect }. The whole outline scales about the centre by
 * how much farther from it the pointer now is. A rectangle's side moves alone
 * and its opposite side stays put, so the centre moves half as far, and
 * moving a short side changes the aspect instead of the size across. Sizes
 * snap with snapSideKm and the aspect stays within ASPECT_MIN to ASPECT_MAX.
 * Returns { centre, sideKm, aspect }.
 */
export function dragOutline(print, edge, from, to) {
  const { centre, sideKm, widthMm, bearing = 0, aspect = 2 } = print;
  const frame = printFrame(centre, sideKm, widthMm, bearing);
  const kmPerMm = sideKm / widthMm, c = widthMm / 2;
  const [x0, y0] = frame.toMm(from.lon, from.lat), [x, y] = frame.toMm(to.lon, to.lat);
  if (edge === 'outline') {
    const r0 = Math.hypot(x0 - c, y0 - c);
    return { centre, sideKm: r0 > 0 ? snapSideKm((sideKm * Math.hypot(x - c, y - c)) / r0) : sideKm, aspect };
  }
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const at = (mx, my) => { const p = frame.toLonLat(mx, my); return { lat: p.lat, lon: p.lon }; };
  if (edge === 'left' || edge === 'right') {
    const shortKm = sideKm / aspect, sign = edge === 'right' ? 1 : -1;
    const longKm = clamp(snapSideKm((widthMm + sign * (x - x0)) * kmPerMm), Math.max(SIDE_MIN_KM, shortKm * ASPECT_MIN), Math.min(SIDE_MAX_KM, shortKm * ASPECT_MAX));
    const half = longKm / kmPerMm / 2;
    return { centre: at(edge === 'right' ? half : widthMm - half, c), sideKm: longKm, aspect: longKm / shortKm };
  }
  const h = widthMm / aspect, sign = edge === 'top' ? 1 : -1;
  const shortKm = clamp(snapSideKm((h + sign * (y - y0)) * kmPerMm), sideKm / ASPECT_MAX, sideKm / ASPECT_MIN);
  const half = shortKm / kmPerMm / 2;
  return { centre: at(c, edge === 'top' ? c - h / 2 + half : c + h / 2 - half), sideKm, aspect: sideKm / shortKm };
}

/**
 * The centre of the print one over from print ({ centre, sideKm, widthMm,
 * bearing, aspect }) across its side ('left', 'right', 'bottom' or 'top' of
 * the model), so the two share that side and print to sit edge to edge. A
 * rectangle steps by its long side across and its short side up and down.
 * Each frame is even in degrees at its own centre, so the step is solved for
 * the shared side's middle to land in the same place from both prints.
 */
export function neighbourCentre(print, shape, side) {
  const { centre, sideKm, widthMm, bearing = 0, aspect = 2 } = print;
  const c = widthMm / 2, h = shape === 'rectangle' ? widthMm / aspect : widthMm;
  const [dx, dy] = { left: [-widthMm, 0], right: [widthMm, 0], bottom: [0, -h], top: [0, h] }[side];
  const f = printFrame(centre, sideKm, widthMm, bearing);
  const meet = f.toLonLat(c + dx / 2, c + dy / 2);
  let next = f.toLonLat(c + dx, c + dy);
  for (let k = 0; k < 4; k++) {
    const p = printFrame(next, sideKm, widthMm, bearing).toLonLat(c - dx / 2, c - dy / 2);
    next = { lat: next.lat + meet.lat - p.lat, lon: next.lon + meet.lon - p.lon };
  }
  return next;
}

/**
 * A frame for part of another: the w-wide square whose bottom-left corner sits
 * at (x0, y0) mm on frame, with its own mm running 0 to w. A point two parts
 * share is the same ground from both, since both read it through frame.
 */
export function subFrame(frame, x0, y0, w) {
  const toLonLat = (x, y) => frame.toLonLat(x0 + x, y0 + y);
  const toMm = (lon, lat) => { const [x, y] = frame.toMm(lon, lat); return [x - x0, y - y0]; };
  const bounds = lonLatBounds([[0, 0], [w, 0], [w, w], [0, w]].map(([x, y]) => toLonLat(x, y)));
  return { toLonLat, toMm, bounds };
}

/** The lon/lat box a list of {lon, lat} fits in. */
export function lonLatBounds(points) {
  return {
    west: Math.min(...points.map((p) => p.lon)), east: Math.max(...points.map((p) => p.lon)),
    south: Math.min(...points.map((p) => p.lat)), north: Math.max(...points.map((p) => p.lat)),
  };
}

/** The most pieces a print splits into, across or down. */
export const PIECES_MAX = 3;

/**
 * A square print split into cols x rows square pieces, each widthMm across,
 * that sit edge to edge as one model. sideKm is the ground across the whole
 * set. Every piece is cut from one frame, cols x widthMm across and centred on
 * centre, so a side two pieces share is the same ground on both, with no drift
 * at the corners. Pieces are named by row from the top (A, B, C) and column
 * from the left (1, 2, 3), A1 at the top left, and listed in that order.
 * corners says which of a piece's corners (south-west, south-east, north-east,
 * north-west on the model) are corners of the whole set. Returns { frame,
 * acrossMm, downMm, bottomMm, pieceKm, pieces }: bottomMm is where the set's
 * lower edge sits on frame.
 */
export function piecePlan(centre, { sideKm, widthMm, bearing = 0, cols = 1, rows = 1 }) {
  const acrossMm = cols * widthMm, downMm = rows * widthMm;
  const frame = printFrame(centre, sideKm, acrossMm, bearing);
  const bottomMm = (acrossMm - downMm) / 2;
  const pieces = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x0 = c * widthMm, y0 = bottomMm + (rows - 1 - r) * widthMm;
      const f = subFrame(frame, x0, y0, widthMm);
      const top = r === 0, low = r === rows - 1, left = c === 0, right = c === cols - 1;
      pieces.push({
        name: `${String.fromCharCode(65 + r)}${c + 1}`, col: c, row: r, x0, y0, frame: f,
        centre: f.toLonLat(widthMm / 2, widthMm / 2),
        corners: [low && left, low && right, top && right, top && left],
      });
    }
  }
  return { frame, acrossMm, downMm, bottomMm, pieceKm: sideKm / cols, pieces };
}

const steps = (from, to, by) => Array.from({ length: Math.round((to - from) / by) + 1 }, (_, i) => from + i * by);
/**
 * The height stretch slider's stops: quarter steps up to x10, where most prints
 * sit, then coarser ones for the big squares, whose relief is a millimetre at x1.
 */
export const STRETCH_STOPS = [...steps(1, 10, 0.25), ...steps(11, 20, 1), ...steps(22.5, 50, 2.5)];

/** The stops with value among them, for a saved print whose stretch is between or past them. */
export function withStop(stops, value) {
  return stops.includes(value) ? stops : [...stops, value].sort((a, b) => a - b);
}

/**
 * The height stretch suggested for ground with reliefM of land (sea level up)
 * across sideKm, as a stop, or null with no land relief. The model's width
 * cancels out: what shows is relief against the ground across. Full stretch to
 * a set steepness would make flat ground a cartoon, so it takes the square
 * root, as raised-relief maps stretch big flat areas more but not in full.
 * 0.18 gives Mt Washington's 20 km its x1.5, Boston's 20 km about x6 and the
 * Alps across 100 km about x2.25; it stays within x1 to x20.
 */
export function suggestStretch(reliefM, sideKm) {
  if (!(reliefM > 0) || !(sideKm > 0)) return null;
  const want = Math.min(20, Math.max(1, Math.sqrt(0.18 / (reliefM / (sideKm * 1000)))));
  return STRETCH_STOPS.reduce((a, b) => (Math.abs(b - want) < Math.abs(a - want) ? b : a));
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

/** The most grid points a side a print takes, whatever its width and detail. */
export const MAX_CELLS = 1000;

/**
 * Grid points a side for a model widthMm across with about pitchMm between
 * them. Detail is a pitch rather than a count, so a wide model gets as fine a
 * grid as a narrow one: 0.4 mm, about a nozzle's line, is 301 points across
 * 120 mm and 626 across 250 mm.
 */
export function gridCells(widthMm, pitchMm) {
  return Math.max(10, Math.min(MAX_CELLS, Math.round(widthMm / pitchMm) + 1));
}

/**
 * The zoom whose pixels are at least as fine as the model's grid, within a
 * tile budget. A 626-point grid needs up to 64 tiles, so the budget leaves room.
 */
export function printZoom(center, sideKm, cells, maxTiles = 100) {
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
 * at sea level), and depths are stretched by depthStretch. used (from
 * shapeCells) limits the lowest and highest points to the grid points a shape
 * prints; the rest are scaled the same way and left unused. lowM puts the
 * base under that height instead of this grid's lowest point, so pieces of
 * one print, each under the lowest point of them all, meet at the same height.
 */
export function printHeights(heights, { sideKm, widthMm, exaggeration = 1, baseMm = 3, seaFloorM = 0, depthStretch = exaggeration, lowM = null }, used = null) {
  const floor = seaFloorM ? -seaFloorM : 0; // not -0, which would show as a lowest point of "-0 m"
  const metres = heights.map((h) => Math.max(floor, h));
  let lo = Infinity, hi = -Infinity;
  metres.forEach((h, k) => { if (used && !used[k]) return; if (h < lo) lo = h; if (h > hi) hi = h; });
  if (lowM != null) lo = lowM;
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
 * An n x n grid (row 0 at the top) read at m x m points by bilinear
 * interpolation, for a lighter preview. Its edges read only the source's
 * edges, so two grids that shared a side still do. m >= n returns z.
 */
export function resampleGrid(z, n, m) {
  if (m >= n) return z;
  const out = new Array(m * m), s = (n - 1) / (m - 1);
  for (let j = 0; j < m; j++) {
    const fy = j * s, j0 = Math.min(n - 2, Math.floor(fy)), ty = fy - j0;
    for (let i = 0; i < m; i++) {
      const fx = i * s, i0 = Math.min(n - 2, Math.floor(fx)), tx = fx - i0;
      const a = z[j0 * n + i0], b = z[j0 * n + i0 + 1], c = z[(j0 + 1) * n + i0], d = z[(j0 + 1) * n + i0 + 1];
      out[j * m + i] = (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
    }
  }
  return out;
}

/**
 * A KML of a print: the square as a polygon, a pin at its centre, and every
 * input and derived figure as ExtendedData, so Google Earth shows the area and
 * the settings, and parsePrintKml can rebuild the same STL from the file.
 * model is optional; without it only the inputs are written.
 */
export function printKml({ centre, set, model = null, stlFile = '', made = new Date() }) {
  const cols = set.cols ?? 1, rows = set.rows ?? 1, split = cols * rows > 1;
  const plan = split ? piecePlan(centre, set) : null;
  const frame = plan ? plan.frame : printFrame(centre, set.sideKm, set.widthMm, set.bearing ?? 0);
  const acrossMm = set.widthMm * cols;
  // a split print's ring is the whole set, its four outside corners
  const setRing = plan && [[0, plan.bottomMm], [acrossMm, plan.bottomMm], [acrossMm, plan.bottomMm + plan.downMm], [0, plan.bottomMm + plan.downMm]];
  const b = plan ? lonLatBounds(setRing.map(([x, y]) => frame.toLonLat(x, y))) : frame.bounds;
  const scale = Math.round((set.sideKm * 1e6) / acrossMm);
  const inputs = [
    ['reachFormat', 'Reach print format', PRINT_FORMAT],
    ['centreName', 'Centre', centre.name],
    // in full, so the file rebuilds the grid on the very same points
    ['centreLat', 'Centre latitude', String(centre.lat)],
    ['centreLon', 'Centre longitude', String(centre.lon)],
    ['squareKm', 'Square side (km)', set.sideKm],
    ['modelWidthMm', 'Model width (mm)', set.widthMm],
    ['gridCells', 'Detail (grid points per side)', set.cells],
    ['gridPitchMm', 'Detail (mm between grid points)', set.pitchMm ?? +(set.widthMm / (set.cells - 1)).toFixed(4)],
    ['heightStretch', 'Height stretch (x)', set.exaggeration],
    ['baseMm', 'Base under the lowest point (mm)', set.baseMm],
    ['seaFloorM', 'Sea floor down to (m, 0 cuts it at sea level)', set.seaFloorM ?? 0],
    ['depthStretch', 'Depth stretch (x)', set.depthStretch ?? set.exaggeration],
    ['shoreMm', 'Shoreline line size (mm, 0 for none)', set.shoreMm ?? 0],
    ['shoreRidge', 'Shoreline as a ridge (1) or a groove (0)', set.shoreRidge ? 1 : 0],
    ['bottomLabel', 'Label cut into the underside (1 yes, 0 no)', set.label ? 1 : 0],
    ['bottomText', 'Own text cut into the underside, a line a line', set.labelText ?? ''],
    ['cornerMm', 'Corner radius (mm, 0 for square)', set.cornerMm ?? 0],
    ['shape', 'Shape', set.shape ?? 'square'],
    ['aspect', 'Rectangle: long side over short side', set.aspect ?? 2],
    ['bearingDeg', 'Top of the model faces (degrees clockwise from north)', set.bearing ?? 0],
    ['buildings', 'Buildings from OpenStreetMap (1 yes, 0 no)', set.buildings ? 1 : 0],
    ['buildingDefaultM', 'Building height where OSM has none (m)', set.buildingDefaultM ?? DEFAULT_BUILDING_M],
    ...Object.keys(ROAD_CLASSES).map((cls) => [`${cls}Mm`, `${cap(cls)} roads from OpenStreetMap (mm up, negative sunk, 0 for none)`, set.roadMm?.[cls] ?? 0]),
    ...Object.entries(WATER_KEYS).map(([kind, k]) => [k, `${WATER_KINDS[kind]} from OpenStreetMap (mm up, negative sunk, 0 for none)`, set.waterMm?.[kind] ?? 0]),
    ['piecesAcross', 'Pieces across (each one model width)', cols],
    ['piecesDown', 'Pieces down', rows],
  ];
  const derived = [
    ['boundsNorth', 'North edge', b.north.toFixed(6)],
    ['boundsSouth', 'South edge', b.south.toFixed(6)],
    ['boundsEast', 'East edge', b.east.toFixed(6)],
    ['boundsWest', 'West edge', b.west.toFixed(6)],
    ['mapScale', 'Map scale', `1:${scale}`],
    ['mmPerKmAcross', 'Model mm per km across', +(acrossMm / set.sideKm).toFixed(4)],
    ['elevationSource', 'Elevation data', 'Mapzen Terrain Tiles on AWS (Terrarium)'],
  ];
  if (model) {
    const vertical = 1 / ((acrossMm / (set.sideKm * 1000)) * set.exaggeration);
    derived.push(
      ['elevationZoom', 'Elevation tile zoom', model.zoom],
      ['metresPerPixel', 'Elevation detail (m per pixel)', Math.round(model.pixelM)],
      ...(model.seaZoom != null ? [
        ['seaFloorZoom', 'Sea floor tile zoom', model.seaZoom],
        ['seaFloorMetresPerPixel', 'Sea floor detail (m per pixel)', Math.round(model.seaPixelM)],
      ] : []),
      ['gridSpacingM', 'Grid spacing (m)', Math.round((set.sideKm * 1000) / cols / (set.cells - 1))],
      ['lowestM', 'Lowest point (m)', Math.round(model.lowM)],
      ['highestM', 'Highest point (m)', Math.round(model.highM)],
      ['reliefMm', 'Relief on the model (mm)', +model.reliefMm.toFixed(2)],
      ['modelHeightMm', 'Model height overall (mm)', +(set.baseMm + model.reliefMm).toFixed(2)],
      ['metresPerMmVertical', 'Metres of ground per mm of model height', +vertical.toFixed(2)],
      ['triangles', 'STL triangles', model.triangles],
    );
    if (model.label?.depthMm) {
      derived.push(
        ['labelText', 'Label text', model.label.lines.join(' / ')],
        ['labelLetterMm', 'Label letter height (mm)', +(model.label.pxMm * 7).toFixed(2)],
        ['labelDepthMm', 'Label depth (mm)', +model.label.depthMm.toFixed(2)],
      );
    }
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
    if (model.roads) {
      const r = model.roads;
      derived.push(
        ...Object.keys(ROAD_CLASSES).map((cls) => [`${cls}Km`, `${cap(cls)} roads printed (km)`, +(r.km[cls] || 0).toFixed(1)]),
        ['roadSource', 'Road data', `OpenStreetMap contributors (ODbL), read ${r.readAt}`],
      );
    }
    if (model.water) {
      derived.push(
        ['lakesKm2', 'Lakes printed (km²)', +(model.water.lakesKm2 || 0).toFixed(2)],
        ['wideRiversKm2', 'Wide rivers printed (km²)', +(model.water.wideKm2 || 0).toFixed(2)],
        ['riverKm', 'Narrow rivers printed (km)', +(model.water.riverKm || 0).toFixed(1)],
        ['waterSource', 'Water data', `OpenStreetMap contributors (ODbL), read ${model.water.readAt}`],
      );
    }
  }
  if (stlFile) derived.push(['stlFile', 'STL file', stlFile]);
  derived.push(['made', 'Made', made.toISOString()]);

  const data = (rows) => rows.map(([k, label, v]) =>
    `      <Data name="${k}"><displayName>${escapeXml(label)}</displayName><value>${escapeXml(v)}</value></Data>`).join('\n');
  const table = (rows) => rows.filter(([k]) => k !== 'reachFormat')
    .map(([, label, v]) => `<tr><td>${escapeXml(label)}</td><td>${escapeXml(v)}</td></tr>`).join('');
  const shape = set.shape ?? 'square';
  const description = split
    ? `<![CDATA[<p>${set.sideKm} km of terrain across as ${cols} × ${rows} pieces of ${set.widthMm} mm that sit edge to edge. Open this file in Reach's Print tab to build the same STLs.</p>`
    : `<![CDATA[<p>A ${set.sideKm} km ${shape} of terrain as a ${set.widthMm} mm model. Open this file in Reach's Print tab to build the same STL.</p>`;
  const tables = `<table>${table(inputs)}${table(derived)}</table>]]>`;
  const outline = setRing || shapeOutline(shape, set.widthMm, { aspect: set.aspect, cornerMm: shape === 'square' ? 0 : set.cornerMm }).ring;
  const ring = [...outline, outline[0]].filter((_, k, all) => all.length < 200 || k % 10 === 0 || k === all.length - 1)
    .map(([x, y]) => { const p = frame.toLonLat(x, y); return [p.lon, p.lat]; });
  // A set of pieces adds each piece's own outline, named as its label names it.
  const w = set.widthMm;
  const piecePlacemarks = plan ? plan.pieces.map((p) => {
    const corners = [[0, 0], [w, 0], [w, w], [0, w], [0, 0]].map(([x, y]) => { const g = p.frame.toLonLat(x, y); return [g.lon, g.lat]; });
    return `  <Placemark><name>Piece ${p.name}</name><styleUrl>#piece</styleUrl><Polygon><tessellate>1</tessellate><outerBoundaryIs><LinearRing><coordinates>${coordText(corners)}</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>
`;
  }).join('') : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
<Document>
  <name>${escapeXml(`Reach print: ${centre.name}, ${set.sideKm} km`)}</name>
  <Style id="square"><LineStyle><color>ff24548f</color><width>3</width></LineStyle><PolyStyle><color>2224548f</color></PolyStyle></Style>${plan ? `
  <Style id="piece"><LineStyle><color>ff24548f</color><width>1.5</width></LineStyle><PolyStyle><fill>0</fill></PolyStyle></Style>` : ''}
  <Placemark id="reach-print">
    <name>${escapeXml(`${set.sideKm} km print area`)}</name>
    <description>${description}${tables}</description>
    <styleUrl>#square</styleUrl>
    <ExtendedData>
${data(inputs)}
${data(derived)}
    </ExtendedData>
    <Polygon><tessellate>1</tessellate><outerBoundaryIs><LinearRing><coordinates>${coordText(ring)}</coordinates></LinearRing></outerBoundaryIs></Polygon>
  </Placemark>
${piecePlacemarks}  <Placemark><name>${escapeXml(centre.name)}</name><Point><coordinates>${centre.lon.toFixed(6)},${centre.lat.toFixed(6)},0</coordinates></Point></Placemark>
</Document>
</kml>
`;
}

export const PRINT_FORMAT = 'reach-print-1';
/** Each kind of water's key in a print's KML. */
const WATER_KEYS = { lakes: 'lakesMm', wide: 'wideRiversMm', narrow: 'narrowRiversMm' };
const cap = (w) => `${w[0].toUpperCase()}${w.slice(1)}`;

const shapeName = (v) => {
  if (!PRINT_SHAPES.includes(v)) throw new Error(`the file's shape "${v}" is not one Reach prints`);
  return v;
};

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
  const widthMm = num('modelWidthMm', 10, 1000);
  const cells = Math.round(num('gridCells', 10, MAX_CELLS));
  return {
    centre: { name: values.centreName || 'Saved print', lat: num('centreLat', -85, 85), lon: num('centreLon', -180, 180) },
    set: {
      sideKm: num('squareKm', 0.1, 1000),
      widthMm,
      cells,
      // files from before detail was a pitch have only the count
      pitchMm: values.gridPitchMm == null ? widthMm / (cells - 1) : num('gridPitchMm', 0.01, 100),
      exaggeration,
      baseMm: num('baseMm', 0, 100),
      // files from before the sea floor cut it at sea level
      seaFloorM: values.seaFloorM == null ? 0 : num('seaFloorM', 0, 11100),
      depthStretch: values.depthStretch == null ? exaggeration : num('depthStretch', 0.1, 100),
      // files from before the shoreline have none
      shoreMm: values.shoreMm == null ? 0 : num('shoreMm', 0, 10),
      shoreRidge: values.shoreRidge === '1',
      // files from before the label have none
      label: values.bottomLabel === '1',
      // files from before their own text have none
      labelText: values.bottomText ?? '',
      // files from before rounded corners are square
      cornerMm: values.cornerMm == null ? 0 : num('cornerMm', 0, 100),
      // files from before shapes are squares with north up
      shape: values.shape == null ? 'square' : shapeName(values.shape),
      aspect: values.aspect == null ? 2 : num('aspect', 1, 20),
      bearing: values.bearingDeg == null ? 0 : num('bearingDeg', -360, 360),
      // files from before buildings have none
      buildings: values.buildings === '1',
      buildingDefaultM: values.buildingDefaultM == null ? DEFAULT_BUILDING_M : num('buildingDefaultM', 1, 100),
      // files from before roads have none, and from before a level for each class have them raised as they were
      roadMm: Object.fromEntries(Object.keys(ROAD_CLASSES).map((cls) => [cls,
        values[`${cls}Mm`] != null ? num(`${cls}Mm`, -10, 10) : values.roads === '1' ? ROAD_LEVELS[cls] : 0])),
      // files from before lakes and rivers have none, and from before a level for each kind have them all sunk one depth
      waterMm: Object.fromEntries(Object.entries(WATER_KEYS).map(([kind, k]) => [kind,
        values[k] != null ? num(k, -10, 10) : values.waterMm != null ? -num('waterMm', 0, 10) : 0])),
      // files from before pieces are one piece
      cols: values.piecesAcross == null ? 1 : Math.round(num('piecesAcross', 1, PIECES_MAX)),
      rows: values.piecesDown == null ? 1 : Math.round(num('piecesDown', 1, PIECES_MAX)),
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

// ---------- the label under a print ----------

/** A 5 x 7 block font for the label, '#' for ink and row 0 at the top. Narrow glyphs are narrow strings. */
const FONT = {
  ' ': ['...', '...', '...', '...', '...', '...', '...'],
  '.': ['..', '..', '..', '..', '..', '##', '##'],
  '-': ['...', '...', '...', '###', '...', '...', '...'],
  ':': ['..', '##', '##', '..', '##', '##', '..'],
  '°': ['###', '#.#', '###', '...', '...', '...', '...'],
  '×': ['.....', '#...#', '.#.#.', '..#..', '.#.#.', '#...#', '.....'],
  ',': ['..', '..', '..', '..', '##', '.#', '#.'],
  "'": ['#', '#', '.', '.', '.', '.', '.'],
  '’': ['#', '#', '.', '.', '.', '.', '.'],
  '!': ['#', '#', '#', '#', '#', '.', '#'],
  '?': ['.###.', '#...#', '....#', '...#.', '..#..', '.....', '..#..'],
  '&': ['.##..', '#..#.', '#.#..', '.#...', '#.#.#', '#..#.', '.##.#'],
  '/': ['....#', '....#', '...#.', '..#..', '.#...', '#....', '#....'],
  '(': ['.#', '#.', '#.', '#.', '#.', '#.', '.#'],
  ')': ['#.', '.#', '.#', '.#', '.#', '.#', '#.'],
  '+': ['.....', '..#..', '..#..', '#####', '..#..', '..#..', '.....'],
  '#': ['.#.#.', '.#.#.', '#####', '.#.#.', '#####', '.#.#.', '.#.#.'],
  0: ['.###.', '#...#', '#..##', '#.#.#', '##..#', '#...#', '.###.'],
  1: ['..#..', '.##..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  2: ['.###.', '#...#', '....#', '...#.', '..#..', '.#...', '#####'],
  3: ['#####', '...#.', '..#..', '...#.', '....#', '#...#', '.###.'],
  4: ['...#.', '..##.', '.#.#.', '#..#.', '#####', '...#.', '...#.'],
  5: ['#####', '#....', '####.', '....#', '....#', '#...#', '.###.'],
  6: ['..##.', '.#...', '#....', '####.', '#...#', '#...#', '.###.'],
  7: ['#####', '....#', '...#.', '..#..', '.#...', '.#...', '.#...'],
  8: ['.###.', '#...#', '#...#', '.###.', '#...#', '#...#', '.###.'],
  9: ['.###.', '#...#', '#...#', '.####', '....#', '...#.', '.##..'],
  A: ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  B: ['####.', '#...#', '#...#', '####.', '#...#', '#...#', '####.'],
  C: ['.###.', '#...#', '#....', '#....', '#....', '#...#', '.###.'],
  D: ['####.', '#...#', '#...#', '#...#', '#...#', '#...#', '####.'],
  E: ['#####', '#....', '#....', '####.', '#....', '#....', '#####'],
  F: ['#####', '#....', '#....', '####.', '#....', '#....', '#....'],
  G: ['.###.', '#...#', '#....', '#.###', '#...#', '#...#', '.####'],
  H: ['#...#', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  I: ['###', '.#.', '.#.', '.#.', '.#.', '.#.', '###'],
  J: ['..###', '...#.', '...#.', '...#.', '...#.', '#..#.', '.##..'],
  K: ['#...#', '#..#.', '#.#..', '##...', '#.#..', '#..#.', '#...#'],
  L: ['#....', '#....', '#....', '#....', '#....', '#....', '#####'],
  M: ['#...#', '##.##', '#.#.#', '#.#.#', '#...#', '#...#', '#...#'],
  N: ['#...#', '#...#', '##..#', '#.#.#', '#..##', '#...#', '#...#'],
  O: ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  P: ['####.', '#...#', '#...#', '####.', '#....', '#....', '#....'],
  Q: ['.###.', '#...#', '#...#', '#...#', '#.#.#', '#..#.', '.##.#'],
  R: ['####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#'],
  S: ['.####', '#....', '#....', '.###.', '....#', '....#', '####.'],
  T: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
  U: ['#...#', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  V: ['#...#', '#...#', '#...#', '#...#', '#...#', '.#.#.', '..#..'],
  W: ['#...#', '#...#', '#...#', '#.#.#', '#.#.#', '#.#.#', '.#.#.'],
  X: ['#...#', '#...#', '.#.#.', '..#..', '.#.#.', '#...#', '#...#'],
  Y: ['#...#', '#...#', '.#.#.', '..#..', '..#..', '..#..', '..#..'],
  Z: ['#####', '....#', '...#.', '..#..', '.#...', '#....', '#####'],
};

/** How deep the letters are cut into the underside, and the least model left over them (mm). */
export const LABEL_DEPTH_MM = 0.6;
export const LABEL_ROOF_MM = 0.6;
/** The size of one font pixel on the model (mm): under the least, the strokes are too fine to print. */
const LABEL_MAX_PX = 1;
const LABEL_MIN_PX = 0.5;

/** How much of their own text a label takes: lines, and characters a line. */
export const LABEL_TEXT_LINES = 3;
export const LABEL_TEXT_CHARS = 30;

/** Text typed for a label as its lines: upper case, blank lines dropped, cut to LABEL_TEXT_LINES of LABEL_TEXT_CHARS. */
export function customLines(text = '') {
  return text.split(/\r?\n/).map((l) => l.trim().replace(/\s+/g, ' ').toUpperCase().slice(0, LABEL_TEXT_CHARS))
    .filter(Boolean).slice(0, LABEL_TEXT_LINES);
}

/** The characters in text the label's font doesn't have, once each: they print as spaces. */
export function unprintable(text = '') {
  return [...new Set([...text.toUpperCase()].filter((ch) => !FONT[ch] && !/\s/.test(ch)))];
}

/**
 * What the label under a print says: set.labelText's lines (customLines),
 * then with set.label the centre, the ground covered, and the height
 * stretch, with the depth stretch when the sea floor has its own. wrap is
 * the line the coordinates are on, or null without them.
 */
export function labelLines(centre, set, piece = null) {
  const own = [...(piece ? [pieceLine(piece, set)] : []), ...customLines(set.labelText)];
  return { lines: [...own, ...(set.label ? infoLines(centre, set) : [])], wrap: set.label ? own.length : null };
}

/** Where a piece goes in its set, for its label: "A2 OF 3 × 2". */
export function pieceLine(piece, { cols = 1, rows = 1 }) {
  return `${piece} OF ${cols} × ${rows}`;
}

function infoLines(centre, set) {
  const deg = (v, pos, neg) => `${Math.abs(v).toFixed(4)}°${v >= 0 ? pos : neg}`;
  const shape = set.shape || 'square';
  const ground = shape === 'square' ? `${set.sideKm} × ${+((set.sideKm * (set.rows ?? 1)) / (set.cols ?? 1)).toFixed(2)} KM`
    : shape === 'rectangle' ? `${set.sideKm} × ${+(set.sideKm / set.aspect).toFixed(2)} KM`
      : `${set.sideKm} KM ${shape.toUpperCase()}`;
  const lines = [`${deg(centre.lat, 'N', 'S')} ${deg(centre.lon, 'E', 'W')}`, ground, `VERTICAL ×${set.exaggeration}`];
  if (set.seaFloorM > 0 && set.depthStretch !== set.exaggeration) lines.push(`DEPTH ×${set.depthStretch}`);
  if (set.bearing) lines.push(`TOP FACES ${((set.bearing % 360) + 360) % 360}°`);
  return lines;
}

/**
 * Lines of text as an ink grid (row 0 at the top), each line centred with two
 * font pixels between lines, at two cells to the font pixel. Two pixels of a
 * diagonal meet only at a corner, which would pinch the solid to an edge; at
 * two cells a pixel, a cell either side of the corner bridges them evenly.
 */
export function textInk(lines) {
  const glyphs = lines.map((s) => [...s.toUpperCase()].map((ch) => FONT[ch] || FONT[' ']));
  const widths = glyphs.map((g) => g.reduce((w, rows) => w + rows[0].length, 0) + g.length - 1);
  const fw = Math.max(...widths), fh = lines.length * 9 - 2;
  const font = Array.from({ length: fh }, () => new Uint8Array(fw));
  glyphs.forEach((line, l) => {
    let x = Math.floor((fw - widths[l]) / 2);
    for (const rows of line) {
      rows.forEach((row, r) => { for (let c = 0; c < row.length; c++) if (row[c] === '#') font[l * 9 + r][x + c] = 1; });
      x += rows[0].length + 1;
    }
  });
  const w = fw * 2, h = fh * 2;
  const ink = Array.from({ length: h }, (_, r) => Uint8Array.from({ length: w }, (_, c) => font[r >> 1][c >> 1]));
  for (let r = 0; r < fh - 1; r++) {
    for (let c = 0; c < fw - 1; c++) {
      const a = font[r][c], b = font[r][c + 1], d = font[r + 1][c], e = font[r + 1][c + 1];
      const R = 2 * r + 1, C = 2 * c + 1; // the cell up and left of the corner they share
      if (a && e && !b && !d) { ink[R][C + 1] = 1; ink[R + 1][C] = 1; }
      else if (b && d && !a && !e) { ink[R][C] = 1; ink[R + 1][C + 1] = 1; }
    }
  }
  return { ink, w, h };
}

/** How big the north arrow is, in font pixels: about two lines of text. */
const ARROW_PX = 14;

/**
 * An arrow on an ink grid size cells square (row 0 at the top), pointing deg
 * degrees clockwise from up: a shaft and a head. Cells meeting only at a
 * corner are bridged with a third, as the font's are.
 */
export function arrowInk(deg, size) {
  const dx = Math.sin(deg * RAD), dy = -Math.cos(deg * RAD), c = size / 2;
  const ink = Array.from({ length: size }, (_, r) => Uint8Array.from({ length: size }, (_, col) => {
    const px = col + 0.5 - c, py = r + 0.5 - c;
    const along = (px * dx + py * dy) / size, across = Math.abs(px * dy - py * dx) / size;
    const shaft = along >= -0.46 && along <= 0.12 && across <= 0.075;
    const head = along >= 0.08 && along <= 0.48 && across <= 0.27 * ((0.48 - along) / 0.4);
    return shaft || head ? 1 : 0;
  }));
  for (let changed = true; changed;) {
    changed = false;
    for (let r = 0; r < size - 1; r++) {
      for (let col = 0; col < size - 1; col++) {
        const a = ink[r][col], b = ink[r][col + 1], d = ink[r + 1][col], e = ink[r + 1][col + 1];
        if ((a && e && !b && !d) || (b && d && !a && !e)) { ink[r][a ? col + 1 : col] = 1; changed = true; }
      }
    }
  }
  return ink;
}

/**
 * The label's ink: its lines (textInk), and with north given, an arrow
 * pointing north and an N above them. north is the bearing the print's top
 * faces; the ink reads as the label does from underneath, so the arrow leans
 * north degrees clockwise.
 */
export function labelInk(lines, north = null) {
  const text = textInk(lines);
  if (north == null) return text;
  const size = ARROW_PX * 2, gap = 8;
  const arrow = arrowInk(north, size);
  const letter = textInk(['N']);
  const topW = size + gap + letter.w;
  const w = Math.max(text.w, topW), h = size + gap + text.h;
  const ink = Array.from({ length: h }, () => new Uint8Array(w));
  const ax = Math.floor((w - topW) / 2), tx = Math.floor((w - text.w) / 2);
  arrow.forEach((row, r) => row.forEach((v, col) => { if (v) ink[r][ax + col] = 1; }));
  const ly = Math.floor((size - letter.h) / 2);
  letter.ink.forEach((row, r) => row.forEach((v, col) => { if (v) ink[ly + r][ax + size + gap + col] = 1; }));
  text.ink.forEach((row, r) => row.forEach((v, col) => { if (v) ink[size + gap + r][tx + col] = 1; }));
  return { ink, w, h };
}

/**
 * The label to cut into the underside of an n x n print widthMm across: the
 * lines in the font, as large as fits (the coordinates go on two lines when
 * that makes them larger), centred and mirrored so they read when the print
 * is turned over, the model's top still at the top. With north (the bearing
 * the top faces), an arrow above them points north. wrap is the line
 * with the coordinates on it, or null to keep every line whole. Returns { lines, pxMm,
 * depthMm, cellMm, ink, w, h, mid, midY }: the ink grid with a millimetre or
 * so of bare bed around it, cellMm to a cell, centred on mid, midY; or { why }
 * when the label can't be cut.
 */
export function bottomLabel(lines, zMm, n, widthMm, shape = null, north = null, wrap = 0) {
  const layouts = wrap == null ? [lines] : [lines, [...lines.slice(0, wrap), ...lines[wrap].split(' '), ...lines.slice(wrap + 1)]];
  const [mid, midY] = shape ? shape.centre : [widthMm / 2, widthMm / 2];
  const padOf = (pxMm) => Math.ceil(2 / pxMm); // a millimetre or so of cells
  // Within a shape, the box and a millimetre round it must clear the outline.
  const fits = (text, pxMm) => {
    if (!shape) return true;
    const pad = padOf(pxMm);
    const hw = ((text.w + 2 * pad) / 2) * (pxMm / 2) + 1, hh = ((text.h + 2 * pad) / 2) * (pxMm / 2) + 1;
    const corners = [[mid - hw, midY - hh], [mid + hw, midY - hh], [mid + hw, midY + hh], [mid - hw, midY + hh]];
    return corners.every((p) => inRing(p, shape.ring)) &&
      !shape.ring.some(([x, y]) => Math.abs(x - mid) < hw && Math.abs(y - midY) < hh);
  };
  let best = null;
  for (const l of layouts) {
    const text = labelInk(l, north);
    let pxMm = Math.min(LABEL_MAX_PX, (widthMm * 0.85) / (text.w / 2), (widthMm * 0.6) / (text.h / 2));
    while (pxMm >= LABEL_MIN_PX && !fits(text, pxMm)) pxMm *= 0.97;
    if (!best || pxMm > best.pxMm) best = { lines: l, text, pxMm };
  }
  const { text, pxMm } = best;
  if (pxMm < LABEL_MIN_PX) return { why: `a ${widthMm} mm ${shape ? 'shape' : 'model'} is too small for letters that print` };
  const cellMm = pxMm / 2;
  const pad = padOf(pxMm);
  const w = text.w + 2 * pad, h = text.h + 2 * pad;
  const ink = Array.from({ length: h }, (_, r) => Uint8Array.from({ length: w }, (_, c) => text.ink[r - pad]?.[c - pad] || 0));
  // the thinnest model over the label, a grid point either side of it
  const x0 = mid - (w / 2) * cellMm, x1 = mid + (w / 2) * cellMm, y0 = midY - (h / 2) * cellMm, y1 = midY + (h / 2) * cellMm;
  const step = widthMm / (n - 1);
  let low = Infinity;
  for (let i = Math.max(0, Math.floor(x0 / step) - 1); i <= Math.min(n - 1, Math.ceil(x1 / step) + 1); i++) {
    for (let j = Math.max(0, Math.floor(n - 1 - y1 / step) - 1); j <= Math.min(n - 1, Math.ceil(n - 1 - y0 / step) + 1); j++) {
      low = Math.min(low, zMm[j * n + i]);
    }
  }
  const depthMm = Math.min(LABEL_DEPTH_MM, low - LABEL_ROOF_MM);
  if (depthMm < 0.3) return { why: `the model is only ${low.toFixed(1)} mm thick over it` };
  return { lines: best.lines, pxMm, depthMm, cellMm, ink, w, h, mid, midY };
}

/**
 * The bottom of a print with a label cut up into it, as triangles. perim is
 * the bottom edge of the walls at z = 0, counter-clockwise from the south-west
 * corner, n - 1 points a side. The label's box is a grid of cells, each on the
 * bed or, under ink, the ceiling of a pocket depthMm up, with a wall wherever
 * the two meet; the strip between the box and the edge is fanned from the
 * corners. Every point on a straight edge is kept, so every edge is matched.
 */
function labelledBottom(label, perim, n) {
  const tris = [];
  const sides = labelSides(label);
  for (let s = 0; s < 4; s++) {
    const edge = Array.from({ length: n }, (_, k) => perim[(s * (n - 1) + k) % perim.length]);
    const box = sides[s];
    for (let k = 0; k < n - 1; k++) tris.push(box[0], edge[k + 1], edge[k]);
    for (let k = 0; k < box.length - 1; k++) tris.push(edge[n - 1], box[k], box[k + 1]);
  }
  return tris.concat(labelCells(label));
}

/** A label grid's corner (gx, gy), counted from its top left as it reads from underneath: mirrored. */
const labelPoint = ({ w, h, cellMm, mid, midY = mid }) => (gx, gy, z = 0) => [mid + (w / 2 - gx) * cellMm, midY + (h / 2 - gy) * cellMm, z];

/** The label box's four sides on the bed, south, east, north, west, counter-clockwise, every grid point kept. */
function labelSides(label) {
  const { w, h } = label;
  const P = labelPoint(label);
  return [
    Array.from({ length: w + 1 }, (_, k) => P(w - k, h)), // south, west to east
    Array.from({ length: h + 1 }, (_, k) => P(0, h - k)), // east, south to north
    Array.from({ length: w + 1 }, (_, k) => P(k, 0)), // north, east to west
    Array.from({ length: h + 1 }, (_, k) => P(w, k)), // west, north to south
  ];
}

/** The label box's cells as triangles: bed, or the ceilings of the letters' pockets, and the pockets' walls. */
function labelCells(label) {
  const { ink, w, h, depthMm } = label;
  const P = labelPoint(label);
  const tris = [];
  const wall = (p, q) => { // facing right of p to q, into the pocket
    const p0 = [p[0], p[1], 0], q0 = [q[0], q[1], 0], pd = [p[0], p[1], depthMm], qd = [q[0], q[1], depthMm];
    tris.push(p0, q0, qd, p0, qd, pd);
  };
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      const z = ink[r][c] ? depthMm : 0;
      const ne = P(c, r, z), nw = P(c + 1, r, z), sw = P(c + 1, r + 1, z), se = P(c, r + 1, z);
      tris.push(sw, nw, ne, sw, ne, se); // facing down
      if (!ink[r][c]) continue;
      if (!ink[r - 1][c]) wall(nw, ne);
      if (!ink[r + 1][c]) wall(se, sw);
      if (!ink[r][c - 1]) wall(ne, se);
      if (!ink[r][c + 1]) wall(sw, nw);
    }
  }
  return tris;
}

/**
 * A point of a widthMm square print moved so the square's corners are rounded
 * to radius rMm. Only the rMm x rMm box at each corner moves: each point there
 * slides toward the arc's centre, along its ray, so the box's square outline
 * lands on the arc and its inner sides stay put. One smooth map for every
 * point, so a closed mesh stays closed, walls stay upright, and the ground
 * within a corner is squeezed by at most 0.41 rMm.
 */
export function roundCorner(p, widthMm, rMm, corners = null) {
  const cx = p[0] < rMm ? rMm : p[0] > widthMm - rMm ? widthMm - rMm : null;
  const cy = p[1] < rMm ? rMm : p[1] > widthMm - rMm ? widthMm - rMm : null;
  if (cx == null || cy == null) return p;
  if (corners && !corners[cy === rMm ? (cx === rMm ? 0 : 1) : (cx === rMm ? 3 : 2)]) return p;
  const dx = p[0] - cx, dy = p[1] - cy;
  const len = Math.hypot(dx, dy);
  if (!len) return p;
  const k = Math.max(Math.abs(dx), Math.abs(dy)) / len;
  return [cx + dx * k, cy + dy * k, p[2]];
}

/**
 * A closed, printable binary STL of an n x n height grid (row 0 north): the
 * terrain on top, four walls down to z = 0, and a bottom fanned from its centre.
 * Every edge is shared by exactly two triangles, so slicers take it as solid.
 * extra is more triangles (three points each) to write after the terrain's,
 * such as buildingTriangles. label (from bottomLabel) cuts its letters up
 * into the bottom. cornerMm rounds the corners (roundCorner), so they are
 * slower to lift off the bed; corners (south-west, south-east, north-east,
 * north-west, true to round) limits it to some, the outside corners of a set
 * of pieces.
 */
export function terrainStl(zMm, n, widthMm, extra = [], label = null, cornerMm = 0, corners = null) {
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
    if (!label) tri(centre, bot1, bot0); // bottom, facing down
  }
  if (label) for (const p of labelledBottom(label, ring.map(([i, j]) => [X(i), Y(j), 0]), n)) tris.push(p);
  for (const p of extra) tris.push(p);
  const r = Math.min(cornerMm, widthMm / 2);
  if (r > 0) for (let k = 0; k < tris.length; k++) tris[k] = roundCorner(tris[k], widthMm, r, corners);
  return writeStl(tris);
}

/** Triangles (three points each) as a binary STL, each with its normal. */
export function writeStl(tris) {
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

// ---------- print shapes ----------

/** The outlines a print can take. A square keeps the whole grid, and its own mesh (terrainStl). */
export const PRINT_SHAPES = ['square', 'rectangle', 'circle', 'hexagon', 'triangle', 'star'];
/** How far out a star's inner corners sit, as a share of its points' reach: fatter than a drawn star, so the points print. */
const STAR_INNER = 0.5;

/**
 * Corner v of an outline running counter-clockwise from p to q, rounded to
 * radius rMm when it turns left (an outward corner), as the points of the
 * arc. A corner too sharp for the radius gets the largest arc that leaves
 * half of each side. A corner turning right, or rMm of 0, stays a point.
 */
function roundVertex(p, v, q, rMm) {
  const ax = p[0] - v[0], ay = p[1] - v[1], bx = q[0] - v[0], by = q[1] - v[1];
  const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
  if (rMm <= 0 || ax * by - ay * bx >= 0) return [v]; // not a left turn
  const half = Math.acos(Math.max(-1, Math.min(1, (ax * bx + ay * by) / (la * lb)))) / 2; // half the corner's angle
  const d = Math.min(rMm / Math.tan(half), la / 2, lb / 2); // from the corner to where the arc meets each side
  const r = d * Math.tan(half);
  const ux = ax / la + bx / lb, uy = ay / la + by / lb, ul = Math.hypot(ux, uy);
  const cx = v[0] + (ux / ul) * (r / Math.sin(half)), cy = v[1] + (uy / ul) * (r / Math.sin(half));
  const from = Math.atan2(v[1] + (ay / la) * d - cy, v[0] + (ax / la) * d - cx);
  const sweep = Math.PI - 2 * half;
  const parts = Math.max(2, Math.ceil(sweep / (Math.PI / 32)));
  return Array.from({ length: parts + 1 }, (_, s) => {
    const a = from + (sweep * s) / parts;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  });
}

/** A ring without a point repeated next to itself (or the last on the first). */
function dedupe(ring) {
  return ring.filter((p, k) => {
    const q = ring[(k + 1) % ring.length];
    return Math.abs(p[0] - q[0]) > 1e-9 || Math.abs(p[1] - q[1]) > 1e-9;
  });
}

/**
 * A print's outline in model millimetres, counter-clockwise, centred in the
 * widthMm square and as wide as it: a rectangle aspect times as wide as it is
 * tall, a hexagon flat on top and bottom, and a triangle and five-pointed star
 * pointing up (the star's points reach a circle widthMm across). cornerMm
 * rounds the outward corners; a circle has none, and a star's inner corners
 * stay sharp. Returns { ring, pieces, centre }: pieces are convex polygons
 * that make up the shape, to cut buildings to, and centre is where its label
 * goes (a triangle's sits a third of the way up).
 */
export function shapeOutline(shape, widthMm, { aspect = 2, cornerMm = 0 } = {}) {
  const c = widthMm / 2;
  const polar = (k, count, r, start = 0) => {
    const a = start + (2 * Math.PI * k) / count;
    return [c + r * Math.cos(a), c + r * Math.sin(a)];
  };
  if (shape === 'circle') {
    const ring = Array.from({ length: 720 }, (_, k) => polar(k, 720, c));
    return { ring, pieces: [ring], centre: [c, c] };
  }
  let corners, centre = [c, c];
  if (shape === 'rectangle') {
    const h = widthMm / aspect;
    corners = [[0, c - h / 2], [widthMm, c - h / 2], [widthMm, c + h / 2], [0, c + h / 2]];
  } else if (shape === 'hexagon') {
    corners = Array.from({ length: 6 }, (_, k) => polar(k, 6, c));
  } else if (shape === 'triangle') {
    const h = (widthMm * Math.sqrt(3)) / 2, y0 = c - h / 2;
    corners = [[0, y0], [widthMm, y0], [c, y0 + h]];
    centre = [c, y0 + h / 3];
  } else if (shape === 'star') {
    corners = Array.from({ length: 10 }, (_, k) => polar(k, 10, k % 2 ? c * STAR_INNER : c, Math.PI / 2));
  } else {
    corners = [[0, 0], [widthMm, 0], [widthMm, widthMm], [0, widthMm]];
  }
  const m = corners.length;
  const arcs = corners.map((v, k) => roundVertex(corners[(k + m - 1) % m], v, corners[(k + 1) % m], cornerMm));
  const ring = dedupe(arcs.flat());
  // A star is five kites, each from the middle out to a point and its two inner corners.
  const pieces = shape !== 'star' ? [ring]
    : arcs.flatMap((arc, k) => (k % 2 ? [] : [dedupe([[c, c], ...arcs[(k + m - 1) % m], ...arc, ...arcs[k + 1]])]));
  return { ring, pieces, centre };
}

/** A ring with every side split evenly into parts no longer than maxLen. */
export function densify(ring, maxLen) {
  const out = [];
  for (let k = 0; k < ring.length; k++) {
    const a = ring[k], b = ring[(k + 1) % ring.length];
    const parts = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / maxLen));
    for (let s = 0; s < parts; s++) out.push([a[0] + ((b[0] - a[0]) * s) / parts, a[1] + ((b[1] - a[1]) * s) / parts]);
  }
  return out;
}

/**
 * How a shape's outline lies on an n x n grid widthMm across (row 0 north).
 * ring is the outline split at every grid step, so the walls follow the
 * ground. cells marks the grid cells that print whole, (n - 1)² of them row
 * by row: inside the outline and at least 0.75 of a step clear of it, with no
 * two meeting only at a corner. used marks the grid points the print reads:
 * the corners of those cells and of every cell the outline crosses.
 */
export function shapeCells(outline, n, widthMm) {
  const step = widthMm / (n - 1), m = n - 1;
  const ring = densify(outline, step);
  const cellOf = (x, y) => [Math.max(0, Math.min(m - 1, Math.floor(x / step))), Math.max(0, Math.min(m - 1, Math.floor(m - y / step)))];
  // Cells within a cell of a point every half step along the outline are too near it: the outline is at least 0.75 of a step from the rest.
  const near = new Uint8Array(m * m);
  for (const [x, y] of densify(ring, step / 2)) {
    const [ci, cj] = cellOf(x, y);
    for (let j = Math.max(0, cj - 1); j <= Math.min(m - 1, cj + 1); j++) {
      for (let i = Math.max(0, ci - 1); i <= Math.min(m - 1, ci + 1); i++) near[j * m + i] = 1;
    }
  }
  // The rest are wholly in or out: test each cell's middle against the outline's crossings of its row.
  const cells = new Uint8Array(m * m);
  for (let j = 0; j < m; j++) {
    const y = (m - j - 0.5) * step;
    const xs = [];
    for (let k = 0; k < ring.length; k++) {
      const a = ring[k], b = ring[(k + 1) % ring.length];
      if ((a[1] > y) !== (b[1] > y)) xs.push(a[0] + ((y - a[1]) * (b[0] - a[0])) / (b[1] - a[1]));
    }
    xs.sort((p, q) => p - q);
    let crossed = 0;
    for (let i = 0; i < m; i++) {
      const x = (i + 0.5) * step;
      while (crossed < xs.length && xs[crossed] < x) crossed++;
      if (crossed % 2 && !near[j * m + i]) cells[j * m + i] = 1;
    }
  }
  // Two cells meeting only at a corner would pinch the outline of the whole cells to a point.
  for (let changed = true; changed;) {
    changed = false;
    for (let j = 0; j < m - 1; j++) {
      for (let i = 0; i < m - 1; i++) {
        const a = j * m + i, b = a + 1, c = a + m, d = c + 1;
        if (cells[a] && cells[d] && !cells[b] && !cells[c]) { cells[a] = 0; changed = true; }
        if (cells[b] && cells[c] && !cells[a] && !cells[d]) { cells[b] = 0; changed = true; }
      }
    }
  }
  const used = new Uint8Array(n * n);
  const corners = (i, j) => { used[j * n + i] = used[j * n + i + 1] = used[(j + 1) * n + i] = used[(j + 1) * n + i + 1] = 1; };
  for (let j = 0; j < m; j++) for (let i = 0; i < m; i++) if (cells[j * m + i]) corners(i, j);
  for (const [x, y] of ring) corners(...cellOf(x, y));
  return { ring, cells, used, n, widthMm };
}

/** Height on an n x n grid of zMm (row 0 north) at model point (x, y), bilinear, clamped to the square. */
function gridAt(zMm, n, widthMm, x, y) {
  const step = widthMm / (n - 1);
  const gi = Math.max(0, Math.min(n - 1, x / step)), gj = Math.max(0, Math.min(n - 1, n - 1 - y / step));
  const i0 = Math.min(n - 2, Math.floor(gi)), j0 = Math.min(n - 2, Math.floor(gj));
  const ti = gi - i0, tj = gj - j0, z = (i, j) => zMm[j * n + i];
  return z(i0, j0) * (1 - ti) * (1 - tj) + z(i0 + 1, j0) * ti * (1 - tj) + z(i0, j0 + 1) * (1 - ti) * tj + z(i0 + 1, j0 + 1) * ti * tj;
}

/**
 * Triangles covering a polygon with holes, keeping every point of every ring,
 * so each edge meets its neighbour's. rings[0] is the outline, the rest holes;
 * points are [x, y, z] arrays and come back as the same arrays, three to a
 * triangle, counter-clockwise from above. earcut gets only the rings' corners,
 * and also drops points in line with a bridge to a hole, so a triangle with
 * points on its sides is fanned through them again: from its far corner, or,
 * when more than one side has them, from its middle.
 */
function triangulate(rings) {
  // earcut is given only the corners: the points in line between them come back in the fanning,
  // and long straight runs in a thin strip can otherwise lead it to overlap triangles.
  const pts = rings.flat();
  const flat = [], holes = [], keep = [];
  let start = 0;
  for (const [k, r] of rings.entries()) {
    if (k) holes.push(flat.length / 2);
    r.forEach((p, q) => {
      const a = r[(q + r.length - 1) % r.length], b = r[(q + 1) % r.length];
      const ux = p[0] - a[0], uy = p[1] - a[1], vx = b[0] - p[0], vy = b[1] - p[1];
      if (Math.abs(ux * vy - uy * vx) > 1e-9 * (ux * ux + uy * uy + vx * vx + vy * vy) || ux * vx + uy * vy < 0) {
        flat.push(p[0], p[1]);
        keep.push(start + q);
      }
    });
    // earcut 3.0.1 sizes its point hash from the outline less its first point, so a hole past
    // that point hashes wrongly; the first point again at the end (dropped as a repeat) fixes it.
    if (!k) { flat.push(flat[0], flat[1]); keep.push(keep[0]); }
    start += r.length;
  }
  const idx = earcut(flat, holes).map((v) => keep[v]);
  // The points in buckets, to find the ones on a side quickly.
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  const B = 64, bw = (x1 - x0) / B || 1, bh = (y1 - y0) / B || 1;
  const bx = (x) => Math.max(0, Math.min(B - 1, Math.floor((x - x0) / bw))), by = (y) => Math.max(0, Math.min(B - 1, Math.floor((y - y0) / bh)));
  const buckets = Array.from({ length: B * B }, () => []);
  pts.forEach(([x, y], k) => buckets[by(y) * B + bx(x)].push(k));
  // the points lying on the segment from a to b, in order from a
  const between = (a, b) => {
    const [ax, ay] = pts[a], dx = pts[b][0] - ax, dy = pts[b][1] - ay, len2 = dx * dx + dy * dy;
    const on = [];
    for (let j = by(Math.min(ay, pts[b][1])); j <= by(Math.max(ay, pts[b][1])); j++) {
      for (let i = bx(Math.min(ax, pts[b][0])); i <= bx(Math.max(ax, pts[b][0])); i++) {
        for (const k of buckets[j * B + i]) {
          const px = pts[k][0] - ax, py = pts[k][1] - ay, t = (px * dx + py * dy) / len2;
          if (t > 1e-9 && t < 1 - 1e-9 && Math.abs(px * dy - py * dx) <= 1e-9 * len2) on.push([t, k]);
        }
      }
    }
    return on.sort((p, q) => p[0] - q[0]).map(([, k]) => k);
  };
  const out = [];
  for (let t = 0; t < idx.length; t += 3) {
    let [a, b, c] = [idx[t], idx[t + 1], idx[t + 2]];
    const ux = pts[b][0] - pts[a][0], uy = pts[b][1] - pts[a][1], vx = pts[c][0] - pts[a][0], vy = pts[c][1] - pts[a][1];
    const cross = ux * vy - vx * uy;
    // A flat triangle along three points in a line covers nothing: the triangles beside it take its points in.
    if (Math.abs(cross) <= 1e-9 * (ux * ux + uy * uy + vx * vx + vy * vy)) continue;
    if (cross < 0) [b, c] = [c, b];
    const sides = [[a, b], [b, c], [c, a]].map(([p, q]) => [p, ...between(p, q)]);
    const lost = sides.filter((s) => s.length > 1).length;
    if (!lost) { out.push(pts[a], pts[b], pts[c]); continue; }
    if (lost === 1) {
      const k = sides.findIndex((s) => s.length > 1);
      const chain = [...sides[k], [b, c, a][k]], far = pts[[c, a, b][k]];
      for (let s = 0; s < chain.length - 1; s++) out.push(pts[chain[s]], pts[chain[s + 1]], far);
      continue;
    }
    const loop = sides.flat().map((v) => pts[v]);
    const middle = [0, 1, 2].map((k) => (pts[a][k] + pts[b][k] + pts[c][k]) / 3);
    for (let s = 0; s < loop.length; s++) out.push(loop[s], loop[(s + 1) % loop.length], middle);
  }
  // A fan through a long straight side reaches a point far along it: a sliver that skims over the
  // ground and leaves the outline standing up like a thin wall. Flipping joins near points instead.
  return delaunayFlips(out);
}

/**
 * Triangles (point arrays, three to a triangle, counter-clockwise) with every
 * side two of them share flipped to the other diagonal of their quadrilateral
 * while that makes them less thin (Lawson's flips, to a Delaunay
 * triangulation). The points and the outline stay as they were.
 */
function delaunayFlips(tris) {
  const ids = new Map(), pts = [];
  const id = (p) => { if (!ids.has(p)) { ids.set(p, pts.length); pts.push(p); } return ids.get(p); };
  const T = [];
  for (let t = 0; t < tris.length; t += 3) T.push([id(tris[t]), id(tris[t + 1]), id(tris[t + 2])]);
  const N = pts.length, key = (u, v) => (u < v ? u * N + v : v * N + u);
  const sides = new Map(); // side -> the triangles that have it
  const link = (t) => T[t].forEach((u, k) => {
    const s = key(u, T[t][(k + 1) % 3]);
    if (sides.has(s)) sides.get(s).push(t); else sides.set(s, [t]);
  });
  const unlink = (t) => T[t].forEach((u, k) => {
    const list = sides.get(key(u, T[t][(k + 1) % 3]));
    list.splice(list.indexOf(t), 1);
  });
  T.forEach((_, t) => link(t));
  const orient = (a, b, c) => {
    const [ax, ay] = pts[a], [bx, by] = pts[b], [cx, cy] = pts[c];
    const ux = bx - ax, uy = by - ay, vx = cx - ax, vy = cy - ay;
    return ux * vy - uy * vx > 1e-9 * (ux * ux + uy * uy + vx * vx + vy * vy);
  };
  // d inside the circle through a, b and c (counter-clockwise), by more than rounding
  const inCircle = (a, b, c, d) => {
    const [dx, dy] = pts[d];
    const [ax, ay] = [pts[a][0] - dx, pts[a][1] - dy], [bx, by] = [pts[b][0] - dx, pts[b][1] - dy], [cx, cy] = [pts[c][0] - dx, pts[c][1] - dy];
    const a2 = ax * ax + ay * ay, b2 = bx * bx + by * by, c2 = cx * cx + cy * cy;
    const det = a2 * (bx * cy - cx * by) - b2 * (ax * cy - cx * ay) + c2 * (ax * by - bx * ay);
    return det > 1e-9 * (a2 + b2 + c2) ** 2;
  };
  const stack = [...sides.keys()];
  while (stack.length) {
    const ts = sides.get(stack.pop());
    if (!ts || ts.length !== 2) continue; // an outline side, or one flipped away
    const [t1, t2] = ts;
    // t1 is (a, b, p) and t2 (b, a, q), both counter-clockwise
    const k = T[t1].findIndex((u) => !T[t2].includes(u));
    const p = T[t1][k], a = T[t1][(k + 1) % 3], b = T[t1][(k + 2) % 3];
    const q = T[t2].find((u) => u !== a && u !== b);
    if (!inCircle(a, b, p, q) || !orient(a, q, p) || !orient(q, b, p)) continue;
    unlink(t1); unlink(t2);
    T[t1] = [a, q, p]; T[t2] = [q, b, p];
    link(t1); link(t2);
    stack.push(key(a, q), key(q, b), key(b, p), key(p, a));
  }
  return T.flatMap((t) => t.map((v) => pts[v]));
}

/**
 * The outlines of a set of cells on an n x n grid of points, as rings of
 * point indices (j * n + i). An outline round cells runs counter-clockwise
 * (seen with north up), a hole among them clockwise. No two cells may meet
 * only at a corner.
 */
function cellOutlines(cells, n) {
  const m = n - 1;
  const inside = (i, j) => i >= 0 && j >= 0 && i < m && j < m && cells[j * m + i];
  const next = new Map();
  for (let j = 0; j < m; j++) {
    for (let i = 0; i < m; i++) {
      if (!inside(i, j)) continue;
      const nw = j * n + i, ne = nw + 1, sw = nw + n, se = sw + 1;
      if (!inside(i, j + 1)) next.set(sw, se);
      if (!inside(i + 1, j)) next.set(se, ne);
      if (!inside(i, j - 1)) next.set(ne, nw);
      if (!inside(i - 1, j)) next.set(nw, sw);
    }
  }
  const loops = [];
  for (const start of next.keys()) {
    if (!next.has(start)) continue;
    const loop = [];
    for (let k = start; next.has(k);) { loop.push(k); const to = next.get(k); next.delete(k); k = to; }
    loops.push(loop);
  }
  return loops;
}

/**
 * A closed solid of a shaped print as triangles (three points each): the
 * whole cells of the grid (from shapeCells) as in terrainStl, the strip from
 * them to the outline, walls down round the outline and a flat bottom, with
 * label (from bottomLabel) cut up into it and extra added at the end.
 * Returns { tris, top }, top being how many triangles the top surface has:
 * they come first.
 */
export function shapeMesh(zMm, shape, extra = [], label = null) {
  const { ring, cells, n, widthMm } = shape;
  const step = widthMm / (n - 1), m = n - 1;
  const point = (k) => { const i = k % n, j = (k - i) / n; return [i * step, (m - j) * step, zMm[k]]; };
  const tris = [];
  for (let j = 0; j < m; j++) {
    for (let i = 0; i < m; i++) {
      if (!cells[j * m + i]) continue;
      const a = point(j * n + i), b = point(j * n + i + 1), c = point((j + 1) * n + i), d = point((j + 1) * n + i + 1);
      tris.push(a, c, b, b, c, d);
    }
  }
  const edge = ring.map(([x, y]) => [x, y, gridAt(zMm, n, widthMm, x, y)]);
  const loops = cellOutlines(cells, n).map((l) => l.map(point));
  const islands = loops.filter((l) => ringArea2(l) > 0);
  for (const p of triangulate([edge, ...islands])) tris.push(p);
  for (const hole of loops.filter((l) => ringArea2(l) < 0)) for (const p of triangulate([hole])) tris.push(p);
  const top = tris.length / 3;
  for (let k = 0; k < edge.length; k++) {
    const t0 = edge[k], t1 = edge[(k + 1) % edge.length];
    const b0 = [t0[0], t0[1], 0], b1 = [t1[0], t1[1], 0];
    tris.push(b0, b1, t1, b0, t1, t0); // wall, facing outward
  }
  const bed = ring.map(([x, y]) => [x, y, 0]);
  const bottom = triangulate(label ? [bed, labelSides(label).flatMap((s) => s.slice(0, -1))] : [bed]);
  for (let t = 0; t < bottom.length; t += 3) tris.push(bottom[t], bottom[t + 2], bottom[t + 1]); // facing down
  if (label) for (const p of labelCells(label)) tris.push(p);
  for (const p of extra) tris.push(p);
  return { tris, top };
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

/** The Overpass query for every building in a lon/lat box, or in any of a list of them, with its outline. */
export function overpassBuildingsQuery(b) {
  const parts = overpassBoxes(b).map((box) => `way["building"](${box});relation["building"]["type"="multipolygon"](${box});`);
  return `[out:json][timeout:90];(${parts.join('')});out geom;`;
}

/** A lon/lat box, or a list of them, as Overpass bbox strings (south,west,north,east). */
function overpassBoxes(b) {
  return [b].flat().map((x) => [x.south, x.west, x.north, x.east].map((v) => v.toFixed(6)).join(','));
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

/** A ring cut to a convex polygon running counter-clockwise (Sutherland-Hodgman), without repeated points. */
export function clipToConvex(ring, clip) {
  let pts = ring;
  for (let k = 0; k < clip.length && pts.length; k++) {
    const a = clip[k], b = clip[(k + 1) % clip.length];
    const side = (p) => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]); // 0 or more on the inside
    const out = [];
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i], q = pts[(i + 1) % pts.length], sp = side(p), sq = side(q);
      if (sp >= 0) out.push(p);
      if ((sp >= 0) !== (sq >= 0)) {
        const t = sp / (sp - sq);
        out.push([p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])]);
      }
    }
    pts = out;
  }
  const out = pts.filter((p, i) => {
    const q = pts[(i + 1) % pts.length];
    return Math.abs(p[0] - q[0]) > 1e-6 || Math.abs(p[1] - q[1]) > 1e-6;
  });
  return out.length >= 3 ? out : null;
}

/** Whether point p is strictly inside a convex polygon running counter-clockwise. */
const inConvex = (p, clip) => clip.every((a, k) => {
  const b = clip[(k + 1) % clip.length];
  return (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]) > 1e-9;
});

const NOT_BUILT = new Set(['no', 'roof', 'construction', 'proposed', 'demolished', 'destroyed']);

/**
 * Building footprints from an Overpass reply, in model millimetres (x east, y
 * north, the square's south-west corner at 0,0) and cut to the square. Each is
 * { rings, heightM }: the outline counter-clockwise, then any courtyards
 * clockwise, with heightM null where OSM has no height. Roofs on posts,
 * underground buildings and footprints too small to print are left out.
 * frame (from printFrame) places a turned print; pieces (from shapeOutline)
 * cut them to a shape instead, a footprint across two pieces in two parts.
 */
export function buildingFootprints(osm, bounds, widthMm, { frame = null, pieces = null } = {}) {
  const toMm = frame ? (g) => frame.toMm(g.lon, g.lat) : (g) => [((g.lon - bounds.west) / (bounds.east - bounds.west)) * widthMm,
    ((g.lat - bounds.south) / (bounds.north - bounds.south)) * widthMm];
  const square = [[0, 0], [widthMm, 0], [widthMm, widthMm], [0, widthMm]];
  const cuts = pieces ? pieces.map((piece) => ({ clip: (r) => clipToConvex(r, piece), within: (p) => inConvex(p, piece) }))
    : [{ clip: (r) => clipToSquare(r, widthMm), within: (p) => inConvex(p, square) }];
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
      for (const { clip, within } of cuts) {
        const shell = clip(outer);
        if (!shell) continue;
        // A courtyard the edge cuts would touch the cut outline, so it is filled in instead.
        const holes = inners.filter((h) => inRing(h[0], outer) && h.every((p) => within(p))).map((h) => h.slice());
        const area = Math.abs(ringArea2(shell)) / 2 - holes.reduce((s, h) => s + Math.abs(ringArea2(h)) / 2, 0);
        if (area < MIN_FOOTPRINT_MM2) continue;
        if (ringArea2(shell) < 0) shell.reverse();
        for (const h of holes) if (ringArea2(h) > 0) h.reverse();
        out.push({ rings: [shell, ...holes], heightM });
      }
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

// ---------- roads ----------

/**
 * The road classes printed, biggest first, each with its width and its level
 * by default (mm on the model, up). A 30 m motorway is 0.36 mm across at 10
 * km on 120 mm, under the nozzle, so widths are set on the model rather than
 * the ground; widthM is a real carriageway, which takes over on prints small
 * enough for it to be wider.
 */
export const ROAD_CLASSES = {
  motorway: { widthMm: 1.6, liftMm: 1.2, widthM: 25 },
  trunk: { widthMm: 1.2, liftMm: 0.8, widthM: 20 },
  primary: { widthMm: 0.8, liftMm: 0.4, widthM: 14 },
};
/** Roads come from OpenStreetMap only on prints this size across or smaller. Not measured: past 25 km the query may be slow or turned away by Overpass. */
export const ROADS_MAX_KM = 50;
/** A road's top follows the ground averaged over this far either way along it (mm on the model), so it reads as graded. */
export const ROAD_SMOOTH_MM = 1.5;
/**
 * The levels a road class or kind of water can print at, in mm on the model:
 * up for raised, down (negative) for sunk, 0 for left out.
 */
export const LEVELS_MM = [0, 0.4, 0.6, 0.8, 1.2, 1.6, 2, -0.4, -0.6, -0.8, -1.2, -1.6, -2];
/** Each road class's level by default (raised), and no roads at all. */
export const ROAD_LEVELS = Object.fromEntries(Object.entries(ROAD_CLASSES).map(([cls, c]) => [cls, c.liftMm]));
export const NO_ROADS = Object.fromEntries(Object.keys(ROAD_CLASSES).map((cls) => [cls, 0]));
/** The kinds of water printed, biggest first: areas of still water, rivers mapped as areas, and rivers mapped only as lines. */
export const WATER_KINDS = { lakes: 'Lakes', wide: 'Wide rivers', narrow: 'Narrow rivers' };
/** Each kind of water's level by default (sunk), and no water at all. */
export const WATER_LEVELS = { lakes: -0.6, wide: -0.6, narrow: -0.6 };
export const NO_WATER = { lakes: 0, wide: 0, narrow: 0 };
/** True when any class or kind of a set of levels prints. */
export const anyLevel = (levels) => Object.values(levels || {}).some((v) => v !== 0);

/** The Overpass query for every motorway, trunk and primary road in a lon/lat box, or in any of a list of them, with its line. */
export function overpassRoadsQuery(b) {
  const parts = overpassBoxes(b).map((box) => `way["highway"~"^(${Object.keys(ROAD_CLASSES).join('|')})$"](${box});`);
  return `[out:json][timeout:90];(${parts.join('')});out geom;`;
}

/**
 * Lines that meet end to end joined into longer ones, either way round.
 * Points are [x, y] pairs matched exactly. Where three or more lines meet,
 * which two join is the first found.
 */
export function joinLines(lines) {
  const same = (a, b) => a[0] === b[0] && a[1] === b[1];
  const left = lines.filter((l) => l.length > 1).map((l) => l.slice());
  const out = [];
  while (left.length) {
    let line = left.shift();
    for (;;) {
      const head = line[0], end = line[line.length - 1];
      if (same(head, end)) break; // a loop
      const k = left.findIndex((l) => same(l[0], end) || same(l[l.length - 1], end) || same(l[0], head) || same(l[l.length - 1], head));
      if (k < 0) break;
      const [l] = left.splice(k, 1);
      if (same(l[0], end)) line = line.concat(l.slice(1));
      else if (same(l[l.length - 1], end)) line = line.concat(l.slice(0, -1).reverse());
      else if (same(l[l.length - 1], head)) line = l.slice(0, -1).concat(line);
      else line = l.slice(1).reverse().concat(line);
    }
    out.push(line);
  }
  return out;
}

/**
 * A line cut to a convex polygon running counter-clockwise (Cyrus-Beck on
 * each segment), as the runs of it inside.
 */
export function clipLine(line, clip) {
  const runs = [];
  let run = null;
  for (let s = 0; s + 1 < line.length; s++) {
    const p = line[s], q = line[s + 1];
    let t0 = 0, t1 = 1;
    for (let k = 0; k < clip.length && t0 <= t1; k++) {
      const a = clip[k], b = clip[(k + 1) % clip.length];
      const side = (r) => (b[0] - a[0]) * (r[1] - a[1]) - (b[1] - a[1]) * (r[0] - a[0]); // 0 or more on the inside
      const sp = side(p), sq = side(q);
      if (sp < 0 && sq < 0) t1 = -1;
      else if (sp < 0) t0 = Math.max(t0, sp / (sp - sq));
      else if (sq < 0) t1 = Math.min(t1, sp / (sp - sq));
    }
    if (t0 > t1) { run = null; continue; }
    const at = (t) => [p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])];
    if (!run || t0 > 0) { run = [at(t0)]; runs.push(run); }
    run.push(at(t1));
    if (t1 < 1) run = null;
  }
  return runs.map((r) => r.filter((p, i) => !i || Math.hypot(p[0] - r[i - 1][0], p[1] - r[i - 1][1]) > 1e-6)).filter((r) => r.length > 1);
}

/** A line's length. */
export const lineLength = (line) => line.reduce((s, p, i) => (i ? s + Math.hypot(p[0] - line[i - 1][0], p[1] - line[i - 1][1]) : 0), 0);

/**
 * Motorway, trunk and primary roads from an Overpass reply, in model
 * millimetres (x east, y north, the square's south-west corner at 0,0) and
 * cut to the square, as { cls, line }. Ways of a class that meet end to end
 * are joined first, so a road is one solid rather than a string of them.
 * Tunnels and covered roads are left out; ramps (the _link classes) aren't
 * asked for. frame and pieces place and cut them as buildingFootprints does.
 */
export function roadLines(osm, bounds, widthMm, { frame = null, pieces = null } = {}) {
  const toMm = frame ? (g) => frame.toMm(g.lon, g.lat) : (g) => [((g.lon - bounds.west) / (bounds.east - bounds.west)) * widthMm,
    ((g.lat - bounds.south) / (bounds.north - bounds.south)) * widthMm];
  const clips = pieces || [[[0, 0], [widthMm, 0], [widthMm, widthMm], [0, widthMm]]];
  const byClass = new Map(Object.keys(ROAD_CLASSES).map((c) => [c, []]));
  for (const el of osm.elements || []) {
    const tags = el.tags || {};
    if (el.type !== 'way' || !byClass.has(tags.highway) || !el.geometry) continue;
    if ((tags.tunnel && tags.tunnel !== 'no') || tags.covered === 'yes' || tags.area === 'yes') continue;
    byClass.get(tags.highway).push(el.geometry.map(toMm));
  }
  const out = [];
  for (const [cls, ways] of byClass) {
    for (const line of joinLines(ways)) {
      for (const clip of clips) {
        for (const run of clipLine(line, clip)) if (lineLength(run) >= ROAD_CLASSES[cls].widthMm) out.push({ cls, line: run });
      }
    }
  }
  return out;
}

/**
 * Each road as its own closed solid, as STL triangles (three points each) to
 * add to the terrain's: a ribbon its class's width, whose top is the ground
 * along it, averaged over ROAD_SMOOTH_MM either way, plus its class's level
 * in levels, and whose floor sits just under the lowest terrain beneath it, so
 * nothing floats. The top stays at least 0.2 mm over the terrain under it, so
 * a road in a cutting still shows. Classes whose level isn't up are left to
 * carveRoads. zMm is the terrain in mm (row 0 north); mmPerMetre is model mm
 * per metre of ground across (both from printHeights).
 */
export function roadTriangles(roads, zMm, n, { widthMm, mmPerMetre, levels = ROAD_LEVELS }) {
  const step = widthMm / (n - 1);
  // the lowest and highest corner of the grid cell under a point: the terrain over the cell lies between
  const cellSpan = (x, y) => {
    const i = Math.max(0, Math.min(n - 2, Math.floor(x / step))), j = Math.max(0, Math.min(n - 2, Math.floor(n - 1 - y / step)));
    const zs = [zMm[j * n + i], zMm[j * n + i + 1], zMm[(j + 1) * n + i], zMm[(j + 1) * n + i + 1]];
    return [Math.min(...zs), Math.max(...zs)];
  };
  const dir = (a, b) => { const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1; return [dx / l, dy / l]; };
  const tris = [];
  for (const { cls, line } of roads) {
    const liftMm = levels[cls] || 0;
    if (liftMm <= 0) continue;
    const { widthMm: classMm, widthM } = ROAD_CLASSES[cls];
    const half = Math.max(classMm, widthM * mmPerMetre) / 2;
    const pts = roadPoints(line, step);
    const m = pts.length;
    if (m < 2) continue;
    const smooth = roadGround(pts, zMm, n, widthMm);
    const sections = [];
    for (let k = 0; k < m; k++) {
      // the point's left is square to the mean of the directions either side, pushed out at a bend so the sides stay parallel
      const d0 = dir(pts[Math.max(0, k - 1)], pts[k === 0 ? 1 : k]), d1 = dir(pts[k === m - 1 ? m - 2 : k], pts[Math.min(m - 1, k + 1)]);
      let tx = d0[0] + d1[0], ty = d0[1] + d1[1];
      const tl = Math.hypot(tx, ty);
      if (tl < 1e-9) [tx, ty] = d1; else { tx /= tl; ty /= tl; }
      const miter = 1 / Math.max(0.5, tx * d1[0] + ty * d1[1]); // at most twice out, at a hairpin
      const ox = -ty * half * miter, oy = tx * half * miter;
      const [x, y] = pts[k];
      const L = [x + ox, y + oy], R = [x - ox, y - oy];
      const spans = [cellSpan(x, y), cellSpan(...L), cellSpan(...R)];
      const bottom = Math.max(0, Math.min(...spans.map((s) => s[0])) - 0.2);
      const top = Math.max(smooth[k] + liftMm, Math.max(...spans.map((s) => s[1])) + 0.2, bottom + 0.4);
      // counter-clockwise looking back along the road: top left, top right, bottom right, bottom left
      sections.push([[L[0], L[1], top], [R[0], R[1], top], [R[0], R[1], bottom], [L[0], L[1], bottom]]);
    }
    for (let k = 0; k + 1 < m; k++) {
      const a = sections[k], b = sections[k + 1];
      for (let r = 0; r < 4; r++) {
        const r1 = (r + 1) % 4;
        tris.push(a[r], a[r1], b[r1], a[r], b[r1], b[r]);
      }
    }
    const s0 = sections[0], s1 = sections[m - 1];
    tris.push(s0[0], s0[2], s0[1], s0[0], s0[3], s0[2]); // the start, facing back
    tris.push(s1[0], s1[1], s1[2], s1[0], s1[2], s1[3]); // the end, facing on
  }
  return tris;
}

/** A road line's points at most step apart, keeping the line's own corners. */
function roadPoints(line, step) {
  const pts = [line[0]];
  for (let k = 1; k < line.length; k++) {
    const [ax, ay] = line[k - 1], [bx, by] = line[k];
    const parts = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / step));
    for (let s = 1; s <= parts; s++) pts.push([ax + ((bx - ax) * s) / parts, ay + ((by - ay) * s) / parts]);
  }
  return pts;
}

/** The ground under each of a road's points, averaged over ROAD_SMOOTH_MM either way along it, as a sliding window. */
function roadGround(pts, zMm, n, widthMm) {
  const m = pts.length;
  const along = [0];
  for (let k = 1; k < m; k++) along.push(along[k - 1] + Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]));
  const ground = pts.map(([x, y]) => gridAt(zMm, n, widthMm, x, y));
  const out = [];
  let lo = 0, hi = 0, sum = 0;
  for (let k = 0; k < m; k++) {
    while (hi < m && along[hi] <= along[k] + ROAD_SMOOTH_MM) sum += ground[hi++];
    while (along[lo] < along[k] - ROAD_SMOOTH_MM) sum -= ground[lo++];
    out.push(sum / (hi - lo));
  }
  return out;
}

/**
 * Cuts the roads whose class's level in levels is down into a millimetre grid
 * (row 0 north) as grooves: the grid points within half the road's width of
 * its line, and the point nearest it all along, sink by the level under the
 * ground along the road, averaged over ROAD_SMOOTH_MM either way, so the
 * groove's floor is graded as a raised road's top is. Points in skip (the
 * water, which a road crosses on a bridge) and at or under sea level (heights
 * in metres, at most 0) are left alone, and no point is left with less than
 * minMm of model under it. Returns { mm, mask }: the new grid and a Uint8Array
 * with a 1 for each point cut.
 */
export function carveRoads(mm, roads, n, { widthMm, mmPerMetre, levels = ROAD_LEVELS, skip = null, heights = null, minMm = 0.6 }) {
  const step = widthMm / (n - 1);
  const bed = new Float64Array(n * n).fill(Infinity);
  for (const { cls, line } of roads) {
    const depthMm = -(levels[cls] || 0);
    if (depthMm <= 0) continue;
    const { widthMm: classMm, widthM } = ROAD_CLASSES[cls];
    const half = Math.max(classMm, widthM * mmPerMetre) / 2;
    // half a grid step apart, so the nearest grid point moves at most one step each way between them
    const pts = roadPoints(line, step / 2);
    const smooth = roadGround(pts, mm, n, widthMm);
    stampLine(pts.map(([x, y], k) => ({ x, y, half, z: smooth[k] - depthMm })), n, widthMm, bed);
  }
  return setLevels(mm, bed, n, { skip, heights, minMm });
}

/**
 * Marks a line of { x, y, half, z } samples (mm on the model, at most half a
 * grid step apart) into bed, keeping the lowest z at each grid point: the
 * points within half of each sample, and the grid point nearest the line all
 * along it, with a diagonal move filled in so what it marks stays 4-connected.
 * A sample off the model, or without a finite z, breaks the line.
 */
function stampLine(samples, n, widthMm, bed) {
  const step = widthMm / (n - 1);
  const put = (i, j, z) => {
    if (i < 0 || i >= n || j < 0 || j >= n) return;
    const k = j * n + i;
    if (z < bed[k]) bed[k] = z;
  };
  let prev = null;
  for (const { x, y, half, z } of samples) {
    if (!Number.isFinite(z) || x < 0 || x > widthMm || y < 0 || y > widthMm) { prev = null; continue; }
    const gi = x / step, gj = n - 1 - y / step;
    const ni = Math.round(gi), nj = Math.round(gj);
    put(ni, nj, z);
    if (prev && prev[0] !== ni && prev[1] !== nj) put(ni, prev[1], z); // a diagonal move, filled in so the line stays 4-connected
    prev = [ni, nj];
    const r = half / step;
    for (let j = Math.ceil(gj - r); j <= Math.floor(gj + r); j++) {
      for (let i = Math.ceil(gi - r); i <= Math.floor(gi + r); i++) if (Math.hypot(i - gi, j - gj) <= r) put(i, j, z);
    }
  }
}

/**
 * A grid with each point marked in bed moved to its level there: sunk to it,
 * keeping minMm of model under it, or with raise, lifted to it where it is
 * above the ground, never cut. Points in skip, and at or under sea level in
 * heights, are left alone. Returns { mm, mask }, mask a Uint8Array with a 1
 * for each point marked.
 */
function setLevels(mm, bed, n, { skip = null, heights = null, minMm = 0.6, raise = false }) {
  const out = mm.slice(), mask = new Uint8Array(n * n);
  for (let k = 0; k < n * n; k++) {
    if (!(bed[k] < Infinity) || skip?.[k] || (heights && !(heights[k] > 0))) continue;
    out[k] = raise ? Math.max(mm[k], bed[k]) : Math.max(Math.min(mm[k], minMm), Math.min(mm[k], bed[k]));
    mask[k] = 1;
  }
  return { mm: out, mask };
}

// ---------- lakes and wide rivers ----------

/** Lakes and rivers come from OpenStreetMap only on prints this size across or smaller, as roads do. */
export const WATER_MAX_KM = 50;
/** A patch of water smaller than this on the model (mm²) stays land: the grid could only show it as a pit. */
export const WATER_MIN_MM2 = 4;
/** How far round a water point (grid steps) its level looks for the lowest water, so the blur at a shore doesn't lift it. */
export const WATER_REACH = 2;
const NOT_WATER = new Set(['wastewater']);

/** The Overpass query for every lake, pond, reservoir and river area, and every river line, in a lon/lat box, or in any of a list of them, with its outline. */
export function overpassWaterQuery(b) {
  const parts = overpassBoxes(b).map((box) => ['natural"="water', 'waterway"="riverbank']
    .map((tag) => `way["${tag}"](${box});relation["${tag}"]["type"="multipolygon"](${box});`).join('') + `way["waterway"="river"](${box});`);
  return `[out:json][timeout:90];(${parts.join('')});out geom;`;
}

/** River and canal water mapped as an area: a riverbank, or natural=water tagged as a river, canal or stream. The rest is a lake. */
export const wideRiver = (tags = {}) => tags.waterway === 'riverbank' || ['river', 'canal', 'stream', 'rapids'].includes(tags.water);

/**
 * A water area's rings from an OSM element, as [lon, lat] points without the
 * repeated last one: a closed way's outline, or a multipolygon's outer and
 * inner rings together, to be filled even-odd so islands stay land. Empty for
 * anything that isn't open water at the surface.
 */
export function waterRings(el) {
  const tags = el.tags || {};
  if (NOT_WATER.has(tags.water) || tags.covered === 'yes' || (tags.tunnel && tags.tunnel !== 'no') || tags.location === 'underground') return [];
  const pts = (g) => g.map((p) => [p.lon, p.lat]);
  const open = (ring) => ring.slice(0, -1);
  if (el.type === 'way') {
    const g = el.geometry || [];
    const closed = g.length >= 4 && g[0].lon === g[g.length - 1].lon && g[0].lat === g[g.length - 1].lat;
    return closed ? [open(pts(g))] : [];
  }
  if (el.type !== 'relation') return [];
  return joinRings((el.members || [])
    .filter((m) => m.type === 'way' && ['outer', 'inner', ''].includes(m.role || '') && m.geometry)
    .map((m) => pts(m.geometry))).map(open);
}

/**
 * An Overpass water reply shared out among the cells it was asked for, as
 * elementsByCell does, but each water area cut to the cell it is kept in, as
 * { type: 'water', id, rings, wide }, wide for a river's area rather than a
 * lake's (wideRiver). One lake can be a great many points (all of
 * Lake Michigan comes back for a print on its shore), and each cell keeps only
 * its own piece of it. A ring cut to a cell still fills even-odd as the whole
 * did within the cell, so the pieces of every cell together are the area.
 * A river line is kept whole in every cell it may cross, as
 * { type: 'river', id, line }, since its level runs along it from the source.
 */
export function waterByCell(osm, cells, z) {
  const out = new Map(cells.map((c) => [`${c.x}/${c.y}`, []]));
  for (const el of osm.elements || []) {
    const line = riverLine(el);
    if (line) {
      const lb = lonLatBounds(line.map(([lon, lat]) => ({ lon, lat })));
      for (const c of cellsForBounds(lb, z)) out.get(`${c.x}/${c.y}`)?.push({ type: 'river', id: `way${el.id}`, line });
      continue;
    }
    const rings = waterRings(el);
    if (!rings.length) continue;
    const wide = wideRiver(el.tags);
    // by a loop, not lonLatBounds: a big lake's points are too many to spread into Math.min
    const b = { west: Infinity, east: -Infinity, south: Infinity, north: -Infinity };
    for (const ring of rings) {
      for (const [lon, lat] of ring) {
        if (lon < b.west) b.west = lon; if (lon > b.east) b.east = lon;
        if (lat < b.south) b.south = lat; if (lat > b.north) b.north = lat;
      }
    }
    for (const c of cellsForBounds(b, z)) {
      const list = out.get(`${c.x}/${c.y}`);
      if (!list) continue;
      const cb = cellBounds(c, z);
      const box = [[cb.west, cb.south], [cb.east, cb.south], [cb.east, cb.north], [cb.west, cb.north]];
      const cut = rings.map((r) => clipToConvex(r, box)).filter(Boolean);
      if (cut.length) list.push({ type: 'water', id: `${el.type}${el.id}@${c.x}/${c.y}`, rings: cut, wide });
    }
  }
  return out;
}

/**
 * The water on an n x n grid (row 0 along the model's top), as a Uint8Array
 * with a 1 for each point inside a water area of osm (from waterByCell) and
 * above sea level: water at or under it is the sea's, cut flat already.
 * frame places the lon/lat rings on the model. Patches smaller than
 * minMm2 are left out.
 */
export function waterPoints(osm, heights, n, widthMm, frame, minMm2 = WATER_MIN_MM2) {
  const step = widthMm / (n - 1);
  const water = new Uint8Array(n * n);
  for (const el of osm.elements || []) {
    // Every ring's crossings of each row together, filled in pairs: even-odd, so an island stays land.
    const rows = new Map();
    for (const ring of el.rings || []) {
      const g = ring.map(([lon, lat]) => { const [x, y] = frame.toMm(lon, lat); return [x / step, n - 1 - y / step]; });
      for (let a = 0, b = g.length - 1; a < g.length; b = a++) {
        const [x0, y0] = g[b], [x1, y1] = g[a];
        if (y0 === y1) continue;
        const lo = Math.max(0, Math.ceil(Math.min(y0, y1))), hi = Math.min(n - 1, Math.ceil(Math.max(y0, y1)) - 1);
        for (let j = lo; j <= hi; j++) (rows.get(j) || rows.set(j, []).get(j)).push(x0 + ((j - y0) * (x1 - x0)) / (y1 - y0));
      }
    }
    for (const [j, xs] of rows) {
      xs.sort((p, q) => p - q);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        for (let i = Math.max(0, Math.ceil(xs[k])); i <= Math.min(n - 1, Math.floor(xs[k + 1])); i++) water[j * n + i] = 1;
      }
    }
  }
  for (let k = 0; k < n * n; k++) if (!(heights[k] > 0)) water[k] = 0;
  // Drop the patches too small to show, in 4-connected pieces as the shoreline finds the sea.
  const minPoints = minMm2 / (step * step);
  const seen = new Uint8Array(n * n);
  for (let start = 0; start < n * n; start++) {
    if (!water[start] || seen[start]) continue;
    const patch = [], stack = [start];
    seen[start] = 1;
    while (stack.length) {
      const k = stack.pop();
      patch.push(k);
      const i = k % n, j = (k - i) / n;
      for (const q of [i > 0 ? k - 1 : -1, i < n - 1 ? k + 1 : -1, j > 0 ? k - n : -1, j < n - 1 ? k + n : -1]) {
        if (q >= 0 && water[q] && !seen[q]) { seen[q] = 1; stack.push(q); }
      }
    }
    if (patch.length < minPoints) for (const k of patch) water[k] = 0;
  }
  return water;
}

/**
 * The water on an n x n grid as waterPoints finds it, split into { lakes,
 * wide }: a Uint8Array each, wide for the points of a river's area (wideRiver)
 * and lakes for the rest. Where a lake and a river's area overlap, the lake
 * has it. The patches too small to show are found in the two together, so a
 * river's short reach into a lake isn't lost for being short.
 */
export function waterKinds(osm, heights, n, widthMm, frame) {
  const all = waterPoints(osm, heights, n, widthMm, frame);
  const still = waterPoints({ elements: (osm.elements || []).filter((el) => !el.wide) }, heights, n, widthMm, frame, 0);
  const lakes = new Uint8Array(n * n), wide = new Uint8Array(n * n);
  for (let k = 0; k < n * n; k++) if (all[k]) (still[k] ? lakes : wide)[k] = 1;
  return { lakes, wide };
}

/**
 * Sinks the water (from waterPoints) into a millimetre grid: each water point
 * to depthMm under the lowest water within WATER_REACH grid steps of it, so
 * a lake is one flat level under its shore and a river steps down with its
 * valley, never leaving less than minMm of model under it. A negative depthMm
 * raises it that far over the same level instead, as a flat top, lifting
 * only what is under it. Still a height grid, so the STL stays closed.
 */
export function carveWater(mm, water, n, depthMm, minMm = 0.6) {
  const r = WATER_REACH;
  return mm.map((z, k) => {
    if (!water[k]) return z;
    const i = k % n, j = (k - i) / n;
    let low = z;
    for (let jj = Math.max(0, j - r); jj <= Math.min(n - 1, j + r); jj++) {
      for (let ii = Math.max(0, i - r); ii <= Math.min(n - 1, i + r); ii++) {
        const q = jj * n + ii;
        if (water[q] && mm[q] < low) low = mm[q];
      }
    }
    return depthMm < 0 ? Math.max(z, low - depthMm) : Math.max(Math.min(z, minMm), Math.min(z, low - depthMm));
  });
}

// ---------- narrow rivers ----------

/** A river mapped only as a line is cut at least this wide (mm on the model), or its real width where a small print makes that wider. */
export const RIVER_WIDTH_MM = 0.8;
/** A river's width where OpenStreetMap gives none (m). */
export const RIVER_WIDTH_M = 20;

/**
 * A river line's points from an OSM way, as [lon, lat, width m] in the way's
 * own order, which OpenStreetMap draws downstream. Null for anything that
 * isn't a river at the surface.
 */
export function riverLine(el) {
  const tags = el.tags || {};
  if (el.type !== 'way' || tags.waterway !== 'river' || !el.geometry || el.geometry.length < 2) return null;
  if ((tags.tunnel && tags.tunnel !== 'no') || tags.covered === 'yes' || tags.location === 'underground') return null;
  const w = parseFloat(tags.width);
  const widthM = w > 0 && w < 5000 ? w : RIVER_WIDTH_M;
  return el.geometry.map((p) => [p.lon, p.lat, widthM]);
}

/** The river lines of osm (from waterByCell) on the model, as [x mm, y mm, width m] points, downstream. */
export function riverLines(osm, frame) {
  return (osm.elements || []).filter((el) => el.type === 'river')
    .map((el) => el.line.map(([lon, lat, w]) => [...frame.toMm(lon, lat), w]));
}

/**
 * Cuts the rivers (from riverLines) into a millimetre grid (row 0 north) as
 * channels: the grid points within half a river's width of its line, and
 * the point nearest it all along, so the channel never breaks, sink to
 * depthMm under the lowest ground the river has passed over since its
 * source. So a channel only ever steps down, however the elevation data
 * wobbles under it. Where rivers share a point (one joining another, or a
 * river drawn in several ways), the lowest level reaching it goes on down
 * each of them. Points in skip (the lakes and wide rivers, sunk on their own)
 * and at or under sea level (heights in metres, at most 0) are left alone,
 * and no point is left with less than minMm of model under it. A negative
 * depthMm raises the river that far over the same level instead, as a ridge,
 * lifting only what is under it. Returns { mm, mask, km }: the new grid, a
 * Uint8Array with a 1 for each point cut, and the length of river on the grid
 * in km.
 */
export function carveRivers(mm, rivers, n, { widthMm, mmPerMetre, depthMm, skip = null, heights = null, minMm = 0.6 }) {
  const step = widthMm / (n - 1);
  const inside = (x, y) => x >= 0 && x <= widthMm && y >= 0 && y <= widthMm;
  let lengthMm = 0;
  // each line as samples at most half a grid step apart, so its nearest grid point moves at most one step each way between them
  const lines = rivers.map((line) => {
    const out = [];
    for (let k = 0; k < line.length; k++) {
      const [x, y, w] = line[k];
      const half = Math.max(RIVER_WIDTH_MM, w * mmPerMetre) / 2;
      out.push({ x, y, half, key: `${x},${y}` });
      if (k + 1 === line.length) break;
      const [bx, by] = line[k + 1], len = Math.hypot(bx - x, by - y);
      const parts = Math.max(1, Math.ceil(len / (step / 2)));
      for (let s = 1; s < parts; s++) out.push({ x: x + ((bx - x) * s) / parts, y: y + ((by - y) * s) / parts, half, key: null });
      for (let s = 0; s < parts; s++) {
        const t = (s + 0.5) / parts; // the length on the grid, measured a piece at a time
        if (inside(x + (bx - x) * t, y + (by - y) * t)) lengthMm += len / parts;
      }
    }
    for (const p of out) p.ground = inside(p.x, p.y) ? gridAt(mm, n, widthMm, p.x, p.y) : Infinity;
    return out;
  });
  // The lowest level reaching each shared point, carried on until nothing lowers.
  const level = new Map();
  for (let pass = 0, changed = true; changed && pass < 100; pass++) {
    changed = false;
    for (const line of lines) {
      let run = Infinity;
      for (const p of line) {
        if (p.key) { const l = level.get(p.key); if (l < run) run = l; }
        if (p.ground < run) run = p.ground;
        p.run = run;
        if (p.key && !(level.get(p.key) <= run)) { level.set(p.key, run); changed = true; }
      }
    }
  }
  const bed = new Float64Array(n * n).fill(Infinity);
  for (const line of lines) stampLine(line.map((p) => ({ x: p.x, y: p.y, half: p.half, z: p.run - depthMm })), n, widthMm, bed);
  return { ...setLevels(mm, bed, n, { skip, heights, minMm, raise: depthMm < 0 }), km: lengthMm / mmPerMetre / 1000 };
}

// ---------- zip ----------

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

/** The CRC-32 of a Uint8Array, as ZIP files carry it. */
export function crc32(bytes) {
  let c = 0xffffffff;
  for (let k = 0; k < bytes.length; k++) c = CRC_TABLE[(c ^ bytes[k]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Files ({ name, data: Uint8Array }) as a ZIP archive, stored rather than
 * compressed, so it needs no library and every unzipper reads it. Without
 * ZIP64 it holds up to 4 GB, far past a set of print pieces.
 */
export function zipFiles(files, made = new Date()) {
  const enc = new TextEncoder();
  const time = (made.getHours() << 11) | (made.getMinutes() << 5) | (made.getSeconds() >> 1);
  const date = ((Math.max(1980, made.getFullYear()) - 1980) << 9) | ((made.getMonth() + 1) << 5) | made.getDate();
  const parts = [], central = [];
  let offset = 0;
  for (const { name, data } of files) {
    const nameBytes = enc.encode(name), crc = crc32(data);
    // the fields a local header and its central directory entry share, from "version needed" on
    const common = (v) => {
      v.setUint16(0, 20, true); v.setUint16(2, 0x0800, true); // version 2.0, names in UTF-8
      v.setUint16(4, 0, true); v.setUint16(6, time, true); v.setUint16(8, date, true); // stored
      v.setUint32(10, crc, true); v.setUint32(14, data.length, true); v.setUint32(18, data.length, true);
      v.setUint16(22, nameBytes.length, true); v.setUint16(24, 0, true);
    };
    const local = new Uint8Array(30 + nameBytes.length), lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    common(new DataView(local.buffer, 4));
    local.set(nameBytes, 30);
    const entry = new Uint8Array(46 + nameBytes.length), ev = new DataView(entry.buffer);
    ev.setUint32(0, 0x02014b50, true);
    ev.setUint16(4, 20, true); // made by version 2.0
    common(new DataView(entry.buffer, 6));
    ev.setUint32(42, offset, true); // comment, disk, attributes: all 0
    entry.set(nameBytes, 46);
    parts.push(local, data);
    central.push(entry);
    offset += local.length + data.length;
  }
  const size = central.reduce((s, e) => s + e.length, 0);
  const end = new Uint8Array(22), endv = new DataView(end.buffer);
  endv.setUint32(0, 0x06054b50, true);
  endv.setUint16(8, files.length, true); endv.setUint16(10, files.length, true);
  endv.setUint32(12, size, true); endv.setUint32(16, offset, true);
  const out = new Uint8Array(offset + size + 22);
  let at = 0;
  for (const p of [...parts, ...central, end]) { out.set(p, at); at += p.length; }
  return out;
}

// ---------- saved OpenStreetMap areas ----------

/**
 * OpenStreetMap data is fetched and kept by web-mercator cell rather than by
 * print, so a print that moves, grows or turns over ground already read needs
 * no new query. Buildings come in zoom 16 cells (610 m across at the equator,
 * 450 m at Boston), so the box asked for is at most a cell wider each way than
 * a 2 km print; roads and water in zoom 13 cells (4.9 km, 3.6 km).
 */
export const OSM_CELL_ZOOM = { buildings: 16, roads: 13, water: 13 };
/** Saved cells older than this many days are read again. */
export const OSM_CELL_DAYS = 90;

/** Every cell at zoom z that a lon/lat box touches, as { x, y }, row by row from the north. */
export function cellsForBounds(b, z) {
  const nw = lonLatToTile(b.west, b.north, z), se = lonLatToTile(b.east, b.south, z);
  const last = 2 ** z - 1;
  const clamp = (v) => Math.max(0, Math.min(last, Math.floor(v)));
  const out = [];
  for (let y = clamp(nw.y); y <= clamp(se.y); y++) for (let x = clamp(nw.x); x <= clamp(se.x); x++) out.push({ x, y });
  return out;
}

/** The lon/lat box of one cell at zoom z. */
export function cellBounds({ x, y }, z) {
  const nw = tileToLonLat(x, y, z), se = tileToLonLat(x + 1, y + 1, z);
  return { west: nw.lon, east: se.lon, south: se.lat, north: nw.lat };
}

/**
 * Cells covered by as few lon/lat boxes as a simple sweep finds: runs along
 * each row, then runs of the same columns in rows one under another joined.
 * Asking Overpass for these, not the one box round them all, leaves out the
 * cells already saved between them.
 */
export function cellBoxes(cells, z) {
  const rows = new Map();
  for (const c of cells) (rows.get(c.y) || rows.set(c.y, []).get(c.y)).push(c.x);
  const open = new Map(); // "x0/x1" -> { x0, x1, y0, y1 } still growing down
  const done = [];
  for (const y of [...rows.keys()].sort((a, b) => a - b)) {
    const xs = [...new Set(rows.get(y))].sort((a, b) => a - b);
    const runs = [];
    for (const x of xs) {
      const run = runs[runs.length - 1];
      if (run && x === run.x1 + 1) run.x1 = x; else runs.push({ x0: x, x1: x });
    }
    const next = new Map();
    for (const { x0, x1 } of runs) {
      const key = `${x0}/${x1}`, prev = open.get(key);
      if (prev && prev.y1 === y - 1) { prev.y1 = y; next.set(key, prev); open.delete(key); } else next.set(key, { x0, x1, y0: y, y1: y });
    }
    done.push(...open.values());
    open.clear();
    for (const [k, v] of next) open.set(k, v);
  }
  done.push(...open.values());
  return done.map(({ x0, x1, y0, y1 }) => {
    const nw = cellBounds({ x: x0, y: y0 }, z), se = cellBounds({ x: x1, y: y1 }, z);
    return { west: nw.west, north: nw.north, east: se.east, south: se.south };
  });
}

/** The lon/lat box round an OSM element's geometry (a way's points, or a relation's members'), or null. */
export function elementBounds(el) {
  const points = el.geometry || (el.members || []).flatMap((m) => m.geometry || []);
  if (points.length) return lonLatBounds(points);
  const b = el.bounds;
  return b ? { west: b.minlon, east: b.maxlon, south: b.minlat, north: b.maxlat } : null;
}

/**
 * An Overpass reply shared out among the cells it was asked for, as a Map
 * from "x/y" to that cell's elements. An element goes to every cell its box
 * touches, so one that crosses a cell edge is kept in both.
 */
export function elementsByCell(osm, cells, z) {
  const out = new Map(cells.map((c) => [`${c.x}/${c.y}`, []]));
  for (const el of osm.elements || []) {
    const b = elementBounds(el);
    if (!b) continue;
    for (const { x, y } of cellsForBounds(b, z)) out.get(`${x}/${y}`)?.push(el);
  }
  return out;
}

/** Saved cells' elements as one Overpass-like reply, each element once. */
export function mergeElements(lists) {
  const seen = new Set(), elements = [];
  for (const list of lists) {
    for (const el of list) {
      const id = `${el.type}/${el.id}`;
      if (!seen.has(id)) { seen.add(id); elements.push(el); }
    }
  }
  return { elements };
}

/** Whether a cell read on readAt (YYYY-MM-DD) is due to be read again on today. */
export function cellStale(readAt, today, days = OSM_CELL_DAYS) {
  return (Date.parse(today) - Date.parse(readAt)) / 86400000 > days;
}
