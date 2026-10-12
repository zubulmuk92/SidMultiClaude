// @ts-check
// src/web/lib/sound.js — notification sounds with WebAudio oscillators (no audio files; ux §11).
// 'chime' = two-tone (needs), 'tick' = soft tick (done), 'low' = low tone (error / limit). Volume 0..1 from Réglages.

/** @type {AudioContext | null} */
let ctx = null;
/** @type {Record<'chime' | 'tick' | 'low', [freq: number, start: number, dur: number][]>} */
const SHAPES = {
  chime: [[880, 0, 0.14], [1320, 0.16, 0.2]],
  tick: [[1760, 0, 0.05]],
  low: [[220, 0, 0.3]],
};

/** @param {number} volume 0..1 @param {'chime' | 'tick' | 'low'} [kind] @returns {boolean} played */
export function playChime(volume, kind = 'chime') {
  const v = Math.max(0, Math.min(1, volume));
  if (v === 0) return false;
  try {
    const AC = globalThis.AudioContext;
    if (!AC) return false;
    ctx ??= new AC();
    if (ctx.state === 'suspended') void ctx.resume();
    const t0 = ctx.currentTime + 0.01;
    for (const [freq, start, dur] of SHAPES[kind]) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, t0 + start);
      gain.gain.linearRampToValueAtTime(0.25 * v, t0 + start + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + start + dur);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t0 + start);
      osc.stop(t0 + start + dur + 0.02);
    }
    return true;
  } catch { return false; }
}
