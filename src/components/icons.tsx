// The product's 16×16 line icons, ported from the studio.html prototype so the
// shell uses the approved set rather than a stand-in family.

import React from 'react';

const PATHS: Record<string, string> = {
  check: 'M3 8.5 6.5 12 13 5',
  close: 'm4 4 8 8M12 4l-8 8',
  plus: 'M8 3v10M3 8h10',
  search: '', // drawn with circle below
  chevronRight: 'm6 4 4 4-4 4',
  chevronDown: 'M4 6.5 8 10l4-3.5',
  chevronUp: 'M4 9.5 8 6l4 3.5',
  back: 'M10 3 5 8l5 5M5 8h8',
  upLevel: 'M8 13V4M4.5 7.5 8 4l3.5 3.5',
  file: 'M4 1.5h5l3 3v10H4Zm5 0v3h3',
  paperclip: 'M5.2 8.7 9.7 4.2a2.1 2.1 0 0 1 3 3L7 12.9a3.3 3.3 0 0 1-4.7-4.7l5.5-5.5a2.2 2.2 0 0 1 3.1 3.1L5.7 11a1 1 0 0 1-1.4-1.4l4.4-4.4',
  folder: 'M1.5 3.5h4.2L7.5 5.5H14.5v8h-13Z',
  upload: 'M8 10.5v-8M4.5 6 8 2.5 11.5 6M3 13.5h10',
  download: 'M8 2.5v8M4.5 7 8 10.5 11.5 7M3 13.5h10',
  warning: 'M8 2.5 14.2 13H1.8ZM8 6.5v3.2M8 11.4v.2',
  filter: 'M2 3h12L9.7 8.3v4.4l-3.4 1.8V8.3Z',
  layers: 'M8 1.8 14.2 5.1 8 8.4 1.8 5.1Zm-5.4 6.4 5.4 2.9 5.4-2.9m-10.8 3.1 5.4 2.9 5.4-2.9',
  section: 'M2.5 4.5h11v7h-11ZM8 2h2.6M8 14h2.6',
  schedule: 'M2 6h12M2 9.75h12M6.2 6v7.5',
  expand: 'M6 2H2v4M10 2h4v4M6 14H2v-4M10 14h4v-4',
  pan: 'M8 1.5v13M1.5 8h13M6.3 3.2 8 1.5l1.7 1.7M6.3 12.8 8 14.5l1.7-1.7M3.2 6.3 1.5 8l1.7 1.7M12.8 6.3 14.5 8l-1.7 1.7',
  select: 'M4.5 1.8 12 9.3l-4.2.4 2.3 4-1.9.9-2.2-4-2.5 2.7Z',
  line: 'm2.5 13.5 11-11',
  dimension: 'M2 4v8M14 4v8M2 8h12',
  measure: 'M4.5 5.5v2.2M7.5 5.5v3.2M10.5 5.5v2.2',
  text: 'M3 3.5h10M8 3.5v9M6 12.5h4',
  grid: 'M2 5.8h12M2 10.2h12M5.8 2v12M10.2 2v12',
  magnet: 'M4.5 2v5.5a3.5 3.5 0 0 0 7 0V2M4.5 2h2.6v3M8.9 2h2.6M8.9 5h2.6M7.1 2v3H4.5',
  panelLeft: 'M6 3v10',
  panelRight: 'M10 3v10',
  panelBottom: 'M1.6 10h12.8',
  gear: 'M8 1.7v1.7M8 12.6v1.7M14.3 8h-1.7M3.4 8H1.7M12.4 3.6l-1.2 1.2M4.8 11.2l-1.2 1.2M12.4 12.4l-1.2-1.2M4.8 4.8 3.6 3.6',
  winMin: 'M3.5 8h9',
  // Restore-down: the small pane in front, the window it came out of behind.
  winRestore: 'M5.6 5.6V3.9h6.5v6.5h-1.7',
  history: 'M3.1 5.1H.9V2.9M2 4.1A6 6 0 1 1 2.6 12M8 4.5V8l2.4 1.4',
  sparkles: 'M6.1 2.1c.35 2.15 1.5 3.3 3.65 3.65-2.15.35-3.3 1.5-3.65 3.65-.35-2.15-1.5-3.3-3.65-3.65 2.15-.35 3.3-1.5 3.65-3.65Z',
  rotate: 'M13 8a5 5 0 1 1-1.6-3.7M13.5 2v3.2h-3.2',
  scale: 'M9.5 6.5V2.5h-4M13.5 2.5 8.5 7.5',
  mirror: 'M6 4.5 2.5 8 6 11.5zM10 4.5 13.5 8 10 11.5z',
  polyline: 'm2 12 4-6 4 3 4-7',
  rectangle: '',
  circle: '',
  arc: 'M2.5 12.5a7 7 0 0 1 11-5.6',
  wall: 'M1.5 5.5h13M1.5 10.5h13m-10.5 5 2.5-5M8 10.5l2.5-5',
  door: 'M1.5 13.5h13M4.5 13.5v-8M4.5 5.5a8 8 0 0 1 8 8',
  window: 'M1.5 8h13',
  column: 'm4 4 8 8M12 4l-8 8',
  beam: 'M3 3h10M3 13h10M8 3v10',
  slab: 'M2 9 8 6l6 3-6 3ZM2 9v3l6 3 6-3V9M8 12v3',
  room: 'M6 8h4',
  stair: 'M1.5 14.5h3v-3h3v-3h3v-3h3v-3',
  furniture: 'M3.5 11.5V7a1.5 1.5 0 0 1 1.5-1.5h6A1.5 1.5 0 0 1 12.5 7v4.5M2 11.5h12M4 11.5V14M12 11.5V14',
  save: 'M2.5 2.5h9l2 2v9h-11ZM5 2.5V6h6V2.5M5 13.5V9.5h6v4',
  solo: '',
  dots: '',
  sun: 'M8 1.3v1.4M8 13.3v1.4M1.3 8h1.4M13.3 8h1.4M3.3 3.3l1 1M11.7 11.7l1 1M12.7 3.3l-1 1M4.3 11.7l-1 1',
  moon: 'M12.9 10.7A5.7 5.7 0 0 1 5.3 3.1 5.8 5.8 0 1 0 12.9 10.7Z',
  chatBubble: 'M2.2 3.1h11.6v8.2H7.1L3.6 14v-2.7H2.2ZM5 6.1h6M5 8.5h4',
  // Files-view toolbar (Explorer idiom): rename, delete, sort, view.
  pencil: 'M11.6 2.3 13.7 4.4 5.3 12.8 2.2 13.8l1-3.1ZM10.1 3.8l2.1 2.1',
  trash: 'M2.6 4.4h10.8M6 4.4V2.7h4v1.7M4.3 4.4l.6 9.1h6.2l.6-9.1M6.6 6.8v4.3M9.4 6.8v4.3',
  sortArrows: 'M4.4 2.6v10.8M2.1 11.1l2.3 2.3 2.3-2.3M11.6 13.4V2.6M9.3 4.9l2.3-2.3 2.3 2.3',
  viewGrid: '',
};

