// Gmail for the whole team, without a browser. You connect once with a Gmail app password
// (stored in the Keychain); every Bot then searches, reads and organizes mail through Gmail's
// own IMAP server at the same time, and drafts you approve are sent through Gmail's SMTP
// server, landing in your Sent folder. No browser sessions, so nothing for Google to sign out.
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import { simpleParser } from 'mailparser';
import { PATHS, setting, setSetting } from './db.js';
import { emit } from './bus.js';

const SERVICE = 'Tandem accounts';
const NS = crypto.createHash('sha1').update(PATHS.data).digest('hex').slice(0, 8);
const ITEM = `${NS}:gmail-app-password`;
const sh = (args) => new Promise((resolve, reject) => execFile('security', args, (err, out) => (err ? reject(err) : resolve(out.trim()))));

export const email = () => setting('gmail_email') || '';
export const connected = () => !!email();

async function password() {
  const p = await sh(['find-generic-password', '-s', SERVICE, '-a', ITEM, '-w']).catch(() => '');
  if (!p) throw new Error('Gmail is not connected. Call request_connect with "Gmail".');
  return p;
}

const imapFor = (user, pass) => new ImapFlow({ host: 'imap.gmail.com', port: 993, secure: true, auth: { user, pass }, logger: false, emitLogs: false });

// One IMAP session per call keeps things simple and safe with many Bots at once.
async function withImap(fn, mailbox = '[Gmail]/All Mail') {
  const client = imapFor(email(), await password());
  await client.connect();
  const lock = await client.getMailboxLock(mailbox);
  try { return await fn(client); } finally { lock.release(); await client.logout().catch(() => {}); }
}

export async function connect({ address, appPassword }) {
  const user = String(address || '').trim();
  const pass = String(appPassword || '').replace(/\s+/g, '');
  if (!/@/.test(user) || pass.length < 12) throw new Error('Enter your Gmail address and the 16-letter app password.');
  const client = imapFor(user, pass);
  try { await client.connect(); await client.logout(); }
  catch (e) {
    const why = `${e.responseText || ''} ${e.serverResponseCode || ''} ${e.message || ''}`;
    if (e.authenticationFailed || /AUTHENTICATIONFAILED|Invalid credentials|auth/i.test(why)) throw new Error('Gmail rejected that app password. Check the address and paste the 16 letters again.');
    throw new Error(`Couldn't reach Gmail: ${(e.responseText || e.message || 'unknown error').slice(0, 160)}`);
  }
  await sh(['add-generic-password', '-U', '-s', SERVICE, '-a', ITEM, '-l', 'Tandem: Gmail app password', '-w', pass]);
  setSetting('gmail_email', user);
  emit('connectors');
  return { email: user };
}

export async function disconnect() {
  await sh(['delete-generic-password', '-s', SERVICE, '-a', ITEM]).catch(() => {});
  setSetting('gmail_email', '');
  emit('connectors');
}

const addr = (a) => (a?.value || []).map((x) => (x.name ? `${x.name} <${x.address}>` : x.address)).join(', ');

// Gmail search syntax works as-is: from:alex is:unread newer_than:7d, etc.
export async function search(query = 'in:inbox', limit = 15) {
  return withImap(async (c) => {
    const uids = (await c.search({ gmraw: query || 'in:inbox' }, { uid: true })) || [];
    const pick = uids.slice(-Math.min(Number(limit) || 15, 50)).reverse();
    const out = [];
    for await (const m of c.fetch(pick, { uid: true, envelope: true, flags: true, labels: true, threadId: true, source: { start: 0, maxLength: 6000 } }, { uid: true })) {
      let snippet = '';
      try { const p = await simpleParser(m.source); snippet = (p.text || '').replace(/\s+/g, ' ').trim().slice(0, 200); } catch {}
      out.push({ id: m.uid, thread: m.threadId, date: m.envelope?.date, from: (m.envelope?.from || []).map((x) => x.name || x.address).join(', '),
        fromEmail: m.envelope?.from?.[0]?.address, subject: m.envelope?.subject || '(no subject)', unread: !m.flags?.has('\\Seen'), labels: [...(m.labels || [])].filter((l) => !/^\\/.test(l)), snippet });
    }
    return out.sort((a, b) => new Date(b.date) - new Date(a.date));
  });
}

export async function read(id) {
  return withImap(async (c) => {
    const m = await c.fetchOne(String(id), { uid: true, source: true, threadId: true, labels: true }, { uid: true });
    if (!m) throw new Error('No email with that id');
    const p = await simpleParser(m.source);
    return { id: m.uid, thread: m.threadId, messageId: p.messageId, date: p.date, from: addr(p.from), to: addr(p.to), cc: addr(p.cc), subject: p.subject || '',
      text: (p.text || (p.html ? p.html.replace(/<[^>]+>/g, ' ') : '')).replace(/\n{3,}/g, '\n\n').trim().slice(0, 20000),
      attachments: (p.attachments || []).map((a) => `${a.filename || 'file'} (${a.contentType}, ${Math.round(a.size / 1024)} KB)`) };
  });
}

// Archive, mark read or unread, star, or add and remove labels.
export async function update(id, { archive, read: isRead, star, addLabel, removeLabel } = {}) {
  return withImap(async (c) => {
    const u = String(id);
    if (isRead === true) await c.messageFlagsAdd(u, ['\\Seen'], { uid: true });
    if (isRead === false) await c.messageFlagsRemove(u, ['\\Seen'], { uid: true });
    if (star === true) await c.messageFlagsAdd(u, ['\\Flagged'], { uid: true });
    if (star === false) await c.messageFlagsRemove(u, ['\\Flagged'], { uid: true });
    if (addLabel) await c.messageFlagsAdd(u, [addLabel], { uid: true, useLabels: true });
    if (removeLabel) await c.messageFlagsRemove(u, [removeLabel], { uid: true, useLabels: true });
    if (archive) await c.messageFlagsRemove(u, ['\\Inbox'], { uid: true, useLabels: true });
    return 'Done.';
  });
}

// Send through Gmail (only for drafts the user approved). Replies stay in their thread.
export async function send({ to, cc, subject, body, inReplyTo }) {
  const transport = nodemailer.createTransport({ host: 'smtp.gmail.com', port: 465, secure: true, auth: { user: email(), pass: await password() } });
  const info = await transport.sendMail({ from: email(), to, cc: cc || undefined, subject: subject || '', text: body,
    ...(inReplyTo ? { inReplyTo, references: inReplyTo } : {}) });
  return { messageId: info.messageId, accepted: info.accepted };
}

// For a reply: find the message we're answering so the reply threads under it.
export async function replyTarget(thread, to) {
  if (!thread && !to) return null;
  const q = /^<.+>$/.test(thread || '') ? `rfc822msgid:${thread.slice(1, -1)}` : `from:${String(to).split(',')[0].trim()}`;
  const hits = await search(q, 1).catch(() => []);
  if (!hits[0]) return null;
  const m = await read(hits[0].id).catch(() => null);
  return m?.messageId || null;
}
