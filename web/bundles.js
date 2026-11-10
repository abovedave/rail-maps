// Draws lines sharing track side by side, from the ordered line graph in
// gb.transit.json (`graph`, see map/render.ts), at any scale: the map does
// what LOOM's transitmap did ahead of time.
//
// Each edge's lines are offset from its centreline, a pitch apart, the
// first furthest right looking along the edge (loom's order). Lines going
// on through a node are cut back from it to leave room, and joined from one
// edge to the next by a curve; lines ending there run up to it. Each line's
// pieces are then chained into as few polylines as they'll go, and lines of
// one colour joined where their ends meet.
//
// Geometry is in Web Mercator metres; `draw` returns lines as [lat, lon].

const R = 6_378_137
const toMercator = ([lon, lat]) => [(lon * Math.PI * R) / 180, R * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))]
const toLatLon = ([x, y]) => [(Math.atan(Math.exp(y / R)) * 360) / Math.PI - 90, (x / R) * (180 / Math.PI)]

/** Google's encoded polyline format: [lat, lon] pairs, 5 decimal places. */
function decode(line) {
  const pairs = []
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
    pairs.push([lat / 1e5, lon / 1e5])
  }
  return pairs
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1]]
const add = (a, b) => [a[0] + b[0], a[1] + b[1]]
const scale = (a, k) => [a[0] * k, a[1] * k]
const norm = (a) => Math.hypot(a[0], a[1])
const unit = (a) => { const n = norm(a) || 1; return [a[0] / n, a[1] / n] }
/** To the right of a direction, on a north-up map (y north). */
const right = ([x, y]) => [y, -x]

/** The graph in Web Mercator, with each node's edges. */
export function prepare(graph) {
  const nodes = graph.nodes.map(toMercator)
  const edges = graph.edges.map(([from, to, line, lines]) => {
    const points = decode(line).map(([lat, lon]) => toMercator([lon, lat]))
    // Ends exactly on their nodes, so lines meet there
    points[0] = nodes[from]
    points[points.length - 1] = nodes[to]
    return { from, to, points, lines, length: pathLength(points) }
  })
  const edgesAt = nodes.map(() => [])
  edges.forEach((e, i) => { edgesAt[e.from].push(i); if (e.to !== e.from) edgesAt[e.to].push(i) })
  const bans = new Set(graph.bans.map(([node, line, a, b]) => banKey(node, line, a, b)))
  return { lines: graph.lines, nodes, edges, edgesAt, bans }
}
const banKey = (node, line, a, b) => `${node}|${line}|${Math.min(a, b)}|${Math.max(a, b)}`

function pathLength(points) {
  let total = 0
  for (let i = 1; i < points.length; i++) total += norm(sub(points[i], points[i - 1]))
  return total
}

/** A line cut back by `start` metres from its first point and `end` from
 *  its last. */
function cut(points, start, end) {
  const out = []
  const total = pathLength(points)
  const [from, to] = [start, total - end]
  let along = 0
  for (let i = 1; i < points.length; i++) {
    const [a, b] = [points[i - 1], points[i]]
    const length = norm(sub(b, a))
    const [s, e] = [along, along + length]
    if (e >= from && s <= to && length > 0) {
      if (!out.length) out.push(add(a, scale(sub(b, a), Math.max(0, (from - s) / length))))
      out.push(e <= to ? b : add(a, scale(sub(b, a), (to - s) / length)))
    }
    along = e
    if (along > to) break
  }
  return out.length > 1 ? out : [points[0], points[points.length - 1]]
}

/** A line moved `distance` metres to its right, its corners mitred. */
function offset(points, distance) {
  if (!distance) return points
  const normals = []
  for (let i = 1; i < points.length; i++) normals.push(right(unit(sub(points[i], points[i - 1]))))
  return points.map((p, i) => {
    const before = normals[Math.max(0, i - 1)], after = normals[Math.min(normals.length - 1, i)]
    const mid = unit(add(before, after))
    // Longer at a corner, to keep the distance from both sides, within reason
    const k = Math.min(2, 1 / Math.max(0.5, mid[0] * after[0] + mid[1] * after[1]))
    return add(p, scale(mid, distance * k))
  })
}

