// Model validation rules. Pure function — no caching; cheap enough to run
// on every render tick for a few hundred elements (simple O(n²) pair checks).
import type { BIMModel } from '../core/model';
import type {
  AnyElement,
  DoorElement,
  RoomElement,
  SlabElement,
  StairElement,
  Vec2,
  WallElement,
  WindowElement,
} from '../core/types';
import {
  polygonAreaAbs,
  ptsEqual,
  segmentIntersect,
  wallLength,
} from '../core/geometry';
import { catalogItem } from '../library/catalog';

export interface Issue {
  severity: 'error' | 'warning';
  message: string;
  elementId?: string;
}

const MIN_ROOM_AREA = 10_000; // mm² = 0.01 m²
const MIN_WALL_LENGTH = 50; // mm
const DUPLICATE_TOL = 10; // mm

/** e.g. 'Door "Main Door"' */
function label(el: AnyElement): string {
  return `${el.type.charAt(0).toUpperCase()}${el.type.slice(1)} "${el.name}"`;
}

export function validateModel(model: BIMModel): Issue[] {
  const issues: Issue[] = [];
  const levelIds = new Set(model.levels.map((l) => l.id));
  const elements = model.all();

  for (const el of elements) {
    // every element must sit on an existing level
    if (!levelIds.has(el.levelId)) {
      issues.push({
        severity: 'error',
        elementId: el.id,
        message: `${label(el)} is placed on a level that does not exist`,
      });
    }

    switch (el.type) {
      case 'door':
      case 'window':
        checkOpening(model, el, issues);
        break;
      case 'wall':
        if (wallLength(el) < MIN_WALL_LENGTH) {
          issues.push({
            severity: 'warning',
            elementId: el.id,
            message: `${label(el)} is shorter than ${MIN_WALL_LENGTH}mm`,
          });
        }
        break;
      case 'room':
        checkRoom(el, issues);
        break;
      case 'stair':
        checkStair(el, levelIds, issues);
        break;
      case 'slab':
        if (outlineSelfIntersects(el.outline)) {
          issues.push({
            severity: 'warning',
            elementId: el.id,
            message: `${label(el)} has a self-intersecting outline`,
          });
        }
        break;
      case 'furniture':
        if (!catalogItem(el.catalogId)) {
          issues.push({
            severity: 'warning',
            elementId: el.id,
            message: `${label(el)} references unknown catalog item "${el.catalogId}"`,
          });
        }
        break;
      default:
        break;
    }
  }

  // duplicate walls — identical endpoints in either direction, once per pair
  const walls = elements.filter((el): el is WallElement => el.type === 'wall');
  for (let i = 0; i < walls.length; i++) {
    for (let j = i + 1; j < walls.length; j++) {
      const a = walls[i];
      const b = walls[j];
      const same =
        (ptsEqual(a.start, b.start, DUPLICATE_TOL) &&
          ptsEqual(a.end, b.end, DUPLICATE_TOL)) ||
        (ptsEqual(a.start, b.end, DUPLICATE_TOL) &&
          ptsEqual(a.end, b.start, DUPLICATE_TOL));
      if (same) {
        issues.push({
          severity: 'warning',
          elementId: b.id,
          message: `Walls "${a.name}" and "${b.name}" appear to be duplicates (identical endpoints)`,
        });
      }
    }
  }

  return issues;
}

// ------------------------------------------------------------
// rule helpers
// ------------------------------------------------------------

function checkOpening(
  model: BIMModel,
  el: DoorElement | WindowElement,
  issues: Issue[],
): void {
  const host = el.hostWallId ? model.get(el.hostWallId) : undefined;
  if (!host || host.type !== 'wall') {
    issues.push({
      severity: 'error',
      elementId: el.id,
      message: `${label(el)} has no host wall`,
    });
    return;
  }

  if (host.levelId !== el.levelId) {
    issues.push({
      severity: 'warning',
      elementId: el.id,
      message: `${label(el)} is on a different level than its host wall "${host.name}"`,
    });
  }

  const L = wallLength(host);
  if (el.offset - el.width / 2 < 0 || el.offset + el.width / 2 > L) {
    issues.push({
      severity: 'warning',
      elementId: el.id,
      message: `${label(el)} extends beyond the end of its host wall "${host.name}"`,
    });
  }

  if (el.type === 'window') {
    if (el.sillHeight + el.height > host.height) {
      issues.push({
        severity: 'warning',
        elementId: el.id,
        message: `${label(el)} extends above the top of its host wall "${host.name}"`,
      });
    }
  } else if (el.height > host.height) {
    issues.push({
      severity: 'warning',
      elementId: el.id,
      message: `${label(el)} is taller than its host wall "${host.name}"`,
    });
  }
}

function checkRoom(el: RoomElement, issues: Issue[]): void {
  if (el.boundary.length < 3) {
    issues.push({
      severity: 'error',
      elementId: el.id,
      message: `${label(el)} has a degenerate boundary (fewer than 3 points)`,
    });
    return;
  }
  if (polygonAreaAbs(el.boundary) < MIN_ROOM_AREA) {
    issues.push({
      severity: 'error',
      elementId: el.id,
      message: `${label(el)} has a near-zero area (less than 0.01 m²)`,
    });
  }
}

function checkStair(
  el: StairElement,
  levelIds: Set<string>,
  issues: Issue[],
): void {
  if (!el.toLevelId || !levelIds.has(el.toLevelId)) {
    issues.push({
      severity: 'error',
      elementId: el.id,
      message: `${label(el)} has no valid destination level`,
    });
  } else if (el.toLevelId === el.levelId) {
    issues.push({
      severity: 'error',
      elementId: el.id,
      message: `${label(el)} starts and ends on the same level`,
    });
  }
}

/** segment-pair check, ignoring adjacent segments (incl. the wrap pair) */
function outlineSelfIntersects(outline: Vec2[]): boolean {
  const n = outline.length;
  if (n < 4) return false;
  for (let i = 0; i < n; i++) {
    const a = outline[i];
    const b = outline[(i + 1) % n];
    for (let j = i + 2; j < n; j++) {
      if ((j + 1) % n === i) continue; // wrap-around neighbour of segment i
      const c = outline[j];
      const d = outline[(j + 1) % n];
      if (segmentIntersect(a, b, c, d)) return true;
    }
  }
  return false;
}
