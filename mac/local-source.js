/* MIT. Native-selected local FLAC; versioned, read-only bounded Range input. */
(() => {
  'use strict';
  class LocalSource {
    constructor({ fs, mount }) { this.fs = fs; this.mount = mount; this.mounts = new Map(); }
    path(info) {
      if (typeof info?.path !== 'string' || info.freeTrialInfo || info.isCue
        || Number(info.starttime) || (info.type !== undefined && info.type !== 0)) return null;
      let path = info.path;
      try {
        if (path.startsWith('file:')) {
          const url = new URL(path);
          if (!['', 'localhost'].includes(url.hostname)) return null;
          path = decodeURIComponent(url.pathname);
        }
      } catch { return null; }
      return path.startsWith('/') && /\.flac$/i.test(path) && !path.split('/').includes('..') ? path : null;
    }
    duration(row, info) {
      return Number(info?.songDuration) || Number(row?.localTrack?.duration)
        || Number(row?.localTrack?.origin?.duration) || Number(row?.track?.duration) || Number(row?.duration) || 0;
    }
    async stat(path, signal) {
      if (signal?.aborted) throw new Error('cancelled');
      const controller = new AbortController();
      let abort, timer;
      let stat;
      try {
        stat = await new Promise((resolve, reject) => {
          const stop = reason => { controller.abort(); reject(new Error(reason)); };
          abort = () => stop('cancelled');
          signal?.addEventListener('abort', abort, { once: true });
          timer = setTimeout(() => stop('native-only-local-read-timeout'), 3000);
          Promise.resolve().then(() => this.fs('getProperties', [path], controller.signal)).then(resolve, reject);
        });
      } finally {
        clearTimeout(timer); signal?.removeEventListener('abort', abort);
      }
      if (signal?.aborted) throw new Error('cancelled');
      if (stat?.type !== 'file' || !Number.isSafeInteger(Number(stat.size)) || Number(stat.size) <= 0
        || !Number.isSafeInteger(Number(stat.lastModified))) throw new Error('native-only-local-version');
      return { size: Number(stat.size), version: JSON.stringify([Number(stat.size), Number(stat.lastModified)]) };
    }
    async info(info, row, signal = new AbortController().signal) {
      const path = this.path(info);
      if (!path) throw new Error('native-only-local-format');
      const stat = await this.stat(path, signal);
      return { ...info, path, localKey: path, localVersion: stat.version, fileSize: stat.size,
        size: stat.size, level: info.level || 'local', audioFormat: 'flac', songDuration: this.duration(row, info) };
    }
    async validate(source, signal = new AbortController().signal) {
      const path = this.path(source), stat = path && await this.stat(path, signal);
      if (!stat || source.localKey !== path || source.localVersion !== stat.version || Number(source.fileSize) !== stat.size)
        throw new Error('native-only-local-changed');
    }
    matches(source, info) { return !!source?.localKey && source.localKey === this.path(info); }
    async open(source, signal) {
      await this.validate(source, signal);
      if (!this.mounts.has(source.localKey)) {
        const mounted = await this.mount(source.localKey, signal);
        if (this.mounts.size >= 64) this.mounts.delete(this.mounts.keys().next().value);
        this.mounts.set(source.localKey, mounted);
      }
      const url = new URL(this.mounts.get(source.localKey));
      if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname)) throw new Error('native-only-local-mount');
      const read = async (start, end, rangeSignal) => {
        if (signal.aborted || rangeSignal.aborted) throw new Error('cancelled');
        await this.validate(source, rangeSignal);
        const bytes = await globalThis.GaplessSeekRange.read(url.href, start, end, source.size, rangeSignal);
        await this.validate(source, rangeSignal);
        if (signal.aborted || rangeSignal.aborted) throw new Error('cancelled');
        return bytes;
      };
      const sequential = new AbortController(), abort = () => sequential.abort();
      signal.addEventListener('abort', abort, { once: true });
      let offset = 0;
      const body = new ReadableStream({
        async pull(controller) {
          try {
            if (offset === source.size) { signal.removeEventListener('abort', abort); controller.close(); return; }
            const end = Math.min(source.size, offset + 65536);
            const bytes = await read(offset, end, sequential.signal); offset = end; controller.enqueue(bytes);
          } catch (error) { signal.removeEventListener('abort', abort); controller.error(error); }
        },
        cancel() { signal.removeEventListener('abort', abort); sequential.abort(); },
      }, { highWaterMark: 0 });
      return { kind: 'local-file', seekRange: read, response: new Response(body, {
        headers: { 'content-length': String(source.size) } }) };
    }
    clear() { this.mounts.clear(); }
  }
  globalThis.GaplessMacLocalSource = LocalSource;
})();
