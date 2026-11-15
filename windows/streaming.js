/* MIT. Incremental FLAC acquisition; the playback clock only sees decoded PCM. */
(() => {
  'use strict';
  const { AudioResources, header, fingerprint } = globalThis.GaplessAudioResources;
  class StreamingResources extends AudioResources {
    constructor(options) { super(options); this.streaming = true; }
    async decodeInput(job, source, input) {
      const flac = source.audioFormat === 'flac' || /\.flac$/i.test(source.localKey || source.path || '');
      if (!flac || !globalThis['flac-decoder']?.FLACDecoder) return super.decodeInput(job, source, input);
      clearTimeout(job.acquisitionTimer);
      let reader, decoder, entry, total = 0, published = false;
      const started = performance.now();
      try {
        if (!input.response.ok) throw new Error('stream-read');
        reader = input.response.body.getReader();
        decoder = new globalThis['flac-decoder'].FLACDecoder();
        await decoder.ready;
        let prefix = new Uint8Array(0), spec, workAt = performance.now();
        const append = result => {
          this.check(job);
          if (result.errors?.length) throw new Error('decode-stream-frame');
          if (!result.samplesDecoded) return;
          if (!entry || result.sampleRate !== spec.rate || result.bitDepth !== spec.bits
            || result.channelData.length !== spec.channels) throw new Error('decode-stream-spec');
          const end = entry.stream.decodedFrames + result.samplesDecoded;
          if (end > spec.frames) throw new Error('decode-stream-length');
          // libFLAC's wrapper divides both signs by the positive full scale.
          // Recover exact <=24-bit integers, then match Chromium's signed PCM
          // conversion (float32 reciprocal, asymmetric positive/negative scale).
          const max = 2 ** (spec.bits - 1) - 1;
          const positive = Math.fround(1 / max), negative = Math.fround(1 / (max + 1));
          for (let ch = 0; ch < spec.channels; ch++) {
            const pcm = result.channelData[ch];
            for (let i = 0; i < pcm.length; i++) {
              const integer = Math.round(pcm[i] * max);
              pcm[i] = integer * (integer < 0 ? negative : positive);
            }
            entry.buffer.copyToChannel(pcm, ch, entry.stream.decodedFrames);
          }
          entry.stream.decodedFrames = end;
          if (!published && end >= Math.min(spec.frames, Math.ceil(spec.rate * 0.75))) {
            published = true; job.publish?.(entry);
            this.trace('stream-ready', { id: job.ref.id, readyMs: Math.round(performance.now() - started),
              bufferedSeconds: end / spec.rate, origin: input.kind, sourceRate: spec.rate });
          }
        };
        while (true) {
          this.check(job);
          let stalled;
          let chunk;
          try { chunk = await Promise.race([reader.read(), new Promise((_, reject) => {
            stalled = setTimeout(() => reject(new Error('stream-read-stalled')), 10000);
          })]); } finally { clearTimeout(stalled); }
          if (chunk.done) break;
          for (let at = 0; at < chunk.value.length; at += 32768) {
            this.check(job);
            const part = chunk.value.subarray(at, at + 32768);
            const bytes = input.transform ? await input.transform(part) : part;
            total += bytes.length;
            if (total > this.fileLimit) throw new Error('native-only-file-size');
            if (!spec) {
              const next = new Uint8Array(prefix.length + bytes.length); next.set(prefix); next.set(bytes, prefix.length); prefix = next;
              if (prefix.length < 42) continue;
              spec = header(prefix);
              if (!spec || spec.codec !== 'flac' || ![8, 16, 24].includes(spec.bits)) throw new Error('decode-stream-header');
              const size = spec.frames * spec.channels * 4;
              this.reserve(job, size + 8 * 1024 * 1024);
              const buffer = new AudioBuffer({ length: spec.frames, numberOfChannels: spec.channels, sampleRate: spec.rate });
              const hash = fingerprint(source);
              entry = { id: job.ref.id, requestKey: this.requestKey(job.ref), key: `${this.requestKey(job.ref)}:${job.identity}:${spec.rate}`,
                identity: job.identity, source, hash, level: source.level, requestedLevel: job.ref.level,
                spec, buffer, size, duration: spec.duration, origin: input.kind, pins: 0,
                stream: { decodedFrames: 0, done: false, error: null } };
              this.entries.set(entry.key, entry);
              this.reserved -= size; job.reserve -= size;
              append(await decoder.decode(prefix)); prefix = null;
            } else append(await decoder.decode(bytes));
            // Bound main-thread decode/hash work; no security-policy changes for workers.
            if (performance.now() - workAt >= 4) {
              await new Promise(resolve => setTimeout(resolve, 0)); workAt = performance.now();
            }
          }
        }
        if (!entry) throw new Error('decode-stream-empty');
        append(await decoder.flush());
        this.check(job);
        const expectedSize = source.localKey ? Number(input.response.headers.get('content-length')) : Number(source.size);
        if (entry.stream.decodedFrames !== spec.frames || (this.exactSize && total !== expectedSize))
          throw new Error('decode-stream-length');
        await input.validate?.(total); this.check(job);
        entry.stream.done = true;
        this.failures.delete(entry.requestKey);
        this.trace('stream-complete', { id: job.ref.id, frames: spec.frames, sourceRate: spec.rate,
          elapsedMs: Math.round(performance.now() - started), origin: input.kind });
        return entry;
      } catch (error) {
        if (entry) {
          entry.stream.error = 'decode-stream-failed';
          // Once published, fallback must be coordinated by the player, never
          // silently splice a second source into this partially heard stream.
          if (!entry.pins) this.entries.delete(entry.key);
        }
        if (published) throw new Error('decode-stream-failed');
        throw error;
      } finally {
        decoder?.free(); input.dispose?.();
        try { await reader?.cancel(); } catch {}
        this.reserved -= job.reserve; job.reserve = 0;
      }
    }
  }

  class StreamingClock extends globalThis.GaplessPlaybackClock {
    start(track, at, offset = track.offset || 0) {
      const stream = track.entry?.stream;
      if (!stream || stream.done) return super.start(track, at, offset);
      if (stream.error || this.ctx?.state !== 'running' || !this.matches(track.entry)) throw new Error('native-only-stream');
      this.stop(track);
      at = Math.max(at, this.ctx.currentTime + 0.06);
      const entry = track.entry, rate = entry.spec.rate, generation = this.generation;
      const nodes = new Set(); let timer, stopped = false, cursor = Math.round(offset * rate);
      const first = cursor;
      const owner = { streaming: true, onended: null,
        stop: () => { stopped = true; clearInterval(timer); for (const n of nodes) { n.onended = null; try { n.stop(); } catch {} n.disconnect(); } nodes.clear(); },
        disconnect: () => {} };
      track.offset = offset; track.start = at; track.end = at + track.duration - offset;
      track.node = owner; track.playing = true; track.clockGeneration = generation;
      this.active.add(track); this.resources.pin(entry);
      owner.onended = () => {
        if (track.node !== owner || this.generation !== generation) return;
        track.heard = this.heard(track); track.offset = track.duration; track.playing = false;
        track.node = null; owner.stop(); this.active.delete(track); this.resources.unpin(entry); this.onEnded(track);
      };
      const pump = () => {
        if (stopped || track.node !== owner || this.generation !== generation) return;
        try {
          if (stream.error) throw new Error('stream-integrity');
          while (cursor < entry.buffer.length) {
            const when = at + (cursor - first) / rate;
            // Once verified PCM is complete, schedule the entire remaining
            // buffer now, even for a track minutes in the future. Do not leave
            // a last-second main-thread timer responsible for its continuation.
            if (!stream.done && when > this.ctx.currentTime + 2 && cursor !== first) break;
            const available = stream.decodedFrames - cursor;
            if (available <= 0) {
              if (when < this.ctx.currentTime + 0.03) throw new Error('stream-underrun');
              break;
            }
            if (when < this.ctx.currentTime - 0.005) throw new Error('stream-underrun');
            const count = stream.done ? entry.buffer.length - cursor : Math.min(available, rate);
            const node = this.ctx.createBufferSource(); node.connect(this.gain);
            const end = cursor + count;
            if (stream.done) node.buffer = entry.buffer;
            else {
              node.buffer = this.ctx.createBuffer(entry.spec.channels, count, rate);
              for (let ch = 0; ch < entry.spec.channels; ch++)
                node.buffer.copyToChannel(entry.buffer.getChannelData(ch).subarray(cursor, end), ch);
            }
            nodes.add(node);
            node.onended = () => { nodes.delete(node); node.disconnect(); if (end === entry.buffer.length) owner.onended?.(); };
            node.start(Math.max(when, this.ctx.currentTime), stream.done ? cursor / rate : 0);
            cursor = end;
            if (stream.done) this.trace('stream-fully-scheduled', { id: track.info?.songId || track.id,
              start: when, offsetFrames: end - count, frames: count,
              leadSeconds: when - this.ctx.currentTime });
          }
          if (cursor === entry.buffer.length) clearInterval(timer);
        } catch (error) {
          clearInterval(timer);
          this.trace('stream-output-fallback', { reason: error.message, position: this.position(track),
            decodedSeconds: stream.decodedFrames / rate, cursorSeconds: cursor / rate });
          // Player owns restoration and current intent; do not fake an End.
          this.onState('stream-failed');
        }
      };
      timer = setInterval(pump, 20); pump();
    }
    seek(track, offset) {
      if (track.node && track.playing && track.node?.streaming) {
        // Start ahead of the rendering head, preserving the exact requested offset.
        this.start(track, this.ctx.currentTime + 0.04, offset); return;
      }
      return super.seek(track, offset);
    }
  }
  globalThis.GaplessStreamingResources = StreamingResources;
  globalThis.GaplessStreamingClock = StreamingClock;
})();
