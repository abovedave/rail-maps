// Station dots for render.ts: each station
// as a dot on each line calling there, and each line's colour on dark maps.

import { mercX, mercY } from './geo.ts'
import { type EdgeFeature, type Graph, type StationKeys, edgesByNode, isEdge, isNode, stationKey } from './graph.ts'
import { LINES } from '../lines.ts'

/** Each line's colour on dark maps, by its colour, where it has one. */
export function darkColours() {
  return Object.fromEntries(Object.values(LINES).filter((s) => s.dark).map((s) => [s.colour.toLowerCase(), s.dark!.toLowerCase()]))
}

/** Each station's dots, one on each line calling there, for apps to draw
 *  across the lines in screen points: [name, lon, lat, angle, colour, …].
 *  The angle is the corridor's direction at the station, in degrees
 *  clockwise from east on a north-up map, and the colours run from its
 *  right to its left, LOOM's order, so the first colour's line is drawn
 *  furthest right looking along it. Lines are pitchPoints apart (centre to
 *  centre), centred on the station. */
export function stationDots(graph: Graph, keys: StationKeys) {
  return grouped(stopDots(graph, keys))
}

/** A station's dots: [name, lon, lat, angle, colour, …]. */
export type Dots = [name: string, lon: number, lat: number, angle: number, ...colours: string[]]

/** Stops of a station further apart than this, in metres, are drawn apart
 *  however many lines they share (a safety net: they shouldn't be). */
const STATION_SPREAD = 1000

/** Stops grouped into stations: each OSM stop is its own station in the
 *  graph (see linegraph.ts), so of a station's stops (stationGroups.ts),
 *  only those showing a line no other does are kept, the one with the most
 *  lines first. Where a station's lines share platforms that's one set of
 *  dots; where they're apart (Whitechapel), each line's are on it. */
function grouped(stops: { station: string; dots: Dots }[]) {
  const kept: { station: string; dots: Dots }[] = []
  for (const stop of [...stops].sort((a, b) => b.dots.length - a.dots.length)) {
    const [, lon, lat, , ...colours] = stop.dots
    const covered = kept.some(({ station, dots: [, kLon, kLat, , ...kColours] }) => station === stop.station
      && Math.hypot((kLon - lon) * 69_400, (kLat - lat) * 111_320) < STATION_SPREAD
      && colours.every((c) => kColours.includes(c)))
    if (!covered) kept.push(stop)
  }
  return kept.map((k) => k.dots)
}

/** Each stop's dots. */
function stopDots(graph: Graph, keys: StationKeys): { station: string; dots: Dots }[] {
  const edgesAt = edgesByNode(graph.features.filter(isEdge))
  return graph.features.filter(isNode).filter((f) => f.properties.station_label).flatMap((f) => {
    const p = f.properties
    // The corridor with the most lines calling at the station (others may
    // pass through without calling: the Elizabeth line at Moorgate)
    const notServing = new Set(p.not_serving ?? [])
    const calling = (e: EdgeFeature) => e.properties.lines.filter((l: any) => !notServing.has(l.id)).length
    const edge = (edgesAt.get(p.id) ?? []).sort((a, b) => calling(b) - calling(a) || b.properties.lines.length - a.properties.lines.length)[0]
    if (!edge) return []
    // A dot on each line
    const colours = edge.properties.lines.filter((l) => !notServing.has(l.id)).map((l) => l.color.toLowerCase())
    if (!colours.length) return []
    // Its direction (from → to) over the first or last 30 m at the station
    const c = edge.geometry.coordinates.map(([lon, lat]) => [mercX(lon), mercY(lat)] as [number, number])
    const atStart = edge.properties.from === p.id
    const path = atStart ? c : [...c].reverse()
    let i = 1
    while (i < path.length - 1 && Math.hypot(path[i][0] - path[0][0], path[i][1] - path[0][1]) < 30) i++
    let [dx, dy] = [path[i][0] - path[0][0], path[i][1] - path[0][1]]
    if (!atStart) [dx, dy] = [-dx, -dy]
    const angle = Math.round((-Math.atan2(dy, dx) * 180) / Math.PI * 10) / 10
    const [lon, lat] = f.geometry.coordinates
    const dots: Dots = [p.station_label!, Math.round(lon * 1e6) / 1e6, Math.round(lat * 1e6) / 1e6, angle, ...colours]
    return [{ station: stationKey(keys, f), dots }]
  })
}
