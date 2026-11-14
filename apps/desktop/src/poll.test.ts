import { describe, expect, it } from "vitest";
import type { Message, Poll } from "@aurora/schema";
import { durationLabel, isPollEnded, pollTimeText, pollView, withPollVote } from "./poll";

const NOW = 1_000_000_000_000;
const make = (votes: string[][], extra: Partial<Poll> = {}): Poll => ({
  question: "Qual mapa?",
  answers: votes.map((voterIds, i) => ({ id: i + 1, text: `R${i + 1}`, emoji: null, voterIds })),
  allowMultiselect: false,
  expiresAt: NOW + 3 * 3_600_000,
  endedAt: null,
  ...extra,
});

describe("enquetes no app", () => {
  it("porcentagem sobre o total de votos; resultado só para quem votou ou depois do fim", () => {
    const view = pollView(make([["a", "b"], ["c"], []]), "z", NOW);
    expect(view.answers.map((a) => [a.count, a.percent])).toEqual([[2, 67], [1, 33], [0, 0]]);
    expect(view).toMatchObject({ voters: 3, votedByMe: false, ended: false, showResults: false });
    expect(pollView(make([["a"], ["z"]]), "z", NOW)).toMatchObject({ votedByMe: true, showResults: true });
    expect(pollView(make([[], []]), "z", NOW).answers.map((a) => a.percent)).toEqual([0, 0]); // sem votos: sem dividir por zero
  });

  it("vencedora só no fim; empate marca todas as mais votadas; sem votos, nenhuma", () => {
    expect(pollView(make([["a", "b"], ["c"]]), "z", NOW).answers.some((a) => a.winner)).toBe(false);
    const ended = pollView(make([["a"], ["b"], []], { endedAt: NOW }), "z", NOW);
    expect(ended.answers.map((a) => a.winner)).toEqual([true, true, false]);
    expect(pollView(make([[], []], { endedAt: NOW }), "z", NOW).answers.some((a) => a.winner)).toBe(false);
  });

  it("acaba pelo relógio do app, sem esperar o servidor", () => {
    const poll = make([[]], { expiresAt: NOW + 1000 });
    expect(isPollEnded(poll, NOW)).toBe(false);
    expect(isPollEnded(poll, NOW + 1000)).toBe(true);
    expect(pollTimeText(make([[]], { expiresAt: NOW + 25 * 60_000 }), NOW)).toBe("termina em 25 min");
    expect(pollTimeText(make([[]]), NOW)).toBe("termina em 3 h");
    expect(pollTimeText(make([[]], { expiresAt: NOW + 72 * 3_600_000 }), NOW)).toBe("termina em 3 dias");
    expect(pollTimeText(make([[]], { endedAt: NOW - 1 }), NOW)).toBe("Encerrada");
  });

  it("voto ao vivo: soma, tira e ignora repetido", () => {
    const message = { id: "1", poll: make([["a"], []]) } as Message;
    const added = withPollVote(message, 2, "b", true);
    expect(added.poll!.answers[1]!.voterIds).toEqual(["b"]);
    expect(withPollVote(added, 2, "b", true)).toBe(added); // repetido: mesma referência (sem redesenhar)
    expect(withPollVote(added, 1, "a", false).poll!.answers[0]!.voterIds).toEqual([]);
    const plain = { id: "2" } as Message;
    expect(withPollVote(plain, 1, "a", true)).toBe(plain);
  });

  it("nomes das durações", () => {
    expect([1, 4, 8, 24, 72, 168].map(durationLabel)).toEqual(["1 hora", "4 horas", "8 horas", "24 horas", "3 dias", "1 semana"]);
  });
});
