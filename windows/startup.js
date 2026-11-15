/* MIT. Transparent Windows audio bridge with native and synthetic event paths. */
(() => {
  'use strict';
  if (window.gaplessWindowsBridge) return;
  const registrations = new Map();
  const listeners = new Set();
  const bridge = window.gaplessWindowsBridge = { registrations, listeners, load: null };
  bridge.startup = { phase: 'native-immediate', held: 0, released: 0 };
  bridge.nativeTransport = { load: 0, play: 0, pause: 0, seek: 0, stop: 0, unload: 0 };
  bridge.nativePreload = { requested: 0, suppressed: 0, lateResultsSuppressed: 0 };
  function install() {
    const host = window.channel;
    if (!host || bridge.hooked || typeof host.call !== 'function' || typeof host.registerCall !== 'function') return;
    const rawCall = host.call;
    const rawRegister = host.registerCall;
    bridge.call = (name, args, callback = () => {}) => {
      const transport = name.replace(/^audioplayer\./, '');
      if (Object.prototype.hasOwnProperty.call(bridge.nativeTransport, transport)) bridge.nativeTransport[transport]++;
      return rawCall.call(host, name, callback, args);
    };
    bridge.flushStartup = () => { bridge.startup.phase = 'ready'; };
    bridge.request = (name, args, timeout = 3500) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('native-rpc-timeout:' + name)), timeout);
      try {
        bridge.call(name, args, (...result) => { clearTimeout(timer); resolve(result); });
      } catch (error) { clearTimeout(timer); reject(error); }
    });
    bridge.emit = (name, args) => registrations.get(name)?.apply(window, args);
    bridge.wait = (name, matches, timeout = 3500) => {
      let dispose;
      const promise = new Promise((resolve, reject) => {
        const listener = (event, args) => {
          if (event === name && matches(args)) { dispose(); resolve(args); }
        };
        const timer = setTimeout(() => { dispose(); reject(new Error('native-event-timeout:' + name)); }, timeout);
        dispose = () => { listeners.delete(listener); clearTimeout(timer); };
        listeners.add(listener);
      });
      return { promise, dispose };
    };
    host.registerCall = function (name, handler) {
      if (typeof name !== 'string' || (!name.startsWith('audioplayer.') && name !== 'storage.onclearcache') || typeof handler !== 'function') return rawRegister.apply(this, arguments);
      registrations.set(name, handler);
      return rawRegister.call(this, name, function (...args) {
        try {
          for (const listener of listeners) listener(name, args);
          if (bridge.observe?.(name, args)) return;
        } catch (error) { bridge.report?.(error); }
        return handler.apply(this, args);
      });
    };
    host.call = function (name, callback, args) {
      if (name === 'storage.clearCache') {
        // Diagnostics must never prevent the user's native clear request.
        const reportClearError = error => { try { bridge.report?.(error); } catch {} };
        try {
          const ready = bridge.cacheClearRequested?.(args || []);
          if (ready && typeof ready.then === 'function') {
            // Cancel and settle the auxiliary writer before native deletion.
            // Preserve the original arguments and callback; dispatch once.
            void Promise.resolve(ready).catch(reportClearError)
              .then(() => bridge.call(name, args, callback)).catch(reportClearError);
            return;
          }
        } catch (error) { reportClearError(error); }
      }
      if (name === 'audioplayer.load') bridge.load = args;
      if (name === 'audioplayer.init' && args?.[0] === 'device') bridge.customOutput = !!args[1];
      if (name === 'audioplayer.enableAudioData') bridge.audioDataEnabled = !!args?.[0];
      try { if (bridge.handle?.(name, callback, args || [])) return; }
      catch (error) { bridge.report?.(error); }
      return bridge.call(name, args, callback);
    };
    bridge.hooked = true;
  }
  // Hook synchronous channel assignment as well as an already initialized bridge.
  const descriptor = Object.getOwnPropertyDescriptor(window, 'channel');
  if (!window.channel && (!descriptor || descriptor.configurable)) {
    let value;
    Object.defineProperty(window, 'channel', {
      configurable: true, enumerable: true,
      get: () => descriptor?.get ? descriptor.get.call(window) : value,
      set(next) { if (descriptor?.set) descriptor.set.call(window, next); else value = next; install(); },
    });
  }
  install();
  if (!bridge.hooked) {
    let attempts = 0;
    const retry = setInterval(() => {
      install();
      if (bridge.hooked || ++attempts >= 500) clearInterval(retry);
    }, 10);
  }
})();
