/* MIT. Coordinate native playback with the shared resources and clock. */
plugin.onLoad(async () => {
  'use strict';
  const bridge = window.gaplessWindowsBridge;
  if (!bridge?.hooked || window.APP_CONF?.appver !== '3.1.43.205627') return;
  // Host settings are persisted independently of Chromium's deferred localStorage flush.
  const enabledKey = 'gapless-player-windows.enabled.v1';
  let modeEnabled = false, savingConfig = false, configQueue = Promise.resolve();
  try {
    let timeout;
    const saved = await Promise.race([
      betterncm.app.readConfig(enabledKey, 'unset'),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('config-timeout')), 2000); }),
    ]).finally(() => clearTimeout(timeout));
    modeEnabled = saved === 'true' || (saved === 'unset' && plugin.getConfig('enabled', true) === true);
    plugin.setConfig('enabled', modeEnabled);
  } catch { modeEnabled = false; }
  bridge.startupEnabled = modeEnabled;
  if (!modeEnabled) bridge.flushStartup?.(true);

  const events = [];
  let flush;
  function trace(event, detail = {}) {
    events.push({ at: Math.round(performance.now()), wallMs: Date.now(), event, ...detail });
    if (events.length > 180) events.shift();
    const health = /^(loaded|native-settings|web-load-fallback|stream-output-fallback|restore|restored|prepare-fallback|claim-timeout|boundary|claimed|scheduled|stream-fully-scheduled|stream-seek-wait|stream-seek-ready|stream-seek-cancel|cache-cleared|native-preload-suppressed|native-cache-clear-result)$/.test(event);
    if (!gaplessWindowsBuild.diagnostics && !gaplessWindowsBuild.probe && !health) return;
    if (flush) return;
    flush = setTimeout(() => {
      flush = null;
      const safe = events.slice(-80).map(({ at, wallMs, event, id, from, to, reason, mode, enabled,
        rate, sourceRate, loadMs, leadSeconds, scheduledGapFrames, delayMs, blockers, memoryHit, waitMs, target, position, decodedSeconds, retainedPlaybackBytes, success, outputWallMs, pcmBytes, pcmCapacity }) => ({
        at, wallMs, event, id, from, to, mode, enabled, rate, sourceRate, loadMs, leadSeconds,
        scheduledGapFrames, delayMs, blockers, memoryHit, waitMs, target, position, decodedSeconds, retainedPlaybackBytes, success, outputWallMs, pcmBytes, pcmCapacity,
        reason: reason ? (/^[a-z0-9:-]+$/.test(reason) ? reason : 'unavailable') : undefined,
      }));
      void betterncm.fs.writeFile('C:\\betterncm\\gapless-windows.log',
        new Blob([JSON.stringify(safe, null, 2)])).catch(() => {});
    }, 200);
  }
  bridge.report = error => trace('bridge-error', { kind: error.name });
  trace('loaded', { version: gaplessWindowsBuild.version, client: window.APP_CONF.appver,
    probe: gaplessWindowsBuild.probe, nativeSource: gaplessWindowsBuild.nativeSource });
  if (gaplessWindowsBuild.probe) { probeNative(bridge, trace); return; }

  function installPlayer() {
    const source = WindowsSource;
    let native;
    try { native = source.connect(); } catch (error) { bridge.report(error); }
    if (!native) { trace('selector-unavailable'); return; }

    trace('selector-connected');
    // Temporary mode is a separate evaluation package until Windows output
    // alignment and system controls have independent device evidence.
    const temporaryBridge = !!gaplessWindowsBuild.temporaryBridge;
    const bridgeWindow = new globalThis.GaplessBridgeWindow();
    const enabled = () => modeEnabled;
    const seekReplies = [];
    let current, selected, claim, switchIn, restoring, handback, nativeGate;
    const gateKey = "gapless-windows-native-gain-v1";
    let revision = 0, serial = 0, customOutput = bridge.customOutput;
    let reportedSettings;
    const getSnapshot = () => source.snapshot(native, current, enabled());
    const makeRef = (info, snap) => ({
      id: source.trackId(info), account: snap.account, level: snap.quality,
      duration: Number(info.songDuration) / 1000,
    });
    const sameEnvironment = (a, b) => b?.capable && !customOutput && a?.queue === b.queue
      && a?.mode === b.mode && a?.quality === b.quality && a?.account === b.account;
    const nativeCache = new globalThis.WindowsNativeCache({ settings: () => native.read().setting, trace });
    const nativeSourceMode = !!gaplessWindowsBuild.nativeSource;
    let cacheClearing = false;
    let pendingCacheClears = 0;
    const sourceLeaseValid = () => !cacheClearing && enabled() && current?.owns && !!nativeGate && !nativeGate.releasing && !restoring && !handback;
    async function awaitCacheReady(signal) {
      const deadline = performance.now() + 4000;
      while (cacheClearing) {
        if (signal.aborted) throw new Error('cancelled');
        if (performance.now() >= deadline) throw new Error('native-only-cache-clear-pending');
        await new Promise(resolve => setTimeout(resolve, 30));
      }
    }
    const cacheSession = nativeSourceMode ? new globalThis.WindowsNativeCacheSession({ bridge, valid: sourceLeaseValid,
      snapshot: (info, signal) => nativeCache.snapshotSource(info, signal), trace }) : null;
    const cacheQueue = cacheSession ? new globalThis.WindowsNativeCacheQueue(cacheSession) : null;
    const nativeBytes = cacheQueue ? new globalThis.WindowsNativeByteSource({ cache: nativeCache, queue: cacheQueue,
      valid: sourceLeaseValid, awaitReady: awaitCacheReady }) : null;
    let fillJob = null, fillAfter = 0, preferRetiredFill = true;
    // Metadata only: never retain an old AudioBuffer/PCM entry for disk fill.
    const retiredFills = [];
    function clearRetiredFills() { cancelFill(); retiredFills.length = 0; }
    function rememberFill(c) {
      const entry = c?.entry, points = entry?.stream?.seekPoints;
      if (!nativeSourceMode || c?.cacheComplete || entry?.origin !== 'native-source'
        || !Array.isArray(points) || !points.length || points.length > 65536 || !c.environment) return;
      const key = source.trackId(c.info) + ':' + globalThis.GaplessAudioResources.fingerprint(entry.source);
      const previous = retiredFills.findIndex(item => item.key === key);
      if (previous >= 0) retiredFills.splice(previous, 1);
      retiredFills.push({ key, info: { songId: source.trackId(c.info) },
        source: { ...entry.source }, points: points.map(p => ({ sample: p.sample, offset: p.offset })),
        rate: entry.spec.rate, account: c.environment.account, quality: c.environment.quality,
        generation: nativeCache.generation, expires: performance.now() + 10 * 60 * 1000,
        cacheFillStalls: c.cacheFillStalls || 0, cacheFillRetryAt: c.cacheFillRetryAt || 0 });
      while (retiredFills.length > 2) retiredFills.shift();
    }
    function cancelFill() { fillJob?.controller.abort(); }
    function resetFillRetry(c) {
      if (c) { c.cacheFillStalls = 0; c.cacheFillRetryAt = 0; }
    }
    function deferFill(c) {
      c.cacheFillStalls = Math.min(6, (c.cacheFillStalls || 0) + 1);
      c.cacheFillRetryAt = performance.now() + Math.min(30000, 1000 * 2 ** (c.cacheFillStalls - 1));
      trace('native-cache-fill-wait', { attempts: c.cacheFillStalls, suspended: c.cacheFillStalls >= 6 });
    }
    function maybeFill(c) {
      if (!cacheQueue) return;
      const position = clock.position(c), entry = c.entry;
      const safe = sourceLeaseValid() && c.playing && !c.loading && !c.pendingStreamSeek && !c.claimed
        && entry?.origin === 'native-source' && Array.isArray(entry.stream?.seekPoints)
        && globalThis.GaplessSeekRange.until(entry, Math.floor(position * entry.spec.rate))
          >= Math.min(entry.buffer.length, Math.ceil((position + 6) * entry.spec.rate))
        && (c.duration - position > 15 || !!selected?.entry);
      if (!safe) { cancelFill(); return; }
      for (let i = retiredFills.length - 1; i >= 0; i--) {
        const item = retiredFills[i];
        if (item.cacheComplete || item.generation !== nativeCache.generation || item.expires < performance.now()
          || item.account !== c.environment?.account || item.quality !== c.environment?.quality
          || (item.source.songId === entry.source.songId
            && globalThis.GaplessAudioResources.fingerprint(item.source) === globalThis.GaplessAudioResources.fingerprint(entry.source)))
          retiredFills.splice(i, 1);
      }
      if (fillJob || performance.now() < fillAfter || cacheQueue.running || cacheQueue.queue.length) return;
      const eligible = item => !item.cacheComplete && (item.cacheFillStalls || 0) < 6
        && performance.now() >= (item.cacheFillRetryAt || 0);
      const retired = retiredFills.find(eligible);
      const owner = retired && (preferRetiredFill || !eligible(c)) ? retired : eligible(c) ? c : retired;
      if (!owner) return;
      preferRetiredFill = owner === c;
      const fillSource = owner === c ? entry.source : owner.source;
      const points = owner === c ? entry.stream.seekPoints : owner.points;
      const rate = owner === c ? entry.spec.rate : owner.rate;
      const job = fillJob = { controller: new AbortController(), c: owner };
      const signal = job.controller.signal;
      const generation = nativeCache.generation;
      const valid = () => !signal.aborted && current === c && sourceLeaseValid()
        && generation === nativeCache.generation && (owner === c || retiredFills.includes(owner));
      const timer = setTimeout(() => { if (valid()) deferFill(owner); job.controller.abort(); }, 8000);
      void (async () => {
        try {
          const coverage = await nativeCache.snapshotSource(fillSource, signal);
          if (!valid()) return;
          if (coverage.complete) { owner.cacheComplete = true; return; }
          const gap = globalThis.GaplessCacheCoverage.missing(coverage)[0];
          const target = globalThis.GaplessCacheCoverage.seekBefore(gap[0], points, rate);
          const result = await cacheQueue.request({ source: fillSource, position: target, signal,
            priority: globalThis.WindowsNativeCachePriority.fill,
            budgetMs: Math.min(2000, 500 * 2 ** (owner.cacheFillStalls || 0)) });
          if (!valid()) return;
          if (result?.complete) { resetFillRetry(owner); owner.cacheComplete = true; trace('native-cache-complete', { id: source.trackId(owner.info) }); }
          else {
            const covered = snapshot => snapshot?.ranges.reduce((sum, [start, end]) => sum + end - start, 0) || 0;
            if (covered(result) > covered(coverage)) resetFillRetry(owner);
            else deferFill(owner);
          }
        } catch (error) {
          if (valid() && !/^native-cache-(preempted|cleared|cancelled)$/.test(error.message)) deferFill(owner);
        } finally { clearTimeout(timer); if (fillJob === job) fillJob = null; fillAfter = Math.max(fillAfter, performance.now() + 500); }
      })();
    }

    const resources = new globalThis.GaplessStreamingResources({
      trace, readCache: async (ref, info, signal, full) => {
        if (!nativeBytes) return nativeCache.read(ref, info, signal, full);
        if (full) throw new Error('native-only-cache-index-required');
        try { return await nativeBytes.open(info, signal, () => source.trackId(info) === source.trackId(current?.info)
          ? (current?.entry?.stream?.priorityTarget != null ? 100 : 60) : 30); }
        catch (error) {
          if (signal.aborted || /^native-cache-(preempted|cleared|cancelled)$/.test(error.message)) throw new Error('cancelled');
          // Do not silently start a second Web download after native acquisition.
          throw new Error('native-only-cache-provider');
        }
      }, exactSize: true, openLocal: source.openLocal, openLocalInput: source.openLocalInput,
      resolve: async () => { throw new Error('native-only-source'); }, acceptRate: () => true,
    });
    const preparedPairs = new Map();
    const sameSpec = (a, b) => !!a && !!b && a.rate === b.rate && a.channels === b.channels
      && a.codec === b.codec && (a.codec === 'mp3' || (a.bits !== null && a.bits === b.bits));
    function readyForWeb(info, snap) {
      if (!allowsWeb(info, snap)) return false;
      try {
        const full = source.sourceInfo(info, snap.currentRow), ref = makeRef(full, snap);
        return full.audioFormat === 'flac' || /\.flac$/i.test(full.path || '')
          || (sameEnvironment(preparedPairs.get(resources.requestKey(ref)), snap) && !!resources.lookup(ref, full));
      } catch {
        // Still run handleLoad's old-owner teardown before forwarding native
        // Load when a local file disappears or its version cannot be read.
        return false;
      }
    }
    const clock = new globalThis.GaplessStreamingClock({
      resources, trace,
      onState: (state, failedTrack) => {
        if (state === 'running') return;
        if (failedTrack && failedTrack !== current) {
          if (selected?.track === failedTrack) cancelCandidate();
          if (claim?.track === failedTrack) clearClaim();
          trace('candidate-output-cancelled', { reason: state });
          return;
        }
        clearClaim();
        if (current?.owns && !current.loading) void recover(current, 'output-' + state);
      },
      onEnded: track => { if (track === current && current.owns && !current.pendingStreamSeek) boundary(current); },
    });

    function visualSnapshot() {
      const c = current;
      const active = enabled() && c?.owns && !restoring && !claim && !document.hidden && bridge.audioDataEnabled
        && bridge.registrations.has('audioplayer.onAudioData');
      const ready = active && c.playing && c.node && clock.ctx && clock.outputTime() >= c.start;
      return { active, playing: !!ready, id: c?.id, serial: c?.id,
        revision, generation: clock.generation, buffer: active ? c.entry?.buffer : null,
        position: active ? clock.outputPosition(c) : 0 };
    }
    const visualPacketLengths = new Map();
    const visual = new globalThis.GaplessVisualPCM({ rate: 48000, channels: 2, packetFrames: 400, trace,
      snapshot: visualSnapshot, emit: (bytes, pts) => {
        visualPacketLengths.set(pts, bytes.byteLength);
        if (visualPacketLengths.size > 256) visualPacketLengths.delete(visualPacketLengths.keys().next().value);
        event('AudioData', [{ data: bytes.slice().buffer, pts }]);
      } });

    const visualRenderHooks = new Map();
    let lastVisualRender = null;
    function visualRenderPosition(fallback) {
      try {
        const c = current;
        if (!enabled() || !c?.owns || restoring || claim) {
          lastVisualRender = null;
          return fallback;
        }
        const same = lastVisualRender?.id === c.id;
        if (c.playing && clock.ctx && clock.outputTime() < c.start) {
          return same ? lastVisualRender.position : fallback;
        }
        const position = clock.outputPosition(c) * 1000;
        lastVisualRender = { id: c.id, position };
        return position;
      } catch {
        return fallback;
      }
    }

    let visualRequire, visualSdk;
    function getVisualSdk() {
      if (visualSdk) return visualSdk;
      try {
        if (!visualRequire && window.webpackJsonp?.push) {
          const key = 'gapless-visual-adapter';
          window.webpackJsonp.push([[], { [key]: (m, e, r) => { visualRequire = r; } }, [[key]]]);
          if (visualRequire) { delete visualRequire.m[key]; delete visualRequire.c[key]; }
        }
        for (const mod of Object.values(visualRequire?.c || {})) {
          visualSdk = [mod.exports, mod.exports?.b].find(s => typeof s?._AERenderMV === 'function' && typeof s?._AESetAudioData === 'function');
          if (visualSdk) return visualSdk;
        }
      } catch {}
      return null;
    }
    function prepareVisualClock() {
      const sdk = getVisualSdk();
      if (!sdk) return;
      for (const [name, index] of [
        ['_AERenderMV', 1],
        ['_AEWebSetPlaybackPosition', 0]
      ]) {
        const original = sdk[name], previous = visualRenderHooks.get(name);
        if (typeof original !== 'function' || original === previous?.wrapped) continue;
        const wrapped = function (...args) {
          args[index] = visualRenderPosition(args[index]);
          return original.apply(this, args);
        };
        sdk[name] = wrapped;
        visualRenderHooks.set(name, { sdk, original, wrapped });
      }

      // Windows retains the largest allocation; limit analysis to valid bytes.
      const name = '_AESetAudioData', original = sdk[name];
      if (typeof original === 'function' && original !== visualRenderHooks.get(name)?.wrapped) {
        const wrapped = function (address, pts, length) {
          const actual = current?.owns && visualPacketLengths.get(pts);
          return original.call(this, address, pts, actual || length);
        };
        sdk[name] = wrapped;
        visualRenderHooks.set(name, { sdk, original, wrapped });
      }
    }
    const event = (name, args) => bridge.emit('audioplayer.on' + name, args);
    const reply = (callback, ...args) => { if (typeof callback === 'function') queueMicrotask(() => {
      try { callback(...args); } catch (error) { bridge.report(error); }
    }); };
    const token = (id, action) => id + '|' + action + '|gapless' + ++serial;
    const currentPosition = c => c.owns ? clock.position(c)
      : c.nativePosition + (c.nativePlaying ? (performance.now() - c.progressAt) / 1000 : 0);
    const currentPlayed = c => c.nativeHeard + clock.heard(c);
    const stateEvent = (c, mark, value) => event('PlayState', [c.id, mark, value]);
    const progress = (c, force = false) => { if (current !== c || !c.owns || (!c.playing && !force)) return; event('PlayProgress', [c.id, Number(clock.position(c)).toFixed(3), '1.0000', force]); };
    const loadInfo = c => ({ activeCode: 0, code: 0, errorCode: 0, errorString: '', duration: c.duration });
    function makeTrack(id, info) {
      return { id, info, duration: Number(info?.songDuration) / 1000, pendingNativeSeeks: new Set(), nativePlaying: false, nativePosition: 0, progressAt: performance.now(),
        createdAt: performance.now(), prepareAttempts: 0, prepareAfter: 0, nativeReports: [], nativeHeard: 0, nativeAudioHeard: 0, nativeCarry: 0, nativeAudioCarry: 0, offset: 0, heard: 0, playing: false, owns: false };
    }
    async function requestEvent(command, args, name, matches) {
      const waiter = bridge.wait('audioplayer.on' + name, matches);
      try {
        const result = await Promise.all([bridge.request('audioplayer.' + command, args), waiter.promise]);
        return result[1];
      } finally { waiter.dispose(); }
    }
    function completeSeek(c, callback, mark, target, failed = false, requestRevision = revision) {
      seekReplies.push({ c, callback, mark, target, revision: requestRevision, failed });
      if (seekReplies.length === 1) deliverSeek();
    }
    function startSeekRange(c, target) {
      const entry = c.entry;
      c.seekRangeController?.abort();
      entry.stream.ensureController?.abort();
      entry.stream.priorityTarget = target;
      const controller = c.seekRangeController = new AbortController();
      void globalThis.GaplessSeekRange.prepare(resources, entry, target, controller.signal)
        .catch(() => { if (!controller.signal.aborted) trace('seek-range-unavailable'); })
        .finally(() => { if (c.seekRangeController === controller) entry.stream.priorityTarget = null; });
    }
    function cancelPendingSeek(c) {
      c?.seekRangeController?.abort();
      if (c?.entry?.stream) c.entry.stream.priorityTarget = null;
      const request = c?.pendingStreamSeek;
      if (!request || request.finished) return;
      request.finished = true; c.pendingStreamSeek = null;
      if (!request.resume) completeSeek(c, request.callback, request.mark, request.target, true, request.revision);
    }
    async function seekWhenReady(c, callback, mark, target, resume = false) {
      cancelPendingSeek(c);
      const request = c.pendingStreamSeek = { callback, mark, target, revision, finished: false, resume };
      const began = performance.now(), entry = c.entry;
      startSeekRange(c, target);
      const valid = () => current === c && c.owns && enabled() && !restoring
        && c.entry === entry && c.pendingStreamSeek === request;
      const required = Math.min(entry.buffer.length, Math.ceil((target + seekBufferSeconds(entry)) * entry.spec.rate));
      trace('stream-seek-wait', { id: source.trackId(c.info), target });
      try {
        while (!entry.stream.done && globalThis.GaplessSeekRange.until(entry, Math.floor(target * entry.spec.rate)) < required) {
          if (!valid()) throw new Error('cancelled');
          if (entry.stream.error) throw new Error('stream-seek-source-failed');
          if (performance.now() - began > 10000) throw new Error('stream-seek-timeout');
          await new Promise(resolve => setTimeout(resolve, 30));
        }
        if (!valid() || entry.stream.error) throw new Error('cancelled');
        if (c.playing) clock.seek(c, target);
        else {
          clock.stop(c); c.offset = target;
          if (c.intent === true) clock.start(c, clock.ctx.currentTime + 0.01, target);
        }
        c.pendingStreamSeek = null;
        request.finished = true;
        if (resume) {
          if (c.playing && c.intent === true) { stateEvent(c, mark, 1); progress(c, true); }
        } else completeSeek(c, callback, mark, target, false, request.revision);
        trace('stream-seek-ready', { id: source.trackId(c.info), target, waitMs: Math.round(performance.now() - began) });
      } catch (error) {
        if (!request.finished) {
          const recoverResume = resume && valid() && c.intent === true;
          request.finished = true;
          if (c.pendingStreamSeek === request) c.pendingStreamSeek = null;
          if (!resume) completeSeek(c, callback, mark, target, true, request.revision);
          trace('stream-seek-cancel', { reason: error.message });
          if (recoverResume) void recover(c, 'resume-buffer-unavailable', true);
        }
      }
    }
    function seekBufferSeconds(entry) {
      // A target can land in the last fraction of a FLAC seek interval. Native
      // Load/Seek/Stop plus committed-index reads need more runway than that
      // fraction; do not switch after merely obtaining the target's first frame.
      return entry?.origin === 'native-source' ? 2 : 0.5;
    }
    function deliverSeek() {
      const item = seekReplies[0];
      const { c } = item;
      reply(item.callback);
      // The Windows SDK attaches a temporary Seek listener after the RPC resolves.
      setTimeout(() => {
        try {
          const same = current === c && c.owns;
          const valid = !item.failed && same && revision === item.revision;
          event('Seek', [c.id, item.mark, valid ? 0 : -1, same && !valid ? clock.position(c) : item.target]);
          if (valid) progress(c);
        } finally {
          seekReplies.shift();
          if (seekReplies.length) setTimeout(deliverSeek, 0);
        }
      }, 0);
    }
    function cancelCandidate() {
      if (!selected) return;
      selected.controller?.abort();
      clock.stop(selected.track);
      selected = null;
    }
    function clearClaim() {
      if (!claim) return;
      const previous = claim;
      claim = null;
      clearTimeout(previous.timer);
      clock.stop(previous.track);
    }
    let switchIdleTimer, recentEntry;
    function clearRecent() {
      resources.unpin(recentEntry); recentEntry = null;
    }
    function clearMemoryCache() {
      clearRetiredFills(); if (current) current.cacheComplete = false;
      resetFillRetry(current);
      cacheQueue?.clear();
      const c = current;
      cancelPendingSeek(c); cancelCandidate(); clearRecent();
      // Do not cancel an already audible boundary claim: its PCM is active.
      const active = claim?.track?.entry || (c?.owns ? c.entry : null);
      const ref = claim ? makeRef(claim.info, claim.snapshot) : c?.owns ? makeRef(c.info, c.environment || getSnapshot()) : null;
      resources.retain(ref ? [ref] : []);
      resources.clearCachedData(active);
      nativeCache.clear(); preparedPairs.clear();
      if (c) {
        c.prepareAttempts = 0;
        c.prepareAfter = performance.now() + Math.max(0, Math.min(5000, (c.duration - clock.position(c) - 4) * 1000));
      }
      trace('cache-cleared', { retainedPlaybackBytes: active?.size || 0 });
      return { encodedBytes: resources.songCache.bytes, retainedPlaybackBytes: active?.size || 0 };
    }
    bridge.cacheClearRequested = (args = []) => {
      // Only the default current-cache clear emits onclearcache on this client.
      // Clearing an explicitly named old directory was observed not to emit it.
      if (nativeSourceMode && !args[0]) {
        pendingCacheClears++;
        cacheClearing = true;
      }
      const result = clearMemoryCache();
      if (nativeSourceMode && !args[0]) {
        const stops = cacheSession.recentStops.filter(item => performance.now() - item.at < 2000);
        return nativeCache.settleStoppedWrites(stops).catch(error => {
          trace('native-cache-settle-failed', { reason: error.message });
          // Still forward the user's native clear. Keep acquisition blocked
          // until its real completion event, including on observation failure.
        }).then(() => result);
      }
      return result;
    };
    function abandon(keepWarm = false) {
      if (keepWarm) rememberFill(current); else clearRetiredFills();
      cancelFill();
      cacheQueue?.clear();
      clearTimeout(switchIdleTimer);
      // One recently heard buffer makes back/forward navigation responsive.
      // It remains inside the shared memory budget and is evicted before a
      // prefetch is allowed to fail for memory pressure.
      if (keepWarm && current?.entry && !current.entry.stream?.error && (!current.entry.stream || current.entry.stream.done || current.entry.stream.indexed) && current.entry.size <= 128 * 1024 * 1024) {
        clearRecent(); recentEntry = current.entry; resources.pin(recentEntry);
      } else if (!keepWarm) clearRecent();
      revision++;
      cancelPendingSeek(current);
      cancelCandidate();
      clearClaim();
      visual.stop();
      clock.stop(current);
      if (!keepWarm) void clock.close().catch(bridge.report);
      if (nativeGate && !keepWarm) void releaseNativeGate().catch(bridge.report);
      current = null;
      restoring = null;
      if (!keepWarm) resources.retain([]);
      else switchIdleTimer = setTimeout(() => {
        if (current) return;
        clearRecent();
        resources.retain([]);
        void clock.close().catch(bridge.report);
        void releaseNativeGate().catch(bridge.report);
      }, 2500);
    }

    function schedule(c, candidate) {
      if (temporaryBridge && c.bridgeSide === 'head') return;
      if (c.pendingStreamSeek || !c.owns || !c.playing || !candidate?.entry || clock.ctx?.state !== 'running') return;
      // Keep the prepared file's version, rather than comparing two host rows
      // which may both omit file metadata. Recheck a queued local node without
      // putting synchronous filesystem calls on every 40 ms progress tick.
      if (!candidate.track || (candidate.entry.source.localKey
        && performance.now() >= (candidate.fileCheckAt || 0))) {
        candidate.fileCheckAt = performance.now() + 250;
        if (!source.same(candidate.entry.source, candidate.info)) {
          if (selected === candidate) cancelCandidate(); else clock.stop(candidate.track);
          c.prepareAttempts = 0; c.prepareAfter = performance.now() + 1000;
          trace('candidate-source-changed');
          return;
        }
      }
      if (candidate.track) return;
      if (!clock.matches(candidate.entry) || c.end - clock.ctx.currentTime < 0.08) return;
      const next = { ...makeTrack('', candidate.info), entry: candidate.entry, duration: candidate.entry.duration };
      clock.start(next, c.end, 0);
      candidate.track = next;
      trace('scheduled', { from: source.trackId(c.info), to: source.trackId(next.info),
        sourceRate: next.entry.spec.rate, decodedRate: next.entry.buffer.sampleRate,
        contextRate: clock.ctx.sampleRate, leadSeconds: c.end - clock.ctx.currentTime,
        scheduledGapFrames: Math.round((next.start - c.end) * clock.ctx.sampleRate) });
    }
    function boundary(c) {
      if (current !== c || c.endSent || !c.owns) return;
      c.endSent = true;
      const candidate = selected;
      selected = null;
      c.owns = false;
      visual.stop();
      const snap = getSnapshot();
      if (candidate?.track && snap?.id === c.id && snap.nextKnown
        && sameEnvironment(candidate.snapshot, snap) && enabled()
        && source.same(candidate.entry.source, candidate.info)) {
        claim = candidate;
        claim.previous = c;
        claim.started = performance.now();
        const stamp = clock.ctx.getOutputTimestamp();
        trace('boundary', { from: source.trackId(c.info), to: source.trackId(candidate.info),
          outputWallMs: Math.round(performance.timeOrigin + stamp.performanceTime
            + 1000 * (candidate.track.start - stamp.contextTime)) });
        candidate.timer = setTimeout(() => {
          if (claim !== candidate) return;
          clearClaim();
          resources.retain([]);
          trace('claim-timeout');
          const snap = getSnapshot();
          if (enabled() && current === c && sameEnvironment(candidate.snapshot, snap)
            && snap.sourceId === source.trackId(candidate.info) && snap.id !== c.id && !snap.playing) {
            // Only retry the row already selected by the client's natural advance.
            Promise.resolve(native.select(candidate.row)).catch(bridge.report);
          }
        }, 2200);
      } else clock.stop(candidate?.track);
      event('End', [c.id, { ...loadInfo(c), playedTime: currentPlayed(c) }]);
    }

    async function prepare(c, snap) {
      // Native acquisition reuses the host backend. Until Web owns output,
      // leave that backend playing normally; preparation would either fail its
      // lease or interrupt the audible native song. The next Load establishes
      // ownership through loadOwned before requesting native cache bytes.
      if (nativeSourceMode && !c.owns) return;
      if (selected && sameEnvironment(selected.snapshot, snap)) return;
      if (c.prepareAttempts >= 4 || performance.now() < c.prepareAfter) return;
      c.prepareAttempts++;
      cancelCandidate();
      const candidate = selected = { snapshot: snap, track: null, entry: null, info: null, controller: new AbortController() };
      const stillCurrent = () => current === c && selected === candidate && enabled()
        && sameEnvironment(snap, getSnapshot());
      try {
        let sourceTimer;
        const preload = await Promise.race([native.next(c.id), new Promise((_, reject) => {
          sourceTimer = setTimeout(() => reject(new Error('next-source-timeout')), 3500);
        })]).finally(() => clearTimeout(sourceTimer));
        if (!stillCurrent()) return;
        if (!source.acceptsCandidate(preload, snap, c)) throw new Error('native-only-next-source');
        candidate.info = preload.info;
        candidate.row = preload.row;
        const currentInfo = source.sourceInfo(c.info, snap.currentRow);
        const nextInfo = source.sourceInfo(candidate.info, candidate.row);
        const firstRef = makeRef(currentInfo, snap), nextRef = makeRef(nextInfo, snap);
        resources.retain([firstRef, nextRef]);
        const entry = await resources.obtain(firstRef, currentInfo);
        if (!stillCurrent()) return;
        c.entry = entry;
        if (source.same(c.info, candidate.info)) candidate.entry = c.entry;
        else {
          try { candidate.entry = await resources.obtain(nextRef, nextInfo); }
          catch (error) {
            if (error.message !== 'native-only-memory' || !recentEntry || !stillCurrent()) throw error;
            clearRecent(); resources.retain([firstRef, nextRef]); resources.resetFailures();
            candidate.entry = await resources.obtain(nextRef, nextInfo);
          }
        }
        if (!stillCurrent()) return;
        if (!temporaryBridge && !sameSpec(c.entry.spec, candidate.entry.spec)) throw new Error('native-only-sample-spec');
        if ((firstRef.duration > 0 && Math.abs(c.entry.duration - firstRef.duration) > 0.15)
          || (nextRef.duration > 0 && Math.abs(candidate.entry.duration - nextRef.duration) > 0.15)) throw new Error('native-only-duration');
        if (temporaryBridge && c.entry.spec.rate !== candidate.entry.spec.rate) throw new Error('native-only-sample-rate');
        c.duration = c.entry.duration;
        c.environment = snap;
        preparedPairs.set(resources.requestKey(firstRef), snap);
        preparedPairs.set(resources.requestKey(nextRef), snap);
        while (preparedPairs.size > 6) preparedPairs.delete(preparedPairs.keys().next().value);
        c.prepareAttempts = 0;
        trace('pair-ready', { rate: c.entry.spec.rate, devices: customOutput ? 'custom' : 'default' });
      } catch (error) {
        if (!stillCurrent()) return;
        candidate.entry = null;
        c.prepareAfter = performance.now() + Math.min(30000, 2000 * 2 ** Math.max(0, (c.prepareAttempts || 1) - 1));
        if (/^(native-only-|decode-)/.test(error.message)) c.prepareAttempts = 4;
        cancelCandidate();
        trace('prepare-fallback', { reason: /^[a-z0-9-]+$/.test(error.message) ? error.message : 'source-error' });
      }
    }

    async function takeOver(c, candidate) {
      if (c.pendingNativeSeeks.size || performance.now() - (c.lastSeek || -Infinity) < 400) return;
      if (temporaryBridge && !bridgeWindow.canEnter(c.duration, currentPosition(c))) return;
      const attempt = { c, revision, pauseMark: null };
      switchIn = attempt;
      const valid = () => current === c && switchIn === attempt && selected === candidate && revision === attempt.revision
        && !c.pendingNativeSeeks.size && enabled() && sameEnvironment(candidate.snapshot, getSnapshot());
      let offset = 0;
      try {
        await clock.open(c.entry);
        if (!valid() || !c.nativePlaying || !getSnapshot().playing || performance.now() - c.lastSeek < 400) return;
        const nativeInfo = await bridge.request('audioplayer.getPlayedTime', [{ playId: c.id }], 800).catch(() => []);
        if (!valid() || !c.nativePlaying || !getSnapshot().playing) return;
        offset = currentPosition(c);
        if (offset < 0 || c.duration - offset < 0.5) return;
        const pauseMark = token(c.id, 'pause');
        attempt.pauseMark = pauseMark;
        await requestEvent('pause', [c.id, pauseMark], 'PlayState', args =>
          String(args[0]) === c.id && args[1] === pauseMark && Number(args[2]) === 2);
        if (!valid() || c.nativePlaying) throw new Error('takeover-cancelled');
        const reported = Number(nativeInfo[0]?.playedTime);
        c.nativeHeard = (Number.isFinite(reported) ? reported : 0) + c.nativeCarry;
        const audioReported = Number(nativeInfo[0]?.playedAudioTime);
        c.nativeAudioHeard = (Number.isFinite(audioReported) ? audioReported : reported || 0) + c.nativeAudioCarry;
        c.offset = Math.max(0, Math.min(currentPosition(c), c.duration - 0.12));
        if (Math.abs(c.offset - offset) > 0.35) c.offset = offset;
        c.nativeLoaded = true;
        c.owns = true;
        c.bridgeSide = 'tail';
        clock.start(c, clock.ctx.currentTime, c.offset);
        schedule(c, candidate);
        stateEvent(c, token(c.id, 'resume'), 1);
        progress(c, true);
        prepareVisualClock();
        visual.sync();
        trace('takeover', { id: source.trackId(c.info), position: c.offset, playFade: candidate.snapshot.playFade });
      } catch (error) {
        if (current === c) {
          if (error.message !== 'takeover-cancelled') c.blocked = true;
          if (error.message === 'native-only-context-awaiting-gesture') c.awaitingGesture = true;
          if (c.owns) void recover(c, 'takeover-failed');
          else if (attempt.pauseMark && c.intent !== false && !c.nativePlaying) {
            bridge.call('audioplayer.play', [c.id, token(c.id, 'resume')]);
          }
        }
        trace('takeover-cancel', { reason: error.message });
      } finally {
        // Failed prewarming must not retain an idle audio device all song long.
        if (!current?.owns && !claim) await clock.close().catch(bridge.report);
        if (switchIn === attempt) switchIn = null;
      }
    }

    async function acquireNativeGate(c) {
      if (nativeGate && nativeGate.c !== c) throw new Error('native-output-busy');
      if (!nativeGate) {
        nativeGate = { c };
        try { localStorage.setItem(gateKey, String(clock.volume)); } catch {}
      }
      await bridge.request('audioplayer.setVolume', ['', '', 0], 1200);
    }
    async function releaseNativeGate() {
      const gate = nativeGate;
      if (!gate) return;
      if (gate.releasing) return gate.releasing;
      gate.releasing = (async () => {
        let confirmed = false;
        try {
          for (let n = 0; n < 3; n++) {
            const volume = clock.volume;
            await bridge.request('audioplayer.setVolume', ['', '', volume], 1200);
            if (volume === clock.volume) { confirmed = true; break; }
          }
        } finally {
          if (nativeGate === gate) nativeGate = null;
          if (confirmed) { try { localStorage.removeItem(gateKey); } catch {} }
          else bridge.call('audioplayer.setVolume', ['', '', clock.volume], () => {
            try { localStorage.removeItem(gateKey); } catch {}
          });
        }
      })();
      return gate.releasing;
    }
    async function prepareNative(c, force = false) {
      if (c.nativePreparing) return c.nativePreparing;
      if (c.nativeReady && !force) return;
      if (c.nativeReady && force) {
        // On Windows, loading the same playId again leaves getPlayedTime bound
        // to a retired instance. Re-anchor a retry through confirmed pause/Seek.
        if (c.nativePlaying) {
          const mark = token(c.id, 'align-pause');
          await requestEvent('pause', [c.id, mark], 'PlayState', a => String(a[0]) === c.id && a[1] === mark && Number(a[2]) === 2);
        }
        if (current !== c || !c.owns) throw new Error('handback-cancelled');
        c.nativeReports = [];
        return;
      }
      const valid = () => current === c && c.owns;
      c.nativePreparing = (async () => {
        if (!valid() || !source.same(c.entry?.source, c.info)) throw new Error('native-source-changed');
        c.internalLoad = true;
        const started = performance.now();
        try {
          const loaded = await requestEvent('load', [c.id, c.info], 'Load', a => String(a[0]) === c.id);
          if (!valid()) throw new Error('handback-cancelled');
          if (Number(loaded[1]?.code) !== 0) throw new Error('native-load-failed');
          await bridge.request('audioplayer.pause', [c.id, token(c.id, 'prepare-pause')]);
          if (!valid()) throw new Error('handback-cancelled');
          c.nativePlaying = false;
          c.nativeReports = [];
          c.nativeLoaded = true; c.nativeReady = true;
          trace('native-prepared', { elapsedMs: performance.now() - started });
        } finally { c.internalLoad = false; }
      })();
      try { await c.nativePreparing; } finally { c.nativePreparing = null; }
    }
    async function handBack(c, reason) {
      if (handback || restoring || switchIn || current !== c || !c.owns) return;
      if (!c.playing) { void recover(c, reason); return; }
      const tx = { c, revision, cancelled: false };
      handback = tx;
      const valid = () => current === c && c.owns && handback === tx && !tx.cancelled
        && revision === tx.revision && enabled() && sameEnvironment(c.environment, getSnapshot())
        && clock.ctx?.state === 'running';
      const check = () => { if (!valid()) throw new Error('handback-cancelled'); };
      tx.promise = (async () => {
        let committed = false, fallback = false;
        trace('handback-start', { reason, position: clock.outputPosition(c) });
        cancelCandidate();
        try {
          const result = await GaplessNativeHandback.run({ track: c, clock, valid, trace, native: {
            prepare: async force => { check(); await acquireNativeGate(c); check(); await prepareNative(c, force); check(); },
            mute: async () => { check(); await acquireNativeGate(c); },
            seek: async position => {
              check(); c.nativeReports = [];
              const mark = c.internalSeek = token(c.id, 'align-seek');
              try {
                const result = await requestEvent('seek', [c.id, mark, position], 'Seek', a => String(a[0]) === c.id && a[1] === mark);
                check();
                if (Number(result[2]) !== 0) throw new Error('native-seek-failed');
              } finally { c.internalSeek = null; }
            },
            play: async () => {
              check(); c.nativeReports = [];
              const mark = token(c.id, 'align-play');
              await requestEvent('play', [c.id, mark], 'PlayState', a => String(a[0]) === c.id && a[1] === mark && Number(a[2]) === 1);
              check();
            },
            reports: () => c.nativeReports,
            outputLeadMs: () => 0,
            unmute: releaseNativeGate,
          }});
          check();
          const heard = currentPlayed(c), audioHeard = c.nativeAudioHeard + clock.heard(c);
          const [counter] = await bridge.request('audioplayer.getPlayedTime', [{ playId: c.id }], 800);
          check();
          if (counter?.result) {
            c.nativeCarry = heard - Number(counter.playedTime);
            c.nativeAudioCarry = audioHeard - Number(counter.playedAudioTime);
          }
          const position = result.position + (performance.now() - result.at) / 1000;
          c.owns = false; c.bridgeSide = null; c.handbackRequested = false;
          c.nativePosition = position; c.progressAt = performance.now(); c.nativePlaying = true;
          c.bridgeNotBefore = performance.now() + 1000;
          clock.stop(c); await clock.close();
          resources.retain([makeRef(c.info, getSnapshot() || c.environment)]);
          committed = true;
          trace('handback-complete', { reason, position, alignmentErrorMs: result.error * 1000,
            switchWallMs: performance.timeOrigin + result.cutWall, activeNodes: clock.status().activeNodes });
        } catch (error) {
          fallback = error.message !== 'handback-cancelled';
          trace('handback-interrupted', { reason: error.message });
          if (current === c && c.owns) {
            // Cancel any queued Web mute before restoring the latest transport intent.
            clock.setOutput(true);
            try { await prepareNative(c, true); } catch { fallback = true; }
            c.handbackRequested = true;
          }
        } finally {
          await releaseNativeGate().catch(error => { trace('native-gain-restore-failed'); fallback = true; });
          if (handback === tx) handback = null;
          if (!committed && fallback && current === c && c.owns) void recover(c, 'handback-fallback');
        }
      })();
      await tx.promise;
    }

    async function recover(c, reason, playIntent) {
      if (current !== c) return;
      clearRetiredFills();
      cacheQueue?.clear();
      cancelPendingSeek(c);
      clearRecent();
      if (current === c && c.loading) { c.rejectLoadReason = reason; resources.retain([]); return; }
      if (handback?.c === c) {
        const pending = handback; pending.cancelled = true; revision++;
        await pending.promise;
        if (current === c && c.owns) return recover(c, reason, playIntent);
        return;
      }
      if (restoring || current !== c || !c.owns) return;
      restoring = c;
      const valid = () => current === c && restoring === c;
      // Controls may arrive during native preparation or gain restoration.
      // Install their queues before the first await and never overwrite them.
      c.recoverySeeks = [];
      c.queuedTransport = null;
      if (c.nativePreparing) { try { await c.nativePreparing; } catch {} }
      if (!valid()) { if (restoring === c) restoring = null; return; }
      await releaseNativeGate().catch(bridge.report);
      if (!valid()) { if (restoring === c) restoring = null; return; }
      const position = c.playing && clock.ctx?.state === 'running'
        ? clock.outputPosition(c) : currentPosition(c);
      const desired = playIntent ?? c.playing;
      const heardBefore = currentPlayed(c);
      const audioHeardBefore = c.nativeAudioHeard + clock.heard(c);
      cancelCandidate();
      visual.stop();
      clock.stop(c);
      void clock.close().catch(bridge.report);
      const retainCurrent = temporaryBridge && /^bridge-/.test(reason);
      resources.retain(retainCurrent ? [makeRef(c.info, getSnapshot() || c.environment)] : []);
      if (!retainCurrent) c.entry = null;
      c.owns = false;
      c.blocked = true;
      trace('restore', { reason, position, desired });
      try {
        if (!c.nativeLoaded) {
          const loaded = await requestEvent('load', [c.id, c.info], 'Load',
            args => String(args[0]) === c.id);
          if (Number(loaded[1]?.code) !== 0) throw new Error('native-load-failed');
          c.nativeLoaded = true;
        }
        if (!valid()) return;
        const [baseline] = await bridge.request('audioplayer.getPlayedTime', [{ playId: c.id }]);
        if (!valid()) return;
        if (baseline?.result && Number.isFinite(Number(baseline.playedTime))) {
          c.nativeCarry = heardBefore - Number(baseline.playedTime);
          c.nativeAudioCarry = audioHeardBefore - Number(baseline.playedAudioTime ?? baseline.playedTime);
        }
        async function seekNative(position, mark) {
          c.recoverySeekMark = c.recoverySeeks[0]?.mark === mark ? null : mark;
          const result = await requestEvent('seek', [c.id, mark, position], 'Seek',
            args => String(args[0]) === c.id && String(args[1]) === mark);
          if (Number(result[2]) !== 0) throw new Error('native-seek-failed');
        }
        let target = position;
        if (position > 0 && !c.recoverySeeks.length) await seekNative(position, token(c.id, 'seek'));
        let play = false;
        while (valid()) {
          const seek = c.recoverySeeks[0];
          if (seek) {
            reply(seek.callback);
            seek.callback = null;
            await new Promise(resolve => setTimeout(resolve, 0));
            if (!valid()) break;
            await seekNative(seek.position, seek.mark);
            c.recoverySeeks.shift();
            target = seek.position;
            continue;
          }
          const transport = c.queuedTransport;
          play = transport?.play ?? desired;
          if (c.nativePlaying !== play) {
            const action = play ? 'play' : 'pause';
            const mark = token(c.id, play ? 'resume' : 'pause');
            await requestEvent(action, [c.id, mark], 'PlayState',
              args => String(args[0]) === c.id && Number(args[2]) === (play ? 1 : 2));
          }
          if (c.queuedTransport === transport && !c.recoverySeeks.length) break;
        }
        if (!valid()) return;
        if (!play) stateEvent(c, token(c.id, 'pause'), 2);
        c.bridgeSide = null;
        if (temporaryBridge && /^bridge-/.test(reason)) {
          c.handbackRequested = false;
          c.blocked = false;
          c.bridgeNotBefore = performance.now() + 1000;
        }
        trace('restored', { position: target, playing: play, handoff: 'sequential-unverified' });
      } catch (error) {
        trace('restore-failed', { reason: error.message });
        if (valid() && c.nativeLoaded && (c.queuedTransport?.play ?? desired)) {
          bridge.call('audioplayer.play', [c.id, token(c.id, 'resume')]);
        }
      }
      finally {
        const pending = c.recoverySeeks;
        c.recoverySeeks = [];
        if (restoring === c) restoring = null;
        for (const seek of pending) completeSeek(c, seek.callback, seek.mark, seek.position, true);
      }
    }

    bridge.observe = (name, args) => {
      if (cacheSession?.observe(name, args)) return true;
      const c = current;
      if (name === 'storage.onclearcache') {
        // One result must not release the barrier for another clear that is
        // still settling or deleting. A missing result keeps reads blocked;
        // their existing deadline falls back to native instead of guessing.
        pendingCacheClears = Math.max(0, pendingCacheClears - 1);
        cacheClearing = pendingCacheClears > 0;
        nativeCache.clear(); trace('native-cache-clear-result', { success: !!args[0] }); return false;
      }
      if (name === 'audioplayer.onFetchPreloadInfo') {
        bridge.nativePreload.requested++;
        if (c?.owns && !restoring && !handback && args[0] && typeof args[0] === 'object') {
          bridge.nativePreload.suppressed++;
          bridge.call('audioplayer.setFetchPreloadInfoResult', [{ params: args[0], info: {}, code: 0, reason: 'gapless-web-owner' }]);
          trace('native-preload-suppressed'); return true;
        }
      }
      if (name === 'audioplayer.onAudioData' && c?.owns) return true;
      if (name === 'audioplayer.onVolume' && nativeGate) return true;
      if (name === 'audioplayer.onAudioDeviceChanged') {
        customOutput = true;
        if (c?.owns) void recover(c, 'device-changed');
      }
      if (!c || String(args[0]) !== c.id) return false;
      // The UI already accepted this instance at the boundary. A second Load
      // notification triggers the SDK's autoplay and overwrites a user's pause.
      if (name === 'audioplayer.onLoad' && (restoring === c || c.internalLoad)) return true;
      if (name === 'audioplayer.onPlayState') {
        c.nativePlaying = Number(args[2]) === 1;
        c.nativeReports = [];
        if (c.nativePlaying) {
          c.progressAt = performance.now();
          if (switchIn?.c !== c && !c.owns && !restoring) c.intent = true;
        }
        if (switchIn?.c === c && switchIn.pauseMark === args[1] && !c.nativePlaying) return true;
      }
      if (name === 'audioplayer.onPlayProgress' && Number.isFinite(Number(args[1]))) {
        c.nativePosition = Number(args[1]);
        c.progressAt = performance.now();
        if (c.nativePlaying) {
          c.nativeReports.push({ position: c.nativePosition, at: c.progressAt });
          if (c.nativeReports.length > 20) c.nativeReports.shift();
        }
      }
      if (name === 'audioplayer.onSeek') {
        c.nativeReports = [];
        if (c.internalSeek === args[1]) return true;
        c.pendingNativeSeeks.delete(args[1]);
        c.lastSeek = performance.now();
        if (Number(args[2]) === 0 && (restoring === c || !c.latestNativeSeek || c.latestNativeSeek === args[1])) {
          c.nativePosition = Number(args[3]);
          c.progressAt = performance.now();
        }
        if (restoring === c && args[1] === c.recoverySeekMark) return true;
      }
      if (name === 'audioplayer.onEnd') {
        if (restoring === c || c.owns || c.endSent) return true;
        c.nativePlaying = false;
        c.endSent = true;
        cancelCandidate();
      }
      return c.owns && ['audioplayer.onPlayProgress', 'audioplayer.onPlayState', 'audioplayer.onBuffering'].includes(name);
    };

    function allowsWeb(info, snap) {
      return !temporaryBridge && enabled() && snap?.capable && !customOutput && source.valid(info)
        && !!snap.currentRow && source.trackId(info) === snap.sourceId;
    }
    async function prepareLoadBuffer(c, entry, check) {
      const began = performance.now(); let target;
      for (;;) {
        check();
        if (!entry.stream || entry.stream.done) return;
        if (entry.stream.error) throw new Error('native-only-seek-buffer');
        if (target !== c.offset) { target = c.offset; startSeekRange(c, target); }
        if (globalThis.GaplessSeekRange.until(entry, Math.floor(target * entry.spec.rate))
          >= Math.min(entry.buffer.length, Math.ceil((target + seekBufferSeconds(entry)) * entry.spec.rate))) return;
        if (performance.now() - began > 10000) throw new Error('native-only-seek-buffer');
        await new Promise(resolve => setTimeout(resolve, 30));
      }
    }
    async function loadOwned(c, args, callback, resume = false) {
      const loadStarted = performance.now();
      const operation = c.loadingToken = {};
      c.loading = true; c.owns = true;
      const valid = () => current === c && c.loadingToken === operation && !restoring;
      const check = () => {
        if (!valid()) throw new Error('cancelled');
        if (c.rejectLoadReason) throw new Error('native-only-load-interrupted');
        const snap = getSnapshot();
        if (!allowsWeb(c.info, snap) || snap.account !== c.environment.account || snap.quality !== c.environment.quality)
          throw new Error('native-only-settings');
      };
      try {
        if (resume) {
          const [count] = await bridge.request('audioplayer.getPlayedTime', [{ playId: c.id }], 800);
          check();
          c.nativeHeard = Number(count?.playedTime || 0) + c.nativeCarry;
          c.nativeAudioHeard = Number(count?.playedAudioTime || 0) + c.nativeAudioCarry;
        }
        const info = source.sourceInfo(c.info, c.environment.currentRow);
        if (nativeSourceMode) {
          if (nativeGate?.releasing) await nativeGate.releasing;
          check();
          if (nativeGate) nativeGate.c = c;
          else await acquireNativeGate(c);
          check();
        }
        const ref = makeRef(info, c.environment);
        if (recentEntry && (recentEntry.requestKey !== resources.requestKey({ ...ref, id: recentEntry.id })
          || recentEntry.requestedLevel !== ref.level)) clearRecent();
        const memoryHit = !!resources.lookup(ref, info);
        resources.retain([ref]);
        let entry;
        try {
          let deadline;
          try { entry = await Promise.race([resources.obtain(ref, info), new Promise((_, reject) => {
            deadline = setTimeout(() => reject(new Error('native-only-start-deadline')), nativeSourceMode ? 8000 : 1000);
          })]); } finally { clearTimeout(deadline); }
        }
        catch (error) {
          check();
          if (error.message !== 'native-only-memory' || !recentEntry) throw error;
          clearRecent(); resources.retain([ref]); resources.resetFailures();
          entry = await resources.obtain(ref, info);
        }
        check();
        if (!source.same(entry.source, info)) throw new Error('native-only-source-identity');
        if (ref.duration > 0 && Math.abs(entry.duration - ref.duration) > 0.15) throw new Error('native-only-duration');
        c.entry = entry; c.duration = entry.duration;
        await prepareLoadBuffer(c, entry, check);
        await clock.open(entry);
        check();
        // A previous native instance must remain inaudible even if an external
        // native transport command revives it while Web owns playback.
        if (nativeGate?.releasing) await nativeGate.releasing;
        check();
        if (nativeGate && nativeGate.c !== c) nativeGate.c = c;
        check();
        if (!nativeGate) await acquireNativeGate(c);
        check();
        // Seek/transport may change while output initialization awaits native.
        // Commit only after the latest offset has playable PCM.
        await prepareLoadBuffer(c, entry, check);
        check();
        c.loading = false; c.blocked = false; c.bridgeSide = null;
        prepareVisualClock(); visual.sync();
        reply(callback);
        queueMicrotask(() => {
          if (current !== c || !c.owns) return;
          if (resume) { stateEvent(c, args[1], c.playing ? 1 : 2); progress(c, true); }
          else event('Load', [c.id, loadInfo(c)]);
          if (current === c && c.owns && c.playing && !c.node && !c.pendingStreamSeek) {
            progress(c, true); clock.start(c, clock.ctx.currentTime + 0.01, c.offset);
            trace('web-start', { id: source.trackId(c.info), offset: c.offset });
          }
        });
        trace('web-loaded', { id: source.trackId(c.info), sourceRate: entry.spec.rate,
          decodedRate: entry.buffer.sampleRate, contextRate: clock.ctx.sampleRate, resume,
          memoryHit, loadMs: Math.round(performance.now() - loadStarted) });
      } catch (error) {
        if (!valid()) { reply(callback); return; }
        c.loading = false; c.owns = false; c.blocked = true;
        // Cancel the acquisition lane before any asynchronous output teardown
        // or unmuting; a timed-out native Load/Seek must not outlive ownership.
        clearRetiredFills(); cacheQueue?.clear(); cancelPendingSeek(c);
        resources.retain([]);
        clock.stop(c); await clock.close().catch(bridge.report);
        if (current !== c) { reply(callback); return; }
        await releaseNativeGate().catch(bridge.report);
        if (current !== c) { reply(callback); return; }
        resources.retain([]); c.entry = null;
        trace('web-load-fallback', { reason: /^[a-z0-9-]+$/.test(error.message) ? error.message : 'load-error', resume });
        if (resume && c.intent === false) { reply(callback); stateEvent(c, args[1], 2); }
        else bridge.call(resume ? 'audioplayer.play' : 'audioplayer.load', args, callback);
      }
    }

    function handleLoad(args, callback, observedNative = false) {
      const [rawId, info] = args;
      const id = String(rawId);
      const incoming = claim;
      const snap = getSnapshot();
      if (incoming && id !== incoming.previous.id && enabled() && sameEnvironment(incoming.snapshot, snap)
        && snap.sourceId === source.trackId(info) && source.same(incoming.track.entry?.source, info) && incoming.track.node
        && bridge.registrations.has('audioplayer.onLoad')) {
        claim = null;
        clearTimeout(incoming.timer);
        cancelFill(); rememberFill(incoming.previous);
        const c = current = incoming.track;
        c.id = id;
        c.info = info;
        c.owns = true;
        c.environment = incoming.snapshot;
        resources.retain([makeRef(info, snap)]);
        c.claimed = true;
        c.claimAt = performance.now();
        c.bridgeSide = 'head';
        prepareVisualClock();
        visual.sync();
        trace('claimed', { id: source.trackId(info), delayMs: performance.now() - incoming.started });
        reply(callback);
        queueMicrotask(() => { if (current === c) event('Load', [id, loadInfo(c)]); });
        return true;
      }
      const useWeb = !observedNative && readyForWeb(info, snap);
      abandon(useWeb);
      current = makeTrack(id, info);
      if (useWeb) {
        current.environment = snap;
        clock.setVolume(snap.volume);
        void loadOwned(current, args, callback);
        return true;
      }
      trace('native-load', { id: source.trackId(info), level: info?.level, codec: info?.audioFormat,
        valid: source.valid(info), reason: observedNative ? 'already-native' : 'not-prepared', pluginWaitMs: 0 });
      return false;
    }

    bridge.handle = (name, callback, args) => {
      if (['audioplayer.load', 'audioplayer.seek', 'audioplayer.pause', 'audioplayer.stop'].includes(name)) cancelFill();
      if (name === 'audioplayer.setFetchPreloadInfoResult' && current?.owns && !restoring && !handback
        && args[0] && typeof args[0] === 'object') {
        bridge.nativePreload.lateResultsSuppressed++;
        bridge.call(name, [{ ...args[0], info: {}, code: 0, reason: 'gapless-web-owner' }], callback);
        return true;
      }
      if (name === 'audioplayer.enableAudioData') {
        bridge.audioDataEnabled = !!args[0];
        if (bridge.audioDataEnabled) visual.sync(); else visual.stop();
        return false;
      }
      if (name === 'audioplayer.load') return handleLoad(args, callback);
      const c = current;
      if (name === 'audioplayer.init' && args[0] === 'device') {
        customOutput = !!args[1];
        if (customOutput && c?.owns) void recover(c, 'device-selected');
        return false;
      }
      if (name === 'audioplayer.setVolume') {
        clock.setVolume(Number(args[2]));
        if (nativeGate || current?.owns) {
          try { localStorage.setItem(gateKey, String(clock.volume)); } catch {}
          reply(callback);
          event('Volume', [args[0] || '', args[1] || '', 0, clock.volume]);
          return true;
        }
        return false;
      }
      if (!c || !name.startsWith('audioplayer.')) return false;
      if (name === 'audioplayer.setPlaybackRate' && enabled() && c.owns && !restoring && !handback) {
        reply(callback);
        trace('native-audio-setting-bypassed', { setting: 'speed', effectiveRate: 1 });
        return true;
      }
      if (name === 'audioplayer.stop' && (!args[0] || String(args[0]) === c.id)) {
        if (claim?.previous === c) {
          trace('claim-cleanup-stop');
          return false;
        }
        if (!restoring) {
          // The host replays the current row with Stop -> Play and no new Load.
          // Keep its source identity and paused buffer until Play or another Load.
          let warmNext = null;
          try {
            if (selected?.info && sameEnvironment(selected.snapshot, getSnapshot()))
              warmNext = makeRef(source.sourceInfo(selected.info, selected.row), selected.snapshot);
          } catch { /* Invalid next-file metadata must not skip current Stop. */ }
          revision++; cancelPendingSeek(c); cancelCandidate(); visual.stop(); clock.stop(c);
          resources.retain([makeRef(c.info, c.environment || getSnapshot()), warmNext]);
          c.offset = 0; c.heard = 0; c.nativeHeard = 0; c.nativeAudioHeard = 0;
          c.stopped = true; c.endSent = false; c.intent = false;
          c.prepareAttempts = 0; c.prepareAfter = 0;
          if (c.loading) c.ignoreAutoPlay = true;
          c.nativePosition = 0; c.nativePlaying = false;
        }
        return false;
      }
      // PlaybackInfo describes the native device, not a synthetic listened-time record.
      // Keep its original response instead of returning fabricated format information.
      if (name === 'audioplayer.getPlaybackInfo') return false;
      const query = name === 'audioplayer.getPlayedTime';
      const id = String(query ? args[0]?.playId : args[0]);
      const snapForControl = getSnapshot();
      const sourceControl = /^audioplayer\.(play|pause|seek)$/.test(name)
        && id === source.trackId(c.info) && snapForControl?.sourceId === id
        && (!snapForControl.id || snapForControl.id === c.id || snapForControl.id === id);
      const loadingControl = c.loading && !id && /^audioplayer\.(play|pause|seek)$/.test(name);
      if (id !== c.id && !sourceControl && !loadingControl) return false;
      const play = name === 'audioplayer.play', pause = name === 'audioplayer.pause', seek = name === 'audioplayer.seek';
      if (play || pause || seek) {
        if (play || seek) resetFillRetry(c);
        if (play) { c.replaying = !!c.stopped; c.stopped = false; }
        if (claim?.previous === c) clearClaim();
        revision++;
        if (!seek) c.intent = play;
        else c.lastSeek = performance.now();
      }
      if (restoring === c && (play || pause || seek)) {
        if (seek) c.recoverySeeks.push({ callback, mark: String(args[1]), position: Math.max(0, Number(args[2]) || 0) });
        else {
          c.queuedTransport = { play };
          reply(callback);
        }
        return true;
      }
      if (play && c.replaying && c.owns && !c.loading) {
        c.replaying = false;
        reply(callback);
        setTimeout(() => {
          if (current !== c || !c.owns) return;
          if (c.intent === false) c.ignoreAutoPlay = true;
          // The host clears playId on same-row replay. Re-announce this loaded
          // source before its normal autoplay to restore progress/queue control.
          event('Load', [c.id, loadInfo(c)]);
        }, 0);
        return true;
      }
      if (play && c.ignoreAutoPlay && !c.loading) {
        c.ignoreAutoPlay = false; c.intent = false;
        reply(callback);
        setTimeout(() => {
          if (current === c && c.intent === false && !c.playing) {
            // Native events alone do not finish the client's Load action, which
            // writes Playing afterwards. Use its normal pause action as the UI does.
            Promise.resolve(native.pause()).catch(bridge.report);
          }
        }, 0);
        return true;
      }
      if (!c.owns && play && !c.nativePlaying && c.nativePosition === 0 && !c.blocked
        && readyForWeb(c.info, getSnapshot())) {
        c.environment = getSnapshot(); c.offset = 0; c.playing = true;
        clock.setVolume(c.environment.volume);
        void loadOwned(c, args, callback, true);
        return true;
      }
      if (c.loading && (play || pause || seek)) {
        if (seek) {
          c.offset = Math.max(0, Math.min(Number(args[2]) || 0, c.duration - 0.001));
          completeSeek(c, callback, args[1], c.offset);
        } else {
          c.playing = play;
          c.ignoreAutoPlay = pause;
          reply(callback); queueMicrotask(() => { if (current === c) stateEvent(c, args[1], play ? 1 : 2); });
        }
        return true;
      }
      if (!c.owns) {
        if (query && (c.nativeCarry || c.nativeAudioCarry)) {
          void bridge.request(name, args).then(([data]) => reply(callback, data?.result ? {
            ...data, playedTime: Math.max(0, Number(data.playedTime) + c.nativeCarry),
            playedAudioTime: Math.max(0, Number(data.playedAudioTime) + c.nativeAudioCarry),
          } : data), () => reply(callback, { result: false }));
          return true;
        }
        if (seek) {
          const mark = args[1];
          c.latestNativeSeek = mark;
          c.pendingNativeSeeks.add(mark);
          setTimeout(() => {
            if (c.pendingNativeSeeks.delete(mark)) c.blocked = true;
          }, 3500);
        }
        return false;
      }
      if (query) {
        const played = currentPlayed(c);
        reply(callback, { result: true, playId: c.id, playedTime: played, playedAudioTime: c.nativeAudioHeard + clock.heard(c),
          playedPercent: 100 * clock.position(c) / c.duration });
        return true;
      }
      if (play || pause || seek) {
        const mark = args[1];
        if (play) {
          if (!c.playing && !c.pendingStreamSeek && c.entry?.stream && !c.entry.stream.done
            && globalThis.GaplessSeekRange.until(c.entry, Math.floor(c.offset * c.entry.spec.rate))
              < Math.min(c.entry.buffer.length, Math.ceil((c.offset + seekBufferSeconds(c.entry)) * c.entry.spec.rate))) {
            // A paused position may have been evicted from bounded PCM. Refill
            // before opening its output, while retaining subsequent pause/seek.
            reply(callback);
            void seekWhenReady(c, null, mark, c.offset, true);
            return true;
          }
          if (!c.playing && !c.pendingStreamSeek) {
            progress(c, true); clock.start(c, clock.ctx.currentTime);
            trace('web-start', { id: source.trackId(c.info), offset: c.offset });
          }
          c.claimed = false;
          prepareVisualClock();
          visual.sync();
          reply(callback);
          queueMicrotask(() => { if (current === c) stateEvent(c, mark, 1); });
        } else if (pause) {
          if (temporaryBridge) c.handbackRequested = true;
          clock.stop(selected?.track);
          if (selected) selected.track = null;
          clock.stop(c);
          reply(callback);
          queueMicrotask(() => { if (current === c) stateEvent(c, mark, 2); });
        } else {
          clock.stop(selected?.track);
          if (selected) selected.track = null;
          if (temporaryBridge) c.handbackRequested = true;
          const wasPlaying = c.playing;
          const target = Math.max(0, Math.min(Number(args[2]) || 0, c.duration - 0.001));
          c.prepareAfter = 0; c.prepareAttempts = 0;
          cancelPendingSeek(c);
          if (c.entry?.stream && !c.entry.stream.done
            && globalThis.GaplessSeekRange.until(c.entry, Math.floor(target * c.entry.spec.rate)) < Math.min(c.entry.buffer.length, Math.ceil((target + seekBufferSeconds(c.entry)) * c.entry.spec.rate))) {
            void seekWhenReady(c, callback, mark, target);
            return true;
          }
          // A new seek into an already filled sparse range still needs its
          // continuation; cancelling the previous request must not strand it.
          if (c.entry?.stream && !c.entry.stream.done && target * c.entry.spec.rate >= c.entry.stream.decodedFrames)
            startSeekRange(c, target);
          if (wasPlaying) clock.seek(c, target);
          else { clock.stop(c); c.offset = target; }
          completeSeek(c, callback, mark, target);
        }
        return true;
      }
      return false;
    };

    let lastProgress = 0;
    setInterval(() => {
      try {
        const c = current;
        if (!c || restoring || c.loading || c.stopped) return;
        if (c.owns && c.entry?.stream?.error) { void recover(c, 'stream-failed'); return; }
        if (selected?.entry?.stream?.error) { cancelCandidate(); c.prepareAfter = performance.now() + 5000; }
        const snap = getSnapshot();
        if (claim) {
          const target = source.trackId(claim.info);
          const previous = source.trackId(claim.previous.info);
          if (!enabled() || !sameEnvironment(claim.snapshot, snap)
            || (snap.sourceId !== previous && snap.sourceId !== target)) {
            clearClaim();
            resources.retain([]);
          }
          return;
        }
        if (c.endSent || !snap) return;
        const flags = JSON.stringify([snap.capable, snap.mode, !!customOutput, snap.playFade, snap.blockers, snap.nextKnown]);
        if (flags !== reportedSettings) {
          reportedSettings = flags;
          trace('native-settings', { capable: snap.capable, mode: snap.mode, customOutput: !!customOutput,
            playFade: snap.playFade, blockers: snap.blockers, nextKnown: snap.nextKnown });
        }
        clock.setVolume(snap.volume);
        const finishLast = c.owns && !snap.nextKnown && sameEnvironment(c.environment, snap);
        if (!enabled() || (!snap.nextKnown && !finishLast) || !snap.capable || customOutput) {
          cancelCandidate();
          if (c.owns && !c.claimed) {
            void recover(c, 'native-settings-or-queue');
          }
          if (!c.owns && !switchIn) resources.retain([]);
          return;
        }
        if (c.owns && !sameEnvironment(c.environment, snap)) {
          void recover(c, 'environment-changed');
          return;
        }
        if (!source.valid(c.info) || c.blocked) return;
        if (c.owns) {
          if (handback) {
            if (c.playing && performance.now() - lastProgress > 250) { lastProgress = performance.now(); progress(c); }
            return;
          }
          if (temporaryBridge && c.handbackRequested && !c.claimed && !seekReplies.length) {
            void handBack(c, 'bridge-user-control');
            return;
          }
          if (c.claimed && performance.now() - (c.claimAt || 0) > 800) c.claimed = false;
          // Paused playback still has a valid authorized source and queue.
          // Prepare only; schedule() remains gated on actual playback intent.
          if (!temporaryBridge && !c.claimed && !finishLast && !selected) void prepare(c, snap);
          maybeFill(c);
          if (!c.playing || c.claimed) return;
          if (performance.now() - lastProgress > 50) { lastProgress = performance.now(); progress(c); }
          prepareVisualClock();
          visual.sync();
          if (temporaryBridge && c.bridgeSide === 'head') {
            if (!c.nativeReady && !c.nativePreparing && !c.nativePrepareFailed) {
              void prepareNative(c).catch(() => { c.nativePrepareFailed = true; });
            }
            if (bridgeWindow.shouldReturn(c.duration, clock.outputPosition(c))) void handBack(c, 'bridge-head-complete');
            return;
          }
          if (finishLast) cancelCandidate();
          else {
            if (!selected) void prepare(c, snap);
            schedule(c, selected);
          }
        } else if (!temporaryBridge && !nativeSourceMode && enabled() && snap.nextKnown && c.nativePlaying && snap.playing) {
          // Prepare an authorized next source without waiting for a prior listen. Never interrupt
          // an already sounding native instance to chase Web ownership.
          if (!selected && c.prepareAttempts < 4 && performance.now() >= c.prepareAfter
            && performance.now() - c.createdAt >= 1500) {
            void prepare(c, snap);
          }
        } else if (temporaryBridge && !switchIn && !handback && c.nativePlaying && snap.playing) {
          if (!selected || !sameEnvironment(selected.snapshot, snap)) void prepare(c, snap);
          else if (selected.entry && c.entry && !c.pendingNativeSeeks.size && performance.now() >= (c.bridgeNotBefore || 0) && c.duration - currentPosition(c) >= 0.5) void takeOver(c, selected);
        }
      } catch (error) { bridge.report(error); }
    }, 40);

    for (const name of ['pointerdown', 'keydown']) window.addEventListener(name, () => {
      if (current?.awaitingGesture) { current.awaitingGesture = false; current.blocked = false; }
    }, { capture: true });
    try {
      const saved = localStorage.getItem(gateKey), value = Number(saved);
      if (saved !== null && Number.isFinite(value) && value >= 0 && value <= 1)
        bridge.call('audioplayer.setVolume', ['', '', value], () => localStorage.removeItem(gateKey));
    } catch {}
    window.addEventListener('beforeunload', () => {
      clearRetiredFills(); cacheQueue?.close();
      if (nativeGate) bridge.call('audioplayer.setVolume', ['', '', clock.volume]);
    });
    if (bridge.load) {
      handleLoad(bridge.load, undefined, true);
      if (current && bridge.startupNativeId === current.id) current.blocked = true;
    }
    bridge.readyForStartup = true;
    bridge.flushStartup?.();
    // Supported FLAC starts from an initial PCM segment, not a whole-file decode.
    const publicStatus = {
      cacheStatus: () => ({ nativeSourceMode, clearing: cacheClearing, pendingClears: pendingCacheClears, filling: !!fillJob,
        fillStalls: current?.cacheFillStalls || 0, fillSuspended: (current?.cacheFillStalls || 0) >= 6,
        currentComplete: !!current?.cacheComplete, pendingPrevious: retiredFills.length, queue: cacheQueue?.status() || null,
        session: cacheSession ? { ...cacheSession.stats } : null }),
      status: () => ({ version: gaplessWindowsBuild.version, nativeSourceMode, enabled: enabled(), savingConfig, owns: !!current?.owns, loading: !!current?.loading,
        nativeAudioPolicy: enabled() ? 'gapless-priority' : 'native',
        suppressedNativeAudioSettings: enabled() && current?.owns ? getSnapshot()?.nativeAudioPreferences || [] : [],
        waitingForNextLoad: nativeSourceMode && enabled() && !!current && !current.owns && !current.loading,
        directWebLoad: !temporaryBridge, startupPolicy: 'stream-flac-native-fallback', nativePrepared: !!current?.nativeReady, handingBack: !!handback || !!restoring, nativeMuted: !!nativeGate, mode: temporaryBridge ? 'temporary-trial' : 'streaming-gapless', bridgeSide: current?.bridgeSide || null, visual: visual.status(), visualHooks: [...visualRenderHooks.keys()], clock: clock.status(), resources: resources.status(), nativeTransport: { ...bridge.nativeTransport }, nativePreload: { ...bridge.nativePreload } }),
      diagnostics: () => events.slice(),
      clearMemoryCache,
      enable(value) {
        const next = Boolean(value);
        const apply = async () => {
          savingConfig = true;
          try {
            if (!await betterncm.app.writeConfig(enabledKey, String(next))
              || await betterncm.app.readConfig(enabledKey, 'unset') !== String(next)) throw new Error('config-save-failed');
            modeEnabled = next;
            bridge.startupEnabled = next;
            plugin.setConfig('enabled', next);
            applyEnabled(next);
          } finally { savingConfig = false; }
        };
        configQueue = configQueue.catch(() => {}).then(apply);
        return configQueue;
      },
    };
    function applyEnabled(value) {
        if (!value) {
          clearRetiredFills(); cacheQueue?.clear();
          resources.songCache.clear();
          cancelPendingSeek(current);
          preparedPairs.clear();
          clearRecent();
          if (current?.loading) { resources.retain([]); }
          else if (current?.owns) void recover(current, 'disabled');
          else { cancelCandidate(); resources.retain([]); void clock.close().catch(bridge.report); void releaseNativeGate().catch(bridge.report); }
          clearClaim();
        }
        if (value && current) { current.blocked = false; current.prepareAttempts = 0; current.prepareAfter = 0; cancelCandidate(); }
    }
    window.gaplessWindows = Object.freeze(publicStatus);
    installGaplessToggle(publicStatus);
    function settingsControl(makeCheckbox) {
      const label = document.createElement('label');
      const checkbox = makeCheckbox({ checked: enabled() });
      checkbox.addEventListener('change', async () => {
        checkbox.disabled = true;
        try { await publicStatus.enable(checkbox.checked); } catch (error) { bridge.report(error); }
        finally { checkbox.checked = enabled(); checkbox.disabled = false; }
      });
      checkbox.addEventListener('focus', () => { checkbox.checked = enabled(); });
      label.append(checkbox, ' 无缝播放');
      return label;
    }
    plugin.onConfig(tools => settingsControl(options => tools.makeCheckbox(options)));
    window.addEventListener('keydown', event => {
      if (event.repeat || !event.ctrlKey || !event.altKey || event.shiftKey
        || String(event.key).toLowerCase() !== 'g') return;
      if (event.target?.closest?.('input,textarea,[contenteditable]')) return;
      const manager = document.querySelector('section.better-ncm-manager');
      const main = document.querySelector('.right-container, section.g-mn:not(.better-ncm-manager)');
      if (!manager || !main || manager === main) return;
      event.preventDefault();
      if (manager.classList.contains('ncmm-show')) {
        manager.classList.remove('ncmm-show');
        main.style.removeProperty('display');
      } else {
        if (manager.parentElement !== main.parentElement) main.after(manager);
        manager.classList.add('ncmm-show');
        main.style.setProperty('display', 'none', 'important');
        manager.querySelector('[data-plugin-slug="gapless-player-windows"]')?.click();
      }
    }, true);
  }
  try { installPlayer(); } catch (error) { trace('init-error', { kind: error.name }); }
});
