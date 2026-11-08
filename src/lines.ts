// How services are grouped into lines, and how lines are drawn.

/** The lines, each drawn in its colour (hex), width (points) and from a
 *  zoom level, so zoomed out shows the main network and not every line.
 *  National Rail is one line, with Intercity services as their
 *  own. A few services that people know by their own name have their own
 *  line. `dark` is a colour for dark maps, where `colour` is too dark to see. */
export const LINES: Record<string, { colour: string; dark?: string; width: number; minZoom: number }> = {
  'Intercity': { colour: 'D7263D', width: 1, minZoom: 0 },
  'National Rail': { colour: '1D2D5C', dark: 'B9C6E4', width: 1, minZoom: 7 },
  'Elizabeth line': { colour: '9364CC', width: 1, minZoom: 7 },
  'London Overground': { colour: 'EE7623', width: 1, minZoom: 7 },
  'Heathrow Express': { colour: '5B2C6F', width: 1, minZoom: 7 },
  'Merseyrail': { colour: 'E6B800', width: 1, minZoom: 7 },
  'Tyne and Wear Metro': { colour: 'F59B00', width: 1, minZoom: 7 },
}
export const lineStyle = (line: string): (typeof LINES)[string] => LINES[line] ?? { colour: '808080', width: 1, minZoom: 8 }
export const lineColour = (line: string) => lineStyle(line).colour

/** London's lines, by the `ref` of their `route=train` relations: the
 *  Overground's six (drawn as one) and the Elizabeth line. */
const LONDON_REFS: Record<string, string> = {
  Elizabeth: 'Elizabeth line',
  Liberty: 'London Overground',
  Lioness: 'London Overground',
  Mildmay: 'London Overground',
  Suffragette: 'London Overground',
  Weaver: 'London Overground',
  Windrush: 'London Overground',
}

/** Companies drawn as their own line. */
const OWN_LINES = new Set(['Heathrow Express', 'Merseyrail', 'Tyne and Wear Metro'])

/** Britain's train companies, each with the other names OpenStreetMap uses
 *  for it (old names, owners, misspellings). */
export const TRAIN_COMPANIES: Record<string, string[]> = {
  'Avanti West Coast': [],
  'c2c': [],
  'Caledonian Sleeper': [],
  'Chiltern Railways': [],
  'CrossCountry': ['Cross Country', 'Arriva CrossCountry'],
  'East Midlands Railway': ['East Midlands'],
  'Eurostar': ['Eurostar International Ltd'],
  'Gatwick Express': [],
  'Grand Central': [],
  'Great Northern': [],
  'Great Western Railway': ['First Great Western', 'Great Western Railways', 'GWR'],
  'Greater Anglia': ['Abellio Greater Anglia'],
  'Heathrow Express': [],
  'Hull Trains': [],
  'Island Line': ['Island Line Trains'],
  'LNER': ['London North Eastern Railway', 'Virgin Trains East Coast'],
  'London Northwestern Railway': ['LNWR', 'London Midland'],
  'Lumo': [],
  'Merseyrail': [],
  'Northern': ['Northern Trains', 'Northern Rail', 'Arriva Rail North', 'Arriva Trains North'],
  'ScotRail': [],
  'South Western Railway': [],
  'Southeastern': ['South Eastern', 'Southeastern Railway', 'Southeastern Railways'],
  'Southern': ['Southern Railway'],
  'Stansted Express': [],
  'Thameslink': ['Thameslink Railway', 'Greater Thameslink Railway', 'Govia Thameslink Railway'],
  'TransPennine Express': ['Transpennine Express', 'North TransPennine'],
  'Transport for Wales': ['Trafnidiaeth Cymru', 'TfW Rail'],
  'West Midlands Railway': ['West Midlands Trains', 'Transport for West Midlands'],
  'Tyne and Wear Metro': ['Nexus'],
}

const companies = new Map<string, string>()
for (const [name, aliases] of Object.entries(TRAIN_COMPANIES)) {
  for (const alias of [name, ...aliases]) companies.set(alias.toLowerCase(), name)
}

/** The train company running a route, matched from its brand, the start
 *  of its name ("Southern: London Victoria → Littlehampton"), operator or
 *  network, in that order, as a brand is more specific than an operator
 *  (Govia Thameslink Railway runs Southern, Thameslink and others). */
export function trainCompany(tags: Record<string, string>): string | undefined {
  for (const name of [tags.brand, tags.name?.split(':')[0], tags.operator, tags.network]) {
    const company = name && companies.get(name.trim().toLowerCase())
    if (company) return company
  }
}

/** A route, for picking its line. */
export type Route = { company: string; name: string; service: string }

const named = (pattern: RegExp) => (r: Route) => pattern.test(r.name)
const between = (a: string, b: string) => named(new RegExp(`${a}.*${b}|${b}.*${a}`))

/** Intercity services: [company, which of its routes
 *  (all if left out)]. Companies running both long-distance and local
 *  trains are split by route name or service type. */
const INTERCITY: [string, ((r: Route) => boolean)?][] = [
  ['Avanti West Coast'],
  ['LNER'],
  ['Lumo'],
  ['Grand Central'],
  ['Hull Trains'],
  ['Caledonian Sleeper'],
  ['TransPennine Express'],
  ['Eurostar'],
  // All but its local routes around Birmingham
  ['CrossCountry', (r) => !/Stansted/.test(r.name) && !between('Birmingham', 'Nottingham')(r) && !between('Cardiff', 'Nottingham')(r)],
  // Paddington's long-distance trains, not the Thames Valley's
  ['Great Western Railway', (r) => /London Paddington/.test(r.name) && !/Didcot|Oxford|Reading|Newbury|Bedwyn/.test(r.name)],
  ['East Midlands Railway', (r) => /London|St Pancras/.test(r.name) || between('Norwich', 'Liverpool')(r)],
  ['Greater Anglia', between('London', 'Norwich')],
  ['Southeastern', (r) => r.service === 'high_speed' || /High Speed|St Pancras/.test(r.name)],
]

/** The line a route is drawn as: London's lines by their `ref`, companies
 *  with their own line, Intercity services, otherwise National Rail. Undefined for routes of no known company. */
export function routeLine(tags: Record<string, string>): string | undefined {
  if (tags.ref && tags.ref in LONDON_REFS) return LONDON_REFS[tags.ref]
  const company = trainCompany(tags)
  if (!company) return undefined
  if (OWN_LINES.has(company)) return company
  const route = { company, name: tags.name ?? '', service: tags.service ?? '' }
  if (INTERCITY.some(([c, when]) => c === company && (!when || when(route)))) return 'Intercity'
  return 'National Rail'
}
