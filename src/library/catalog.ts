// Component/family catalog — doors, windows, furniture, sanitary ware and
// structural parts that can be placed into a model. Dimensions are the plan
// footprint in mm (width × depth) plus the overall height.
export interface CatalogItem {
  id: string;
  name: string;
  category: 'door' | 'window' | 'furniture' | 'sanitary' | 'structural';
  /** plan footprint, mm */
  width: number;
  depth: number;
  height: number;
  description?: string;
  /**
   * Optional plan symbol as an SVG path in a unit box (0..1 × 0..1),
   * scaled by the editor/exporters to width × depth.
   */
  symbolPath?: string;
}

export const CATALOG: CatalogItem[] = [
  // ---------------------------------------------------------------- doors
  {
    id: 'door-single-900',
    name: 'Single Door 900',
    category: 'door',
    width: 900,
    depth: 40,
    height: 2100,
    description: 'Standard single-leaf hinged door, 900 mm clear opening.',
    symbolPath: 'M0 0.5 L1 0.5',
  },
  {
    id: 'door-narrow-750',
    name: 'Narrow Door 750',
    category: 'door',
    width: 750,
    depth: 40,
    height: 2100,
    description: 'Narrow single-leaf door for bathrooms, stores and closets.',
    symbolPath: 'M0 0.5 L1 0.5',
  },
  {
    id: 'door-double-1500',
    name: 'Double Door 1500',
    category: 'door',
    width: 1500,
    depth: 40,
    height: 2100,
    description: 'Double-leaf entrance door, two 750 mm leaves.',
    symbolPath: 'M0 0.5 L1 0.5 M0.5 0.1 L0.5 0.9',
  },
  {
    id: 'door-sliding-1800',
    name: 'Sliding Door 1800',
    category: 'door',
    width: 1800,
    depth: 40,
    height: 2100,
    description: 'Twin-panel sliding door for wardrobes and patios.',
    symbolPath: 'M0 0.3 L0.55 0.3 M0.45 0.7 L1 0.7',
  },

  // -------------------------------------------------------------- windows
  {
    id: 'window-1200',
    name: 'Window 1200×1200',
    category: 'window',
    width: 1200,
    depth: 150,
    height: 1200,
    description: 'Standard double-casement window, 900 mm sill.',
    symbolPath: 'M0 0.5 L1 0.5 M0.5 0.15 L0.5 0.85',
  },
  {
    id: 'window-wide-1800',
    name: 'Wide Window 1800×1200',
    category: 'window',
    width: 1800,
    depth: 150,
    height: 1200,
    description: 'Wide three-panel window for living areas and offices.',
    symbolPath: 'M0 0.5 L1 0.5 M0.33 0.15 L0.33 0.85 M0.67 0.15 L0.67 0.85',
  },
  {
    id: 'window-bath-600',
    name: 'Bath Window 600×600',
    category: 'window',
    width: 600,
    depth: 150,
    height: 600,
    description: 'Small obscured-glass window for bathrooms, high sill.',
    symbolPath: 'M0 0.5 L1 0.5',
  },

  // ------------------------------------------------------------ furniture
  {
    id: 'bed-double',
    name: 'Double Bed',
    category: 'furniture',
    width: 1500,
    depth: 2000,
    height: 450,
    description: 'Queen-size double bed with two pillows, 1500 × 2000 mm.',
    symbolPath:
      'M0.08 0.05 L0.44 0.05 L0.44 0.18 L0.08 0.18 Z ' +
      'M0.56 0.05 L0.92 0.05 L0.92 0.18 L0.56 0.18 Z ' +
      'M0 0.32 L1 0.32 M0.85 0.32 L1 0.45',
  },
  {
    id: 'bed-single',
    name: 'Single Bed',
    category: 'furniture',
    width: 900,
    depth: 2000,
    height: 450,
    description: 'Single bed with one pillow, 900 × 2000 mm.',
    symbolPath:
      'M0.15 0.05 L0.85 0.05 L0.85 0.18 L0.15 0.18 Z ' +
      'M0 0.32 L1 0.32 M0.8 0.32 L1 0.48',
  },
  {
    id: 'sofa-3seat',
    name: 'Sofa (3-seat)',
    category: 'furniture',
    width: 2000,
    depth: 900,
    height: 800,
    description: 'Three-seat sofa with back and armrests.',
    symbolPath:
      'M0.12 0.97 L0.12 0.28 L0.88 0.28 L0.88 0.97 M0.5 0.28 L0.5 0.97',
  },
  {
    id: 'armchair',
    name: 'Armchair',
    category: 'furniture',
    width: 900,
    depth: 850,
    height: 800,
    description: 'Single-seat upholstered armchair.',
    symbolPath: 'M0.18 0.97 L0.18 0.3 L0.82 0.3 L0.82 0.97',
  },
  {
    id: 'table-dining',
    name: 'Dining Table',
    category: 'furniture',
    width: 1600,
    depth: 900,
    height: 750,
    description: 'Six-seat rectangular dining table.',
    symbolPath:
      'M0.14 0.2 L0.86 0.2 L0.86 0.8 L0.14 0.8 Z ' +
      'M0.2 0.02 L0.38 0.02 L0.38 0.17 L0.2 0.17 Z ' +
      'M0.62 0.02 L0.8 0.02 L0.8 0.17 L0.62 0.17 Z ' +
      'M0.2 0.83 L0.38 0.83 L0.38 0.98 L0.2 0.98 Z ' +
      'M0.62 0.83 L0.8 0.83 L0.8 0.98 L0.62 0.98 Z',
  },
  {
    id: 'chair',
    name: 'Chair',
    category: 'furniture',
    width: 450,
    depth: 450,
    height: 900,
    description: 'Standard dining/desk chair.',
    symbolPath: 'M0.12 0.18 L0.88 0.18 M0.18 0.3 L0.82 0.3 L0.82 0.92 L0.18 0.92 Z',
  },
  {
    id: 'desk',
    name: 'Desk',
    category: 'furniture',
    width: 1400,
    depth: 700,
    height: 750,
    description: 'Office work desk with pedestal drawers.',
    symbolPath:
      'M0.04 0.15 L0.24 0.15 L0.24 0.9 L0.04 0.9 Z ' +
      'M0.76 0.15 L0.96 0.15 L0.96 0.9 L0.76 0.9 Z',
  },
  {
    id: 'wardrobe',
    name: 'Wardrobe',
    category: 'furniture',
    width: 1800,
    depth: 600,
    height: 2100,
    description: 'Full-height two-door wardrobe with hanging rail.',
    symbolPath:
      'M0.02 0.5 L0.98 0.5 M0.5 0.05 L0.5 0.95 ' +
      'M0.2 0.3 L0.2 0.7 M0.35 0.3 L0.35 0.7 M0.65 0.3 L0.65 0.7 M0.8 0.3 L0.8 0.7',
  },
  {
    id: 'kitchen-counter',
    name: 'Kitchen Counter',
    category: 'furniture',
    width: 2400,
    depth: 600,
    height: 900,
    description: 'Base-cabinet kitchen counter run, 600 mm deep.',
    symbolPath:
      'M0 0.22 L1 0.22 M0.25 0.22 L0.25 1 M0.5 0.22 L0.5 1 M0.75 0.22 L0.75 1',
  },
  {
    id: 'fridge',
    name: 'Fridge',
    category: 'furniture',
    width: 700,
    depth: 700,
    height: 1800,
    description: 'Free-standing refrigerator/freezer.',
    symbolPath: 'M0.1 0.12 L0.9 0.12 L0.9 0.9 L0.1 0.9 Z M0.1 0.35 L0.9 0.35',
  },
  {
    id: 'tv-unit',
    name: 'TV Unit',
    category: 'furniture',
    width: 1500,
    depth: 450,
    height: 500,
    description: 'Low media console with television.',
    symbolPath:
      'M0.1 0.2 L0.9 0.2 L0.9 0.38 L0.1 0.38 Z ' +
      'M0.3 0.6 L0.7 0.6 L0.7 0.85 L0.3 0.85 Z',
  },

  // ------------------------------------------------------------- sanitary
  {
    id: 'wc',
    name: 'WC',
    category: 'sanitary',
    width: 380,
    depth: 700,
    height: 400,
    description: 'Close-coupled toilet with cistern.',
    symbolPath:
      'M0.06 0.02 L0.94 0.02 L0.94 0.24 L0.06 0.24 Z ' +
      'M0.5 0.3 C0.78 0.3 0.85 0.5 0.85 0.62 C0.85 0.82 0.68 0.95 0.5 0.95 ' +
      'C0.32 0.95 0.15 0.82 0.15 0.62 C0.15 0.5 0.22 0.3 0.5 0.3 Z',
  },
  {
    id: 'washbasin',
    name: 'Washbasin',
    category: 'sanitary',
    width: 550,
    depth: 450,
    height: 850,
    description: 'Wall-hung washbasin with tap.',
    symbolPath:
      'M0.38 0.02 L0.62 0.02 L0.62 0.14 L0.38 0.14 Z ' +
      'M0.5 0.2 C0.82 0.2 0.9 0.42 0.9 0.55 C0.9 0.78 0.72 0.92 0.5 0.92 ' +
      'C0.28 0.92 0.1 0.78 0.1 0.55 C0.1 0.42 0.18 0.2 0.5 0.2 Z',
  },
  {
    id: 'shower',
    name: 'Shower',
    category: 'sanitary',
    width: 900,
    depth: 900,
    height: 2100,
    description: 'Square shower enclosure, 900 × 900 mm tray.',
    symbolPath: 'M0 0 L1 1 M1 0 L0 1',
  },
  {
    id: 'bathtub',
    name: 'Bathtub',
    category: 'sanitary',
    width: 1700,
    depth: 750,
    height: 550,
    description: 'Built-in bathtub with rounded interior.',
    symbolPath:
      'M0.14 0.1 L0.86 0.1 C0.96 0.1 0.96 0.9 0.86 0.9 L0.14 0.9 ' +
      'C0.04 0.9 0.04 0.1 0.14 0.1 Z ' +
      'M0.2 0.46 L0.26 0.46 L0.26 0.54 L0.2 0.54 Z',
  },
  {
    id: 'kitchen-sink',
    name: 'Kitchen Sink',
    category: 'sanitary',
    width: 800,
    depth: 500,
    height: 900,
    description: 'Counter-mounted sink with bowl and drainer.',
    symbolPath:
      'M0.08 0.15 L0.58 0.15 L0.58 0.85 L0.08 0.85 Z ' +
      'M0.66 0.25 L0.92 0.25 L0.92 0.75 L0.66 0.75 Z',
  },

  // ----------------------------------------------------------- structural
  {
    id: 'column-300',
    name: 'Column 300×300',
    category: 'structural',
    width: 300,
    depth: 300,
    height: 3000,
    description: 'Reinforced-concrete column, 300 mm square.',
    symbolPath: 'M0 0 L1 1 M1 0 L0 1',
  },
  {
    id: 'column-450',
    name: 'Column 450×450',
    category: 'structural',
    width: 450,
    depth: 450,
    height: 3000,
    description: 'Heavy reinforced-concrete column, 450 mm square.',
    symbolPath: 'M0 0 L1 1 M1 0 L0 1',
  },
  {
    id: 'footing-1200',
    name: 'Footing 1200×1200',
    category: 'structural',
    width: 1200,
    depth: 1200,
    height: 450,
    description: 'Isolated pad footing, 1200 mm square.',
    symbolPath:
      'M0.32 0.32 L0.68 0.32 L0.68 0.68 L0.32 0.68 Z ' +
      'M0 0 L0.32 0.32 M1 0 L0.68 0.32 M1 1 L0.68 0.68 M0 1 L0.32 0.68',
  },
];

export function catalogItem(id: string): CatalogItem | undefined {
  return CATALOG.find((c) => c.id === id);
}
