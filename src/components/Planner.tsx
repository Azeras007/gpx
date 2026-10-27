import { useEffect, useState } from "react";
import { Cloud, CloudFog, CloudLightning, CloudRain, CloudSnow, CloudSun, Sun, Sunset, Trash2, Wind } from "lucide-react";
import { formatDuration, POI_TYPES, type Poi, type Split } from "../lib/geo";
import { fetchWeather, type Weather } from "../lib/services";

const pad = (n: number) => String(n).padStart(2, "0");
/** "YYYY-MM-DDTHH:mm" in local time. */
export const toLocalInput = (d: Date) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
const clock = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

function WeatherIcon({ code, size = 18 }: { code: number; size?: number }) {
  if (code === 0) return <Sun size={size} color="#fbbf24" />;
  if (code <= 2) return <CloudSun size={size} color="#fcd34d" />;
  if (code === 3) return <Cloud size={size} color="#cbd5e1" />;
  if (code === 45 || code === 48) return <CloudFog size={size} color="#94a3b8" />;
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return <CloudSnow size={size} color="#e0f2fe" />;
  if (code >= 95) return <CloudLightning size={size} color="#c084fc" />;
  return <CloudRain size={size} color="#60a5fa" />;
}

interface Props {
  start: string;
  onStartChange: (v: string) => void;
  duration: number;
  startPoint: { lat: number; lng: number } | null;
  splits: Split[];
  pois: (Poi & { d: number | null })[];
  onRenamePoi: (id: string, name: string) => void;
  onRemovePoi: (id: string) => void;
  onFocusPoi: (p: Poi) => void;
  weight: number;
  onWeightChange: (v: number) => void;
}

