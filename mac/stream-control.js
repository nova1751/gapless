/* MIT. Mac intent-checked preparation; decoding never changes the playback clock. */
(() => {
  class StreamControl {
    constructor(resources) { this.resources = resources; }
    static failure(kind) {
      const error = new Error('mac-stream-' + kind);
      error.kind = kind;
      error.cancelled = ['cancelled', 'superseded', 'pause', 'cache-clear', 'stale'].includes(kind);
      return error;
    }
    defaultAhead(entry, target = 0) {
      if (entry?.origin !== 'native-source') return 0.5;
      if (entry.stream?.hasDiskCoverage?.(target, 2)) return 0.5;
      return 1.5;
    }
    ready(entry, target, ahead = this.defaultAhead(entry, target)) {
      if (!entry || entry.stream?.error) return false;
      if (!entry.stream || entry.stream.done) return true;
      const start = Math.floor(target * entry.spec.rate);
      return globalThis.GaplessSeekRange.until(entry, start) >= Math.min(entry.buffer.length, Math.ceil((target + ahead) * entry.spec.rate));
    }
    cancel(track, reason = 'cancelled', keepLoad = false) {
      const controller = track?.streamPreparation;
      if (keepLoad && controller?.purpose === 'load') return;
      controller?.abort(StreamControl.failure(reason));
      if (track) {
        track.streamPreparation = null;
        if (controller?.entry?.stream) controller.entry.stream.priorityTarget = null;
      }
    }
    async prepare(track, target, valid, { purpose = 'seek', ahead } = {}) {
      // An older file/intent check can finish after a newer preparation starts.
      // Reject that caller before it can abort the current controller.
      if (!valid() || !this.resources.enabled) throw StreamControl.failure('stale');
      this.cancel(track, 'superseded');
      const controller = track.streamPreparation = new AbortController();
      const entry = track.entry, signal = controller.signal;
      const targetAhead = () => ahead ?? this.defaultAhead(entry, target);
      controller.purpose = purpose; controller.entry = entry; controller.target = target;
      const timer = setTimeout(() => controller.abort(StreamControl.failure('timeout')), 10000);
      const check = () => {
        if (signal.aborted) throw signal.reason;
        if (!valid() || track.entry !== entry || !this.resources.enabled) throw StreamControl.failure('stale');
        if (!entry || entry.stream?.error) throw StreamControl.failure('source-failed');
      };
      try {
        check();
        if (entry.stream?.indexed && !this.ready(entry, target, targetAhead())) {
          entry.stream.ensureController?.abort();
          entry.stream.priorityTarget = target;
          await globalThis.GaplessSeekRange.prepare(this.resources, entry, target, signal, targetAhead());
        }
        while (!this.ready(entry, target, targetAhead())) {
          check();
          await (entry.stream.waitProgress ? entry.stream.waitProgress(25) : new Promise(resolve => setTimeout(resolve, 25)));
        }
        check();
      } catch (error) {
        // Abort/deadline and ownership changes take precedence over a late
        // decoder rejection, so user controls never become source failures.
        check();
        error.kind ||= 'source-failed';
        throw error;
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
