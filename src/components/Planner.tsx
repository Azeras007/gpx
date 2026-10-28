import { useEffect, useState } from "react";
import {
  Cloud,
  CloudFog,
  CloudLightning,
  CloudRain,
  CloudSnow,
  CloudSun,
  Droplets,
  Flame,
  RotateCw,
  Sun,
  Sunset,
  Target,
  Trash2,
  Utensils,
  Wind,
} from "lucide-react";
import { formatDuration, formatPace, type Activity, type Poi, type Split } from "../lib/geo";
import { getWeather, type Weather } from "../lib/weather";
import { PoiIcon } from "./icons";
import { sunTimes } from "../lib/sun";
import { reportError } from "../lib/report";

const pad = (n: number) => String(n).padStart(2, "0");
/** "YYYY-MM-DDTHH:mm" in local time. */
export const toLocalInput = (d: Date) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
const clock = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

function WeatherIcon({ code, size = 18 }: { code: number; size?: number }) {
  if (code === 0) return <Sun size={size} color="#b07d2b" />;
  if (code <= 2) return <CloudSun size={size} color="#8a6a2a" />;
  if (code === 3) return <Cloud size={size} color="#6e6a60" />;
  if (code === 45 || code === 48) return <CloudFog size={size} color="#8b8578" />;
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return <CloudSnow size={size} color="#5d7894" />;
  if (code >= 95) return <CloudLightning size={size} color="#6b3a5e" />;
  return <CloudRain size={size} color="#3d5f87" />;
}

interface Props {
  activity: Activity;
  start: string;
  onStartChange: (v: string) => void;
  duration: number;
  runPace: number;
  hikeSpeed: number;
  onApplyPace: (runPace: number) => void;
  onApplySpeed: (hikeSpeed: number) => void;
  startPoint: { lat: number; lng: number } | null;
  splits: Split[];
  pois: (Poi & { d: number | null })[];
  onRenamePoi: (id: string, name: string) => void;
  onRemovePoi: (id: string) => void;
  onFocusPoi: (p: Poi) => void;
  weight: number;
  onWeightChange: (v: number) => void;
  kcal: number;
}

