/* MIT. Bounded decoded FLAC intervals; missing PCM is never playable silence. */
(() => {
  'use strict';
  class PCMCache {
    constructor(spec, limit = 32 * 1024 * 1024) {
      this.length = spec.frames; this.sampleRate = spec.rate;
      this.numberOfChannels = spec.channels; this.duration = spec.duration;
      this.limit = Math.min(limit, spec.frames * spec.channels * 4);
      this.bytes = 0; this.serial = 0; this.parts = new Map(); this.last = null;
    }
    put(start, channels) {
      const length = channels[0]?.length, end = start + length;
      if (!Number.isSafeInteger(start) || start < 0 || !length || end > this.length
        || channels.length !== this.numberOfChannels || channels.some(c => c.length !== length))
        throw new Error('pcm-cache-bounds');
      const size = length * channels.length * 4;
      if (size > this.limit) throw new Error('native-only-pcm-block-size');
      for (const part of this.parts.values()) {
        if (part.start === start && part.end === end) { part.used = ++this.serial; return; }
        if (part.start < end && part.end > start) throw new Error('pcm-cache-overlap');
      }
      while (this.bytes + size > this.limit || this.parts.size >= 512) {
        let oldest;
        for (const part of this.parts.values()) if (!oldest || part.used < oldest.used) oldest = part;
        this.parts.delete(oldest.start); this.bytes -= oldest.size;
        if (this.last === oldest) this.last = null;
      }
      const data = channels.map(c => c.slice());
      this.parts.set(start, { start, end, data, size, used: ++this.serial }); this.bytes += size;
    }
    until(sample) {
      let end = sample;
      for (const part of [...this.parts.values()].sort((a, b) => a.start - b.start)) {
        if (part.start > end) break;
        if (part.end > end) end = part.end;
      }
      return end;
    }
    copyFromChannel(destination, channel, start = 0) {
      const end = start + destination.length;
      if (!Number.isSafeInteger(start) || start < 0 || channel < 0 || channel >= this.numberOfChannels
        || end > this.length || this.until(start) < end) throw new Error('pcm-cache-missing');
      for (const part of this.parts.values()) {
        const left = Math.max(start, part.start), right = Math.min(end, part.end);
        if (left >= right) continue;
        destination.set(part.data[channel].subarray(left - part.start, right - part.start), left - start);
        part.used = ++this.serial;
      }
    }
    sampleAt(channel, sample) {
      let part = this.last;
      if (!part || sample < part.start || sample >= part.end)
        part = [...this.parts.values()].find(p => p.start <= sample && p.end > sample);
      this.last = part;
      // Only the visualizer uses sampleAt; output uses strict copyFromChannel.
      return part?.data[channel]?.[sample - part.start] ?? 0;
    }
  }
  globalThis.GaplessPCMCache = PCMCache;
})();