export default function Planner(p: Props) {
  const [weather, setWeather] = useState<Weather | null>(null);
  const [weatherError, setWeatherError] = useState(false);
  const startDate = p.start ? new Date(p.start) : null;
  const endDate = startDate ? new Date(startDate.getTime() + p.duration * 1000) : null;
  const daysAhead = startDate ? (startDate.getTime() - Date.now()) / 86400000 : 0;
  const forecastable = startDate != null && daysAhead > -1 && daysAhead < 15;
  const lat = p.startPoint?.lat;
  const lng = p.startPoint?.lng;
  const endDay = endDate ? p.start.slice(0, 10) === toLocalInput(endDate).slice(0, 10) ? p.start.slice(0, 10) : toLocalInput(endDate).slice(0, 10) : "";

  useEffect(() => {
    setWeather(null);
    setWeatherError(false);
    if (!forecastable || lat == null || lng == null) return;
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      fetchWeather(lat, lng, p.start.slice(0, 10), endDay, ctrl.signal)
        .then(setWeather)
        .catch((e) => e.name !== "AbortError" && setWeatherError(true));
    }, 500);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
    // Coordinates are rounded so small edits of the start point do not refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [forecastable, lat?.toFixed(2), lng?.toFixed(2), p.start.slice(0, 13), endDay]);

  // Forecast hours that cover the outing (at most 8 cards).
  const hours = (() => {
    if (!weather || !startDate || !endDate) return [];
    const from = p.start.slice(0, 13);
    const to = toLocalInput(endDate).slice(0, 13);
    const inRange = weather.hours.filter((h) => h.time.slice(0, 13) >= from && h.time.slice(0, 13) <= to);
    const every = Math.ceil(inRange.length / 8);
    return inRange.filter((_, i) => i % every === 0);
  })();
  const sunset = weather ? new Date(weather.sunset) : null;
  const lateFinish = sunset && endDate && endDate > sunset;

  return (
    <>
      <div className="block">
        <div className="block-head">
          <span>Départ prévu</span>
          {!p.start && (
            <button className="link" onClick={() => p.onStartChange(toLocalInput(new Date(Math.ceil(Date.now() / 900000) * 900000)))}>
              Maintenant
            </button>
          )}
        </div>
        <input type="datetime-local" className="field" value={p.start} onChange={(e) => p.onStartChange(e.target.value)} />
        {startDate && endDate && (
          <div className="timeline">
            <div>
              <span className="label">Départ</span>
              <b>{clock(startDate)}</b>
            </div>
            <div className="timeline-bar">
              <span>{formatDuration(p.duration)}</span>
            </div>
            <div>
              <span className="label">Arrivée</span>
              <b>{clock(endDate)}</b>
            </div>
          </div>
        )}
        {lateFinish && (
          <div className="alert">
            <Sunset size={16} /> Arrivée après le coucher du soleil ({clock(sunset)}) — pensez à la frontale.
          </div>
        )}
      </div>

      {startDate && (
        <div className="block">
          <div className="block-head">
            <span>Météo sur le parcours</span>
            {weather && (
              <span className="sun">
                <Sun size={13} /> {weather.sunrise.slice(11)} · <Sunset size={13} /> {weather.sunset.slice(11)}
              </span>
            )}
          </div>
          {!p.startPoint ? (
            <p className="muted">Placez un point de départ pour voir la météo.</p>
          ) : !forecastable ? (
            <p className="muted">Prévisions disponibles jusqu'à 15 jours à l'avance.</p>
          ) : weatherError ? (
            <p className="muted">Météo indisponible pour le moment.</p>
          ) : !weather ? (
            <p className="muted">
              <span className="spinner" /> Chargement des prévisions…
            </p>
          ) : (
            <div className="weather">
              {hours.map((h) => (
                <div key={h.time} className="hour">
                  <span>{h.time.slice(11, 13)}h</span>
                  <WeatherIcon code={h.code} />
                  <b>{Math.round(h.temp)}°</b>
                  <small className={h.rain >= 40 ? "rainy" : ""}>{h.rain}%</small>
                  <small>
                    <Wind size={10} /> {Math.round(h.wind)}
                  </small>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="block">
        <div className="block-head">
          <span>Temps de passage</span>
          <b>{p.splits.length ? `${p.splits.length} km` : ""}</b>
        </div>
        {p.splits.length === 0 ? (
          <p className="muted">Tracez un parcours pour obtenir le détail kilomètre par kilomètre.</p>
        ) : (
          <div className="splits">
            <div className="split head">
              <span>Km</span>
              <span>D+</span>
              <span>D-</span>
              <span>Temps</span>
              <span>{startDate ? "Heure" : "Cumul"}</span>
            </div>
            {p.splits.map((s) => (
              <div key={s.km} className="split">
                <span>{s.length < 999 ? (s.km - 1 + s.length / 1000).toFixed(1) : s.km}</span>
                <span className="up">{Math.round(s.gain)}</span>
                <span className="down">{Math.round(s.loss)}</span>
                <span>{formatSplit(s.time)}</span>
                <span>{startDate ? clock(new Date(startDate.getTime() + s.elapsed * 1000)) : formatDuration(s.elapsed)}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="block">
        <div className="block-head">
          <span>Repères</span>
          <b>{p.pois.length}</b>
        </div>
        {p.pois.length === 0 ? (
          <p className="muted">Ajoutez des points d'eau, ravitos ou sommets depuis l'onglet Tracer. Ils sont exportés dans le GPX.</p>
        ) : (
          <ul className="poi-list">
            {p.pois.map((poi) => (
              <li key={poi.id}>
                <button className="poi-emoji" onClick={() => p.onFocusPoi(poi)} title="Centrer la carte">
                  {POI_TYPES[poi.type].emoji}
                </button>
                <input value={poi.name} onChange={(e) => p.onRenamePoi(poi.id, e.target.value)} />
                <span>{poi.d != null ? `km ${(poi.d / 1000).toFixed(1)}` : "hors tracé"}</span>
                <button className="icon-btn ghost" onClick={() => p.onRemovePoi(poi.id)} title="Supprimer">
                  <Trash2 size={14} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="block">
        <div className="block-head">
          <span>Poids (calories)</span>
          <b>{p.weight} kg</b>
        </div>
        <input type="range" min={40} max={120} step={1} value={p.weight} onChange={(e) => p.onWeightChange(+e.target.value)} />
      </div>
    </>
  );
}

function formatSplit(s: number) {
  const m = Math.floor(s / 60);
  const sec = Math.round(s % 60);
  if (m >= 60) return `${Math.floor(m / 60)}h${pad(m % 60)}`;
  return `${m}:${pad(sec === 60 ? 59 : sec)}`;
}
