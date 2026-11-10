// Writes official brand marks from Simple Icons (CC0) for services whose own sites
// block automated fetching. Run after fetch-logos.mjs:
//   npm i --no-save simple-icons@16.35.0 && node scripts/simple-logos.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as si from 'simple-icons';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web', 'logos');
const MAP = {
  asana: 'siAsana', trello: 'siTrello', clickup: 'siClickup', airtable: 'siAirtable', figma: 'siFigma', dropbox: 'siDropbox',
  vercel: 'siVercel', stripe: 'siStripe', quickbooks: 'siQuickbooks', xero: 'siXero', instagram: 'siInstagram', facebook: 'siFacebook',
  metaads: 'siMeta', whatsapp: 'siWhatsapp', imessage: 'siImessage', jira: ['siJira', '0052CC'], confluence: ['siConfluence', '0052CC'],
};
for (const [id, spec] of Object.entries(MAP)) {
  const [name, color] = Array.isArray(spec) ? spec : [spec];
  if (['svg', 'png'].some((e) => fs.existsSync(path.join(OUT, `${id}.${e}`))) && !process.argv.includes('--force')) continue;
  const icon = si[name];
  if (!icon) { console.log('missing', id); continue; }
  fs.writeFileSync(path.join(OUT, `${id}.svg`), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><title>${icon.title}</title><path fill="#${color || icon.hex}" d="${icon.path}"/></svg>`);
  console.log('wrote', id);
}
const manifest = Object.fromEntries(fs.readdirSync(OUT).filter((f) => /\.(svg|png)$/.test(f)).map((f) => [f.replace(/\.(svg|png)$/, ''), `/logos/${f}`]));
fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify(manifest, null, 1));
console.log(`${Object.keys(manifest).length} logos`);
