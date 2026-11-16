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
  // Gapless takes priority over native-only processing. Keep saved preferences
  // intact for native playback; they must not silently disable the gapless switch.
  const nativeAudioPreferences = s => Object.entries({
    audioEffects: s?.audioEffect?.setting?.isOn || s?.assignedAudioEffect?.isOn
      || s?.assignedAudioEffect?.setting?.isOn || s?.playing?.audioEffect?.isOpen,
    loudness: s?.setting?.loudnessBalance, spatial: s?.setting?.systemSpatialSound,
    enhancement: s?.setting?.systemAudioEnhance, dolby: s?.setting?.listenDolby, fade: s?.setting?.playFade,
    speed: Number(s?.playing?.playingSpeed || 1) !== 1 || Number(s?.playing?.playingSpeedTrack || 1) !== 1,
  }).filter(([, value]) => value).map(([name]) => name);
  const allowed = info => {
    const s = state();
    return !!(S.enabled && S.compatible && s && (!info || (!info.freeTrialInfo
      && (info.audioType === 'track' || localSource.path(info))))
      && !s.playing?.isPlayingVideo && !s.playing?.resourceIsTryType);
  };
  const rowId = row => String(row.resourceId || row.trackId || row.id);
  const rows = () => state()?.playingList?.curPlayingList || [];
  const ref = c => c && ({ id: c.id, level: c.requestedLevel, account: c.account, duration: c.duration, row: c.row });
  const nativePosition = () => Math.max(0, S.nativePosition + (S.nativePlaying ? (performance.now() - S.nativeAt) / 1000 : 0));
  let recent = null;
  function clearRecent() {
    if (recent) resources.unpin(recent.entry);
    recent = null;
  }
  function rememberRecent(c) {
    const entry = c?.entry;
    if (!entry || entry.stream?.error || entry.size > 128 * 1024 * 1024
      || entry.stream && !entry.stream.done && !entry.stream.indexed) return;
    clearRecent(); recent = { entry, ref: ref(c) }; resources.pin(entry);
  }
  async function obtain(request, info) {
    const owner = S.current, epoch = S.epoch;
    try { return await resources.obtain(request, info); }
    catch (error) {
      if (error.message !== 'native-only-memory' || !recent) throw error;
      if (S.current !== owner || S.epoch !== epoch) throw new Error('cancelled');
      clearRecent(); resources.resetFailures();
      // Drop the unpinned old entry before retrying inside the same budget.
      resources.retain([request, ref(S.current), nextTrack(), ref(S.scheduled)]);
      return resources.obtain(request, info);
    }
  }
  const nativeCache = globalThis.GaplessNativeCache && new globalThis.GaplessNativeCache({ trace,
    storage: () => webpackRequire()(4).Storage, settings: () => state()?.setting,
    crypto: () => {
      const r = webpackRequire();
      return [139,257,671].map(id => r.c[id]?.exports).find(x => x?.algo?.MD5?.create);
    } });
  const localSource = new globalThis.GaplessMacLocalSource({
    fs: (method, args, signal) => nativeCache.nativeFs(method, args, signal),
    mount: (path, signal) => nativeCache.wait(betterncm.fs.mountFile(path), signal) });
  const normalizeSource = (info, row) => localSource.path(info) ? localSource.info(info, row) : Promise.resolve(info);
  const nativeSource = nativeCache && new globalThis.GaplessMacNativeSource({ bridge, cache: nativeCache, trace,
    valid: source => {
      const c = S.current;
      return !!(c?.owns && !c.transitioning && S.phase !== 'restoring' && allowed(c.info) && source._gpAccount === S.account
        && (String(source.songId) === c.id && source.md5 === (c.info?.md5 || c.entry?.hash)
          || String(source.songId) === nextTrack()?.id || nativeFill.allows(source)));
    },
    ensureGate: async () => {
      const c = S.current, epoch = S.epoch;
      if (!c?.owns || !allowed(c.info)) throw new Error('cancelled');
      if (S.nativeGate?.releasing) await S.nativeGate.releasing;
      if (!validRecovery(c, epoch) || S.phase === 'restoring') throw new Error('cancelled');
      if (!S.nativeGate) await acquireNativeGate(c, epoch, 'native-cache-source');
      await S.nativeGate.ready;
      if (!validRecovery(c, epoch) || S.phase === 'restoring' || !allowed(c.info)) throw new Error('cancelled');
      clearTimeout(S.nativeGate.watchdog);
    },
    refresh: async source => {
      const c = S.current, row = rows().find(item => rowId(item) === String(source.songId));
      if (!row || !c) throw new Error('native-only-cache-source-selection');
      const result = await nativeSourceResolver()({ track: row, requestSoundQuality: c.requestedLevel, isNextTrack: true });
      if (!result?.canPlay || !result.playInfo?.musicurl || result.playInfo.freeTrialInfo)
        throw new Error('native-only-cache-rights');
      return result.playInfo;
    },
    priority: source => String(source.songId) !== S.current?.id ? 30
      : S.current?.streamPreparation?.purpose === 'seek' ? 100 : 60 });
  const resources = new globalThis.GaplessStreamingResources({ trace, boundedIndexed: true,
    openLocalInput: (source, signal) => localSource.open(source, signal),
    readCache: nativeCache && (async (r, source, signal, full) => {
      if (!full && nativeSource && S.current?.owns && S.phase !== 'restoring' && allowed(S.current.info)
        && source.audioFormat === 'flac' && /^[a-f0-9]{32}$/i.test(source.md5 || ''))
        return nativeSource.open(r, source, signal);
      const cache = await nativeCache.read(r, source, signal, full);
      if (full && S.current?.owns && source.audioFormat === 'flac' && !cache)
        throw new Error('native-only-cache-index-unavailable');
      return cache;
    }), resolve: async (r, signal) => {
    if (!Object.values(QUALITY).includes(r.level)) throw new Error('native-only-quality');
    if (!r.row || rowId(r.row) !== r.id) throw new Error('native-only-source-selection');
    const result = await nativeSourceResolver()({ track: r.row, requestSoundQuality: r.level, isNextTrack: true });
    if (signal.aborted) throw new Error('cancelled');
    const info = result?.playInfo;
    if (result?.canPlay && localSource.path(info)) {
      const normalized = await localSource.info(info, r.row, signal);
      return { ...normalized, duration: normalized.songDuration / 1000, code: 200 };
    }
    if (!result?.canPlay || !info?.musicurl || info.freeTrialInfo) throw new Error('native-only-rights');
    return { ...info, url: info.musicurl, size: Number(info.fileSize),
      duration: Number(info.songDuration) / 1000, code: 200 };
  }, acceptRate: (r, rate) => {
    const c = S.current;
    return !!c && r.account === S.account && (rate >= 8000 && rate <= 192000);
  } });
  const streamControl = new globalThis.GaplessMacStreamControl(resources);
  const clock = new globalThis.GaplessStreamingClock({ resources, trace,
    onState: (value, failedTrack) => {
      if (failedTrack && failedTrack !== S.current) {
        if (S.scheduled === failedTrack) cancelScheduled();
        trace('candidate-output-cancelled', { reason: value });
        return;
      }
      if (S.current?.owns && S.current.entry && !S.current.loading && value !== 'running') void restoreNative(`context-${value}`);
    },
    onEnded: c => { if (S.current === c && c.owns) boundary(c); } });
  const fillSnapshot = () => ({ owner: S.current, entry: S.current?.entry, account: S.account,
    quality: S.current?.requestedLevel, position: S.current?.owns ? clock.position(S.current) : 0 });
  const nativeFill = new globalThis.GaplessNativeCacheFill({ cache: nativeCache, queue: nativeSource.queue,
    snapshot: fillSnapshot, trace, safe: snapshot => {
      const c = snapshot?.owner, entry = snapshot?.entry, p = snapshot?.position;
      return !!(c?.owns && c.playing && !c.loading && !c.transitioning && !c.streamPreparation && !S.claim
        && S.phase === 'owned' && allowed(c.info) && S.nativeGate && !S.nativeGate.releasing
        && !nativeSource.clearTimers.length && !nativeSource.fault && entry?.origin === 'native-source'
        && Array.isArray(entry.stream?.seekPoints)
        && globalThis.GaplessSeekRange.until(entry, Math.floor(p * entry.spec.rate))
          >= Math.min(entry.buffer.length, Math.ceil((p + 6) * entry.spec.rate))
        && (c.duration - p > 15 || !!S.scheduled?.entry));
    } });
  bridge.cacheClearRequested = async () => {
    clearRecent(); nativeFill.clear(); localSource.clear();
    streamControl.cancel(S.current, 'cache-clear'); cancelScheduled();
    const active = S.current?.owns ? S.current.entry : null;
    resources.retain(active ? [ref(S.current)] : []);
    resources.clearCachedData(active); nativeCache?.clear();
    trace('cache-cleared');
    await nativeSource?.beginClear();
  };
  const position = () => S.current?.owns ? clock.position(S.current) : nativePosition();
  const media = globalThis.GaplessMacMediaSession && new globalThis.GaplessMacMediaSession({ trace,
    seek: (id, value) => {
      reconcile(); const c = S.current;
      if (!c?.owns || c.id !== id) return;
      return seekOwned(c, value, `${id}|seek|system-${S.revision + 1}`).then(() => {
        if (S.current === c && c.owns) progress(c, true);
      });
    },
    cancelSeek: id => {
      const c = S.current;
      if (c?.id === id && c.streamPreparation?.purpose === 'seek') {
        S.revision++; streamControl.cancel(c, 'superseded');
      }
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
  function visualSnapshot() {
    const c = S.current;
    const active = S.enabled && c?.owns && !c.loading && !S.claim && S.phase === 'owned'
      && bridge.audioDataEnabled && !!bridge.registrations['audioplayer.onAudioData'] && !document.hidden;
    // A replaced node may still be waiting in the output pipeline. Do not
    // analyze its new Seek position before those samples reach the device.
    const ready = active && c.playing && c.node && clock.outputTime() >= c.start;
    return { active, playing: !!ready, id: c?.id, serial: c?.serial,
      revision: S.revision, generation: clock.generation, buffer: active ? c.entry?.buffer : null,
      position: active ? clock.outputPosition(c) : 0 };
  }
  const visual = new globalThis.GaplessVisualPCM({ rate: 48000, channels: 2, packetFrames: 400, trace,
    snapshot: visualSnapshot, emit: (bytes, pts) => {
      const encoded = new Array(bytes.length);
      for (let i = 0; i < bytes.length; i++) encoded[i] = hexByte[bytes[i]];
      bridge.emit('audioplayer.onAudioData', [{ data: encoded.join(''), pts }]);
    } });
  const visualRenderHooks = new Map();
  let lastVisualRender = null;
  function visualRenderPosition(fallback) {
    try {
      const s = visualSnapshot();
      if (!s.active) { lastVisualRender = null; return fallback; }
      const same = lastVisualRender?.id === s.id && lastVisualRender.serial === s.serial;
      if (S.current.playing && !s.playing) return same ? lastVisualRender.position : fallback;
      const position = s.position * 1000;
      lastVisualRender = { id: s.id, serial: s.serial, position };
      return position;
    } catch { return fallback; } // A display clock must never interrupt audio.
  }
  function prepareVisualClock() {
    // Keep the original 30 fps renderer and its animation parameters. Only its
    // time argument changes: the 150 ms UI heartbeat is not an audio clock.
    const sdk = webpackRequire().c[42]?.exports?.b;
    if (!sdk) return;
    for (const [name, index] of [['_AERenderMV', 1], ['_AEWebSetPlaybackPosition', 0]]) {
      const original = sdk[name], previous = visualRenderHooks.get(name);
      if (typeof original !== 'function' || original === previous?.wrapped) continue;
      const wrapped = function (...args) {
        args[index] = visualRenderPosition(args[index]);
        return original.apply(this, args);
      };
      sdk[name] = wrapped; visualRenderHooks.set(name, { sdk, original, wrapped });
    }
  }
  function checkLocalVersion(entry) {
    if (!entry?.source?.localKey) return true;
    if (entry.stream?.error) return false;
    if (performance.now() - (entry.localCheckedAt || -Infinity) < 1000) return true;
    if (!entry.localChecking) {
      entry.localChecking = true;
      void localSource.validate(entry.source).then(() => {
        entry.localCheckedAt = performance.now(); scheduleNext();
      }).catch(() => {
        entry.stream.error = 'local-file-changed';
        if (S.scheduled?.entry === entry) cancelScheduled();
        if (S.current?.owns && S.current.entry === entry) void restoreNative('local-file-changed');
      }).finally(() => { entry.localChecking = false; });
    }
    return false;
  }
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
    if (!row || !['track', 'localTrack', 'downloadTrack'].includes(row.resourceType)
      || list.filter(item => rowId(item) === rowId(row)).length !== 1) return null;
    const id = rowId(row), duration = localSource.duration(row) / 1000;
    return { id, level: c.requestedLevel, account: S.account, duration, row, queueVersion: S.queueVersion,
      occurrence: `${row.id}:${row.displayOrder}`, key: `${S.account}:${id}:${c.requestedLevel}:${row.id}:${row.displayOrder}:${row.randomOrder}` };
  }
  function cancelScheduled() { clock.stop(S.scheduled); S.scheduled = null; }
  function stopCurrent(reason = 'cancelled') {
    nativeFill.cancel();
    streamControl.cancel(S.current, reason, reason === 'pause');
    cancelScheduled(); clock.stop(S.current);
  }
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
    if (S.current !== c || !c.owns || c.endSent || c.pendingOwnedSeek?.revision === S.revision) return;
    const candidate = S.scheduled;
    c.endSent = true;
    if (candidate && candidate.clockGeneration === clock.generation && candidate.queueVersion === S.queueVersion) {
      rememberRecent(c);
      nativeFill.remember(c.entry, c.account, c.requestedLevel);
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
      nativeFill.clear();
      S.signature = signature; S.queueVersion++; cancelScheduled(); trace('queue-changed', { queueVersion: S.queueVersion });
      if (S.claim) void restoreNative('queue-during-claim');
    }
    if (S.account && account !== S.account) { nativeFill.clear(); S.epoch++; resources.resetFailures(); void restoreNative('account-changed'); }
    S.account = account;
    const c = S.current;
    if (c && !c.owns && !c.entry && !c.preparing && !c.blocked && allowed(c.info)) {
      c.account = account; void prepareCurrent(c);
    }
    const selection = JSON.stringify(s.setting?.quantity || null);
    const selectionChanged = S.selection && selection !== S.selection;
    S.selection = selection;
    if (recent && (recent.ref.account !== account || recent.ref.level !== c?.requestedLevel || selectionChanged)) clearRecent();
    if (c?.owns && (selectionChanged || !allowed(c.info) || c.account !== account)) {
      nativeFill.clear();
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
      if (msg.seq) {
        bridge.dispatch(msg.seq, args); bridge.emit('audioplayer.onLoad', args);
        releaseLoadPlayGuard(c, epoch);
      } else {
        // A saved snapshot has no pending SDK Load. Do not complete an
        // unrelated subscriber or consume the user's first manual Play.
        emitState(c, c.playing ? 1 : 2); progress(c, true);
      }
      c.needsLyrics = true; refreshLyrics(c);
    });
  }
  function releaseLoadPlayGuard(c, epoch) {
    const revision = S.revision;
    // The SDK's Load callback calls Play synchronously. This guard applies to
    // that automatic Play only, never to a later manual resume.
    setTimeout(() => {
      if (validRecovery(c, epoch) && S.revision === revision) {
        if (c.pauseAfterClaimRevision === revision) c.pauseAfterClaimRevision = null;
        c.nativeLoadPlayPending = false;
      }
    }, 0);
  }
  function answerNativeLoad(msg, c, code) {
    const epoch = S.epoch;
    queueMicrotask(() => {
      if (!validRecovery(c, epoch)) { bridge.dispatch(msg.seq, [c.id, { code: -1 }]); return; }
      const args = [c.id, { code, duration: c.duration }];
      if (!msg.seq) return;
      if (code === 0) c.nativeLoadPlayPending = true;
      bridge.dispatch(msg.seq, args); bridge.emit('audioplayer.onLoad', args);
      releaseLoadPlayGuard(c, epoch);
    });
  }
  function scheduleNext() {
    reconcile(); const c = S.current;
    if (!c?.owns || c.loading || !c.playing || S.claim || S.phase !== 'owned') return;
    if (c.pendingOwnedSeek?.revision === S.revision || c.streamPreparation?.purpose === 'seek') { cancelScheduled(); return; }
    const next = nextTrack();
    if (S.scheduled && (S.scheduled.selectionKey !== next?.key
      || S.scheduled.clockGeneration !== clock.generation
      || Math.abs(S.scheduled.start - c.end) > 1 / clock.ctx.sampleRate)) cancelScheduled();
    if (!next || S.scheduled) return;
    const entry = resources.lookup(next);
    if ((!entry?.hash && !entry?.source?.localKey) || entry.stream?.error) return;
    if (entry.source.localKey && !checkLocalVersion(entry)) return;
    resources.ensure?.(entry, 0);
    if (!streamControl.ready(entry, 0)) return;
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
    const next = c && !c.blocked
      && ['native', 'owned', 'warming', 'pausing', 'loading'].includes(S.phase) ? nextTrack() : null;
    resources.retain([S.current?.blocked && !S.current.owns ? null : ref(S.current), next, ref(S.scheduled), recent?.ref]);
    // Prepare a trusted next source while paused too. Scheduling/output remain
    // gated by playback intent; cancellation still checks epoch and queue.
    if (!S.enabled || !c?.entry || !next || ['restoring', 'warming', 'pausing'].includes(S.phase)
      || resources.lookup(next) || resources.jobs.has(resources.requestKey(next))) return;
    const epoch = S.epoch, queueVersion = S.queueVersion;
    obtain(next).then(() => {
      if (S.epoch === epoch && S.queueVersion === queueVersion) { void takeover(); scheduleNext(); }
    }).catch(error => {
      const key = resources.requestKey(next), failure = resources.failures.get(key);
      if (!failure?.logged && error.message !== 'cancelled') {
        trace('prefetch-fallback', { id: next.id, reason: error.message }); if (failure) failure.logged = true;
      }
    });
  }
  async function prepareLoadPosition(c, epoch) {
    for (;;) {
      const target = c.offset || 0;
      const valid = () => validRecovery(c, epoch) && allowed(c.info) && S.phase !== 'restoring';
      try {
        await streamControl.prepare(c, target, () => valid() && target === (c.offset || 0), { purpose: 'load' });
      } catch (error) {
        if (!error.cancelled || !valid() || (target === (c.offset || 0) && error.kind !== 'cache-clear')) throw error;
        continue;
      }
      if (!valid()) throw globalThis.GaplessMacStreamControl.failure('stale');
      if (target === (c.offset || 0)) return;
    }
  }
  function recordLoadOutput(c) {
    if (!Number.isFinite(c.loadAt)) return;
    const loadAt = c.loadAt; c.loadAt = null;
    try {
      trace('web-start', { id: c.id,
        loadToScheduledOutputMs: Math.round(clock.outputWallTime(c.start) - loadAt) });
    } catch { trace('web-start-timing-unavailable', { id: c.id }); }
  }
  async function loadOwned(msg, c) {
    if (c.webLoadRunning) return;
    c.webLoadRunning = true;
    const epoch = S.epoch, loadAt = performance.now(), timings = {};
    c.loadAt = c.pauseAfterClaimRevision != null || msg.resumeExisting && !c.playing ? null : loadAt;
    try {
      if (msg.resumeExisting) {
        const [count] = await bridge.raw('audioplayer.getPlayedTime', [{ playId: c.id }]);
        if (!validRecovery(c, epoch)) throw new Error('cancelled');
        if (Number(count?.result) === 1) c.heard = Number(count.playedAudioTime) + (c.nativeHeardBase || 0);
      }
      // A native fallback may evict an unpinned entry while c still references
      // it. Reacquire through the resource owner so budget/pins stay accounted.
      const normalized = await normalizeSource(c.info, c.row);
      if (!validRecovery(c, epoch)) throw new Error('cancelled');
      const memoryHit = !!resources.lookup(ref(c), normalized);
      let stageAt = performance.now();
      c.entry = await obtain(ref(c), normalized);
      timings.sourceMs = Math.round(performance.now() - stageAt);
      if (c.entry.source.localKey) await localSource.validate(c.entry.source);
      else if (!c.entry.hash || c.entry.hash !== Resources.fingerprint(c.info) || c.entry.level !== c.info.level)
        throw new Error('native-only-source-identity');
      if (!validRecovery(c, epoch) || !allowed(c.info)) throw new Error('cancelled');
      c.duration = c.entry.duration; c.level = c.entry.level;
      stageAt = performance.now();
      await prepareLoadPosition(c, epoch);
      if (c.entry.source.localKey) await localSource.validate(c.entry.source);
      if (!validRecovery(c, epoch) || !allowed(c.info)) throw new Error('cancelled');
      timings.bufferMs = Math.round(performance.now() - stageAt); stageAt = performance.now();
      await clock.open(c.entry);
      timings.contextMs = Math.round(performance.now() - stageAt); stageAt = performance.now();
      if (!validRecovery(c, epoch) || !allowed(c.info)) throw new Error('cancelled');
      // Direct Web Load/resume also parks the native output. Otherwise an
      // unwrapped native system command could revive the old audio instance.
      if (S.nativeGate?.releasing) await S.nativeGate.releasing;
      if (!validRecovery(c, epoch) || !allowed(c.info) || S.phase === 'restoring') throw new Error('cancelled');
      if (!S.nativeGate) await acquireNativeGate(c, epoch, 'continuous-web');
      else { S.nativeGate.c = c; S.nativeGate.epoch = epoch; await S.nativeGate.ready; }
      if (!validRecovery(c, epoch) || !allowed(c.info) || S.phase === 'restoring') throw new Error('cancelled');
      clearTimeout(S.nativeGate?.watchdog);
      timings.gateMs = Math.round(performance.now() - stageAt);
      // A Seek can arrive while the context/gain handshake is awaiting native.
      // Recheck the latest requested offset before committing any Web output.
      await prepareLoadPosition(c, epoch);
      if (c.entry.source.localKey) await localSource.validate(c.entry.source);
      if (!validRecovery(c, epoch) || !allowed(c.info) || S.phase === 'restoring') throw new Error('cancelled');
      clock.setOutput(true); c.loading = false; c.transitioning = false; c.blocked = false; S.phase = 'owned';
      if (c.playing) {
        clock.start(c, clock.ctx.currentTime + 0.01, c.offset); recordLoadOutput(c);
      }
      if (msg.resumeExisting) {
        ack(msg); emitState(c, c.playing ? 1 : 2, S.token); progress(c, true);
      } else answerLoad(msg, c);
      media?.sync(true); prefetch(); scheduleNext();
      trace('web-loaded', { id: c.id, origin: c.entry.origin, rate: c.entry.spec.rate,
        memoryHit, ...timings, loadMs: Math.round(performance.now() - loadAt) });
    } catch (error) {
      if (!validRecovery(c, epoch)) { bridge.dispatch(msg.seq, [c.id, { code: -1 }]); return; }
      if (error.message === 'native-only-context-awaiting-gesture' && allowed(c.info)) {
        // A cold autoplay request must not sound natively while Web waits for
        // user activation. Keep the original Load pending and resume on input.
        c.pendingWebLoad = msg; c.awaitingGesture = true;
        trace('web-start-awaiting-gesture', { id: c.id }); return;
      }
      c.loading = false; c.playing = c.loadIntent;
      if (error.message.startsWith('native-only-cache-')) c.restoreSelection = true;
      trace('web-load-fallback', { id: c.id, reason: error.message });
      // Reuse the exact authorized Native Load, never substitute a lower quality.
      await restoreNative(`web-load-${error.message}`);
      if (validRecovery(c, epoch)) {
        if (msg.resumeExisting) ack(msg);
        else answerNativeLoad(msg, c, c.recoverySucceeded ? 0 : -1);
      }
    } finally { c.webLoadRunning = false; }
  }
  function settlePendingWebLoad(c, code = -1, nativeResult = false) {
    const msg = c?.pendingWebLoad; if (!msg) return;
    c.pendingWebLoad = null; c.awaitingGesture = false;
    if (msg.resumeExisting) ack(msg);
    else if (nativeResult) answerNativeLoad(msg, c, code);
    else bridge.dispatch(msg.seq, [c.id, { code }]);
  }
  async function prepareCurrent(c) {
    if (c.preparing || !S.enabled || c.blocked || !allowed(c.info)) return; c.preparing = true;
    const epoch = S.epoch;
    try {
      const normalized = await normalizeSource(c.info, c.row);
      if (!validRecovery(c, epoch)) return;
      const entry = await obtain(ref(c), normalized);
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
      await streamControl.prepare(c, nativePosition(), valid, { purpose: 'takeover', ahead: 3 });
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
      if (validRecovery(gate.c, gate.epoch) && gate.c.owns) void restoreNative('native-gate-timeout');
      else void releaseNativeGate().catch(error => trace('native-volume-restore-error', { reason: error.message }));
    }, 3000);
    gate.ready = bridge.raw('audioplayer.setVolume', ['', '', 0]);
    await gate.ready;
  }
  async function restoreNative(reason, playIntent, seekTarget) {
    clearRecent(); nativeFill.clear();
    reconcile(); const c = S.current;
    if (!c?.owns) return S.recovering;
    if (S.phase === 'restoring') return S.recovering;
    const pending = c.streamPreparation?.purpose === 'seek' ? c.streamPreparation.target : undefined;
    const requested = seekTarget ?? pending
      ?? (c.pendingOwnedSeek?.revision === S.revision ? c.pendingOwnedSeek.target : undefined);
    const epoch = S.epoch, target = Number.isFinite(requested)
      ? Math.max(0, Math.min(c.duration - 0.001, requested)) : clock.position(c);
    let desired = playIntent ?? c.playing;
    c.recoveryPosition = target; c.recoveryPlaying = desired; c.recoveryHeard = clock.heard(c);
    c.recoverySucceeded = false; c.blocked = true; c.loading = false; S.claim = false;
    S.phase = 'restoring'; stopCurrent(); visual.stop(); trace('restore-start', { id: c.id, reason, position: target });
    const run = async () => {
      try {
        await nativeSource?.quiesce();
        if (!validRecovery(c, epoch)) return;
        await releaseNativeGate();
        if (!validRecovery(c, epoch)) return;
        // Only the SDK queue-selection workflow installs an onLoad auto-play
        // callback. A raw load does not; its first Play may be real user intent.
        // Direct startup restoration may precede the SDK's first Load, which
        // is also when it registers onLoad. Use its original selection flow
        // to establish that callback before waiting for native completion.
        const needsSelection = !c.info || c.restoreSelection || !bridge.registrations['audioplayer.onLoad'];
        c.recoverySelecting = !!needsSelection;
        // Native local Load may notify again after the reconstruction RPC has
        // settled. Those replies still belong to recovery, not a new SDK Play.
        c.suppressRecoveryLoad = !needsSelection;
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
        if (validRecovery(c, epoch)) {
          resources.retain([ref(c)]);
          if (!c.owns) await clock.close();
          if (validRecovery(c, epoch)) settlePendingWebLoad(c, c.recoverySucceeded ? 0 : -1, true);
        }
      }
    };
    S.recovering = run(); await S.recovering;
    if (validRecovery(c, epoch)) S.recovering = null;
  }
  bridge.shouldSuppressNative = (command, args) => {
    if (nativeSource?.observe(command, args)) return true;
    const c = S.current;
    if (command === 'audioplayer.onAudioData' && c?.owns) return true;
    if (command === 'audioplayer.onVolume' && (S.nativeGate || c?.owns)) return true;
    if (command === 'audioplayer.onLoad' && String(args?.[0]) === c?.id && c.suppressRecoveryLoad) return true;
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
    if (command === 'storage.onclearcache') { nativeSource?.finishClear(); nativeCache?.clear(); return; }
    if (nativeSource?.observe(command, args)) return;
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
  async function seekOwned(c, value, token) {
    if (!Number.isFinite(Number(value))) throw new Error('invalid-seek');
    const revision = ++S.revision, epoch = S.epoch;
    const offset = Math.max(0, Math.min(c.duration - 0.001, Number(value)));
    const request = c.pendingOwnedSeek = { revision, target: offset, playing: c.playing };
    try {
      nativeFill.cancel(); nativeFill.retry(c.entry); cancelScheduled(); S.token = token;
      if (c.pauseAfterClaimRevision != null && c.loadIntent === false) c.pauseAfterClaimRevision = revision;
      if (c.loading) c.offset = offset;
      else {
        const valid = () => S.current === c && c.owns && S.enabled && S.phase !== 'restoring'
          && S.epoch === epoch && S.revision === revision;
        try {
          if (c.entry?.source.localKey) await localSource.validate(c.entry.source);
          if (!valid()) throw globalThis.GaplessMacStreamControl.failure('stale');
          await streamControl.prepare(c, offset, valid);
          if (!valid()) throw globalThis.GaplessMacStreamControl.failure('stale');
        } catch (error) {
          if (error.cancelled || !valid()) throw error;
          await restoreNative('seek-buffer-unavailable', request.playing, offset);
          if (!validRecovery(c, epoch) || !c.recoverySucceeded) throw error;
          return offset;
        }
        // An old sounding node may end while target data is being prepared.
        // Keep the Seek's transport intent, rather than skipping or pausing.
        cancelScheduled();
        if (request.playing && !c.node) clock.start(c, clock.ctx.currentTime + 0.01, offset);
        else clock.seek(c, offset);
      }
      c.endSent = false; c.missed = false;
      trace('seek', { id: c.id, position: offset });
      return offset;
    } finally {
      if (c.pendingOwnedSeek === request) { c.pendingOwnedSeek = null; scheduleNext(); }
    }
  }
  function completeSeek(msg, c, token, offset, code = 0, context) {
    seekReplies.push({ msg, c, token, offset, code, epoch: context?.epoch ?? S.epoch, revision: context?.revision });
    if (seekReplies.length === 1) replyNextSeek();
  }
  function replyNextSeek() {
    const request = seekReplies[0]; if (!request) return;
    ack(request.msg);
    // Serialize acknowledgements: this SDK subscribes after RPC and does not
    // filter Seek notifications by token. Every accepted request must complete.
    setTimeout(() => {
      try {
        const { c, token, offset, code, epoch, revision } = request;
        const valid = S.current === c && S.epoch === epoch;
        const latest = valid && (revision === undefined || revision === S.revision);
        bridge.emit('audioplayer.onSeek', [c.id, token, latest ? code : -1, valid && !latest ? position() : offset]);
        const current = S.current;
        if (latest && current?.owns && !S.claim) {
          progress(current, true);
          // BetterNCM infers playing from large progress jumps. A paused Seek is
          // still paused; publish its real state once, without paused heartbeats.
          if (!current.playing) emitState(current, 2);
        } else if (valid && !current?.owns && S.phase !== 'restoring' && !c.nativeSeekTokens?.size) {
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
      if (c?.id === id) c.suppressRecoveryLoad = false;
      trace('native-load', { id, phase: S.phase, current: c?.id, epoch: S.epoch });
      if (S.phase === 'restoring' && c?.id === id) { c.info = info; return false; }
      const localClaim = c?.entry?.source.localKey && localSource.matches(c.entry.source, info);
      if (S.claim && c?.id === id && allowed(info) && c.requestedLevel === level && clock.matches(c.entry)
        && (localClaim || c.level === info?.level && c.entry?.hash
          && Resources.fingerprint({ ...info, url: info?.musicurl }) === c.entry.hash)) {
        if (localClaim) {
          const epoch = S.epoch; c.info = info;
          void normalizeSource(info, c.row).then(normalized => {
            if (!validRecovery(c, epoch) || !S.claim) {
              bridge.dispatch(msg.seq, [id, { code: -1 }]); return;
            }
            if (Resources.localIdentity(normalized) !== c.entry.identity) throw new Error('native-only-local-changed');
            S.claim = false; S.phase = 'owned';
            if (!c.playing) c.pauseAfterClaimRevision = S.revision;
            trace('claimed', { id, position: clock.position(c), claimDelayMs: performance.now() - c.claimAt, local: true });
            answerLoad(msg, c); prefetch(); scheduleNext();
          }).catch(() => {
            if (validRecovery(c, epoch)) void restoreNative('local-claim-source-changed').then(() => {
              if (validRecovery(c, epoch)) answerNativeLoad(msg, c, c.recoverySucceeded ? 0 : -1);
              else bridge.dispatch(msg.seq, [id, { code: -1 }]);
            });
            else bridge.dispatch(msg.seq, [id, { code: -1 }]);
          });
          return true;
        }
        c.info = info; S.claim = false; S.phase = 'owned';
        if (!c.playing) c.pauseAfterClaimRevision = S.revision;
        trace('claimed', { id, position: clock.position(c), claimDelayMs: performance.now() - c.claimAt });
        answerLoad(msg, c);
        prefetch(); scheduleNext();
        return true;
      }
      if (S.claim) trace('claim-rejected', { expected: c?.id, received: id, reason: 'native-source-or-queue-changed' });
      const snapshot = c?.restoreSnapshot && c.id === id ? {
        position: position(), heard: clock.heard(c), playing: !!c.playing,
      } : null;
      const wasPlaying = c?.owns ? !!(c.playing || c.transitioning && c.loadIntent) : S.nativePlaying;
      if (c?.entry && c.id !== id) {
        nativeFill.remember(c.entry, c.account, c.requestedLevel);
        if (allowed(info)) rememberRecent(c); else clearRecent();
      }
      settlePendingWebLoad(c);
      nativeSource?.cancel();
      S.epoch++; S.revision++; stopCurrent(); S.claim = false; S.phase = 'native';
      S.nativePlaying = false; S.nativePosition = 0; S.nativeAt = performance.now();
      S.current = c = { id, info, requestedLevel: level, account: S.account, duration: Number(info?.songDuration) / 1000,
        row: rows().filter(item => rowId(item) === id).length === 1 ? rows().find(item => rowId(item) === id) : null,
        serial: ++S.serial, offset: snapshot?.position || 0, heard: snapshot?.heard || 0, owns: false, playing: false,
        loadRevision: S.revision, blocked: !!msg.startupNativeFallback };
      // Adopt a matching cached source synchronously. Waiting for native play
      // before the async preparation would let a store update evict both warm
      // buffers between Load and play, especially when selecting the same track.
      const cached = allowed(info) && !localSource.path(info) && resources.lookup(ref(c), info);
      if (cached) { c.entry = cached; c.duration = cached.duration; c.level = cached.level; }
      resources.resetFailures(); resources.retain([ref(c), nextTrack(), recent?.ref]);
      if (allowed(info) && !msg.observedNative) {
        c.owns = true; c.loading = true; c.playing = !!snapshot?.playing;
        c.loadIntent = snapshot ? snapshot.playing : wasPlaying; S.phase = 'loading';
        if (snapshot && !snapshot.playing && performance.now() - S.gestureAt >= 1500)
          c.pauseAfterClaimRevision = S.revision;
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
    if (!c?.owns && c?.nativeLoadPlayPending && msg.command === 'audioplayer.play'
      && (!p[0] || String(p[0]) === c.id)) {
      c.nativeLoadPlayPending = false;
      if (S.nativePlaying || c.pauseAfterClaimRevision === S.revision || !S.enabled && c.suppressPausedNativeProgress) {
        // Recovery already restored transport. Completing the SDK Load must
        // not send a second native Play and retrigger its playback envelope.
        c.pauseAfterClaimRevision = null; ack(msg); emitState(c, S.nativePlaying ? 1 : 2, p[1] || c.id); return true;
      }
      return false;
    }
    if (!c?.owns && !c?.blocked && c?.info && S.phase === 'native' && !S.nativePlaying && !S.starting
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
    if (msg.command === 'audioplayer.setPlaybackRate' && S.enabled && S.phase !== 'restoring') {
      // Gapless output uses the source clock at 1x; a native-only rate request
      // must not hand playback back or alter the parked backend.
      ack(msg); trace('native-audio-setting-bypassed', { setting: 'speed', effectiveRate: 1 }); return true;
    }
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
      if (!c.loading && c.pauseAfterClaimRevision === S.revision) {
        c.pauseAfterClaimRevision = null; ack(msg);
        const epoch = S.epoch, token = p[1] || c.id;
        setTimeout(() => { if (validRecovery(c, epoch) && !c.playing) emitState(c, 2, token); }, 0);
        return true;
      }
      c.pauseAfterClaimRevision = null;
      c.restoreSnapshot = false;
      S.revision++; const token = p[1] || c.id; S.token = token;
      if (c.loading) { c.playing = true; c.loadIntent = true; ack(msg); return true; }
      c.transitioning = false;
      if (clock.ctx?.state !== 'running') {
        // The parked native instance is not ready to receive this Play. Restore
        // in order and carry the requested intent through that transaction.
        ack(msg); void restoreNative('play-context-unavailable', true); return true;
      }
      if (!c.playing && (c.entry?.source.localKey || !streamControl.ready(c.entry, c.offset))) {
        const revision = S.revision, epoch = S.epoch; c.loadIntent = true;
        const valid = () => S.current === c && c.owns && S.enabled && S.phase !== 'restoring'
          && S.revision === revision && S.epoch === epoch;
        void (async () => {
          if (c.entry?.source.localKey) await localSource.validate(c.entry.source);
          if (!valid()) throw globalThis.GaplessMacStreamControl.failure('stale');
          await streamControl.prepare(c, c.offset, valid, { purpose: 'resume' });
        })().then(() => {
          if (!valid() || !c.loadIntent) throw globalThis.GaplessMacStreamControl.failure('stale');
          cancelScheduled(); clock.start(c, clock.ctx.currentTime + 0.01, c.offset); recordLoadOutput(c);
          emitState(c, 1, token); prefetch(); scheduleNext();
        }).catch(error => {
          if (!error.cancelled && valid())
            void restoreNative('resume-buffer-unavailable', true);
        });
        ack(msg); return true;
      }
      if (!c.playing) {
        cancelScheduled(); clock.start(c, clock.ctx.currentTime + 0.01, c.offset);
        recordLoadOutput(c);
      }
      emitState(c, 1, token); ack(msg); trace('play', { id: c.id }); prefetch(); scheduleNext(); return true;
    }
    if (msg.command === 'audioplayer.pause') {
      c.restoreSnapshot = false; c.loadAt = null;
      S.revision++; S.token = p[1] || c.id; stopCurrent('pause'); progress(c, true); emitState(c, 2, S.token); ack(msg);
      c.loadIntent = false; c.transitioning = false; if (c.loading) c.pauseAfterClaimRevision = S.revision;
      trace('pause', { id: c.id, position: clock.position(c) }); return true;
    }
    if (msg.command === 'audioplayer.seek') {
      if (!Number.isFinite(Number(p[2]))) return false;
      const token = p[1] || c.id;
      c.restoreSnapshot = false;
      const context = { epoch: S.epoch, revision: S.revision + 1 };
      void seekOwned(c, p[2], token).then(offset => completeSeek(msg, c, token, offset, 0, context))
        .catch(() => completeSeek(msg, c, token, S.current === c ? position() : Number(p[2]), -1, context));
      return true;
    }
    if (/^audioplayer\.(stop|unload)$/.test(msg.command)) {
      nativeFill.remember(c.entry, c.account, c.requestedLevel);
      const intent = c.playing || c.loadIntent;
      c.restoreSnapshot = false;
      settlePendingWebLoad(c);
      c.entry?.stream?.ensureController?.abort();
      nativeSource?.cancel();
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
      bridge.flushStartup(); consumeRecovery();
      if (S.claim && performance.now() - S.current.claimAt > 3000) void restoreNative('unclaimed-next');
      if (S.current?.owns && !S.current.transitioning && S.current.entry?.stream?.error) { void restoreNative('stream-source-failed'); return; }
      if (S.scheduled?.entry?.stream?.error) cancelScheduled();
      if (S.current?.owns && !S.claim) progress(S.current);
      void takeover(); scheduleNext(); prefetch();
      checkLocalVersion(S.current?.entry); checkLocalVersion(S.scheduled?.entry); nativeFill.maybe();
      media?.sync();
      try { prepareVisualClock(); visual.sync(); }
      catch (error) { visual.stop(); trace('visual-clock-error', { reason: error.message }); }
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
    const c = S.current;
    if (c?.owns && c.loading && c.pendingWebLoad && !c.webLoadRunning && S.phase === 'loading' && allowed(c.info)) {
      const msg = c.pendingWebLoad; c.pendingWebLoad = null; c.awaitingGesture = false;
      void loadOwned(msg, c); return;
    }
    if (S.current) S.current.awaitingGesture = false;
    if (clock.ctx?.state === 'suspended') void clock.ctx.resume().then(() => takeover()).catch(() => {});
    if (!S.current?.owns) void takeover();
  };
  window.addEventListener('pointerdown', gesture, true); window.addEventListener('keydown', gesture, true);
  async function disable() {
    clearRecent(); nativeFill.clear(); localSource.clear();
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
    persistRecovery(); clearRecent(); clearInterval(timer); S.unsubscribe?.(); resources.stop();
    nativeFill.clear(); nativeSource?.cancel();
    media?.release(); visual.stop();
    for (const [name, hook] of visualRenderHooks) if (hook.sdk[name] === hook.wrapped) hook.sdk[name] = hook.original;
    // The native gain is never left at the rehearsal value across navigation.
    if (S.nativeGate) bridge.callNative('audioplayer.setVolume', ['', '', clock.volume]);
    // Recovery is driven by the next page, rather than a multi-stage asynchronous unload callback.
    stopCurrent(); void clock.close();
  });
  function consumeRecovery() {
    if (S.recoveryConsumed || !S.compatible) return;
    if (bridge.startup.phase === 'waiting' && bridge.startup.held > bridge.startup.released) return;
    S.recoveryConsumed = true;
    try {
    const saved = JSON.parse(sessionStorage.getItem(recoveryKey) || 'null'); sessionStorage.removeItem(recoveryKey);
    if (saved && Date.now() - saved.at < 30000 && saved.account === S.account
      && (!S.current || S.current.id === saved.id)) {
      const info = saved.info || bridge.loads.get(saved.id);
      if (info && saved.row) {
        if (!rows().length) S.store.dispatch({ type: 'playingList/restoreCurPlayingList' });
        const current = S.current;
        if (current?.owns && current.loading && S.phase === 'loading') {
          // An intercepted fresh Load is authoritative for the source. Only
          // restore intent when no newer user control superseded this Load.
          if (current.loadRevision === S.revision) {
            current.offset = Math.max(0, Math.min(current.duration - 0.001, saved.position));
            current.heard = saved.heard || 0; current.playing = !!saved.playing; current.loadIntent = !!saved.playing;
            if (!saved.playing) current.pauseAfterClaimRevision = S.revision;
            trace('startup-web-intent', { id: current.id, position: current.offset, playing: current.playing });
          }
          return;
        }
        stopCurrent(); S.epoch++;
        S.current = { id: saved.id, info, requestedLevel: quality(info), account: S.account,
          duration: Number(info.songDuration) / 1000, serial: ++S.serial, offset: saved.position,
          heard: saved.heard || 0, playing: !!saved.playing, loadIntent: !!saved.playing,
          owns: true, loading: true, row: saved.row, restoreSnapshot: true };
        if (allowed(info) && !S.nativePlaying) {
          S.phase = 'loading';
          trace('startup-web-restore', { id: saved.id, position: saved.position, playing: !!saved.playing });
          void loadOwned({ seq: null, command: 'audioplayer.load', params: [saved.id, info] }, S.current);
        } else {
          S.current.restoreSelection = true; S.current.loading = false;
          void restoreNative('page-reload');
        }
      }
    }
    } catch (error) { trace('reload-recovery-error', { reason: error.message }); }
  }
  window.gaplessMac = {
    version: '0.3.7', status: () => {
      reconcile(); const c = S.current;
      return { enabled: S.enabled, compatible: S.compatible, id: c?.id, phase: S.phase,
        ownsPlayback: !!c?.owns, playing: c?.owns ? !!c.playing : S.nativePlaying,
        playbackMode: 'continuous-web', loading: !!c?.loading, nativeOutputGated: !!S.nativeGate,
        startup: { ...bridge.startup }, awaitingGesture: !!c?.awaitingGesture,
        nativeTransport: { ...bridge.nativeTransport },
        seekPending: !!c?.nativeSeekTokens?.size, seekSettling: performance.now() < (c?.seekStableAt || 0),
        position: position(), duration: c?.duration, requestedLevel: c?.requestedLevel, actualLevel: c?.level || c?.info?.level,
        sourceRate: c?.entry?.spec.rate, decodedRate: c?.entry?.buffer.sampleRate, ...clock.status(),
        sourceBits: c?.entry?.spec.bits, sourceChannels: c?.entry?.spec.channels,
        nativeAudioPolicy: S.enabled ? 'gapless-priority' : 'native',
        suppressedNativeAudioSettings: c?.owns && S.enabled ? nativeAudioPreferences(state()) : [],
        resourceOrigin: c?.entry?.origin || null,
        next: nextTrack()?.id, scheduled: S.scheduled?.id, claiming: S.claim,
        memory: resources.status(), mode: state()?.playing?.playingMode, nativeAllowed: allowed(c?.info),
        nativeCacheSource: nativeSource?.status(),
        nativeCacheFill: nativeFill.status(), recentId: recent?.entry.id, localSource: !!c?.entry?.source.localKey,
        queueVersion: S.queueVersion, loadEpoch: S.epoch, controlRevision: S.revision,
        systemMedia: media?.status(), visualization: { ...visual.status(), renderClock: visualRenderHooks.size ? 'output' : 'pending',
          renderClockHooks: [...visualRenderHooks.keys()] } };
    }, trace: () => [...log], disable, restoreNative,
  };
  bridge.readyForStartup = () => !!(S.enabled && S.compatible && S.store && !S.recovering);
  bridge.flushStartup(); consumeRecovery();
  trace('ready', { compatible: S.compatible, appVersion: window.APP_CONF?.appver });
});
