/* MIT. Bounded, per-file XOR/MD5 worker; no URLs, credentials or filesystem APIs. */
(() => {
  let unavailable = false;
  function create(hash, size, signal) {
    if (unavailable || typeof Worker !== 'function' || typeof globalThis.gaplessCacheWorkerSource !== 'string') return null;
    let worker, url;
    try {
      url = URL.createObjectURL(new Blob([globalThis.gaplessCacheWorkerSource], { type: 'text/javascript' }));
      worker = new Worker(url);
    } catch { unavailable = true; if (url) URL.revokeObjectURL(url); return null; }
    URL.revokeObjectURL(url);
    const pending = new Map(); let serial = 0, stopped = false;
    function dispose() {
      if (stopped) return;
      stopped = true; worker.terminate(); signal.removeEventListener('abort', dispose);
      for (const item of pending.values()) item.reject(new Error('cache-worker-cancelled'));
      pending.clear();
    }
    worker.onmessage = ({ data }) => {
      const item = pending.get(data.id); if (!item) return;
      pending.delete(data.id);
      if (data.error) item.reject(new Error(data.error)); else item.resolve(data.bytes ? new Uint8Array(data.bytes) : data);
    };
    worker.onerror = event => { event.preventDefault(); dispose(); };
    signal.addEventListener('abort', dispose, { once: true });
    const call = (kind, extra = {}, transfer = []) => new Promise((resolve, reject) => {
      if (stopped || signal.aborted) { reject(new Error('cache-worker-cancelled')); return; }
      const id = ++serial; pending.set(id, { resolve, reject });
      try { worker.postMessage({ id, kind, ...extra }, transfer); }
      catch (error) { pending.delete(id); reject(error); }
    });
    return {
      transform(part) {
        // Never detach the reader's buffer: it may contain subsequent slices.
        const bytes = part.slice().buffer;
        return call('chunk', { bytes }, [bytes]);
      },
      validate(total) { return call('finish', { hash, size, total }); },
      dispose,
    };
  }
  globalThis.GaplessCacheWorker = { create };
})();
