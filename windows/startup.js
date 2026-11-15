/* MIT. Transparent Windows audio bridge with native and synthetic event paths. */
(() => {
  'use strict';
  if (window.gaplessWindowsBridge) return;
  const registrations = new Map();
  const listeners = new Set();
  const bridge = window.gaplessWindowsBridge = { registrations, listeners, load: null };
  const pending = [];
  let startupTimer;
  bridge.startup = { phase: 'waiting', held: 0, released: 0 };
  bridge.nativeTransport = { load: 0, play: 0, pause: 0, seek: 0, stop: 0, unload: 0 };
  // Unknown host configuration may briefly hold a request, never start Web.
  // The main adapter reads the durable host setting; timeout passes to native.
  const configured = () => bridge.startupEnabled !== false;
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
    bridge.flushStartup = (fallback = false) => {
      if (!fallback && !bridge.readyForStartup) return;
      clearTimeout(startupTimer);
      bridge.startup.phase = fallback ? 'native-fallback' : 'web-ready';
      for (const [name, callback, args] of pending.splice(0)) {
        bridge.startup.released++;
        if (name === 'audioplayer.load') {
          bridge.load = args;
          bridge.startupNativeId = fallback ? String(args[0]) : null;
        }
        if (!fallback) {
          try { if (bridge.handle?.(name, callback, args)) continue; }
          catch (error) { bridge.report?.(error); }
        }
        bridge.call(name, args, callback);
      }
    };
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
      if (typeof name !== 'string' || !name.startsWith('audioplayer.') || typeof handler !== 'function') return rawRegister.apply(this, arguments);
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
      if (bridge.startup.phase === 'waiting' && !bridge.readyForStartup
        && (name === 'audioplayer.load' || (pending.length && /^audioplayer\.(play|pause|seek|stop|unload)$/.test(name)))) {
        const version = window.APP_CONF?.appver;
        if (configured() && (!version || version === '3.1.43.205627')) {
          pending.push([name, callback, args || []]); bridge.startup.held++;
          if (!startupTimer) startupTimer = setTimeout(() => bridge.flushStartup(true), 2500);
          if (pending.length >= 32) bridge.flushStartup(true);
          return;
        }
        bridge.flushStartup(true);
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
