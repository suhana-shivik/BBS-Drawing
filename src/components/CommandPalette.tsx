// R6 — the command palette (Ctrl+K): one search, four kinds of hit, grouped by
// kind with the top hit selected (§6.2). Selecting any result NAVIGATES AND
// HIGHLIGHTS (§6.4) — a drawing opens, a section opens zoomed, a fact opens
// the Specification scrolled to it, a mark lights its handles in amber. The
// index is built by src/search over the register, the split packages, the
// ledger and the extractor's marks; realData rebuilds it cheaply on change.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { SearchHit } from '../search/types';
import { useStudioData } from '../studio/data';
import { useStudioStore } from '../studio/store';
import { Icon } from './icons';
import './CommandPalette.css';

const KIND_LABEL: Record<SearchHit['kind'], string> = {
  drawing: 'Drawings',
  section: 'Sections',
  fact: 'Facts',
  mark: 'Marks & callouts',
};

const KIND_ICON: Record<SearchHit['kind'], string> = {
  drawing: 'file',
  section: 'section',
  fact: 'schedule',
  mark: 'dimension',
};

function hitTitle(hit: SearchHit): string {
  switch (hit.kind) {
    case 'drawing':
      return hit.fileName || hit.drawingNumber || hit.snippet;
    case 'section':
      return `${hit.sectionId} · ${hit.label}`;
    case 'fact':
      return hit.factId;
    case 'mark':
      return hit.text;
  }
}

function hitDetail(hit: SearchHit): string {
  switch (hit.kind) {
    case 'drawing':
      return hit.matchedOn === 'drawingNumber' || hit.matchedOn === 'fileName'
        ? ''
        : hit.snippet;
    case 'section':
      return hit.matchedOn === 'label' || hit.matchedOn === 'sectionId' ? '' : hit.snippet;
    case 'fact':
      return hit.state.toLowerCase() + (hit.snippet !== hit.factId ? ` · ${hit.snippet}` : '');
    case 'mark':
      return hit.matchedOn === 'callout' ? 'callout' : 'mark';
  }
}

export function CommandPalette() {
  const data = useStudioData();
  const store = useStudioStore();
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const close = () => store.setPaletteOpen(false);

  const hits = useMemo(
    () => (data.search && query.trim() ? data.search.query(query) : []),
    [data.search, query],
  );

  // Grouped by kind, groups ordered by their best hit — so the first row of
  // the first group IS the overall top hit, which starts selected.
  const groups = useMemo(() => {
    const byKind = new Map<SearchHit['kind'], SearchHit[]>();
    for (const h of hits) {
      const list = byKind.get(h.kind) ?? [];
      list.push(h);
      byKind.set(h.kind, list);
    }
    return [...byKind.entries()].sort(
      ([, a], [, b]) => (b[0]?.score ?? 0) - (a[0]?.score ?? 0),
    );
  }, [hits]);

  const flat = useMemo(() => groups.flatMap(([, list]) => list), [groups]);

  useEffect(() => {
    setSelected(0);
  }, [query]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>('[data-selected="true"]');
    el?.scrollIntoView?.({ block: 'nearest' });
  }, [selected]);

  const go = (hit: SearchHit) => {
    close();
    data.search?.goTo(hit);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelected((i) => Math.min(flat.length - 1, i + 1));
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelected((i) => Math.max(0, i - 1));
      return;
    }
    if (e.key === 'Enter' && flat[selected]) {
      e.preventDefault();
      go(flat[selected]);
    }
  };

  let index = -1;

  return (
    <div className="palette-overlay" data-testid="command-palette" onPointerDown={(e) => {
      if (e.target === e.currentTarget) close();
    }}>
      <div className="palette" role="dialog" aria-label="Project search">
        <div className="pal-input">
          <Icon name="search" size={14} />
          <input
            ref={inputRef}
            type="text"
            placeholder="Search drawings, sections, facts and marks…"
            aria-label="Search the project"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
          />
          <kbd>Esc</kbd>
        </div>
        <div className="pal-list" ref={listRef}>
          {!data.search ? (
            <div className="pal-empty">Search connects to the project index — not wired in the demo.</div>
          ) : !query.trim() ? (
            <div className="pal-empty">
              Type to search — a drawing number, a section label, a fact key, a mark like C1, a
              callout like 8@150. A result always takes you there.
            </div>
          ) : !flat.length ? (
            <div className="pal-empty">Nothing in this project matches “{query}”.</div>
          ) : (
            groups.map(([kind, list]) => (
              <div key={kind} className="pal-group">
                <div className="pal-kind">{KIND_LABEL[kind]}</div>
                {list.map((hit) => {
                  index += 1;
                  const i = index;
                  const on = i === selected;
                  return (
                    <button
                      key={`${kind}-${i}`}
                      type="button"
                      className={`pal-row${on ? ' on' : ''}`}
                      data-selected={on || undefined}
                      onPointerEnter={() => setSelected(i)}
                      onClick={() => go(hit)}
                    >
                      <Icon name={KIND_ICON[hit.kind]} size={13} />
                      <span className="t">{hitTitle(hit)}</span>
                      <span className="d">{hitDetail(hit)}</span>
                      {'superseded' in hit && hit.superseded ? (
                        <span className="pal-tag">superseded</span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
