/* MIT. Publish the real music clock to macOS; native transport keeps its handlers. */
(() => {
  'use strict';
  class MacMediaSession {
    constructor({ snapshot, seek, trace }) {
      this.snapshot = snapshot; this.seek = seek; this.trace = trace; this.media = navigator.mediaSession;
      this.supported = !!(this.media?.setActionHandler && this.media.setPositionState && globalThis.MediaMetadata);
      this.active = false; this.failed = false; this.generation = 0; this.positionAt = -Infinity;
      this.actions = ['play', 'pause', 'previoustrack', 'nexttrack', 'seekto'];
    }
    acquire() {
      // Chromium needs a persistent media element for the system session. This
      // unmuted, all-zero carrier never receives music or changes its gain.
      const bytes = new ArrayBuffer(44 + 8000 * 2 * 8), view = new DataView(bytes);
      const text = (at, value) => [...value].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
      text(0, 'RIFF'); view.setUint32(4, bytes.byteLength - 8, true); text(8, 'WAVE');
      text(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
      view.setUint16(22, 1, true); view.setUint32(24, 8000, true); view.setUint32(28, 16000, true);
      view.setUint16(32, 2, true); view.setUint16(34, 16, true); text(36, 'data');
      view.setUint32(40, bytes.byteLength - 44, true);
      this.url = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
      this.audio = new Audio(this.url); this.audio.loop = true; this.active = true; this.generation++;
      this.key = ''; this.playing = null; this.revision = -1; this.positionAt = -Infinity;
      for (const action of this.actions) this.media.setActionHandler(action, detail => {
        // Native transport keeps play/pause/queue handling. System Seek needs
        // the actual music owner because the native streamer is parked.
        this.trace('system-media-action', { action });
        if (action === 'seekto') this.requestSeek(detail.seekTime);
      });
      this.trace('system-media-acquired');
    }
    requestSeek(target) {
      const s = this.snapshot();
      if (!this.active || !s?.owns || !Number.isFinite(target)) return;
      const value = Math.max(0, Math.min(s.duration - 0.001, target)), now = performance.now();
      // macOS can deliver the same drag twice. Native SDK Seek completion is
      // global, so merge duplicates and serialize requests before subscribing.
      if (this.lastSeek?.id === s.id && now - this.lastSeek.at < 80
        && Math.abs(this.lastSeek.value - value) < 0.02) return;
      this.lastSeek = { id: s.id, value, at: now };
      if (Math.abs(s.position - value) < 0.02) { this.sync(true); return; }
      this.pendingSeek = { id: s.id, value, generation: this.generation };
      void this.flushSeek();
    }
    async flushSeek() {
      if (this.seeking) return;
      this.seeking = true;
      try {
        while (this.pendingSeek) {
          const request = this.pendingSeek, s = this.snapshot(); this.pendingSeek = null;
          if (!this.active || !s?.owns || s.id !== request.id || request.generation !== this.generation) continue;
          await this.seek(request.id, request.value);
          this.trace('system-media-seek', { id: request.id, position: request.value });
          this.sync(true);
        }
      } catch (error) {
        this.pendingSeek = null; this.trace('system-media-seek-error', { reason: error.message });
        this.sync(true);
      } finally { this.seeking = false; }
    }
    sync(force = false) {
      if (!this.supported || this.failed) return;
      try {
        const s = this.snapshot();
        if (!s?.owns) { this.release(); return; }
        if (!this.active) { if (!s.playing) return; this.acquire(); }
        const m = s.metadata;
        if (m) {
          const key = JSON.stringify([s.id, m.songName, m.artistName, m.albumName, m.url]);
          if (key !== this.key) {
            this.key = key; this.positionAt = -Infinity;
            this.media.metadata = new MediaMetadata({ title: m.songName || '', artist: m.artistName || '',
              album: m.albumName || '', artwork: m.url ? [{ src: m.url }] : [] });
          }
        }
        if (this.playing !== s.playing) {
          this.playing = s.playing; this.positionAt = -Infinity;
          const playEpoch = this.playEpoch = (this.playEpoch || 0) + 1;
          this.media.playbackState = s.playing ? 'playing' : 'paused';
          if (s.playing) {
            const generation = this.generation;
            this.audio.play().catch(error => {
              if (this.active && generation === this.generation && playEpoch === this.playEpoch) this.fail(error);
            });
          } else this.audio.pause();
        }
        if (!this.pendingSeek && (force || s.revision !== this.revision || this.positionAt === -Infinity
          || (s.playing && performance.now() - this.positionAt >= 1000))) {
          this.media.setPositionState({ duration: s.duration, playbackRate: 1,
            position: Math.max(0, Math.min(s.duration, s.position)) });
          this.positionAt = performance.now(); this.revision = s.revision;
        }
      } catch (error) { this.fail(error); }
    }
    fail(error) {
      this.release(); this.failed = true;
      // A display failure must not stop gapless music or start the native backend.
      this.trace('system-media-unavailable', { reason: error.name || error.message });
    }
    retry() { if (this.failed) { this.failed = false; this.sync(); } }
    release() {
      if (!this.active && !this.audio && !this.url) return;
      this.active = false; this.generation++; this.pendingSeek = null; this.lastSeek = null;
      if (this.audio) {
        try { this.audio.pause(); this.audio.removeAttribute('src'); this.audio.load(); } catch { /* Element is being discarded. */ }
        this.audio = null;
      }
      if (this.url) URL.revokeObjectURL(this.url); this.url = null;
      for (const action of this.actions) try { this.media.setActionHandler(action, null); } catch { /* Partial acquire. */ }
      try { this.media.playbackState = 'none'; this.media.metadata = null; this.media.setPositionState(); }
      catch { /* The real native playback workflow republishes its own state. */ }
      this.trace('system-media-released');
    }
    status() { return { supported: this.supported, active: this.active, failed: this.failed,
      seekPending: !!this.pendingSeek || !!this.seeking }; }
  }
  globalThis.GaplessMacMediaSession = MacMediaSession;
})();
