import { readFileSync } from 'node:fs';
import { unzipSync, strFromU8 } from 'fflate';
const file = process.argv[2];
const z = unzipSync(new Uint8Array(readFileSync(file)));
const names = Object.keys(z);
const ss = z['xl/sharedStrings.xml'] ? [...strFromU8(z['xl/sharedStrings.xml']).matchAll(/<si>([\s\S]*?)<\/si>/g)].map(m => [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(t=>t[1]).join('')) : [];
const dec = s => s.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#10;/g,'\n');
for (const n of names.filter(n => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort()) {
  console.log('=== ' + n);
  const xml = strFromU8(z[n]);
  for (const row of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = [];
    for (const c of row[1].matchAll(/<c r="([A-Z]+)\d+"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = c[2]; const inner = c[3] ?? '';
      let v = '';
      const vm = /<v>([\s\S]*?)<\/v>/.exec(inner); const im = /<t[^>]*>([\s\S]*?)<\/t>/.exec(inner);
      if (/t="s"/.test(attrs) && vm) v = ss[Number(vm[1])];
      else if (im) v = im[1]; else if (vm) v = vm[1];
      if (v !== '') cells.push(c[1] + ':' + dec(v));
    }
    if (cells.length) console.log(cells.join(' | '));
  }
}
