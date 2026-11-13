/* MIT. One playback clock; resource jobs cannot create or replace it. */
(() => {
  'use strict';
  class PlaybackClock {
    constructor({ resources, onState, onEnded, trace }) {
      this.resources = resources; this.onState = onState; this.onEnded = onEnded; this.trace = trace;
      this.ctx = null; this.gain = null; this.generation = 0; this.volume = 1;
      this.active = new Set();
    }
    async open(entry) {
      if (this.ctx?.state === 'closed') this.ctx = null;
      if (this.ctx && this.ctx.sampleRate !== entry.spec.rate) {
        if (this.active.size) throw new Error('native-only-sample-rate');
        const previous = this.ctx; this.ctx = null; await previous.close();
      }
      if (!this.ctx) {
        const ctx = this.ctx = new AudioContext({ sampleRate: entry.spec.rate, latencyHint: 'playback' });
        this.generation++;
        this.gain = ctx.createGain(); this.gain.gain.value = this.volume; this.gain.connect(ctx.destination);
        ctx.onstatechange = () => { if (this.ctx === ctx) this.onState(ctx.state); };
      }
      if (this.ctx.state === 'suspended') {
        // Autoplay may leave resume pending indefinitely until a real user gesture.
        let timer;
        try { await Promise.race([this.ctx.resume(), new Promise((resolve, reject) => {
          timer = setTimeout(() => reject(new Error('native-only-context-awaiting-gesture')), 1500);
        })]); } finally { clearTimeout(timer); }
      }
      if (!this.matches(entry) || this.ctx.state !== 'running') throw new Error('native-only-context');
      // A running state can precede the first output block. Keep the native
      // player audible until the output timestamp actually advances; otherwise
      // the handoff makes the listener wait for a cold output device.
      const ctx = this.ctx, started = performance.now();
      if (typeof ctx.getOutputTimestamp !== 'function') throw new Error('native-only-output-clock');
      const initial = ctx.getOutputTimestamp();
      for (;;) {
        if (this.ctx !== ctx || ctx.state !== 'running' || !this.matches(entry)) throw new Error('native-only-context');
        const stamp = ctx.getOutputTimestamp();
        if (stamp.contextTime > Math.max(0, initial.contextTime)
          && stamp.performanceTime > Math.max(0, initial.performanceTime)) {
          this.trace('output-ready', { waitMs: performance.now() - started, contextTime: ctx.currentTime,
            outputContextTime: stamp.contextTime });
          return ctx;
        }
        if (performance.now() - started >= 500) throw new Error('native-only-output-clock-timeout');
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    }
    matches(entry) { return !!entry?.buffer && entry.spec.rate === entry.buffer.sampleRate
      && entry.spec.channels === entry.buffer.numberOfChannels && this.ctx?.sampleRate === entry.spec.rate; }
    position(track) {
      if (!track) return 0;
      const advance = track.node && track.playing ? Math.max(0, this.ctx.currentTime - track.start) : 0;
      return Math.max(0, Math.min(track.duration || Infinity, track.offset + advance));
    }
    heard(track) {
      return (track?.heard || 0) + (track?.node && track.playing
        ? Math.max(0, Math.min(this.ctx.currentTime, track.end) - track.start) : 0);
    }
    stop(track) {
      if (!track) return;
      track.offset = this.position(track); track.heard = this.heard(track); track.playing = false;
      if (!track.node) return;
      const node = track.node; track.node = null; node.onended = null;
      try { node.stop(); } catch { /* Already ended. */ }
      node.disconnect(); this.active.delete(track); this.resources.unpin(track.entry);
    }
    start(track, at, offset = track.offset || 0) {
      if (this.ctx?.state !== 'running' || !this.matches(track.entry)) throw new Error('native-only-context');
      this.stop(track);
      const node = this.ctx.createBufferSource(), generation = this.generation;
      node.buffer = track.entry.buffer; node.connect(this.gain);
      track.offset = Math.min(Math.max(0, offset), track.duration - 0.001);
      track.start = at; track.end = at + track.duration - track.offset;
      track.node = node; track.playing = true; track.clockGeneration = generation;
      this.active.add(track); this.resources.pin(track.entry);
      node.onended = () => {
        if (track.node !== node || generation !== this.generation) return;
        track.heard = this.heard(track); track.offset = track.duration; track.playing = false;
        track.node = null; node.disconnect(); this.active.delete(track); this.resources.unpin(track.entry);
        this.onEnded(track);
      };
      try { node.start(at, track.offset); }
      catch (error) { this.stop(track); throw error; }
    }
    setVolume(value) {
      if (!Number.isFinite(value)) return;
      this.volume = Math.max(0, Math.min(1, value));
      if (this.gain) this.gain.gain.value = this.volume;
    }
    async close() {
      for (const track of [...this.active]) this.stop(track);
      const ctx = this.ctx; this.ctx = null; this.gain = null; this.generation++;
      if (ctx?.state !== 'closed') await ctx?.close();
    }
    status() { return { sampleRate: this.ctx?.sampleRate, contextState: this.ctx?.state,
      contextGeneration: this.generation, activeNodes: this.active.size, deviceFormat: 'unknown' }; }
  }
  globalThis.GaplessPlaybackClock = PlaybackClock;
})();
