// Voice chat with a Bot: you talk, it listens, works if it needs to, and answers out loud.
// Uses the browser's speech recognition and the Mac's voices, so it's free.
import { api, h, avatar, icon, toast } from './lib.js';
import { S, bot, chat, runsIn, on } from './store.js';

let call = null;

const plain = (md) => String(md || '')
  .replace(/```[\s\S]*?```/g, ' ').replace(/`([^`]+)`/g, '$1').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
  .replace(/https?:\/\/\S+/g, 'a link').replace(/[*_#>|]+/g, '').replace(/^\s*[-•]\s+/gm, '').replace(/\n{2,}/g, '. ').replace(/\n/g, ' ').trim();

function pickVoice() {
  const voices = speechSynthesis.getVoices().filter((v) => /^en/i.test(v.lang));
  const prefs = [/premium/i, /enhanced/i, /siri/i, /^(Ava|Zoe|Evan|Nathan|Samantha|Daniel|Karen|Moira|Tessa)/];
  for (const p of prefs) { const v = voices.find((x) => p.test(x.name)); if (v) return v; }
  return voices.find((v) => v.localService) || voices[0] || null;
}

export function startCall(chatId) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR || !('speechSynthesis' in window)) return toast('Voice chat needs Chrome, Edge or Safari', 'bad');
  const c = chat(chatId);
  const b = bot(c.kind === 'dm' ? c.bot_ids[0] : c.bot_ids[0]);
  if (call) endCall();

  const statusEl = h('div', { style: { color: 'var(--text-2)', fontSize: '15px', minHeight: '22px' } }, 'Connecting');
  const heard = h('div', { style: { color: 'var(--text)', fontSize: '17px', minHeight: '48px', maxWidth: '520px', textAlign: 'center', lineHeight: 1.4 } });
  const said = h('div', { style: { color: 'var(--text-2)', fontSize: '15px', minHeight: '40px', maxWidth: '520px', textAlign: 'center', lineHeight: 1.45 } });
  const face = h('div', { style: { transition: 'transform .2s', borderRadius: '50%' } }, avatar(b, 132, { blink: true }));
  const timer = h('div.hint', '0:00');
  const muteBtn = h('button.round', { style: { width: '52px', height: '52px' }, title: 'Mute', on: { click: () => { call.muted = !call.muted; muteBtn.style.background = call.muted ? 'var(--text)' : ''; muteBtn.style.color = call.muted ? 'var(--bg)' : ''; if (call.muted) { try { call.rec.stop(); } catch {} setStatus('Muted'); } else listen(); } } }, icon('mic'));
  const endBtn = h('button.round', { style: { width: '52px', height: '52px', background: 'var(--bad)', color: '#fff' }, title: 'End call', on: { click: endCall } }, icon('hangup'));
  const el = h('div.viewer', { style: { alignItems: 'center', justifyContent: 'center', gap: '18px', background: 'var(--bg)' } },
    h('div', { style: { position: 'absolute', top: '16px', left: '20px', fontWeight: 600 } }, b.name),
    face, statusEl, heard, said, timer, h('div.hstack', { style: { gap: '18px', marginTop: '10px' } }, muteBtn, endBtn));
  document.body.append(el);

  const rec = new SR();
  rec.continuous = true; rec.interimResults = true; rec.lang = navigator.language || 'en-US';
  call = { chatId, botId: b.id, el, rec, muted: false, speaking: false, waiting: false, buffer: '', silenceTimer: null, started: Date.now(), sentAt: 0 };
  call.tick = setInterval(() => { const s = Math.round((Date.now() - call.started) / 1000); timer.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }, 1000);

  function setStatus(t) { statusEl.textContent = t; }
  function listen() {
    if (!call || call.muted || call.speaking || call.waiting) return;
    setStatus('Listening');
    face.style.transform = 'scale(1)';
    try { rec.start(); } catch {}
  }
  call.listen = listen;
  call.setStatus = setStatus;
  call.face = face; call.said = said; call.heard = heard;

  rec.onresult = (e) => {
    let interim = '', final = '';
    for (let i = e.resultIndex; i < e.results.length; i++) (e.results[i].isFinal ? (final += e.results[i][0].transcript) : (interim += e.results[i][0].transcript));
    if (final) call.buffer += (call.buffer ? ' ' : '') + final.trim();
    heard.textContent = (call.buffer + ' ' + interim).trim();
    clearTimeout(call.silenceTimer);
    // Send after a short pause in speech.
    call.silenceTimer = setTimeout(() => { if (call?.buffer.trim()) send(); }, 1300);
  };
  rec.onend = () => { if (call && !call.speaking && !call.waiting && !call.muted) setTimeout(listen, 200); };
  rec.onerror = (e) => { if (e.error === 'not-allowed') { toast('Allow microphone access to talk to your Bot', 'bad'); endCall(); } };

  async function send() {
    const text = call.buffer.trim();
    call.buffer = '';
    if (!text) return;
    call.waiting = true;
    try { rec.stop(); } catch {}
    setStatus('Thinking');
    said.textContent = '';
    call.sentAt = Date.now();
    try { await api('POST', `/api/chats/${chatId}/messages`, { text, voice: true }); }
    catch (e) { toast(e.message, 'bad'); call.waiting = false; listen(); }
  }

  speechSynthesis.getVoices();
  setTimeout(listen, 300);
}

function speak(text) {
  if (!call) return;
  const t = plain(text).slice(0, 900);
  if (!t) { call.waiting = false; call.listen(); return; }
  call.speaking = true; call.waiting = false;
  call.said.textContent = t;
  call.setStatus('Speaking');
  const u = new SpeechSynthesisUtterance(t);
  const v = pickVoice();
  if (v) u.voice = v;
  u.rate = 1.04;
  let pulse = setInterval(() => { if (call) call.face.style.transform = call.face.style.transform === 'scale(1.05)' ? 'scale(1)' : 'scale(1.05)'; }, 260);
  u.onend = u.onerror = () => { clearInterval(pulse); if (!call) return; call.speaking = false; call.face.style.transform = 'scale(1)'; call.heard.textContent = ''; call.listen(); };
  speechSynthesis.cancel();
  speechSynthesis.speak(u);
}

export function endCall() {
  if (!call) return;
  clearInterval(call.tick);
  clearTimeout(call.silenceTimer);
  try { call.rec.abort(); } catch {}
  speechSynthesis.cancel();
  call.el.remove();
  call = null;
}

// The Bot's reply in this chat gets read out.
on('message', (m) => {
  if (!call || m.chat_id !== call.chatId || m.author !== 'bot' || m.bot_id !== call.botId) return;
  if (m.created < call.sentAt) return;
  if (m.card?.type === 'approval' || m.card?.type === 'question' || m.card?.type === 'draft') {
    speak(m.card.type === 'approval' ? `I need your OK on the screen: ${m.card.summary}.` : m.card.type === 'draft' ? 'I drafted that for you. It’s on the screen for you to send.' : m.card.question);
    return;
  }
  if (m.text) speak(m.text);
});
on('run', (r) => {
  if (!call || r.chatId !== call.chatId || r.botId !== call.botId) return;
  if (!r.ended && call.waiting) call.setStatus(r.status || 'Working');
  if (r.ended && call.waiting && !runsIn(call.chatId).length) setTimeout(() => { if (call?.waiting) { call.waiting = false; call.listen(); } }, 1500);
});
document.addEventListener('keydown', (e) => { if (call && e.key === 'Escape') endCall(); });
