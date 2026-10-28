import { Component, type ReactNode } from "react";
import { reportError } from "../lib/report";

interface State {
  error: Error | null;
}

/** Last line of defense: a crash shows a way out instead of a blank page, and is reported. */
export default class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    reportError(error, "react", "error", { composants: (info.componentStack ?? "").trim().split("\n").slice(0, 3).join(" < ").slice(0, 200) });
  }

  render() {
    if (!this.state.error) return this.props.children;
    const resetDraft = () => {
      try {
        localStorage.removeItem("gpx-studio:draft");
      } catch {
        /* storage unavailable */
      }
      location.reload();
    };
    return (
      <div className="crash">
        <div className="crash-card">
          <h1>Oups, quelque chose s'est mal passé</h1>
          <p>Le problème nous a été signalé automatiquement. Votre parcours en cours est sauvegardé sur cet appareil.</p>
          <div className="crash-actions">
            <button className="primary" onClick={() => location.reload()}>
              Recharger l'application
            </button>
            <button className="secondary" onClick={resetDraft}>
              Repartir d'une carte vide
            </button>
          </div>
          <p className="muted small">Si l'erreur revient, « Repartir d'une carte vide » efface le parcours en cours (pas vos parcours enregistrés).</p>
        </div>
      </div>
    );
  }
}
