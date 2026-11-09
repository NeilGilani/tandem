// Server-sent events: every open app window (desktop or phone) gets live updates.
const clients = new Set();

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
}
