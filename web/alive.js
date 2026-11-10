// Makes Bot faces feel alive: eyes follow the cursor, look at the message box while you
// type, glance around while the Bot works, and squint happily when it finishes.
const MAX_X = 3.4, MAX_Y = 2.8;
let mx = innerWidth / 2, my = innerHeight / 2, lastMove = 0, frame = 0, typingUntil = 0;

function look(av, tx, ty) {
  const p = av.querySelector('.pupils');
  if (!p) return;
  const r = av.getBoundingClientRect();
  if (r.bottom < 0 || r.top > innerHeight || !r.width) return;
  const cx = r.left + r.width / 2, cy = r.top + r.height * 0.47;
  const dx = tx - cx, dy = ty - cy;
  const d = Math.hypot(dx, dy) || 1;
  const reach = Math.min(1, d / 160);
  p.setAttribute('transform', `translate(${((dx / d) * MAX_X * reach).toFixed(2)} ${((dy / d) * MAX_Y * reach).toFixed(2)})`);
}

function update() {
  frame = 0;
  const idle = Date.now() - lastMove > 5000;
  const ta = document.querySelector('.composer textarea');
  const typing = Date.now() < typingUntil && ta;
  let target = [mx, my];
  if (typing) { const r = ta.getBoundingClientRect(); target = [r.left + Math.min(r.width, 40 + ta.value.length * 6.5), r.top + r.height / 2]; }
  const avs = document.querySelectorAll('.av:not(.busy):not(.happy)');
  for (let i = 0; i < avs.length && i < 80; i++) {
    if (idle && !typing) avs[i].querySelector('.pupils')?.setAttribute('transform', 'translate(0 0)');
    else look(avs[i], ...target);
  }
}
const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };

addEventListener('mousemove', (e) => { mx = e.clientX; my = e.clientY; lastMove = Date.now(); schedule(); }, { passive: true });
addEventListener('scroll', schedule, { passive: true, capture: true });
addEventListener('input', (e) => { if (e.target.matches?.('.composer textarea')) { typingUntil = Date.now() + 1500; schedule(); } }, true);
setInterval(schedule, 1200);

// A happy squint for a moment when a Bot finishes.
export function cheer(botId) {
  document.querySelectorAll(`.av[data-bot="${botId}"]`).forEach((av) => {
    av.classList.add('happy');
    setTimeout(() => av.classList.remove('happy'), 2200);
  });
}
