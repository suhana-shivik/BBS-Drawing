// Unit formatting helpers. Model space is always mm; these convert for display.
import type { Unit } from './types';

export function formatLength(mm: number, unit: Unit = 'mm'): string {
  switch (unit) {
    case 'mm':
      return `${Math.round(mm)} mm`;
    case 'cm':
      return `${(mm / 10).toFixed(1)} cm`;
    case 'm':
      return `${(mm / 1000).toFixed(2)} m`;
    case 'in':
      return `${(mm / 25.4).toFixed(1)}"`;
    case 'ft': {
      const totalIn = mm / 25.4;
      const ft = Math.floor(totalIn / 12);
      const inch = Math.round(totalIn - ft * 12);
      return `${ft}'-${inch}"`;
    }
  }
}

export function formatArea(mm2: number, unit: Unit = 'mm'): string {
  if (unit === 'in' || unit === 'ft') {
    return `${(mm2 / 92903.04).toFixed(1)} sq.ft`;
  }
  return `${(mm2 / 1e6).toFixed(2)} m²`;
}

export function formatVolume(mm3: number, unit: Unit = 'mm'): string {
  if (unit === 'in' || unit === 'ft') {
    return `${(mm3 / 2.8317e7).toFixed(1)} cu.ft`;
  }
  return `${(mm3 / 1e9).toFixed(2)} m³`;
}
