// Actualiza la copia de respaldo de órbitas (assets/sky/tle/*.txt) desde CelesTrak.
// La web siempre intenta primero CelesTrak en directo; esta copia solo se usa si falla.
// Uso (de vez en cuando, a mano):  node scripts/update-tle.mjs
import { writeFile, mkdir } from 'node:fs/promises';

const GROUPS = process.argv.slice(2).length ? process.argv.slice(2) : ['stations', 'visual', 'gnss', 'geo'];
await mkdir('assets/sky/tle', { recursive: true });
for (const g of GROUPS) {
  let res, text;
  try {
    res = await fetch(`https://celestrak.org/NORAD/elements/gp.php?GROUP=${g}&FORMAT=tle`);
    text = await res.text();
  } catch (e) {
    console.error(`${g}: ${e.message}, se mantiene la copia anterior`);
    continue;
  }
  if (!res.ok || !text.includes('\n1 ')) { console.error(`${g}: HTTP ${res.status}, se mantiene la copia anterior`); continue; }
  await writeFile(`assets/sky/tle/${g}.txt`, text);
  console.log(`${g}: ${text.split('\n1 ').length - 1} satélites`);
  await new Promise((r) => setTimeout(r, 1500)); // sin prisas con CelesTrak
}
