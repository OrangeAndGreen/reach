// core.js - the pure part of Reach: tile maths, distance, height profiles,
// drive-time grids, and the KML/CSV writers. No DOM, no network, so every
// function here runs under `node --test`.

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

/** Elevation in metres from one pixel of a Terrarium-encoded tile. */
export function terrariumElevation(r, g, b) {
  return r * 256 + g + b / 256 - 32768;
}

/**
 * Removes single-pixel glitches from a tile of elevations. The terrain tiles
 * carry the odd spike (2,375 m in the shallows off Cuba, beside 0-12 m
 * water), and a "highest point" tool finds every one of them. A pixel that
 * stands more than its own height clear of the third-highest value in its
 * 3x3 block (and at least 60 m) is replaced by that third-highest value. Real
 * peaks pass, because their neighbours are high too.
 */
export function despike(elev, size = 256) {
  const out = Float32Array.from(elev);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // The three highest values in the 3x3 block, kept by hand: this runs per pixel.
      let a = -Infinity, b = -Infinity, c = -Infinity, n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= size) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= size) continue;
          const v = elev[yy * size + xx];
          n++;
          if (v > a) { c = b; b = a; a = v; } else if (v > b) { c = b; b = v; } else if (v > c) c = v;
        }
      }
      const third = n >= 3 ? c : b;
      const e = elev[y * size + x];
      if (e - third > Math.max(60, Math.abs(third))) out[y * size + x] = third;
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

// ---------- printable terrain ----------

/** The lon/lat box of a square sideKm across, centred on center. */
export function squareBounds(center, sideKm) {
  const deg = kmPerDegree(center.lat);
  const dLon = sideKm / 2 / deg.lon;
  const dLat = sideKm / 2 / deg.lat;
  return { west: center.lon - dLon, east: center.lon + dLon, south: center.lat - dLat, north: center.lat + dLat };
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
 * Scales a height grid to millimetres: the model is widthMm across, the base
 * slab is baseMm thick under the lowest point, and heights are stretched by
 * exaggeration. Sea floor is cut to sea level when clampSea is set.
 */
export function printHeights(heights, { sideKm, widthMm, exaggeration = 1, baseMm = 3, clampSea = true }) {
  const metres = clampSea ? heights.map((h) => Math.max(0, h)) : heights;
  let lo = Infinity, hi = -Infinity;
  for (const h of metres) { if (h < lo) lo = h; if (h > hi) hi = h; }
  const mmPerMetre = widthMm / (sideKm * 1000);
  const mm = metres.map((h) => baseMm + (h - lo) * mmPerMetre * exaggeration);
  return { mm, lowM: lo, highM: hi, reliefMm: (hi - lo) * mmPerMetre * exaggeration, mmPerMetre };
}

/**
 * A closed, printable binary STL of an n x n height grid (row 0 north): the
 * terrain on top, four walls down to z = 0, and a bottom fanned from its centre.
 * Every edge is shared by exactly two triangles, so slicers take it as solid.
 */
export function terrainStl(zMm, n, widthMm) {
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
