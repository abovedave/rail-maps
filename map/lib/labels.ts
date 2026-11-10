// Places line names along lines, for maps to show as text on the line,
// turned to run along it (as Apple Maps names its transit lines).
//
// Lines sharing track are placed along it, each with its side of the track
// (how many pitches to the right of the way it runs), for maps to move the
// name onto the line as they draw it (web/bundles.js).
//
// For each zoom step (render.ts), each line gets its name where it runs about
// straight for at least the name's length, clear of stations and of other
// names, repeated every REPEAT points along it. Names come from names.json
// (linegraph.ts): National Rail by its track's name, the Overground by each
// of its lines', others by their own. Lines are named in LINES' order, so the
// named networks get room before National Rail.
//
// Sizes are screen points at the zoom a drawing is drawn for, measured half
// a zoom further out, where it's first shown and things are closest.

import { segmentDistance } from './graph.ts'
import { LINES } from '../lines.ts'

/** Text size, and roughly how wide a character is, in points. */
export const LABEL_POINTS = 11

const CHARACTER = 6.2

/** Space around a name: from the next name, and from a station dot. */
const CLEAR = 6
const STATION_CLEAR = 14

/** How far a line can bow from straight under its name, in points. */
const BOW = 2.5

/** Tried every this many points along each line, and the same name not
 *  again within REPEAT. */
const STEP = 30
const REPEAT = 300

/** How far a line's drawing can be from the track its name is from, in Web
 *  Mercator metres (lines are drawn beside each other, up to a few hundred
 *  metres off their track zoomed out). */
const NAME_REACH = 600

type Vec = [number, number]

/** A placed name: text, colour, its middle and direction (Web Mercator
 *  metres), and half its length. */
type Label = { text: string; colour: string; at: Vec; along: Vec; half: number; side: number }

/** What lines are called near where they run: segments by line, in a grid. */
export function nameIndex(names: [string, string, Vec[]][], toMercator: (p: Vec) => Vec) {
  const CELL = 1000
  const cells = new Map<string, { line: string; name: string; a: Vec; b: Vec }[]>()

  for (const [line, name, path] of names) {
    const points = path.map(toMercator)

    for (let i = 1; i < points.length; i++) {
      const [a, b] = [points[i - 1], points[i]]
      const keys = new Set<string>()

      for (const [x, y] of [a, b, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]]) keys.add(`${Math.floor(x / CELL)},${Math.floor(y / CELL)}`)
      for (const key of keys) (cells.get(key) ?? cells.set(key, []).get(key)!).push({ line, name, a, b })
    }
  }

  /** The name of a line's track nearest a point, within NAME_REACH. */
  return (line: string, [x, y]: Vec): string | undefined => {
    let best: string | undefined, bestDistance = NAME_REACH
    const reach = Math.ceil(NAME_REACH / CELL)

    for (let dx = -reach; dx <= reach; dx++) for (let dy = -reach; dy <= reach; dy++) {
      for (const s of cells.get(`${Math.floor(x / CELL) + dx},${Math.floor(y / CELL) + dy}`) ?? []) {
        if (s.line !== line) continue

        const d = segmentDistance([x, y], s.a, s.b)

        if (d < bestDistance) [best, bestDistance] = [s.name, d]
      }
    }

    return best
  }
}

/** Names for one step's lines (Web Mercator metres), as [text, colour,
 *  lon, lat, angle, side]: the angle in degrees clockwise from east on a
 *  north-up map, between -90 and 90 so it reads left to right, and the side
 *  how many pitches below the text's middle (looking along it) its line is. */
