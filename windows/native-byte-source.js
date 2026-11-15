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
      const state = { points: null, rate: null };
      const read = async (start, end, requestSignal) => {
        const deadline = performance.now() + 8000;
        for (;;) {
          await this.awaitReady(requestSignal);
          if (requestSignal.aborted || !this.valid(source)) throw new Error('cancelled');
          const coverage = await this.cache.snapshotSource(source, requestSignal);
          const gaps = globalThis.GaplessCacheCoverage.missing(coverage, start, end);
          if (!gaps.length) return await this.cache.readReadyRange(source, start, end, requestSignal);
          if (performance.now() >= deadline) throw new Error('native-only-cache-range-timeout');
          const position = state.points
            ? globalThis.GaplessCacheCoverage.seekBefore(gaps[0][0], state.points, state.rate) : 0;
          await this.queue.request({ source, position, signal: requestSignal, priority: priorityForRead(), budgetMs: 500 });
          // The next iteration re-reads the committed index. A completed batch
          // is not itself proof that the desired byte interval is available.
        }
      };
      const end = Math.min(size, 32768), head = await read(0, end, signal);
      return { kind: 'native-source', partial: true,
        response: new Response(head, { status: 206, headers: {
          'content-range': `bytes 0-${end - 1}/${size}`, 'content-length': String(end),
        } }),
        setIndex: (points, spec) => { state.points = points; state.rate = spec.rate; },
        seekRange: (start, end, requestSignal) => read(start, end, requestSignal),
      };
    }
  }
  globalThis.WindowsNativeByteSource = NativeByteSource;
})();
