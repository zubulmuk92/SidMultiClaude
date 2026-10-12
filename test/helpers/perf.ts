// Perf budgets of the unit suite (SPEC §9.5). `npm test` runs its files in parallel on a shared machine, which slows a
// wall-clock measure 2–10× (preemption, not work). SMC_PERF=1 (idle machine) asserts the SPEC budget on the wall clock;
// the default tier asserts a 4× wall bound, or, for `timed` measures, the process CPU time spent (each test file runs in
// its own process, so another file's load does not count) against 2× the budget (shared cores, 15.6 ms Windows ticks).
export const PERF = process.env['SMC_PERF'] === '1';
export const budget = (ms: number): number => (PERF ? ms : ms * 4);
export type Timed = { wall: number; cpu: number };
export async function timed<T>(fn: () => Promise<T> | T): Promise<Timed & { value: T }> {
  const c0 = process.cpuUsage();
  const t0 = performance.now();
  const value = await fn();
  const wall = performance.now() - t0;
  const c = process.cpuUsage(c0);
  return { value, wall, cpu: (c.user + c.system) / 1000 };
}
/** Whether a timed measure meets a SPEC budget (see above). */
export const within = (t: Timed, ms: number): boolean => (PERF ? t.wall < ms : t.wall < ms || t.cpu < ms * 2);
export const timedText = (t: Timed): string => `${t.wall.toFixed(0)} ms wall, ${t.cpu.toFixed(0)} ms CPU`;
