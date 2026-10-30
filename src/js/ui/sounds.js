/* Relik — звуки: уведомление о сообщении, отправка, звонок */

let ctx = null;

function ensureCtx() {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;
  if (!ctx || ctx.state === 'closed') ctx = new Ctx();
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

function tone(freq, start, dur, gainValue = 0.12, type = 'sine') {
  const c = ensureCtx();
  if (!c) return;
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  const t0 = c.currentTime + start;
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gainValue, t0 + 0.015);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g).connect(c.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

export function soundsEnabled() {
  return localStorage.getItem('relik.sounds') !== 'off';
}

export function setSounds(on) {
  localStorage.setItem('relik.sounds', on ? 'on' : 'off');
  if (on) playTest();
}

export function playMessage() {
  if (!soundsEnabled()) return;
  tone(880, 0, 0.09, 0.10);
  tone(1174, 0.10, 0.12, 0.09);
}

export function playSent() {
  if (!soundsEnabled()) return;
  tone(520, 0, 0.06, 0.05);
}

export function playTest() {
  tone(660, 0, 0.10, 0.09);
  tone(990, 0.12, 0.14, 0.09);
}

/* Гудки вызова: повторяющийся мягкий паттерн */
let ringTimer = 0;

export function startRing() {
  if (!soundsEnabled() || ringTimer) return;
  const pattern = () => {
    tone(440, 0, 0.35, 0.10);
    tone(480, 0.5, 0.35, 0.10);
  };
  pattern();
  ringTimer = setInterval(pattern, 2000);
}

export function stopRing() {
  if (ringTimer) { clearInterval(ringTimer); ringTimer = 0; }
}
