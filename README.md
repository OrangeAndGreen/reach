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
  Central Park. On the map, drag the centre dot to move it or the outline to
  resize it: the shape grows about its centre, a rectangle's side moves alone,
  and sizes snap to 10 m, 100 m or 1 km as they grow. On prints of 2 km or less across it can raise the buildings
  from OpenStreetMap too, and on prints of 50 km or less the main roads and the lakes and rivers, and on prints of 25 km or less the secondary roads as well if you ask for them. Each road class (motorway, trunk, primary, secondary) and each kind of water (lakes, wide rivers, narrow rivers) has its own level, typed in mm on the model: positive raises it, negative sinks it, 0 leaves it out (up to 10 mm either way). By default roads are raised 1.2, 0.8, 0.4 and 0.4 mm and water is sunk 0.6 mm. Tracks of your own (a hike, a ride, a route drawn in Google Earth) come in from KML files, one or several at a time, and each sits in a list with its own level in mm, typed the same way (0.8 at first) and a button to take it off the model; they show on the map in red, dashed when left out, and are remembered between visits. Choose the model width (the shape's width across), the detail, a height stretch and
  the base thickness, and whether the sea floor comes too (down to 50 m, 200 m,
  1,000 m or all the way, with its own depth stretch), and whether to mark the
  shoreline with a ridge or a groove, its level typed in mm (positive a ridge that high, negative a groove that deep) to paint or just to see the coast by. It can also cut a label 0.6 mm up into the underside, mirrored so it reads when you turn the print over: the centre's coordinates, the ground covered and the height stretch (and the depth stretch, when the sea floor has its own), under an arrow pointing north, with up to three lines of your own text between the arrow and them, or your text alone. It can also cut a notch to balance the print on a pencil point: a cone up into the underside under the centre of mass, its walls 30° from upright so it prints without support, found for the infill you'll print at (the walls and skins weigh more than the infill) and cut up past the centre of mass, 2 mm where the model is thick enough, so the print hangs level from the point, always leaving 1.2 mm over it; a label moves aside to clear it. The corners are rounded, 5 mm by default (or 10 mm, or square), so a wide slab is slower to lift off the bed: a square's ground is squeezed into the curve, another shape's is cut off along it, and a star rounds only its points. A preview you can turn shows the model, beside its real
  dimensions and scale. Beside the height stretch it suggests one for the ground,
  which grows with the square root of how flat it is (Mt Washington's 20 km
  ×1.5, Boston's ×6, at most ×20), with a button to use it. The default is the 20 km around Mt Washington:
  120 × 120 × 17.6 mm at ×1.5. **Download KML** saves the outline for Google
  Earth along with every setting (centre, size, width, detail, stretch, base, sea floor, shoreline, label and its text, corners, shape, turn, each track printed, as its own line with its level, and each bin, as a pin at its centre with its ring or grid)
  and what came of them (tile zoom, metres per pixel, lowest and highest point,
  model height, scale, triangle count, STL file name). A KML from before the per-class levels opens with its roads raised as they were and its water all sunk its one depth. **Open KML** reads one
  back and builds the same STL again. **Download map image** saves the map
  layer on show (Terrain or Streets) cropped to the print (turned to match, and clear outside its shape), as a PNG of up to
  2,048 px with the map's credit in the corner.
- **Bins**, on the Print tab's third settings tab: holes cut straight down
  into the top to stand things in, such as SD cards, AA or 18650 batteries,
  so each stands part way out and is easy to grab. Pick a thing (or type your
  own size), and a bin is its footprint plus a clearance (0.4 mm), as a
  rectangle, a circle or an oval (length by width), turned any way. A bin can
  repeat as a ring (how many, the radius, and each turned toward the centre,
  along the ring or all the same way; the radius follows a suggestion that
  keeps them apart until you type your own) or a grid (across, down and the
  gap), all on one card, the pattern moved by its centre and turned whole;
  Split makes each of its bins a card of its own. The depth is measured down from the
  lowest, average or highest ground under the bin, so on a slope it can be
  deep everywhere or open on its low side. The floor is flat and the walls
  upright, and the base grows when a floor would leave less than 1.5 mm under
  it. Each bin is outlined on the map, with a dot to drag it by. Raised roads,
  tracks and buildings keep 1 mm clear of a bin. A bin too near the edge, in a
  rounded corner, over another or across a seam between pieces is left out,
  and its card says why.

Reach keeps what it reads between visits, in the browser's IndexedDB, so a
place you come back to costs no new download: the elevation tiles (up to 3,000,
the oldest dropped first; they never change), and OpenStreetMap's buildings and
roads, lakes and rivers by map cell (buildings in cells about 450 m across at Boston, roads and water 3.6
km), read again after 90 days. A lake is kept cut to each cell, so a print on
Lake Michigan's shore keeps its own few km of shoreline, not the whole lake. A print that moves, grows or turns asks Overpass
only for the cells it hasn't seen, and the KML's "read" date is the oldest
cell's. A line under Print says how much is kept, with a button to clear it.

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
| Buildings, roads, lakes and rivers | OpenStreetMap through the Overpass API | one call each per print, kept for the session; © OpenStreetMap contributors, ODbL |

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
  detailed zoom whose pixels are at least twice as fine as a grid cell (100 tiles
  at most). The detail sets the spacing on the model, not the count: Draft is
  1 mm, Standard 0.6 mm and Fine 0.4 mm, about one nozzle line, so a 250 mm
  model at Fine is 626 × 626 and a 120 mm one 301 × 301. Past the tiles' own
  detail (zoom 14, and about 30 m behind it outside the US, 10 m inside) more
  points only smooth what is there, so Fine pays on wide prints of big ground
  more than on small ones. The sea is cut to sea level unless the sea floor is asked for.
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
- **Roads.** Motorway, trunk and primary ways, and secondary ones when asked
  for, joined end to end per class, are 1.6, 1.2, 0.8 or 0.6 mm wide (or the
  real carriageway, 25, 20, 14 or 10 m, where
  a small print makes that wider), at their class's level over or under the
  ground along them averaged over 1.5 mm either way. A raised road is its own
  closed solid, a ribbon whose floor sits just under the terrain. A sunk road
  is a groove cut into the terrain grid, the points within half its width and
  the point nearest its line all along, so it never breaks on a diagonal; it
  leaves lakes and rivers' areas alone, where the road crosses on a bridge, and
  keeps 0.6 mm of model under it. Tunnels
  drop out and ramps aren't fetched. Where solids cross, the slicer merges
  them. Classes are as OSM tags them: Chicago's arterials (Cermak, Roosevelt,
  Michigan Avenue) are secondary, so a 10 km Loop print of the main roads
  shows only its expressways and Lake Shore Drive. Secondary roads are fetched
  and kept apart from the main ones, so asking for them never reads the main
  roads again.
- **Tracks.** Every LineString and `gx:Track` (a GPS log's) in a KML
  placemark is one track, named as the placemark is; points, polygons and the
  file's heights are ignored. A track is 1.2 mm wide on the model at any scale,
  and printed as a road is: raised, its own solid on the ground along it
  smoothed over 1.5 mm; sunk, a groove that leaves lakes and rivers' areas
  alone and keeps 0.6 mm of model under it.
- **Lakes and rivers.** Water areas (`natural=water` and `waterway=riverbank`,
  ways and multipolygons, but not wastewater or anything covered) fill the grid
  points inside them, even-odd so islands stay land. Water at or under sea level is left to the sea, and
  patches under 4 mm² on the model are dropped. Lakes and wide rivers each
  have their own level: a riverbank, or water tagged as a river, canal or
  stream, is a wide river, and the rest is a lake (where they overlap, the
  lake). Each point sinks its depth under, or is raised its height over,
  the lowest water within two grid steps of it. Raised water only lifts the
  ground and never cuts it. A lake reads flat in the
  elevation data, so it prints as one level under its shore, and the window reaches past the
  blur at the shore that would lift the edge. A river steps down its valley.
  The water is carved before buildings and roads are stood on the terrain, so a
  bridge reaches down into the channel rather than float.
- **Narrow rivers.** Rivers mapped only as lines (`waterway=river`, not
  streams, canals or culverts) are cut as channels: the grid points within
  half the river's width of its line (OSM's `width`, or 20 m, and never under
  0.8 mm on the model), and the point nearest the line all along it, so the
  channel never breaks on a diagonal. The bed is the sinking depth under the
  lowest ground the river has passed over since its source, read along the
  line in the way OSM draws it, downstream. So a channel only ever steps down,
  cutting through the bumps where the elevation data and the mapped line
  disagree. Raised, the same level plus the height makes a ridge, which lifts
  the ground but never cuts it, so it can vanish over a bump in the data.
  Where rivers share a point (a tributary joining, a river drawn in
  several ways) the lowest level reaching it goes on down each. Lines inside a
  lake or river area are left to it. A 20 km square around Bartlett, NH cuts
  76 miles of river channel. A river's level starts
  again at each piece's edge, so across a seam it can step up a little.
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
