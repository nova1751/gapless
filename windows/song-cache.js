/* MIT. Bounded, source-keyed encoded intervals shared by all consumers. */
(() => {
  class SongCache {
    constructor(allowance, limit = 64 * 1024 * 1024) {
      this.allowance = allowance; this.limit = limit; this.bytes = 0;
      this.sources = new Map(); this.hits = 0; this.reads = 0; this.joins = 0;
    }
    source(key) {
      if (!this.sources.has(key)) {
        for (const [old, source] of this.sources) if (!source.parts.length && !source.pending.size) this.sources.delete(old);
        this.sources.set(key, { parts: [], pending: new Set() });
      }
      return this.sources.get(key);
    }
    put(key, start, bytes) {
      const source = this.source(key), end = start + bytes.length;
      let at = start;
      for (const part of [...source.parts].sort((a, b) => a.start - b.start)) {
        if (part.end <= at) continue;
        if (part.start >= end) break;
        if (part.start > at) this.add(source, at, bytes.subarray(at - start, part.start - start));
        at = Math.max(at, part.end);
      }
      if (at < end) this.add(source, at, bytes.subarray(at - start));
    }
    add(source, start, bytes) {
      const budget = Math.max(0, Math.min(this.limit, this.bytes + this.allowance()));
      while (this.bytes + bytes.length > budget) {
        let oldest, owner;
        for (const s of this.sources.values()) for (const p of s.parts)
          if (!p.pins && (!oldest || p.used < oldest.used)) { oldest = p; owner = s; }
        if (!oldest) return;
        owner.parts.splice(owner.parts.indexOf(oldest), 1); this.bytes -= oldest.bytes.length;
      }
      const copy = bytes.slice();
      source.parts.push({ start, end: start + copy.length, bytes: copy, used: performance.now() });
      this.bytes += copy.length;
    }
    subscribe(job, signal) {
      if (signal.aborted) return Promise.reject(new Error('cancelled'));
      job.users++;
      return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (fn, value) => {
          if (settled) return; settled = true;
          signal.removeEventListener('abort', cancel);
          if (--job.users === 0 && !job.done) job.controller.abort();
          fn(value);
        };
        const cancel = () => finish(reject, new Error('cancelled'));
        signal.addEventListener('abort', cancel, { once: true });
        job.promise.then(value => finish(resolve, value), error => finish(reject, error));
      });
    }
    async read(key, start, end, fetcher, signal) {
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start
        || end - start > 2 * 1024 * 1024) throw new Error('cache-range-bounds');
      const result = new Uint8Array(end - start), source = this.source(key);
      let at = start;
      while (at < end) {
        if (signal.aborted) throw new Error('cancelled');
        const part = source.parts.find(p => p.start <= at && p.end > at);
        if (part) {
          const to = Math.min(end, part.end); part.used = performance.now(); this.hits++;
          result.set(part.bytes.subarray(at - part.start, to - part.start), at - start); at = to; continue;
        }
        let job = [...source.pending].find(p => !p.controller.signal.aborted && p.start <= at && p.end > at);
        if (job) this.joins++;
        else {
          let to = Math.min(end, at + 2 * 1024 * 1024);
          for (const p of [...source.parts, ...source.pending]) if (p.start > at) to = Math.min(to, p.start);
          job = { start: at, end: to, users: 0, done: false, controller: new AbortController() };
          const request = job; this.reads++;
          job.promise = Promise.resolve().then(() => fetcher(request.start, request.end, request.controller.signal))
            .then(bytes => {
              if (request.controller.signal.aborted || bytes.length !== request.end - request.start) throw new Error('cancelled');
              if (this.sources.get(key) === source) this.put(key, request.start, bytes);
              return bytes;
            }).finally(() => { request.done = true; source.pending.delete(request); });
          source.pending.add(job);
        }
        const bytes = await this.subscribe(job, signal), to = Math.min(end, job.end);
        result.set(bytes.subarray(at - job.start, to - job.start), at - start); at = to;
      }
      return result;
    }
    complete(key, size) {
      const parts = [...(this.sources.get(key)?.parts || [])].sort((a, b) => a.start - b.start);
      let at = 0;
      for (const part of parts) { if (part.start !== at) return null; at = part.end; }
      if (at !== size) return null;
      for (const p of parts) p.pins = (p.pins || 0) + 1;
      const bytes = parts.map(p => p.bytes);
      bytes.release = () => { for (const p of parts) p.pins--; };
      return bytes;
    }
    clear() {
      for (const s of this.sources.values()) for (const p of s.pending) p.controller.abort();
      this.sources.clear(); this.bytes = 0;
    }
    status() { return { bytes: this.bytes, limit: this.limit, hits: this.hits, reads: this.reads, joins: this.joins }; }
  }
  globalThis.GaplessSongCache = SongCache;
})();
