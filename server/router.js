// Automatic model routing. Like Grok Bot there is no model picker: each turn is
// sent to the Claude model that fits it.
const HEAVY = /\b(plan|strategy|research|analy[sz]e|investigate|debug|refactor|architect|compare|audit|reconcile|forecast|write (a|the) (report|proposal|spec)|deep dive|step[- ]by[- ]step|figure out|why (is|does|did))\b/i;
const LIGHT = /^(hi|hey|hello|thanks|thank you|ok|okay|cool|great|nice|yes|no|sure|got it|👍|🙏)[\s!.]*$/i;

export function pickModel(text = '', { origin = 'chat', attachments = 0 } = {}) {
  const t = String(text);
  if (LIGHT.test(t.trim())) return 'haiku';
  if (origin === 'mission') return 'opus'; // long unattended work gets the strongest model
  if (origin === 'routine' || origin === 'handoff' || origin === 'squad') return HEAVY.test(t) ? 'opus' : 'sonnet';
  if (HEAVY.test(t) || t.length > 1200 || attachments > 2) return 'opus';
  return 'sonnet';
}
