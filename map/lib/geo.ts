// Geometry shared by the build steps.

import type { LatLon } from './osm.ts'

/** Metres between two points, near enough over short distances. */
export function metres(a: LatLon, b: LatLon): number {
  const rad = Math.PI / 180
  const x = (b[1] - a[1]) * rad * Math.cos(((a[0] + b[0]) / 2) * rad)
  const y = (b[0] - a[0]) * rad

  return Math.hypot(x, y) * 6_371_000
}

/** Douglas–Peucker on flat points: which to keep, the ones straying
 *  furthest, and both ends. */
export function kept(p: [number, number][], tolerance: number): Uint8Array {
  const keep = new Uint8Array(p.length)

  keep[0] = keep[p.length - 1] = 1

  const stack: [number, number][] = [[0, p.length - 1]]

  while (stack.length) {
    const [s, e] = stack.pop()!
    const [ax, ay] = p[s], [bx, by] = p[e]
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy
    let worst = -1, index = -1

    for (let i = s + 1; i < e; i++) {
      const t = len2 ? Math.max(0, Math.min(1, ((p[i][0] - ax) * dx + (p[i][1] - ay) * dy) / len2)) : 0
      const d = Math.hypot(p[i][0] - (ax + t * dx), p[i][1] - (ay + t * dy))

      if (d > worst) { worst = d; index = i }
    }

    if (worst > tolerance) { keep[index] = 1; stack.push([s, index], [index, e]) }
  }

  return keep
}

/** Douglas–Peucker on latitudes and longitudes, the tolerance in metres. */
export function simplifyLatLon(path: LatLon[], tolerance: number): LatLon[] {
  if (path.length <= 2) return path

  const [lat0, lon0] = path[0]
  const kx = 111_320 * Math.cos((lat0 * Math.PI) / 180), ky = 110_540
  const keep = kept(path.map(([lat, lon]) => [(lon - lon0) * kx, (lat - lat0) * ky]), tolerance)

  return path.filter((_, i) => keep[i])
}

/** Whole numbers in Google's encoded polyline format, each as the change
 *  from the one before. */
export function encodeIntegers(values: Iterable<number>): string {
  let out = '', last = 0

  for (const value of values) {
    const delta = Math.round(value) - last

    last = Math.round(value)

    let v = delta < 0 ? ~(delta << 1) : delta << 1

    while (v >= 0x20) { out += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5 }

    out += String.fromCharCode(v + 63)
  }

  return out
}

/** Google's encoded polyline format, 5 decimal places. */
export function encode(path: Iterable<LatLon>): string {
  let out = '', lastLat = 0, lastLon = 0

  const put = (value: number) => {
    let v = value < 0 ? ~(value << 1) : value << 1

    while (v >= 0x20) { out += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5 }

    out += String.fromCharCode(v + 63)
  }

  for (const [lat, lon] of path) {
    const la = Math.round(lat * 1e5), lo = Math.round(lon * 1e5)

    put(la - lastLat); put(lo - lastLon)
    lastLat = la; lastLon = lo
  }

  return out
}

/** Web Mercator: metres east and north from longitude and latitude, and back. */
const R = 6_378_137

export const mercX = (lon: number) => (lon * Math.PI * R) / 180
export const mercY = (lat: number) => R * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))

export const fromMercator = (x: number, y: number): [number, number] =>
  [(x / R) * (180 / Math.PI), (Math.atan(Math.exp(y / R)) * 360) / Math.PI - 90]

/** Web Mercator metres per screen point at zoom 0. */
export const METRES_AT_ZOOM_0 = 156_543.034
