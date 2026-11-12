import { useEffect, useId, useRef, type ReactNode } from "react";
import { X } from "lucide-react";

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

/** Diálogo modal acessível: foco preso, Esc fecha, devolve o foco ao gatilho (guia visual §6.8). */
export function Modal({
  title,
  description,
  size = "sm",
  onClose,
  children,
}: {
  title: string;
  description?: string;
  /** Larguras do guia visual §6.8: sm 440 · md 600. */
  size?: "sm" | "md";
  onClose: () => void;
  children: ReactNode;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const dialog = dialogRef.current;
    const first = dialog?.querySelector<HTMLElement>("input, textarea") ?? dialog?.querySelector<HTMLElement>(FOCUSABLE);
    first?.focus();

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab" || !dialog) return;
      const items = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (items.length === 0) return;
      const firstItem = items[0]!;
      const lastItem = items[items.length - 1]!;
      if (event.shiftKey && document.activeElement === firstItem) {
        event.preventDefault();
        lastItem.focus();
      } else if (!event.shiftKey && document.activeElement === lastItem) {
        event.preventDefault();
        firstItem.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      previous?.focus();
    };
  }, [onClose]);

  return (
    <div className="modal-layer">
      <div className="scrim" aria-hidden="true" onClick={onClose} />
      <div
        ref={dialogRef}
        className={size === "md" ? "modal modal--md" : "modal"}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
      >
        <header className="modal__header">
          <h2 id={titleId} className="modal__title">
            {title}
          </h2>
          <button type="button" className="icon-button" aria-label="Fechar" onClick={onClose}>
            <X size={20} strokeWidth={1.75} aria-hidden />
          </button>
        </header>
        {description && (
          <p id={descriptionId} className="modal__description">
            {description}
          </p>
        )}
        {children}
      </div>
    </div>
  );
}
