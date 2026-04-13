import Papa from "papaparse";

const AIRPORTS_CSV_URL = "https://davidmegginson.github.io/ourairports-data/airports.csv";
const FREQUENCIES_CSV_URL = "https://davidmegginson.github.io/ourairports-data/airport-frequencies.csv";
const FLIGHTPLAN_AIRPORT_URL = "https://api.flightplandatabase.com/nav/airport";
const AVIATION_API_CHARTS_URL = "https://api.aviationapi.com/v1/charts";

const NOTAM_API_URL_TEMPLATE = String(import.meta.env.NOTAM_API_URL_TEMPLATE ?? "").trim();

type CsvRow = Record<string, string>;

export interface Airport {
  id: string;
  ident: string;
  type: string;
  name: string;
  latitudeDeg: number | null;
  longitudeDeg: number | null;
  elevationFt: number | null;
  isoCountry: string;
  isoRegion: string;
  municipality: string;
  scheduledService: boolean;
  icaoCode: string;
  iataCode: string;
  gpsCode: string;
  localCode: string;
}

export interface AirportSummary {
  ident: string;
  name: string;
  municipality: string;
  isoCountry: string;
  isoRegion: string;
  type: string;
  elevationFt: number | null;
  latitudeDeg: number | null;
  longitudeDeg: number | null;
  scheduledService: boolean;
  iataCode: string;
  gpsCode: string;
  localCode: string;
}

export interface ExpertFrequency {
  type: string;
  name: string;
  frequencyMhz: number | null;
}

export interface ProcedureChart {
  chartCode: string;
  chartName: string;
  pdfName: string;
  pdfPath: string;
}

export interface NotamItem {
  id: string;
  message: string;
  effective: string;
  expires: string;
}

export interface AirportExpertData {
  frequencies: ExpertFrequency[];
  stars: ProcedureChart[];
  sids: ProcedureChart[];
  notams: NotamItem[];
  notamSearchUrl: string;
  warnings: string[];
}

interface FlightPlanFrequency {
  type?: string;
  name?: string;
  frequency?: number;
}

interface FlightPlanAirportResponse {
  frequencies?: FlightPlanFrequency[];
}

interface AviationApiChart {
  chart_code?: string;
  chart_name?: string;
  pdf_name?: string;
  pdf_path?: string;
}

let airportsPromise: Promise<Airport[]> | null = null;
let csvFrequencyIndexPromise: Promise<Map<string, ExpertFrequency[]>> | null = null;

function parseCsv(text: string): CsvRow[] {
  const parsed = Papa.parse<CsvRow>(text, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (header) => header.trim(),
  });

  return parsed.data;
}

async function fetchCsvRows(url: string): Promise<CsvRow[]> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`CSV request failed: ${response.status} ${response.statusText}`);
  }

  const csvText = await response.text();
  return parseCsv(csvText);
}

function clean(value: string | undefined): string {
  return String(value ?? "").trim();
}

function parseNumber(value: string | undefined): number | null {
  const cleaned = clean(value);
  if (!cleaned) {
    return null;
  }

  const numberValue = Number(cleaned);
  return Number.isFinite(numberValue) ? numberValue : null;
}

function parseBoolean(value: string | undefined): boolean {
  return clean(value).toLowerCase() === "yes";
}

function normalizeIdentifier(value: string): string {
  return clean(value).toUpperCase();
}

function toAirport(row: CsvRow): Airport | null {
  const ident = clean(row.ident);
  const name = clean(row.name);

  if (!ident || !name) {
    return null;
  }

  return {
    id: clean(row.id),
    ident,
    type: clean(row.type),
    name,
    latitudeDeg: parseNumber(row.latitude_deg),
    longitudeDeg: parseNumber(row.longitude_deg),
    elevationFt: parseNumber(row.elevation_ft),
    isoCountry: clean(row.iso_country),
    isoRegion: clean(row.iso_region),
    municipality: clean(row.municipality),
    scheduledService: parseBoolean(row.scheduled_service),
    icaoCode: clean(row.icao_code),
    iataCode: clean(row.iata_code),
    gpsCode: clean(row.gps_code),
    localCode: clean(row.local_code),
  };
}

