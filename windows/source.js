/* MIT. Native source and queue adapter for NetEase Cloud Music 3.1.43.205627. */
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
  function snapshot(native, current) {
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
    const blockers = Object.entries({
      account: !account, audioEffects, loudness: setting.loudnessBalance,
      spatial: setting.systemSpatialSound, fade: setting.playFade,
      dolby: setting.listenDolby, trial: playing.resourceIsTryType, video: playing.isPlayingVideo,
      speed: Number(playing.playingSpeed || 1) !== 1 || Number(playing.playingSpeedTrack || 1) !== 1,
    }).filter(([, blocked]) => blocked).map(([name]) => name);
    const capable = !blockers.length;
    const volume = Number(playing.playingVolume);
    const sameTrack = current && id === current.id && sourceId === trackId(current.info);
    const matchingRows = sameTrack && Array.isArray(queue) ? queue.filter(row => rowId(row) === sourceId) : [];
    const order = matchingRows[0]?.displayOrder;
    const ordered = mode === 'playOrder' && matchingRows.length === 1 && Number.isFinite(order)
      && queue.every(row => Number.isFinite(row.displayOrder));
    const terminal = ordered && !queue.some(row => row.displayOrder > order);
    const nextKnown = matchingRows.length === 1 && (mode === 'playCycle' || mode === 'playOneCycle'
      || (ordered && !terminal));
    return { mode, id, sourceId, queue, currentRow: playing.curPlaying, account, quality, volume, capable, nextKnown, terminal,
      blockers, playing: playing.playingState === 2, playFade: !!setting.playFade };
  }
  function acceptsCandidate(preload, snap, current) {
    if (!snap.nextKnown || preload?.code !== 1 || !valid(preload.info) || !snap.queue.includes(preload.row)) return false;
    const id = trackId(preload.info);
    return rowId(preload.row) === id && snap.queue.filter(row => rowId(row) === id).length === 1
      && (snap.mode === 'playOneCycle' ? id === trackId(current.info) : id !== trackId(current.info));
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
  return { valid, same, connect, snapshot, acceptsCandidate, trackId, sourceInfo, openLocal };
})();
