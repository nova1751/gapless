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
      this.active = null; this.fault = null; this.serial = 0; this.retired = new Set();
      this.recentStops = [];
      this.prefix = Date.now().toString(36) + '_' + (++instanceSerial);
      this.stats = { batches: 0, cancelled: 0, failed: 0, stopFailed: 0 };
    }
    resetFault() {
      if (!this.active && this.fault) {
        this.fault = null;
        this.trace('native-cache-fault-reset');
      }
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
      const { songId, level, md5 } = job.source;
      this.recentStops = this.recentStops.filter(item => performance.now() - item.at < 2000);
      this.recentStops.push({ source: { songId, level, md5 }, at: performance.now() });
      // Remember IDs before Stop, including synchronous and delayed callbacks.
      this.retired.add(job.id);
      if (this.retired.size > 256) this.retired.delete(this.retired.values().next().value);
      try { this.bridge.call('audioplayer.stop', [job.id]); }
      catch {
        // Stop dispatch is uncertain. Do not start another auxiliary native
        // load in this session; reload is required to re-establish ownership.
        this.fault = 'native-cache-stop-failed'; this.stats.stopFailed++;
        this.trace('native-cache-stop-failed');
        throw new Error(this.fault);
      }
    }
    cancel(reason = 'cancelled') {
      const job = this.active;
      if (!job || job.cancelled) return;
      job.cancelled = true; this.stats.cancelled++;
      // AbortSignal listeners must not throw or strand a pending bridge call.
      try { this.stop(job); } catch { /* stop() latched a terminal session fault. */ }
      finally { job.wake?.(); this.trace('native-cache-cancel', { reason }); }
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
      return await new Promise((resolve, reject) => {
        let settled = false;
        const finish = (error, value) => {
          if (settled) return;
          settled = true;
          if (job.wake === abort) job.wake = null;
          if (error) reject(value); else resolve(value);
        };
        const abort = () => finish(true, new Error('native-cache-cancelled'));
        // Observe an already-issued RPC even if its job is now obsolete.
        Promise.resolve(promise).then(value => finish(false, value), error => finish(true, error));
        try { this.check(job); job.wake = abort; }
        catch (error) { finish(true, error); }
      });
    }
    async batch({ source, position, signal, budgetMs = 2000, wantRange = null }) {
      if (this.fault) throw new Error(this.fault);
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
          await this.delay(job, 15);
        }
        const mark = job.id + '|seek';
        waiter = this.bridge.wait('audioplayer.onSeek', args => args[0] === job.id && args[1] === mark, 3000);
        // Attach rejection handling before the command can synchronously complete.
        const seek = waiter.promise;
        // Disposal can reject even if the command throws before pending() attaches.
        // Observe that rejection now; pending() still receives the original promise.
        void seek.catch(() => {});
        this.bridge.call('audioplayer.seek', [job.id, mark, position]);
        const result = await this.pending(job, seek); this.check(job);
        if (Number(result[2]) !== 0) throw new Error('native-cache-seek-failed');
        await this.delay(job, budgetMs);
        this.stop(job);
        // Stop was observed to commit .idx up to ~154 ms after dispatch. Check
        // at 50 ms first, then re-observe briefly if the desired range is not
        // yet committed so we avoid restarting a whole CDN download needlessly.
        let coverage;
        for (const wait of wantRange ? [50, 60, 80] : [50]) {
          await this.delay(job, wait);
          coverage = await this.pending(job, this.snapshot(source, signal)); this.check(job);
          if (!wantRange || (coverage?.path && !globalThis.GaplessCacheCoverage.missing(coverage, wantRange[0], wantRange[1]).length)) break;
        }
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