/** A quadratic curve from p, heading along `dp`, to q, arriving along `dq`. */
function curve(p, dp, q, dq) {
  // Control point where the two headings meet, if they do ahead of both
  const denom = dp[0] * dq[1] - dp[1] * dq[0]
  let control = scale(add(p, q), 0.5)
  if (Math.abs(denom) > 1e-6) {
    const w = sub(q, p)
    const t = (w[0] * dq[1] - w[1] * dq[0]) / denom
    const c = add(p, scale(dp, t))
    if (t > 0 && norm(sub(c, q)) > 0 && (q[0] - c[0]) * dq[0] + (q[1] - c[1]) * dq[1] > 0) control = c
  }
  const out = []
  for (let k = 0; k <= 8; k++) {
    const t = k / 8, u = 1 - t
    out.push([u * u * p[0] + 2 * u * t * control[0] + t * t * q[0], u * u * p[1] + 2 * u * t * control[1] + t * t * q[1]])
  }
  return out
}

/** Douglas–Peucker, keeping both ends. */
function simplify(points, tolerance) {
  if (points.length <= 2) return points
  const keep = new Uint8Array(points.length)
  keep[0] = keep[points.length - 1] = 1
  const stack = [[0, points.length - 1]]
  while (stack.length) {
    const [s, e] = stack.pop()
    const [a, b] = [points[s], points[e]], d = sub(b, a), length2 = d[0] * d[0] + d[1] * d[1]
    let worst = -1, index = -1
    for (let i = s + 1; i < e; i++) {
      const p = points[i]
      const t = length2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * d[0] + (p[1] - a[1]) * d[1]) / length2)) : 0
      const distance = Math.hypot(p[0] - a[0] - t * d[0], p[1] - a[1] - t * d[1])
      if (distance > worst) [worst, index] = [distance, i]
    }
    if (worst > tolerance) { keep[index] = 1; stack.push([s, index], [index, e]) }
  }
  return points.filter((_, i) => keep[i])
}

/** Every line drawn side by side at a scale (Web Mercator metres per screen
 *  point), lines `pitch` points apart, centre to centre: [{ colour, points:
 *  [[lat, lon]] }]. */
