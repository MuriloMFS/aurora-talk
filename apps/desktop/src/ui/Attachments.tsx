import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Download, ExternalLink, FileText, X } from "lucide-react";
import type { Attachment } from "@aurora/schema";
import { mediaUrl } from "../avatar-image";
import { admitFiles, formatBytes, isImageType } from "../attachments";
import { ICON, ICON_SM } from "./shell";

/* ---------------- na mensagem ---------------- */

/** Imagens em grade (com o espaço reservado antes de carregar) e arquivos como cartão de download. */
export function MessageAttachments({ attachments, onOpenLink }: { attachments: Attachment[]; onOpenLink: (url: string) => void }) {
  const [viewing, setViewing] = useState<number | null>(null);
  const images = attachments.filter((a) => isImageType(a.contentType) && a.url);
  const others = attachments.filter((a) => !isImageType(a.contentType) && a.url);
  if (images.length === 0 && others.length === 0) return null;
  return (
    <div className="attachments">
      {images.length > 0 && (
        <div className={images.length === 1 ? "attachment-grid attachment-grid--single" : "attachment-grid"}>
          {images.map((image, index) => (
            <button key={image.id} type="button" className="attachment-image" aria-label={`Abrir imagem ${image.filename}`} onClick={() => setViewing(index)}>
              <img
                src={mediaUrl(image.url)}
                alt={image.filename}
                loading="lazy"
                draggable={false}
                width={image.width ?? undefined}
                height={image.height ?? undefined}
                style={images.length === 1 && image.width && image.height ? { aspectRatio: `${image.width} / ${image.height}` } : undefined}
              />
            </button>
          ))}
        </div>
      )}
      {others.map((file) => (
        <div key={file.id} className="file-card">
          <FileText {...ICON} />
          <div className="file-card__text">
            <button type="button" className="file-card__name" title={file.filename} onClick={() => onOpenLink(mediaUrl(file.url))}>
              {file.filename}
            </button>
            <span className="file-card__size">{formatBytes(file.size)}</span>
          </div>
          <button type="button" className="icon-button" aria-label={`Baixar ${file.filename}`} title="Baixar" onClick={() => onOpenLink(mediaUrl(file.url))}>
            <Download {...ICON_SM} />
          </button>
        </div>
      ))}
      {viewing !== null && images[viewing] && (
        <Lightbox images={images} index={viewing} onIndex={setViewing} onClose={() => setViewing(null)} onOpenLink={onOpenLink} />
      )}
    </div>
  );
}

/** Imagem em tela cheia: Esc fecha, setas trocam, e dá para abrir no navegador (salvar). */
function Lightbox({
  images,
  index,
  onIndex,
  onClose,
  onOpenLink,
}: {
  images: Attachment[];
  index: number;
  onIndex: (index: number) => void;
  onClose: () => void;
  onOpenLink: (url: string) => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const image = images[index]!;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    return () => previous?.focus();
  }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      } else if (event.key === "ArrowRight" && index < images.length - 1) onIndex(index + 1);
      else if (event.key === "ArrowLeft" && index > 0) onIndex(index - 1);
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [index, images.length, onClose, onIndex]);

  return (
    <div className="lightbox" role="dialog" aria-modal="true" aria-label={image.filename}>
      <div className="lightbox__scrim" aria-hidden="true" onClick={onClose} />
      <div className="lightbox__bar">
        <span className="lightbox__name">
          {image.filename} · {formatBytes(image.size)}
          {images.length > 1 && ` · ${index + 1} de ${images.length}`}
        </span>
        <button type="button" className="icon-button" aria-label="Abrir no navegador (para salvar)" title="Abrir no navegador" onClick={() => onOpenLink(mediaUrl(image.url))}>
          <ExternalLink {...ICON} />
        </button>
        <button ref={closeRef} type="button" className="icon-button" aria-label="Fechar (Esc)" title="Fechar (Esc)" onClick={onClose}>
          <X {...ICON} />
        </button>
      </div>
      {index > 0 && (
        <button type="button" className="icon-button lightbox__nav lightbox__nav--prev" aria-label="Imagem anterior" onClick={() => onIndex(index - 1)}>
          <ChevronLeft {...ICON} />
        </button>
      )}
      <img className="lightbox__img" src={mediaUrl(image.url)} alt={image.filename} />
      {index < images.length - 1 && (
        <button type="button" className="icon-button lightbox__nav lightbox__nav--next" aria-label="Próxima imagem" onClick={() => onIndex(index + 1)}>
          <ChevronRight {...ICON} />
        </button>
      )}
    </div>
  );
}

