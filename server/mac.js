// Native Mac apps as connectors: Calendar, Contacts, Reminders, Messages, notifications.
// Each runs a small JXA script through osascript. macOS asks for permission the
// first time each app is used.
import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import * as platform from './platform.js';

const jxa = (script, args = []) => new Promise((resolve, reject) => {
  execFile('osascript', ['-l', 'JavaScript', '-e', script, ...args.map(String)], { timeout: 60000, maxBuffer: 8 << 20 },
    (err, stdout, stderr) => (err ? reject(new Error((stderr || err.message).trim())) : resolve(stdout.trim())));
});
const parse = (s) => { try { return JSON.parse(s); } catch { return s; } };

export async function calendarEvents({ days = 7, calendar } = {}) {
  return parse(await jxa(`function run(a){
    const cal = Application('Calendar'); const start = new Date(); const end = new Date(Date.now() + Number(a[0]) * 864e5);
    const out = [];
    for (const c of cal.calendars()) {
      if (a[1] && c.name() !== a[1]) continue;
      for (const e of c.events.whose({ startDate: { _greaterThan: start }, endDate: { _lessThan: end } })()) {
        out.push({ calendar: c.name(), title: e.summary(), start: e.startDate(), end: e.endDate(), location: e.location() || '' });
      }
    }
    out.sort((x, y) => new Date(x.start) - new Date(y.start));
    return JSON.stringify(out.slice(0, 200));
  }`, [days, calendar || '']));
}

export async function calendarAdd({ title, start, end, calendar, location = '', notes = '' }) {
  return parse(await jxa(`function run(a){
    const cal = Application('Calendar');
    const c = a[3] ? cal.calendars.byName(a[3]) : cal.calendars().find(x => x.writable()) || cal.calendars()[0];
    const e = cal.Event({ summary: a[0], startDate: new Date(a[1]), endDate: new Date(a[2]), location: a[4], description: a[5] });
    c.events.push(e);
    return JSON.stringify({ created: a[0], calendar: c.name() });
  }`, [title, start, end || new Date(new Date(start).getTime() + 36e5).toISOString(), calendar || '', location, notes]));
}

export async function contactsSearch({ query }) {
  return parse(await jxa(`function run(a){
    const app = Application('Contacts'); const q = a[0].toLowerCase();
    const people = app.people.whose({ name: { _contains: a[0] } })().slice(0, 25);
    return JSON.stringify(people.map(p => ({
      name: p.name(), organization: p.organization() || '',
      emails: p.emails().map(e => e.value()), phones: p.phones().map(e => e.value()),
      birthday: p.birthDate() ? p.birthDate().toISOString().slice(0, 10) : null,
      addresses: p.addresses().map(x => x.formattedAddress()),
    })));
  }`, [query]));
}

export async function remindersList({ list, includeCompleted = false } = {}) {
  return parse(await jxa(`function run(a){
    const app = Application('Reminders'); const out = [];
    for (const l of app.lists()) {
      if (a[0] && l.name() !== a[0]) continue;
      const rs = a[1] === 'true' ? l.reminders() : l.reminders.whose({ completed: false })();
      for (const r of rs.slice(0, 200)) out.push({ list: l.name(), name: r.name(), due: r.dueDate(), completed: r.completed() });
    }
    return JSON.stringify(out);
  }`, [list || '', includeCompleted]));
}

export async function remindersAdd({ name, due, list, notes = '' }) {
  return parse(await jxa(`function run(a){
    const app = Application('Reminders');
    const l = a[2] ? app.lists.byName(a[2]) : app.defaultList();
    const props = { name: a[0], body: a[3] };
    if (a[1]) props.dueDate = new Date(a[1]);
    l.reminders.push(app.Reminder(props));
    return JSON.stringify({ added: a[0], list: l.name() });
  }`, [name, due || '', list || '', notes]));
}

export async function remindersComplete({ name }) {
  return parse(await jxa(`function run(a){
    const app = Application('Reminders'); let n = 0;
    for (const l of app.lists()) for (const r of l.reminders.whose({ name: a[0], completed: false })()) { r.completed = true; n++; }
    return JSON.stringify({ completed: n });
  }`, [name]));
}

export async function notify({ title = 'Tandem', message, inMinutes = 0 }) {
  const delay = Math.min(Math.max(Number(inMinutes) || 0, 0), 24 * 60);
  const fire = () => platform.WIN ? platform.notify(title, message).then((ok) => (ok ? 'ok' : 'Could not show the notification')) : jxa(`function run(a){ const app = Application.currentApplication(); app.includeStandardAdditions = true;
    app.displayNotification(a[1], { withTitle: a[0], soundName: 'Glass' }); return 'ok'; }`, [title, message]);
  if (!delay) return parse(await fire());
  setTimeout(() => fire().catch(() => {}), delay * 60000);
  return { scheduled: true, inMinutes: delay };
}

// Messages: reads ~/Library/Messages/chat.db (needs Full Disk Access for Node).
export async function messagesRecent({ limit = 30 } = {}) {
  const dbPath = path.join(os.homedir(), 'Library/Messages/chat.db');
  const { DatabaseSync } = await import('node:sqlite');
  let m;
  try { m = new DatabaseSync(dbPath, { readOnly: true }); }
  catch { throw new Error('Grant Full Disk Access to your terminal/Node in System Settings → Privacy & Security to read Messages.'); }
  try {
    return m.prepare(`SELECT datetime(message.date/1000000000 + 978307200, 'unixepoch', 'localtime') AS at,
      handle.id AS who, message.is_from_me AS from_me, message.text AS text
      FROM message LEFT JOIN handle ON message.handle_id = handle.ROWID
      WHERE message.text IS NOT NULL ORDER BY message.date DESC LIMIT ?`).all(Math.min(limit, 200));
  } finally { m.close(); }
}

export const TOOLS = {
  mac_calendar_events: calendarEvents,
  mac_calendar_add: calendarAdd,
  mac_contacts_search: contactsSearch,
  mac_reminders_list: remindersList,
  mac_reminders_add: remindersAdd,
  mac_reminders_complete: remindersComplete,
  mac_notify: notify,
  mac_messages_recent: messagesRecent,
};
