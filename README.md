# Reach

How high, and how far, you can get from a place, and a piece of it to print.
Three tools on one map:

- **Height**: for each distance from a place, the highest ground anywhere
  within it. Compare up to four places on one graph. Boston climbs gradually to
  Mt Washington (1,916 m, 213 km out). Cape Town is at 1,000 m within 5 km. Miami
  has to cross to Cuba.
- **Drive**: drive-time contours (4, 8, 12 hours by default) from one start,
  with a graph of how far, and how much ground, each extra hour buys. **Find
  the high ground** then reads the tallest point inside each band. **Download
  KML** saves the bands and their placemarks for Google Earth.
- **Print**: a square of real terrain (2 to 160 km across) as a closed binary
  STL for the slicer. Choose the model width, the detail, a height stretch and
  the base thickness. A preview you can turn shows the model, beside its real
  dimensions and scale. The default is the 20 km around Mt Washington:
  120 × 120 × 17.6 mm at ×1.5.

All three started as ideas parked in ViggiPy's `TODO.txt`: the
distance-to-height graph (Miami, Boston, Cape Town), the drive-distance graph
maker with time-contour placemarks, and 3D-printed landscapes from DEM data.

## Run it

```
npm start        # http://localhost:8732
npm test
```

On an Android phone plugged in over adb, `adb reverse tcp:8732 tcp:8732` makes
the PC's server answer at http://localhost:8732 on the phone, and Chrome then
offers to install Reach as an app. The app still needs the PC serving it and
the reverse in place.

No install step. The page loads Leaflet, d3 and three.js from CDNs, and its own code as
ES modules, which is why it needs the little server rather than file://.

## Where the numbers come from

| What | Source | Notes |
|---|---|---|
| Elevation | Mapzen Terrain Tiles on AWS (Terrarium PNGs) | free, no key, CORS open |
| Road times | OSRM public demo server, `table` service | fair use: a run is 4 to 11 calls of 300 points, 0.7 s apart, and is cached in the browser |
| Place search | Open-Meteo geocoding | the same service Goldilocks uses |
| Map click names | Nominatim reverse geocoding | one call per click |

- **Height** reads every DEM pixel within the radius at the most detailed zoom
  that stays under 160 tiles. Then it re-reads each step of the
  running maximum at zoom 12 (about 30 m), so summits come out true instead of
  averaged down.
- **Despiking.** The tiles carry single-pixel glitches: 2,375 m in the shallows
  off Cuba, 123 m in the Everglades. A pixel standing more than its own height
  (and at least 60 m) above the third-highest value in its 3x3 block is
  flattened to that value. Real summits pass, because their neighbours are high
  too. A one-pixel island can be lost.
- **Drive** asks OSRM for the time from the start to every point of an n×n grid
  (32, 44 or 56 across), sized to the longest limit at 95 km/h. A point more
  than half a grid step (20 km at most) from a road counts as unreachable, so
  the sea doesn't take on the coast's times. Contours come from d3-contour over
  the grid. Detail is about one grid step, so a Quick 12-hour run is accurate
  to about 75 km.
- **Print** samples the terrain bilinearly on an n×n grid, from the most
  detailed zoom whose pixels are at least twice as fine as a grid cell (64 tiles
  at most). The sea is cut to sea level. The mesh is the terrain, four walls and
  a bottom fanned from its centre. A test checks that every edge is shared by
  exactly two triangles and wound consistently, so it is watertight.
- OSRM times are free-flow with no traffic or stops, and its car speeds are
  conservative. Boston's 12-hour line lands short of where a real day's drive
  ends.

## Layout

- `src/core.js`: everything pure. Tile maths, haversine, the height profile,
  the drive grid, interpolation, despiking, formatting, KML, CSV and the STL
  mesh. Tested in
  `test/core.test.mjs`.
- `src/chart.js`: the SVG line chart (d3 scales, crosshair tooltip, direct
  labels).
- `src/app.js`: the page. Map, search, tile loading, OSRM batches, exports.