const EXTRAS: Record<string, React.ReactNode> = {
  search: (
    <>
      <circle cx="7" cy="7" r="4.2" />
      <path d="m10.2 10.2 3.6 3.6" />
    </>
  ),
  gear: <circle cx="8" cy="8" r="2.3" />,
  sun: <circle cx="8" cy="8" r="2.7" />,
  solo: (
    <>
      <circle cx="8" cy="8" r="5.3" />
      <circle cx="8" cy="8" r="1.5" fill="currentColor" stroke="none" />
    </>
  ),
  dots: (
    <g fill="currentColor" stroke="none">
      <circle cx="3.5" cy="8" r="1.15" />
      <circle cx="8" cy="8" r="1.15" />
      <circle cx="12.5" cy="8" r="1.15" />
    </g>
  ),
  line: (
    <>
      <circle cx="2.5" cy="13.5" r="1.4" />
      <circle cx="13.5" cy="2.5" r="1.4" />
    </>
  ),
  measure: <rect x="1.5" y="5.5" width="13" height="5.5" />,
  schedule: <rect x="2" y="2.5" width="12" height="11" rx="1" />,
  panelLeft: <rect x="1.6" y="3" width="12.8" height="10" rx="1" />,
  panelRight: <rect x="1.6" y="3" width="12.8" height="10" rx="1" />,
  panelBottom: <rect x="1.6" y="3" width="12.8" height="10" rx="1" />,
  winMax: <rect x="3.8" y="3.8" width="8.4" height="8.4" rx="0.6" />,
  winRestore: <rect x="3.9" y="5.6" width="6.5" height="6.5" rx="0.6" />,
  dimension: <path d="m4.6 6.6-2.6 1.4 2.6 1.4M11.4 6.6 14 8l-2.6 1.4" />,
  section: <path d="M8 1.5v13" strokeDasharray="2.6 2.1" />,
  scale: <rect x="2.5" y="8" width="5.5" height="5.5" />,
  mirror: <path d="M8 1.5v13" strokeDasharray="2 2" />,
  polyline: (
    <>
      <circle cx="2" cy="12" r="1.3" />
      <circle cx="14" cy="2" r="1.3" />
    </>
  ),
  rectangle: <rect x="2.5" y="4" width="11" height="8" rx="0.5" />,
  circle: <circle cx="8" cy="8" r="5.5" />,
  arc: (
    <>
      <circle cx="2.5" cy="12.5" r="1.3" />
      <circle cx="13.5" cy="6.9" r="1.3" />
    </>
  ),
  window: <rect x="1.5" y="5" width="13" height="6" />,
  column: <rect x="4" y="4" width="8" height="8" />,
  room: <rect x="2" y="3" width="12" height="10" />,
  viewGrid: (
    <>
      <rect x="2.2" y="2.2" width="5" height="5" rx="0.8" />
      <rect x="8.8" y="2.2" width="5" height="5" rx="0.8" />
      <rect x="2.2" y="8.8" width="5" height="5" rx="0.8" />
      <rect x="8.8" y="8.8" width="5" height="5" rx="0.8" />
    </>
  ),
};

export type IconName = keyof typeof PATHS | 'winMax';

export function Icon({ name, size = 15 }: { name: string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.3}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {PATHS[name] ? <path d={PATHS[name]} /> : null}
      {EXTRAS[name] ?? null}
    </svg>
  );
}
