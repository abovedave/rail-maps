// Shows Britain's transit map on Apple Maps with MapKit JS, from
// out/gb.transit.json (see map/render.ts).
//
// Lines sharing track are drawn side by side here (bundles.js), from the
// line graph, for the map's zoom. Stations are a dot on each line calling
// there, in its colour, or one white dot zoomed out.

import { draw, prepare } from './bundles.js'

const status = document.getElementById('status')
const params = new URLSearchParams(location.search)

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

/** Google's encoded polyline format, as pairs of numbers at a precision
 *  (5 decimal places). */
function decodePairs(line, factor) {
  const pairs = []
  let a = 0, b = 0, i = 0

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
    a += next()
    b += next()
    pairs.push([a / factor, b / factor])
  }

  return pairs
}

// MARK: Zoom and widths

/** The map's zoom level, from its size on screen. */
function zoom() {
  const width = map.element.clientWidth || 1
  const metresPerPoint = ((map.region.span.longitudeDelta / 360) * 40_075_016.686) / width

  return Math.log2(156_543.034 / metresPerPoint)
}

const metresPerPoint = (z) => 156_543.034 / 2 ** z

/** A line's style at a width in points. */
const lineStyle = (colour, width) => new mapkit.Style({
  strokeColor: `#${colour}`, lineWidth: width, lineCap: 'round', lineJoin: 'round',
})

// MARK: Lines

/** Lines are pitchPoints apart (centre to centre) at zoom 14, doubling
 *  every two levels in and halving every two out, but never closer than
 *  minPitchPoints; linePoints of pitchPoints of that wide, up to 3 points. */
const bundles = prepare(transit.graph)
const pitchAt = (z) => Math.max(transit.minPitchPoints, transit.pitchPoints * 2 ** ((z - 14) / 2))
const widthAt = (z) => Math.min(3, (pitchAt(z) * transit.linePoints) / transit.pitchPoints)

/** The zoom lines are drawn for: every half level from zoom 12, every whole
 *  level further out (where less changes), from zoom 5 to 19. */
const levelAt = (z) => Math.min(19, Math.max(5, z >= 12 ? Math.round(z * 2) / 2 : Math.round(z)))

/** Each level's line overlays, made when first shown. */
const overlays = new Map()

function overlaysAt(level) {
  if (!overlays.has(level)) {
    overlays.set(level, draw(bundles, metresPerPoint(level), pitchAt(level)).map(({ colour, points }) => {
      const overlay = new mapkit.PolylineOverlay(points.map(([lat, lon]) => new mapkit.Coordinate(lat, lon)), { style: lineStyle(colour, widthAt(level)) })

      overlay.colour = colour

      return overlay
    }))
  }

  return overlays.get(level)
}

/** The level drawn, and its overlays: kept while the map moves, as drawing
 *  takes a moment. */
let shown = { level: undefined, overlays: [] }

function showLines(z, moving) {
  const level = moving && shown.level !== undefined ? shown.level : levelAt(z)

  if (level !== shown.level) {
    const next = overlaysAt(level)

    map.removeOverlays(shown.overlays)
    map.addOverlays(next)
    shown = { level, overlays: next }
  }

  return shown.overlays.length
}

/** How wide lines are, as a multiple of linePoints, and how much further
 *  apart than pitchPoints: for station dots to match. */
const pitch = transit.pitchPoints

function lineScale() {
  return { scale: widthAt(shown.level) / transit.linePoints, spread: pitchAt(shown.level) / pitch }
}

// MARK: Stations

