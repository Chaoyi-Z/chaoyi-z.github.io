// The web core's tests: the Swift suite (iOS_HRMonitor/MarmoFACTCore/Tests),
// on the same vectors from the Python reference, plus the classifier cases.
// Runs under any JavaScript engine: test/run.js (macOS jsc) or test/index.html
// (a browser). Returns {passed, failed}.

globalThis.MFTests = function (log) {
  const MF = globalThis.MF, V = globalThis.V;
  let passed = 0, failed = 0, current = "";
  const fail = (msg) => { failed++; log("  FAIL " + current + ": " + msg); };
  const ok = (cond, msg) => (cond ? passed++ : fail(msg));
  const eq = (a, b, msg) => {
    const sa = JSON.stringify(a), sb = JSON.stringify(b);
    sa === sb ? passed++ : fail(`${msg || ""} got ${sa.slice(0, 120)} want ${sb.slice(0, 120)}`);
  };
  const near = (a, b, tol, msg) =>
    a !== null && a !== undefined && Math.abs(a - b) <= tol ? passed++ : fail(`${msg || ""} got ${a} want ${b} (tol ${tol})`);
  const bytes = (hex) => {
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(2 * i, 2), 16);
    return out;
  };
  const le32 = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
  const test = (name, fn) => {
    current = name;
    const before = failed;
    try { fn(); } catch (e) { fail("threw " + e); }
    log((failed === before ? "ok   " : "FAIL ") + name);
  };

  // ---- packets
  test("raw v3 matches wireframe", () => {
    const f = MF.parseRaw(bytes(V.raw3));
    eq([f.magic, f.seq, f.t0, f.dt, f.slots, f.count], [0xa7, 7, 123456, 4, 3, V.raw3N]);
    eq(f.channels, V.raw3Ch, "channels");
    eq(f.ir[3], 0x01a2b3, "big-endian slot");
    eq(f.beats, [123460, 123500]);
  });
  test("raw v3 full-MTU trim", () => {
    const f = MF.parseRaw(bytes(V.raw3Full));
    eq(f.count, V.raw3FullN);
    eq(f.green[24], 24 * 7);
  });
  test("truncated notify keeps what arrived", () => {
    const f = MF.parseRaw(bytes(V.raw3).slice(0, 14 + 9 * 5 + 4));
    eq(f.count, 5);
    eq(f.ir, V.raw3Ch[0].slice(0, 5));
  });
  test("raw v2", () => {
    const f = MF.parseRaw(bytes(V.raw2));
    eq(f.ir, [1, 2, 0xffffff]); eq(f.red, [4, 5, 6]); eq(f.beats, [77]); eq(f.t0, 5000);
    eq(f.green, null);
  });
  test("imu", () => {
    const f = MF.parseImu(bytes(V.imu));
    eq(f.seq, 42);
    eq(f.samples, [{ ppgIndex: 10, ax: 4096, ay: -4096, az: 1 }, { ppgIndex: 12, ax: -1, ay: 0, az: 32767 }]);
    eq(MF.parseRaw(bytes(V.imu)), null);
  });
  test("status", () => {
    const s = MF.parseStatus("SAMPLING=1,HR=312,SPO2=-1,PI=1.4,DROP=0/3,OPT=dark");
    eq([s.HR, s.SPO2, Number(s.PI), s.DROP, s.OPT], [312, -1, 1.4, "0/3", "dark"]);
  });
  test("commands", () => {
    eq(MF.Command.led(150, 60, 150), "LED:150,60,150");
    eq(MF.Command.led(256, 0, 0), null);
    eq(MF.Command.species("marmoset"), "SPECIES:MARMOSET");
  });
  test("coverage counts a gap", () => {
    const cov = new MF.Coverage();
    const b = bytes(V.raw3);
    cov.feed(b);
    const next = b.slice();
    const t1 = 123456 + 20 * 4;
    next.set(le32(t1), 8); next[4] = 8;
    cov.feed(next);
    eq(cov.missing, 0);
    const late = next.slice();
    late.set(le32(t1 + 20 * 4 + 10 * 4), 8); late[4] = 9;
    cov.feed(late);
    eq([cov.samples, cov.missing, cov.percent], [60, 10, 85.71]);
    cov.feed(bytes(V.imu));
    eq([cov.imuFrames, cov.unparsed], [1, 0]);
  });

  // ---- wire log
  test("crc32 is zlib's", () => eq(MF.crc32(MF.utf8("123456789")), 0xcbf43926));
  test("record matches python", () => {
    const rec = MF.WireLog.record(MF.WireKind.raw, bytes(V.raw3), 1761800000.125, 12345.5);
    eq(Array.from(rec), Array.from(bytes(V.mfwlRecord)));
  });
  test("round trip", () => {
    const w = new MF.WireLogWriter("t", { tool: "test", default_species: "marmoset", created_epoch: 1, created_iso: "x" });
    w.append(MF.WireKind.event, MF.utf8(MF.sortedJSON({ event: "recording_start", t0_epoch: 1.5 })), 1, 1);
    w.append(MF.WireKind.raw, bytes(V.raw3), 10.25, 3.5);
    w.append(MF.WireKind.status, MF.utf8("SAMPLING=1,HR=300"), 11, 4);
    w.append(MF.WireKind.command, MF.utf8("START"), 12, 5);
    const r = MF.readWireLog(w.bytes());
    ok(r.intact, "intact");
    eq([r.manifest.default_species, r.manifest.schema], ["marmoset", 1]);
    eq(r.records.map((x) => x.kind), [3, 2, 1, 4]);
    eq(Array.from(r.records[1].payload), Array.from(bytes(V.raw3)));
    eq([r.records[1].tEpoch, r.records[1].tMono], [10.25, 3.5]);
    eq(JSON.parse(MF.fromUtf8(r.records[0].payload)).event, "recording_start");
  });
  test("damaged tail is reported", () => {
    const head = MF.WireLog.header({});
    const good = MF.WireLog.record(1, new Uint8Array([1, 2, 3]), 1, 1);
    const bad = MF.WireLog.record(1, new Uint8Array([4, 5, 6]), 2, 2);
    bad[21] ^= 0xff;
    const all = new Uint8Array(head.length + good.length + bad.length);
    all.set(head, 0); all.set(good, head.length); all.set(bad, head.length + good.length);
    const r = MF.readWireLog(all);
    eq([r.records.length, r.crcErrors, r.intact], [1, 1, false]);
  });

  // ---- filter and detector
  const response = (sos, f, fs) => {
    const w = (2 * Math.PI * f) / fs;
    const poly = (c0, c1, c2) => Math.hypot(c0 + c1 * Math.cos(w) + c2 * Math.cos(2 * w), -c1 * Math.sin(w) - c2 * Math.sin(2 * w));
    return sos.reduce((m, q) => (m * poly(q.b0, q.b1, q.b2)) / poly(1, q.a1, q.a2), 1);
  };
  const checkFilter = (flat, band) => {
    const ref = [];
    for (let i = 0; i < flat.length; i += 6) ref.push({ b0: flat[i], b1: flat[i + 1], b2: flat[i + 2], a1: flat[i + 4], a2: flat[i + 5] });
    const mine = MF.bandpass2(band[0], band[1], band[2]);
    for (let f = 0.1; f < 40; f += 0.37) near(response(mine, f, band[2]), response(ref, f, band[2]), 1e-9, "f=" + f);
  };
  test("butterworth matches scipy", () => {
    checkFilter(V.sosMarmoset, V.sosMarmosetBand);
    checkFilter(V.sosHuman, V.sosHumanBand);
  });
  const checkDetector = (t, x, sp, hr, hrv, beats) => {
    const r = MF.detect(t, x, MF.Profiles[sp]);
    eq(r.beats.length, beats.length, sp + " beat count");
    r.beats.forEach((b, i) => near(b, beats[i], 1e-6, sp + " beat " + i));
    near(r.hr, hr, 1e-6, sp + " hr");
    near(r.hrv, hrv, 1e-6, sp + " hrv");
  };
  test("detector matches ppgdetect", () => {
    checkDetector(V.detMarmosetT, V.detMarmosetX, "marmoset", V.detMarmosetHR, V.detMarmosetHRV, V.detMarmosetBeats);
    checkDetector(V.detHumanT, V.detHumanX, "human", V.detHumanHR, V.detHumanHRV, V.detHumanBeats);
  });
  test("spectral matches ppgdetect", () => {
    const m = MF.spectralPulse(V.detMarmosetT, V.detMarmosetX, MF.Profiles.marmoset);
    near(m.bpm, V.specMarmosetBPM, 1e-6, "marmoset bpm");
    near(m.snr, V.specMarmosetSNR, V.specMarmosetSNR * 1e-6, "marmoset snr");
    const h = MF.spectralPulse(V.detHumanT, V.detHumanX, MF.Profiles.human);
    near(h.bpm, V.specHumanBPM, 1e-6, "human bpm");
    near(h.snr, V.specHumanSNR, V.specHumanSNR * 1e-6, "human snr");
  });
  test("too little data says nothing", () => eq(MF.detect([0, 1, 2], [1, 2, 3], MF.Profiles.human), null));

  // ---- species classifier (same synthetic traces as SpeciesClassifierTests)
  const lcg = (seed) => {
    let s = BigInt(seed);
    return () => {
      s = (s * 6364136223846793005n + 1442695040888963407n) & 0xffffffffffffffffn;
      return Number(s >> 11n) / 2 ** 53;
    };
  };
  const trace = (bpm, slowBpm, slowAmp = 0, fs = 250, seconds = 12) => {
    const rnd = lcg(0x9e3779b97f4a7c15n);
    const n = Math.trunc(fs * seconds), f = bpm / 60, t = [], x = [];
    for (let i = 0; i < n; i++) {
      const s = i / fs;
      let v = 1000 * Math.sin(2 * Math.PI * f * s) + 350 * Math.sin(4 * Math.PI * f * s);
      if (slowBpm) v += slowAmp * Math.sin(((2 * Math.PI * slowBpm) / 60) * s);
      t.push(s); x.push(200000 + v + 60 * (rnd() - 0.5));
    }
    return [t, x];
  };
  const cls = (tx) => MF.Classifier.classify(tx[0], tx[1]);
  test("resting human is human", () => {
    const v = cls(trace(72));
    eq(v && v.species, "human"); near(v && v.bpm, 72, 6);
  });
  test("human whose harmonic sits in the marmoset band", () => eq((cls(trace(90)) || {}).species, "human"));
  test("marmoset is marmoset", () => {
    const v = cls(trace(380));
    eq(v && v.species, "marmoset"); near(v && v.bpm, 380, 10);
  });
  test("marmoset with breathing wander", () => eq((cls(trace(300, 70, 600)) || {}).species, "marmoset"));
  test("marmoset whose breathing dominates is still marmoset", () =>
    eq((cls(trace(380, 45, 3000)) || {}).species, "marmoset"));
  test("a marmoset verdict on any channel wins", () => {
    const [t, ir] = trace(52), green = trace(380)[1];
    eq((MF.Classifier.classifyChannels(t, [ir, green]) || {}).species, "marmoset");
    eq((MF.Classifier.classifyChannels(t, [ir, []]) || {}).species, "human");
  });
  test("noise says nothing", () => {
    const rnd = lcg(42);
    const t = [], x = [];
    for (let i = 0; i < 3000; i++) { t.push(i / 250); x.push(200000 + rnd() * 100); }
    eq(MF.Classifier.classify(t, x), null);
  });
  test("overlap band is undecided", () => eq(cls(trace(190)), null));

  log(`${passed} checks passed, ${failed} failed`);
  return { passed, failed };
};
