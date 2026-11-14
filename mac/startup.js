/* MIT. macOS transport adapter. Exceptions always return commands to NetEase. */
(() => {
  'use strict';
  if (!/Mac/i.test(navigator.platform) || window.__gpMacBridge) return;
  const bridge = window.__gpMacBridge = {
    registrations: Object.create(null), events: Object.create(null), eventAt: Object.create(null),
    calls: [], loads: new Map(), handle: null, hooked: false, nativePost: null, synthetic: false,
    audioDataEnabled: false,
  };
  const waiters = new Set(), protectedDispatchers = new WeakSet();
  const report = error => { try { bridge.onError?.(error); } catch { /* Preserve native delivery. */ } };
  function observe(command, args) {
    bridge.events[command] = args; bridge.eventAt[command] = performance.now();
    for (const waiter of [...waiters]) {
      try { if (waiter.command === command && waiter.predicate(args)) waiter.finish(null, args); }
      catch (error) { waiter.finish(error); }
    }
    try { bridge.onNativeEvent?.(command, args); } catch (error) { report(error); }
  }
  bridge.protect = () => {
    const descriptor = Object.getOwnPropertyDescriptor(window, 'MNBCallback');
    const original = window.MNBCallback;
    if (!descriptor?.configurable || typeof original !== 'function' || protectedDispatchers.has(original)) return;
    const wrapped = function (seq, args) {
      const command = Object.keys(bridge.registrations).find(key => bridge.registrations[key] === seq);
      if (command && !bridge.synthetic) {
        observe(command, args);
        try { if (bridge.shouldSuppressNative?.(command, args)) return; } catch (error) { report(error); }
      }
      return original.apply(this, arguments);
    };
    protectedDispatchers.add(wrapped);
    Object.defineProperty(window, 'MNBCallback', {
      configurable: true, enumerable: descriptor.enumerable, get: () => wrapped,
      set(value) {
        if (descriptor.set) descriptor.set.call(window, value);
        else {
          Object.defineProperty(window, 'MNBCallback', { configurable: true, enumerable: descriptor.enumerable,
            writable: true, value });
          bridge.protect();
        }
      },
    });
  };
  bridge.dispatch = (seq, args) => {
    if (!seq || typeof window.MNBCallback !== 'function') return;
    const previous = bridge.synthetic; bridge.synthetic = true;
    try { window.MNBCallback(seq, args); } finally { bridge.synthetic = previous; }
  };
  bridge.emit = (command, args) => bridge.dispatch(bridge.registrations[command], args);
  let sequence = 0;
  bridge.waitNative = (command, predicate, timeout = 5000) => {
    let waiter;
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => waiter.finish(new Error(`native-event-timeout:${command}`)), timeout);
      waiter = { command, predicate, finish(error, args) {
        if (!waiters.delete(waiter)) return;
        clearTimeout(timer); if (error) reject(error); else resolve(args);
      } };
      waiters.add(waiter);
    });
    return { promise, cancel: () => waiter.finish(new Error('cancelled')) };
  };
  bridge.raw = (command, params, timeout = 5000) => new Promise((resolve, reject) => {
    if (!bridge.nativePost || !window.$$MNBCallbackMap) { reject(new Error('native-channel-unavailable')); return; }
    const seq = `::[[gapless-mac]]::${++sequence}`;
    const timer = setTimeout(() => {
      delete window.$$MNBCallbackMap[seq]; reject(new Error(`native-call-timeout:${command}`));
    }, timeout);
    window.$$MNBCallbackMap[seq] = { type: 'call', source: 'gapless-mac', callback: (...args) => {
      clearTimeout(timer); delete window.$$MNBCallbackMap[seq]; resolve(args);
    } };
    try { bridge.nativePost({ method: 'call', command, params, seq }); }
    catch (error) { clearTimeout(timer); delete window.$$MNBCallbackMap[seq]; reject(error); }
  });
  bridge.callNative = (command, params, callback = () => {}) => {
    bridge.raw(command, params).then(args => callback(...args)).catch(report);
  };
  function wrap() {
    const channel = window.ncmChannelOSX;
    if (!channel || typeof channel.postMessage !== 'function' || bridge.hooked) return;
    const original = channel.postMessage;
    bridge.nativePost = msg => original.call(channel, msg);
    channel.postMessage = function (msg) {
      if (msg?.method === 'registerCall' && (msg.command?.startsWith('audioplayer.') || msg.command === 'winhelper.onHotkey')) {
        bridge.registrations[msg.command] = msg.seq; bridge.protect();
      }
      if (msg?.method === 'call' && /^audioplayer\./.test(msg.command)) {
        if (msg.command === 'audioplayer.enableAudioData') bridge.audioDataEnabled = Number(msg.params?.[0]) === 1;
        if (msg.command === 'audioplayer.load') {
          bridge.loads.set(String(msg.params?.[0]), msg.params?.[1]);
          if (bridge.loads.size > 8) bridge.loads.delete(bridge.loads.keys().next().value);
        }
        if (!bridge.handle) {
          bridge.calls.push({ command: msg.command, params: msg.params, seq: msg.seq });
          if (bridge.calls.length > 120) bridge.calls.shift();
        }
        try { if (bridge.handle?.(msg)) return; } catch (error) { report(error); }
      }
      return original.apply(this, arguments);
    };
    bridge.hooked = true;
  }
  const descriptor = Object.getOwnPropertyDescriptor(window, 'ncmChannelOSX');
  if (!window.ncmChannelOSX && (!descriptor || descriptor.configurable)) {
    let stored;
    Object.defineProperty(window, 'ncmChannelOSX', {
      configurable: true, enumerable: true,
      get: () => descriptor?.get ? descriptor.get.call(window) : stored,
      set(value) { if (descriptor?.set) descriptor.set.call(window, value); else stored = value; wrap(); },
    });
  }
  wrap();
  window.addEventListener('DOMContentLoaded', () => { wrap(); bridge.protect(); }, true);
})();
