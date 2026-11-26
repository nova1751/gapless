/* MIT. Experimental native-only encoded-byte path; never fetches an audio URL. */
(() => {
  'use strict';
  class NativeByteSource {
    constructor({ cache, queue, valid, awaitReady = async () => {} }) {
      this.cache = cache; this.queue = queue; this.valid = valid; this.awaitReady = awaitReady;
    }
    async open(source, signal, priorityForRead = () => globalThis.WindowsNativeCachePriority.playback) {
      const size = Number(source.size ?? source.fileSize);
      if (source.audioFormat !== 'flac' || !Number.isSafeInteger(size) || size < 4)
        throw new Error('native-only-byte-source-format');
      const acquisition = { nativeRequests: 0 };
      const state = { points: null, rate: null, coverage: null };
      const read = async (start, end, requestSignal) => {
        const controller = new AbortController(), readSignal = controller.signal;
        let timedOut = false, refreshed = false, seekBatches = 0;
        const abort = () => controller.abort();
        if (requestSignal.aborted) abort();
        requestSignal.addEventListener('abort', abort, { once: true });
        const readDeadline = performance.now() + 8000;
        const timer = setTimeout(() => { timedOut = true; abort(); }, 8000);
        try {
          for (;;) {
            await this.awaitReady(readSignal);
            if (readSignal.aborted || !this.valid(source)) throw new Error('cancelled');
            let coverage = state.coverage;
            if (!coverage || coverage.generation !== this.cache.generation
              || globalThis.GaplessCacheCoverage.missing(coverage, start, end).length) {
              coverage = await this.cache.snapshotSource(source, readSignal);
              state.coverage = coverage;
            }
            const gaps = globalThis.GaplessCacheCoverage.missing(coverage, start, end);
            if (!gaps.length) {
              try { return await this.cache.readReadyRange(source, start, end, readSignal, coverage); }
              catch (error) {
                if (refreshed || readSignal.aborted || !this.valid(source)
                  || coverage.generation !== this.cache.generation
                  || !(error.name === 'TypeError' || ['seek-range-length', 'seek-range-unsupported',
                    'native-cache-range-missing'].includes(error.message))) throw error;
                refreshed = true;
                this.cache.mounts.delete(coverage.path);
                state.coverage = null;
                continue;
              }
            }
            if (readSignal.aborted) throw new Error('cancelled');
            const position = state.points
              ? globalThis.GaplessCacheCoverage.seekBefore(gaps[0][0], state.points, state.rate) : 0;
            const priority = priorityForRead();
            // Give a cold CDN download enough time to commit multiple seek
            // intervals in one connection instead of aborting too early and
            // retrying. Background refills use larger windows to minimize
            // Load/Seek/Stop round-trips while remaining immediately preemptible.
            const budgets = priority >= 100 ? [1200, 1800, 2500] : [1800, 2400, 2800];
            const planned = budgets[Math.min(budgets.length - 1, seekBatches++)];
            const remaining = Math.floor(readDeadline - performance.now() - 400);
            const budgetMs = Math.max(250, Math.min(planned, remaining));
            try {
              acquisition.nativeRequests++;
              state.coverage = await this.queue.request({ source, position, signal: readSignal,
                priority, budgetMs, wantRange: [start, end] });
            } catch (error) {
              if (['native-cache-preempted', 'native-cache-cleared'].includes(error.message)
                && !readSignal.aborted) {
                state.coverage = null; continue;
              }
              throw error;
            }
            // A batch returns a committed index snapshot; completion alone is
            // not proof that the requested byte interval has become available.
          }
        } catch (error) {
          if (timedOut && !requestSignal.aborted) throw new Error('native-only-cache-range-timeout');
          throw error;
        } finally { clearTimeout(timer); requestSignal.removeEventListener('abort', abort); }
      };
      const hasDiskCoverage = (targetSeconds, runwaySeconds = 2) => {
        const cov = state.coverage, points = state.points, rate = state.rate;
        if (!cov || cov.generation !== this.cache.generation || !points || !rate) return false;
        if (cov.complete) return true;
        const startSample = Math.max(0, Math.floor(targetSeconds * rate));
        const endSample = Math.min(points[points.length - 1].sample, Math.ceil((targetSeconds + runwaySeconds) * rate));
        const first = points.findIndex((p, i) => i + 1 < points.length && p.sample <= startSample && points[i + 1].sample > startSample);
        if (first < 0) return false;
        let last = first;
        while (last + 1 < points.length && points[last + 1].sample < endSample) last++;
        const byteStart = points[first].offset;
        const byteEnd = Math.min(size, points[Math.min(points.length - 1, last + 1)].offset + 16);
        return !globalThis.GaplessCacheCoverage.missing(cov, byteStart, byteEnd).length;
      };
      const end = Math.min(size, 32768), head = await read(0, end, signal);
      return { kind: 'native-source', partial: true, acquisition, hasDiskCoverage,
        response: new Response(head, { status: 206, headers: {
          'content-range': `bytes 0-${end - 1}/${size}`, 'content-length': String(end),
        } }),
        setIndex: (points, spec) => { state.points = points; state.rate = spec.rate; },
        verifyParts: (parts, requestSignal) => this.cache.verifyParts(source, parts, requestSignal),
        seekRange: (start, end, requestSignal) => read(start, end, requestSignal),
      };
    }
  }
  globalThis.WindowsNativeByteSource = NativeByteSource;
})();
