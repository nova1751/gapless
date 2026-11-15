/* MIT. Bounded source acquisition and isolated decoding; no playback context access. */
(() => {
  'use strict';
  const MiB = 1024 * 1024;
  function header(bytes, durationHint = 0) {
    const a = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (a.length >= 42 && a[0] === 102 && a[1] === 76 && a[2] === 97 && a[3] === 67) {
      if ((a[4] & 127) !== 0 || ((a[5] << 16) | (a[6] << 8) | a[7]) !== 34) return null;
      const rate = (a[18] << 12) | (a[19] << 4) | (a[20] >> 4);
      const channels = ((a[20] >> 1) & 7) + 1;
      const bits = (((a[20] & 1) << 4) | (a[21] >> 4)) + 1;
      const frames = (a[21] & 15) * 4294967296 + new DataView(a.buffer, a.byteOffset, a.byteLength).getUint32(22);
      if (rate < 8000 || rate > 192000 || !frames || ![1, 2].includes(channels)) return null;
      return { codec: 'flac', rate, channels, bits, frames, duration: frames / rate };
    }
    let offset = 0;
    if (a.length >= 10 && a[0] === 73 && a[1] === 68 && a[2] === 51) {
      offset = 10 + ((a[6] & 127) << 21) + ((a[7] & 127) << 14) + ((a[8] & 127) << 7) + (a[9] & 127);
      if (a[5] & 16) offset += 10;
    }
    for (let i = offset; i < Math.min(a.length - 4, offset + 4096); i++) {
      if (a[i] !== 255 || (a[i + 1] & 224) !== 224 || ((a[i + 1] >> 1) & 3) !== 1) continue;
      const version = (a[i + 1] >> 3) & 3, rateIndex = (a[i + 2] >> 2) & 3;
      const bitrateIndex = a[i + 2] >> 4;
      if (version === 1 || rateIndex === 3 || bitrateIndex === 0 || bitrateIndex === 15) continue;
      if (!Number.isFinite(durationHint) || durationHint <= 0) return null;
      const rate = [44100, 48000, 32000][rateIndex] / (version === 3 ? 1 : version === 2 ? 2 : 4);
      const channels = (a[i + 3] >> 6) === 3 ? 1 : 2;
      return { codec: 'mp3', rate, channels, bits: null, frames: Math.ceil(durationHint * rate) + 2304, duration: durationHint };
    }
    return null;
  }
  function fingerprint(source) {
    const hash = String(source.md5 || '').toLowerCase();
    if (/^[a-f0-9]{32}$/.test(hash)) return hash;
    try {
      const match = new URL(source.url || source.musicurl).pathname.match(/([a-f0-9]{32})\.(?:flac|mp3)$/i);
      return match?.[1].toLowerCase() || null;
    } catch { return null; }
  }
  class AudioResources {
    constructor({ resolve, trace, acceptRate, readCache = null, exactSize = false, openLocal, limit = 512 * MiB, fileLimit = 128 * MiB }) {
      this.resolve = resolve; this.trace = trace; this.acceptRate = acceptRate; this.readCache = readCache;
      this.limit = limit; this.fileLimit = fileLimit; this.exactSize = exactSize; this.openLocal = openLocal;
      this.entries = new Map(); this.jobs = new Map(); this.failures = new Map();
      this.tail = Promise.resolve(); this.reserved = 0; this.enabled = true;
    }
    requestKey(ref) { return `${ref.account}:${ref.id}:${ref.level}`; }
    held() { return [...this.entries.values()].reduce((n, entry) => n + entry.size, 0); }
    lookup(ref, source) {
      const hash = source && fingerprint(source);
      return [...this.entries.values()].find(e => !e.stream?.error && e.requestKey === this.requestKey(ref)
        && (!source || (source.localKey ? source.localKey === e.source.localKey
          : this.exactSize ? this.identity(source) === e.identity && !!e.identity
            : e.hash && hash === e.hash && e.level === source.level))) || null;
    }
    identity(info) {
      if (!info) return null;
      if (info.localKey) return JSON.stringify(['local', info.localKey]);
      const hash = fingerprint(info);
      return hash ? JSON.stringify([hash, info.level, Number(info.fileSize)]) : null;
    }
    async obtain(ref, info) {
      const requestKey = this.requestKey(ref);
      const cached = this.lookup(ref, info);
      if (cached) return cached;
      const identity = this.exactSize ? this.identity(info) : null;
      const pending = this.jobs.get(requestKey);
      if (pending && !pending.controller.signal.aborted) {
        if (pending.identity === identity) {
          const entry = await pending.promise;
          if (info && !this.exactSize && !info.localKey
            && (entry.hash !== fingerprint(info) || entry.level !== info.level)) return this.obtain(ref, info);
          return entry;
        }
        pending.controller.abort('cancelled');
      }
      const previousFailure = this.failures.get(requestKey);
      const failure = previousFailure?.identity === identity ? previousFailure : null;
      if (failure && (failure.permanent || failure.retryAt > performance.now())) throw new Error(failure.reason);
      const controller = new AbortController();
      const job = { ref, controller, identity, reserve: 0, queuedAt: performance.now() };
      const early = this.streaming ? new Promise(resolve => { job.publish = resolve; }) : null;
      const run = () => this.acquire(job, info);
      job.promise = this.tail.then(run, run).catch(error => {
        if (this.jobs.get(requestKey) === job &&
          (!controller.signal.aborted || controller.signal.reason === 'timeout') && error.message !== 'cancelled') {
          const attempts = (failure?.attempts || 0) + 1;
          const permanent = /^native-only-|unsupported-|decode-/.test(error.message) || attempts >= 3;
          this.failures.set(requestKey, { identity, reason: error.message, permanent, attempts,
            retryAt: performance.now() + Math.min(120000, 10000 * 2 ** (attempts - 1)) });
        }
        throw error;
      }).finally(() => {
        this.reserved -= job.reserve; job.reserve = 0;
        if (this.jobs.get(requestKey) === job) this.jobs.delete(requestKey);
      });
      this.tail = job.promise.catch(() => {});
      if (early) job.promise = Promise.race([early, job.promise]);
      this.jobs.set(requestKey, job);
      return job.promise;
    }
    reserve(job, amount) {
      if (this.held() + this.reserved - job.reserve + amount > this.limit) throw new Error('native-only-memory');
      this.reserved += amount - job.reserve; job.reserve = amount;
    }
    check(job) {
      if (!this.enabled || job.controller.signal.aborted) throw new Error('cancelled');
    }
    async acquire(job, info) {
      this.check(job);
      this.trace('resource-start', { id: job.ref.id, queueMs: Math.round(performance.now() - job.queuedAt) });
      const timeout = job.acquisitionTimer = setTimeout(() => job.controller.abort('timeout'), 25000);
      try {
        const source = info ? { ...info, url: info.musicurl, duration: Number(info.songDuration) / 1000,
          size: Number(info.fileSize) } : await this.resolve(job.ref, job.controller.signal);
        this.check(job);
        if (source.freeTrialInfo) throw new Error('native-only-rights');
        if (Number(source.size) > this.fileLimit) throw new Error('native-only-file-size');
        if (this.openLocal && source.localKey) {
          this.reserve(job, this.fileLimit);
          const blob = await this.openLocal(source);
          this.check(job);
          if (!(blob.size > 0 && blob.size <= this.fileLimit)) throw new Error('native-only-file-size');
          return await this.decodeInput(job, source, { kind: 'local-file', response: new Response(blob, { headers: { 'content-length': String(blob.size) } }) });
        }
        if (this.readCache) {
          const cacheController = new AbortController();
          const cancelCache = () => cacheController.abort(job.controller.signal.reason);
          job.controller.signal.addEventListener('abort', cancelCache, { once: true });
          const cacheTimeout = setTimeout(() => cacheController.abort('cache-timeout'), 8000);
          try {
            const cache = await this.readCache(job.ref, source, cacheController.signal);
            this.check(job);
            if (this.streaming && cache) clearTimeout(cacheTimeout);
            if (cache) return await this.decodeInput(job, source, cache);
          } catch (error) {
            this.check(job);
            // A format/rate/budget rejection also applies to the same original
            // bytes from the network. Keep native playback without redownloading.
            if (/^(native-only-|decode-)/.test(error.message)) throw error;
            // No cache path, metadata or mounted-file token enters diagnostics.
            this.trace('native-cache-fallback', { id: job.ref.id, reason: 'cache-unavailable-or-invalid' });
          } finally {
            clearTimeout(cacheTimeout);
            job.controller.signal.removeEventListener('abort', cancelCache);
            cacheController.abort('finished');
          }
        }
        this.check(job);
        if (!source.url) throw new Error('native-only-rights');
        if (!['https:', 'http:'].includes(new URL(source.url).protocol)) throw new Error('native-only-source');
        const response = await fetch(source.url, { signal: job.controller.signal });
        return await this.decodeInput(job, source, { kind: 'network', response });
      } catch (error) {
        if (job.controller.signal.reason === 'timeout') throw new Error('download-timeout');
        if (job.controller.signal.aborted) throw new Error('cancelled');
        throw error;
      } finally { clearTimeout(timeout); }
    }
    async decodeInput(job, source, input) {
      let reader;
      const started = performance.now();
      try {
        const response = input.response;
        if (!response.ok) throw new Error(`download-${response.status}`);
        const declared = Number(response.headers.get('content-length')) || Number(source.size) || 0;
        if (declared > this.fileLimit) throw new Error('native-only-file-size');
        if (!response.body?.getReader) throw new Error('native-only-stream');
        reader = response.body.getReader();
        const chunks = []; let total = 0, spec = null, prefix = new Uint8Array(0), workAt = performance.now();
        while (true) {
          this.check(job);
          const nextChunk = await reader.read();
          if (nextChunk.done) break;
          // Bound XOR/hash work even if the host delivers a large file chunk.
          const step = input.transform ? 64 * 1024 : nextChunk.value.byteLength;
          for (let start = 0; start < nextChunk.value.byteLength; start += step) {
            this.check(job);
            const part = nextChunk.value.subarray(start, start + step);
            const value = input.transform ? await input.transform(part) : part;
            total += value.byteLength;
            if (total > this.fileLimit) throw new Error('native-only-file-size');
            if (!spec) {
              const next = new Uint8Array(prefix.byteLength + Math.min(value.byteLength, MiB - prefix.byteLength));
              next.set(prefix); next.set(value.subarray(0, next.length - prefix.length), prefix.length); prefix = next;
              spec = header(prefix, Number(source.duration || job.ref.duration));
              if (!spec && prefix.byteLength >= MiB) throw new Error('native-only-format');
              if (spec && !this.acceptRate(job.ref, spec.rate)) throw new Error('native-only-sample-rate');
            }
            // The same encoded/PCM budget applies to disk cache and download.
            const pcm = spec ? Math.ceil(spec.frames * spec.channels * 4 * 1.05) : 0;
            this.reserve(job, pcm * 2 + Math.max(total, declared) * 2);
            chunks.push(value);
            if (input.transform && performance.now() - workAt >= 6) {
              await new Promise(resolve => setTimeout(resolve, 0)); workAt = performance.now();
            }
          }
        }
        if (!spec) throw new Error('native-only-format');
        if (this.exactSize && total !== (source.localKey ? declared : Number(source.size))) throw new Error('native-only-source-size');
        this.check(job); await input.validate?.(total); this.check(job);
        const readValidateMs = Math.round(performance.now() - started);
        const bytes = new Uint8Array(total); let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
        chunks.length = 0; prefix = null;
        const decoder = new OfflineAudioContext(spec.channels, 1, spec.rate);
        const decodeStarted = performance.now();
        let buffer;
        try { buffer = await decoder.decodeAudioData(bytes.buffer); }
        catch { throw new Error('decode-unsupported'); }
        this.check(job);
        if (buffer.sampleRate !== spec.rate || buffer.numberOfChannels !== spec.channels) throw new Error('native-only-decoded-spec');
        const size = buffer.length * buffer.numberOfChannels * 4;
        if (size > spec.frames * spec.channels * 4 * 1.05
          || (this.exactSize && spec.codec === 'flac' && buffer.length !== spec.frames)) throw new Error('native-only-decoded-size');
        const hash = fingerprint(source);
        const entry = { id: job.ref.id, requestKey: this.requestKey(job.ref),
          key: `${this.requestKey(job.ref)}:${job.identity || hash || `unverified-${performance.now()}`}:${source.level}:${spec.rate}`,
          level: source.level, hash, identity: job.identity, source, spec, buffer, size, duration: buffer.duration,
          requestedLevel: job.ref.level, origin: input.kind, pins: 0 };
        this.entries.set(entry.key, entry);
        this.failures.delete(entry.requestKey);
        this.trace('decoded', { id: entry.id, level: entry.level, origin: entry.origin, sourceRate: spec.rate,
          decodedRate: buffer.sampleRate, channels: spec.channels, size,
          readValidateMs, decodeMs: Math.round(performance.now() - decodeStarted), worker: !!input.worker });
        return entry;
      } finally {
        input.dispose?.();
        try { await reader?.cancel(); } catch { /* Reader already completed or aborted. */ }
        // Release the failed input before trying another source. Do not hide
        // two retained encoded/PCM reservations under the same job.
        this.reserved -= job.reserve; job.reserve = 0;
      }
    }
    pin(entry) { if (entry) entry.pins++; }
    unpin(entry) { if (entry) entry.pins = Math.max(0, entry.pins - 1); }
    retain(refs) {
      const keep = new Set(refs.filter(Boolean).map(r => this.requestKey(r)));
      for (const [key, job] of this.jobs) if (!keep.has(key)) job.controller.abort('cancelled');
      for (const [key, entry] of this.entries) if (!keep.has(entry.requestKey) && !entry.pins) this.entries.delete(key);
      for (const key of this.failures.keys()) if (!keep.has(key)) this.failures.delete(key);
    }
    stop() { this.enabled = false; for (const job of this.jobs.values()) job.controller.abort('cancelled'); }
    resetFailures() { this.failures.clear(); }
    status() { return { held: this.held(), reserved: this.reserved, limit: this.limit, pending: this.jobs.size }; }
  }
  globalThis.GaplessAudioResources = { AudioResources, header, fingerprint };
})();
