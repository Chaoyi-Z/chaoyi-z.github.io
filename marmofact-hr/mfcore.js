// MarmoFACT core for the browser: everything the web monitor does that is
// not UI or Bluetooth.
//
// A line-for-line port of iOS_HRMonitor/MarmoFACTCore (Packets.swift,
// WireLog.swift, BeatDetector.swift, SpeciesClassifier.swift), which are
// themselves ports of hostlib/packets.py, wirelog.py and ppgdetect.py. The
// Python is the reference: if this file disagrees with it, this file has a
// bug. test/tests.js checks it against the same vectors the Swift tests use.
//
// A classic script, not an ES module, so index.html works when opened
// straight from disk (Chrome refuses module imports over file://). It defines
// one global, MF.

(function (root) {
  "use strict";

  // ---------------------------------------------------------------- protocol

  const Board = {
    deviceName: "HealthMonitor1",
    serviceUUID: "12345678-1234-1234-1234-123456789abc",
    dataCharUUID: "12345678-1234-1234-1234-123456789abd",
    cmdCharUUID: "12345678-1234-1234-1234-123456789abe",
    rawCharUUID: "12345678-1234-1234-1234-123456789abf",
    rawMagicV1: 0xa5,
    rawMagicV2: 0xa6,
    rawMagicV3: 0xa7,
    imuMagicV1: 0xa8,
    adcMask: 0x7ffff, // 19 bits, MSB at bit 18
    adcCeiling: 524287,
    imuLSBPerG: 4096, // +/-8 g over int16
    ledMAPerCode: 0.2, // LEDx_PA codes
    legacySampleRate: 300, // nominal Hz of 0xA5
  };

  const le16 = (b, o) => b[o] | (b[o + 1] << 8);
  const le32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
  const les16 = (b, o) => {
    const v = le16(b, o);
    return v >= 0x8000 ? v - 0x10000 : v;
  };

  /// "HR=83,PI=1.4,OPT=dark" -> {HR: 83, PI: "1.4", OPT: "dark"}. Keys are
  /// upper-cased; values that parse as an integer become numbers, the rest stay
  /// text (as StatusValue in Swift: PI arrives as text, read it with Number()).
  function parseStatus(text) {
    const out = {};
    for (const kv of String(text).trim().split(",")) {
      const eq = kv.indexOf("=");
      if (eq < 0) continue;
      const key = kv.slice(0, eq).trim().toUpperCase();
      const val = kv.slice(eq + 1).trim();
      out[key] = /^[+-]?\d+$/.test(val) ? parseInt(val, 10) : val;
    }
    return out;
  }

  /// A binary RAW packet, or null if it is not one.
  ///
  /// v1/v2 header: magic u8, n u8, nb u8, seq u32, t0 u32, dt u16  (13 B)
  /// v3 inserts slots u8 after nb, then the same seq/t0/dt         (14 B)
  ///
  /// In v3 the PPG slots are BIG-endian: they are the MAX86916 FIFO bytes
  /// verbatim. Everything else, in every version, is little-endian.
  function parseRaw(b) {
    if (b.length < 3) return null;
    const magic = b[0];
    let n = b[1];
    let nb = b[2];

    if (magic === Board.rawMagicV3) {
      if (b.length < 14) return null;
      const slots = b[3];
      if (slots < 1 || slots > 4) return null;
      const seq = le32(b, 4), t0 = le32(b, 8), dt = le16(b, 12);
      let off = 14;
      const stride = slots * 3;
      // A truncated notify: keep what actually arrived.
      const avail = b.length - off;
      if (n * stride + nb * 4 > avail) {
        n = Math.max(0, Math.floor(avail / stride));
        nb = Math.max(0, Math.min(nb, Math.floor((avail - n * stride) / 4)));
      }
      const channels = [];
      for (let k = 0; k < slots; k++) channels.push(new Array(n));
      for (let i = 0; i < n; i++) {
        const base = off + i * stride;
        for (let k = 0; k < slots; k++) {
          const o = base + k * 3;
          channels[k][i] = ((b[o] << 16) | (b[o + 1] << 8) | b[o + 2]) & Board.adcMask;
        }
      }
      off += n * stride;
      const beats = [];
      for (let j = 0; j < nb; j++) beats.push(le32(b, off + 4 * j));
      return frame(magic, seq, t0, dt, slots, channels, beats);
    }

    if ((magic !== Board.rawMagicV1 && magic !== Board.rawMagicV2) || b.length < 13) return null;
    const sb = magic === Board.rawMagicV2 ? 3 : 4;
    const seq = le32(b, 3), t0 = le32(b, 7), dt = le16(b, 11);
    let off = 13;
    const avail = b.length - off;
    if (2 * n * sb + nb * 4 > avail) {
      n = Math.min(n, Math.floor(Math.floor(avail / sb) / 2));
      nb = Math.max(0, Math.min(nb, Math.floor((avail - 2 * n * sb) / 4)));
    }
    const sample = (o) => (sb === 3 ? b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) : le32(b, o));
    const ir = [], red = [];
    for (let i = 0; i < n; i++) ir.push(sample(off + sb * i));
    off += sb * n;
    for (let i = 0; i < n; i++) red.push(sample(off + sb * i));
    off += sb * n;
    const beats = [];
    for (let j = 0; j < nb; j++) beats.push(le32(b, off + 4 * j));
    return frame(magic, seq, t0, dt, 2, [ir, red], beats);
  }

  function frame(magic, seq, t0, dt, slots, channels, beats) {
    const count = channels.length ? channels[0].length : 0;
    return {
      magic, seq, t0, slots, channels, beats, count,
      dt: dt !== 0 ? dt : 1000 / Board.legacySampleRate,
      ir: channels[0],
      red: slots > 1 ? channels[1] : new Array(count).fill(0),
      green: slots > 2 ? channels[2] : null,
    };
  }

  /// magic 0xA8 | n u8 | seq u32 | n * (int16 x, y, z, u32 ppg_index), all LE.
  function parseImu(b) {
    if (b.length < 6 || b[0] !== Board.imuMagicV1) return null;
    let n = b[1];
    const seq = le32(b, 2);
    const off = 6;
    if (n * 10 > b.length - off) n = Math.max(0, Math.floor((b.length - off) / 10));
    const samples = [];
    for (let i = 0; i < n; i++) {
      const o = off + i * 10;
      samples.push({ ppgIndex: le32(b, o + 6), ax: les16(b, o), ay: les16(b, o + 2), az: les16(b, o + 4) });
    }
    return { seq, samples };
  }

  const Command = {
    start: "START",
    stop: "STOP",
    species: (s) => "SPECIES:" + s.toUpperCase(),
    /// LED currents as 0...255 codes of 0.2 mA. Board default 50,50,50 = 10 mA.
    led(ir, red, green) {
      const v = [ir, red, green];
      if (!v.every((x) => Number.isInteger(x) && x >= 0 && x <= 255)) return null;
      return "LED:" + v.join(",");
    },
  };

  /// How much of the waveform arrived, from the device timebase. A port of
  /// receiver.Coverage: frame i+1 must begin where frame i ended, at t0 + n*dt;
  /// anything beyond that is samples that existed on the chip and never got out.
  class Coverage {
    constructor() {
      this.frames = 0; this.samples = 0; this.missing = 0;
      this.seqRestarts = 0; this.imuFrames = 0; this.unparsed = 0;
      this.dtMs = null; this._next = null; this._lastSeq = null;
    }
    feed(b) {
      this.frames += 1;
      if (b.length && b[0] === Board.imuMagicV1) { this.imuFrames += 1; return; }
      if (b.length < 14 || b[0] !== Board.rawMagicV3) { this.unparsed += 1; return; }
      const n = b[1], seq = le32(b, 4), t0 = le32(b, 8), dt = le16(b, 12);
      if (dt <= 0 || n <= 0) { this.unparsed += 1; return; }
      this.dtMs = dt;
      this.samples += n;
      if (this._lastSeq !== null && seq < this._lastSeq) {
        this.seqRestarts += 1;
        this._next = null; // a new run: its t0 starts over
      }
      this._lastSeq = seq;
      if (this._next !== null) {
        const gap = t0 - this._next;
        if (gap > 0) this.missing += Math.trunc(gap / dt);
      }
      this._next = t0 + n * dt;
    }
    /// Same definition as wireframe.coverage_pct: two decimals, null if empty.
    get percent() {
      const total = this.samples + this.missing;
      if (total <= 0) return null;
      return Math.round((10000 * this.samples) / total) / 100;
    }
  }

  // ---------------------------------------------------------------- wire log
  //
  // The close-to-wire archive, in the format of hostlib/wirelog.py, so
  //     python hostlib/replay.py <file.mfwl> -o out/
  // builds the same hr_*.csv from a browser capture as from the rig.
  //
  //   magic "MFWL" | version u16 | reserved u16 | mlen u32 | manifest JSON
  //   records: kind u8 | flags u8 | length u16 | t_epoch f64 | t_mono f64
  //            | payload | crc32 of the 20-byte header AND the payload

  const WireKind = { status: 1, raw: 2, event: 3, command: 4 };

  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[i] = c >>> 0;
    }
    return t;
  })();

  /// zlib.crc32.
  function crc32(bytes, seed = 0) {
    let c = ~seed >>> 0;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return ~c >>> 0;
  }

  // TextEncoder/Decoder exist in every browser; the fallbacks are for the
  // bare JavaScript engines the tests run in.
  const utf8 = (s) => typeof TextEncoder !== "undefined" ? new TextEncoder().encode(s)
    : Uint8Array.from(unescape(encodeURIComponent(s)), (c) => c.charCodeAt(0));
  const fromUtf8 = (b) => typeof TextDecoder !== "undefined" ? new TextDecoder().decode(b)
    : decodeURIComponent(escape(String.fromCharCode.apply(null, Array.from(b))));

  /// JSON with sorted keys at every level, as json.dumps(sort_keys=True).
  function sortedJSON(v) {
    if (Array.isArray(v)) return "[" + v.map(sortedJSON).join(",") + "]";
    if (v && typeof v === "object") {
      return "{" + Object.keys(v).sort().filter((k) => v[k] !== undefined)
        .map((k) => JSON.stringify(k) + ":" + sortedJSON(v[k])).join(",") + "}";
    }
    return JSON.stringify(v === undefined ? null : v);
  }

  const WireLog = {
    schema: 1,
    header(manifest) {
      const m = Object.assign({}, manifest);
      if (m.schema === undefined) m.schema = WireLog.schema;
      const blob = utf8(sortedJSON(m));
      const out = new Uint8Array(12 + blob.length);
      out.set(utf8("MFWL"), 0);
      const dv = new DataView(out.buffer);
      dv.setUint16(4, WireLog.schema, true);
      dv.setUint16(6, 0, true);
      dv.setUint32(8, blob.length, true);
      out.set(blob, 12);
      return out;
    },
    record(kind, payload, tEpoch, tMono) {
      const len = Math.min(payload.length, 0xffff);
      const out = new Uint8Array(20 + payload.length + 4);
      const dv = new DataView(out.buffer);
      out[0] = kind; out[1] = 0;
      dv.setUint16(2, len, true);
      dv.setFloat64(4, tEpoch, true);
      dv.setFloat64(12, tMono, true);
      out.set(payload, 20);
      dv.setUint32(20 + payload.length, crc32(out.subarray(0, 20 + payload.length)), true);
      return out;
    },
  };

  /// Wall clock and a monotonic clock, in seconds, at the moment of the call.
  function now() {
    const mono = performance.now();
    return { epoch: (performance.timeOrigin + mono) / 1000, mono: mono / 1000 };
  }

  /// An in-memory capture, handed to the user as a file when it stops. About
  /// 10 MB an hour at 250 Hz with three channels.
  class WireLogWriter {
    constructor(name, manifest) {
      const t = new Date();
      const m = Object.assign({}, manifest);
      if (m.created_epoch === undefined) m.created_epoch = t.getTime() / 1000;
      if (m.created_iso === undefined) m.created_iso = isoLocal(t);
      this.name = name;
      this.chunks = [WireLog.header(m)];
      this.records = 0;
      this.size = this.chunks[0].length;
      this.closed = false;
    }
    append(kind, payload, tEpoch, tMono) {
      if (this.closed) return;
      if (tEpoch === undefined) { const t = now(); tEpoch = t.epoch; tMono = t.mono; }
      const rec = WireLog.record(kind, payload, tEpoch, tMono);
      this.chunks.push(rec);
      this.records += 1;
      this.size += rec.length;
    }
    event(what, fields = {}) {
      this.append(WireKind.event, utf8(sortedJSON(Object.assign({}, fields, { event: what }))));
    }
    command(text) { this.append(WireKind.command, utf8(text)); }
    /// The whole file so far, as one Uint8Array.
    bytes() {
      const out = new Uint8Array(this.size);
      let o = 0;
      for (const c of this.chunks) { out.set(c, o); o += c.length; }
      return out;
    }
    close() { this.closed = true; return new Blob(this.chunks, { type: "application/octet-stream" }); }
  }

  function isoLocal(d) {
    const p = (x) => String(x).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }

  /// Read a capture back: manifest, records, and whether it is intact.
  function readWireLog(b) {
    if (b.length < 12 || String.fromCharCode(b[0], b[1], b[2], b[3]) !== "MFWL") throw new Error("not an MFWL file");
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const mlen = dv.getUint32(8, true);
    if (b.length < 12 + mlen) throw new Error("truncated header");
    let manifest = {};
    try { manifest = JSON.parse(fromUtf8(b.subarray(12, 12 + mlen))); } catch (e) { /* keep {} */ }
    const records = [];
    let crcErrors = 0, off = 12 + mlen;
    while (off < b.length) {
      if (off + 20 > b.length) break;
      const len = dv.getUint16(off + 2, true);
      if (off + 20 + len + 4 > b.length) break;
      const body = b.subarray(off, off + 20 + len);
      if (crc32(body) !== dv.getUint32(off + 20 + len, true)) { crcErrors += 1; break; }
      records.push({
        kind: b[off], tEpoch: dv.getFloat64(off + 4, true), tMono: dv.getFloat64(off + 12, true),
        payload: b.slice(off + 20, off + 20 + len),
      });
      off += 20 + len + 4;
    }
    const trailingBytes = b.length - off;
    return { manifest, records, crcErrors, trailingBytes, intact: crcErrors === 0 && trailingBytes === 0 };
  }

  // ---------------------------------------------------------------- species

  const Species = { marmoset: "marmoset", human: "human" };

  const Profiles = {
    human: { hrMin: 30, hrMax: 220, refractoryMs: 300, maxIbiChangePct: 20, useGreen: false },
    // The chaired animal sat at 350-430 bpm; 400 cut real beats. Green: on the
    // trimmed tail its pulse was 4x IR's fraction of DC and ~5x the SNR.
    marmoset: { hrMin: 150, hrMax: 480, refractoryMs: 100, maxIbiChangePct: 20, useGreen: true },
  };

  // ---------------------------------------------------------------- filter

  /// The filter scipy.signal.butter(2, [lo, hi], btype="band", fs=fs) designs,
  /// as two biquads {b0,b1,b2,a1,a2} with zeros at z = +1 and z = -1.
  function bandpass2(lowHz, highHz, fs) {
    const C = (re, im) => ({ re, im });
    const add = (a, b) => C(a.re + b.re, a.im + b.im);
    const sub = (a, b) => C(a.re - b.re, a.im - b.im);
    const mul = (a, b) => C(a.re * b.re - a.im * b.im, a.re * b.im + a.im * b.re);
    const scale = (a, k) => C(a.re * k, a.im * k);
    const div = (a, b) => {
      const d = b.re * b.re + b.im * b.im;
      return C((a.re * b.re + a.im * b.im) / d, (a.im * b.re - a.re * b.im) / d);
    };
    const csqrt = (a) => {
      const r = Math.sqrt(a.re * a.re + a.im * a.im);
      const s = Math.sqrt((r + a.re) / 2), t = Math.sqrt((r - a.re) / 2);
      return C(s, a.im < 0 ? -t : t);
    };
    const fs2 = 2 * fs;
    const wl = fs2 * Math.tan((Math.PI * lowHz) / fs);
    const wh = fs2 * Math.tan((Math.PI * highHz) / fs);
    const bw = wh - wl, w0sq = wl * wh;
    const p = C(-1 / Math.SQRT2, 1 / Math.SQRT2);
    const half = scale(p, bw / 2);
    const disc = csqrt(sub(mul(half, half), C(w0sq, 0)));
    const analog = [add(half, disc), sub(half, disc)];
    const F = C(fs2, 0);
    const zPoles = analog.map((s) => div(add(F, s), sub(F, s)));
    let den = C(1, 0);
    for (const s of analog) den = mul(den, sub(F, s));
    for (const s of analog) den = mul(den, sub(F, C(s.re, -s.im)));
    const kDigital = (bw * bw * fs2 * fs2) / den.re;
    const g = Math.sqrt(Math.abs(kDigital)) * (kDigital < 0 ? -1 : 1);
    return zPoles.map((z, i) => {
      const k = i === 0 ? g : kDigital / g;
      return { b0: k, b1: 0, b2: -k, a1: -2 * z.re, a2: z.re * z.re + z.im * z.im };
    });
  }

  function sosRun(sos, x, zi) {
    const y = x.slice();
    sos.forEach((q, s) => {
      let z1 = zi[s][0], z2 = zi[s][1];
      for (let i = 0; i < y.length; i++) {
        const xi = y[i];
        const yi = q.b0 * xi + z1;
        z1 = q.b1 * xi - q.a1 * yi + z2;
        z2 = q.b2 * xi - q.a2 * yi;
        y[i] = yi;
      }
    });
    return y;
  }

  /// Steady-state initial conditions for a unit step (scipy sosfilt_zi).
  function steadyZi(sos) {
    let scale = 1;
    return sos.map((q) => {
      const dc = (q.b0 + q.b1 + q.b2) / (1 + q.a1 + q.a2);
      const z2 = (q.b2 - q.a2 * dc) * scale;
      const z1 = (dc - q.b0) * scale;
      scale *= dc;
      return [z1, z2];
    });
  }

  /// Zero-phase filtering, as scipy filtfilt: odd extension of 3*(order+1)
  /// samples at each end, steady-state start, forward, then backward.
  function filtfilt(sos, x) {
    if (x.length <= 1) return x.slice();
    const n = x.length;
    const padlen = Math.min(3 * (2 * sos.length + 1), n - 1);
    const ext = [];
    for (let i = padlen; i > 0; i--) ext.push(2 * x[0] - x[i]);
    for (let i = 0; i < n; i++) ext.push(x[i]);
    if (padlen > 0) for (let i = 1; i <= padlen; i++) ext.push(2 * x[n - 1] - x[n - 1 - i]);
    const zi = steadyZi(sos);
    const f = sosRun(sos, ext, zi.map((z) => z.map((v) => v * ext[0])));
    f.reverse();
    const b = sosRun(sos, f, zi.map((z) => z.map((v) => v * f[0])));
    b.reverse();
    return b.slice(padlen, padlen + n);
  }

  /// scipy.signal.find_peaks(x, distance=, prominence=): local maxima
  /// (plateaus at their middle), thinned to `distance` keeping the tallest
  /// first, then a minimum prominence.
  function findPeaks(x, distance, prominence) {
    const n = x.length;
    if (n < 3) return [];
    let peaks = [];
    let i = 1;
    while (i < n - 1) {
      if (x[i - 1] < x[i]) {
        let ahead = i + 1;
        while (ahead < n - 1 && x[ahead] === x[i]) ahead++;
        if (x[ahead] < x[i]) {
          peaks.push(Math.floor((i + ahead - 1) / 2));
          i = ahead;
          continue;
        }
      }
      i++;
    }
    if (distance > 1 && peaks.length > 1) {
      const keep = new Array(peaks.length).fill(true);
      // Swift sorts ascending (stable) then reverses: ties go to the later index.
      const order = peaks.map((_, j) => j).sort((a, b) => x[peaks[a]] - x[peaks[b]] || a - b).reverse();
      for (const j of order) {
        if (!keep[j]) continue;
        let k = j - 1;
        while (k >= 0 && peaks[j] - peaks[k] < distance) { keep[k] = false; k--; }
        k = j + 1;
        while (k < peaks.length && peaks[k] - peaks[j] < distance) { keep[k] = false; k++; }
      }
      peaks = peaks.filter((_, j) => keep[j]);
    }
    return peaks.filter((p) => {
      const h = x[p];
      let lmin = h, j = p - 1;
      while (j >= 0 && x[j] <= h) { lmin = Math.min(lmin, x[j]); j--; }
      let rmin = h;
      j = p + 1;
      while (j < n && x[j] <= h) { rmin = Math.min(rmin, x[j]); j++; }
      return h - Math.max(lmin, rmin) >= prominence;
    });
  }

  function median(v) {
    const s = v.slice().sort((a, b) => a - b);
    const n = s.length;
    if (!n) return NaN;
    return n % 2 === 1 ? s[(n - 1) / 2] : 0.5 * (s[n / 2 - 1] + s[n / 2]);
  }

  function stddev(v) {
    if (!v.length) return 0;
    let m = 0;
    for (const x of v) m += x;
    m /= v.length;
    let s = 0;
    for (const x of v) s += (x - m) * (x - m);
    return Math.sqrt(s / v.length);
  }

  // ---------------------------------------------------------------- detector

  const Detector = { windowS: 12, minSamples: 40, minSpanS: 3, minFs: 5 };

  /// np.interp for ascending t and ascending queries q.
  function interp(q, t, x) {
    const out = new Array(q.length);
    const last = t.length - 1;
    let j = 0;
    for (let i = 0; i < q.length; i++) {
      const v = q[i];
      if (v <= t[0]) { out[i] = x[0]; continue; }
      if (v >= t[last]) { out[i] = x[last]; continue; }
      while (t[j + 1] < v) j++;
      const t0 = t[j], t1 = t[j + 1];
      out[i] = t1 > t0 ? x[j] + ((x[j + 1] - x[j]) * (v - t0)) / (t1 - t0) : x[j];
    }
    return out;
  }

  /// The last windowS seconds, NaN dropped, linearly resampled at the mean
  /// rate onto np.arange(t0, t_end, 1/fs).
  function window(t, x, windowS) {
    if (t.length < Detector.minSamples || t.length !== x.length) return null;
    const tEnd = t[t.length - 1];
    const tt = [], xx = [];
    for (let i = 0; i < t.length; i++) {
      if (t[i] >= tEnd - windowS && !Number.isNaN(x[i])) { tt.push(t[i]); xx.push(x[i]); }
    }
    if (tt.length < Detector.minSamples) return null;
    const a = tt[0], b = tt[tt.length - 1];
    const span = b - a;
    if (span < Detector.minSpanS) return null;
    const fs = (tt.length - 1) / span;
    if (fs < Detector.minFs) return null;
    const step = 1 / fs;
    const n = Math.ceil((b - a) / step);
    const grid = new Array(n);
    for (let i = 0; i < n; i++) grid[i] = a + i * step;
    return { grid, y: interp(grid, tt, xx), fs };
  }

  /// Beats, HR and RMSSD over the window; a port of ppgdetect.detect. null
  /// means "learned nothing this run, keep what you had".
  function detect(t, x, p, windowS = Detector.windowS) {
    const w = window(t, x, windowS);
    if (!w) return null;
    const { grid, y, fs } = w;
    const lo = p.hrMin / 60;
    const hi = Math.min(p.hrMax / 60, fs / 2 - 0.2);
    if (!(hi > lo)) return null;
    const sig = y.map((v) => -v); // the beat is a trough in the light returned
    const filt = filtfilt(bandpass2(lo, hi, fs), sig);
    const sd = stddev(filt);
    const peaks = findPeaks(filt, Math.max(1, Math.trunc((fs * p.refractoryMs) / 1000)), 0.4 * sd);
    if (peaks.length < 2) return { hr: null, hrv: null, beats: [] };
    const beatT = peaks.map((i) => grid[i]);
    const ibiMin = 60000 / p.hrMax, ibiMax = 60000 / p.hrMin;
    const ibis = [];
    for (let i = 1; i < beatT.length; i++) {
      const d = (beatT[i] - beatT[i - 1]) * 1000;
      if (d > ibiMin && d < ibiMax) ibis.push(d);
    }
    if (ibis.length < 2) return { hr: null, hrv: null, beats: beatT };
    const med = median(ibis);
    const tol = (med * p.maxIbiChangePct) / 100;
    const clean = ibis.filter((v) => Math.abs(v - med) <= tol);
    if (clean.length >= 2) {
      let sq = 0;
      for (let i = 1; i < clean.length; i++) sq += Math.pow(clean[i] - clean[i - 1], 2);
      return { hr: 60000 / median(clean), hrv: Math.sqrt(sq / (clean.length - 1)), beats: beatT };
    }
    return { hr: 60000 / med, hrv: null, beats: beatT };
  }

  /// Is there a periodic pulse at all? Welch spectrum, 4 s Hann segments at
  /// 50 % overlap; the strongest local maximum inside the HR band against the
  /// median power elsewhere in 0.5-12 Hz. Under ~8 is noise.
  function spectralPulse(t, x, p, windowS = Detector.windowS) {
    const w = window(t, x, windowS);
    if (!w) return null;
    const { y, fs } = w;
    const seg = Math.min(y.length, Math.trunc(fs * 4));
    if (seg < 16) return null;
    const df = fs / seg;
    const fTop = Math.min(12, fs / 2 - 0.2);
    const kMax = Math.min(Math.trunc(seg / 2), Math.trunc(fTop / df) + 1);
    const win = new Float64Array(seg);
    for (let i = 0; i < seg; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (seg - 1));
    const cosT = [], sinT = [];
    for (let k = 0; k <= kMax; k++) {
      const om = (2 * Math.PI * k) / seg;
      const c = new Float64Array(seg), s = new Float64Array(seg);
      for (let i = 0; i < seg; i++) { c[i] = Math.cos(om * i); s[i] = Math.sin(om * i); }
      cosT.push(c); sinT.push(s);
    }
    const P = new Float64Array(kMax + 1);
    let nSeg = 0, s0 = 0;
    const step = Math.max(1, Math.trunc(seg / 2));
    const yy = new Float64Array(seg);
    while (s0 + seg <= y.length) {
      let mean = 0;
      for (let i = 0; i < seg; i++) { yy[i] = y[s0 + i]; mean += yy[i]; }
      mean /= seg;
      for (let i = 0; i < seg; i++) yy[i] = (yy[i] - mean) * win[i];
      for (let k = 0; k <= kMax; k++) {
        let re = 0, im = 0;
        const c = cosT[k], s = sinT[k];
        for (let i = 0; i < seg; i++) { re += yy[i] * c[i]; im -= yy[i] * s[i]; }
        P[k] += re * re + im * im;
      }
      nSeg++;
      s0 += step;
    }
    if (!nSeg) return null;
    for (let k = 0; k <= kMax; k++) P[k] /= nSeg;
    const lo = p.hrMin / 60;
    const hi = Math.min(p.hrMax / 60, fs / 2 - 0.2);
    const band = [];
    for (let k = 0; k <= kMax; k++) if (k * df >= lo && k * df <= hi) band.push(k);
    if (band.length < 3) return null;
    let best = null;
    for (let j = 1; j < band.length - 1; j++) {
      const v = P[band[j]];
      if (v > P[band[j - 1]] && v >= P[band[j + 1]] && (best === null || v > P[best])) best = band[j];
    }
    if (best === null) return { bpm: null, snr: 0 };
    const fp = best * df;
    const noise = [];
    for (let k = 0; k <= kMax; k++) {
      const f = k * df;
      if (f >= 0.5 && f <= fTop && Math.abs(f - fp) > 0.3 && Math.abs(f - 2 * fp) > 0.3) noise.push(P[k]);
    }
    const nm = noise.length ? median(noise) : 0;
    return { bpm: fp * 60, snr: nm > 0 ? P[best] / nm : 0 };
  }

  /// Human or marmoset, from the pulse rate. A resting human is 40-120 bpm and
  /// a marmoset 200-450: under 150 is human, over 220 marmoset, a human's 2nd
  /// to 5th harmonic in the marmoset band is recognised, and a weak pulse or
  /// the 150-220 overlap says nothing.
  ///
  /// The two mistakes are not symmetric. A human cannot produce a clear pulse
  /// at 220-480 bpm that is not a harmonic of their own heart rate, but a
  /// marmoset's breathing (30-60 a minute) shows up as a strong slow peak in
  /// the human band, strongest on IR, where the tail pulse is faint. So a
  /// clear non-harmonic marmoset-band peak wins over a stronger slow one, and
  /// across channels a marmoset verdict wins.
  const Classifier = {
    minSNR: 10, margin: 1.5, humanBelow: 150, marmosetAbove: 220,
    classify(t, x, windowS = Detector.windowS) {
      const h = spectralPulse(t, x, Profiles.human, windowS);
      const m = spectralPulse(t, x, Profiles.marmoset, windowS);
      if (!h || !m) return null;
      const C = Classifier;
      const hb = h.snr >= C.minSNR ? h.bpm : null;
      const mb = m.snr >= C.minSNR ? m.bpm : null;
      const human = () => ({ species: "human", bpm: hb, snr: h.snr });
      const marm = () => ({ species: "marmoset", bpm: mb, snr: m.snr });
      if (hb === null && mb === null) return null;
      if (mb === null) return hb < C.humanBelow ? human() : null;
      if (hb === null) return mb > C.marmosetAbove ? marm() : null;
      if (Math.abs(hb - mb) < 1e-6) return null; // the same peak, inside the overlap
      for (const k of [2, 3, 4, 5]) {
        if (Math.abs(mb - k * hb) <= 0.04 * mb && h.snr >= 0.35 * m.snr && hb < C.humanBelow) return human();
      }
      // A clear marmoset-band pulse that is not a harmonic: no human makes one,
      // so the slow peak is breathing, however strong.
      if (mb > C.marmosetAbove && m.snr >= 2 * C.minSNR) return marm();
      if (h.snr >= C.margin * m.snr && hb < C.humanBelow) return human();
      return null;
    },
    /// Several channels of the same window (IR, green): a marmoset verdict on
    /// any channel wins, since only a marmoset makes one; otherwise the
    /// clearest human verdict. Empty channels are skipped.
    classifyChannels(t, channels, windowS = Detector.windowS) {
      const v = channels.filter((x) => x.length).map((x) => Classifier.classify(t, x, windowS)).filter(Boolean);
      const best = (list) => list.reduce((a, b) => (!a || b.snr > a.snr ? b : a), null);
      return best(v.filter((x) => x.species === "marmoset")) || best(v);
    },
  };

  root.MF = {
    Board, parseStatus, parseRaw, parseImu, Command, Coverage,
    WireKind, crc32, utf8, fromUtf8, sortedJSON, WireLog, WireLogWriter, readWireLog, now,
    Species, Profiles, bandpass2, filtfilt, findPeaks, median, stddev,
    Detector, detect, spectralPulse, Classifier,
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
