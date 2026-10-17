# Reach

How high, and how far, you can get from a place, and a piece of it to print.
Three tools on one map:

- **Height**: for each distance from a place, the highest ground anywhere
  within it. Compare up to eight places on one graph. Boston climbs gradually to
  Mt Washington (1,916 m, 213 km out). Cape Town is at 1,000 m within 5 km. Miami
  has to cross to Cuba.
- **Drive**: drive-time contours (4, 8, 12 hours by default) from one start,
  with a graph of how far, and how much ground, each extra hour buys. **Find
  the high ground** then reads the tallest point inside each band. **Download
  KML** saves the bands and their placemarks for Google Earth.
- **Print**: a piece of real terrain (100 m to 500 km across) as a closed binary
  STL for the slicer. It can be a square, a rectangle (3:2 to 5:1), a circle, a
  hexagon, a triangle or a five-pointed star, turned up to 90° either way so its
  top faces any bearing: a 4 km by 0.8 km rectangle turned to 29° lines up with
  Central Park. On prints of 2 km or less across it can raise the buildings
  from OpenStreetMap too. Choose the model width (the shape's width across), the detail, a height stretch and
  the base thickness, and whether the sea floor comes too (down to 50 m, 200 m,
  1,000 m or all the way, with its own depth stretch), and whether to mark the
  shoreline with a groove or a ridge (0.4 or 0.8 mm) to paint or just to see the coast by. It can also cut a label 0.6 mm up into the underside, mirrored so it reads when you turn the print over: the centre's coordinates, the ground covered and the height stretch (and the depth stretch, when the sea floor has its own). The corners are rounded, 5 mm by default (or 10 mm, or square), so a wide slab is slower to lift off the bed: a square's ground is squeezed into the curve, another shape's is cut off along it, and a star rounds only its points. A preview you can turn shows the model, beside its real
  dimensions and scale. The default is the 20 km around Mt Washington:
  120 × 120 × 17.6 mm at ×1.5. **Download KML** saves the outline for Google
  Earth along with every setting (centre, size, width, detail, stretch, base, sea floor, shoreline, label, corners, shape, turn)
  and what came of them (tile zoom, metres per pixel, lowest and highest point,
  model height, scale, triangle count, STL file name). **Open KML** reads one
  back and builds the same STL again. **Download map image** saves the map
  layer on show (Terrain or Streets) cropped to the print (turned to match, and clear outside its shape), as a PNG of up to
  2,048 px with the map's credit in the corner.

All three started as ideas parked in ViggiPy's `TODO.txt`: the
distance-to-height graph (Miami, Boston, Cape Town), the drive-distance graph
maker with time-contour placemarks, and 3D-printed landscapes from DEM data.

## Run it

Live at https://orangeandgreen.github.io/reach/. Every push to `master`
publishes `src/` there (`.github/workflows/pages.yml`, after the tests pass).
On Android, open it in Chrome and choose Install. On the PC, Chrome or Edge
can install it from the address bar.

Locally:

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
| Buildings | OpenStreetMap through the Overpass API | one call per print square, kept for the session; © OpenStreetMap contributors, ODbL |

- **Height** reads every DEM pixel within the radius at the most detailed zoom
  that stays under 160 tiles. Then it re-reads each step of the
  running maximum at zoom 12 (about 30 m), so summits come out true instead of
  averaged down.
- **Despiking.** The tiles carry single-pixel glitches: 2,375 m in the shallows
  off Cuba, 123 m in the Everglades. A pixel standing more than its own height
  (and at least 60 m) above the third-highest value in its 3x3 block is
  flattened to that value. Real summits pass, because their neighbours are high
  too. A one-pixel island can be lost. The same test runs across each pixel's
  left/right and upper/lower neighbours, for one-pixel streaks. Heights no
  place on Earth has (the tiles' no-data patches decode to 32,767 m) count as
  missing. And the zoom-12 re-read replaces the coarse value rather than
  competing with it, so a glitch patch in a coarse tile can't outrank the
  truth.
- Tall buildings are in the data. Within 100 km of Miami the top is 71 m, the
  condo towers of Sunny Isles Beach.
- **Drive** asks OSRM for the time from the start to every point of an n×n grid
  (32, 44 or 56 across), sized to the longest limit at 95 km/h. A point more
  than half a grid step (20 km at most) from a road counts as unreachable, so
  the sea doesn't take on the coast's times. Contours come from d3-contour over
  the grid. Detail is about one grid step, so a Quick 12-hour run is accurate
  to about 75 km.
- **Print** samples the terrain bilinearly on an n×n grid, from the most
  detailed zoom whose pixels are at least twice as fine as a grid cell (64 tiles
  at most). The sea is cut to sea level unless the sea floor is asked for.
- **Sea floor.** The tiles only carry it up to zoom 10 (75 to 150 m a pixel,
  by latitude). From zoom 11 every sea pixel reads 0: Monterey Canyon is
  -657 m at zoom 10 and 0 at zoom 11. So a print reads the land at its own
  zoom and the sea floor at zoom 10, and where the detailed reading is at or
  below sea level the deeper of the two wins. Where the two sources meet, the
  odd pixel drops far below its neighbours (-4,348 m beside 4 m of beach at
  Monterey), so despiking flattens lone pits the same way it flattens spikes.
  Lakes are their flat surface at every zoom, and fjords barely show
  (Oslofjord is about -5 m). The mesh is the terrain, four walls and
  a bottom fanned from its centre. A test checks that every edge is shared by
  exactly two triangles and wound consistently, so it is watertight.
- **Shoreline.** The line is every land point (above 0 m) with a sea point
  (at or below 0 m) to its north, south, east or west, lowered by the groove
  depth or raised by the ridge height, so it is a V (or an upside-down V) one
  grid step wide on each side and the mesh stays a closed height grid. Patches of fewer than 8 points at or below sea level
  don't count as sea, so a quarry or a dip in the data draws no ring. Lakes
  read as flat land above 0 m, so lakeshores get no line. In the preview the
  line is drawn dark.
- **Buildings.** Each footprint becomes its own closed solid, from just under
  the terrain beneath it up to its ground plus its height, at the land's height
  stretch. The height is OSM's `height`, or its floors (`building:levels` plus
  `roof:levels`) at 3 m each, or the chosen default where it has neither (about
  9% of buildings in Manhattan, 18% in Sunny Isles Beach). Courtyards stay open, outlines are cut at
  the square's edge, and an outline too broken to close (crossing itself,
  courtyards touching it) prints as itself without courtyards, or failing that
  as its convex hull. Footprints under 0.4 mm² on the model are left out. Roofs on posts
  (`building=roof`) and underground buildings are skipped. A 2 km square of
  Manhattan is about 3,000 buildings and a 9 MB STL.
- **Buildings already in the elevation data.** Mostly they aren't: at the
  print zooms the tiles are bare earth under the buildings OSM maps in
  Manhattan, Sunny Isles Beach, Midtown Miami and Dubai Marina. The tall
  readings in Height's Miami run are structures OSM doesn't map and elevated
  roads. A building's ground is therefore the terrain under its own footprint.
  Two checks catch the exceptions. One building standing more than 4 m (and
  40% of its height) above nearly everything around it is in the data, and
  the ground under it is lowered to the ground around it. And where the tiles
  are a surface model for the whole city, as SRTM is, the ground under the
  buildings stands well above the open ground near them: 8 m in Mong Kok and
  5 m on São Paulo's Avenida Paulista, against 0.2 m in Manhattan. Over 4 m,
  the Print tab says the land will print lumpy under the buildings.
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
- `src/earcut.js`: Mapbox's earcut 3.0.1 (ISC), vendored unchanged, which
  triangulates building roofs and floors.