export default function Planner(p: Props) {
  const [weather, setWeather] = useState<Weather | null>(null);
  const [weatherError, setWeatherError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [target, setTarget] = useState("");
  const startDate = p.start ? new Date(p.start) : null;
  const endDate = startDate ? new Date(startDate.getTime() + p.duration * 1000) : null;
  const daysAhead = startDate ? (startDate.getTime() - Date.now()) / 86400000 : 0;
  const forecastable = startDate != null && daysAhead > -1 && daysAhead < 15;
  const lat = p.startPoint ? +p.startPoint.lat.toFixed(1) : null;
  const lng = p.startPoint ? +p.startPoint.lng.toFixed(1) : null;

  // Only the forecast cell (~10 km) and the number of days needed matter: the
  // start time can change freely without any new request.
  const daysNeeded = startDate ? Math.max(0, Math.ceil((endDate!.getTime() - Date.now()) / 86400000)) : 0;
  useEffect(() => {
    setWeatherError(null);
    if (!forecastable || lat == null || lng == null) return;
    let alive = true;
    const t = setTimeout(() => {
      getWeather(lat, lng, daysNeeded)
        .then((w) => alive && setWeather(w))
        .catch((e) => {
          reportError(e, "météo", "warn");
          if (alive) setWeatherError((e as Error).message || "erreur réseau");
        });
    }, 400);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [forecastable, lat, lng, daysNeeded, retry]);

  // Forecast hours covering the outing (at most 8 cards).
  const hours = (() => {
    if (!weather || !startDate || !endDate) return [];
    const from = p.start.slice(0, 13);
    const to = toLocalInput(endDate).slice(0, 13);
    const inRange = weather.hours.filter((h) => h.time.slice(0, 13) >= from && h.time.slice(0, 13) <= to);
    const every = Math.ceil(inRange.length / 8) || 1;
    return inRange.filter((_, i) => i % every === 0);
  })();
  const sun = startDate && p.startPoint ? sunTimes(startDate, p.startPoint.lat, p.startPoint.lng) : null;
  const sunset = sun?.sunset ?? null;
  const lateFinish = sunset && endDate && endDate > sunset && startDate! < sunset;
  const maxTemp = hours.length ? Math.max(...hours.map((h) => h.temp)) : null;
  const maxRain = hours.length ? Math.max(...hours.map((h) => h.rain ?? ((h.mm ?? 0) >= 0.5 ? 60 : 0))) : 0;

  // Water & food: ~0.5 L/h walking, 0.6 L/h running, more when it is hot.
  const hoursOut = p.duration / 3600;
  const heat = maxTemp == null ? 0 : maxTemp > 28 ? 0.35 : maxTemp > 22 ? 0.2 : 0;
  const water = hoursOut * ((p.activity === "run" ? 0.6 : 0.5) + heat);
  const carbs = hoursOut > (p.activity === "run" ? 1.25 : 2) ? hoursOut * (p.activity === "run" ? 50 : 35) : 0;

  // Target time → flat pace / speed needed, using the same effort model as the estimate.
  const targetSec = (() => {
    const m = target.match(/^(\d{1,2})(?:[:h](\d{1,2}))?$/);
    if (!m) return null;
    return (+m[1] * 60 + (m[2] ? +m[2] : 0)) * 60;
  })();
  const ratio = targetSec && p.duration ? targetSec / p.duration : null;
  const neededPace = ratio ? p.runPace * ratio : null;
  const neededSpeed = ratio ? p.hikeSpeed / ratio : null;

  return (
    <>
      <div className="block">
        <div className="block-head">
          <span>Départ prévu</span>
          <button className="link" onClick={() => p.onStartChange(toLocalInput(new Date(Math.ceil(Date.now() / 900000) * 900000)))}>
            Maintenant
          </button>
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

      <div className="block">
        <div className="block-head">
          <span>
            <Target size={14} /> Objectif de temps
          </span>
        </div>
        <div className="field-row">
          <input
            className="field"
            placeholder="ex. 1:45 ou 5h30"
            value={target}
            onChange={(e) => setTarget(e.target.value.trim())}
            inputMode="numeric"
          />
          {ratio && (
            <button
              className="secondary"
              onClick={() => (p.activity === "run" ? p.onApplyPace(neededPace!) : p.onApplySpeed(neededSpeed!))}
              disabled={p.activity === "run" ? neededPace! < 2.5 || neededPace! > 15 : neededSpeed! < 1 || neededSpeed! > 9}
            >
              Appliquer
            </button>
          )}
        </div>
        {ratio && (
          <p className="target-result">
            {p.activity === "run" ? (
              <>
                Allure sur le plat nécessaire : <b>{formatPace(neededPace!)} /km</b>
                {neededPace! < 2.5 && " — irréaliste 😅"}
              </>
            ) : (
              <>
                Vitesse de marche nécessaire : <b>{neededSpeed!.toFixed(1).replace(".", ",")} km/h</b>
                {neededSpeed! > 7 && " — très ambitieux"}
              </>
            )}
          </p>
        )}
      </div>

      {startDate && (
        <div className="block">
          <div className="block-head">
            <span>Météo sur le parcours</span>
            {sun?.sunrise && sun.sunset && (
              <span className="sun">
                <Sun size={13} /> {clock(sun.sunrise)} · <Sunset size={13} /> {clock(sun.sunset)}
              </span>
            )}
          </div>
          {!p.startPoint ? (
            <p className="muted">Placez un point de départ pour voir la météo.</p>
          ) : !forecastable ? (
            <p className="muted">Prévisions disponibles jusqu'à 15 jours à l'avance.</p>
          ) : weatherError ? (
            <div className="alert">
              <CloudRain size={16} />
              <span>
                Météo indisponible ({weatherError}).
                <button className="link" onClick={() => setRetry((r) => r + 1)}>
                  <RotateCw size={12} /> Réessayer
                </button>
              </span>
            </div>
          ) : !weather ? (
            <p className="muted">
              <span className="spinner" /> Chargement des prévisions…
            </p>
          ) : hours.length === 0 ? (
            <p className="muted">Pas de prévision pour ce créneau.</p>
          ) : (
            <>
              <div className="weather">
                {hours.map((h) => (
                  <div key={h.time} className="hour">
                    <span>{h.time.slice(11, 13)}h</span>
                    <WeatherIcon code={h.code} />
                    <b>{Math.round(h.temp)}°</b>
                    {h.rain != null ? (
                      <small className={h.rain >= 40 ? "rainy" : ""}>
                        <Droplets size={10} /> {h.rain}%
                      </small>
                    ) : (
                      <small className={(h.mm ?? 0) >= 0.5 ? "rainy" : ""}>
                        <Droplets size={10} /> {(h.mm ?? 0).toFixed(1).replace(".", ",")} mm
                      </small>
                    )}
                    <small>
                      <Wind size={10} /> {Math.round(h.wind)}
                    </small>
                  </div>
                ))}
              </div>
              {maxRain >= 50 && <p className="muted small">☔ Pluie probable — prenez une veste imperméable.</p>}
              <p className="muted small source">Prévisions {weather.source}</p>
            </>
          )}
        </div>
      )}

      <div className="block">
        <div className="block-head">
          <span>Dans le sac</span>
        </div>
        <div className="bag">
          <div>
            <Droplets size={18} />
            <b>{p.duration ? `${String(Math.max(0.25, Math.ceil(water * 4) / 4)).replace(".", ",")} L` : "—"}</b>
            <span>d'eau{heat ? " (chaleur)" : ""}</span>
          </div>
          <div>
            <Utensils size={18} />
            <b>{carbs ? `${Math.round(carbs / 10) * 10} g` : "—"}</b>
            <span>{carbs ? `glucides ≈ ${Math.ceil(carbs / 25)} ${p.activity === "run" ? "gels" : "barres"}` : "pas de ravito nécessaire"}</span>
          </div>
          <div>
            <Flame size={18} />
            <b>{Math.round(p.kcal)}</b>
            <span>kcal dépensées</span>
          </div>
        </div>
        <label className="inline-field">
          <span>Votre poids</span>
          <input
            type="number"
            min={30}
            max={200}
            value={p.weight}
            onChange={(e) => {
              const v = parseFloat(e.target.value);
              if (isFinite(v) && v > 0) p.onWeightChange(v);
            }}
          />
          <span>kg</span>
        </label>
      </div>

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
                <span>{Math.abs(s.length - 1000) < 1 ? s.km : (s.km - 1 + s.length / 1000).toFixed(2).replace(".", ",")}</span>
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
            {[...p.pois]
              .sort((a, b) => (a.d ?? Infinity) - (b.d ?? Infinity))
              .map((poi) => (
                <li key={poi.id}>
                  <button className="poi-emoji" onClick={() => p.onFocusPoi(poi)} title="Centrer la carte">
                    <PoiIcon type={poi.type} size={14} />
                  </button>
                  <input value={poi.name} onChange={(e) => p.onRenamePoi(poi.id, e.target.value)} />
                  <span>{poi.d != null ? `km ${(poi.d / 1000).toFixed(1).replace(".", ",")}` : "hors tracé"}</span>
                  <button className="icon-btn ghost" onClick={() => p.onRemovePoi(poi.id)} title="Supprimer">
                    <Trash2 size={14} />
                  </button>
                </li>
              ))}
          </ul>
        )}
      </div>
    </>
  );
}

function formatSplit(s: number) {
  const total = Math.round(s);
  const m = Math.floor(total / 60);
  if (m >= 60) return `${Math.floor(m / 60)}h${pad(m % 60)}`;
  return `${m}:${pad(total % 60)}`;
}
