/* MIT. Read-only PCM for the client's existing visualizer; never an audio output. */
(() => {
  'use strict';
  class VisualPCM {
    constructor({ snapshot, emit, trace, rate, channels }) {
      this.snapshot = snapshot; this.emit = emit; this.trace = trace;
      this.rate = rate; this.channels = channels; this.frame = null;
      this.bytes = new Uint8Array(Math.ceil(rate * 0.05) * channels * 2);
      this.identity = null; this.cursor = 0; this.frames = 0;
      this.lastPosition = 0; this.maxWorkMs = 0; this.totalWorkMs = 0;
      this.failed = false;
    }
    sync() {
      if (this.frame !== null || this.failed) return;
      try {
        const s = this.snapshot();
        if (!s?.active || !s.playing) { this.stop(); return; }
        this.frame = requestAnimationFrame(() => this.tick());
      } catch (error) {
        this.stop(); this.failed = true;
        this.trace('visual-pcm-error', { reason: error.message });
      }
    }
    tick() {
      this.frame = null;
      try {
        const s = this.snapshot();
        if (!s?.active || !s.playing) { this.stop(); return; }
        const buffer = s.buffer;
        if (!buffer || ![1, 2].includes(buffer.numberOfChannels)) { this.stop(); return; }
        const identity = `${s.id}:${s.serial}:${s.revision}:${s.generation}`;
        const end = Math.floor(Math.max(0, Math.min(buffer.duration, s.position)) * this.rate);
        // Seek, Load and clock changes discard old visual samples. Background
        // stalls skip old frames instead of allocating a backlog or catching up.
        if (this.identity !== identity || end < this.cursor || end - this.cursor > this.rate * 0.1) {
          this.identity = identity;
          this.cursor = Math.max(0, end - Math.ceil(this.rate * 0.02));
        }
        const count = Math.min(end - this.cursor, this.bytes.length / (this.channels * 2));
        if (count >= this.rate * 0.015) {
          const started = performance.now(), start = end - count;
          const left = buffer.getChannelData(0);
          const right = buffer.numberOfChannels === 2 ? buffer.getChannelData(1) : left;
          const view = new DataView(this.bytes.buffer);
          const step = buffer.sampleRate / this.rate;
          for (let i = 0; i < count; i++) {
            const at = (start + i) * step, first = Math.min(left.length - 1, Math.floor(at));
            const next = Math.min(left.length - 1, first + 1), mix = at - first;
            for (let channel = 0; channel < this.channels; channel++) {
              const data = channel ? right : left;
              const sample = Math.max(-1, Math.min(1, data[first] + (data[next] - data[first]) * mix));
              view.setInt16((i * this.channels + channel) * 2,
                Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
            }
          }
          this.emit(this.bytes.subarray(0, count * this.channels * 2), start * 1000 / this.rate);
          this.cursor = end; this.lastPosition = end / this.rate; this.frames++;
          const elapsed = performance.now() - started;
          this.maxWorkMs = Math.max(this.maxWorkMs, elapsed); this.totalWorkMs += elapsed;
        }
        this.frame = requestAnimationFrame(() => this.tick());
      } catch (error) {
        this.stop(); this.failed = true;
        this.trace('visual-pcm-error', { reason: error.message });
      }
    }
    stop() {
      if (this.frame !== null) cancelAnimationFrame(this.frame);
      this.frame = null; this.identity = null; this.cursor = 0;
    }
    status() { return { active: this.frame !== null, failed: this.failed, frames: this.frames,
      lastPosition: this.lastPosition, maxWorkMs: this.maxWorkMs,
      averageWorkMs: this.frames ? this.totalWorkMs / this.frames : 0,
      visualRate: this.rate, visualChannels: this.channels, affectsAudioOutput: false }; }
  }
  globalThis.GaplessVisualPCM = VisualPCM;
})();
