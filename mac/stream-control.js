/* MIT. Mac intent-checked preparation; decoding never changes the playback clock. */
(() => {
  class StreamControl {
    constructor(resources) { this.resources = resources; }
    ready(entry, target, ahead = 0.5) {
      if (!entry || entry.stream?.error) return false;
      if (!entry.stream || entry.stream.done) return true;
      const start = Math.floor(target * entry.spec.rate);
      return globalThis.GaplessSeekRange.until(entry, start) >= Math.min(entry.buffer.length, Math.ceil((target + ahead) * entry.spec.rate));
    }
    cancel(track) {
      track?.streamPreparation?.abort();
      if (track) {
        track.streamPreparation = null;
        if (track.entry?.stream) track.entry.stream.priorityTarget = null;
      }
    }
    async prepare(track, target, valid, ahead = 0.5) {
      this.cancel(track);
      const controller = track.streamPreparation = new AbortController();
      const entry = track.entry, signal = controller.signal;
      const timer = setTimeout(() => controller.abort(), 10000);
      const check = () => {
        if (signal.aborted || !valid() || track.entry !== entry || entry?.stream?.error) throw new Error('cancelled');
      };
      try {
        check();
        if (entry.stream?.indexed && !this.ready(entry, target, ahead)) {
          entry.stream.ensureController?.abort();
          entry.stream.priorityTarget = target;
          await globalThis.GaplessSeekRange.prepare(this.resources, entry, target, signal, Math.max(2, ahead));
        }
        while (!this.ready(entry, target, ahead)) {
          check(); await new Promise(resolve => setTimeout(resolve, 25));
        }
        check();
      } finally {
        clearTimeout(timer);
        if (track.streamPreparation === controller) {
          track.streamPreparation = null;
          if (entry?.stream) entry.stream.priorityTarget = null;
        }
      }
    }
  }
  globalThis.GaplessMacStreamControl = StreamControl;
})();
