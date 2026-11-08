// Shows Britain's transit map on Apple Maps with MapKit JS, from
// out/gb.transit.json (see src/render.ts), the same way the app does.
//
// The lines are drawn ahead of time (src/render.ts): zoomed out, one line per
// corridor for each set of lines shown; from zoom 13, one drawing of lines
// side by side by LOOM's transitmap, whose widths are scaled as you zoom to
// keep in step with its spacing. Stations are a dot on each line calling
// there, in its colour, or one white dot zoomed out.

const status = document.getElementById('status')

/** Station dots from this zoom in, coloured from `COLOURED_DOTS_ZOOM`, and
 *  named from `LABELS_ZOOM`. */
const STATIONS_ZOOM = 10
const COLOURED_DOTS_ZOOM = 13
const LABELS_ZOOM = 12

mapkit.init({
  authorizationCallback: (done) => fetch('token').then((r) => r.text()).then(done),
})

const map = new mapkit.Map('map', {
  // Muted, like the app (`.standard(emphasis: .muted)`), so the lines stand out
  mapType: mapkit.Map.MapTypes.MutedStandard,
  colorScheme: mapkit.Map.ColorSchemes.Light,
  pointOfInterestFilter: mapkit.PointOfInterestFilter.excludingAllCategories,
  showsCompass: mapkit.FeatureVisibility.Adaptive,
})

const response = await fetch('data/gb.transit.json')
if (!response.ok) {
  status.textContent = 'No map yet – run npm run build first'
  throw new Error(status.textContent)
}
const transit = await response.json()
/** From one line's middle to the next, in points. */
const pitch = transit.pitchPoints

/** Google's encoded polyline format, 5 decimal places. */
function decode(line) {
  const points = []
  let lat = 0, lon = 0, i = 0
  const next = () => {
    let result = 0, shift = 0, byte
    do {
      byte = line.charCodeAt(i++) - 63
      result |= (byte & 0x1f) << shift
      shift += 5
    } while (byte >= 0x20)
    return result & 1 ? ~(result >> 1) : result >> 1
  }
  while (i < line.length) {
    lat += next()
    lon += next()
    points.push(new mapkit.Coordinate(lat / 1e5, lon / 1e5))
  }
  return points
}

// MARK: Lines

/** A line's style, its width times `scale`. */
const lineStyle = (colour, scale) => new mapkit.Style({
  strokeColor: `#${colour}`,
  lineWidth: (transit.widths[colour] ?? transit.linePoints) * scale,
  lineCap: 'round',
  lineJoin: 'round',
})

/** Each step's line overlays, made when first shown. */
const overlays = new Map()
function overlaysAt(index) {
  if (!overlays.has(index)) {
    overlays.set(index, transit.steps[index].lines.map(([colour, line]) => {
      const overlay = new mapkit.PolylineOverlay(decode(line), { style: lineStyle(colour, 1) })
      overlay.colour = colour
      return overlay
    }))
  }
  return overlays.get(index)
}

/** Apple's road widths in points at each zoom level from 0, as the app gets
 *  them from MKRoadWidthAtZoomScale, for lines to widen and narrow with. */
const ROAD_POINTS = [2, 2, 2, 2, 2, 2, 2, 3, 3, 3, 4, 4, 6, 6, 7, 9, 11, 12, 15, 16]
const roadAt = (z) => {
  const i = Math.max(0, Math.min(ROAD_POINTS.length - 1, Math.round(z)))
  return ROAD_POINTS[i]
}

/** How much faster lines widen than roads, closer in (lines side by side
 *  have room to, as their gaps widen faster still; as in the app). */
const WIDTH_GROWTH = 1

/** How much wider than drawn to show a step's lines at a zoom: side by side,
 *  as roads widen and narrow from the zoom it's drawn for, to the power of
 *  WIDTH_GROWTH, no thinner than half (as in the app). Roads change width
 *  in whole steps, so overlays aren't restyled every frame. */
const scaleAt = (z, index) => Math.max(0.5, (roadAt(z) / roadAt(transit.steps[index].drawn ?? transit.steps[index].zoom)) ** WIDTH_GROWTH)

/** The map's zoom level, from its size on screen. */
function zoom() {
  const width = map.element.clientWidth || 1
  const metresPerPoint = ((map.region.span.longitudeDelta / 360) * 40_075_016.686) / width
  return Math.log2(156_543.034 / metresPerPoint)
}

/** The step for a zoom level: the last starting at or before it, to the
 *  nearest whole zoom. */
const stepIndex = (z) => Math.max(0, transit.steps.findLastIndex((s) => s.zoom <= z + 0.5))

// MARK: Stations

/** Each zoom band's stations (steps say which), as lines are merged further
 *  out and stations are drawn where their lines are. */
const stationSets = transit.stationSets.map((set) => set.map(([station, lon, lat, angle, ...colours]) =>
  ({ name: station, coordinate: new mapkit.Coordinate(lat, lon), angle, colours })))
/** The stations zoomed in. */
const stations = stationSets[0]

/** A station's dots: one on each line, side by side across the lines, or
 *  one white dot. Turned back by the map's rotation. */
