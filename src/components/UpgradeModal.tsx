import { useState } from "react";
import { Check, Sparkles, X } from "lucide-react";
import { PRICES, PRO_FEATURES, TRIAL_DAYS, type ProFeature } from "../lib/plan";

interface Props {
  feature: ProFeature | null;
  trialUsed: boolean;
  onStartTrial: () => void;
  onCheckout: (period: "monthly" | "yearly") => boolean;
  onClose: () => void;
}

export default function UpgradeModal({ feature, trialUsed, onStartTrial, onCheckout, onClose }: Props) {
  const [period, setPeriod] = useState<"yearly" | "monthly">("yearly");
  const [notice, setNotice] = useState<string | null>(null);
  const highlighted = feature ? PRO_FEATURES[feature] : null;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal panel upgrade" onClick={(e) => e.stopPropagation()}>
        <button className="icon-btn ghost close" onClick={onClose} aria-label="Fermer">
          <X size={16} />
        </button>
        <span className="pro-pill big">PRO</span>
        <h2>{highlighted ? highlighted.title : "Préparez vos sorties comme un pro"}</h2>
        <p className="upgrade-pitch">
          {highlighted ? highlighted.pitch : "Toutes les fonctions qui font gagner du temps avant chaque sortie."}
        </p>

        <ul className="upgrade-list">
          {(Object.keys(PRO_FEATURES) as ProFeature[]).map((k) => (
            <li key={k} className={k === feature ? "on" : ""}>
              <Check size={15} />
              <span>
                <b>{PRO_FEATURES[k].title}</b>
                <small>{PRO_FEATURES[k].pitch}</small>
              </span>
            </li>
          ))}
        </ul>

        <div className="periods">
          <button className={period === "yearly" ? "active" : ""} onClick={() => setPeriod("yearly")}>
            <span>Annuel</span>
            <b>{PRICES.yearly}</b>
            <small>par an · soit 2,08 €/mois</small>
            <i>-48 %</i>
          </button>
          <button className={period === "monthly" ? "active" : ""} onClick={() => setPeriod("monthly")}>
            <span>Mensuel</span>
            <b>{PRICES.monthly}</b>
            <small>par mois, sans engagement</small>
          </button>
        </div>

        {!trialUsed && (
          <button
            className="primary"
            onClick={() => {
              onStartTrial();
              onClose();
            }}
          >
            <Sparkles size={17} /> Essayer {TRIAL_DAYS} jours gratuitement
          </button>
        )}
        <button
          className={trialUsed ? "primary" : "secondary wide"}
          onClick={() => {
            if (!onCheckout(period)) setNotice("Le paiement en ligne ouvre très bientôt. Merci de votre patience !");
          }}
        >
          S'abonner · {period === "yearly" ? `${PRICES.yearly}/an` : `${PRICES.monthly}/mois`}
        </button>
        {notice && <p className="muted small center">{notice}</p>}
        <p className="muted small center">
          Sans carte bancaire pour l'essai · résiliable à tout moment · offre fondateur à {PRICES.founder}/an pour les 500 premiers
        </p>
      </div>
    </div>
  );
}
