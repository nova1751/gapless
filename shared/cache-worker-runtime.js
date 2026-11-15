/* MIT. Appended after the pinned CryptoJS core/MD5 modules inside a dedicated worker. */
(() => {
  const digest = CryptoJS.algo.MD5.create(); let total = 0, finished = false;
  self.onmessage = ({ data }) => {
    const { id, kind } = data;
    try {
      if (finished) throw new Error('cache-worker-finished');
      if (kind === 'chunk') {
        const bytes = new Uint8Array(data.bytes);
        if (bytes.byteLength > 64 * 1024) throw new Error('cache-worker-chunk-size');
        const words = new Array(Math.ceil(bytes.length / 4)).fill(0);
        for (let i = 0; i < bytes.length; i++) {
          bytes[i] ^= 0xa3; words[i >>> 2] |= bytes[i] << (24 - (i & 3) * 8);
        }
        total += bytes.length;
        digest.update(CryptoJS.lib.WordArray.create(words, bytes.length));
        self.postMessage({ id, bytes: bytes.buffer }, [bytes.buffer]);
      } else if (kind === 'finish') {
        finished = true;
        if (total !== data.total || total !== data.size || digest.finalize().toString(CryptoJS.enc.Hex) !== data.hash)
          throw new Error('cache-integrity');
        self.postMessage({ id, ok: true });
      } else throw new Error('cache-worker-command');
    } catch (error) { finished = true; self.postMessage({ id, error: error.message }); }
  };
})();
