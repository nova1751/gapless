/* MIT. Mac adapter for the shared clock and bounded resource pipeline.
 * NetEase supplies quality, authorization, queue and UI. No CSS, EQ or silence trimming.
 */
plugin.onLoad(() => {
  'use strict';
  const bridge = window.__gpMacBridge, Resources = globalThis.GaplessAudioResources;
  if (!bridge?.hooked || !Resources || !globalThis.GaplessPlaybackClock || window.gaplessMac) return;
  const QUALITY = { 128: 'standard', 192: 'higher', 320: 'exhigh', 999: 'lossless', 1999: 'hires' };
  const ALIGN_TOLERANCE = 0.025;
  const log = [], seekReplies = [], recoveryKey = 'gapless-mac-reload-v2', gateRecoveryKey = 'gapless-mac-native-output-v1';
  const S = { enabled: true, compatible: false, current: null, scheduled: null, claim: false,
    store: null, phase: 'native', epoch: 0, revision: 0, serial: 0, queueVersion: 0,
    account: '', signature: '', selection: '', token: '', nativePosition: 0, nativeAt: performance.now(), nativePlaying: false,
    gestureAt: -Infinity, recovering: null, unsubscribe: null, starting: false, recoveryConsumed: false,
    nativeGate: null, volumeLatencyMs: 2 };
  const trace = (event, detail = {}) => {
    log.push({ at: Math.round(performance.now()), event, ...detail }); if (log.length > 180) log.shift();
  };
  const state = () => S.store?.getState();
  function findStore() {
    const root = document.getElementById('root')?._reactRootContainer?._internalRoot?.current;
    const queue = root ? [root] : [];
    for (let i = 0; i < queue.length && i < 5000; i++) {
      const f = queue[i]; if (f.memoizedProps?.store?.getState) return f.memoizedProps.store;
      if (f.child) queue.push(f.child); if (f.sibling) queue.push(f.sibling);
    }
    return null;
  }
  function webpackRequire() {
    if (S.require) return S.require;
    if (!window.webpackJsonp?.push) throw new Error('native-api-unavailable');
    let require; const key = `gapless-mac-${Date.now()}`;
    window.webpackJsonp.push([[key], { [key]: (m, e, r) => { require = r; } }, [[key]]]);
    if (!require?.c || !require?.m) throw new Error('native-api-unavailable');
    return S.require = require;
  }
  function nativeSourceResolver() {
    if (S.resolveNativeSource) return S.resolveNativeSource;
    // Verified 3.1.12 source selector: reuses the client's rights, cache,
    // download preference and quality policy without loading its audio backend.
    const resolver = webpackRequire().c[100]?.exports?.f;
    const code = typeof resolver === 'function' ? String(resolver) : '';
    if (!code.includes('requestSoundQuality') || !code.includes('getTrackFromCacheFast')
      || !code.includes('isNextTrack')) throw new Error('native-source-selector-unavailable');
    return S.resolveNativeSource = resolver;
  }
  function nativePlayer() {
    if (S.nativePlayer) return S.nativePlayer;
    for (const module of Object.values(webpackRequire().c)) {
      const player = module.exports?.AudioPlayer;
      if (player?.subscribePlayStatus && player?.seek && player?.pause) return S.nativePlayer = player;
    }
    throw new Error('native-player-unavailable');
  }
  function nativeRandomNext(list, current) {
    // Use the client's existing shuffled order. Never create a second random
    // queue, which could make the audible next track differ from the UI.
    const resolver = webpackRequire().c[161]?.exports?.a;
    const code = typeof resolver === 'function' ? String(resolver) : '';
    if (!code.includes('PlayRandom') || !code.includes('randomOrder') || !code.includes('displayOrder')) return null;
    if (list.some(row => !Number.isFinite(row.randomOrder))
      || new Set(list.map(row => Number(row.randomOrder))).size !== list.length) return null;
    const selected = resolver('playRandom', list, current, 1);
    return list.includes(selected) ? selected : null;
  }
  function capabilityCheck() {
    try {
      if (window.APP_CONF?.appver !== '3.1.12' || !state()?.playing || !state()?.playingList || !state()?.['page:vinylPage']) return false;
      if (!['onSeek', 'onPlayState', 'onPlayProgress', 'onEnd'].every(n => bridge.registrations[`audioplayer.${n}`])) return false;
      nativePlayer(); nativeSourceResolver(); return true;
    } catch (error) { trace('capability-fallback', { reason: error.message }); return false; }
  }
  const quality = info => info?.soundQuality || QUALITY[state()?.playing?.resourcePlayingQuality] || info?.level;
  const allowed = info => {
    const s = state();
    return !!(S.enabled && S.compatible && s && (!info || (!info.freeTrialInfo && info.audioType === 'track'))
      && !s.playing?.isPlayingVideo && !s.playing?.resourceIsTryType
      && Number(s.playing?.playingSpeed || 1) === 1 && !s.audioEffect?.setting?.isOn
      && !s.assignedAudioEffect?.isOn && !s.playing?.audioEffect?.isOpen
      && !s.setting?.loudnessBalance && !s.setting?.systemSpatialSound);
  };
  const rowId = row => String(row.resourceId || row.trackId || row.id);
  const rows = () => state()?.playingList?.curPlayingList || [];
  const ref = c => c && ({ id: c.id, level: c.requestedLevel, account: c.account, duration: c.duration });
  const nativePosition = () => Math.max(0, S.nativePosition + (S.nativePlaying ? (performance.now() - S.nativeAt) / 1000 : 0));
  const nativeCache = globalThis.GaplessNativeCache && new globalThis.GaplessNativeCache({ trace,
    storage: () => webpackRequire()(4).Storage, settings: () => state()?.setting,
    crypto: () => {
      const r = webpackRequire();
      return [139,257,671].map(id => r.c[id]?.exports).find(x => x?.algo?.MD5?.create);
    } });
  const resources = new Resources.AudioResources({ trace,
    readCache: nativeCache && ((r, source, signal) => nativeCache.read(r, source, signal)), resolve: async (r, signal) => {
    if (!Object.values(QUALITY).includes(r.level)) throw new Error('native-only-quality');
    if (!r.row || rowId(r.row) !== r.id) throw new Error('native-only-source-selection');
    const result = await nativeSourceResolver()({ track: r.row, requestSoundQuality: r.level, isNextTrack: true });
    if (signal.aborted) throw new Error('cancelled');
    const info = result?.playInfo;
    if (!result?.canPlay || !info?.musicurl || info.freeTrialInfo) throw new Error('native-only-rights');
    return { ...info, url: info.musicurl, size: Number(info.fileSize),
      duration: Number(info.songDuration) / 1000, code: 200 };
  }, acceptRate: (r, rate) => {
    const c = S.current;
    return !!c && r.account === S.account && (rate >= 8000 && rate <= 192000);
  } });
  const clock = new globalThis.GaplessPlaybackClock({ resources, trace,
    onState: value => { if (S.current?.owns && S.current.entry && !S.current.loading && value !== 'running') void restoreNative(`context-${value}`); },
    onEnded: c => { if (S.current === c && c.owns) boundary(c); } });
  const position = () => S.current?.owns ? clock.position(S.current) : nativePosition();
  const media = globalThis.GaplessMacMediaSession && new globalThis.GaplessMacMediaSession({ trace,
    seek: (id, value) => {
      reconcile(); const c = S.current;
      if (!c?.owns || c.id !== id) return;
      seekOwned(c, value, `${id}|seek|system-${S.revision + 1}`);
      progress(c, true);
    },
    transport: (id, action) => {
      reconcile(); const c = S.current;
      if (!c || c.id !== id || S.phase === 'restoring') return;
      if (action === 'nexttrack' || action === 'previoustrack') {
        // Reuse NetEase's queue policy, including manual previous/next in
        // single-track repeat. Do not address the parked native track.
        S.store.dispatch({ type: 'playingList/jump2Track', payload: {
          flag: action === 'nexttrack' ? 1 : -1, type: 'call', triggerScene: 'miniPlayer', assignedResourceId: c.id } });
      } else if ((action === 'play') !== (c.owns ? !!c.playing : S.nativePlaying)) {
        if (c.owns) {
          const command = action === 'play' ? 'audioplayer.play' : 'audioplayer.pause';
          bridge.handle({ command, params: [c.id, `${c.id}|system-${action}|${S.revision + 1}`] });
        } else S.store.dispatch({ type: `playing/${action === 'play' ? 'resume' : 'pause'}`, payload: { triggerScene: 'miniPlayer' } });
      }
      trace('system-media-control', { id, action });
    },
    snapshot: () => {
    const c = S.current;
    const preparing = ['warming', 'pausing'].includes(S.phase) && c?.takeoverPlaying && S.nativePlaying;
    // Once acquired, retain the system session across native fallback and
    // disabling gapless. Chromium teardown disables shared macOS commands;
    // the carrier now mirrors native playback without carrying music.
    if (!c || (!S.enabled && !media?.active)) return { owns: false };
    if (!c.mediaMetadata) {
      const row = c.row || rows().find(r => rowId(r) === c.id);
      if (row) c.mediaMetadata = webpackRequire()(22).e(row);
    }
    return { owns: true, controlsReady: S.phase !== 'pausing' && S.phase !== 'restoring',
      canAcquire: S.enabled && ((c.owns && S.phase !== 'restoring') || preparing),
      id: c.id, playing: S.phase === 'restoring' ? !!c.recoveryPlaying : S.phase === 'pausing' ? !!c.takeoverPlaying
        : c.owns ? !!(c.playing || (c.loading || c.transitioning) && c.loadIntent) : S.nativePlaying, duration: c.duration,
      position: c.owns ? clock.position(c) : nativePosition(), revision: S.revision, metadata: c.mediaMetadata };
  } });
  // Native visual effects consume stereo s16le at 48 kHz with millisecond
  // timestamps. This copy is for their existing renderer, never the music graph.
  const hexByte = Array.from({ length: 256 }, (_, value) => value.toString(16).padStart(2, '0'));
  const visual = new globalThis.GaplessVisualPCM({ rate: 48000, channels: 2, trace,
    snapshot: () => {
      const c = S.current;
      const active = S.enabled && c?.owns && !c.loading && !S.claim && S.phase === 'owned'
        && bridge.audioDataEnabled && !!bridge.registrations['audioplayer.onAudioData'] && !document.hidden;
      return { active, playing: !!c?.playing, id: c?.id, serial: c?.serial,
        revision: S.revision, generation: clock.generation, buffer: active ? c.entry?.buffer : null,
        position: active && c.playing ? clock.outputPosition(c) : 0 };
    }, emit: (bytes, pts) => {
      const encoded = new Array(bytes.length);
      for (let i = 0; i < bytes.length; i++) encoded[i] = hexByte[bytes[i]];
      bridge.emit('audioplayer.onAudioData', [{ data: encoded.join(''), pts }]);
    } });
  function nextTrack() {
    const c = S.current, s = state(); if (!c || !allowed(c.info)) return null;
    const mode = s.playing.playingMode;
    if (!['playOrder', 'playCycle', 'playOneCycle', 'playRandom'].includes(mode)) return null;
    const list = [...rows()].sort((a, b) => Number(a.displayOrder) - Number(b.displayOrder));
    // Duplicate track IDs cannot be tied to an occurrence by this version's native Load protocol.
    const matches = list.filter(row => rowId(row) === c.id);
    if (matches.length !== 1) return null;
    const index = list.indexOf(matches[0]);
    const row = mode === 'playRandom' ? nativeRandomNext(list, matches[0])
      : mode === 'playOneCycle' ? matches[0] : list[index + 1] || (mode === 'playCycle' ? list[0] : null);
    if (!row || row.resourceType !== 'track' || list.filter(item => rowId(item) === rowId(row)).length !== 1) return null;
    const id = rowId(row), duration = Number(row.track?.duration || row.duration) / 1000;
    return { id, level: c.requestedLevel, account: S.account, duration, row, queueVersion: S.queueVersion,
      occurrence: `${row.id}:${row.displayOrder}`, key: `${S.account}:${id}:${c.requestedLevel}:${row.id}:${row.displayOrder}:${row.randomOrder}` };
  }
  function cancelScheduled() { clock.stop(S.scheduled); S.scheduled = null; }
  function stopCurrent() { cancelScheduled(); clock.stop(S.current); }
  function emitState(c, value, token = S.token || c.id) {
    if (value === 2) nativePlayer().isCallPaused = true;
    bridge.emit('audioplayer.onPlayState', [c.id, token, value]);
    media?.sync(true);
  }
  function progress(c, force = false) {
    if (S.current !== c || !c.owns || S.claim || (!c.playing && !force)) return;
    bridge.emit('audioplayer.onPlayProgress', [c.id, clock.position(c).toFixed(3), '1.0000', force]);
    media?.sync(force);
  }
  function boundary(c) {
    if (S.current !== c || !c.owns || c.endSent) return;
    const candidate = S.scheduled;
    c.endSent = true;
    if (candidate && candidate.clockGeneration === clock.generation && candidate.queueVersion === S.queueVersion) {
      clock.stop(c); S.scheduled = null; S.current = candidate; S.claim = true;
      S.phase = 'claiming'; candidate.claimAt = performance.now();
      trace('transition', { from: c.id, to: candidate.id, scheduledGapFrames: Math.round((candidate.start - c.end) * clock.ctx.sampleRate) });
    } else {
      cancelScheduled(); c.playing = false; c.loadIntent = true;
      c.transitioning = !!nextTrack() || state()?.playing?.playingMode === 'playRandom'; S.phase = 'owned';
    }
    media?.sync(true);
    bridge.emit('audioplayer.onEnd', [c.id, { code: 0, errorCode: 0, errorString: '', playedTime: clock.heard(c) }]);
  }
  function reconcile() {
    const c = S.current;
    if (c?.owns && c.playing && c.end && clock.ctx?.currentTime >= c.end) boundary(c);
  }
  function updateEnvironment() {
    reconcile();
    const s = state(); if (!s) return;
    if (!S.compatible && s['page:vinylPage']) {
      S.compatible = capabilityCheck();
      if (S.compatible) { trace('capabilities', { compatible: true }); queueMicrotask(consumeRecovery); }
    }
    const account = String(s.host?.uid || s.user?.profile?.userId || 'anonymous');
    const signature = JSON.stringify([s.playing?.playingMode, rows().map(r => [r.id, rowId(r), r.displayOrder, r.randomOrder])]);
    if (signature !== S.signature) {
      S.signature = signature; S.queueVersion++; cancelScheduled(); trace('queue-changed', { queueVersion: S.queueVersion });
      if (S.claim) void restoreNative('queue-during-claim');
    }
    if (S.account && account !== S.account) { S.epoch++; resources.resetFailures(); void restoreNative('account-changed'); }
    S.account = account;
    const c = S.current;
    if (c && !c.owns && !c.entry && !c.preparing && !c.blocked && allowed(c.info)) {
      c.account = account; void prepareCurrent(c);
    }
    const selection = JSON.stringify(s.setting?.quantity || null);
    const selectionChanged = S.selection && selection !== S.selection;
    S.selection = selection;
    if (c?.owns && (selectionChanged || !allowed(c.info) || c.account !== account)) {
      if (selectionChanged) {
        c.restoreSelection = true; c.row ||= rows().find(r => rowId(r) === c.id); resources.resetFailures();
      }
      void restoreNative('native-settings');
    }
    refreshLyrics(c);
  }
  function refreshLyrics(c) {
    if (!c?.needsLyrics || S.current !== c || S.claim || String(state()?.playing?.resourceTrackId) !== c.id) return;
    const s = state();
    if (String(s.playing?.onlineResourceId) !== c.id || !s.playing?.curPlaying || !s.playing?.resourceDuration) return;
    c.needsLyrics = false;
    if (!(s['page:vinylPage']?.pageState === 'opened' || s.setting?.showLyric || s.app?.isMiniMode)) return;
    // Lyrics never drive playback progress; the audio clock is the sole source.
    Promise.resolve(S.store.dispatch({ type: 'async:lyric/fetchLyric', payload: { force: true } }))
      .catch(error => trace('native-lyric-error', { reason: error.message }));
  }
  function answerLoad(msg, c) {
    const epoch = S.epoch;
    queueMicrotask(() => {
      if (S.current !== c || S.epoch !== epoch) { bridge.dispatch(msg.seq, [c.id, { code: -1 }]); return; }
      const args = [c.id, { code: 0, duration: c.duration }];
      bridge.dispatch(msg.seq, args); bridge.emit('audioplayer.onLoad', args);
      c.needsLyrics = true; refreshLyrics(c);
    });
  }
  function scheduleNext() {
    reconcile(); const c = S.current;
    if (!c?.owns || c.loading || !c.playing || S.claim || S.phase !== 'owned') return;
    const next = nextTrack();
    if (S.scheduled && S.scheduled.selectionKey !== next?.key) cancelScheduled();
    if (!next || S.scheduled) return;
    const entry = resources.lookup(next);
    if (!entry?.hash) return;
    if (entry.spec.rate !== clock.ctx?.sampleRate) {
      if (c.rateBoundary !== next.key) {
        c.rateBoundary = next.key;
        trace('sample-rate-boundary', { from: c.id, to: next.id,
          currentRate: clock.ctx?.sampleRate, nextRate: entry.spec.rate });
      }
      return;
    }
    if (!clock.matches(entry)) return;
    const lead = c.end - clock.ctx.currentTime;
    if (lead < 0.08) { if (!c.missed) { c.missed = true; trace('missed-schedule', { id: c.id, lead }); } return; }
    const candidate = { id: next.id, requestedLevel: next.level, account: next.account, row: next.row,
      selectionKey: next.key, queueVersion: S.queueVersion, info: null, entry, level: entry.level,
      duration: entry.duration, offset: 0, heard: 0, owns: true, serial: ++S.serial };
    clock.start(candidate, c.end, 0); S.scheduled = candidate;
    trace('scheduled', { from: c.id, to: candidate.id, leadSeconds: lead,
      sourceRate: entry.spec.rate, decodedRate: entry.buffer.sampleRate, contextRate: clock.ctx.sampleRate, scheduledGapFrames: 0 });
  }
  function prefetch() {
    const c = S.current;
    const active = c?.owns ? c.playing : S.nativePlaying;
    const next = c && !c.blocked
      && ['native', 'owned', 'warming', 'pausing', 'loading'].includes(S.phase) ? nextTrack() : null;
    resources.retain([S.current?.blocked && !S.current.owns ? null : ref(S.current), next, ref(S.scheduled)]);
    // Retain an already decoded next track across pause; do not start new
    // background requests until playback resumes. Discarding it creates gaps
    // when the user seeks near the end and resumes immediately.
    if (!c?.entry || !next || (!active && !S.starting) || ['restoring', 'warming', 'pausing'].includes(S.phase)
      || resources.lookup(next) || resources.jobs.has(resources.requestKey(next))) return;
    const epoch = S.epoch, queueVersion = S.queueVersion;
    resources.obtain(next).then(() => {
      if (S.epoch === epoch && S.queueVersion === queueVersion) { void takeover(); scheduleNext(); }
    }).catch(error => {
      const key = resources.requestKey(next), failure = resources.failures.get(key);
      if (!failure?.logged && error.message !== 'cancelled') {
        trace('prefetch-fallback', { id: next.id, reason: error.message }); if (failure) failure.logged = true;
      }
    });
  }
  async function loadOwned(msg, c) {
    const epoch = S.epoch;
    try {
      if (msg.resumeExisting) {
        const [count] = await bridge.raw('audioplayer.getPlayedTime', [{ playId: c.id }]);
        if (!validRecovery(c, epoch)) throw new Error('cancelled');
        if (Number(count?.result) === 1) c.heard = Number(count.playedAudioTime) + (c.nativeHeardBase || 0);
      }
      // A native fallback may evict an unpinned entry while c still references
      // it. Reacquire through the resource owner so budget/pins stay accounted.
      c.entry = await resources.obtain(ref(c), c.info);
      if (!c.entry.hash || c.entry.hash !== Resources.fingerprint(c.info) || c.entry.level !== c.info.level)
        throw new Error('native-only-source-identity');
      if (!validRecovery(c, epoch) || !allowed(c.info)) throw new Error('cancelled');
      c.duration = c.entry.duration; c.level = c.entry.level;
      await clock.open(c.entry);
      if (!validRecovery(c, epoch) || !allowed(c.info)) throw new Error('cancelled');
      // Direct Web Load/resume also parks the native output. Otherwise an
      // unwrapped native system command could revive the old audio instance.
      if (S.nativeGate?.releasing) await S.nativeGate.releasing;
      if (!validRecovery(c, epoch) || !allowed(c.info) || S.phase === 'restoring') throw new Error('cancelled');
      if (!S.nativeGate) await acquireNativeGate(c, epoch, 'continuous-web');
      else await S.nativeGate.ready;
      if (!validRecovery(c, epoch) || !allowed(c.info) || S.phase === 'restoring') throw new Error('cancelled');
      clearTimeout(S.nativeGate?.watchdog);
      clock.setOutput(true); c.loading = false; c.transitioning = false; c.blocked = false; S.phase = 'owned';
      if (c.playing) clock.start(c, clock.ctx.currentTime + 0.01, c.offset);
      if (msg.resumeExisting) {
        ack(msg); emitState(c, c.playing ? 1 : 2, S.token); progress(c, true);
      } else answerLoad(msg, c);
      media?.sync(true); prefetch(); scheduleNext();
      trace('web-loaded', { id: c.id, origin: c.entry.origin, rate: c.entry.spec.rate });
    } catch (error) {
      if (!validRecovery(c, epoch)) { bridge.dispatch(msg.seq, [c.id, { code: -1 }]); return; }
      c.loading = false; c.playing = c.loadIntent;
      trace('web-load-fallback', { id: c.id, reason: error.message });
      // Reuse the exact authorized Native Load, never substitute a lower quality.
      await restoreNative(`web-load-${error.message}`);
      if (validRecovery(c, epoch)) {
        if (msg.resumeExisting) ack(msg);
        else bridge.dispatch(msg.seq, [c.id, { code: c.recoverySucceeded ? 0 : -1 }]);
      }
    }
  }
  async function prepareCurrent(c) {
    if (c.preparing || !S.nativePlaying) return; c.preparing = true;
    const epoch = S.epoch;
    try {
      const entry = await resources.obtain(ref(c), c.info);
      if (S.current !== c || S.epoch !== epoch || !allowed(c.info) || c.blocked) return;
      c.entry = entry; c.duration = entry.duration; c.level = entry.level;
      await takeover(); prefetch();
    } catch (error) {
      const failure = resources.failures.get(resources.requestKey(ref(c)));
      if (failure?.permanent) c.blocked = true;
      if (S.current === c && error.message !== 'cancelled' && !failure?.logged) {
        trace('native-fallback', { id: c.id, reason: error.message }); if (failure) failure.logged = true;
      }
    }
    finally { c.preparing = false; }
  }
  async function eventCall(command, params, event, predicate) {
    const waiter = bridge.waitNative(event, predicate);
    // Attach both rejection handlers before issuing the call to avoid orphaned event promises.
    try { const results = await Promise.all([bridge.raw(command, params), waiter.promise]); return results[1]; }
    finally { waiter.cancel(); }
  }
  async function waitUntil(wallTime, valid) {
    while (performance.now() < wallTime) {
      if (!valid()) throw new Error('handoff-cancelled');
      await new Promise(resolve => setTimeout(resolve, Math.min(10, Math.max(1, wallTime - performance.now()))));
    }
    if (!valid()) throw new Error('handoff-cancelled');
  }
  const nativeClockPosition = c => {
    const n = c.nativeClock;
    return n ? n.position + (n.playing ? Math.max(0, performance.now() - n.at) / 1000 : 0) : NaN;
  };
  async function readNativeClock(c) {
    const [count] = await bridge.raw('audioplayer.getPlayedTime', [{ playId: c.id }]);
    if (Number(count?.result) !== 1 || !Number.isFinite(Number(count.playedAudioTime)))
      throw new Error('native-listening-time-unavailable');
    const at = performance.now();
    // Progress delivery and the listened-frame counter are quantized. Fit the
    // continuous segment from several reports instead of snapping Web to the
    // phase of whichever report happened to arrive immediately before the cut.
    const reports = (c.nativeReports || []).filter(x => at - x.at < 1500);
    if (reports.length < 3) throw new Error('native-to-web-clock-not-stable');
    const offsets = reports.map(x => x.position - x.at / 1000).sort((a,b) => a-b);
    const offset = offsets[Math.floor(offsets.length / 2)];
    const deviations = offsets.map(x => Math.abs(x-offset)).sort((a,b) => a-b);
    if (deviations[Math.floor(deviations.length / 2)] > 0.015) throw new Error('native-to-web-clock-not-stable');
    return { count, at, position: at / 1000 + offset };
  }
  function primeNativeBridge(c, reading) {
    // Starting at currentTime can miss a render callback already in flight.
    // Schedule ahead, and advance the source offset to that future output time.
    const at = clock.ctx.currentTime + 0.08;
    const offset = reading.position + (clock.outputWallTime(at) - reading.at) / 1000;
    if (offset >= c.duration - 0.15) throw new Error('native-to-web-too-late');
    clock.start(c, at, offset);
  }
  function nativeOutputControlLead() {
    // Native gain selects PCM at the host mixer, not at the later device
    // timestamp. On this supported client a render buffer separates the two;
    // audio capture verified that using only RPC latency leaves a ~22 ms gap.
    const latency = Number(clock.ctx?.baseLatency);
    if (!(latency > 0 && latency <= 0.1)) throw new Error('native-output-control-latency-unavailable');
    return latency * 1000 + S.volumeLatencyMs;
  }
  async function takeover() {
    const c = S.current;
    if (!c?.entry) return;
    const remaining = c.duration - nativePosition();
    if (c.blocked || c.owns || c.awaitingGesture
      || !S.nativePlaying || !allowed(c.info) || c.nativeSeekTokens?.size
      || performance.now() < Math.max(c.seekStableAt || 0, c.bridgeNotBefore || 0)
      || S.starting || S.phase !== 'native' || remaining < 0.5) return;
    const epoch = S.epoch, revision = S.revision, queueVersion = S.queueVersion;
    const valid = () => S.current === c && S.epoch === epoch && S.revision === revision
      && S.queueVersion === queueVersion && allowed(c.info) && !c.blocked;
    S.starting = true; c.takeoverPlaying = true;
    let pauseIssued = false;
    try {
      await clock.open(c.entry);
      if (!valid() || !S.nativePlaying || c.duration - nativePosition() < 0.3) return;
      S.phase = 'warming';
      await media?.prepare();
      if (!valid() || !S.nativePlaying) return;
      // Render silently ahead of the output device while native remains audible.
      // Compensate the render/output delay, rather than replaying the old position.
      clock.setOutput(false);
      const outputDelay = Math.max(0, clock.ctx.currentTime - clock.outputTime());
      let reading = await readNativeClock(c);
      if (!valid() || !S.nativePlaying) return;
      primeNativeBridge(c, reading);
      c.nativeReady = true;
      const warmUntil = clock.outputWallTime(c.start + 0.04);
      await waitUntil(warmUntil, () => valid() && S.nativePlaying);
      reading = await readNativeClock(c);
      if (!valid() || !S.nativePlaying) return;
      let error = reading.position - clock.outputPosition(c);
      if (Math.abs(error) > 0.004) {
        // A late native progress report can change the clock estimate. Re-prime
        // silently once; do not stop the native music to perform this correction.
        primeNativeBridge(c, reading);
        await waitUntil(clock.outputWallTime(c.start + 0.04), () => valid() && S.nativePlaying);
        reading = await readNativeClock(c);
        if (!valid() || !S.nativePlaying) return;
        error = reading.position - clock.outputPosition(c);
      }
      if (Math.abs(error) > ALIGN_TOLERANCE) throw new Error('native-to-web-not-aligned');
      const nativeTime = reading.count, nativeReadAt = reading.at;
      if (!valid() || !S.nativePlaying) return;
      if (Number(nativeTime?.result) !== 1 || !Number.isFinite(Number(nativeTime.playedAudioTime))) throw new Error('native-listening-time-unavailable');
      const cutAt = clock.ctx.currentTime + 0.04;
      const cutWall = clock.outputWallTime(cutAt);
      clock.setOutput(true, cutAt);
      const controlLeadMs = nativeOutputControlLead();
      await waitUntil(cutWall - controlLeadMs, () => valid() && S.nativePlaying);
      S.phase = 'pausing';
      // Native pause acknowledges before its fade has finished. Select Web
      // output first; park native while muted so that fade cannot mix with Web.
      await acquireNativeGate(c, epoch, 'takeover');
      if (!valid() || !c.takeoverPlaying) return;
      pauseIssued = true;
      const started = performance.now(), token = `${c.id}|pause|gapless-${epoch}`;
      await eventCall('audioplayer.pause', [c.id, token], 'audioplayer.onPlayState',
        a => String(a[0]) === c.id && a[1] === token && Number(a[2]) === 2);
      const pausedAt = bridge.eventAt['audioplayer.onPlayState'];
      if (!valid() || !c.takeoverPlaying) return;
      if (S.nativeGate?.c !== c || S.nativeGate.epoch !== epoch) throw new Error('native-takeover-gate-lost');
      c.heard = Number(nativeTime.playedAudioTime) + (c.nativeHeardBase || 0)
        + Math.max(0, (performance.now() - nativeReadAt) / 1000) - Math.max(0, clock.ctx.currentTime - c.start);
      c.owns = true; S.phase = 'owned';
      // Keep the parked backend muted throughout Web playback. Restoring gain
      // on its pause acknowledgement would revive residual native output.
      clearTimeout(S.nativeGate?.watchdog);
      S.token = `${c.id}|resume|gapless-${epoch}`;
      emitState(c, 1); bridge.emit('audioplayer.onBuffering', [c.id, 0]);
      trace('takeover', { id: c.id, position: clock.outputPosition(c), remainingSeconds: c.duration - clock.outputPosition(c),
        alignmentErrorMs: error * 1000, outputDelayMs: outputDelay * 1000, pauseAcknowledged: true,
        nativeOutputControlLeadMs: controlLeadMs, pauseAcknowledgementMs: pausedAt - started,
        switchTimingErrorMs: pausedAt - cutWall });
      scheduleNext();
    } catch (error) {
      if (validRecovery(c, epoch)) {
        if (error.message === 'native-only-context-awaiting-gesture') {
          c.awaitingGesture = true; trace('awaiting-gesture', { id: c.id });
        } else if (error.message !== 'handoff-cancelled') {
          c.bridgeNotBefore = performance.now() + 1000;
          trace('takeover-fallback', { id: c.id, reason: error.message });
        }
      }
    } finally {
      if (validRecovery(c, epoch) && !c.owns) {
        clock.setOutput(false); clock.stop(c);
        while (c.takeoverSeek) {
          const pending = c.takeoverSeek; await pending;
          if (c.takeoverSeek === pending) c.takeoverSeek = null;
        }
        if (validRecovery(c, epoch)) {
          S.phase = 'native';
          await releaseNativeGate().catch(error => trace('native-volume-restore-error', { reason: error.message }));
          if (pauseIssued && c.takeoverPlaying) await bridge.raw('audioplayer.play',
            [c.id, `${c.id}|resume|cancelled-takeover-${epoch}`]).catch(() => {});
        }
      }
      try {
        if (S.nativeGate?.c === c && !c.owns)
          await releaseNativeGate().catch(error => trace('native-volume-restore-error', { reason: error.message }));
        // Failed/cancelled prewarming must not leave a silent output device
        // running throughout native playback. Keep starting locked until close.
        if (!S.current?.owns) { await clock.close(); media?.sync(true); }
      } catch (error) {
        trace('takeover-cleanup-error', { id: c.id, reason: error.message });
      } finally { S.starting = false; }
    }
  }
  function validRecovery(c, epoch) { return S.current === c && S.epoch === epoch; }
  async function releaseNativeGate() {
    const gate = S.nativeGate;
    if (!gate) return;
    if (gate.releasing) return gate.releasing;
    clearTimeout(gate.watchdog);
    gate.releasing = (async () => {
      let confirmed = false;
      try {
        for (let attempt = 0; attempt < 3; attempt++) {
          const volume = clock.volume, started = performance.now();
          await bridge.raw('audioplayer.setVolume', ['', '', volume], 1500);
          S.volumeLatencyMs = Math.max(0, Math.min(30, performance.now() - started));
          if (volume === clock.volume) { confirmed = true; break; }
        }
      } finally {
        if (S.nativeGate === gate) S.nativeGate = null;
        if (confirmed) {
          try { localStorage.removeItem(gateRecoveryKey); } catch { /* Optional crash recovery. */ }
        } else {
          // An acknowledgement failure must not keep intercepting user volume.
          // Reissue the original gain and retain the crash journal until it succeeds.
          bridge.callNative('audioplayer.setVolume', ['', '', clock.volume], () => {
            try { localStorage.removeItem(gateRecoveryKey); } catch { /* Optional crash recovery. */ }
          });
        }
      }
    })();
    return gate.releasing;
  }
  async function acquireNativeGate(c, epoch, purpose = 'handoff') {
    if (S.nativeGate) throw new Error('native-output-gate-busy');
    const gate = S.nativeGate = { c, epoch, purpose };
    try { localStorage.setItem(gateRecoveryKey, String(clock.volume)); } catch { /* Navigation also restores gain. */ }
    // This is an output selector, not a new volume setting: user volume is
    // retained in clock.volume and restored on every success/cancel/error path.
    gate.watchdog = setTimeout(() => {
      if (S.nativeGate !== gate) return;
      if (validRecovery(c, epoch) && c.owns) void restoreNative('native-gate-timeout');
      else void releaseNativeGate().catch(error => trace('native-volume-restore-error', { reason: error.message }));
    }, 3000);
    gate.ready = bridge.raw('audioplayer.setVolume', ['', '', 0]);
    await gate.ready;
  }
  async function restoreNative(reason) {
    reconcile(); const c = S.current;
    if (!c?.owns) return S.recovering;
    if (S.phase === 'restoring') return S.recovering;
    const epoch = S.epoch, target = clock.position(c); let desired = c.playing;
    c.recoveryPosition = target; c.recoveryPlaying = desired; c.recoveryHeard = clock.heard(c);
    c.recoverySucceeded = false; c.blocked = true; S.claim = false;
    S.phase = 'restoring'; stopCurrent(); visual.stop(); trace('restore-start', { id: c.id, reason, position: target });
    const run = async () => {
      try {
        await releaseNativeGate();
        // Only the SDK queue-selection workflow installs an onLoad auto-play
        // callback. A raw load does not; its first Play may be real user intent.
        const needsSelection = !c.info || c.restoreSelection;
        c.recoverySelecting = !!needsSelection;
        c.ignoreSelectionPlay = !!needsSelection;
        if (needsSelection) {
          if (!c.row || (rows().length && rows().filter(r => rowId(r) === c.id).length !== 1)) throw new Error('native-recovery-selection-unavailable');
          const loaded = bridge.waitNative('audioplayer.onLoad', a => String(a[0]) === c.id && Number(a[1]?.code) === 0, 8000);
          const completed = loaded.promise;
          try {
            S.store.dispatch({ type: 'playing/playOneTrackInPlayingList', payload: {
              item: c.row, switchType: 'call', flag: 1, triggerScene: 'playingList' } });
            await completed;
          } finally { loaded.cancel(); }
          c.info = bridge.loads.get(c.id);
          if (!c.info) throw new Error('native-recovery-info-unavailable');
        } else {
          await eventCall('audioplayer.load', [c.id, c.info], 'audioplayer.onLoad', a => String(a[0]) === c.id && Number(a[1]?.code) === 0);
        }
        if (!validRecovery(c, epoch)) return;
        c.restoreSelection = false;
        // Stop the native load workflow first; then seek; only then restore the latest transport intent.
        let token = `${c.id}|pause|restore-${epoch}`;
        // NetEase acknowledges pause by RPC; a freshly loaded, already paused backend emits no new state event.
        await bridge.raw('audioplayer.pause', [c.id, token]);
        if (!validRecovery(c, epoch)) return;
        let settled = false;
        for (let attempt = 0; attempt < 8 && !settled; attempt++) {
          const revision = S.revision;
          token = `${c.id}|seek|restore-${epoch}-${attempt}`;
          await eventCall('audioplayer.seek', [c.id, token, c.recoveryPosition], 'audioplayer.onSeek', a => String(a[0]) === c.id && a[1] === token && Number(a[2]) === 0);
          if (!validRecovery(c, epoch)) return;
          if (S.revision !== revision) continue;
          desired = c.recoveryPlaying;
          token = `${c.id}|${desired ? 'resume' : 'pause'}|restore-${epoch}-${attempt}`;
          if (desired) await eventCall('audioplayer.play', [c.id, token], 'audioplayer.onPlayState', a => String(a[0]) === c.id && a[1] === token && Number(a[2]) === 1);
          else await bridge.raw('audioplayer.pause', [c.id, token]);
          if (!validRecovery(c, epoch)) return;
          settled = S.revision === revision;
        }
        if (!settled) throw new Error('native-recovery-controls-busy');
        stopCurrent(); c.owns = false; c.bridgeSide = null; c.nativeSegment = null; S.phase = 'native';
        S.nativePosition = c.recoveryPosition; S.nativeAt = performance.now(); S.nativePlaying = desired;
        c.suppressPausedNativeProgress = !desired;
        c.recoverySucceeded = true;
        c.nativeHeardBase = c.recoveryHeard;
        if (!validRecovery(c, epoch)) return;
        bridge.emit('audioplayer.onPlayProgress', [c.id, c.recoveryPosition, 1, true]);
        emitState(c, desired ? 1 : 2, token);
        trace('restored-native', { id: c.id, reason, position: c.recoveryPosition, playing: desired, confirmed: true });
        if (reason === 'page-reload' && S.enabled) {
          c.blocked = false; c.requestedLevel = quality(c.info); void prepareCurrent(c);
        }
      } catch (error) {
        if (!validRecovery(c, epoch)) return;
        stopCurrent(); c.owns = false; S.phase = 'native';
        // Even a failed seek/load acknowledgement must leave the real backend in an explicit state.
        desired = c.recoveryPlaying;
        await bridge.raw(`audioplayer.${desired ? 'play' : 'pause'}`, [c.id, `${c.id}|${desired ? 'resume' : 'pause'}|recovery-fallback-${epoch}`]).catch(() => {});
        trace('recovery-error', { id: c.id, reason: error.message, nativeFallbackIssued: true });
      } finally {
        c.recoverySelecting = false;
        c.ignoreSelectionPlay = false;
        resources.retain([ref(S.current)]);
        if (!S.current?.owns) await clock.close();
      }
    };
    S.recovering = run(); await S.recovering;
    if (validRecovery(c, epoch)) S.recovering = null;
  }
  bridge.shouldSuppressNative = (command, args) => {
    const c = S.current;
    if (command === 'audioplayer.onAudioData' && c?.owns) return true;
    if (command === 'audioplayer.onVolume' && (S.nativeGate || c?.owns)) return true;
    if (command === 'audioplayer.onLoad' && c?.owns && S.phase !== 'restoring') return true;
    // Raw recovery loads only reconstruct the parked backend. Native waiters
    // already observed this event; forwarding it re-enters the SDK auto-play
    // workflow. Queue selection still needs its SDK Load callback to finish.
    if (command === 'audioplayer.onLoad' && c?.owns && S.phase === 'restoring' && !c.recoverySelecting) return true;
    if (command === 'winhelper.onHotkey') {
      const action = { play_pause: 'toggle', play: 'play', pause: 'pause', next: 'nexttrack', prev: 'previoustrack' }[args[0]];
      if (action && media?.requestTransport(action)) return true;
    }
    // Parked-backend events, including old track IDs, cannot replace owned
    // state/progress or complete an owned Seek. Raw waiters observe them first.
    if (c?.owns && /^audioplayer\.(onPlayState|onPlayProgress|onEnd|onSeek|onBuffering)$/.test(command)) return true;
    if (String(args?.[0]) === c?.id && command === 'audioplayer.onSeek'
      && c.nativeSeekBuffered?.has(args[1])) return true;
    if (String(args?.[0]) === c?.id && command === 'audioplayer.onPlayProgress'
      && c.nativeSeekTokens?.size) return true;
    if (String(args?.[0]) === c?.id && command === 'audioplayer.onPlayProgress'
      && c.suppressPausedNativeProgress && !S.nativePlaying) return true;
    return !!c && (c.owns || S.phase === 'pausing') && String(args?.[0]) === c.id
      && /^audioplayer\.(onPlayState|onPlayProgress|onEnd|onSeek|onBuffering)$/.test(command);
  };
  bridge.onNativeEvent = (command, args) => {
    if (command === 'audioplayer.onVolume' && !S.nativeGate && !S.current?.owns) clock.setVolume(Number(args[3]));
    const c = S.current; if (!c || String(args[0]) !== c.id) return;
    if (command === 'audioplayer.onPlayProgress') {
      c.nativeClock = { position: Number(args[1]), at: performance.now(), playing: !!c.nativeClock?.playing };
    } else if (command === 'audioplayer.onPlayState') {
      c.nativeClock = { position: Number.isFinite(nativeClockPosition(c)) ? nativeClockPosition(c) : nativePosition(),
        at: performance.now(), playing: Number(args[2]) === 1 };
    } else if (command === 'audioplayer.onSeek' && Number(args[2]) === 0) {
      c.nativeClock = { position: Number(args[3]), at: performance.now(), playing: !!c.nativeClock?.playing };
    }
    if (c.owns) return;
    if (command === 'audioplayer.onPlayProgress') {
      S.nativePosition = Number(args[1]); S.nativeAt = performance.now();
      if (S.nativePlaying) {
        c.nativeReports ||= [];
        c.nativeReports.push({ position: S.nativePosition, at: S.nativeAt });
        c.nativeReports = c.nativeReports.filter(x => S.nativeAt - x.at < 1500).slice(-16);
      }
    }
    else if (command === 'audioplayer.onPlayState') {
      S.nativePosition = nativePosition(); S.nativeAt = performance.now(); S.nativePlaying = Number(args[2]) === 1;
      c.nativeReports = [];
      S.token = args[1]; if (S.phase === 'native') void takeover();
    } else if (command === 'audioplayer.onSeek') {
      c.nativeReports = [];
      c.nativeSeekTokens?.delete(args[1]); c.seekStableAt = performance.now() + 400;
      if (Number(args[2]) === 0) { S.nativePosition = Number(args[3]); S.nativeAt = performance.now(); }
    }
  };
  bridge.onError = error => { trace('bridge-error', { reason: error.message }); void restoreNative('bridge-error'); };
  function ack(msg, args = []) { queueMicrotask(() => bridge.dispatch(msg.seq, args)); }
  function seekOwned(c, value, token) {
    S.revision++;
    const offset = Math.max(0, Math.min(c.duration - 0.001, Number(value)));
    cancelScheduled(); if (c.loading) c.offset = offset; else clock.seek(c, offset); c.endSent = false; c.missed = false; S.token = token;
    trace('seek', { id: c.id, position: offset }); scheduleNext();
    return offset;
  }
  function completeSeek(msg, c, token, offset, code = 0) {
    seekReplies.push({ msg, c, token, offset, code, epoch: S.epoch });
    if (seekReplies.length === 1) replyNextSeek();
  }
  function replyNextSeek() {
    const request = seekReplies[0]; if (!request) return;
    ack(request.msg);
    // Serialize acknowledgements: this SDK subscribes after RPC and does not
    // filter Seek notifications by token. Every accepted request must complete.
    setTimeout(() => {
      try {
        const { c, token, offset, code, epoch } = request;
        const valid = S.current === c && S.epoch === epoch;
        bridge.emit('audioplayer.onSeek', [c.id, token, valid ? code : -1, offset]);
        const current = S.current;
        if (current?.owns && !S.claim) {
          progress(current, true);
          // BetterNCM infers playing from large progress jumps. A paused Seek is
          // still paused; publish its real state once, without paused heartbeats.
          if (!current.playing) emitState(current, 2);
        } else if (valid && S.phase !== 'restoring' && !c.nativeSeekTokens?.size) {
          bridge.emit('audioplayer.onPlayProgress', [c.id, nativePosition().toFixed(3), '1.0000', true]);
          if (!S.nativePlaying) emitState(c, 2);
        }
      } catch (error) { bridge.onError(error); }
      finally { seekReplies.shift(); replyNextSeek(); }
    }, 0);
  }
  bridge.handle = msg => {
    reconcile(); const p = msg.params || []; let c = S.current;
    if (msg.command === 'audioplayer.load') {
      const id = String(p[0]), info = p[1], level = quality(info);
      trace('native-load', { id, phase: S.phase, current: c?.id, epoch: S.epoch });
      if (S.phase === 'restoring' && c?.id === id) { c.info = info; return false; }
      if (S.claim && c?.id === id && allowed(info) && c.requestedLevel === level && c.level === info?.level
        && c.entry?.hash && Resources.fingerprint({ ...info, url: info?.musicurl }) === c.entry.hash && clock.matches(c.entry)) {
        c.info = info; S.claim = false; S.phase = 'owned';
        if (!c.playing) c.pauseAfterClaimRevision = S.revision;
        trace('claimed', { id, position: clock.position(c), claimDelayMs: performance.now() - c.claimAt });
        answerLoad(msg, c);
        prefetch(); scheduleNext();
        return true;
      }
      if (S.claim) trace('claim-rejected', { expected: c?.id, received: id, reason: 'native-source-or-queue-changed' });
      const wasPlaying = c?.owns ? !!(c.playing || c.transitioning && c.loadIntent) : S.nativePlaying;
      S.epoch++; S.revision++; stopCurrent(); S.claim = false; S.phase = 'native';
      S.nativePlaying = false; S.nativePosition = 0; S.nativeAt = performance.now();
      S.current = c = { id, info, requestedLevel: level, account: S.account, duration: Number(info?.songDuration) / 1000,
        serial: ++S.serial, offset: 0, heard: 0, owns: false, playing: false };
      // Adopt a matching cached source synchronously. Waiting for native play
      // before the async preparation would let a store update evict both warm
      // buffers between Load and play, especially when selecting the same track.
      const cached = allowed(info) && resources.lookup(ref(c), info);
      if (cached) { c.entry = cached; c.duration = cached.duration; c.level = cached.level; }
      resources.resetFailures(); resources.retain([ref(c), nextTrack()]);
      if (allowed(info) && !msg.observedNative) {
        c.owns = true; c.loading = true; c.playing = false; c.offset = 0;
        c.loadIntent = wasPlaying; S.phase = 'loading';
        void loadOwned(msg, c); return true;
      }
      void releaseNativeGate().catch(error => trace('native-volume-restore-error', { reason: error.message }));
      if (allowed(info)) void prepareCurrent(c);
      return false;
    }
    if (msg.command === 'audioplayer.setVolume') {
      clock.setVolume(Number(p[2]));
      if (S.nativeGate || c?.owns) {
        try { localStorage.setItem(gateRecoveryKey, String(clock.volume)); } catch { /* Optional crash recovery. */ }
        ack(msg); bridge.emit('audioplayer.onVolume', [p[0] || '', p[1] || '', 0, clock.volume]); return true;
      }
      return false;
    }
    if (S.phase === 'restoring' && /^audioplayer\.(stop|unload)$/.test(msg.command)) {
      trace('recovery-native-cleanup', { command: msg.command, id: String(p[0] || '') }); ack(msg); return true;
    }
    if (S.phase === 'restoring' && c && /^audioplayer\.(play|pause|seek)$/.test(msg.command)
      && (!p[0] || String(p[0]) === c.id)) {
      const selectionPlay = c.ignoreSelectionPlay && msg.command === 'audioplayer.play';
      if (selectionPlay) c.ignoreSelectionPlay = false;
      else {
        S.revision++;
        if (msg.command.endsWith('seek')) {
          if (Number.isFinite(Number(p[2]))) c.recoveryPosition = Math.max(0, Math.min(c.duration - 0.001, Number(p[2])));
        } else c.recoveryPlaying = msg.command.endsWith('play');
      }
      const epoch = S.epoch, token = p[1] || c.id;
      Promise.resolve(S.recovering).finally(() => {
        if (msg.command.endsWith('seek')) {
          completeSeek(msg, c, token, c.recoveryPosition,
            validRecovery(c, epoch) && c.recoverySucceeded ? 0 : -1);
          return;
        }
        ack(msg);
        if (selectionPlay) setTimeout(() => {
          if (validRecovery(c, epoch) && c.suppressPausedNativeProgress && !S.nativePlaying) emitState(c, 2, token);
        }, 0);
      });
      return true;
    }
    if (!c?.owns && c?.nativeHeardBase && msg.command === 'audioplayer.getPlayedTime') {
      const requested = String(p[0]?.playId || p[0] || '');
      if (requested && requested !== c.id) return false;
      void bridge.raw(msg.command, p).then(args => {
        const result = args[0];
        if (Number(result?.result) === 1) ack(msg, [{ ...result,
          playedTime: Number(result.playedTime) + c.nativeHeardBase,
          playedAudioTime: Number(result.playedAudioTime) + c.nativeHeardBase }]);
        else ack(msg, args);
      }).catch(() => ack(msg, [{ result: 0 }]));
      return true;
    }
    if (!c?.owns && c?.info && S.phase === 'native' && !S.nativePlaying && !S.starting
      && allowed(c.info) && msg.command === 'audioplayer.play' && (!p[0] || String(p[0]) === c.id)) {
      // A confirmed paused native source need not start just to hand it off.
      // Resume directly into Web at its saved position and listening-time base.
      S.revision++; S.token = p[1] || c.id; c.offset = nativePosition();
      c.owns = true; c.loading = true; c.playing = true; c.loadIntent = true; S.phase = 'loading';
      void loadOwned({ ...msg, resumeExisting: true }, c); return true;
    }
    if (!c?.owns) {
      if (/^audioplayer\.(play|pause|seek|stop|unload)$/.test(msg.command)) {
        S.revision++;
        if (c) c.suppressPausedNativeProgress = false;
        if (c && S.enabled && S.compatible && allowed(c.info) && msg.command === 'audioplayer.seek'
          && (!p[0] || String(p[0]) === c.id)) {
          // Defer output handoff until native Seek settles; keep decoded sources
          // so a user Seek does not disable gapless for the remainder of a track.
          const seekToken = p[1] || c.id, epoch = S.epoch;
          c.nativeSeekTokens ||= new Set(); c.nativeSeekTokens.add(seekToken);
          c.seekStableAt = performance.now() + 400;
          setTimeout(() => {
            if (S.current === c && S.epoch === epoch && c.nativeSeekTokens.delete(seekToken)) {
              c.seekStableAt = performance.now() + 400;
              trace('native-user-seek-timeout', { id: c.id });
            }
          }, 5000);
          // Buffer completion until its RPC finishes, then use the same
          // serialized SDK reply as an owned Seek. Never lose its event.
          c.nativeSeekBuffered ||= new Set(); c.nativeSeekBuffered.add(seekToken);
          c.takeoverSeek = eventCall('audioplayer.seek', p, 'audioplayer.onSeek',
            a => String(a[0]) === c.id && a[1] === seekToken).then(args => {
            c.nativeSeekBuffered.delete(seekToken);
            completeSeek(msg, c, seekToken, Number(args[3]), Number(args[2]));
          }).catch(error => {
            c.nativeSeekBuffered.delete(seekToken); c.nativeSeekTokens.delete(seekToken);
            trace('native-user-seek-error', { id: c.id, reason: error.message });
            completeSeek(msg, c, seekToken, nativePosition(), -1);
          });
          trace('native-user-seek', { id: c.id, takeoverDeferred: true });
          return true;
        }
        if (['warming', 'pausing'].includes(S.phase) && c && (!p[0] || String(p[0]) === c.id)) {
          if (msg.command.endsWith('pause') || /\.(stop|unload)$/.test(msg.command)) c.takeoverPlaying = false;
          else if (msg.command.endsWith('play')) c.takeoverPlaying = true;
        }
      }
      return false;
    }
    if (msg.command === 'audioplayer.setPlaybackRate' && Number(p[0]) !== 1) { void restoreNative('native-speed'); return false; }
    const trackCommand = /^audioplayer\.(play|pause|seek|stop|unload)$/.test(msg.command);
    const matches = !p[0] || String(p[0]) === c.id;
    const globalPause = msg.command === 'audioplayer.pause' && S.claim && performance.now() - S.gestureAt < 1500;
    if (trackCommand && !matches && !globalPause) {
      // An old SDK cleanup command must not pause the parked native backend or the new Web Audio instance.
      trace('stale-control', { command: msg.command, id: String(p[0]), current: c.id });
      if (msg.command === 'audioplayer.seek') {
        completeSeek(msg, { id: String(p[0]) }, p[1] || String(p[0]), Number(p[2]) || 0, -1);
      } else ack(msg);
      return true;
    }
    if (msg.command === 'audioplayer.play') {
      if (c.pauseAfterClaimRevision === S.revision) {
        c.pauseAfterClaimRevision = null; ack(msg);
        const epoch = S.epoch, token = p[1] || c.id;
        setTimeout(() => { if (validRecovery(c, epoch) && !c.playing) emitState(c, 2, token); }, 0);
        return true;
      }
      c.pauseAfterClaimRevision = null;
      S.revision++; const token = p[1] || c.id; S.token = token;
      if (c.loading) { c.playing = true; c.loadIntent = true; ack(msg); return true; }
      c.transitioning = false;
      if (clock.ctx?.state !== 'running') { void restoreNative('play-context-unavailable'); return false; }
      if (!c.playing) { cancelScheduled(); clock.start(c, clock.ctx.currentTime + 0.01, c.offset); }
      emitState(c, 1, token); ack(msg); trace('play', { id: c.id }); prefetch(); scheduleNext(); return true;
    }
    if (msg.command === 'audioplayer.pause') {
      S.revision++; S.token = p[1] || c.id; stopCurrent(); progress(c, true); emitState(c, 2, S.token); ack(msg);
      c.loadIntent = false; c.transitioning = false; if (c.loading) c.pauseAfterClaimRevision = S.revision;
      trace('pause', { id: c.id, position: clock.position(c) }); return true;
    }
    if (msg.command === 'audioplayer.seek') {
      if (!Number.isFinite(Number(p[2]))) return false;
      const token = p[1] || c.id;
      const offset = seekOwned(c, p[2], token);
      completeSeek(msg, c, token, offset);
      return true;
    }
    if (/^audioplayer\.(stop|unload)$/.test(msg.command)) {
      const intent = c.playing || c.loadIntent;
      S.epoch++; S.revision++; stopCurrent(); c.loading = false;
      c.transitioning = true; c.loadIntent = !!intent; S.phase = 'owned'; ack(msg); return true;
    }
    if (msg.command === 'audioplayer.getPlayedTime') {
      const requested = String(p[0]?.playId || p[0] || '').split('_')[0];
      if (requested && requested !== c.id) return false;
      // macOS SDK returns cumulative listened seconds in both fields, independent of seek position.
      const heard = clock.heard(c);
      ack(msg, [{ result: 1, playedTime: heard, playedAudioTime: heard }]); return true;
    }
    if (msg.command === 'audioplayer.getPlaybackInfo') {
      // Device format belongs to the native device API; never invent it from an AudioBuffer.
      return false;
    }
    return false;
  };
  function tick() {
    try {
      if (!S.store) initializeStore();
      reconcile(); updateEnvironment();
      if (S.claim && performance.now() - S.current.claimAt > 3000) void restoreNative('unclaimed-next');
      if (S.current?.owns && !S.claim) progress(S.current);
      void takeover(); scheduleNext(); prefetch();
      media?.sync(); visual.sync();
    } catch (error) { bridge.onError(error); }
  }
  function initializeStore() {
    S.store ||= findStore(); if (!S.store || S.unsubscribe) return;
    S.compatible = capabilityCheck(); updateEnvironment();
    S.unsubscribe = S.store.subscribe(() => {
      try { updateEnvironment(); scheduleNext(); prefetch(); } catch (error) { bridge.onError(error); }
    });
    clock.setVolume(Number(state()?.playing?.playingVolume ?? clock.volume));
    if (S.current && !S.current.owns && !S.current.entry && allowed(S.current.info)) {
      S.current.account = S.account; void prepareCurrent(S.current);
    }
    trace('capabilities', { compatible: S.compatible });
    consumeRecovery();
  }
  initializeStore();
  try {
    const saved = localStorage.getItem(gateRecoveryKey), value = Number(saved);
    if (saved !== null && Number.isFinite(value) && value >= 0 && value <= 1) {
      clock.setVolume(value);
      bridge.callNative('audioplayer.setVolume', ['', '', value], () => localStorage.removeItem(gateRecoveryKey));
    }
  } catch { /* Do not block native startup for optional gain recovery. */ }
  clock.setVolume(Number(bridge.events['audioplayer.onVolume']?.[3] ?? state()?.playing?.playingVolume ?? 1));
  const initial = bridge.calls.filter(call => call.command === 'audioplayer.load').at(-1);
  if (initial) {
    bridge.handle({ ...initial, observedNative: true });
    const e = bridge.events['audioplayer.onPlayProgress'];
    if (e && String(e[0]) === S.current.id) {
      S.nativePosition = Number(e[1]); S.nativeAt = bridge.eventAt['audioplayer.onPlayProgress'] || performance.now();
    }
    const play = bridge.events['audioplayer.onPlayState'];
    S.nativePlaying = Number(play?.[2]) === 1; S.token = play?.[1] || '';
  }
  bridge.calls.length = 0;
  const timer = setInterval(tick, 150);
  const gesture = () => {
    S.gestureAt = performance.now();
    media?.retry();
    if (S.current) S.current.awaitingGesture = false;
    if (clock.ctx?.state === 'suspended') void clock.ctx.resume().then(() => takeover()).catch(() => {});
    if (!S.current?.owns) void takeover();
  };
  window.addEventListener('pointerdown', gesture, true); window.addEventListener('keydown', gesture, true);
  async function disable() {
    S.enabled = false; visual.stop(); resources.stop(); await restoreNative('disabled');
    resources.retain([]); await clock.close(); if (S.current) S.current.entry = null; trace('disabled');
  }
  const hostFetch = window.fetch.bind(window);
  document.addEventListener('click', event => {
    const button = event.target.closest?.('.bncm-plugins-switch');
    if (button?.getAttribute('aria-label') !== '无缝播放' || typeof BETTERNCM_API_PATH !== 'string'
      || typeof BETTERNCM_API_KEY !== 'string') return;
    event.preventDefault(); event.stopImmediatePropagation();
    const on = button.getAttribute('aria-checked') !== 'true'; button.disabled = true;
    // Persist through the same host endpoint; this isolated switch does not need a page reload.
    // That keeps the native backend playing when the plugin is no longer injected on future loads.
    void (async () => {
      try {
        if (!on) await disable();
        const response = await hostFetch(BETTERNCM_API_PATH + '/internal/plugins/enabled', {
          method: 'POST', headers: { BETTERNCM_API_KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify({ slug: 'gapless-player-mac', enabled: on }),
        });
        if (!response.ok) throw new Error(`host-switch-${response.status}`);
        if (on) {
          S.enabled = true; resources.enabled = true;
          if (S.current) { S.current.blocked = false; void prepareCurrent(S.current); }
        }
        button.setAttribute('aria-checked', String(on)); trace('enabled-changed', { enabled: on });
      } catch (error) {
        trace('host-switch-error', { reason: error.message });
        if (!on) {
          S.enabled = true; resources.enabled = true;
          if (S.current) { S.current.blocked = false; void prepareCurrent(S.current); }
        }
      } finally { button.disabled = false; }
    })();
  }, true);
  function persistRecovery() {
    const c = S.current; if (!c || !S.enabled) return;
    const row = c.row || rows().find(r => rowId(r) === c.id);
    try { sessionStorage.setItem(recoveryKey, JSON.stringify({ id: c.id, info: c.info,
      row, position: position(), playing: c.owns ? c.playing : S.nativePlaying,
      heard: c.owns ? clock.heard(c) : c.nativeHeardBase || 0,
      account: S.account, at: Date.now() })); } catch { /* Optional host recovery. */ }
  }
  window.addEventListener('beforeunload', () => {
    persistRecovery(); clearInterval(timer); S.unsubscribe?.(); resources.stop();
    media?.release(); visual.stop();
    // The native gain is never left at the rehearsal value across navigation.
    if (S.nativeGate) bridge.callNative('audioplayer.setVolume', ['', '', clock.volume]);
    // Recovery is driven by the next page, rather than a multi-stage asynchronous unload callback.
    stopCurrent(); void clock.close();
  });
  function consumeRecovery() {
    if (S.recoveryConsumed || !S.compatible) return;
    S.recoveryConsumed = true;
    try {
    const saved = JSON.parse(sessionStorage.getItem(recoveryKey) || 'null'); sessionStorage.removeItem(recoveryKey);
    if (saved && Date.now() - saved.at < 30000 && saved.account === S.account
      && (!S.current || S.current.id === saved.id)) {
      const info = saved.info || bridge.loads.get(saved.id);
      if (info && saved.row) {
        if (!rows().length) S.store.dispatch({ type: 'playingList/restoreCurPlayingList' });
        stopCurrent(); S.epoch++;
        S.current = { id: saved.id, info, requestedLevel: quality(info), account: S.account,
          duration: Number(info.songDuration) / 1000, serial: ++S.serial, offset: saved.position,
          heard: saved.heard || 0, playing: saved.playing, owns: true, row: saved.row, restoreSelection: true };
        // No audio node survives navigation; the saved native transaction is the only owner.
        void restoreNative('page-reload');
      }
    }
    } catch (error) { trace('reload-recovery-error', { reason: error.message }); }
  }
  window.gaplessMac = {
    version: '0.2.2', status: () => {
      reconcile(); const c = S.current;
      return { enabled: S.enabled, compatible: S.compatible, id: c?.id, phase: S.phase,
        ownsPlayback: !!c?.owns, playing: c?.owns ? !!c.playing : S.nativePlaying,
        playbackMode: 'continuous-web', loading: !!c?.loading, nativeOutputGated: !!S.nativeGate,
        seekPending: !!c?.nativeSeekTokens?.size, seekSettling: performance.now() < (c?.seekStableAt || 0),
        position: position(), duration: c?.duration, requestedLevel: c?.requestedLevel, actualLevel: c?.level || c?.info?.level,
        sourceRate: c?.entry?.spec.rate, decodedRate: c?.entry?.buffer.sampleRate, ...clock.status(),
        resourceOrigin: c?.entry?.origin || null,
        next: nextTrack()?.id, scheduled: S.scheduled?.id, claiming: S.claim,
        memory: resources.status(), mode: state()?.playing?.playingMode, nativeAllowed: allowed(c?.info),
        queueVersion: S.queueVersion, loadEpoch: S.epoch, controlRevision: S.revision,
        systemMedia: media?.status(), visualization: visual.status() };
    }, trace: () => [...log], disable, restoreNative,
  };
  trace('ready', { compatible: S.compatible, appVersion: window.APP_CONF?.appver });
});
