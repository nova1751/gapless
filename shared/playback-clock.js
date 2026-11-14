/* MIT. One playback clock; resource jobs cannot create or replace it. */
(() => {
  'use strict';
  class PlaybackClock {
    constructor({ resources, onState, onEnded, trace }) {
      this.resources = resources; this.onState = onState; this.onEnded = onEnded; this.trace = trace;
      this.ctx = null; this.gain = null; this.generation = 0; this.volume = 1;
      this.active = new Set(); this.retiring = new Map();
      this.outputSwitch = { before: true, enabled: true, at: 0 };
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
        this.gain = ctx.createGain(); this.applyOutputVolume(); this.gain.connect(ctx.destination);
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
    // currentTime is the rendering clock, ahead of the sound leaving the
    // device. Handoffs use the output timestamp instead of that future PCM.
    outputTime() {
      const stamp = this.ctx?.getOutputTimestamp();
      if (!stamp || !(stamp.performanceTime > 0)) throw new Error('native-only-output-clock');
      return Math.min(this.ctx.currentTime, stamp.contextTime + Math.max(0, performance.now() - stamp.performanceTime) / 1000);
    }
    outputPosition(track) {
      if (!track?.playing || !track.node) return this.position(track);
      return Math.max(0, Math.min(track.duration, track.offset + Math.max(0, this.outputTime() - track.start)));
    }
    outputWallTime(contextTime) {
      const stamp = this.ctx.getOutputTimestamp();
      if (!(stamp.performanceTime > 0)) throw new Error('native-only-output-clock');
      return stamp.performanceTime + (contextTime - stamp.contextTime) * 1000;
    }
    setOutput(enabled, at = this.ctx?.currentTime || 0) {
      const now = this.ctx?.currentTime || 0, old = this.outputSwitch;
      const before = now < old.at ? old.before : old.enabled;
      this.outputSwitch = { before, enabled, at: Math.max(now, at) };
      this.applyOutputVolume();
    }
    applyOutputVolume() {
      if (!this.gain) return;
      const now = this.ctx.currentTime, s = this.outputSwitch;
      this.gain.gain.cancelScheduledValues(now);
      this.gain.gain.setValueAtTime((now < s.at ? s.before : s.enabled) ? this.volume : 0, now);
      if (s.at > now) this.gain.gain.setValueAtTime(s.enabled ? this.volume : 0, s.at);
    }
    heard(track) {
      return (track?.heard || 0) + (track?.node && track.playing
        ? Math.max(0, Math.min(this.ctx.currentTime, track.end) - track.start) : 0)
        - (track?.heardUntil ? Math.max(0, track.heardUntil - this.ctx.currentTime) : 0);
    }
    stop(track) {
      if (!track) return;
      track.offset = this.position(track); track.heard = this.heard(track); track.playing = false;
      track.heardUntil = 0;
      for (const [node, retired] of this.retiring) if (retired.track === track) {
        try { node.stop(); } catch { /* Already ended. */ }
        retired.finish();
      }
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
    seek(track, offset) {
      if (!track.node || !track.playing) { this.stop(track); track.offset = offset; return; }
      if (this.ctx?.state !== 'running' || !this.matches(track.entry)) throw new Error('native-only-context');
      // Keep sounding until the replacement starts at the same render boundary.
      const quantum = 128 / this.ctx.sampleRate;
      const at = Math.min(track.end, Math.ceil((this.ctx.currentTime + quantum) / quantum) * quantum);
      const previous = track.node, entry = track.entry;
      const node = this.ctx.createBufferSource(), generation = this.generation;
      const heard = this.heard(track) + Math.max(0, at - this.ctx.currentTime);
      node.buffer = entry.buffer; node.connect(this.gain);
      try { node.start(at, offset); }
      catch (error) { node.disconnect(); throw error; }
      try { previous.stop(at); }
      catch (error) {
        // Leave the current track intact; the bridge can restore native playback.
        try { node.stop(); } catch { /* Replacement already ended. */ }
        node.disconnect(); throw error;
      }
      const retired = { track, finish: () => {
        if (!this.retiring.delete(previous)) return;
        previous.onended = null; previous.disconnect(); this.resources.unpin(entry);
      } };
      this.retiring.set(previous, retired); previous.onended = retired.finish;
      this.resources.pin(entry);
      track.heard = heard; track.heardUntil = at;
      track.offset = offset; track.start = at; track.end = at + track.duration - offset; track.node = node;
      node.onended = () => {
        if (track.node !== node || generation !== this.generation) return;
        track.heard = this.heard(track); track.heardUntil = 0; track.offset = track.duration; track.playing = false;
        track.node = null; node.disconnect(); this.active.delete(track); this.resources.unpin(entry);
        this.onEnded(track);
      };
      this.trace('seek-replaced', { id: track.id, switchLeadMs: (at - this.ctx.currentTime) * 1000 });
    }
    setVolume(value) {
      if (!Number.isFinite(value)) return;
      this.volume = Math.max(0, Math.min(1, value));
      this.applyOutputVolume();
    }
    async close() {
      for (const track of [...this.active]) this.stop(track);
      for (const [node, retired] of [...this.retiring]) {
        try { node.stop(); } catch { /* Already ended. */ }
        retired.finish();
      }
      const ctx = this.ctx; this.ctx = null; this.gain = null; this.generation++;
      this.outputSwitch = { before: true, enabled: true, at: 0 };
      if (ctx?.state !== 'closed') await ctx?.close();
    }
    status() { return { sampleRate: this.ctx?.sampleRate, contextState: this.ctx?.state,
      contextGeneration: this.generation, activeNodes: this.active.size + this.retiring.size, deviceFormat: 'unknown' }; }
  }
  globalThis.GaplessPlaybackClock = PlaybackClock;
})();
