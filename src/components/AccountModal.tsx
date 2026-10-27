import { useState } from "react";
import { CloudUpload, LogOut, Mail, Settings, Trash2, X } from "lucide-react";
import { googleEnabled, type Account } from "../lib/account";
import { TRIAL_DAYS, type Plan } from "../lib/plan";

interface Props {
  account: Account;
  plan: Plan;
  /** Why the window opened (e.g. to start the trial), shown above the form. */
  reason: string | null;
  onUpgrade: () => void;
  onClose: () => void;
}

const fmt = (d: Date) => d.toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" });

export default function AccountModal({ account, plan, reason, onUpgrade, onClose }: Props) {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const user = account.user;

  const run = async (fn: () => Promise<string | null>) => {
    setBusy(true);
    setError(null);
    const err = await fn();
    setBusy(false);
    if (err) setError(err);
    return !err;
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal panel account" onClick={(e) => e.stopPropagation()}>
        <button className="icon-btn ghost close" onClick={onClose} aria-label="Fermer">
          <X size={16} />
        </button>

        {!user ? (
          sent ? (
            <div className="sent">
              <Mail size={34} />
              <h2>Vérifiez votre boîte mail</h2>
              <p className="muted">
                Un lien de connexion a été envoyé à <b>{email}</b>. Cliquez dessus pour revenir ici, connecté.
              </p>
              <button className="link" onClick={() => setSent(false)}>
                Utiliser une autre adresse
              </button>
            </div>
          ) : (
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                if (await run(() => account.sendMagicLink(email.trim()))) setSent(true);
              }}
            >
              <h2>Votre compte</h2>
              {reason && <p className="reason">{reason}</p>}
              <ul className="perks">
                <li>
                  <CloudUpload size={15} /> Vos parcours sauvegardés et retrouvés sur tous vos appareils
                </li>
                <li>
                  <Settings size={15} /> Essai Pro de {TRIAL_DAYS} jours, puis abonnement si vous le souhaitez
                </li>
              </ul>
              {googleEnabled && (
                <>
                  <button type="button" className="secondary wide" onClick={account.signInWithGoogle}>
                    <span className="g">G</span> Continuer avec Google
                  </button>
                  <div className="or">ou</div>
                </>
              )}
              <input
                className="field"
                type="email"
                required
                autoFocus
                placeholder="vous@exemple.fr"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
              <button className="primary" type="submit" disabled={busy}>
                {busy ? <span className="spinner" /> : <Mail size={17} />} Recevoir un lien de connexion
              </button>
              <p className="muted small center">Pas de mot de passe : un lien sécurisé arrive par e-mail.</p>
            </form>
          )
        ) : (
          <>
            <h2>Mon compte</h2>
            <p className="muted">{user.email}</p>

            <div className={`plan-card ${plan.isPro ? "pro" : ""}`}>
              {plan.paid ? (
                <>
                  <span className="pro-pill big">PRO</span>
                  <b>Abonnement {plan.period === "monthly" ? "mensuel" : "annuel"}</b>
                  {plan.renewsAt && (
                    <span className="muted small">
                      {plan.cancelsAtPeriodEnd ? "Se termine le " : "Renouvellement le "}
                      {fmt(plan.renewsAt)}
                    </span>
                  )}
                </>
              ) : plan.onTrial ? (
                <>
                  <span className="pro-pill big">ESSAI</span>
                  <b>Essai Pro : encore {plan.trialDaysLeft} jour{plan.trialDaysLeft > 1 ? "s" : ""}</b>
                  <button className="primary" onClick={onUpgrade}>
                    S'abonner pour garder Pro
                  </button>
                </>
              ) : plan.syncing ? (
                <b>
                  <span className="spinner" /> Activation de votre abonnement…
                </b>
              ) : (
                <>
                  <b>Offre gratuite</b>
                  <button className="primary" onClick={onUpgrade}>
                    Passer Pro
                  </button>
                </>
              )}
            </div>

            {(plan.paid || plan.cancelsAtPeriodEnd) && (
              <button className="secondary wide" disabled={busy} onClick={() => run(plan.manage)}>
                <Settings size={16} /> Gérer mon abonnement et mes factures
              </button>
            )}
            <button className="secondary wide" onClick={() => account.signOut().then(onClose)}>
              <LogOut size={16} /> Se déconnecter
            </button>
            <button
              className="link danger"
              disabled={busy}
              onClick={async () => {
                if (!window.confirm("Supprimer définitivement votre compte, vos parcours et votre abonnement ?")) return;
                if (await run(account.deleteAccount)) onClose();
              }}
            >
              <Trash2 size={13} /> Supprimer mon compte
            </button>
          </>
        )}
        {error && <p className="form-error">{error}</p>}
      </div>
    </div>
  );
}
