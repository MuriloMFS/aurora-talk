import { LIMITS } from "@aurora/schema";

/** "820 KB", "3,4 MB" — tamanho para gente ler. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  const mb = kb / 1024;
  return `${mb.toLocaleString("pt-BR", { maximumFractionDigits: mb < 10 ? 1 : 0 })} MB`;
}

export const isImageType = (contentType: string) => contentType.startsWith("image/");

const MAX_MB = LIMITS.attachmentMaxBytes / (1024 * 1024);

/**
 * Quais dos arquivos escolhidos entram na fila (respeitando o máximo por mensagem) e por que algum
 * ficou de fora. Arquivo grande demais entra na fila já com erro, para a pessoa ver qual foi.
 */
export function admitFiles<T extends { size: number }>(queued: number, files: readonly T[]): { accepted: { file: T; error: string | null }[]; overflow: string | null } {
  const room = Math.max(0, LIMITS.attachmentsPerMessage - queued);
  const accepted = files.slice(0, room).map((file) => ({
    file,
    error: file.size > LIMITS.attachmentMaxBytes ? `Passa de ${MAX_MB} MB` : file.size === 0 ? "Arquivo vazio" : null,
  }));
  const overflow = files.length > room ? `Dá para enviar até ${LIMITS.attachmentsPerMessage} arquivos por mensagem. ${files.length - room === 1 ? "Um ficou" : `${files.length - room} ficaram`} de fora.` : null;
  return { accepted, overflow };
}
