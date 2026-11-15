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
      const state = { points: null, rate: null, coverage: null };
      const read = async (start, end, requestSignal) => {
        const controller = new AbortController(), readSignal = controller.signal;
        let timedOut = false;
        const abort = () => controller.abort();
        if (requestSignal.aborted) abort();
        requestSignal.addEventListener('abort', abort, { once: true });
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
            if (!gaps.length) return await this.cache.readReadyRange(source, start, end, readSignal, coverage);
            if (readSignal.aborted) throw new Error('cancelled');
            const position = state.points
              ? globalThis.GaplessCacheCoverage.seekBefore(gaps[0][0], state.points, state.rate) : 0;
            state.coverage = await this.queue.request({ source, position, signal: readSignal, priority: priorityForRead(), budgetMs: 500 });
            // A batch returns a committed index snapshot; completion alone is
            // not proof that the requested byte interval has become available.
          }
        } catch (error) {
          if (timedOut && !requestSignal.aborted) throw new Error('native-only-cache-range-timeout');
          throw error;
        } finally { clearTimeout(timer); requestSignal.removeEventListener('abort', abort); }
      };
      const end = Math.min(size, 32768), head = await read(0, end, signal);
      return { kind: 'native-source', partial: true,
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