export function draw({ lines, nodes, edges, edgesAt, bans }, metresPerPoint, pitch) {
  const spacing = pitch * metresPerPoint
  // How far edges are cut back from each node: room for the widest bundle
  // there to turn, none at the end of a line
  const room = nodes.map((_, n) => {
    if (edgesAt[n].length < 2) return 0
    return Math.max(...edgesAt[n].map((i) => edges[i].lines.length)) * spacing * 0.75
  })

  /** Whether a line goes on from an edge through a node, on another edge. */
  const goesOn = (n, i, line) => edgesAt[n].some((j) => j !== i && edges[j].lines.includes(line))

  // Each edge's lines, offset: pieces[e][slot] runs from → to
  const pieces = edges.map((e, i) => {
    const fit = Math.min(1, (e.length * 0.45) / Math.max(room[e.from], room[e.to], 1e-9))
    return e.lines.map((line, slot) => {
      const start = goesOn(e.from, i, line) ? room[e.from] * fit : 0
      const end = goesOn(e.to, i, line) ? room[e.to] * fit : 0
      return offset(cut(e.points, start, end), ((e.lines.length - 1) / 2 - slot) * spacing)
    })
  })

  /** A piece's end at a node: its point there, and its heading away from the
   *  node into the edge. */
  const endAt = (i, slot, atTo) => {
    const p = pieces[i][slot]
    return atTo
      ? { point: p[p.length - 1], away: unit(sub(p[p.length - 2], p[p.length - 1])) }
      : { point: p[0], away: unit(sub(p[1], p[0])) }
  }

  // Curves joining a line from one edge to the next through each node, by
  // `line|edge|end`
  const joins = new Map()
  const joinKey = (line, i, atTo) => `${line}|${i}|${atTo ? 1 : 0}`
  const curves = []
  nodes.forEach((_, n) => {
    const at = edgesAt[n]
    for (let x = 0; x < at.length; x++) for (let y = x + 1; y < at.length; y++) {
      const [a, b] = [edges[at[x]], edges[at[y]]]
      const [aAtTo, bAtTo] = [a.to === n, b.to === n]
      const [aNext, bNext] = [aAtTo ? a.from : a.to, bAtTo ? b.from : b.to]
      for (const [aSlot, line] of a.lines.entries()) {
        const bSlot = b.lines.indexOf(line)
        if (bSlot < 0 || bans.has(banKey(n, line, aNext, bNext))) continue
        const p = endAt(at[x], aSlot, aAtTo), q = endAt(at[y], bSlot, bAtTo)
        // Not back the way it came (loom's turn bans rule out the rest)
        if (aNext === bNext || p.away[0] * q.away[0] + p.away[1] * q.away[1] > 0.95) continue
        const points = curve(p.point, scale(p.away, -1), q.point, q.away)
        const join = { line, points, a: [at[x], aSlot, aAtTo], b: [at[y], bSlot, bAtTo] }
        curves.push(join)
        for (const [i, slot, atTo] of [join.a, join.b]) {
          const key = joinKey(line, i, atTo)
          joins.set(key, [...(joins.get(key) ?? []), join])
        }
      }
    }
  })

  // Chain each line's pieces through nodes it goes straight on through
  const chained = new Set()
  const used = new Set()
  const out = []
  const only = (line, i, atTo) => {
    const list = joins.get(joinKey(line, i, atTo)) ?? []
    if (list.length !== 1) return
    const join = list[0]
    const [j, slot, jAtTo] = join.a[0] === i && join.a[2] === atTo ? join.b : join.a
    if ((joins.get(joinKey(line, j, jAtTo)) ?? []).length !== 1) return
    return { join, next: [j, slot, jAtTo] }
  }
  edges.forEach((e, i) => e.lines.forEach((line, slot) => {
    const key = `${i}|${slot}`
    if (chained.has(key)) return
    chained.add(key)
    let points = [...pieces[i][slot]]
    // On from its `to` end, then back from its `from` end
    for (const [atTo, append] of [[true, true], [false, false]]) {
      let at = [i, atTo]
      for (let step; (step = only(line, at[0], at[1]));) {
        const [j, jSlot, jAtTo] = step.next
        if (chained.has(`${j}|${jSlot}`)) break
        chained.add(`${j}|${jSlot}`)
        used.add(step.join)
        const fromA = step.join.a[0] === at[0] && step.join.a[2] === at[1]
        const bend = fromA ? step.join.points : [...step.join.points].reverse()
        // The next piece, leaving the node
        const piece = jAtTo ? [...pieces[j][jSlot]].reverse() : pieces[j][jSlot]
        if (append) points.push(...bend.slice(1), ...piece.slice(1))
        else points = [...[...piece].reverse().slice(0, -1), ...[...bend].reverse().slice(0, -1), ...points]
        at = [j, !jAtTo]
      }
    }
    out.push({ colour: lines[line][1], points })
  }))
  for (const join of curves) if (!used.has(join)) out.push({ colour: lines[join.line][1], points: join.points })

  return joinEnds(out).map(({ colour, points }) => ({ colour, points: simplify(points, metresPerPoint / 4).map(toLatLon) }))
}

/** Lines of one colour joined where their ends meet, so maps have about a
 *  quarter as many to draw: chains stop where lines branch, and the curves
 *  into each branch are their own. Each line goes on into the first it
 *  meets, at its last end, then its first. */
function joinEnds(lines) {
  const key = (colour, [x, y]) => `${colour}|${x},${y}`
  /** Each end, by colour and point: line index × 2, + 1 for its last. */
  const ends = new Map()
  lines.forEach(({ colour, points }, i) => {
    for (const [end, point] of [[0, points[0]], [1, points[points.length - 1]]]) {
      const k = key(colour, point)
      ends.set(k, [...(ends.get(k) ?? []), i * 2 + end])
    }
  })
  const used = new Uint8Array(lines.length)
  /** The first line not yet used with an end at a point, and which end. */
  const meeting = (colour, point) => {
    const end = (ends.get(key(colour, point)) ?? []).find((e) => !used[e >> 1])
    if (end !== undefined) used[end >> 1] = 1
    return end
  }
  const out = []
  lines.forEach(({ colour, points: first }, i) => {
    if (used[i]) return
    used[i] = 1
    let points = [...first]
    for (let end; (end = meeting(colour, points[points.length - 1])) !== undefined;) {
      const next = lines[end >> 1].points
      points.push(...(end & 1 ? [...next].reverse() : next).slice(1))
    }
    for (let end; (end = meeting(colour, points[0])) !== undefined;) {
      const before = lines[end >> 1].points
      points = [...(end & 1 ? before : [...before].reverse()).slice(0, -1), ...points]
    }
    out.push({ colour, points })
  })
  return out
}
