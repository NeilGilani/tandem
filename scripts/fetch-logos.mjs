// Fetches each Connect apps service's own full-color logo into web/logos/, once,
// so Tandem never loads third-party images at runtime.
//   node scripts/fetch-logos.mjs            fetch missing logos
//   node scripts/fetch-logos.mjs --force    refetch all
// Sources, in order: known official icon URLs, Wikimedia Commons SVGs (Microsoft
// apps), then the icons each site declares (SVG, apple-touch-icon, largest PNG).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CATALOG } from '../server/catalog.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'web', 'logos');
const TMP = path.join(ROOT, 'macos', '.build', 'logo-tmp');
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(TMP, { recursive: true });
const force = process.argv.includes('--force');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';

const G = (n) => `https://www.gstatic.com/images/branding/product/2x/${n}_2020q4_48dp.png`;
const WIKI = (t) => ({ wiki: t });
const SOURCES = {
  gmail: [G('gmail')], gcal: [G('calendar')], gdrive: [G('drive')], gdocs: [G('docs')], gsheets: [G('sheets')], gslides: [G('slides')], gmeet: [G('meet')],
  ganalytics: ['https://www.gstatic.com/analytics-suite/header/suite/v2/ic_analytics.svg', 'https://www.gstatic.com/images/branding/product/2x/analytics_48dp.png'],
  gads: ['https://www.gstatic.com/images/branding/product/2x/ads_48dp.png'],
  youtube: [WIKI('YouTube full-color icon (2017).svg'), 'https://www.youtube.com/'],
  outlook: [WIKI('Microsoft Outlook Icon (2025–present).svg'), WIKI('Microsoft Office Outlook (2018–present).svg')],
  outlookcal: [WIKI('Microsoft Outlook Icon (2025–present).svg'), WIKI('Microsoft Office Outlook (2018–present).svg')],
  teams: [WIKI('Microsoft Teams Icon (2025–present).svg'), WIKI('Microsoft Office Teams (2018–present).svg')],
  onedrive: [WIKI('Microsoft OneDrive Icon (2025–present).svg'), WIKI('Microsoft Office OneDrive (2019–present).svg')],
  sharepoint: [WIKI('Microsoft SharePoint Icon (2025–present).svg'), WIKI('Microsoft Office SharePoint (2019–present).svg')],
  word: [WIKI('Microsoft Office Word (2025–present).svg'), WIKI('Microsoft Office Word (2019–2025).svg')],
  excel: [WIKI('Microsoft Office Excel (2025–present).svg'), WIKI('Microsoft Office Excel (2019–2025).svg')],
  powerpoint: [WIKI('Microsoft Office PowerPoint (2025–present).svg'), WIKI('Microsoft Office PowerPoint (2019–2025).svg')],
  linkedin: [WIKI('LinkedIn icon.svg'), WIKI('LinkedIn logo initials.png'), 'https://www.linkedin.com/'],
  canva: [WIKI('Canva icon 2021.svg'), WIKI('Canva Logo.svg'), 'https://www.canva.com/'],
  amazon: [WIKI('Amazon icon.svg'), WIKI('Amazon logo.svg'), 'https://www.amazon.com/'],
  imessage: [WIKI('IMessage logo.svg')],
  mac_calendar: [WIKI('Apple Calendar (iOS).svg')],
  mac_contacts: [WIKI('Contacts (iOS).png'), WIKI('Contacts (iOS).svg')],
  mac_reminders: [WIKI('Reminders (iOS).svg'), WIKI('Reminders (iOS).png'), WIKI('Apple Reminders icon.png')],
  mac_notify: [WIKI('Clock (iOS).png')],
  slack: ['https://slack.com/'], zoom: ['https://zoom.us/'], discord: ['https://discord.com/'], whatsapp: ['https://www.whatsapp.com/'], telegram: ['https://telegram.org/'],
  notion: ['https://www.notion.so/'], linear: ['https://linear.app/'],
  // jira, confluence and the Simple Icons fallbacks are written by scripts/simple-logos.mjs asana: ['https://asana.com/'], trello: ['https://trello.com/'],
  monday: ['https://monday.com/'], clickup: ['https://clickup.com/'], airtable: ['https://www.airtable.com/'], calendly: ['https://calendly.com/'],
  figma: ['https://www.figma.com/'], dropbox: ['https://www.dropbox.com/'], box: ['https://www.box.com/'],
  github: ['https://github.com/'], gitlab: ['https://about.gitlab.com/'], sentry: ['https://sentry.io/'], pagerduty: ['https://www.pagerduty.com/'],
  vercel: ['https://vercel.com/'], datadog: ['https://www.datadoghq.com/'], salesforce: ['https://www.salesforce.com/'], hubspot: ['https://www.hubspot.com/'],
  pipedrive: ['https://www.pipedrive.com/'], linkedin: ['https://www.linkedin.com/'], apollo: ['https://www.apollo.io/'], gong: ['https://www.gong.io/'],
  zendesk: ['https://www.zendesk.com/'], intercom: ['https://www.intercom.com/'], freshdesk: ['https://www.freshworks.com/freshdesk/'],
  stripe: ['https://stripe.com/'], quickbooks: ['https://quickbooks.intuit.com/'], xero: ['https://www.xero.com/'], expensify: ['https://www.expensify.com/'],
  ramp: ['https://ramp.com/'], shopify: ['https://www.shopify.com/'], x: ['https://x.com/'],
  instagram: ['https://www.instagram.com/'], facebook: ['https://www.facebook.com/'], metaads: ['https://www.facebook.com/business/ads'],
  reddit: ['https://www.reddit.com/'], mailchimp: ['https://mailchimp.com/'], workday: ['https://www.workday.com/'], greenhouse: ['https://www.greenhouse.com/'],
};

