import type { Id, Message, Poll } from "@aurora/schema";

/** Acabou: encerrada antes ou passou do prazo (o relógio do app decide sem esperar o servidor). */
export const isPollEnded = (poll: Poll, now: number): boolean => poll.endedAt !== null || poll.expiresAt <= now;

export interface PollAnswerView {
  id: number;
  text: string;
  emoji: string | null;
  count: number;
  /** 0 a 100, em relação ao total de votos (soma das respostas). */
  percent: number;
  mine: boolean;
  /** Mais votada numa enquete encerrada (empate: todas as mais votadas). */
  winner: boolean;
  voterIds: Id[];
}

export interface PollView {
  answers: PollAnswerView[];
  /** Pessoas diferentes que votaram. */
  voters: number;
  votedByMe: boolean;
  ended: boolean;
  /** Resultado aparece para quem já votou ou depois que acabou. */
  showResults: boolean;
}

export function pollView(poll: Poll, meId: Id, now: number): PollView {
  const ended = isPollEnded(poll, now);
  const totalVotes = poll.answers.reduce((sum, a) => sum + a.voterIds.length, 0);
  const top = Math.max(0, ...poll.answers.map((a) => a.voterIds.length));
  const answers = poll.answers.map((a) => ({
    id: a.id,
    text: a.text,
    emoji: a.emoji,
    count: a.voterIds.length,
    percent: totalVotes === 0 ? 0 : Math.round((a.voterIds.length / totalVotes) * 100),
    mine: a.voterIds.includes(meId),
    winner: ended && top > 0 && a.voterIds.length === top,
    voterIds: a.voterIds,
  }));
  const votedByMe = answers.some((a) => a.mine);
  const voters = new Set(poll.answers.flatMap((a) => a.voterIds)).size;
  return { answers, voters, votedByMe, ended, showResults: votedByMe || ended };
}

/** "Encerrada", "termina em 3 h", "termina em 25 min", "termina em 2 dias". */
export function pollTimeText(poll: Poll, now: number): string {
  if (isPollEnded(poll, now)) return "Encerrada";
  const minutes = Math.max(1, Math.ceil((poll.expiresAt - now) / 60_000));
  if (minutes < 60) return `termina em ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `termina em ${hours} h`;
  return `termina em ${Math.round(hours / 24)} dias`;
}

/** Voto ao vivo (evento do gateway) aplicado à mensagem; sem enquete ou repetido, devolve a mesma. */
export function withPollVote(message: Message, answerId: number, userId: Id, add: boolean): Message {
  const poll = message.poll;
  if (!poll) return message;
  let changed = false;
  const answers = poll.answers.map((a) => {
    if (a.id !== answerId) return a;
    const has = a.voterIds.includes(userId);
    if (add === has) return a;
    changed = true;
    return { ...a, voterIds: add ? [...a.voterIds, userId] : a.voterIds.filter((id) => id !== userId) };
  });
  return changed ? { ...message, poll: { ...poll, answers } } : message;
}

/** Rótulos das durações (as horas vêm de LIMITS.pollDurationsHours). */
export const durationLabel = (hours: number): string =>
  hours === 1 ? "1 hora" : hours < 24 ? `${hours} horas` : hours === 24 ? "24 horas" : hours === 168 ? "1 semana" : `${hours / 24} dias`;
