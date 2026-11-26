/* MIT. One native acquisition lane, bounded queue, priority and clear barrier. */
(() => {
  'use strict';
  const PRIORITY = Object.freeze({ fill: 10, next: 30, playback: 60, seek: 100 });
  class NativeCacheQueue {
    constructor(session) {
      this.session = session; this.queue = []; this.running = null;
      this.generation = 0; this.serial = 0; this.closed = false;
    }
    request({ source, position, signal, priority = PRIORITY.playback, budgetMs = 500, wantRange = null }) {
      if (this.closed || signal?.aborted) return Promise.reject(new Error('native-cache-cancelled'));
      if (!signal || !Object.values(PRIORITY).includes(priority)) return Promise.reject(new Error('native-cache-priority'));
      if (this.queue.length >= 32) return Promise.reject(new Error('native-cache-queue-full'));
      const task = { source, position, signal, priority, budgetMs, wantRange, order: ++this.serial,
        generation: this.generation, controller: new AbortController(), settled: false };
      const promise = new Promise((resolve, reject) => { task.resolve = resolve; task.reject = reject; });
      task.abort = () => {
        task.controller.abort(); this.finish(task, new Error('native-cache-cancelled'));
        const index = this.queue.indexOf(task); if (index >= 0) this.queue.splice(index, 1);
      };
      signal.addEventListener('abort', task.abort, { once: true });
      this.queue.push(task);
      this.queue.sort((a, b) => b.priority - a.priority || a.order - b.order);
      if (this.running && this.running.priority < priority) {
        // No implicit resubmission: the owner must revalidate the source and
        // still-missing ranges before restarting a preempted background fill.
        this.running.controller.abort();
        this.finish(this.running, new Error('native-cache-preempted'));
      }
      this.pump(); return promise;
    }
    finish(task, error, value) {
      if (task.settled) return;
      task.settled = true; task.signal.removeEventListener('abort', task.abort);
      if (error) task.reject(error); else task.resolve(value);
    }
    pump() {
      if (this.running || this.closed) return;
      const task = this.queue.shift(); if (!task) return;
      this.running = task;
      void (async () => {
        try {
          if (task.controller.signal.aborted || task.generation !== this.generation)
            throw new Error('native-cache-cancelled');
          const value = await this.session.batch({ ...task, signal: task.controller.signal });
          if (task.generation !== this.generation || task.controller.signal.aborted)
            throw new Error('native-cache-cancelled');
          this.finish(task, null, value);
        } catch (error) { this.finish(task, error); }
        finally { if (this.running === task) this.running = null; this.pump(); }
      })();
    }
    clear() {
      this.generation++;
      for (const task of this.queue.splice(0)) {
        task.controller.abort(); this.finish(task, new Error('native-cache-cleared'));
      }
      if (this.running) {
        this.running.controller.abort(); this.finish(this.running, new Error('native-cache-cleared'));
      }
      // The session owns Stop and finalization. Keep the lane occupied until
      // its finally block finishes, so old cleanup cannot stop a newer load.
    }
    close() { this.closed = true; this.clear(); }
    status() { return { queued: this.queue.length, activePriority: this.running?.priority ?? null,
      generation: this.generation, closed: this.closed }; }
  }
  globalThis.WindowsNativeCacheQueue = NativeCacheQueue;
  globalThis.WindowsNativeCachePriority = PRIORITY;
})();
