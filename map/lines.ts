// How services are grouped into lines, and each line's colour.

/** The lines, each drawn in its colour (hex). National Rail is one line,
 *  the base network; a few networks people know by their own name have
 *  their own, drawn beside it where they share track. `dark` is a colour for
 *  dark maps, where `colour` is too dark to see. */
export const LINES: Record<string, { colour: string; dark?: string }> = {
  'National Rail': { colour: '1D2D5C', dark: 'B9C6E4' },
  'Elizabeth line': { colour: '9364CC' },
  'London Overground': { colour: 'EE7623' },
  'Thameslink': { colour: 'D6007F' },
  'Southeastern': { colour: '00A3E0' },
  'South Western Railway': { colour: 'D7263D' },
  'Heathrow Express': { colour: '5B2C6F' },
  'Merseyrail': { colour: 'E6B800' },
  'Tyne and Wear Metro': { colour: 'F59B00' },
}

export const lineColour = (line: string) => LINES[line]?.colour ?? '808080'

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
const OWN_LINES = new Set(['Thameslink', 'Southeastern', 'South Western Railway', 'Heathrow Express', 'Merseyrail', 'Tyne and Wear Metro'])

/** Britain's train companies, each with the other names OpenStreetMap uses
 *  for it (old names, owners, misspellings). */
const TRAIN_COMPANIES: Record<string, string[]> = {
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
function trainCompany(tags: Record<string, string>): string | undefined {
  for (const name of [tags.brand, tags.name?.split(':')[0], tags.operator, tags.network]) {
    const company = name && companies.get(name.trim().toLowerCase())
    if (company) return company
  }
}

/** Networks and operators of routes with no train company that are still
 *  National Rail lines (the Felixstowe branch, the Bittern Line). */
const NATIONAL_RAIL = new Set(['national rail', 'network rail'])

/** The line a route is drawn as: London's lines by their `ref`, companies
 *  with their own line, otherwise National Rail. Undefined for routes of no
 *  known company, unless tagged as National Rail or Network Rail's. */
function routeLine(tags: Record<string, string>): string | undefined {
  if (tags.ref && tags.ref in LONDON_REFS) return LONDON_REFS[tags.ref]

  const company = trainCompany(tags)

  if (!company) {
    const national = [tags.network, tags.operator].some((name) => name && NATIONAL_RAIL.has(name.trim().toLowerCase()))

    return national ? 'National Rail' : undefined
  }

  return OWN_LINES.has(company) ? company : 'National Rail'
}

/** Stations in the Elizabeth line's tunnel under central London. Its
 *  services that never call at one end at Liverpool Street's or
 *  Paddington's surface platforms, on National Rail's track, and are drawn
 *  as National Rail, as TfL's map does: right over the tunnel, their
 *  terminus would otherwise be merged into it (topo.ts merges a line's
 *  tracks close together). */
const TUNNEL_STOPS = new Set(['Paddington', 'Bond Street', 'Tottenham Court Road', 'Farringdon', 'Liverpool Street', 'Whitechapel'])

/** The line a service (a `route=train` or `light_rail` relation, calling at
 *  stops of these names) is drawn as (see routeLine), or undefined if it
 *  isn't drawn: light rail other than the Tyne and Wear Metro (trams), and
 *  routes of no known company (heritage railways, charters, mistagged
 *  track). Elizabeth line services that stay out of its tunnel are
 *  National Rail (see TUNNEL_STOPS). */
export function serviceLine(tags: Record<string, string>, stopNames: string[]): string | undefined {
  if (tags.route === 'light_rail' && tags.network !== 'Tyne and Wear Metro') return

  const line = routeLine(tags)
  if (line === 'Elizabeth line' && !stopNames.some((name) => TUNNEL_STOPS.has(name))) return 'National Rail'

  return line
}
