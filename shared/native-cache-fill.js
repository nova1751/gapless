/* MIT. Bounded native disk fill; metadata only, foreground output always wins. */
(() => {
  'use strict';
  class NativeCacheFill {
    constructor({ cache, queue, snapshot, safe, trace }) {
      Object.assign(this, { cache, queue, snapshot, safe, trace });
      this.retired = []; this.states = new WeakMap(); this.job = null; this.after = 0; this.preferRetired = true;
    }
    state(entry) {
      if (!this.states.has(entry)) this.states.set(entry, { stalls: 0, retryAt: 0, complete: false });
      return this.states.get(entry);
    }
    remember(entry, account, quality) {
      const points = entry?.stream?.seekPoints;
      if (entry?.origin !== 'native-source' || !Array.isArray(points) || !points.length || points.length > 65536) return;
      const state = this.state(entry); if (state.complete) return;
      const key = String(entry.source.songId) + ':' + entry.hash;
      this.retired = this.retired.filter(item => item.key !== key);
      this.retired.push({ key, source: { ...entry.source, _gpAccount: account },
        points: points.map(point => ({ sample: point.sample, offset: point.offset })), rate: entry.spec.rate,
        account, quality, generation: this.cache.generation, expires: performance.now() + 600000, state: { ...state } });
      while (this.retired.length > 2) this.retired.shift();
    }
    allows(source) {
      const s = this.snapshot();
      return this.retired.some(item => item.generation === this.cache.generation && item.expires > performance.now()
        && item.account === s?.account && item.quality === s?.quality
        && String(item.source.songId) === String(source.songId) && item.source.md5 === source.md5
        && item.source.level === source.level && Number(item.source.size) === Number(source.size));
    }
    cancel() { this.job?.controller.abort(); }
    clear() { this.cancel(); this.retired.length = 0; this.states = new WeakMap(); }
    retry(entry) { if (entry) { const s = this.state(entry); s.stalls = 0; s.retryAt = 0; } }
    defer(owner) {
      owner.state.stalls = Math.min(6, owner.state.stalls + 1);
      owner.state.retryAt = performance.now() + Math.min(30000, 1000 * 2 ** (owner.state.stalls - 1));
      this.trace('native-cache-fill-wait', { id: String(owner.source.songId), attempts: owner.state.stalls, suspended: owner.state.stalls >= 6 });
    }
    maybe() {
      const s = this.snapshot();
      if (!s || !this.safe(s)) { this.cancel(); return; }
      const foreground = s.owner, entry = s.entry;
      this.retired = this.retired.filter(item => !item.state.complete && item.generation === this.cache.generation
        && item.expires > performance.now() && item.account === s.account && item.quality === s.quality
        && !(String(item.source.songId) === String(entry.source.songId) && item.source.md5 === entry.source.md5));
      if (this.job || performance.now() < this.after || this.queue.running || this.queue.queue.length) return;
      const eligible = owner => !owner.state.complete && owner.state.stalls < 6 && performance.now() >= owner.state.retryAt;
      const current = { source: { ...entry.source, _gpAccount: s.account }, points: entry.stream.seekPoints,
        rate: entry.spec.rate, state: this.state(entry) };
      const retired = this.retired.find(eligible);
      const owner = retired && (this.preferRetired || !eligible(current)) ? retired : eligible(current) ? current : retired;
      if (!owner) return;
      this.preferRetired = owner === current;
      const job = this.job = { controller: new AbortController(), owner };
      const signal = job.controller.signal, generation = this.cache.generation;
      const valid = () => !signal.aborted && this.snapshot()?.owner === foreground && this.safe(this.snapshot())
        && generation === this.cache.generation && (owner === current || this.retired.includes(owner));
      const timer = setTimeout(() => { if (valid()) this.defer(owner); job.controller.abort(); }, 8000);
      void (async () => {
        try {
          const coverage = await this.cache.snapshotSource(owner.source, signal);
          if (!valid()) return;
          if (coverage?.complete) { owner.state.complete = true; return; }
          const gap = coverage ? globalThis.GaplessCacheCoverage.missing(coverage)[0] : [0, owner.source.size];
          if (!gap) return;
          const target = globalThis.GaplessCacheCoverage.seekBefore(gap[0], owner.points, owner.rate);
          const result = await this.queue.request({ source: owner.source, position: target, signal,
            priority: globalThis.WindowsNativeCachePriority.fill, budgetMs: Math.min(2000, 500 * 2 ** owner.state.stalls) });
          if (!valid()) return;
          const covered = value => value?.ranges.reduce((sum, [start, end]) => sum + end - start, 0) || 0;
          if (result?.complete || covered(result) > covered(coverage)) { owner.state.stalls = 0; owner.state.retryAt = 0; }
          else this.defer(owner);
          if (result?.complete) {
            owner.state.complete = true;
            this.trace('native-cache-complete', { id: String(owner.source.songId), retired: owner !== current });
          } else this.trace('native-cache-fill-progress', { id: String(owner.source.songId), retired: owner !== current,
            beforeBytes: covered(coverage), afterBytes: covered(result), position: target });
        } catch (error) {
          if (valid() && !/^native-cache-(preempted|cleared|cancelled)$/.test(error.message)) this.defer(owner);
        } finally { clearTimeout(timer); if (this.job === job) this.job = null; this.after = performance.now() + 500; }
      })();
    }
    status() { return { filling: !!this.job, fillId: this.job ? String(this.job.owner.source.songId) : null,
      pendingPrevious: this.retired.length, retiredStalls: this.retired.map(item => item.state.stalls) }; }
  }
  globalThis.GaplessNativeCacheFill = NativeCacheFill;
})();
