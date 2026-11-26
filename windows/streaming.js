/* MIT. Incremental FLAC acquisition; the playback clock only sees decoded PCM. */
(() => {
  'use strict';
  const { AudioResources, header, fingerprint, normalizeFlacPCM } = globalThis.GaplessAudioResources;
  // Yield to the UI without the nested/background setTimeout minimum delay.
  // This is a main-thread task boundary, not a worker or CSP workaround.
  const yieldWork = (() => {
    const channel = new MessageChannel(), waiting = [];
    channel.port1.onmessage = () => waiting.shift()?.();
    return () => new Promise(resolve => { waiting.push(resolve); channel.port2.postMessage(0); });
  })();
  class StreamingResources extends AudioResources {
    constructor(options) {
      super(options); this.boundedIndexed = !!options.boundedIndexed; this.streaming = true; this.overlapStreaming = true;
      this.indexedReadAheadSeconds = options.indexedReadAheadSeconds;
      this.yieldIndexedWork = this.indexedReadAheadSeconds ? yieldWork : null;
      this.songCache = new globalThis.GaplessSongCache(() => this.limit - this.held() - this.reserved);
    }
    held() { return super.held() + (this.songCache?.bytes || 0); }
    lookup(ref, source) { const entry = super.lookup(ref, source); return entry?.discardOnUnpin ? null : entry; }
    unpin(entry) {
      super.unpin(entry);
      if (entry?.discardOnUnpin && !entry.pins && this.entries.get(entry.key) === entry) this.entries.delete(entry.key);
    }
    status() {
      const bounded = [...this.entries.values()].filter(entry => entry.stream?.bounded);
      return { ...super.status(), encodedCache: this.songCache.status(), boundedPCM: {
        entries: bounded.length, bytes: bounded.reduce((n, entry) => n + entry.buffer.bytes, 0),
        capacity: bounded.reduce((n, entry) => n + entry.buffer.limit, 0),
      }, lastRangeFailure: this.lastRangeFailure && { ...this.lastRangeFailure } };
    }
    clearCachedData(active) {
      for (const entry of this.entries.values()) entry.stream?.ensureController?.abort();
      this.songCache.clear(); this.failures.clear();
      for (const [key, entry] of this.entries) if (entry !== active) {
        entry.discardOnUnpin = true;
        if (!entry.pins) this.entries.delete(key);
      }
      // An active decode buffer is working state, not reusable cache. Continue
      // from the same authorized source if native disk files have been removed.
      if (active?.stream?.indexed && active.origin !== 'native-source' && !active.source.localKey && active.source.url) {
        const source = active.source, key = active.stream.cacheKey;
        active.stream.verifyAvailable = null;
        active.stream.rangeOrigin = 'network';
        active.stream.readRange = (start, end, signal) => this.songCache.read(key, start, end,
          (a, b, s) => globalThis.GaplessSeekRange.read(source.url, a, b, Number(source.size), s), signal);
      }
    }
    retain(refs) {
      const keep = new Set(refs.filter(Boolean).map(r => this.requestKey(r)));
      for (const entry of this.entries.values()) if (!keep.has(entry.requestKey)) entry.stream?.ensureController?.abort();
      super.retain(refs);
      if (!keep.size) this.songCache.clear();
    }
    ensure(entry, target, maxAhead = null) {
      const state = entry.stream;
      if (!state.indexed || state.done || state.error) return;
      const readAhead = this.indexedReadAheadSeconds;
      // An explicit seek owns range preparation until it finishes.
      if (state.priorityTarget != null && (readAhead || Math.abs(state.priorityTarget - target) > 1)) return;
      const { rate, channels } = entry.spec;
      let ahead = readAhead || 8;
      if (maxAhead != null) ahead = Math.min(ahead, maxAhead);
      if (readAhead && state.bounded && entry.buffer.limit < entry.buffer.length * channels * 4) {
        // Leave half the PCM budget for the current block and the end of a seek interval.
        ahead = Math.min(ahead, entry.buffer.limit / (rate * channels * 8));
      }
      const lowWater = maxAhead != null ? Math.min(ahead * 0.75, ahead) : (readAhead ? ahead * 5 / 8 : 4);
      const sample = Math.floor(target * rate);
      const bufferedEnd = globalThis.GaplessSeekRange.until(entry, sample);
      if (bufferedEnd >= Math.min(entry.buffer.length, sample + lowWater * rate)) return;
      // Advancing playback cannot invalidate its own refill. Explicit controls
      // still abort the controller and a native read retains its own deadline.
      if (state.ensureController && !state.ensureController.signal.aborted
        && (readAhead || Math.abs((state.ensureTarget || 0) - target) < 4)) return;
      state.ensureController?.abort();
      const controller = state.ensureController = new AbortController(); state.ensureTarget = target;
      if (readAhead) this.trace('indexed-refill-start', { id: entry.id, target, bufferedUntilSeconds: bufferedEnd / rate });
      void globalThis.GaplessSeekRange.prepare(this, entry, target, controller.signal, ahead)
        .catch(error => {
          if (controller.signal.aborted || error.message === 'cancelled') return;
          state.error = /^[a-z0-9-]+$/.test(error.message) ? error.message : 'indexed-read-failed';
          this.lastRangeFailure = { at: Math.round(performance.now()), id: entry.id, target, reason: state.error };
          this.trace('indexed-read-failed', this.lastRangeFailure);
          state.notifyProgress?.();
        })
        .finally(() => { if (state.ensureController === controller) state.ensureController = null; });
    }
    async decodeInput(job, source, input) {
      const flac = source.audioFormat === 'flac' || /\.flac$/i.test(source.localKey || source.path || '');
      if (!flac || !globalThis['flac-decoder']?.FLACDecoder) return super.decodeInput(job, source, input);
      clearTimeout(job.acquisitionTimer);
      let reader, decoder, entry, total = 0, published = false;
      const started = performance.now();
      try {
        if (!input.response.ok) throw new Error('stream-read');
        if (input.partial && input.response.headers.get('content-range') !== `bytes 0-${Math.min(Number(source.size), 32768) - 1}/${source.size}`) {
          await input.response.body?.cancel(); throw new Error('range-header-unavailable');
        }
        reader = input.response.body.getReader();
        let prefix = new Uint8Array(0), spec, workAt = performance.now();
        const append = result => {
          this.check(job);
          if ((result.errors || result.U)?.length) throw new Error('decode-stream-frame');
          if (!result.samplesDecoded) return;
          if (!entry || result.sampleRate !== spec.rate || result.bitDepth !== spec.bits
            || result.channelData.length !== spec.channels) throw new Error('decode-stream-spec');
          const end = entry.stream.decodedFrames + result.samplesDecoded;
          if (end > spec.frames) throw new Error('decode-stream-length');
          normalizeFlacPCM(result.channelData, spec.bits);
          for (let ch = 0; ch < spec.channels; ch++) {
            const pcm = result.channelData[ch];
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
              const seekPoints = globalThis.GaplessSeekRange.index(prefix, spec,
                Number(source.localKey ? input.response.headers.get('content-length') : source.size));
              const bounded = (this.boundedIndexed || input.kind === 'native-source' || (input.kind === 'local-file' && source.localKey))
                && seekPoints && (input.seekRange || input.kind === 'network');
              // Indexed native and versioned local inputs share bounded PCM.
              // Reserve capacity plus immutable scheduled output copies.
              const size = bounded ? Math.min(spec.frames * spec.channels * 4, 32 * 1024 * 1024) + 8 * 1024 * 1024
                : spec.frames * spec.channels * 4;
              this.reserve(job, size + 8 * 1024 * 1024);
              const buffer = bounded ? new globalThis.GaplessPCMCache(spec)
                : new AudioBuffer({ length: spec.frames, numberOfChannels: spec.channels, sampleRate: spec.rate });
              const hash = fingerprint(source);
              const identity = source.localKey ? globalThis.GaplessAudioResources.localIdentity(source) : job.identity;
              const progressWaiters = new Set();
              entry = { id: job.ref.id, requestKey: this.requestKey(job.ref), key: `${this.requestKey(job.ref)}:${identity}:${spec.rate}`,
                identity,
                source, hash, level: source.level, requestedLevel: job.ref.level,
                spec, buffer, size, duration: spec.duration, origin: input.kind, acquisition: input.acquisition, pins: 0,
                stream: { decodedFrames: 0, done: false, error: null, bounded: !!bounded,
                  hasDiskCoverage: input.hasDiskCoverage || null,
                  notifyProgress: () => { for (const wake of progressWaiters) wake(); progressWaiters.clear(); },
                  waitProgress: (ms = 30) => new Promise(resolve => {
                    const done = () => { clearTimeout(timer); progressWaiters.delete(done); resolve(); };
                    const timer = setTimeout(done, ms);
                    progressWaiters.add(done);
                  }) } };
              entry.stream.seekPoints = seekPoints;
              entry.stream.readRange = input.seekRange || (input.kind === 'network'
                ? (start, end, signal) => globalThis.GaplessSeekRange.read(source.url, start, end, Number(source.size), signal) : null);
              this.entries.set(entry.key, entry);
              this.reserved -= size; job.reserve -= size;
              input.setIndex?.(entry.stream.seekPoints, spec);
              const cacheKey = entry.requestKey + ':' + (entry.identity || hash || source.localKey || source.url);
              entry.stream.cacheKey = cacheKey;
              const rawRead = entry.stream.readRange;
              if (input.verifyParts) entry.stream.verifyAvailable = async signal => {
                if (entry.stream.integrityVerified) return;
                const parts = this.songCache.complete(cacheKey, Number(source.size));
                if (!parts) return;
                try { await input.verifyParts(parts, signal); }
                catch (error) {
                  if (!signal.aborted && error.message !== 'cancelled') entry.stream.error = 'cache-integrity';
                  throw error;
                }
                finally { parts.release(); }
                entry.stream.integrityVerified = true;
                this.trace('indexed-integrity-verified', { id: entry.id });
              };
              this.songCache.put(cacheKey, 0, prefix);
              if (rawRead) entry.stream.readRange = (start, end, signal) => this.songCache.read(cacheKey, start, end, rawRead, signal);
              if (entry.stream.seekPoints && rawRead) {
                try {
                  await globalThis.GaplessSeekRange.prepare(this, entry, 0, job.controller.signal, 1);
                  this.check(job);
                  if (globalThis.GaplessSeekRange.until(entry, 0) < Math.min(spec.frames, spec.rate * 0.75)) throw new Error('indexed-not-ready');
                  entry.stream.indexed = true;
                  await reader.cancel();
                  this.trace('indexed-ready', { id: entry.id, origin: entry.origin, readyMs: Math.round(performance.now() - started) });
                  published = true; job.publish?.(entry); return entry;
                } catch (error) {
                  this.check(job);
                  this.trace('indexed-unavailable', { id: entry.id });
                  if (entry.stream.bounded) throw new Error('decode-indexed-unavailable');
                  if (input.partial) throw new Error('range-header-unavailable');
                }
              }
              if (input.partial) throw new Error('range-header-unavailable');
              decoder = new globalThis['flac-decoder'].FLACDecoder();
              await decoder.ready;
              this.check(job);
              append(await decoder.decode(prefix)); prefix = null;
            } else append(await decoder.decode(bytes));
            // Bound main-thread decode/hash work; no security-policy changes for workers.
            if (performance.now() - workAt >= 4) {
              await yieldWork(); workAt = performance.now();
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
        entry.stream.notifyProgress?.();
        this.failures.delete(entry.requestKey);
        this.trace('stream-complete', { id: job.ref.id, frames: spec.frames, sourceRate: spec.rate,
          elapsedMs: Math.round(performance.now() - started), origin: input.kind });
        return entry;
      } catch (error) {
        if (entry) {
          entry.stream.error = 'decode-stream-failed';
          entry.stream.notifyProgress?.();
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
    constructor(options) {
      super(options);
      this.scheduleAheadSeconds = options.scheduleAheadSeconds ?? 2;
    }
    async open(entry) {
      const stamp = this.ctx?.getOutputTimestamp?.();
      if (this.readyContext === this.ctx && this.ctx?.state === 'running' && this.matches(entry)
        && stamp?.contextTime > 0 && performance.now() - stamp.performanceTime < 500) {
        this.openSerial++;
        this.trace('output-reused', { sourceRate: entry.spec.rate }); return this.ctx;
      }
      const ctx = await super.open(entry); this.readyContext = ctx; return ctx;
    }
    start(track, at, offset = track.offset || 0, replace = false) {
      const stream = track.entry?.stream;
      if (!stream || stream.done) return super.start(track, at, offset);
      if (stream.error || this.ctx?.state !== 'running' || !this.matches(track.entry)) throw new Error('native-only-stream');
      at = Math.max(at, this.ctx.currentTime + 0.02);
      const previous = replace && track.playing ? track.node : null;
      const heard = previous ? this.heard(track) + Math.max(0, at - this.ctx.currentTime) : 0;
      if (previous) { track.node = null; this.active.delete(track); }
      else this.stop(track);
      const entry = track.entry, rate = entry.spec.rate, generation = this.generation;
      // Cap scheduled PCM runway to stay inside the reserved 8 MiB output budget
      // across both 44.1/48 kHz and 96/192 kHz Hi-Res tracks.
      const aheadSeconds = Math.min(this.scheduleAheadSeconds,
        Math.max(4, Math.floor((6 * 1024 * 1024) / (rate * entry.spec.channels * 4))));
      const nodes = new Set(); let timer, stopped = false, cursor = Math.round(offset * rate);
      const first = cursor;
      let prebufferedFuture = false;
      const owner = { streaming: true, onended: null,
        stop: when => {
          stopped = true; clearInterval(timer);
          if (Number.isFinite(when) && when > this.ctx.currentTime) {
            for (const n of nodes) {
              n.onended = () => { nodes.delete(n); n.disconnect(); if (!nodes.size) owner.onended?.(); };
              try { n.stop(when); } catch { nodes.delete(n); n.disconnect(); }
            }
            if (!nodes.size) owner.onended?.();
          } else {
            for (const n of nodes) { n.onended = null; try { n.stop(); } catch {} n.disconnect(); }
            nodes.clear();
          }
        },
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
          const farFuture = !stream.done && at > this.ctx.currentTime + aheadSeconds + 4 && cursor !== first;
          if (!farFuture || !prebufferedFuture) {
            this.resources.ensure?.(entry, offset + Math.max(0, this.ctx.currentTime - at), farFuture ? 4 : null);
            if (farFuture && globalThis.GaplessSeekRange.until(entry, first) >= Math.min(entry.buffer.length, first + 3 * rate))
              prebufferedFuture = true;
          }
          if (farFuture) return;
          while (cursor < entry.buffer.length) {
            const when = at + (cursor - first) / rate;
            // Once verified PCM is complete, schedule the entire remaining
            // buffer now, even for a track minutes in the future. Do not leave
            // a last-second main-thread timer responsible for its continuation.
            if (!stream.done && when > this.ctx.currentTime + aheadSeconds && cursor !== first) break;
            const available = globalThis.GaplessSeekRange.until(entry, cursor) - cursor;
            if (available <= 0) {
              if (when < this.ctx.currentTime + 0.03) throw new Error('stream-underrun');
              break;
            }
            if (when < this.ctx.currentTime - 0.005) throw new Error('stream-underrun');
            const count = stream.done ? entry.buffer.length - cursor : Math.min(available, rate * 2);
            const node = this.ctx.createBufferSource(); node.connect(this.gain);
            const end = cursor + count;
            if (stream.done) node.buffer = entry.buffer;
            else {
              node.buffer = this.ctx.createBuffer(entry.spec.channels, count, rate);
              for (let ch = 0; ch < entry.spec.channels; ch++)
                entry.buffer.copyFromChannel(node.buffer.getChannelData(ch), ch, cursor);
            }
            nodes.add(node);
            node.onended = () => {
              nodes.delete(node); node.disconnect();
              if (end === entry.buffer.length) owner.onended?.();
              else if (!stopped) pump();
            };
            node.start(Math.max(when, this.ctx.currentTime), stream.done ? cursor / rate : 0);
            cursor = end;
            if (stream.done) this.trace('stream-fully-scheduled', { id: track.info?.songId || track.id,
              start: when, offsetFrames: end - count, frames: count,
              leadSeconds: when - this.ctx.currentTime });
          }
          if (cursor === entry.buffer.length) clearInterval(timer);
        } catch (error) {
          clearInterval(timer);
          this.trace('stream-output-fallback', { id: track.id, reason: error.message, sourceError: stream.error,
            position: this.position(track),
            decodedSeconds: stream.decodedFrames / rate, cursorSeconds: cursor / rate,
            bufferedUntilSeconds: globalThis.GaplessSeekRange.until(entry, cursor) / rate,
            refillTargetSeconds: stream.ensureController ? stream.ensureTarget : undefined,
            leadSeconds: at + (cursor - first) / rate - this.ctx.currentTime });
          // Player owns restoration and current intent; do not fake an End.
          this.onState('stream-failed', track);
        }
      };
      timer = setInterval(pump, 20); pump();
      if (previous) {
        const retired = { track, finish: () => {
          if (!this.retiring.delete(previous)) return;
          previous.onended = null; previous.disconnect(); this.resources.unpin(entry);
        } };
        this.retiring.set(previous, retired); previous.onended = retired.finish;
        previous.stop(at);
        track.heard = heard; track.heardUntil = at;
        this.trace('seek-replaced', { id: track.id, switchLeadMs: (at - this.ctx.currentTime) * 1000 });
      }
    }
    seek(track, offset) {
      if (track.node && track.playing && track.entry?.stream && !track.entry.stream.done) {
        // Stop the old nodes at the exact scheduled start of the replacement.
        this.start(track, this.ctx.currentTime + 0.02, offset, true); return;
      }
      return super.seek(track, offset);
    }
  }
  globalThis.GaplessStreamingResources = StreamingResources;
  globalThis.GaplessStreamingClock = StreamingClock;
})();
