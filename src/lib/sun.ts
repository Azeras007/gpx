// Sunrise / sunset computed locally (algorithm from SunCalc, after
// https://aa.quae.nl/en/reken/zonpositie.html) — no network call needed.

const rad = Math.PI / 180;
const dayMs = 864e5;
const J1970 = 2440588;
const J2000 = 2451545;
const J0 = 0.0009;
const obliquity = rad * 23.4397;

const toDays = (date: Date) => date.valueOf() / dayMs - 0.5 + J1970 - J2000;
const fromJulian = (j: number) => new Date((j + 0.5 - J1970) * dayMs);
const meanAnomaly = (d: number) => rad * (357.5291 + 0.98560028 * d);
const eclipticLongitude = (M: number) =>
  M + rad * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M)) + rad * 102.9372 + Math.PI;
const approxTransit = (ht: number, lw: number, n: number) => J0 + (ht + lw) / (2 * Math.PI) + n;
const solarTransitJ = (ds: number, M: number, L: number) => J2000 + ds + 0.0053 * Math.sin(M) - 0.0069 * Math.sin(2 * L);

/** Sunrise and sunset for the day containing `day` (null during polar day/night). */
export function sunTimes(day: Date, lat: number, lng: number): { sunrise: Date | null; sunset: Date | null } {
  const noon = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 12);
  const lw = rad * -lng;
  const phi = rad * lat;
  const d = toDays(noon);
  const n = Math.round(d - J0 - lw / (2 * Math.PI));
  const ds = approxTransit(0, lw, n);
  const M = meanAnomaly(ds);
  const L = eclipticLongitude(M);
  const dec = Math.asin(Math.sin(obliquity) * Math.sin(L));
  const jNoon = solarTransitJ(ds, M, L);
  const cosH = (Math.sin(-0.833 * rad) - Math.sin(phi) * Math.sin(dec)) / (Math.cos(phi) * Math.cos(dec));
  if (cosH < -1 || cosH > 1) return { sunrise: null, sunset: null };
  const jSet = solarTransitJ(approxTransit(Math.acos(cosH), lw, n), M, L);
  return { sunrise: fromJulian(jNoon - (jSet - jNoon)), sunset: fromJulian(jSet) };
}
