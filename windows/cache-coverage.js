/* MIT. Read-only native cache coverage; file length is never proof of data. */
(() => {
  'use strict';
  function parse(text, expectedSize) {
    if (!Number.isSafeInteger(expectedSize) || expectedSize <= 0) throw new Error('cache-size');
    if (typeof text !== 'string' || text.length > 1024 * 1024) throw new Error('cache-index-size');
    const index = JSON.parse(text);
    if (Number(index.size) !== expectedSize || !Array.isArray(index.zone) || index.zone.length > 16384)
      throw new Error('cache-index-identity');
    const ranges = index.zone.map(zone => {
      if (typeof zone !== 'string' || !/^\d+ \d+$/.test(zone)) throw new Error('cache-index-range');
      const [start, inclusiveEnd] = zone.split(' ').map(Number);
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(inclusiveEnd)
        || start < 0 || inclusiveEnd < start || inclusiveEnd >= expectedSize) throw new Error('cache-index-bounds');
      return [start, inclusiveEnd + 1];
    }).sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const range of ranges) {
      const last = merged[merged.length - 1];
      if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
      else merged.push(range);
    }
    return Object.freeze({ size: expectedSize, ranges: Object.freeze(merged.map(Object.freeze)),
      complete: merged.length === 1 && merged[0][0] === 0 && merged[0][1] === expectedSize });
  }
  function missing(coverage, start = 0, end = coverage.size) {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)
      || start < 0 || end < start || end > coverage.size) throw new Error('cache-request-bounds');
    const gaps = []; let cursor = start;
    for (const [left, right] of coverage.ranges) {
      if (right <= cursor) continue;
      if (left >= end) break;
      if (left > cursor) gaps.push([cursor, left]);
      cursor = Math.min(end, Math.max(cursor, right));
    }
    if (cursor < end) gaps.push([cursor, end]);
    return gaps;
  }
  // Seek to a verified frame at/before a byte gap, never estimate VBR time.
  function seekBefore(byteOffset, points, rate) {
    if (!Number.isSafeInteger(byteOffset) || byteOffset < 0 || !Number.isSafeInteger(rate) || rate <= 0
      || !Array.isArray(points) || !points.length) throw new Error('cache-seek-input');
    let previous = null, selected = null;
    for (const point of points) {
      if (!Number.isSafeInteger(point.offset) || !Number.isSafeInteger(point.sample)
        || point.offset < 0 || point.sample < 0
        || (previous && (point.offset <= previous.offset || point.sample <= previous.sample)))
        throw new Error('cache-seek-index');
      if (point.offset <= byteOffset) selected = point;
      previous = point;
    }
    // Metadata preceding the first frame is acquired with the native Load.
    return selected ? selected.sample / rate : 0;
  }
  globalThis.GaplessCacheCoverage = Object.freeze({ parse, missing, seekBefore });
})();
