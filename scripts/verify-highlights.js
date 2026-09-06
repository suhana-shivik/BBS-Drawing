
(() => {
  const pane = document.querySelector('.viewport .pane');
  if (!pane) return console.error('No drawing open.');
  const host = pane.querySelector('[data-testid="sheet-host"]');
  const svg = host && host.querySelector('svg');
  if (!svg) return console.error('No sheet SVG injected.');

  const vb = (svg.getAttribute('viewBox') || '').split(/[\s,]+/).map(Number);
  const ink = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  let ops = 0;
  for (const p of svg.querySelectorAll('g[data-layer] path')) {
    ops += 1;
    for (const seg of (p.getAttribute('d') || '').matchAll(/[ML](-?[\d.]+) (-?[\d.]+)/g)) {
      const x = +seg[1];
      const y = +seg[2];
      if (x < ink.minX) ink.minX = x;
      if (x > ink.maxX) ink.maxX = x;
      if (y < ink.minY) ink.minY = y;
      if (y > ink.maxY) ink.maxY = y;
    }
  }
  console.log('%cTHE DRAWING', 'font-weight:bold');
  console.log('  viewBox       :', svg.getAttribute('viewBox'));
  console.log('  path ops      :', ops, ops === 0 ? '  <-- NOTHING IS DRAWN AT ALL' : '');
  if (ops && isFinite(ink.minX)) {
    const w = vb[2] || 1;
    const h = vb[3] || 1;
    console.log(
      '  ink spans     : x', Math.round(ink.minX), '..', Math.round(ink.maxX),
      ' y', Math.round(ink.minY), '..', Math.round(ink.maxY),
    );
    console.log(
      '  ink fills     :',
      (((ink.maxX - ink.minX) / w) * 100).toFixed(1) + '% x',
      (((ink.maxY - ink.minY) / h) * 100).toFixed(1) + '% of the sheet',
    );
    const tiny = (ink.maxX - ink.minX) / w < 0.2 || (ink.maxY - ink.minY) / h < 0.2;
    const outside = ink.minX < -1 || ink.maxX > w + 1 || ink.minY < -1 || ink.maxY > h + 1;
    if (tiny) {
      console.log(
        '%c  -> THE FRAME IS TOO BIG for the drawing: the geometry is a speck in a\n' +
          '     sheet sized for something far away. A stray entity is being framed.',
        'color:#f59e0b',
      );
    }
    if (outside) {
      console.log(
        '%c  -> ink falls OUTSIDE the viewBox: the frame is too small / offset.',
        'color:#f59e0b',
      );
    }
    const r = svg.getBoundingClientRect();
    console.log('  svg on screen :', Math.round(r.width) + 'x' + Math.round(r.height), 'at', Math.round(r.x) + ',' + Math.round(r.y));
  }

  const marks = svg.querySelector('.sheet-marks');
  if (!marks) {
    return console.error(
      'NO MARKS IN THE SVG.\n' +
        'The sheet was built with no highlights — this drawing has not been read,\n' +
        'or the sections never reached groupedSheetSvg(). Not a CSS problem.',
    );
  }

  const groups = [...marks.querySelectorAll('g[data-section]')];
  const fills = [...marks.querySelectorAll('[data-testid="mark-fills"] rect')];
  console.log('%cIN THE DOM', 'font-weight:bold');
  console.log('  marks group   : yes');
  console.log('  outlines      :', groups.length);
  console.log('  fills         :', fills.length);

  // ---- is anything hiding them? -----------------------------------------
  const cs = (el) => getComputedStyle(el);
  const m = cs(marks);
  console.log('%cVISIBILITY', 'font-weight:bold');
  console.log('  marks display :', m.display, m.display === 'none' ? '  <-- HIDDEN' : '');
  console.log('  marks opacity :', m.opacity, +m.opacity === 0 ? '  <-- INVISIBLE' : '');
  console.log('  marks visibility:', m.visibility);
  if (m.display === 'none') {
    console.log(
      '%c  -> THE OVERLAY TOGGLE IS OFF. Click the section icon in the sheet strip,\n' +
        '     immediately to the right of the Layers icon — it lights up when on.\n' +
        '     (If it IS lit, your CSS and JS are out of step: hard-reload, Ctrl+Shift+R.)',
      'color:#f59e0b',
    );
  }

  // walk up: a hidden ancestor hides everything under it
  let up = marks.parentElement;
  while (up && up !== document.body) {
    const s = cs(up);
    if (s.display === 'none' || s.visibility === 'hidden' || +s.opacity === 0) {
      console.log(
        '  HIDDEN BY ANCESTOR:',
        up.tagName.toLowerCase() + (up.className.baseVal ?? up.className ? '.' + String(up.className.baseVal ?? up.className).trim().split(/\s+/).join('.') : ''),
        `display=${s.display} visibility=${s.visibility} opacity=${s.opacity}`,
      );
    }
    up = up.parentElement;
  }

  // ---- per mark ----------------------------------------------------------
  const pr = pane.getBoundingClientRect();
  let onScreen = 0;
  console.log('%cMARKS', 'font-weight:bold');
  for (const g of groups) {
    const rect = g.querySelector('rect');
    const r = rect.getBoundingClientRect();
    const rs = cs(rect);
    const gs = cs(g);
    const vis =
      r.width > 0.5 && r.height > 0.5 &&
      r.right > pr.left && r.left < pr.right && r.bottom > pr.top && r.top < pr.bottom;
    if (vis) onScreen += 1;
    console.log(
      `  ${g.dataset.section.padEnd(11)} on-screen: ${vis ? 'YES' : 'NO '}` +
        `  ${Math.round(r.width)}x${Math.round(r.height)} px at ${Math.round(r.x)},${Math.round(r.y)}`,
    );
    console.log(
      `        stroke=${rs.stroke} width=${rs.strokeWidth} fill=${rs.fill}` +
        `  display=${gs.display} opacity=${gs.opacity}`,
    );
  }
  const fs0 = fills[0] && cs(fills[0]);
  if (fs0) {
    console.log('%cFILL', 'font-weight:bold');
    console.log('  group opacity :', cs(fills[0].parentElement).opacity);
    console.log('  rect fill     :', fs0.fill);
  }

  console.log('%cTOTAL', 'font-weight:bold');
  console.log('  marks created :', groups.length);
  console.log('  marks visible :', onScreen);
  if (groups.length && !onScreen) {
    console.log(
      '%c  -> they are in the DOM but not on screen: check the display/opacity\n' +
        '     lines above, then the px positions against the pane.',
      'color:#f59e0b',
    );
  }
})();
