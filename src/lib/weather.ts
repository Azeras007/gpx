// Weather forecast with as few API calls as possible.
//
// - Forecasts are cached per ~10 km cell (weather models are coarser than
//   that) for 1 hour, in memory and in localStorage, so reloading the page,
//   moving the start point or changing the start time costs nothing.
// - Simultaneous requests for the same cell share one fetch.
// - Open-Meteo is asked only for the days needed (7, or 16 when planning
//   further ahead) and 4 variables, which counts as a single API call.
// - When Open-Meteo answers 429, the app stops calling it until its limit
//   resets (minute, hour or day) and uses MET Norway instead.

export interface WeatherHour {
  /** Local time of the browser, "YYYY-MM-DDTHH:mm". */
  time: string;
  temp: number;
  /** Probability of precipitation (%), when the provider gives it. */
  rain: number | null;
  /** Precipitation amount for the hour (mm), when the provider gives it. */
  mm: number | null;
  /** km/h */
  wind: number;
  /** WMO weather code. */
  code: number;
}

export interface Weather {
  hours: WeatherHour[];
  source: "Open-Meteo" | "MET Norway";
  fetchedAt: number;
  /** Number of forecast days covered from today. */
  days: number;
}

const TTL = 60 * 60 * 1000;
const CACHE_KEY = "gpx-studio:weather-cache";
const BLOCK_KEY = "gpx-studio:open-meteo-block";
const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;

const pad = (n: number) => String(n).padStart(2, "0");
const localStamp = (d: Date) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

function readStore<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function writeStore(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage full or unavailable */
  }
}

/** Cell center rounded to 0.1° so nearby points share the same forecast. */
const cellOf = (lat: number, lng: number) => ({ lat: Math.round(lat * 10) / 10, lng: Math.round(lng * 10) / 10 });
const cellKey = (c: { lat: number; lng: number }) => `${c.lat.toFixed(1)},${c.lng.toFixed(1)}`;

const memory = new Map<string, Weather>();
const inflight = new Map<string, Promise<Weather>>();

function cached(key: string, days: number): Weather | null {
  const fresh = (w: Weather | undefined) => w && Date.now() - w.fetchedAt < TTL && w.days >= days;
  const m = memory.get(key);
  if (fresh(m)) return m!;
  const stored = readStore<Record<string, Weather>>(CACHE_KEY, {})[key];
  if (fresh(stored)) {
    memory.set(key, stored);
    return stored;
  }
  return null;
}

function store(key: string, w: Weather) {
  memory.set(key, w);
  const all = readStore<Record<string, Weather>>(CACHE_KEY, {});
  all[key] = w;
  // Keep the 20 most recent, still-fresh cells only
  const kept = Object.entries(all)
    .filter(([, v]) => Date.now() - v.fetchedAt < TTL)
    .sort((a, b) => b[1].fetchedAt - a[1].fetchedAt)
    .slice(0, 20);
  writeStore(CACHE_KEY, Object.fromEntries(kept));
}

/** Time until which Open-Meteo must not be called, after a 429. */
export function openMeteoBlockedUntil(): number {
  return readStore<{ until: number }>(BLOCK_KEY, { until: 0 }).until;
}

function blockOpenMeteo(reason: string) {
  const now = new Date();
  let until: number;
  if (/daily/i.test(reason)) until = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  else if (/hourly/i.test(reason)) until = now.getTime() + 61 * 60 * 1000;
  else until = now.getTime() + 65 * 1000;
  writeStore(BLOCK_KEY, { until, reason });
}

class RateLimited extends Error {}

