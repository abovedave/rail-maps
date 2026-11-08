// How services are grouped into lines, and how lines are drawn.

/** The lines, each drawn in its colour (hex) and width (points). National
 *  Rail is one line, the base network; a few networks people know by their
 *  own name have their own, drawn over it where they share track. `dark` is
 *  a colour for dark maps, where `colour` is too dark to see. `minZoom` is
 *  the zoom a line is shown from. */
export const LINES: Record<string, { colour: string; dark?: string; width: number; minZoom: number }> = {
  'National Rail': { colour: '1D2D5C', dark: 'B9C6E4', width: 2, minZoom: 0 },
  'Elizabeth line': { colour: '9364CC', width: 2, minZoom: 0 },
  'London Overground': { colour: 'EE7623', width: 2, minZoom: 0 },
  'Thameslink': { colour: 'D6007F', width: 2, minZoom: 0 },
  'Southeastern': { colour: '00A3E0', width: 2, minZoom: 0 },
  'South Western Railway': { colour: 'D7263D', width: 2, minZoom: 0 },
  'Heathrow Express': { colour: '5B2C6F', width: 2, minZoom: 0 },
  'Merseyrail': { colour: 'E6B800', width: 2, minZoom: 0 },
  'Tyne and Wear Metro': { colour: 'F59B00', width: 2, minZoom: 0 },
}
export const lineStyle = (line: string): (typeof LINES)[string] => LINES[line] ?? { colour: '808080', width: 2, minZoom: 0 }
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
const OWN_LINES = new Set(['Thameslink', 'Southeastern', 'South Western Railway', 'Heathrow Express', 'Merseyrail', 'Tyne and Wear Metro'])

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

/** The line a route is drawn as: London's lines by their `ref`, companies
 *  with their own line, otherwise National Rail. Undefined for routes of no
 *  known company. */
export function routeLine(tags: Record<string, string>): string | undefined {
  if (tags.ref && tags.ref in LONDON_REFS) return LONDON_REFS[tags.ref]
  const company = trainCompany(tags)
  if (!company) return undefined
  return OWN_LINES.has(company) ? company : 'National Rail'
}
