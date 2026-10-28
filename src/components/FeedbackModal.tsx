import { useState } from "react";
import { Bug, Check, HelpCircle, Lightbulb, MessageSquare, Star, X } from "lucide-react";
import { sendFeedback } from "../lib/report";

const CATEGORIES = [
  { id: "Bug", label: "Un bug", icon: Bug },
  { id: "Idée", label: "Une idée", icon: Lightbulb },
  { id: "Question", label: "Une question", icon: HelpCircle },
  { id: "Autre", label: "Autre chose", icon: MessageSquare },
] as const;

interface Props {
  /** Link to the route being edited, offered as an attachment. */
  routeLink: string | null;
  onClose: () => void;
}

export default function FeedbackModal({ routeLink, onClose }: Props) {
  const [category, setCategory] = useState<string>("Idée");
  const [rating, setRating] = useState(0);
  const [message, setMessage] = useState("");
  const [email, setEmail] = useState("");
  const [attach, setAttach] = useState(true);
  const [state, setState] = useState<"idle" | "sending" | "sent">("idle");
  const [error, setError] = useState<string | null>(null);
  const emailOk = !email.trim() || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  const canSend = message.trim().length >= 3 && emailOk && state === "idle";

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSend) return;
    setState("sending");
    setError(null);
    const err = await sendFeedback({
      category,
      message: message.trim(),
      rating: rating || undefined,
      email: email.trim() || undefined,
      routeLink: attach && routeLink ? routeLink : undefined,
    });
    if (err) {
      setError(err);
      setState("idle");
    } else setState("sent");
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal panel feedback" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="fb-title">
        <header>
          <h2 id="fb-title">Donner mon avis</h2>
          <button className="icon-btn ghost" onClick={onClose} title="Fermer">
            <X size={16} />
          </button>
        </header>
        {state === "sent" ? (
          <div className="feedback-done">
            <span className="feedback-check">
              <Check size={22} />
            </span>
            <b>Merci, c'est bien reçu !</b>
            <p className="muted">Chaque message est lu. {email.trim() ? "Nous vous répondrons par e-mail si besoin." : ""}</p>
            <button className="primary" onClick={onClose}>
              Fermer
            </button>
          </div>
        ) : (
          <form onSubmit={submit}>
            <div className="fb-cats">
              {CATEGORIES.map(({ id, label, icon: Icon }) => (
                <button type="button" key={id} className={category === id ? "active" : ""} onClick={() => setCategory(id)}>
                  <Icon size={16} />
                  {label}
                </button>
              ))}
            </div>
            <label className="fb-label" htmlFor="fb-msg">
              {category === "Bug" ? "Que s'est-il passé ? Qu'attendiez-vous ?" : category === "Idée" ? "Quelle fonctionnalité vous manque ?" : "Votre message"}
            </label>
            <textarea
              id="fb-msg"
              className="field"
              rows={5}
              maxLength={3000}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder={category === "Bug" ? "Ex. : en cliquant sur Exporter sur mon téléphone, rien ne se passe…" : "Écrivez librement…"}
              autoFocus
            />
            <div className="fb-rating">
              <span>Votre note de l'app</span>
              <div role="radiogroup" aria-label="Note sur 5">
                {[1, 2, 3, 4, 5].map((n) => (
                  <button
                    type="button"
                    key={n}
                    role="radio"
                    aria-checked={rating === n}
                    title={`${n} sur 5`}
                    className={n <= rating ? "on" : ""}
                    onClick={() => setRating(rating === n ? 0 : n)}
                  >
                    <Star size={20} />
                  </button>
                ))}
              </div>
            </div>
            <input
              className={`field ${emailOk ? "" : "invalid"}`}
              type="email"
              placeholder="Votre e-mail (facultatif, pour une réponse)"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
            />
            {routeLink && (
              <label className="check">
                <input type="checkbox" checked={attach} onChange={(e) => setAttach(e.target.checked)} />
                <span>Joindre le parcours affiché (aide à comprendre un problème)</span>
              </label>
            )}
            {error && <div className="alert">{error}</div>}
            <button className="primary" type="submit" disabled={!canSend}>
              {state === "sending" ? <span className="spinner" /> : null}
              Envoyer
            </button>
            <p className="muted small">Votre message, le type d'appareil et les dernières actions dans l'app sont envoyés au développeur, rien d'autre.</p>
          </form>
        )}
      </div>
    </div>
  );
}
