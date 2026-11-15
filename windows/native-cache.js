/* MIT. Read-only Windows 3.1.43 playback cache, matched to the authorized source. */
(() => {
  const BITRATE = { standard: 128, higher: 192, exhigh: 320, lossless: 999, hires: 1999 };
  class WindowsNativeCache {
    constructor({ settings, trace }) {
      this.settings = settings; this.trace = trace; this.mounts = new Map();
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
      if (signal.aborted) return Promise.reject(new Error('cancelled'));
      return new Promise((resolve, reject) => {
        const abort = () => reject(new Error('cancelled'));
        signal.addEventListener('abort', abort, { once: true });
        Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
      });
    }
    async peek(ref, info, signal) {
      let input, reader;
      try {
        input = await this.read(ref, { ...info, size: Number(info.fileSize) }, signal);
        if (!input) return null;
        reader = input.response.body.getReader();
        const { value, done } = await this.wait(reader.read(), signal);
        if (done || !value) return null;
        const bytes = await input.transform(value.subarray(0, Math.min(value.length, 64 * 1024)));
        // Compatibility hint only; full size/MD5 verification is still required.
        return globalThis.GaplessAudioResources.header(bytes, Number(info.songDuration) / 1000);
      } finally {
        input?.dispose?.();
        try { await reader?.cancel(); } catch {}
      }
    }
    async read(ref, source, signal) {
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
      const response = await fetch(url.href, { signal, redirect: 'error' });
      if (!response.ok) { this.mounts.delete(path); throw new Error('cache-read'); }
      const worker = globalThis.GaplessCacheWorker?.create(hash, size, signal);
      if (worker) return { kind: 'native-cache', response, worker: true,
        transform: bytes => worker.transform(bytes), dispose: () => worker.dispose(),
        validate: async total => {
          await worker.validate(total);
          this.trace('native-cache-hit', { id: ref.id, level: source.level, bytes: total, md5Verified: true, worker: true });
        } };
      const crypto = this.crypto, digest = crypto.algo.MD5.create();
      return { kind: 'native-cache', response,
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