/* ---------------- no compositor ---------------- */

export interface UploadItem {
  key: string;
  name: string;
  size: number;
  /** Prévia local (imagens), antes de chegar ao servidor. */
  previewUrl: string | null;
  progress: number;
  status: "uploading" | "done" | "error";
  error: string | null;
  attachmentId: string | null;
}

export type UploadFn = (file: File, meta: { filename: string; width?: number; height?: number }, onProgress: (fraction: number) => void) => Promise<Attachment>;

async function imageSize(file: File): Promise<{ width: number; height: number } | null> {
  if (!file.type.startsWith("image/")) return null;
  try {
    const bitmap = await createImageBitmap(file);
    const size = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return size;
  } catch {
    return null;
  }
}

/** Fila de envio: cada arquivo sobe assim que entra (com progresso); a mensagem só cita os ids. */
export function useUploads(upload: UploadFn) {
  const [items, setItems] = useState<UploadItem[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const patch = (key: string, change: Partial<UploadItem>) => setItems((list) => list.map((i) => (i.key === key ? { ...i, ...change } : i)));

  const add = useCallback(
    (files: File[]) => {
      if (files.length === 0) return;
      const { accepted, overflow } = admitFiles(itemsRef.current.length, files);
      setNotice(overflow);
      for (const { file, error } of accepted) {
        const key = crypto.randomUUID();
        const previewUrl = file.type.startsWith("image/") && !error ? URL.createObjectURL(file) : null;
        const name = file.name || (file.type.startsWith("image/") ? "imagem.png" : "arquivo");
        setItems((list) => [...list, { key, name, size: file.size, previewUrl, progress: 0, status: error ? "error" : "uploading", error, attachmentId: null }]);
        if (error) continue;
        void (async () => {
          try {
            const size = await imageSize(file);
            const attachment = await upload(file, { filename: name, ...(size ?? {}) }, (progress) => patch(key, { progress }));
            patch(key, { status: "done", progress: 1, attachmentId: attachment.id });
          } catch (caught) {
            patch(key, { status: "error", error: caught instanceof Error ? caught.message : "Não foi possível enviar." });
          }
        })();
      }
    },
    [upload],
  );

  const remove = useCallback((key: string) => {
    setItems((list) => {
      const item = list.find((i) => i.key === key);
      if (item?.previewUrl) URL.revokeObjectURL(item.previewUrl);
      return list.filter((i) => i.key !== key);
    });
    setNotice(null);
  }, []);

  const clear = useCallback(() => {
    for (const item of itemsRef.current) if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
    setItems([]);
    setNotice(null);
  }, []);

  useEffect(() => () => itemsRef.current.forEach((i) => i.previewUrl && URL.revokeObjectURL(i.previewUrl)), []);

  return {
    items,
    notice,
    add,
    remove,
    clear,
    uploading: items.some((i) => i.status === "uploading"),
    failed: items.some((i) => i.status === "error"),
    readyIds: items.filter((i) => i.status === "done" && i.attachmentId).map((i) => i.attachmentId!),
  };
}

export function UploadQueue({ items, notice, onRemove }: { items: UploadItem[]; notice: string | null; onRemove: (key: string) => void }) {
  if (items.length === 0 && !notice) return null;
  return (
    <div className="upload-queue">
      {notice && (
        <p className="upload-queue__notice" role="status">
          {notice}
        </p>
      )}
      {items.length > 0 && (
        <ul className="upload-queue__list" aria-label="Arquivos para enviar">
          {items.map((item) => (
            <li key={item.key} className={item.status === "error" ? "upload-item upload-item--error" : "upload-item"}>
              {item.previewUrl ? <img className="upload-item__thumb" src={item.previewUrl} alt="" /> : <FileText {...ICON} className="upload-item__icon" />}
              <span className="upload-item__name" title={item.name}>
                {item.name}
              </span>
              {item.status === "uploading" ? (
                <progress className="upload-item__progress" max={1} value={item.progress} aria-label={`Enviando ${item.name}`} />
              ) : (
                <span className={item.status === "error" ? "upload-item__meta upload-item__meta--error" : "upload-item__meta"} role={item.status === "error" ? "alert" : undefined}>
                  {item.status === "error" ? item.error : formatBytes(item.size)}
                </span>
              )}
              <button type="button" className="icon-button icon-button--small upload-item__remove" aria-label={`Tirar ${item.name}`} title="Tirar" onClick={() => onRemove(item.key)}>
                <X {...ICON_SM} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