async function get(url, as = 'text') {
  const r = await fetch(url, { headers: { 'User-Agent': /wiki(media|pedia)\.org/.test(url) ? 'TandemLogoFetcher/1.0 (github.com/NeilGilani/tandem)' : UA, Accept: as === 'text' ? 'text/html,*/*' : 'image/*,*/*' }, redirect: 'follow', signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return as === 'text' ? { body: await r.text(), url: r.url } : { body: Buffer.from(await r.arrayBuffer()), type: r.headers.get('content-type') || '', url: r.url };
}

async function wikiUrl(title) {
  await new Promise((r) => setTimeout(r, 1500));
  const api = `https://commons.wikimedia.org/w/api.php?action=query&titles=${encodeURIComponent('File:' + title)}&prop=imageinfo&iiprop=url&format=json&origin=*`;
  const j = JSON.parse((await get(api)).body);
  const page = Object.values(j.query?.pages || {})[0];
  return page?.imageinfo?.[0]?.url || null;
}

// Icons a page declares, best first.
function iconsFrom(html, base) {
  const out = [];
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    const rel = (tag.match(/rel=["']([^"']+)["']/i) || [])[1]?.toLowerCase() || '';
    if (!/icon/.test(rel) || /mask-icon/.test(rel)) continue;
    const href = (tag.match(/href=["']([^"']+)["']/i) || [])[1];
    if (!href) continue;
    const sizes = (tag.match(/sizes=["']([^"']+)["']/i) || [])[1] || '';
    const size = Math.max(0, ...sizes.split(/\s+/).map((s) => Number(s.split('x')[0]) || 0));
    const type = (tag.match(/type=["']([^"']+)["']/i) || [])[1] || '';
    let url; try { url = new URL(href, base).href; } catch { continue; }
    const svg = /svg/.test(type) || /\.svg(\?|$)/i.test(url);
    const score = svg ? 10000 : /apple-touch/.test(rel) ? 5000 + size : size || 100;
    out.push({ url, score });
  }
  out.push({ url: new URL('/apple-touch-icon.png', base).href, score: 4000 });
  out.push({ url: new URL('/favicon.ico', base).href, score: 1 });
  return out.sort((a, b) => b.score - a.score);
}

const safeSvg = (buf) => {
  const s = buf.toString('utf8');
  return /<svg[\s>]/i.test(s) && !/<script|\son\w+\s*=|javascript:|<foreignObject/i.test(s);
};

function pngSize(file) {
  try {
    const out = execFileSync('sips', ['-g', 'pixelWidth', file], { encoding: 'utf8' });
    return Number((out.match(/pixelWidth:\s*(\d+)/) || [])[1] || 0);
  } catch { return 0; }
}

async function tryImage(url, id) {
  const r = await get(url, 'buf');
  const isSvg = /svg/.test(r.type) || /\.svg(\?|$)/i.test(r.url);
  if (isSvg) {
    if (!safeSvg(r.body)) throw new Error('unsafe svg');
    return { ext: 'svg', body: r.body, size: 9999 };
  }
  // Raster: normalise to PNG with sips (handles .ico too) and measure.
  const raw = path.join(TMP, `${id}.raw`);
  const png = path.join(TMP, `${id}.png`);
  fs.writeFileSync(raw, r.body);
  try { execFileSync('sips', ['-s', 'format', 'png', raw, '--out', png], { stdio: 'ignore' }); } catch { throw new Error('not an image'); }
  const size = pngSize(png);
  if (size < 32) throw new Error(`too small (${size}px)`);
  if (size > 256) execFileSync('sips', ['-Z', '256', png], { stdio: 'ignore' });
  return { ext: 'png', body: fs.readFileSync(png), size };
}

async function fetchLogo(app) {
  const done = ['svg', 'png'].map((e) => path.join(OUT, `${app.id}.${e}`)).find((f) => fs.existsSync(f));
  if (done && !force) return { id: app.id, skipped: true };
  let best = null;
  // Services covered by scripts/simple-logos.mjs are left to it.
  if (['jira', 'confluence'].includes(app.id)) return { id: app.id, skipped: true };
  for (const src of SOURCES[app.id] || [app.url && new URL(app.url).origin + '/']) {
    if (!src) continue;
    try {
      if (src.wiki) { const u = await wikiUrl(src.wiki); if (!u) continue; best = await tryImage(u, app.id); break; }
      if (/\.(png|svg|ico)(\?|$)/i.test(src) || src.includes('gstatic.com/')) { best = await tryImage(src, app.id); break; }
      const page = await get(src);
      for (const ic of iconsFrom(page.body, page.url)) {
        try { const img = await tryImage(ic.url, app.id); if (!best || img.size > best.size) best = img; if (best.size >= 120) break; } catch {}
      }
      if (best) break;
    } catch {}
  }
  if (!best) return { id: app.id, error: 'no logo found' };
  for (const e of ['svg', 'png']) fs.rmSync(path.join(OUT, `${app.id}.${e}`), { force: true });
  fs.writeFileSync(path.join(OUT, `${app.id}.${best.ext}`), best.body);
  return { id: app.id, ext: best.ext, size: best.size };
}

const results = [];
for (const app of CATALOG) results.push(await fetchLogo(app));
const manifest = Object.fromEntries(fs.readdirSync(OUT).filter((f) => /\.(svg|png)$/.test(f)).map((f) => [f.replace(/\.(svg|png)$/, ''), `/logos/${f}`]));
fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify(manifest, null, 1));
for (const r of results) console.log(r.id.padEnd(14), r.skipped ? 'kept' : r.error ? `MISSING: ${r.error}` : `${r.ext} ${r.size}px`);
console.log(`\n${Object.keys(manifest).length}/${CATALOG.length} logos`);
