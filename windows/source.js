/* MIT. Native source and queue adapter for the matched NetEase Cloud Music build. */
const WindowsSource = (() => {
  const { fingerprint, localIdentity } = globalThis.GaplessAudioResources;
  const allowedLevels = new Set(['standard', 'higher', 'exhigh', 'lossless', 'hires']);
  const rowId = row => String(row.resourceId || row.trackId || row.id);
  const trackId = info => String(info?.songId || '');
  function localPath(info) {
    if (typeof info?.path !== 'string' || info.freeTrialInfo || info.isCue
      || Number(info.starttime) || (info.type !== undefined && info.type !== 0)) return null;
    const path = info.path.replace(/^(?:file:|orpheus:)\/\//i, '').replace(/\//g, '\\')
      .replace(/^\\+(?=[a-z]:)/i, '');
    return /^[a-z]:\\.*\.(?:flac|mp3)$/i.test(path) && !path.split('\\').includes('..') ? path : null;
  }
  function localState(info) {
    const path = localPath(info);
    const stat = path && globalThis.betterncm_native?.fs?.getProperties?.(path);
    if (!stat || stat.type !== 'file' || !Number.isSafeInteger(stat.size) || stat.size <= 0
      || !Number.isSafeInteger(stat.lastModified)) throw new Error('native-only-local-version');
    return { size: stat.size, version: JSON.stringify([stat.size, stat.lastModified]) };
  }
  const openLocal = async info => {
    const before = localState(info);
    if (info.localVersion !== before.version) throw new Error('native-only-local-changed');
    const blob = await betterncm.fs.readFile(localPath(info));
    if (localState(info).version !== before.version || blob.size !== before.size)
      throw new Error('native-only-local-changed');
    return blob;
  };
  async function openLocalInput(info, signal) {
    const before = localState(info);
    const check = () => {
      if (signal.aborted) throw new Error('cancelled');
      if (info.localVersion !== before.version || localState(info).version !== before.version)
        throw new Error('native-only-local-changed');
    };
    check();
    const url = new URL(await betterncm.fs.mountFile(localPath(info)));
    check();
    if (url.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(url.hostname))
      throw new Error('native-only-local-mount');
    const read = async (start, end, rangeSignal) => {
      check();
      if (rangeSignal.aborted) throw new Error('cancelled');
      const bytes = await globalThis.GaplessSeekRange.read(url.href, start, end, before.size, rangeSignal);
      check();
      if (rangeSignal.aborted) throw new Error('cancelled');
      return bytes;
    };
    // Backpressure limits sequential file reads; indexed seeking uses the same
    // checked range path. Cancelling the prefix must not disable later seeks.
    const sequential = new AbortController();
    const abort = () => sequential.abort();
    signal.addEventListener('abort', abort, { once: true });
    let offset = 0;
    const body = new ReadableStream({
      async pull(controller) {
        try {
          check();
          if (offset === before.size) {
            signal.removeEventListener('abort', abort); controller.close(); return;
          }
          const end = Math.min(before.size, offset + 65536);
          const bytes = await read(offset, end, sequential.signal);
          offset = end; controller.enqueue(bytes);
        } catch (error) {
          signal.removeEventListener('abort', abort); controller.error(error);
        }
      },
      cancel() { signal.removeEventListener('abort', abort); sequential.abort(); },
    }, { highWaterMark: 0 });
    return { kind: 'local-file', seekRange: read,
      response: new Response(body, { headers: { 'content-length': String(before.size) } }) };
  }
  function valid(info) {
    if (localPath(info)) return !!trackId(info);
    if (!info || info.audioType !== 'track' || info.freeTrialInfo || info.path || info.isCue) return false;
    if (!allowedLevels.has(info.level) || !fingerprint(info) || !/^https?:\/\//i.test(info.musicurl || '')) return false;
    return Number.isSafeInteger(Number(info.fileSize)) && Number(info.fileSize) > 0 && Number(info.songDuration) > 0;
  }
  function same(a, b) {
    if (!valid(a) || !valid(b) || trackId(a) !== trackId(b)) return false;
    const path = localPath(a);
    if (path) {
      if (path.toLowerCase() !== localPath(b)?.toLowerCase()) return false;
      try {
        const state = localState(a);
        if ((a.localVersion && a.localVersion !== state.version)
          || (b.localVersion && b.localVersion !== state.version)) return false;
        const normalize = info => ({ ...info, localKey: path.toLowerCase(), fileSize: state.size, localVersion: state.version });
        return localIdentity(normalize(a)) === localIdentity(normalize(b));
      } catch { return false; }
    }
    return !localPath(b) && a.level === b.level && Number(a.fileSize) === Number(b.fileSize)
      && fingerprint(a) === fingerprint(b);
  }
  function connect() {
    const chunks = window.webpackJsonp;
    if (!chunks || chunks.push === Array.prototype.push) return null;
    let require;
    const id = 'gapless-windows-selector';
    chunks.push([[], { [id]: (module, exports, runtime) => { require = runtime; } }, [[id]]]);
    if (!require?.m || !require?.c) return null;
    delete require.m[id];
    delete require.c[id];
    const matches = Object.values(require.m).map(String)
      .filter(factory => factory.split(selector.original).length === 2);
    if (matches.length !== 1) return null;
    const factory = new Function('return (' + matches[0].replace(selector.original, selector.patched) + ');')();
    const module = { exports: {} };
    return factory(module, module.exports, require);
  }
  function snapshot(native, current, gaplessEnabled = false) {
    const state = native.read();
    const { playing, playingList, setting, host } = state;
    if (!playing || !setting?.quantity || !host) return null;
    const mode = playing.playingMode;
    const id = String(playing.playId || '');
    const sourceId = rowId(playing.curPlaying || {});
    const queue = playingList?.curPlayingList;
    const account = host.isAnonymous ? 'anonymous' : String(host.uid || state.user?.profile?.userId || '');
    const quality = String(host.isAnonymous ? setting.quantity.listenAnon : setting.quantity.listenReg);
    const audioEffects = state.audioEffect?.setting?.isOn || state.assignedAudioEffect?.isOn
      || state.assignedAudioEffect?.setting?.isOn || playing.audioEffect?.isOpen;
    const nativeAudioPreferences = Object.entries({
      audioEffects, loudness: setting.loudnessBalance,
      spatial: setting.systemSpatialSound, enhancement: setting.systemAudioEnhance, fade: setting.playFade,
      dolby: setting.listenDolby,
      speed: Number(playing.playingSpeed || 1) !== 1 || Number(playing.playingSpeedTrack || 1) !== 1,
    }).filter(([, blocked]) => blocked).map(([name]) => name);
    // Native-only effects are bypassed by gapless output. Preserve their saved
    // values for disabling gapless instead of making the enabled switch a no-op.
    const blockers = Object.entries({ account: !account,
      trial: playing.resourceIsTryType, video: playing.isPlayingVideo,
    }).filter(([, blocked]) => blocked).map(([name]) => name);
    if (!gaplessEnabled) blockers.push(...nativeAudioPreferences);
    const capable = !blockers.length;
    const volume = Number(playing.playingVolume);
    const sameTrack = current && id === current.id && sourceId === trackId(current.info);
    const matchingRows = sameTrack && Array.isArray(queue) ? queue.filter(row => rowId(row) === sourceId) : [];
    const order = matchingRows[0]?.displayOrder;
    const ordered = (mode === 'playOrder' || mode === 'playAi') && matchingRows.length === 1 && Number.isFinite(order)
      && queue.every(row => Number.isFinite(row.displayOrder));
    const terminal = ordered && !queue.some(row => row.displayOrder > order);
    // The exact client's original selector chooses the next randomized row.
    // Require both its capability marker and a complete, unambiguous order.
    const random = mode === 'playRandom' && native.supportsRandom === true && Array.isArray(queue) && queue.length > 1
      && queue.every(row => Number.isFinite(row.randomOrder))
      && new Set(queue.map(row => row.randomOrder)).size === queue.length;
    const nextKnown = matchingRows.length === 1 && (mode === 'playCycle' || mode === 'playOneCycle' || random
      || (ordered && !terminal));
    return { mode, id, sourceId, queue, currentRow: playing.curPlaying, account, quality, volume, capable, nextKnown, terminal,
      blockers, nativeAudioPreferences, nativeAudioPolicy: gaplessEnabled ? 'gapless-priority' : 'native',
      playing: playing.playingState === 2, playFade: !!setting.playFade };
  }
  function acceptsCandidate(preload, target) {
    return preload?.code === 1 && valid(preload.info) && !!preload.row
      && rowId(preload.row) === trackId(preload.info) && queueRowKey(preload.row) === target.rowKey;
  }
  function queueRowKey(row) {
    // Order is checked by the host selector. Include the selected row's source
    // context, so a new row with the same song ID cannot reuse stale audio.
    try {
      return JSON.stringify([row.resourceId, row.trackId, row.id, row.resourceType,
        row.scene, row.href, row.fromInfo, row.localTrack, row.track]);
    } catch { return null; }
  }
  function boundaryTarget(native, snap, fromId) {
    const queue = snap?.queue, mode = snap?.mode;
    if (!Array.isArray(queue) || !fromId
      || !['playOrder', 'playCycle', 'playOneCycle', 'playRandom', 'playAi'].includes(mode)) return null;
    const origins = queue.filter(row => rowId(row) === fromId);
    if (origins.length !== 1) return null;
    const origin = origins[0];
    if (mode !== 'playOneCycle') {
      const order = mode === 'playRandom' ? 'randomOrder' : 'displayOrder';
      if (mode === 'playRandom' && (!native.supportsRandom || queue.length < 2)) return null;
      if (!queue.every(row => Number.isFinite(row[order]))
        || new Set(queue.map(row => row[order])).size !== queue.length
        || ((mode === 'playOrder' || mode === 'playAi') && !queue.some(row => row[order] > origin[order]))) return null;
    }
    const row = native.nextRow(mode, queue, origin);
    if (!row || !queue.includes(row)) return null;
    const id = rowId(row);
    if (queue.filter(item => rowId(item) === id).length !== 1
      || (mode === 'playOneCycle' ? id !== fromId : id === fromId)) return null;
    const fromKey = queueRowKey(origin), toKey = queueRowKey(row);
    return fromKey && toKey ? { row, rowKey: toKey, key: JSON.stringify([fromKey, toKey]) } : null;
  }
  function sourceInfo(info, row) {
    const path = localPath(info);
    if (!path) return info;
    const local = row?.localTrack;
    const duration = Number(info.songDuration) || Number(local?.duration)
      || Number(local?.origin?.duration) || Number(row?.track?.duration);
    const state = localState(info);
    return { ...info, songDuration: duration, fileSize: state.size,
      localKey: path.toLowerCase(), localVersion: state.version };
  }
  return { valid, same, connect, snapshot, acceptsCandidate, boundaryTarget,
    trackId, sourceInfo, openLocal, openLocalInput };
})();
