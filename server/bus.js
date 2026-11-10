// Server-sent events: every open app window (desktop or phone) gets live updates.
// Server modules (Telegram, the relay) can listen to the same events with on().
const clients = new Set();
const listeners = new Set();

export function subscribe(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write(': connected\n\n');
  clients.add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  res.on('close', () => { clearInterval(ping); clients.delete(res); });
}

export function emit(type, data = {}) {
  const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(payload);
  for (const fn of listeners) { try { fn(type, data); } catch (e) { console.error('listener', e.message); } }
}

export function on(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export const clientCount = () => clients.size;
