import { useEffect, useId, useState, type FormEvent } from "react";
import { Check, ListChecks, Plus, Trash } from "lucide-react";
import { LIMITS, type Id, type Message, type PollCreate, type User } from "@aurora/schema";
import { durationLabel, pollTimeText, pollView } from "../poll";
import { Modal } from "./Modal";
import { SelectField, SwitchRow } from "./settings/controls";
import { ICON_SM } from "./shell";

/** Criar enquete (menu "+" do campo de mensagem). */
export function CreatePollDialog({ onSubmit, onClose }: { onSubmit: (poll: PollCreate) => Promise<void>; onClose: () => void }) {
  const [question, setQuestion] = useState("");
  const [answers, setAnswers] = useState(["", ""]);
  const [hours, setHours] = useState(24);
  const [multi, setMulti] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const questionId = useId();
  const filled = answers.map((a) => a.trim()).filter(Boolean);
  const ready = question.trim().length > 0 && filled.length >= LIMITS.pollAnswersMin;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit({ question: question.trim(), answers: filled.map((text) => ({ text })), durationHours: hours, allowMultiselect: multi });
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Não foi possível criar a enquete. Tente de novo.");
      setBusy(false);
    }
  };

  return (
    <Modal title="Criar enquete" description="Todo mundo que vê o canal pode votar." size="md" onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <div className="field">
          <label className="field__label" htmlFor={questionId}>
            Pergunta
          </label>
          <input id={questionId} className="input" value={question} maxLength={LIMITS.pollQuestionMax} placeholder="O que vocês querem jogar hoje?" onChange={(e) => setQuestion(e.target.value)} required />
        </div>
        <fieldset className="poll-form__answers">
          <legend className="field__label">Respostas</legend>
          {answers.map((value, index) => (
            <div key={index} className="poll-form__answer">
              <input
                className="input"
                value={value}
                maxLength={LIMITS.pollAnswerMax}
                placeholder={`Resposta ${index + 1}`}
                aria-label={`Resposta ${index + 1}`}
                onChange={(e) => setAnswers((list) => list.map((a, i) => (i === index ? e.target.value : a)))}
              />
              {answers.length > LIMITS.pollAnswersMin && (
                <button type="button" className="icon-button" aria-label={`Tirar a resposta ${index + 1}`} title="Tirar a resposta" onClick={() => setAnswers((list) => list.filter((_, i) => i !== index))}>
                  <Trash {...ICON_SM} />
                </button>
              )}
            </div>
          ))}
          {answers.length < LIMITS.pollAnswersMax && (
            <button type="button" className="button button--secondary button--small poll-form__add" onClick={() => setAnswers((list) => [...list, ""])}>
              <Plus {...ICON_SM} />
              Adicionar resposta
            </button>
          )}
        </fieldset>
        <SelectField label="Duração" value={String(hours)} options={LIMITS.pollDurationsHours.map((h) => ({ value: String(h), label: durationLabel(h) }))} onChange={(v) => setHours(Number(v))} />
        <SwitchRow label="Permitir mais de uma resposta" hint="Cada pessoa pode marcar várias respostas." checked={multi} onChange={setMulti} />
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="modal__actions">
          <button type="button" className="button button--secondary" onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" className="button button--primary" disabled={busy || !ready}>
            {busy ? "Publicando…" : "Publicar enquete"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** Relógio que anda sozinho enquanto a enquete está aberta (para acabar na hora sem esperar o servidor). */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

/** Enquete dentro da mensagem: votar, ver resultado, ver quem votou e encerrar antes. */
export function PollCard({
  message,
  me,
  canVote,
  canEnd,
  usersById,
  onVote,
  onEnd,
}: {
  message: Message & { poll: NonNullable<Message["poll"]> };
  me: User;
  canVote: boolean;
  canEnd: boolean;
  usersById: Readonly<Record<Id, User>>;
  onVote: (answerId: number, add: boolean) => Promise<void>;
  onEnd: () => Promise<void>;
}) {
  const poll = message.poll;
  const now = useNow(poll.endedAt === null);
  const view = pollView(poll, me.id, now);
  const [showVoters, setShowVoters] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const open = !view.ended;
  const act = async (task: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await task();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Não deu certo. Tente de novo.");
    } finally {
      setBusy(false);
    }
  };
  const winners = view.answers.filter((a) => a.winner).map((a) => a.text);
  const nameOf = (id: Id) => usersById[id]?.displayName ?? "Alguém que saiu";

  return (
    <section className="poll" aria-label={`Enquete: ${poll.question}`}>
      <header className="poll__header">
        <ListChecks {...ICON_SM} className="poll__icon" />
        <div>
          <h3 className="poll__question">{poll.question}</h3>
          <p className="poll__hint">{open ? (poll.allowMultiselect ? "Escolha uma ou mais respostas" : "Escolha uma resposta") : "Votação encerrada"}</p>
        </div>
      </header>
      <ul className="poll__answers" role={poll.allowMultiselect ? "group" : "radiogroup"} aria-label="Respostas">
        {view.answers.map((answer) => (
          <li key={answer.id}>
            <button
              type="button"
              role={poll.allowMultiselect ? "checkbox" : "radio"}
              aria-checked={answer.mine}
              className={["poll__answer", answer.mine ? "poll__answer--mine" : "", answer.winner ? "poll__answer--winner" : ""].filter(Boolean).join(" ")}
              disabled={!open || !canVote || busy}
              onClick={() => void act(() => onVote(answer.id, !answer.mine))}
            >
              {view.showResults && <span className="poll__bar" style={{ inlineSize: `${answer.percent}%` }} aria-hidden="true" />}
              <span className="poll__mark" aria-hidden="true">
                {answer.mine && <Check {...ICON_SM} />}
              </span>
              <span className="poll__text">
                {answer.emoji ? `${answer.emoji} ` : ""}
                {answer.text}
              </span>
              {view.showResults && (
                <span className="poll__count">
                  {answer.count} · {answer.percent}%
                </span>
              )}
            </button>
            {showVoters && answer.count > 0 && <p className="poll__voters">{answer.voterIds.map(nameOf).join(", ")}</p>}
          </li>
        ))}
      </ul>
      <footer className="poll__footer">
        <span>
          {view.voters === 1 ? "1 voto" : `${view.voters} votos`} · {pollTimeText(poll, now)}
          {view.ended && winners.length > 0 && ` · ${winners.length === 1 ? `Vencedora: ${winners[0]}` : `Empate: ${winners.join(", ")}`}`}
        </span>
        <span className="poll__actions">
          {view.showResults && view.voters > 0 && (
            <button type="button" className="link-button" aria-expanded={showVoters} onClick={() => setShowVoters((v) => !v)}>
              {showVoters ? "Esconder votos" : "Ver votos"}
            </button>
          )}
          {open && canEnd && (
            <button type="button" className="link-button" disabled={busy} onClick={() => void act(onEnd)}>
              Encerrar agora
            </button>
          )}
        </span>
      </footer>
      {!canVote && open && <p className="poll__hint">Você não tem permissão para votar neste canal.</p>}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
