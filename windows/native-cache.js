/* MIT. Read-only Windows playback cache, matched to the authorized source. */
(() => {
  const BITRATE = { standard: 128, higher: 192, exhigh: 320, lossless: 999, hires: 1999 };
  // Yield in bounded batches without the nested/background timer minimum.
  const yieldWork = (() => {
    const channel = new MessageChannel(), waiting = [];
    channel.port1.onmessage = () => waiting.shift()?.();
    return () => new Promise(resolve => { waiting.push(resolve); channel.port2.postMessage(0); });
  })();
  class WindowsNativeCache {
    constructor({ settings, trace }) {
      this.settings = settings; this.trace = trace; this.mounts = new Map(); this.generation = 0;
    }
    clear() { this.generation++; this.mounts.clear(); }
    async settleStoppedWrites(stops) {
      // A bounded observation, not an atomic native flush acknowledgement.
      // Stop can commit metadata after dispatch (observed about 154 ms later).
      if (!stops.length) return;
      const started = performance.now(), deadline = started + 2000;
      const fs = globalThis.betterncm_native?.fs;
      if (typeof fs?.getProperties !== 'function' || typeof fs?.exists !== 'function' || !this.services())
        throw new Error('native-cache-settle-unavailable');
      const settings = this.settings() || {};
      const roots = [...new Set([this.storage.cacheDir, settings.cacheDir, settings.storageCachePath, settings.oldCacheDir]
        .filter(p => typeof p === 'string' && /^[a-z]:[\\/]/i.test(p) && !p.split(/[\\/]/).includes('..'))
        .flatMap(p => { const root = p.replace(/[\\/]+$/, ''); return [root + '\\Cache', root]; }))];
      if (!roots.length || stops.length > 64) throw new Error('native-cache-settle-scope');
      const paths = new Set();
      for (const { source } of stops) {
        const hash = globalThis.GaplessAudioResources.fingerprint(source), rate = BITRATE[source.level];
        if (!/^\d+$/.test(String(source.songId)) || !hash || !rate) throw new Error('native-cache-settle-source');
        for (const root of roots) for (const ext of ['idx', 'info']) paths.add(`${root}\\${source.songId}-${rate}-${hash}.${ext}`);
      }
      let previous, unchangedSince = started;
      for (;;) {
        const signature = JSON.stringify([...paths].map(path => {
          const properties = fs.exists(path) ? fs.getProperties(path) : null;
          return properties ? [properties.type, properties.size, properties.lastModified] : null;
        }));
        const now = performance.now();
        if (signature !== previous) { previous = signature; unchangedSince = now; }
        if (now - started >= 500 && now - unchangedSince >= 250) {
          this.trace('native-cache-writes-settled', { waitMs: Math.round(now - started) }); return;
        }
        if (now >= deadline) throw new Error('native-cache-settle-timeout');
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
    async verifyParts(source, parts, signal) {
      if (!this.services()) throw new Error('native-only-cache-verifier');
      const hash = globalThis.GaplessAudioResources.fingerprint(source), size = Number(source.size ?? source.fileSize);
      if (!hash || !Number.isSafeInteger(size) || size <= 0) throw new Error('native-only-cache-source');
      const generation = this.generation;
      const check = () => { if (signal.aborted || generation !== this.generation) throw new Error('cancelled'); };
      const crypto = this.crypto, digest = crypto.algo.MD5.create(); let total = 0;
      let workAt = performance.now();
      for (const bytes of parts) {
        check();
        total += bytes.length;
        if (total > size) throw new Error('cache-integrity');
        // Bound synchronous hashing even when a caller supplies a whole song.
        for (let offset = 0; offset < bytes.length; offset += 65536) {
          check();
          const chunk = bytes.subarray(offset, offset + 65536);
          const words = new Array(Math.ceil(chunk.length / 4)).fill(0);
          for (let i = 0; i < chunk.length; i++) words[i >>> 2] |= chunk[i] << (24 - (i & 3) * 8);
          digest.update(crypto.lib.WordArray.create(words, chunk.length));
          if (performance.now() - workAt >= 4) { await yieldWork(); workAt = performance.now(); }
        }
      }
      check();
      if (total !== size || digest.finalize().toString(crypto.enc.Hex).toLowerCase() !== hash)
        throw new Error('cache-integrity');
    }
    async snapshotSource(source, signal) {
      const hash = globalThis.GaplessAudioResources.fingerprint(source), bitrate = BITRATE[source.level];
      const size = Number(source.size ?? source.fileSize), id = String(source.songId || '');
      if (!/^\d+$/.test(id) || !hash || !bitrate || source.freeTrialInfo || source.path
        || !Number.isSafeInteger(size) || size <= 0 || !this.services()) throw new Error('native-only-cache-source');
      const generation = this.generation, settings = this.settings() || {};
      const roots = [...new Set([this.storage.cacheDir, settings.cacheDir, settings.storageCachePath, settings.oldCacheDir]
        .filter(p => typeof p === 'string' && /^[a-z]:[\\/]/i.test(p) && !p.split(/[\\/]/).includes('..'))
        .flatMap(p => { const root = p.replace(/[\\/]+$/, ''); return [root + '\\Cache', root]; }))];
      const key = `${id}-${bitrate}-${hash}`;
      const empty = { size, ranges: [], complete: false, path: null, generation, key };
      for (const root of roots) {
        const path = root + '\\' + `${id}-${bitrate}-${hash}.uc`, indexPath = path.slice(0, -3) + '.idx';
        if (!await this.wait(betterncm.fs.exists(path), signal)
          || !await this.wait(betterncm.fs.exists(indexPath), signal)) continue;
        const blob = await this.wait(betterncm.fs.readFile(indexPath), signal);
        if (!blob || blob.size > 1024 * 1024) throw new Error('native-only-cache-index');
        const text = await this.wait(blob.text(), signal);
        let coverage;
        try { coverage = globalThis.GaplessCacheCoverage.parse(text, size); }
        catch (error) {
          this.trace('native-cache-index-rejected', { id, reason: error.message });
          continue;
        }
        if (generation !== this.generation) throw new Error('cancelled');
        return { ...coverage, path, generation, key };
      }
      if (generation !== this.generation) throw new Error('cancelled');
      return empty;
    }
    async readReadyRange(source, start, end, signal, knownCoverage = null) {
      const key = `${source.songId}-${BITRATE[source.level]}-${globalThis.GaplessAudioResources.fingerprint(source)}`;
      const snapshot = knownCoverage?.key === key && knownCoverage.generation === this.generation
        && knownCoverage.size === Number(source.size ?? source.fileSize)
        ? knownCoverage : await this.snapshotSource(source, signal);
      if (!snapshot.path || globalThis.GaplessCacheCoverage.missing(snapshot, start, end).length)
        throw new Error('native-cache-range-missing');
      let mounted = this.mounts.get(snapshot.path);
      if (!mounted) {
        mounted = await this.wait(betterncm.fs.mountFile(snapshot.path), signal);
        if (snapshot.generation !== this.generation) throw new Error('cancelled');
        if (this.mounts.size >= 16) this.mounts.delete(this.mounts.keys().next().value);
        this.mounts.set(snapshot.path, mounted);
      }
      const url = new URL(mounted);
      if (url.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(url.hostname)) throw new Error('cache-mount');
      // A native partial .uc can be physically shorter than the final song.
      // Its committed index authorizes the interval; the local server reports
      // current physical length, not the final source length, in Content-Range.
      const bytes = await globalThis.GaplessSeekRange.read(url.href, start, end, snapshot.size, signal, true, true);
      if (snapshot.generation !== this.generation || signal.aborted) throw new Error('cancelled');
      return bytes;
    }
    services() {
      if (this.storage && this.crypto) return true;
      if (!this.runtime) {
        const key = 'gapless-windows-cache';
        window.webpackJsonp.push([[], { [key]: (m, e, r) => { this.runtime = r; } }, [[key]]]);
        if (this.runtime) { delete this.runtime.m[key]; delete this.runtime.c[key]; }
      }
      for (const mod of Object.values(this.runtime?.c || {})) {
        for (const value of [mod.exports, mod.exports?.default, mod.exports?.Storage]) {
          if (typeof value?.getTrackFromCacheFast === 'function') this.storage = value;
          if (value?.algo?.MD5?.create && value?.lib?.WordArray?.create) this.crypto = value;
        }
      }
      return this.storage && this.crypto;
    }
    wait(promise, signal) {
      return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (error, value) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener('abort', abort);
          if (error) reject(value); else resolve(value);
        };
        const abort = () => finish(true, new Error('cancelled'));
        // The native operation was already started by the caller. Observe its
        // rejection even when cancellation preceded entry into this wrapper.
        Promise.resolve(promise).then(value => finish(false, value), error => finish(true, error));
        if (signal.aborted) abort();
        else signal.addEventListener('abort', abort, { once: true });
      });
    }
    async read(ref, source, signal, full = false) {
      const hash = globalThis.GaplessAudioResources.fingerprint(source), bitrate = BITRATE[source.level];
      const size = Number(source.size);
      if (!/^\d+$/.test(ref.id) || !hash || !bitrate || !Number.isSafeInteger(size) || size <= 0
        || !this.services()) return null;
      const record = await this.wait(this.storage.getTrackFromCacheFast({ trackId: ref.id, md5: hash, bitrate }), signal);
      if (Number(record?.cached) !== 100 || String(record.songId) !== ref.id
        || Number(record.bitrate) !== bitrate || String(record.md5).toLowerCase() !== hash) return null;
      const metadata = JSON.parse(record.playInfoStr || '{}');
      if (metadata.resourceType !== 'track' || metadata.freeTrialInfo || metadata.level !== source.level
        || String(metadata.md5).toLowerCase() !== hash || Number(metadata.size) !== size) return null;
      const settings = this.settings() || {};
      const roots = [...new Set([this.storage.cacheDir, settings.cacheDir, settings.storageCachePath, settings.oldCacheDir]
        .filter(p => typeof p === 'string' && /^[a-z]:[\\/]/i.test(p) && !p.split(/[\\/]/).includes('..'))
        .flatMap(p => { const root = p.replace(/[\\/]+$/, ''); return [root + '\\Cache', root]; }))];
      const name = `${ref.id}-${bitrate}-${hash}.uc`;
      let path;
      for (const root of roots) {
        const candidate = root + '\\' + name;
        if (await this.wait(betterncm.fs.exists(candidate), signal)) { path = candidate; break; }
      }
      if (!path) return null;
      if (!this.mounts.has(path)) {
        const url = await this.wait(betterncm.fs.mountFile(path), signal);
        if (this.mounts.size >= 16) this.mounts.delete(this.mounts.keys().next().value);
        this.mounts.set(path, url);
      }
      const url = new URL(this.mounts.get(path));
      if (url.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(url.hostname)) throw new Error('cache-mount');
      const indexed = !full && source.audioFormat === 'flac';
      const response = await fetch(url.href, { signal, redirect: 'error',
        ...(indexed ? { headers: { Range: `bytes=0-${Math.min(size, 32768) - 1}` } } : {}) });
      const partial = indexed && response.status === 206;
      if (!response.ok) { this.mounts.delete(path); throw new Error('cache-read'); }
      const seekRange = (start, end, rangeSignal) => globalThis.GaplessSeekRange.read(url.href, start, end, size, rangeSignal, true);
      const verifyParts = (parts, verifySignal) => this.verifyParts(source, parts, verifySignal);
      const worker = globalThis.GaplessCacheWorker?.create(hash, size, signal);
      if (worker) return { kind: 'native-cache', response, partial, seekRange, verifyParts, worker: true,
        transform: bytes => worker.transform(bytes), dispose: () => worker.dispose(),
        validate: async total => {
          await worker.validate(total);
          this.trace('native-cache-hit', { id: ref.id, level: source.level, bytes: total, md5Verified: true, worker: true });
        } };
      const crypto = this.crypto, digest = crypto.algo.MD5.create();
      return { kind: 'native-cache', response, partial, seekRange, verifyParts,
        transform(bytes) {
          const words = new Array(Math.ceil(bytes.length / 4)).fill(0);
          for (let i = 0; i < bytes.length; i++) {
            bytes[i] ^= 0xa3;
            words[i >>> 2] |= bytes[i] << (24 - (i & 3) * 8);
          }
          digest.update(crypto.lib.WordArray.create(words, bytes.length));
          return bytes;
        },
        validate: total => {
          if (total !== size || digest.finalize().toString(crypto.enc.Hex).toLowerCase() !== hash)
            throw new Error('cache-integrity');
          this.trace('native-cache-hit', { id: ref.id, level: source.level, bytes: total, md5Verified: true });
        }
      };
    }
  }
  globalThis.WindowsNativeCache = WindowsNativeCache;
})();
