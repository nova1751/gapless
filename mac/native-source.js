/* MIT. Mac 3.1.12 native acquisition; only native writes UC/IDX. No Play. */
(() => {
  'use strict';
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  class NativeSource {
    constructor({ bridge, cache, valid, ensureGate, refresh, priority, trace }) {
      Object.assign(this, { bridge, cache, valid, ensureGate, refresh, priority, trace });
      this.queue = new globalThis.WindowsNativeCacheQueue(this);
      this.active = null; this.retired = new Set(); this.serial = 0; this.fault = null;
      this.prefix = Date.now().toString(36);
      this.clearTimers = [];
      this.recentStops = [];
      this.stats = { batches: 0, reads: 0, hits: 0, refreshes: 0, failures: 0 };
    }
    observe(name, args) {
      return name.startsWith('audioplayer.') && (args?.[0] === this.active?.id || this.retired.has(args?.[0]));
    }
    cancel() { this.queue.clear(); }
    async beginClear() {
      const timer = setTimeout(() => {
        this.fault = 'native-only-cache-clear-timeout'; this.finishClear();
      }, 10000);
      this.clearTimers.push(timer);
      await this.quiesce();
      // Observe recently written indexes without rewriting native cache. A
      // stable window is a bounded mitigation, never an atomic flush claim.
      const sources = this.recentStops.filter(item => performance.now() - item.at < 2000).map(item => item.source);
      if (!sources.length) { await delay(500); return; }
      const controller = new AbortController(), started = performance.now();
      const deadline = setTimeout(() => controller.abort(), 2000);
      let previous, stableAt = started;
      try {
        while (!controller.signal.aborted) {
          const stamp = await this.cache.indexStamp(sources, controller.signal), now = performance.now();
          if (stamp !== previous) { previous = stamp; stableAt = now; }
          if (now - started >= 500 && now - stableAt >= 250) {
            this.trace('native-cache-settled', { waitMs: Math.round(now - started) }); return;
          }
          await delay(50);
        }
        this.trace('native-cache-settle-timeout');
      } catch { this.trace('native-cache-settle-unavailable'); }
      finally {
        clearTimeout(deadline);
        const remaining = 500 - (performance.now() - started);
        if (remaining > 0) await delay(remaining);
      }
    }
    finishClear() { const timer = this.clearTimers.shift(); if (timer) clearTimeout(timer); }
    async quiesce() {
      this.cancel();
      const deadline = performance.now() + 4000;
      while (this.queue.running) {
        if (performance.now() > deadline) throw new Error('native-only-cache-stop-timeout');
        await delay(10);
      }
    }
    async batch({ source, position, signal, budgetMs }) {
      if (this.fault) throw new Error(this.fault);
      const job = { id: source.songId + '_gp_cache_' + this.prefix + '_' + (++this.serial), signal, source };
      const check = () => {
        if (signal.aborted || !this.valid(source)) throw new Error('cancelled');
      };
      const pending = promise => this.cache.wait(promise, signal);
      let waiter, loaded = false;
      this.active = job;
      try {
        check(); await this.ensureGate(source); check();
        const refreshed = await pending(this.refresh(source)); check();
        if (refreshed.md5 !== source.md5 || refreshed.level !== source.level
          || Number(refreshed.fileSize) !== Number(source.size)) throw new Error('native-only-cache-source-changed');
        waiter = this.bridge.waitNative('audioplayer.onLoad', args => args[0] === job.id, 3000);
        void waiter.promise.catch(() => {});
        loaded = true;
        await pending(this.bridge.raw('audioplayer.load', [job.id, { ...refreshed, playId: job.id }], 2000));
        const result = await pending(waiter.promise); check(); waiter.cancel(); waiter = null;
        if (Number(result[1]?.code) !== 0) throw new Error('native-only-cache-load');
        const token = job.id + '|seek';
        waiter = this.bridge.waitNative('audioplayer.onSeek', args => args[0] === job.id && args[1] === token, 3000);
        void waiter.promise.catch(() => {});
        await pending(this.bridge.raw('audioplayer.seek', [job.id, token, position], 2000));
        const sought = await pending(waiter.promise); check();
        if (Number(sought[2]) !== 0) throw new Error('native-only-cache-seek');
        const until = performance.now() + budgetMs;
        while (performance.now() < until) { check(); await delay(20); }
      } finally {
        waiter?.cancel();
        this.retired.add(job.id);
        if (this.retired.size > 256) this.retired.delete(this.retired.values().next().value);
        try {
          if (loaded) {
            this.recentStops = this.recentStops.filter(item => performance.now() - item.at < 2000);
            this.recentStops.push({ source: { songId: source.songId, md5: source.md5, level: source.level }, at: performance.now() });
            await this.bridge.raw('audioplayer.stop', [job.id], 1500);
          }
        } catch (error) {
          this.fault = 'native-only-cache-stop-failed';
          throw new Error(this.fault);
        } finally { if (this.active === job) this.active = null; }
      }
      check();
      // Stop is followed by a verified committed index, never by an assumed
      // delay/percentage/file-length definition of valid audio bytes.
      await delay(30); check();
      const coverage = await pending(this.cache.snapshotSource(source, signal)); check();
      this.stats.batches++;
      this.trace('native-cache-batch', { id: String(source.songId), position, complete: !!coverage?.complete });
      return coverage;
    }
    async open(ref, info, signal) {
      const source = { ...info, _gpAccount: ref.account };
      let points, rate, committed;
      const read = async (start, end, requestSignal) => {
        const controller = new AbortController();
        const abort = () => controller.abort();
        if (requestSignal.aborted) abort();
        requestSignal.addEventListener('abort', abort, { once: true });
        let timedOut = false;
        const timeout = setTimeout(() => { timedOut = true; abort(); }, 8000), inputSignal = controller.signal;
        let refreshedReads = 0;
        try {
          for (;;) {
            if (inputSignal.aborted || !this.valid(source)) throw new Error('cancelled');
            if (this.fault) throw new Error(this.fault);
            if (this.clearTimers.length) { await delay(20); continue; }
            try {
              let coverage = committed?.generation === this.cache.generation ? committed
                : await this.cache.snapshotSource(source, inputSignal);
              let gaps = coverage ? globalThis.GaplessCacheCoverage.missing(coverage, start, end) : [[start, end]];
              if (gaps.length && committed && coverage === committed) {
                // Another reader or background fill may already have committed
                // this interval. Refresh before starting another native batch.
                coverage = await this.cache.snapshotSource(source, inputSignal);
                gaps = coverage ? globalThis.GaplessCacheCoverage.missing(coverage, start, end) : [[start, end]];
              }
              if (gaps.length) {
                const position = points ? globalThis.GaplessCacheCoverage.seekBefore(gaps[0][0], points, rate) : 0;
                try {
                  coverage = await this.queue.request({ source, position, signal: inputSignal,
                    priority: this.priority(source), budgetMs: 500 });
                } catch (error) {
                  if (['native-cache-preempted', 'native-cache-cleared'].includes(error.message)) continue;
                  throw error;
                }
                gaps = coverage ? globalThis.GaplessCacheCoverage.missing(coverage, start, end) : [[start, end]];
                if (gaps.length) continue;
              } else this.stats.hits++;
              committed = coverage;
              const bytes = await this.cache.readReadyRange(source, start, end, inputSignal, coverage);
              if (inputSignal.aborted || !this.valid(source)) throw new Error('cancelled');
              this.stats.reads++;
              return bytes;
            } catch (error) {
              if (inputSignal.aborted || !this.valid(source)) throw new Error('cancelled');
              // Both index and audio may briefly disappear when native commits
              // a file. Refresh once within the original deadline; persistent
              // failures still restore native, without a second Web download.
              if (['native-only-cache-changed', 'native-only-cache-read-unavailable'].includes(error.message)
                && refreshedReads++ < 1) {
                this.stats.refreshes++;
                this.trace('native-cache-read-refresh', { id: String(source.songId), reason: error.message });
                committed = null; continue;
              }
              throw error;
            }
          }
        } catch (error) {
          if (requestSignal.aborted || !this.valid(source)) throw new Error('cancelled');
          // Do not let the generic cache fallback create a second Web download
          // after native acquisition has already started.
          this.stats.failures++;
          if (timedOut) throw new Error('native-only-cache-read-timeout');
          throw new Error(error.message.startsWith('native-only-') ? error.message : 'native-only-cache-' + error.message);
        } finally { clearTimeout(timeout); requestSignal.removeEventListener('abort', abort); }
      };
      const size = Number(source.size), end = Math.min(size, 32768), head = await read(0, end, signal);
      return { kind: 'native-source', partial: true,
        response: new Response(head, { status: 206, headers: { 'content-range': `bytes 0-${end - 1}/${size}`,
          'content-length': String(end) } }),
        setIndex: (index, spec) => { points = index; rate = spec.rate; }, seekRange: read,
        verifyParts: (parts, verifySignal) => this.cache.verifyParts(source, parts, verifySignal) };
    }
    status() { return { ...this.stats, ...this.queue.status(), pendingClears: this.clearTimers.length, fault: this.fault }; }
  }
  globalThis.GaplessMacNativeSource = NativeSource;
})();