const stations = transit.stations.map(([station, lon, lat, angle, ...colours]) =>
  ({ name: station, coordinate: new mapkit.Coordinate(lat, lon), angle, colours }))

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
function showStations(z) {
  const wanted = new Map()

  if (z >= STATIONS_ZOOM) {
    const { scale, spread } = lineScale()
    const coloured = z >= COLOURED_DOTS_ZOOM, labelled = z >= LABELS_ZOOM
    const { center, span } = map.region

    // The view and a quarter of it around, so small pans keep their dots
    const inView = stations.filter((s) => Math.abs(s.coordinate.latitude - center.latitude) < span.latitudeDelta * 0.75
      && Math.abs(s.coordinate.longitude - center.longitude) < span.longitudeDelta * 0.75)

    // Coloured dots are sized by the scale and turned by the map's rotation
    const look = coloured ? `${scale.toFixed(2)}|${spread.toFixed(2)}|${Math.round(map.rotation)}` : ''

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

// MARK: Line names

/** Each line's name along it (see map/lib/labels.ts), placed for the drawing
 *  shown, from its own zoom. Turned to run along the line, back by the
 *  map's rotation, and never upside down. */
let shownNames = new Map()

/** Whole numbers in Google's encoded polyline format, each the change from
 *  the one before. */
function decodeIntegers(text) {
  const values = []
  let value = 0, i = 0

  while (i < text.length) {
    let result = 0, shift = 0, byte

    do {
      byte = text.charCodeAt(i++) - 63
      result |= (byte & 0x1f) << shift
      shift += 5
    } while (byte >= 0x20)

    value += result & 1 ? ~(result >> 1) : result >> 1
    values.push(value)
  }

  return values
}

/** Each step's names, [text, colour, lon, lat, angle, side], decoded when
 *  first shown: the side is how many pitches below its middle, looking
 *  along it, its line is drawn (lines side by side). */
const stepNames = new Map()

function namesOf(index) {
  if (!stepNames.has(index)) {
    stepNames.set(index, (transit.names[index]?.labels ?? []).flatMap(([name, points, angles, sides]) => {
      const [text, colour] = transit.labelNames[name]
      const turns = decodeIntegers(angles), halves = sides ? decodeIntegers(sides) : []

      return decodePairs(points, 1e5).map(([lat, lon], i) => [text, colour, lon, lat, turns[i], (halves[i] ?? 0) / 2])
    }))
  }

  return stepNames.get(index)
}

function showNames(z) {
  const wanted = new Map()
  const { center, span } = map.region
  const rotation = Math.round(map.rotation)
  const linePitch = pitchAt(shown.level)

  // The names for the zoom: the last step starting at or before it, to the
  // nearest whole zoom, if any
  for (const [text, colour, lon, lat, angle, side] of namesOf(transit.names.findLastIndex((s) => s.zoom <= z + 0.5))) {
    if (Math.abs(lat - center.latitude) > span.latitudeDelta * 0.75 || Math.abs(lon - center.longitude) > span.longitudeDelta * 0.75) continue

    // Turned to read left to right, and moved onto its line
    let turn = angle - rotation, below = side * linePitch

    while (turn > 90) { turn -= 180; below = -below }
    while (turn <= -90) { turn += 180; below = -below }

    const key = `${text}|${lon}|${lat}|${turn}|${below.toFixed(1)}`

    wanted.set(key, shownNames.get(key) ?? new mapkit.Annotation(new mapkit.Coordinate(lat, lon), () => {
      const anchor = document.createElement('div')

      anchor.style.cssText = 'position:relative;width:0;height:0'

      const label = document.createElement('div')

      label.className = 'line-name'
      label.textContent = text
      label.style.cssText = `position:absolute;left:0;top:0;color:#${colour};font-size:${transit.labelPoints ?? 11}px;transform:translate(-50%,-50%) rotate(${turn}deg) translateY(${below}px)`
      anchor.append(label)

      return anchor
    }, { enabled: false }))
  }

  map.removeAnnotations([...shownNames].filter(([key]) => !wanted.has(key)).map(([, a]) => a))
  map.addAnnotations([...wanted].filter(([key]) => !shownNames.has(key)).map(([, a]) => a))
  shownNames = wanted
}

// MARK: Updating

function update(moving) {
  const z = zoom()
  const lines = showLines(z, moving)

  if (!moving) { showNames(z); showStations(z) }

  // For debugging: the zoom, what's drawn and how much is on the map
  status.textContent = `Zoom ${z.toFixed(1)} · drawn for ${shown.level} · ${lines} lines · ${shownNames.size} names · ${shownAnnotations.size} stations`
}

// Follow the zoom while the map moves, not just when it stops
let moving = false
const follow = () => { update(true); if (moving) requestAnimationFrame(follow) }

map.addEventListener('region-change-start', () => { if (!moving) { moving = true; requestAnimationFrame(follow) } })
map.addEventListener('region-change-end', () => { moving = false; update(false) })

// Start on ?lat=…&lon=…&z=… if given (and turned to ?rot=… degrees), to
// compare drawings at one place, or else the whole network
if (params.has('lat') && params.has('lon') && params.has('z')) {
  const width = map.element.clientWidth || 1, height = map.element.clientHeight || 1
  const degreesPerPoint = (metresPerPoint(Number(params.get('z'))) / 40_075_016.686) * 360

  map.region = new mapkit.CoordinateRegion(new mapkit.Coordinate(Number(params.get('lat')), Number(params.get('lon'))),
    new mapkit.CoordinateSpan(degreesPerPoint * height * Math.cos((Number(params.get('lat')) * Math.PI) / 180), degreesPerPoint * width))
}

if (params.has('rot')) map.rotation = Number(params.get('rot'))

if (!params.has('lat')) {
  const lats = stations.map((s) => s.coordinate.latitude), lons = stations.map((s) => s.coordinate.longitude)

  map.region = new mapkit.BoundingRegion(Math.max(...lats), Math.max(...lons), Math.min(...lats), Math.min(...lons)).toCoordinateRegion()
}

update(false)