function createSearchHaystack(airport: Airport): string {
  return [
    airport.ident,
    airport.name,
    airport.municipality,
    airport.isoCountry,
    airport.isoRegion,
    airport.iataCode,
    airport.gpsCode,
    airport.localCode,
  ]
    .filter(Boolean)
    .join(" ")
    .toUpperCase();
}

function scoreAirportMatch(airport: Airport, query: string): number {
  const normalizedQuery = normalizeIdentifier(query);
  if (!normalizedQuery) {
    return 0;
  }

  const codeCandidates = [airport.ident, airport.gpsCode, airport.iataCode, airport.localCode]
    .map(normalizeIdentifier)
    .filter(Boolean);

  if (codeCandidates.includes(normalizedQuery)) {
    return 120;
  }

  if (codeCandidates.some((code) => code.startsWith(normalizedQuery))) {
    return 95;
  }

  const upperName = airport.name.toUpperCase();
  if (upperName.startsWith(normalizedQuery)) {
    return 80;
  }

  const haystack = createSearchHaystack(airport);
  if (haystack.includes(normalizedQuery)) {
    return 50;
  }

  return 0;
}

function sortByScoreAndName(entries: Array<{ airport: Airport; score: number }>): Airport[] {
  return entries
    .sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }

      return a.airport.name.localeCompare(b.airport.name);
    })
    .map((entry) => entry.airport);
}

function dedupeFrequencies(frequencies: ExpertFrequency[]): ExpertFrequency[] {
  const seen = new Set<string>();
  const deduped: ExpertFrequency[] = [];

  for (const frequency of frequencies) {
    const key = `${frequency.type}|${frequency.name}|${String(frequency.frequencyMhz)}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push(frequency);
  }

  return deduped.sort((a, b) => {
    if (a.frequencyMhz !== null && b.frequencyMhz !== null && a.frequencyMhz !== b.frequencyMhz) {
      return a.frequencyMhz - b.frequencyMhz;
    }

    return a.type.localeCompare(b.type);
  });
}

function dedupeCharts(charts: ProcedureChart[]): ProcedureChart[] {
  const seen = new Set<string>();
  const deduped: ProcedureChart[] = [];

  for (const chart of charts) {
    const key = `${chart.chartCode}|${chart.chartName}|${chart.pdfPath}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push(chart);
  }

  return deduped.sort((a, b) => a.chartName.localeCompare(b.chartName));
}

function normalizeNotamEntry(entry: unknown, index: number): NotamItem | null {
  if (typeof entry === "string" && entry.trim()) {
    return {
      id: `NOTAM-${index + 1}`,
      message: entry.trim(),
      effective: "",
      expires: "",
    };
  }

  if (!entry || typeof entry !== "object") {
    return null;
  }

  const candidate = entry as Record<string, unknown>;

  const id =
    clean(String(candidate.id ?? "")) ||
    clean(String(candidate.notamId ?? "")) ||
    clean(String(candidate.number ?? "")) ||
    `NOTAM-${index + 1}`;

  const message =
    clean(String(candidate.message ?? "")) ||
    clean(String(candidate.rawText ?? "")) ||
    clean(String(candidate.notamText ?? "")) ||
    clean(String(candidate.text ?? ""));

  if (!message) {
    return null;
  }

  const effective =
    clean(String(candidate.effective ?? "")) || clean(String(candidate.startDate ?? ""));
  const expires = clean(String(candidate.expires ?? "")) || clean(String(candidate.endDate ?? ""));

  return {
    id,
    message,
    effective,
    expires,
  };
}

function parseNotamList(data: unknown): NotamItem[] {
  let rawEntries: unknown[] = [];

  if (Array.isArray(data)) {
    rawEntries = data;
  } else if (data && typeof data === "object") {
    const record = data as Record<string, unknown>;

    if (Array.isArray(record.notams)) {
      rawEntries = record.notams;
    } else if (Array.isArray(record.items)) {
      rawEntries = record.items;
    } else {
      const firstArray = Object.values(record).find((value) => Array.isArray(value));
      if (Array.isArray(firstArray)) {
        rawEntries = firstArray;
      }
    }
  }

  return rawEntries
    .map((entry, index) => normalizeNotamEntry(entry, index))
    .filter((entry): entry is NotamItem => entry !== null);
}

