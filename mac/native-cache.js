/* MIT. Read-only reuse of NetEase's completed, authorized playback cache. */
(() => {
  'use strict';
  const BITRATE = { standard: 128, higher: 192, exhigh: 320, lossless: 999, hires: 1999 };
  class NativeCache {
    constructor({ storage, crypto, settings, trace }) {
      this.storage = storage; this.crypto = crypto; this.settings = settings; this.trace = trace;
      this.home = null; this.mounts = new Map();
    }
    roots() {
      const settings = this.settings() || {}, roots = [];
      for (const p of [settings.storageCachePath, settings.cacheDir, settings.oldCacheDir]) {
        if (typeof p === 'string' && p.startsWith('/')) {
          const base = p.replace(/\/+$/, ''); roots.push(base, base + '/online_play_cache');
        }
      }
      if (this.home) roots.push(this.home + '/Library/Containers/com.netease.163music/Data/Library/Caches/online_play_cache',
        this.home + '/Library/Caches/online_play_cache');
      return [...new Set(roots)];
    }
    wait(promise, signal) {
      if (signal.aborted) return Promise.reject(new Error('cancelled'));
      return new Promise((resolve, reject) => {
        const abort = () => reject(new Error('cancelled'));
        signal.addEventListener('abort', abort, { once: true });
        Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
      });
    }
    async nativeFs(method, args, signal) {
      const result = await fetch(BETTERNCM_API_PATH + '/native/fs.' + method, {
        method: 'POST', signal, headers: { BETTERNCM_API_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(args),
      });
      const data = await result.json(); return data.ok ? data.value : null;
    }
    async read(ref, source, signal) {
      const hash = String(source.md5 || '').toLowerCase(), bitrate = BITRATE[source.level];
      const crypto = this.crypto(), storage = this.storage();
      if (!/^\d+$/.test(ref.id) || !/^[a-f0-9]{32}$/.test(hash) || !bitrate
        || !crypto?.algo?.MD5?.create || !crypto?.lib?.WordArray?.create
        || !storage?.getTrackFromCacheFast || !globalThis.betterncm?.fs?.mountFile) return null;
      const record = await this.wait(storage.getTrackFromCacheFast({ trackId: ref.id, md5: hash, bitrate }), signal);
      if (signal.aborted) throw new Error('cancelled');
      if (Number(record?.cached) !== 100 || String(record.songId) !== ref.id || Number(record.bitrate) !== bitrate
        || String(record.md5).toLowerCase() !== hash || String(record.et) !== '1') return null;
      const metadata = JSON.parse(record.playInfoStr || '{}');
      const size = Number(source.size);
      if (metadata.resourceType !== 'track' || metadata.freeTrialInfo || metadata.level !== source.level
        || String(metadata.md5).toLowerCase() !== hash || Number(metadata.size) !== size || !(size > 0)) return null;
      const name = `${ref.id}-_-_${bitrate}-_-_${hash}.uc!`;
      if (!this.home) {
        // The synchronous native shim can block the UI on an OS access prompt.
        // Directory discovery and metadata reads use abortable async requests.
        const libraries = await this.nativeFs('getLibraries', [], signal);
        const library = Array.isArray(libraries) && libraries.find(x => x.name === 'Music');
        if (library?.path?.endsWith('/Music')) this.home = library.path.slice(0,-6);
      }
      let path;
      for (const root of this.roots()) {
        if (signal.aborted) throw new Error('cancelled');
        const candidate = root + '/' + name, properties = await this.nativeFs('getProperties', [candidate], signal);
        if (properties?.type === 'file' && Number(properties.size) === size) { path = candidate; break; }
      }
      if (!path) return null;
      if (!this.mounts.has(path)) this.mounts.set(path, await this.wait(betterncm.fs.mountFile(path), signal));
      const url = this.mounts.get(path), parsed = new URL(url);
      if (parsed.hostname !== '127.0.0.1') throw new Error('native-cache-mount');
      const response = await fetch(url, { signal });
      const digest = crypto.algo.MD5.create();
      return { kind: 'native-cache', response,
        transform(bytes) {
          // Supported 3.1.12 UC cache stores the original encoded bytes XOR A3.
          // Restore them in memory only; never rewrite a NetEase cache file.
          const words = new Array(Math.ceil(bytes.length / 4)).fill(0);
          for (let i = 0; i < bytes.length; i++) {
            bytes[i] ^= 0xa3; words[i >>> 2] |= bytes[i] << (24 - (i & 3) * 8);
          }
          digest.update(crypto.lib.WordArray.create(words, bytes.length)); return bytes;
        },
        validate: total => {
          if (total !== size || digest.finalize().toString(crypto.enc.Hex).toLowerCase() !== hash)
            throw new Error('native-cache-integrity');
          this.trace('native-cache-hit', { id: ref.id, level: source.level, bytes: total, md5Verified: true });
        } };
    }
  }
  globalThis.GaplessNativeCache = NativeCache;
})();
