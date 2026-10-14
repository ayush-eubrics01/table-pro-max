import { useEffect, useId, useRef, type ReactNode } from "react";
import { Icon } from "./Icon";

interface DialogProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  className?: string;
  /** Element to focus initially; defaults to the first focusable control. */
  initialFocus?: string;
  subtitle?: ReactNode;
  /** "danger" marks destructive confirmations: warning icon and danger border. */
  tone?: "danger";
}

// Open dialogs, innermost last: only the top one reacts to Escape.
const stack: symbol[] = [];
// A focus restore scheduled by a closing dialog; cancelled if another dialog opens first.
let pendingRestore: ReturnType<typeof setTimeout> | undefined;

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Dialog({ title, onClose, children, footer, wide, className, initialFocus, subtitle, tone }: DialogProps) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const id = Symbol("dialog");
    stack.push(id);
    clearTimeout(pendingRestore);
    const previous = document.activeElement as HTMLElement | null;
    const node = ref.current;
    const target = (initialFocus && node?.querySelector<HTMLElement>(initialFocus)) || node?.querySelector<HTMLElement>(".dialog-body " + FOCUSABLE);
    target?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (stack[stack.length - 1] !== id) return;
      if (e.key === "Escape") {
        e.stopPropagation();
        e.preventDefault();
        onCloseRef.current();
      } else if (e.key === "Tab" && node) {
        // Keep focus inside the dialog.
        const items = Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE));
        if (items.length === 0) return;
        const first = items[0]!;
        const last = items[items.length - 1]!;
        if (!node.contains(document.activeElement)) {
          e.preventDefault();
          first.focus();
        } else if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      stack.splice(stack.indexOf(id), 1);
      // Restore focus after the current key event finishes, so it cannot re-trigger the opener.
      pendingRestore = setTimeout(() => previous?.focus?.(), 0);
    };
  }, [initialFocus]);

  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={ref}
        className={`dialog ${wide ? "dialog-wide" : ""} ${tone === "danger" ? "dialog-danger" : ""} ${className ?? ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className="dialog-header">
          {tone === "danger" && <Icon name="warning" size={18} className="dialog-tone-icon" />}
          <div className="dialog-titles">
            <h2 id={titleId}>{title}</h2>
            {subtitle && <div className="dialog-subtitle">{subtitle}</div>}
          </div>
          <button className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Close">
            <Icon name="close" size={16} />
          </button>
        </div>
        <div className="dialog-body">{children}</div>
        {footer && <div className="dialog-footer">{footer}</div>}
      </div>
    </div>
  );
}