function buildNotamUrl(template: string, ident: string): string {
  if (template.includes("{ident}")) {
    return template.replaceAll("{ident}", encodeURIComponent(ident));
  }

  const parsedUrl = new URL(template);
  if (!parsedUrl.searchParams.has("ident")) {
    parsedUrl.searchParams.set("ident", ident);
  }

  return parsedUrl.toString();
}

function formatFrequencyMhz(frequencyHz: number | undefined): number | null {
  if (!Number.isFinite(frequencyHz)) {
    return null;
  }

  return Number((frequencyHz / 1_000_000).toFixed(3));
}

async function getFlightPlanFrequencies(ident: string): Promise<ExpertFrequency[]> {
  const response = await fetch(`${FLIGHTPLAN_AIRPORT_URL}/${encodeURIComponent(ident)}`);
  if (!response.ok) {
    return [];
  }

  const payload = (await response.json()) as FlightPlanAirportResponse;
  const entries = payload.frequencies ?? [];

  return entries.map((entry) => ({
    type: clean(entry.type || "OTHER") || "OTHER",
    name: clean(entry.name || "") || "Unknown",
    frequencyMhz: formatFrequencyMhz(entry.frequency),
  }));
}

async function getCsvFrequencyIndex(): Promise<Map<string, ExpertFrequency[]>> {
  if (!csvFrequencyIndexPromise) {
    csvFrequencyIndexPromise = (async () => {
      const rows = await fetchCsvRows(FREQUENCIES_CSV_URL);
      const frequencyMap = new Map<string, ExpertFrequency[]>();

      for (const row of rows) {
        const ident = normalizeIdentifier(row.airport_ident ?? "");
        if (!ident) {
          continue;
        }

        const nextFrequency: ExpertFrequency = {
          type: clean(row.type || "OTHER") || "OTHER",
          name: clean(row.description || "") || "Unknown",
          frequencyMhz: parseNumber(row.frequency_mhz),
        };

        const existing = frequencyMap.get(ident) ?? [];
        existing.push(nextFrequency);
        frequencyMap.set(ident, existing);
      }

      return frequencyMap;
    })();
  }

  return csvFrequencyIndexPromise;
}

async function getCsvFrequencies(ident: string): Promise<ExpertFrequency[]> {
  const index = await getCsvFrequencyIndex();
  return index.get(normalizeIdentifier(ident)) ?? [];
}

