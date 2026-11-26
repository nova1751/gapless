/* MIT. Read-only reuse of NetEase's authorized, committed playback cache ranges. */
(() => {
  'use strict';
  const BITRATE = { standard: 128, higher: 192, exhigh: 320, lossless: 999, hires: 1999 };
  // Match the Windows cache lane: yield bounded work without timer clamping.
  const yieldWork = (() => {
    const channel = new MessageChannel(), waiting = [];
    channel.port1.onmessage = () => waiting.shift()?.();
    return () => new Promise(resolve => { waiting.push(resolve); channel.port2.postMessage(0); });
  })();
  class NativeCache {
    constructor({ storage, crypto, settings, trace }) {
      this.storage = storage; this.crypto = crypto; this.settings = settings; this.trace = trace;
      this.home = null; this.mounts = new Map(); this.generation = 0; this.preferredRoot = null;
    }
    clear() { this.generation++; this.mounts.clear(); this.preferredRoot = null; }
    setMount(path, url) {
      if (this.mounts.size >= 64) this.mounts.delete(this.mounts.keys().next().value);
      this.mounts.set(path, url);
      return url;
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
      const unique = [...new Set(roots)];
      if (this.preferredRoot && unique.includes(this.preferredRoot)) {
        return [this.preferredRoot, ...unique.filter(r => r !== this.preferredRoot)];
      }
      return unique;
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
    async nativeCall(command, args, signal) {
      let result;
      try {
        result = await fetch(BETTERNCM_API_PATH + '/native/' + command, {
          method: 'POST', signal, headers: { BETTERNCM_API_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(args),
        });
      } catch (error) {
        if (signal.aborted) throw new Error('cancelled');
        if (error instanceof TypeError) throw new Error('native-only-cache-host-unavailable');
        throw error;
      }
      if (!result.ok) throw new Error('native-only-cache-host-response');
      const data = await result.json(); return data.ok ? data.value : null;
    }
    nativeFs(method, args, signal) { return this.nativeCall('fs.' + method, args, signal); }
    async ensureHome(signal) {
      if (this.home) return;
      // app.datapath returns existing host metadata without stat-ing protected
      // Desktop/Documents/Music folders. fs.getLibraries can block the entire
      // host process on an unavailable folder or an OS access prompt.
      const profile = await this.nativeCall('app.datapath', [], signal);
      if (signal.aborted) throw new Error('cancelled');
      const suffix = '/Library/Application Support/BetterNCM-mac';
      if (typeof profile === 'string' && profile.startsWith('/') && profile.endsWith(suffix))
        this.home = profile.slice(0, -suffix.length);
      if (!this.home && !this.roots().length) throw new Error('native-only-cache-home-unavailable');
    }
    async readIndex(path, size, signal) {
      if (!Number.isSafeInteger(size) || size < 0 || size > 1024 * 1024)
        throw new Error('native-only-cache-index-size');
      if (size === 0) return '';
      // The native text endpoint uses readFileSync and can strand the host's
      // event loop on OS file access. Its mounted-file route streams instead.
      try {
        const bytes = await this.readMountedRange(path, 0, size, size, signal);
        return new TextDecoder().decode(bytes);
      } catch (error) {
        // An index may grow between stat and Range. Let snapshotSource compare
        // file versions before deciding whether the read was really invalid.
        if (error.message === 'seek-range-unsupported') return null;
        throw error;
      }
    }
    async readMountedRange(path, start, end, size, signal, xor = false, partialFile = false) {
      if (!this.mounts.has(path)) this.setMount(path, await this.wait(betterncm.fs.mountFile(path), signal));
      const url = this.mounts.get(path), parsed = new URL(url);
      if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1') throw new Error('native-only-cache-mount');
      try {
        return await globalThis.GaplessSeekRange.read(url, start, end, size, signal, xor, partialFile);
      } catch (error) {
        if (signal.aborted) throw new Error('cancelled');
        // A mounted stream can disappear when native replaces a cache file.
        // Discard only its mount; the caller must revalidate the index before
        // retrying. Never accept a failed/short range or invent valid bytes.
        if (error instanceof TypeError) {
          this.mounts.delete(path);
          throw new Error('native-only-cache-read-unavailable');
        }
        throw error;
      }
    }
    async indexStamp(sources, signal) {
      const paths = new Set();
      for (const source of sources) {
        const id = String(source.songId), hash = String(source.md5 || '').toLowerCase(), bitrate = BITRATE[source.level];
        if (!/^\d+$/.test(id) || !/^[a-f0-9]{32}$/.test(hash) || !bitrate) continue;
        for (const root of this.roots()) for (const suffix of ['!', ''])
          paths.add(`${root}/${id}-_-_${bitrate}-_-_${hash}.idx${suffix}`);
      }
      if (!paths.size) throw new Error('native-only-cache-index-path');
      const values = [];
      for (const path of paths) {
        if (signal.aborted) throw new Error('cancelled');
        const stat = await this.nativeFs('getProperties', [path], signal);
        values.push([path, stat?.type || null, stat?.size ?? null, stat?.lastModified ?? null]);
      }
      return JSON.stringify(values);
    }
    async snapshotSource(source, signal) {
      const generation = this.generation, id = String(source.songId), size = Number(source.size ?? source.fileSize);
      const hash = String(source.md5 || '').toLowerCase(), bitrate = BITRATE[source.level];
      if (!/^\d+$/.test(id) || !/^[a-f0-9]{32}$/.test(hash) || !bitrate || !Number.isSafeInteger(size) || size <= 0)
        throw new Error('native-only-cache-source');
      const check = () => { if (signal.aborted || generation !== this.generation) throw new Error('cancelled'); };
      const record = await this.wait(this.storage().getTrackFromCacheFast({ trackId: id, md5: hash, bitrate }), signal);
      check();
      if (!record || String(record.songId) !== id || Number(record.bitrate) !== bitrate
        || String(record.md5).toLowerCase() !== hash || String(record.et) !== '1') return null;
      const metadata = JSON.parse(record.playInfoStr || '{}');
      if (metadata.resourceType !== 'track' || metadata.freeTrialInfo || metadata.level !== source.level
        || String(metadata.md5).toLowerCase() !== hash || Number(metadata.size) !== size) return null;
      await this.ensureHome(signal); check();
      let readFailure;
      for (const root of this.roots()) {
        const prefix = `${root}/${id}-_-_${bitrate}-_-_${hash}`;
        for (const suffix of ['!', '']) {
          const path = prefix + '.uc' + suffix, indexPath = prefix + '.idx' + suffix;
          const file = await this.nativeFs('getProperties', [path], signal); check();
          if (file?.type !== 'file' || Number(file.size) > size) continue;
          const before = await this.nativeFs('getProperties', [indexPath], signal); check();
          if (before?.type !== 'file' || Number(before.size) > 1024 * 1024) continue;
          let text;
          try { text = await this.readIndex(indexPath, Number(before.size), signal); }
          catch (error) {
            check();
            if (error.message !== 'native-only-cache-read-unavailable') throw error;
            // Try the other native filename/root. A stat alone does not prove
            // that the index is readable, even when its length is complete.
            readFailure = error; continue;
          }
          check();
          const after = await this.nativeFs('getProperties', [indexPath], signal); check();
          if (!after || before.size !== after.size || before.lastModified !== after.lastModified) continue;
          if (text === null) throw new Error('native-only-cache-index-read');
          let coverage;
          try { coverage = globalThis.GaplessCacheCoverage.parse(text, size); }
          catch (error) {
            this.trace('native-cache-index-rejected', { id, reason: error.message });
            continue;
          }
          if (coverage.ranges.some(([, end]) => end > Number(file.size))) continue;
          this.preferredRoot = root;
          return { ...coverage, generation, path, indexPath };
        }
      }
      if (readFailure) throw readFailure;
      return null;
    }
    async readReadyRange(source, start, end, signal, coverage) {
      if (!coverage || coverage.generation !== this.generation
        || globalThis.GaplessCacheCoverage.missing(coverage, start, end).length) throw new Error('native-only-cache-gap');
      const finalized = coverage.complete && coverage.path.endsWith('.uc!');
      const before = finalized ? null : await this.nativeFs('getProperties', [coverage.path], signal);
      if (!finalized && (!before || Number(before.size) < end)) throw new Error('native-only-cache-changed');
      let bytes;
      try { bytes = await this.readMountedRange(coverage.path, start, end, coverage.size, signal, true, !finalized); }
      catch (error) {
        if (error.message === 'seek-range-unsupported') throw new Error('native-only-cache-changed');
        throw error;
      }
      if (finalized) {
        if (signal.aborted || coverage.generation !== this.generation) throw new Error('cancelled');
        return bytes;
      }
      const after = await this.nativeFs('getProperties', [coverage.path], signal);
      if (signal.aborted || coverage.generation !== this.generation) throw new Error('cancelled');
      if (!after || before.size !== after.size || before.lastModified !== after.lastModified)
        throw new Error('native-only-cache-changed');
      return bytes;
    }
    async verifyParts(source, parts, signal) {
      const crypto = this.crypto(), generation = this.generation;
      if (!crypto?.algo?.MD5?.create) throw new Error('native-only-cache-verifier');
      const size = Number(source.size ?? source.fileSize), hash = String(source.md5 || '').toLowerCase();
      if (!Number.isSafeInteger(size) || size <= 0 || !/^[a-f0-9]{32}$/.test(hash))
        throw new Error('native-only-cache-source');
      const digest = crypto.algo.MD5.create(); let total = 0, workAt = performance.now();
      for (const part of parts) for (let at = 0; at < part.length; at += 65536) {
        if (signal.aborted || generation !== this.generation) throw new Error('cancelled');
        const chunk = part.subarray(at, at + 65536), words = new Array(Math.ceil(chunk.length / 4)).fill(0);
        for (let i = 0; i < chunk.length; i++) words[i >>> 2] |= chunk[i] << (24 - (i & 3) * 8);
        total += chunk.length; digest.update(crypto.lib.WordArray.create(words, chunk.length));
        if (total > size) throw new Error('native-only-cache-integrity');
        if (performance.now() - workAt >= 4) { await yieldWork(); workAt = performance.now(); }
      }
      if (signal.aborted || generation !== this.generation) throw new Error('cancelled');
      if (total !== size || digest.finalize().toString(crypto.enc.Hex).toLowerCase() !== hash)
        throw new Error('native-only-cache-integrity');
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
      await this.ensureHome(signal);
      if (signal.aborted || generation !== this.generation) throw new Error('cancelled');
      let path;
      for (const root of this.roots()) {
        if (signal.aborted) throw new Error('cancelled');
        const candidate = root + '/' + name, properties = await this.nativeFs('getProperties', [candidate], signal);
        if (properties?.type === 'file' && Number(properties.size) === size) { this.preferredRoot = root; path = candidate; break; }
      }
      if (!path) return null;
      if (!this.mounts.has(path)) this.setMount(path, await this.wait(betterncm.fs.mountFile(path), signal));
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
            if (verifySignal.aborted || generation !== this.generation) throw new Error('cancelled');
            await this.verifyParts(source, parts, verifySignal);
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
