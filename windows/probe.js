/* MIT. Opt-in measurement of the unmodified native playback path. */
function probeNative(bridge, trace) {
  const describe = info => ({ id: info?.songId, size: Number(info?.fileSize), level: info?.level,
    codec: info?.audioFormat, type: info?.audioType, trial: !!info?.freeTrialInfo,
    hasHash: /^[a-f0-9]{32}$/i.test(info?.md5 || ''), hasPath: !!info?.path,
    duration: Number(info?.songDuration) });
  bridge.handle = (name, callback, args) => {
    if (name === 'audioplayer.load') trace('native-load', describe(args[1]));
    else if (name === 'audioplayer.setFetchPreloadInfoResult') trace('native-preload-response', {
      code: args[0]?.code, ...describe(args[0]?.info)
    });
    return false;
  };
  let progressAt = 0;
  bridge.observe = (name, args) => {
    if (name === 'audioplayer.onFetchPreloadInfo') trace('native-preload-request', {
      index: args[0]?.preloadIndex
    });
    else if (name === 'audioplayer.onEnd') trace('native-end', {
      played: args[1]?.playedTime, code: args[1]?.code
    });
    else if (name === 'audioplayer.onPlayState') trace('native-state', { state: args[2] });
    else if (name === 'audioplayer.onPlayProgress' && performance.now() - progressAt > 1000) {
      progressAt = performance.now();
      trace('native-progress', { pos: Number(args[1]) });
    }
    return false;
  };
}
