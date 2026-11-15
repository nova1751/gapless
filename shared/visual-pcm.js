/* MIT. Read-only PCM for the client's existing visualizer; never an audio output. */
(() => {
  'use strict';
  class VisualPCM {
    constructor({ snapshot, emit, trace, rate, channels, packetFrames }) {
      this.snapshot = snapshot; this.emit = emit; this.trace = trace;
      this.rate = rate; this.channels = channels; this.frame = null;
      this.packetFrames = packetFrames; this.maxPackets = Math.floor(rate * 0.05 / packetFrames);
      this.bytes = new Uint8Array(packetFrames * channels * 2);
      this.view = new DataView(this.bytes.buffer);
      this.identity = null; this.cursor = 0; this.frames = 0;
      this.lastPosition = 0; this.maxWorkMs = 0; this.totalWorkMs = 0;
      this.failed = false; this.resets = 0; this.skippedFrames = 0;
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
        // The native consumer retains its largest allocation as the analysis
        // length. Variable packets replay stale tails, so every packet has the
        // same native size. rAF may deliver several packets, not one large blob.
        if (this.identity !== identity || end < this.cursor
          || end - this.cursor > this.packetFrames * this.maxPackets) {
          if (this.identity === identity && end > this.cursor)
            this.skippedFrames += Math.max(0, end - this.cursor - this.packetFrames);
          this.identity = identity;
          this.cursor = Math.max(0, Math.floor(end / this.packetFrames) * this.packetFrames - this.packetFrames);
          this.resets++;
        }
        const count = Math.min(this.maxPackets, Math.floor((end - this.cursor) / this.packetFrames));
        if (count > 0) {
          const started = performance.now();
          const left = buffer.sampleAt ? null : buffer.getChannelData(0);
          const right = buffer.sampleAt ? null : buffer.numberOfChannels === 2 ? buffer.getChannelData(1) : left;
          const step = buffer.sampleRate / this.rate;
          for (let packet = 0; packet < count; packet++) {
            const start = this.cursor;
            for (let i = 0; i < this.packetFrames; i++) {
              const at = (start + i) * step, first = Math.min(buffer.length - 1, Math.floor(at));
              const next = Math.min(buffer.length - 1, first + 1), mix = at - first;
              for (let channel = 0; channel < this.channels; channel++) {
                const data = channel ? right : left;
                const sourceChannel = Math.min(channel, buffer.numberOfChannels - 1);
                const a = buffer.sampleAt ? buffer.sampleAt(sourceChannel, first) : data[first];
                const b = buffer.sampleAt ? buffer.sampleAt(sourceChannel, next) : data[next];
                const sample = Math.max(-1, Math.min(1, a + (b - a) * mix));
                this.view.setInt16((i * this.channels + channel) * 2,
                  Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
              }
            }
            this.emit(this.bytes, start * 1000 / this.rate);
            this.cursor += this.packetFrames; this.frames++;
          }
          this.lastPosition = this.cursor / this.rate;
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
      visualRate: this.rate, visualChannels: this.channels, packetFrames: this.packetFrames,
      packetBytes: this.bytes.length, maxPacketsPerTick: this.maxPackets,
      resets: this.resets, skippedFrames: this.skippedFrames, affectsAudioOutput: false }; }
  }
  globalThis.GaplessVisualPCM = VisualPCM;
})();