async function fromOpenMeteo(lat: number, lng: number, days: number): Promise<Weather> {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}` +
    `&hourly=temperature_2m,precipitation_probability,wind_speed_10m,weather_code` +
    `&timezone=${encodeURIComponent(tz)}&forecast_days=${days}`;
  const res = await fetch(url);
  if (res.status === 429) {
    const reason = await res
      .json()
      .then((j) => String(j.reason ?? ""))
      .catch(() => "");
    blockOpenMeteo(reason);
    throw new RateLimited(reason);
  }
  if (!res.ok) throw new Error(`Open-Meteo ${res.status}`);
  const h = (await res.json()).hourly;
  return {
    source: "Open-Meteo",
    fetchedAt: Date.now(),
    days,
    hours: (h.time as string[]).map((time, i) => ({
      time,
      temp: h.temperature_2m[i],
      rain: h.precipitation_probability?.[i] ?? null,
      mm: null,
      wind: h.wind_speed_10m[i],
      code: h.weather_code[i],
    })),
  };
}

/** MET Norway symbol codes → closest WMO weather code. */
function metCode(symbol: string): number {
  const s = symbol.replace(/_(day|night|polartwilight)$/, "");
  if (s.includes("thunder")) return 95;
  if (s.includes("snow")) return 71;
  if (s.includes("sleet")) return 66;
  if (s.includes("rain")) return s.includes("showers") ? 80 : 61;
  if (s === "fog") return 45;
  if (s === "cloudy") return 3;
  if (s === "partlycloudy") return 2;
  if (s === "fair") return 1;
  return 0;
}

async function fromMetNorway(lat: number, lng: number): Promise<Weather> {
  const res = await fetch(`https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=${lat}&lon=${lng}`);
  if (!res.ok) throw new Error(`MET Norway ${res.status}`);
  const series = (await res.json()).properties.timeseries as {
    time: string;
    data: {
      instant: { details: { air_temperature: number; wind_speed: number } };
      next_1_hours?: { summary: { symbol_code: string }; details: { precipitation_amount?: number; probability_of_precipitation?: number } };
      next_6_hours?: { summary: { symbol_code: string }; details: { precipitation_amount?: number } };
    };
  }[];
  // Hourly for ~2.5 days, then every 6 hours: expand those to hourly slots.
  const hours: WeatherHour[] = [];
  series.forEach((s, i) => {
    const next = s.data.next_1_hours ?? s.data.next_6_hours;
    const start = new Date(s.time);
    const span = s.data.next_1_hours ? 1 : Math.min(6, series[i + 1] ? (new Date(series[i + 1].time).getTime() - start.getTime()) / 3600e3 : 6);
    for (let k = 0; k < span; k++) {
      const t = new Date(start.getTime() + k * 3600e3);
      hours.push({
        time: localStamp(t),
        temp: s.data.instant.details.air_temperature,
        rain: s.data.next_1_hours?.details.probability_of_precipitation ?? null,
        mm: next?.details.precipitation_amount != null ? next.details.precipitation_amount / (s.data.next_1_hours ? 1 : 6) : null,
        wind: s.data.instant.details.wind_speed * 3.6,
        code: next ? metCode(next.summary.symbol_code) : 0,
      });
    }
  });
  return { source: "MET Norway", fetchedAt: Date.now(), days: 9, hours };
}

export class WeatherError extends Error {}

/**
 * Hourly forecast near a point, covering at least `daysAhead` days from today.
 */
export function getWeather(lat: number, lng: number, daysAhead: number): Promise<Weather> {
  const cell = cellOf(lat, lng);
  const key = cellKey(cell);
  const days = daysAhead < 6 ? 7 : 16;
  const hit = cached(key, Math.ceil(daysAhead) + 1);
  if (hit) return Promise.resolve(hit);
  const running = inflight.get(key);
  if (running) return running;

  const p = (async () => {
    let limited = false;
    if (Date.now() >= openMeteoBlockedUntil()) {
      try {
        const w = await fromOpenMeteo(cell.lat, cell.lng, days);
        store(key, w);
        return w;
      } catch (e) {
        limited = e instanceof RateLimited;
      }
    } else limited = true;
    if (daysAhead <= 8.5) {
      try {
        const w = await fromMetNorway(cell.lat, cell.lng);
        store(key, w);
        return w;
      } catch {
        /* both providers failed */
      }
    }
    if (limited) {
      const until = new Date(openMeteoBlockedUntil());
      const when =
        until.getTime() - Date.now() < 2 * 60 * 1000
          ? "dans une minute"
          : until.toDateString() === new Date().toDateString()
            ? `à ${pad(until.getHours())}:${pad(until.getMinutes())}`
            : "demain";
      throw new WeatherError(`limite Open-Meteo atteinte, de nouveau disponible ${when}`);
    }
    throw new WeatherError("service météo injoignable");
  })();
  inflight.set(key, p);
  p.finally(() => inflight.delete(key)).catch(() => {});
  return p;
}