export function placeLabels(
  lines: { colour: string; points: Vec[]; side?: number }[],
  drawnMetresPerPoint: number,
  stations: Vec[],
  nameAt: (line: string, at: Vec) => string | undefined,
  fromMercator: (x: number, y: number) => Vec,
): (string | number)[][] {
  // Measured half a zoom out, where the drawing is first shown
  const point = drawnMetresPerPoint * Math.SQRT2
  const lineOf = new Map(Object.entries(LINES).map(([line, { colour }]) => [colour.toLowerCase(), line]))
  const order = Object.keys(LINES)
  const placed: Label[] = []

  /** Things near a point, in a grid of cells this many metres across. */
  const grid = <T>(cell: number) => {
    const cells = new Map<string, T[]>()
    const key = (x: number, y: number) => `${Math.floor(x / cell)},${Math.floor(y / cell)}`

    return {
      add: ([x, y]: Vec, item: T) => { const k = key(x, y); (cells.get(k) ?? cells.set(k, []).get(k)!).push(item) },
      near: ([x, y]: Vec, reach: number) => {
        const out: T[] = [], r = Math.ceil(reach / cell)

        for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) out.push(...(cells.get(key(x + dx * cell, y + dy * cell)) ?? []))

        return out
      },
    }
  }

  const stationGrid = grid<Vec>(100 * point)

  for (const s of stations) stationGrid.add(s, s)

  const labelGrid = grid<Label>(100 * point)

  const stationClear = (at: Vec, half: number) =>
    stationGrid.near(at, half + STATION_CLEAR * point).every((s) => Math.hypot(s[0] - at[0], s[1] - at[1]) > half + STATION_CLEAR * point)

  /** Points along a label, for spacing them. */
  const along = (l: Label) => [-1, -0.5, 0, 0.5, 1].map((t): Vec => [l.at[0] + l.along[0] * l.half * t, l.at[1] + l.along[1] * l.half * t])

  const clear = (l: Label) => labelGrid.near(l.at, REPEAT * point).every((o) => {
    if (o.text === l.text && Math.hypot(o.at[0] - l.at[0], o.at[1] - l.at[1]) < REPEAT * point) return false
    if (Math.hypot(o.at[0] - l.at[0], o.at[1] - l.at[1]) > o.half + l.half + (LABEL_POINTS + CLEAR) * point) return true

    const ours = along(l), theirs = along(o)

    return ours.every((p) => theirs.every((q) => Math.hypot(p[0] - q[0], p[1] - q[1]) > (LABEL_POINTS + CLEAR) * point))
  })

  const ordered = lines
    .filter((l) => lineOf.has(l.colour))
    .map((l) => ({ ...l, line: lineOf.get(l.colour)!, length: l.points.reduce((sum, p, i) => sum + (i ? Math.hypot(p[0] - l.points[i - 1][0], p[1] - l.points[i - 1][1]) : 0), 0) }))
    .sort((a, b) => order.indexOf(a.line) === order.indexOf(b.line) ? b.length - a.length : (a.line === 'National Rail' ? 1 : 0) - (b.line === 'National Rail' ? 1 : 0) || order.indexOf(a.line) - order.indexOf(b.line))

  for (const { colour, points, line, length, side = 0 } of ordered) {
    const distance = [0]

    for (let i = 1; i < points.length; i++) distance.push(distance[i - 1] + Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]))

    /** The point a distance along the line. */
    const at = (d: number): Vec => {
      let i = 1

      while (i < points.length - 1 && distance[i] < d) i++
      const t = (d - distance[i - 1]) / (distance[i] - distance[i - 1] || 1)

      return [points[i - 1][0] + (points[i][0] - points[i - 1][0]) * t, points[i - 1][1] + (points[i][1] - points[i - 1][1]) * t]
    }

    for (let d = STEP * point; d < length; d += STEP * point) {
      const middle = at(d)
      const text = nameAt(line, middle)
      if (!text) continue

      const half = ((text.length * CHARACTER) / 2 + CLEAR) * point
      if (d - half < 0 || d + half > length) continue

      // About straight under it
      const [start, end] = [at(d - half), at(d + half)]
      const chord = Math.hypot(end[0] - start[0], end[1] - start[1])
      if (chord < half * 1.9) continue

      let bow = 0

      for (let i = 0; i < points.length; i++) if (distance[i] > d - half && distance[i] < d + half) bow = Math.max(bow, segmentDistance(points[i], start, end))

      if (bow > BOW * point) continue

      const label: Label = { text, colour, at: [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2], along: [(end[0] - start[0]) / chord, (end[1] - start[1]) / chord], half, side }
      if (!stationClear(label.at, half) || !clear(label)) continue

      placed.push(label)
      labelGrid.add(label.at, label)
      d += REPEAT * point / 2
    }
  }

  const round = (v: number) => Math.round(v * 1e5) / 1e5

  return placed.map(({ text, colour, at, along, side }) => {
    let angle = (-Math.atan2(along[1], along[0]) * 180) / Math.PI

    // Turned round to read left to right, its line's on its other side
    const turned = angle > 90 || angle <= -90

    if (angle > 90) angle -= 180
    if (angle <= -90) angle += 180

    const [lon, lat] = fromMercator(at[0], at[1])

    return [text, colour, round(lon), round(lat), Math.round(angle * 10) / 10, turned ? -side : side]
  })
}
