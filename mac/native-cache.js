/* MIT. Read-only reuse of NetEase's completed, authorized playback cache. */
(() => {
  'use strict';
  const BITRATE = { standard: 128, higher: 192, exhigh: 320, lossless: 999, hires: 1999 };
  class NativeCache {
    constructor({ storage, crypto, settings, trace }) {
      this.storage = storage; this.crypto = crypto; this.settings = settings; this.trace = trace;
      this.home = null; this.mounts = new Map(); this.generation = 0;
    }
    clear() { this.generation++; this.mounts.clear(); }
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
    async nativeFs(method, args, signal) {
      const result = await fetch(BETTERNCM_API_PATH + '/native/fs.' + method, {
        method: 'POST', signal, headers: { BETTERNCM_API_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(args),
      });
      const data = await result.json(); return data.ok ? data.value : null;
    }
    async read(ref, source, signal, full = false) {
      const generation = this.generation;
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
      if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1') throw new Error('native-cache-mount');
      if (generation !== this.generation) throw new Error('cancelled');
      if (!full && source.audioFormat === 'flac' && globalThis.GaplessSeekRange) {
        const readRange = async (start, end, rangeSignal) => {
          if (generation !== this.generation) throw new Error('cancelled');
          const bytes = await globalThis.GaplessSeekRange.read(url, start, end, size, rangeSignal, true);
          if (generation !== this.generation) throw new Error('cancelled');
          return bytes;
        };
        const end = Math.min(size, 32768), head = await readRange(0, end, signal);
        return { kind: 'native-cache', partial: true, seekRange: readRange,
          response: new Response(head, { status: 206, headers: {
            'content-range': `bytes 0-${end - 1}/${size}`, 'content-length': String(end) } }),
          verifyParts: async (parts, verifySignal) => {
            const digest = crypto.algo.MD5.create(); let total = 0;
            for (const part of parts) for (let at = 0; at < part.length; at += 65536) {
              if (verifySignal.aborted || generation !== this.generation) throw new Error('cancelled');
              const chunk = part.subarray(at, at + 65536), words = new Array(Math.ceil(chunk.length / 4)).fill(0);
              for (let i = 0; i < chunk.length; i++) words[i >>> 2] |= chunk[i] << (24 - (i & 3) * 8);
              total += chunk.length; digest.update(crypto.lib.WordArray.create(words, chunk.length));
              await new Promise(resolve => setTimeout(resolve, 0));
            }
            if (verifySignal.aborted || generation !== this.generation) throw new Error('cancelled');
            if (total !== size || digest.finalize().toString(crypto.enc.Hex).toLowerCase() !== hash)
              throw new Error('cache-integrity');
          } };
      }
      const response = await fetch(url, { signal });
      const worker = globalThis.GaplessCacheWorker?.create(hash, size, signal);
      if (worker) return { kind: 'native-cache', response, worker: true,
        transform: bytes => worker.transform(bytes), dispose: () => worker.dispose(),
        validate: async total => {
          await worker.validate(total);
          this.trace('native-cache-hit', { id: ref.id, level: source.level, bytes: total, md5Verified: true, worker: true });
        } };
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
