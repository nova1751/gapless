/* MIT. Experimental native data acquisition. No Play and no cache writes.
 * The coordinator must hold the native output gate and route observe() first.
 * Not enabled in production until concurrent playback and cleanup are verified.
 */
(() => {
  'use strict';
  let instanceSerial = 0;
  class NativeCacheSession {
    constructor({ bridge, valid, snapshot, trace = () => {} }) {
      this.bridge = bridge; this.valid = valid; this.snapshot = snapshot; this.trace = trace;
      this.active = null; this.serial = 0; this.retired = new Set();
      this.prefix = Date.now().toString(36) + '_' + (++instanceSerial);
      this.stats = { batches: 0, cancelled: 0, failed: 0 };
    }
    observe(name, args) {
      if (!name.startsWith('audioplayer.')) return false;
      const id = args[0];
      if (id !== this.active?.id && !this.retired.has(id)) return false;
      return true;
    }
    stop(job) {
      if (!job.loaded) return;
      job.loaded = false;
      // Remember IDs before Stop, including synchronous and delayed callbacks.
      this.retired.add(job.id);
      if (this.retired.size > 256) this.retired.delete(this.retired.values().next().value);
      this.bridge.call('audioplayer.stop', [job.id]);
    }
    cancel(reason = 'cancelled') {
      const job = this.active;
      if (!job || job.cancelled) return;
      job.cancelled = true; this.stats.cancelled++;
      this.stop(job); job.wake?.(); this.trace('native-cache-cancel', { reason });
    }
    check(job) {
      if (job !== this.active || job.cancelled || job.signal.aborted || !this.valid(job.source))
        throw new Error('native-cache-cancelled');
    }
    async delay(job, ms) {
      this.check(job);
      await new Promise(resolve => {
        const done = () => { clearTimeout(timer); if (job.wake === done) job.wake = null; resolve(); };
        const timer = setTimeout(done, ms); job.wake = done;
      });
      this.check(job);
    }
    async pending(job, promise) {
      this.check(job);
      return await new Promise((resolve, reject) => {
        const abort = () => reject(new Error('native-cache-cancelled'));
        job.wake = abort;
        Promise.resolve(promise).then(resolve, reject).finally(() => {
          if (job.wake === abort) job.wake = null;
        });
      });
    }
    async batch({ source, position, signal, budgetMs = 2000 }) {
      if (this.active) throw new Error('native-cache-busy');
      if (!source || !/^\d+$/.test(String(source.songId)) || source.freeTrialInfo || source.path
        || !Number.isFinite(position) || position < 0 || position >= Number(source.songDuration) / 1000
        || !Number.isFinite(budgetMs) || budgetMs < 250 || budgetMs > 10000 || !signal)
        throw new Error('native-cache-input');
      const job = { source, position, signal, id: String(source.songId) + '_gapless_cache_' + this.prefix + '_' + (++this.serial),
        loaded: false, cancelled: false, wake: null };
      this.active = job;
      const abort = () => this.cancel('request-aborted');
      signal.addEventListener('abort', abort, { once: true });
      let waiter;
      try {
        this.check(job);
        job.loaded = true;
        this.bridge.call('audioplayer.load', [job.id, { ...source, playId: job.id }]);
        const deadline = performance.now() + 3000;
        for (;;) {
          this.check(job);
          const result = await this.pending(job, this.bridge.request('audioplayer.getPlayedTime', [{ playId: job.id }], 1000));
          this.check(job);
          if (result?.[0]?.result === true) break;
          if (performance.now() >= deadline) throw new Error('native-cache-load-timeout');
          await this.delay(job, 40);
        }
        const mark = job.id + '|seek';
        waiter = this.bridge.wait('audioplayer.onSeek', args => args[0] === job.id && args[1] === mark, 3000);
        // Attach rejection handling before the command can synchronously complete.
        const seek = waiter.promise;
        this.bridge.call('audioplayer.seek', [job.id, mark, position]);
        const result = await this.pending(job, seek); this.check(job);
        if (Number(result[2]) !== 0) throw new Error('native-cache-seek-failed');
        await this.delay(job, budgetMs);
        this.stop(job);
        // Stop was observed to commit .idx; snapshot must verify source identity
        // and may conservatively return an older subset. It must never infer
        // validity from file length or buffering percent.
        await this.delay(job, 50);
        const coverage = await this.pending(job, this.snapshot(source, signal)); this.check(job);
        this.stats.batches++;
        this.trace('native-cache-batch', { position, complete: !!coverage?.complete });
        return coverage;
      } catch (error) {
        if (!job.cancelled && !signal.aborted) this.stats.failed++;
        throw error;
      } finally {
        waiter?.dispose();
        signal.removeEventListener('abort', abort);
        try { this.stop(job); } finally { if (this.active === job) this.active = null; }
      }
    }
  }
  globalThis.WindowsNativeCacheSession = NativeCacheSession;
})();
