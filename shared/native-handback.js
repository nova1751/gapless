/* MIT. Bounded, cancellable native handback; platform commands remain injected. */
(() => {
  'use strict';
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function until(at, valid) {
    while (performance.now() < at) {
      if (!valid()) throw new Error('handback-cancelled');
      await delay(Math.min(8, Math.max(1, at - performance.now())));
    }
    if (!valid()) throw new Error('handback-cancelled');
  }
  function fit(reports, now = performance.now()) {
    const recent = reports.filter(r => now - r.at < 250);
    if (recent.length < 4 || recent[recent.length - 1].at - recent[0].at < 70)
      throw new Error('native-clock-insufficient');
    const offsets = recent.map(r => r.position - r.at / 1000).sort((a,b) => a-b);
    const base = offsets[Math.floor(offsets.length / 2)];
    const errors = offsets.map(v => Math.abs(v - base)).sort((a,b) => a-b);
    if (errors[Math.floor(errors.length / 2)] > 0.012) throw new Error('native-clock-unstable');
    return { position: now / 1000 + base, at: now, spreadMs: errors[Math.floor(errors.length / 2)] * 1000 };
  }
  async function run({ track, clock, native, valid, trace }) {
    const check = () => { if (!valid()) throw new Error('handback-cancelled'); };
    let correction = 0.06, alignment;
    await native.prepare(); check();
    await native.mute(); check();
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) { await native.prepare(true); check(); }
      const position = clock.outputPosition(track) + correction;
      if (position < 0 || track.duration - position < 1) throw new Error('handback-too-late');
      await native.seek(position); check();
      await native.play(); check();
      const deadline = performance.now() + 700;
      for (;;) {
        check();
        try { alignment = fit(native.reports()); break; }
        catch (error) { if (performance.now() >= deadline) throw error; }
        await delay(10);
      }
      alignment.error = alignment.position - clock.outputPosition(track);
      trace('handback-alignment', { attempt, errorMs: alignment.error * 1000, spreadMs: alignment.spreadMs });
      if (Math.abs(alignment.error) <= 0.012) break;
      correction = Math.max(-0.4, Math.min(0.4, correction - alignment.error));
    }
    if (!alignment || Math.abs(alignment.error) > 0.025) throw new Error('native-clock-not-aligned');
    check();
    const cutAt = clock.ctx.currentTime + 0.08;
    const cutWall = clock.outputWallTime(cutAt);
    clock.setOutput(false, cutAt);
    await until(cutWall - native.outputLeadMs(), valid);
    await native.unmute(); check();
    await until(cutWall + 5, valid);
    return { ...alignment, cutAt, cutWall };
  }
  globalThis.GaplessNativeHandback = Object.freeze({ run, fit });
})();
