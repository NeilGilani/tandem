// Five-field cron ("m h dom mon dow") evaluated in a chosen IANA time zone.
const RANGES = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]];

function field(spec, [lo, hi]) {
  const out = new Set();
  for (const part of spec.split(',')) {
    const [range, stepStr] = part.split('/');
    const step = stepStr ? Number(stepStr) : 1;
    let [a, b] = range === '*' ? [lo, hi] : range.split('-').map(Number);
    if (b === undefined) b = stepStr ? hi : a;
    if ([a, b, step].some((n) => Number.isNaN(n)) || a < lo || b > hi || step < 1) throw new Error(`Bad cron field: ${spec}`);
    for (let v = a; v <= b; v += step) out.add(v === 7 && hi === 6 ? 0 : v);
  }
  return out;
}

export function parse(expr) {
  const parts = String(expr).trim().split(/\s+/);
  if (parts.length !== 5) throw new Error('Cron needs 5 fields');
  const f = parts.map((p, i) => field(p.replace(/^7$/, '0'), RANGES[i]));
  return { min: f[0], hour: f[1], dom: f[2], mon: f[3], dow: f[4], domStar: parts[2] === '*', dowStar: parts[4] === '*' };
}

function partsIn(date, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', weekday: 'short',
  }).formatToParts(date).map((x) => [x.type, x.value]));
  const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday);
  return { min: +p.minute, hour: +p.hour, dom: +p.day, mon: +p.month, dow };
}

function matches(c, t) {
  if (!c.min.has(t.min) || !c.hour.has(t.hour) || !c.mon.has(t.mon)) return false;
  const d = c.dom.has(t.dom), w = c.dow.has(t.dow);
  if (c.domStar && c.dowStar) return true;
  if (c.domStar) return w;
  if (c.dowStar) return d;
  return d || w; // standard cron: either day field
}

export function next(expr, tz, from = Date.now()) {
  const c = parse(expr);
  let t = Math.floor(from / 60000) * 60000 + 60000;
  const limit = t + 400 * 24 * 3600 * 1000;
  while (t < limit) {
    const p = partsIn(new Date(t), tz);
    if (!c.mon.has(p.mon) || (!c.domStar && !c.dowStar ? !(c.dom.has(p.dom) || c.dow.has(p.dow)) : (!c.domStar && !c.dom.has(p.dom)) || (!c.dowStar && !c.dow.has(p.dow)))) {
      t += (24 * 60 - (p.hour * 60 + p.min)) * 60000; // skip to the next local midnight
      continue;
    }
    if (!c.hour.has(p.hour)) { t += (60 - p.min) * 60000; continue; }
    if (matches(c, p)) return t;
    t += 60000;
  }
  return null;
}

// Grok Bot rule: schedules must be at least five minutes apart.
export function minGapOk(expr, tz) {
  let a = next(expr, tz);
  for (let i = 0; i < 50 && a; i++) {
    const b = next(expr, tz, a);
    if (b && b - a < 5 * 60000) return false;
    a = b;
  }
  return true;
}
