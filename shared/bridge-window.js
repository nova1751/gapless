/* MIT. Platform-independent boundaries for a single temporary A -> B bridge. */
(() => {
  'use strict';
  class BridgeWindow {
    constructor({ tail = 10, head = 10, minimum = 0.5 } = {}) {
      this.tail = tail; this.head = head; this.minimum = minimum;
    }
    canEnter(duration, position) {
      const remaining = duration - position;
      return Number.isFinite(remaining) && position >= 0
        && remaining <= this.tail && remaining >= this.minimum;
    }
    shouldReturn(duration, position) {
      return Number.isFinite(position) && position >= Math.max(0, Math.min(this.head, duration - this.minimum));
    }
  }
  globalThis.GaplessBridgeWindow = BridgeWindow;
})();