function dots(station, coloured, labelled, scale, spread) {
  // A zero-size anchor (MapKit JS pins an annotation's bottom centre to its
  // coordinate), with the dots centred on it
  const anchor = document.createElement('div')
  anchor.style.cssText = 'position:relative;width:0;height:0'
  const element = document.createElement('div')
  anchor.append(element)
  const centred = 'position:absolute;left:0;top:0;'
  if (coloured) {
    const size = transit.linePoints * scale + 3
    element.style.cssText = `${centred}display:flex;gap:${pitch * spread - size}px;transform:translate(-50%,-50%) rotate(${station.angle + 90 - map.rotation}deg)`
    // Leading is the left of the lines' direction; colours run right to left
    for (const colour of [...station.colours].reverse()) {
      const dot = document.createElement('div')
      dot.style.cssText = `width:${size}px;height:${size}px;border-radius:50%;background:#${colour};box-shadow:0 0 0 1px #fff`
      element.append(dot)
    }
  } else {
    element.style.cssText = `${centred}width:7px;height:7px;border-radius:50%;background:#fff;box-shadow:0 0 0 1.5px rgba(0,0,0,0.7);transform:translate(-50%,-50%)`
  }
  if (labelled) {
    // Beside the dots, clear of them however they're turned
    const label = document.createElement('div')
    label.className = 'label'
    label.textContent = station.name
    const offset = coloured ? (station.colours.length * pitch * spread) / 2 + 6 : 7
    label.style.cssText = `position:absolute;left:${offset}px;top:0;transform:translateY(-50%)`
    anchor.append(label)
  }
  return anchor
}

/** Stations are thinned to one in each square this many points across (as
 *  in the app), so busy areas don't draw hundreds of dots at once. */
const STATION_SPACING = 64

/** One station in each square STATION_SPACING points across at a zoom, the
 *  one with the most lines. The squares are fixed to the map, so the same
 *  stations show as it pans. */
function thinned(list, z) {
  const size = (256 * 2 ** z) / STATION_SPACING
  const kept = new Map()
  for (const s of list) {
    const x = (s.coordinate.longitude + 180) / 360
    const sin = Math.sin((s.coordinate.latitude * Math.PI) / 180)
    const y = 0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)
    const square = `${Math.floor(x * size)},${Math.floor(y * size)}`
    const other = kept.get(square)
    if (!other || s.colours.length > other.colours.length) kept.set(square, s)
  }
  return [...kept.values()]
}

/** The station annotations on the map, by station and how they're drawn,
 *  so only those that change are added or removed. */
let shownAnnotations = new Map()
/** Station dots in or near view, at zoom 10 and closer. */
function showStations(z, scale) {
  const wanted = new Map()
  if (z >= STATIONS_ZOOM) {
    const { stations: set, bundled, drawn } = transit.steps[stepIndex(z)]
    // Lines' spacing is fixed on the ground, so it doubles each zoom level in
    const spread = bundled === false ? 1 : 2 ** (Math.round((z - drawn) * 10) / 10)
    const coloured = z >= COLOURED_DOTS_ZOOM, labelled = z >= LABELS_ZOOM
    const { center, span } = map.region
    // The view and a quarter of it around, so small pans keep their dots
    const inView = stationSets[set].filter((s) => Math.abs(s.coordinate.latitude - center.latitude) < span.latitudeDelta * 0.75
      && Math.abs(s.coordinate.longitude - center.longitude) < span.longitudeDelta * 0.75)
    // Coloured dots are sized by the scale and turned by the map's rotation
    const look = coloured ? `${scale}|${spread}|${Math.round(map.rotation)}` : ''
    for (const s of thinned(inView, Math.round(z))) wanted.set(`${s.name}|${s.coordinate.latitude}|${coloured}|${labelled}|${look}`, s)
    for (const [key, s] of wanted) {
      wanted.set(key, shownAnnotations.get(key) ?? new mapkit.Annotation(s.coordinate, () => dots(s, coloured, labelled, scale, spread), {
        title: s.name, calloutEnabled: true,
      }))
    }
  }
  map.removeAnnotations([...shownAnnotations].filter(([key]) => !wanted.has(key)).map(([, a]) => a))
  map.addAnnotations([...wanted].filter(([key]) => !shownAnnotations.has(key)).map(([, a]) => a))
  shownAnnotations = wanted
}

// MARK: Updating

let shown, showing = [], scaled
function update(moving) {
  const z = zoom()
  const index = stepIndex(z)
  const scale = scaleAt(z, index)
  if (index !== shown || scale !== scaled) {
    const next = overlaysAt(index)
    for (const overlay of next) overlay.style = lineStyle(overlay.colour, scale)
    if (index !== shown) {
      map.removeOverlays(showing)
      map.addOverlays(next)
    }
    shown = index
    scaled = scale
    showing = next
  }
  if (!moving) showStations(z, scale)
  // For debugging: the zoom, the step drawn and how much is on the map
  status.textContent = `Zoom ${z.toFixed(1)} · step ${transit.steps[shown].zoom} × ${scale.toFixed(2)} · ` +
    `${showing.length} lines · ${shownAnnotations.size} stations`
}

// Follow the zoom while the map moves, not just when it stops
let moving = false
const follow = () => { update(true); if (moving) requestAnimationFrame(follow) }
map.addEventListener('region-change-start', () => { if (!moving) { moving = true; requestAnimationFrame(follow) } })
map.addEventListener('region-change-end', () => { moving = false; update(false) })

// Start on the whole network
const lats = stations.map((s) => s.coordinate.latitude), lons = stations.map((s) => s.coordinate.longitude)
map.region = new mapkit.BoundingRegion(Math.max(...lats), Math.max(...lons), Math.min(...lats), Math.min(...lons)).toCoordinateRegion()
update(false)
