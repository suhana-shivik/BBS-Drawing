// Popovers and menus — one open at a time; Escape, outside click or window
// blur closes (STUDIO_DESIGN §5).

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './icons';

let closeCurrent: (() => void) | null = null;

export interface PopoverProps {
  anchor: HTMLElement;
  onClose: () => void;
  align?: 'left' | 'right';
  above?: boolean;
  children: React.ReactNode;
}

export function Popover({ anchor, onClose, align = 'left', above = false, children }: PopoverProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: -9999, top: -9999 });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const a = anchor.getBoundingClientRect();
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    let left = align === 'right' ? a.right - w : a.left;
    left = Math.max(6, Math.min(left, window.innerWidth - w - 6));
    let top = above ? a.top - h - 5 : a.bottom + 5;
    if (top + h > window.innerHeight - 6) top = a.top - h - 5;
    setPos({ left: Math.round(left), top: Math.round(Math.max(6, top)) });
  }, [anchor, align, above]);

  useEffect(() => {
    if (closeCurrent && closeCurrent !== onClose) closeCurrent();
    closeCurrent = onClose;
    const onPointer = (e: PointerEvent) => {
      const el = ref.current;
      if (el && !el.contains(e.target as Node) && !anchor.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    const onBlur = () => onClose();
    document.addEventListener('pointerdown', onPointer, true);
    document.addEventListener('keydown', onKey);
    window.addEventListener('blur', onBlur);
    return () => {
      if (closeCurrent === onClose) closeCurrent = null;
      document.removeEventListener('pointerdown', onPointer, true);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('blur', onBlur);
    };
  }, [anchor, onClose]);

  return createPortal(
    <div ref={ref} className="pop" role="menu" style={{ left: pos.left, top: pos.top }}>
      {children}
    </div>,
    document.body,
  );
}

export type MenuEntry =
  | { kind: 'title'; label: string }
  | { kind: 'note'; label: string }
  | { kind: 'divider' }
  | {
      kind?: 'item';
      label: string;
      hint?: string;
      icon?: string;
      checked?: boolean;
      disabled?: boolean;
      danger?: boolean;
      keepOpen?: boolean;
      /** native tooltip — a disabled item explains itself honestly */
      title?: string;
      onSelect?: () => void;
    };

export function Menu({
  anchor,
  onClose,
  items,
  align,
  above,
}: {
  anchor: HTMLElement;
  onClose: () => void;
  items: MenuEntry[];
  align?: 'left' | 'right';
  above?: boolean;
}) {
  return (
    <Popover anchor={anchor} onClose={onClose} align={align} above={above}>
      {items.map((it, i) => {
        if (it.kind === 'divider') return <div key={i} className="pop-div" />;
        if (it.kind === 'title') return <div key={i} className="pop-title">{it.label}</div>;
        if (it.kind === 'note') return <div key={i} className="pop-note">{it.label}</div>;
        return (
          <button
            key={i}
            type="button"
            className={`pop-item${it.danger ? ' danger' : ''}`}
            role="menuitem"
            disabled={it.disabled}
            title={it.title}
            aria-checked={it.checked !== undefined ? it.checked : undefined}
            onClick={() => {
              if (!it.keepOpen) onClose();
              it.onSelect?.();
            }}
          >
            <span className="tick">
              {it.checked !== undefined ? <Icon name="check" size={13} /> : it.icon ? <Icon name={it.icon} size={13} /> : null}
            </span>
            <span className="lbl">{it.label}</span>
            {it.hint ? <span className="hint">{it.hint}</span> : null}
          </button>
        );
      })}
    </Popover>
  );
}

/** Anchor-state helper: `const m = useMenuAnchor();` then `m.toggle(e)` on the trigger. */
export function useMenuAnchor() {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  return {
    anchor,
    open: anchor !== null,
    toggle: (e: React.MouseEvent<HTMLElement>) => {
      // Read `currentTarget` HERE, not inside the updater. React nulls it as
      // soon as the handler returns, and an updater only runs early enough to
      // see it while the component has no other update pending (React's eager
      // state bail-out). So the menu opened on a quiet component and silently
      // did nothing on a busy one — `cur === null` and a nulled currentTarget
      // compare equal, and the toggle read that as "close me".
      const el = e.currentTarget;
      setAnchor((cur) => (cur === el ? null : el));
    },
    close: () => setAnchor(null),
  };
}
