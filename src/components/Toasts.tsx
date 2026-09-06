// Toasts — every action reports in the past tense, naming what it produced.

import React, { useEffect, useState } from 'react';
import { Icon } from './icons';

export interface Toast {
  id: number;
  message: string;
  kind?: 'ok' | 'warn';
}

type Listener = (toasts: Toast[]) => void;

let toasts: Toast[] = [];
let nextId = 1;
const listeners = new Set<Listener>();

export function toast(message: string, kind?: 'ok' | 'warn'): void {
  const t: Toast = { id: nextId++, message, kind };
  toasts = [...toasts, t].slice(-3);
  listeners.forEach((fn) => fn(toasts));
  setTimeout(() => {
    toasts = toasts.filter((x) => x !== t);
    listeners.forEach((fn) => fn(toasts));
  }, 3600);
}

export function Toasts() {
  const [list, setList] = useState<Toast[]>(toasts);
  useEffect(() => {
    const fn: Listener = (t) => setList(t);
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  }, []);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {list.map((t) => (
        <div key={t.id} className={`toast${t.kind ? ` ${t.kind}` : ''}`}>
          <span className="ic">
            <Icon name={t.kind === 'warn' ? 'warning' : t.kind === 'ok' ? 'check' : 'sparkles'} size={14} />
          </span>
          <span>{t.message}</span>
        </div>
      ))}
    </div>
  );
}