async function getProcedureCharts(ident: string): Promise<{ stars: ProcedureChart[]; sids: ProcedureChart[] }> {
  const url = new URL(AVIATION_API_CHARTS_URL);
  url.searchParams.set("apt", ident);
  url.searchParams.set("chart", "STAR");

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Charts request failed: ${response.status} ${response.statusText}`);
  }

  const payload = (await response.json()) as Record<string, AviationApiChart[]>;
  const rawCharts = payload[ident] ?? payload[ident.toUpperCase()] ?? [];

  const mappedCharts: ProcedureChart[] = rawCharts
    .map((chart) => ({
      chartCode: clean(chart.chart_code),
      chartName: clean(chart.chart_name),
      pdfName: clean(chart.pdf_name),
      pdfPath: clean(chart.pdf_path),
    }))
    .filter((chart) => chart.chartName && chart.pdfPath);

  const stars = mappedCharts.filter((chart) => chart.chartCode === "STAR");
  const sids = mappedCharts.filter((chart) => chart.chartCode === "DP");

  return {
    stars: dedupeCharts(stars),
    sids: dedupeCharts(sids),
  };
}

async function getNotams(ident: string): Promise<{ notams: NotamItem[]; warning: string }> {
  if (!NOTAM_API_URL_TEMPLATE) {
    return {
      notams: [],
      warning: "No NOTAM API is configured on the server. Set NOTAM_API_URL_TEMPLATE to enable live NOTAM data.",
    };
  }

  try {
    const url = buildNotamUrl(NOTAM_API_URL_TEMPLATE, ident);
    const response = await fetch(url);
    if (!response.ok) {
      return {
        notams: [],
        warning: `NOTAM request failed: ${response.status} ${response.statusText}`,
      };
    }

    const payload = (await response.json()) as unknown;
    const parsed = parseNotamList(payload);

    if (!parsed.length) {
      return {
        notams: [],
        warning: "NOTAM API responded successfully, but no NOTAM entries were returned for this airport.",
      };
    }

    return {
      notams: parsed,
      warning: "",
    };
  } catch {
    return {
      notams: [],
      warning: "Unable to load NOTAM data from the configured API.",
    };
  }
}

export async function loadAirports(): Promise<Airport[]> {
  if (!airportsPromise) {
    airportsPromise = (async () => {
      const rows = await fetchCsvRows(AIRPORTS_CSV_URL);
      return rows
        .map(toAirport)
        .filter((airport): airport is Airport => airport !== null);
    })();
  }

  return airportsPromise;
}

export function toAirportSummary(airport: Airport): AirportSummary {
  return {
    ident: airport.ident,
    name: airport.name,
    municipality: airport.municipality,
    isoCountry: airport.isoCountry,
    isoRegion: airport.isoRegion,
    type: airport.type,
    elevationFt: airport.elevationFt,
    latitudeDeg: airport.latitudeDeg,
    longitudeDeg: airport.longitudeDeg,
    scheduledService: airport.scheduledService,
    iataCode: airport.iataCode,
    gpsCode: airport.gpsCode,
    localCode: airport.localCode,
  };
}

export async function searchAirports(query: string, limit = 20): Promise<Airport[]> {
  const trimmedQuery = clean(query);
  if (!trimmedQuery) {
    return [];
  }

  const safeLimit = Number.isFinite(limit) ? Math.min(Math.max(Math.floor(limit), 1), 50) : 20;
  const airports = await loadAirports();

  const scored = airports
    .map((airport) => ({
      airport,
      score: scoreAirportMatch(airport, trimmedQuery),
    }))
    .filter((entry) => entry.score > 0);

  return sortByScoreAndName(scored).slice(0, safeLimit);
}

export async function getAirportByIdentifier(identifier: string): Promise<Airport | null> {
  const normalizedIdentifier = normalizeIdentifier(identifier);
  if (!normalizedIdentifier) {
    return null;
  }

  const airports = await loadAirports();
  return (
    airports.find((airport) => {
      const candidates = [airport.ident, airport.gpsCode, airport.iataCode, airport.localCode, airport.id]
        .map(normalizeIdentifier)
        .filter(Boolean);

      return candidates.includes(normalizedIdentifier);
    }) ?? null
  );
}

export async function getAirportExpertData(identifier: string): Promise<AirportExpertData | null> {
  const airport = await getAirportByIdentifier(identifier);
  if (!airport) {
    return null;
  }

  const ident = normalizeIdentifier(airport.ident);
  const warnings: string[] = [];

  const [flightPlanFrequencies, csvFrequencies, procedureResult, notamResult] = await Promise.all([
    getFlightPlanFrequencies(ident),
    getCsvFrequencies(ident),
    getProcedureCharts(ident).catch(() => ({ stars: [], sids: [] })),
    getNotams(ident),
  ]);

  if (!procedureResult.stars.length && !procedureResult.sids.length) {
    warnings.push("No SID/STAR chart records were returned for this airport.");
  }

  if (notamResult.warning) {
    warnings.push(notamResult.warning);
  }

  const frequencies = dedupeFrequencies([...flightPlanFrequencies, ...csvFrequencies]);
  if (!frequencies.length) {
    warnings.push("No frequency data was available for this airport.");
  }

  return {
    frequencies,
    stars: procedureResult.stars,
    sids: procedureResult.sids,
    notams: notamResult.notams,
    notamSearchUrl: "https://notams.aim.faa.gov/notamSearch/nsapp.html#/",
    warnings,
  };
}
