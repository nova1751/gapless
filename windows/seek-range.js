/* MIT. Indexed FLAC ranges; no clock access and no alternate audio source. */
(() => {
  const MiB = 1024 * 1024;
  function index(bytes, spec, size) {
    if (!Number.isSafeInteger(size) || size <= 0) return false;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const u64 = at => view.getUint32(at) * 4294967296 + view.getUint32(at + 4);
    let at = 4, points = [];
    while (at + 4 <= bytes.length) {
      const last = bytes[at] & 128, type = bytes[at] & 127;
      const length = (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3];
      const end = at + 4 + length;
      if (end > MiB) return false;
      if (end > bytes.length) return null;
      if (type === 3) {
        if (length % 18) return false;
        for (let p = at + 4; p < end; p += 18) {
          if (view.getUint32(p) === 0xffffffff && view.getUint32(p + 4) === 0xffffffff) continue;
          const sample = u64(p), offset = u64(p + 8);
          if (!Number.isSafeInteger(sample) || !Number.isSafeInteger(offset) || sample >= spec.frames
            || offset >= size || (points.length && (sample <= points[points.length - 1].sample || offset <= points[points.length - 1].offset))) return false;
          points.push({ sample, offset });
        }
      }
      at = end;
      if (last) {
        if (!points.length || points[0].sample !== 0 || points[0].offset !== 0) return false;
        points = points.map(p => ({ sample: p.sample, offset: p.offset + at }));
        if (points[points.length - 1].offset >= size) return false;
        points.push({ sample: spec.frames, offset: size });
        points.blockSize = view.getUint16(10);
        return points;
      }
    }
    return null;
  }
  async function read(url, start, end, size, signal, xor = false, partialFile = false) {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    if (signal.aborted) cancel();
    signal.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(cancel, 10000);
    try { return await readBytes(url, start, end, size, controller.signal, xor, partialFile); }
    finally { clearTimeout(timer); signal.removeEventListener('abort', cancel); }
  }
  async function readBytes(url, start, end, size, signal, xor, partialFile) {
    if (!Number.isSafeInteger(size) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end)
      || start < 0 || end <= start || end > size || end - start > 2 * MiB) throw new Error('seek-range-bounds');
    const response = await fetch(url, { headers: { Range: `bytes=${start}-${end - 1}` }, signal });
    const expected = `bytes ${start}-${end - 1}/${size}`;
    const contentRange = response.headers.get('content-range');
    const nativeRange = partialFile && /^bytes (\d+)-(\d+)\/(\d+)$/.exec(contentRange || '');
    const nativeFileValid = nativeRange && Number(nativeRange[1]) === start && Number(nativeRange[2]) === end - 1
      && Number.isSafeInteger(Number(nativeRange[3])) && Number(nativeRange[3]) >= end && Number(nativeRange[3]) <= size;
    if (response.status !== 206 || (contentRange !== expected && !nativeFileValid)) {
      await response.body?.cancel(); throw new Error('seek-range-unsupported');
    }
    const result = new Uint8Array(end - start), reader = response.body.getReader();
    let offset = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        if (offset + part.value.length > result.length) throw new Error('seek-range-length');
        result.set(part.value, offset); offset += part.value.length;
      }
      if (offset !== result.length) throw new Error('seek-range-length');
      if (xor) for (let i = 0; i < result.length; i++) result[i] ^= 0xa3;
      return result;
    } finally { await reader.cancel().catch(() => {}); }
  }
  function until(entry, sample) {
    if (entry.stream?.bounded) return entry.buffer.until(sample);
    if (!entry.stream || entry.stream.done) return entry.buffer.length;
    let end = sample <= entry.stream.decodedFrames ? entry.stream.decodedFrames : sample;
    for (const range of entry.stream.ranges || []) if (range[0] <= end && range[1] > sample) end = Math.max(end, range[1]);
    return end;
  }
  function merge(stream, start, end) {
    const ranges = [...(stream.ranges || []), [start, end]].sort((a, b) => a[0] - b[0]);
    stream.ranges = [];
    for (const range of ranges) {
      const previous = stream.ranges[stream.ranges.length - 1];
      if (previous && range[0] <= previous[1]) previous[1] = Math.max(previous[1], range[1]);
      else stream.ranges.push(range);
    }
  }
  async function prepare(resources, entry, target, signal, ahead = 8) {
    const points = entry.stream?.seekPoints, readRange = entry.stream?.readRange;
    if (!points || !readRange || entry.stream.done) return;
    const sample = Math.floor(target * entry.spec.rate);
    let n = points.findIndex((p, i) => i + 1 < points.length && p.sample <= sample && points[i + 1].sample > sample);
    if (n < 0 || resources.held() + resources.reserved + 8 * MiB > resources.limit) return;
    resources.reserved += 8 * MiB; resources.pin(entry);
    let decoder;
    const previous = entry.stream.decodeTail || Promise.resolve();
    let release;
    entry.stream.decodeTail = new Promise(resolve => { release = resolve; });
    const started = performance.now();
    const check = () => { if (signal.aborted || !resources.enabled || entry.stream.error) throw new Error('cancelled'); };
    try {
      await previous; check();
      decoder = new globalThis['flac-decoder'].FLACDecoder(); await decoder.ready;
      for (; n + 1 < points.length; n++) {
        check();
        if (entry.stream.done || points[n].sample >= (target + ahead) * entry.spec.rate) return;
        if (until(entry, points[n].sample) >= points[n + 1].sample) continue;
        const p = points[n], next = points[n + 1];
        // Bound one range's encoded bytes and temporary PCM before allocating.
        if (next.offset - p.offset > 2 * MiB || (next.sample - p.sample) * entry.spec.channels * 4 > 4 * MiB)
          throw new Error('seek-range-budget');
        const bytes = await readRange(p.offset, next.offset, signal); check();
        if (bytes[0] !== 255 || (bytes[1] & 254) !== 248) throw new Error('seek-frame-header');
        let value = bytes[4], cursor = 5;
        if (value >= 128) {
          let count = 0, mask = 128;
          while (value & mask) { count++; mask >>= 1; }
          if (count < 2 || count > 7) throw new Error('seek-frame-number');
          value &= mask - 1;
          for (let k = 1; k < count; k++) {
            const v = bytes[cursor++];
            if ((v & 192) !== 128) throw new Error('seek-frame-number');
            value = value * 64 + (v & 63);
          }
        }
        if ((bytes[1] & 1 ? value : value * points.blockSize) !== p.sample) throw new Error('seek-frame-position');
        const result = await decoder.decodeFile(bytes); check();
        if (result.errors?.length || result.samplesDecoded !== next.sample - p.sample
          || result.sampleRate !== entry.spec.rate || result.bitDepth !== entry.spec.bits
          || result.channelData.length !== entry.spec.channels) throw new Error('seek-range-decode');
        const max = 2 ** (entry.spec.bits - 1) - 1, positive = Math.fround(1 / max), negative = Math.fround(1 / (max + 1));
        for (let ch = 0; ch < entry.spec.channels; ch++) {
          const pcm = result.channelData[ch];
          for (let i = 0; i < pcm.length; i++) { const v = Math.round(pcm[i] * max); pcm[i] = v * (v < 0 ? negative : positive); }
          if (!entry.stream.bounded) entry.buffer.copyToChannel(pcm, ch, p.sample);
        }
        if (entry.stream.bounded) {
          entry.buffer.put(p.sample, result.channelData);
          entry.stream.decodedFrames = entry.buffer.until(0);
        } else merge(entry.stream, p.sample, next.sample);
        if (!entry.stream.bounded && entry.stream.indexed && entry.stream.ranges[0]?.[0] === 0) {
          entry.stream.decodedFrames = entry.stream.ranges[0][1];
          if (entry.stream.decodedFrames === entry.buffer.length) entry.stream.done = true;
        }
        await entry.stream.verifyAvailable?.(signal); check();
        resources.trace('seek-range-ready', { id: entry.id, target, origin: entry.stream.rangeOrigin || entry.origin,
          waitMs: Math.round(performance.now() - started), decodedSeconds: (next.sample - p.sample) / entry.spec.rate });
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    } finally { decoder?.free(); resources.unpin(entry); resources.reserved -= 8 * MiB; release(); }
  }
  globalThis.GaplessSeekRange = { index, read, until, prepare };
})();
