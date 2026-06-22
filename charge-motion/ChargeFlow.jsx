import { useState, useRef, useReducer, useEffect } from "react";

// =======================================================================
//  Circuit lab: charge flow (single loop) + series / parallel RLC + resonance
// =======================================================================

// ---- palette (instrument panel) ---------------------------------------
const C = {
  bg: "#0E1116", panel: "#161B22", grid: "#1B2129",
  wire: "#3A434F", conv: "#F2A93B", electron: "#56C2E6",
  trace: "#4FE08A", text: "#E6EDF3", muted: "#8B97A5", rest: "#586374",
  R: "#F2A93B", L: "#7C9CF2", Cap: "#E66FB0", res: "#4FE08A",
};
const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";
const SANS = "Inter, system-ui, -apple-system, sans-serif";

const V0 = 5; // source amplitude (V)

// =======================================================================
//  Shared little helpers
// =======================================================================
function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }

// build an arc-length parametrised polyline path
function makePath(pts, closed) {
  const seg = [];
  let tot = 0;
  const list = closed ? [...pts, pts[0]] : pts;
  for (let i = 0; i < list.length - 1; i++) {
    const a = list[i], b = list[i + 1];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    seg.push({ a, b, l });
    tot += l;
  }
  const at = (d) => {
    let x = closed ? ((d % tot) + tot) % tot : clamp(d, 0, tot);
    for (const s of seg) {
      if (x <= s.l) {
        const u = s.l === 0 ? 0 : x / s.l;
        return [s.a[0] + (s.b[0] - s.a[0]) * u, s.a[1] + (s.b[1] - s.a[1]) * u];
      }
      x -= s.l;
    }
    const last = seg[seg.length - 1];
    return [last.b[0], last.b[1]];
  };
  return { at, tot, closed };
}

function fmtHz(f) {
  return f >= 1000 ? (f / 1000).toFixed(2) + " kHz" : f.toFixed(0) + " Hz";
}

// =======================================================================
//  Component symbols (drawn centred at origin, then placed / rotated)
// =======================================================================
function Resistor({ x, y, dir, color }) {
  const t = `translate(${x} ${y}) rotate(${dir === "v" ? 90 : 0})`;
  return (
    <g transform={t}>
      <rect x="-9" y="-8" width="18" height="16" fill={C.panel} />
      <rect x="-16" y="-7" width="32" height="14" rx="2" fill="none" stroke={color} strokeWidth="2" />
    </g>
  );
}
function Inductor({ x, y, dir, color }) {
  const t = `translate(${x} ${y}) rotate(${dir === "v" ? 90 : 0})`;
  const r = 4;
  let d = "M -16 0";
  for (let i = 0; i < 4; i++) {
    const cx = -16 + r + i * 2 * r;
    d += ` A ${r} ${r} 0 0 1 ${cx + r} 0`;
  }
  return (
    <g transform={t}>
      <rect x="-17" y="-6" width="34" height="8" fill={C.panel} />
      <path d={d} fill="none" stroke={color} strokeWidth="2" />
    </g>
  );
}
function Capacitor({ x, y, dir, color }) {
  const t = `translate(${x} ${y}) rotate(${dir === "v" ? 90 : 0})`;
  return (
    <g transform={t}>
      <rect x="-9" y="-10" width="18" height="20" fill={C.panel} />
      <line x1="-9" y1="0" x2="-3" y2="0" stroke={C.wire} strokeWidth="2.5" />
      <line x1="3" y1="0" x2="9" y2="0" stroke={C.wire} strokeWidth="2.5" />
      <line x1="-3" y1="-9" x2="-3" y2="9" stroke={color} strokeWidth="2.4" />
      <line x1="3" y1="-9" x2="3" y2="9" stroke={color} strokeWidth="2.4" />
    </g>
  );
}
function ACSource({ x, y, color }) {
  return (
    <g>
      <circle cx={x} cy={y} r="14" fill={C.panel} stroke={color} strokeWidth="2" />
      <path d={`M ${x - 7} ${y} C ${x - 4} ${y - 7}, ${x - 1} ${y - 7}, ${x} ${y} S ${x + 5} ${y + 7}, ${x + 8} ${y}`}
        fill="none" stroke={color} strokeWidth="1.8" />
    </g>
  );
}

// =======================================================================
//  Original single-loop charge-flow view (unchanged behaviour)
// =======================================================================
const N = 24;
const GX1 = 70, GX2 = 300, GY1 = 60, GY2 = 210;
const SRC_TOP = 120, SRC_BOT = 150;
const RES_T = 117, RES_B = 153;
const SEGS = [
  { len: SRC_TOP - GY1, p: u => ({ x: GX1, y: SRC_TOP - u }) },
  { len: GX2 - GX1, p: u => ({ x: GX1 + u, y: GY1 }) },
  { len: GY2 - GY1, p: u => ({ x: GX2, y: GY1 + u }) },
  { len: GX2 - GX1, p: u => ({ x: GX2 - u, y: GY2 }) },
  { len: GY2 - SRC_BOT, p: u => ({ x: GX1, y: GY2 - u }) },
  { len: SRC_BOT - SRC_TOP, p: u => ({ x: GX1, y: SRC_BOT - u }) },
];
const LTOT = SEGS.reduce((a, s) => a + s.len, 0);
function arc(s) {
  let x = ((s % LTOT) + LTOT) % LTOT;
  for (const seg of SEGS) { if (x <= seg.len) return seg.p(x); x -= seg.len; }
  return SEGS[0].p(0);
}
function distFromSource(b) {
  const d = ((b % LTOT) + LTOT) % LTOT;
  return Math.min(d, LTOT - d);
}
const sbase = Array.from({ length: N }, (_, i) => (i * LTOT) / N);

function SimpleLoop() {
  const [playing, setPlaying] = useState(false);
  const [mode, setMode] = useState("DC");
  const [carrier, setCarrier] = useState("conv");
  const [speed, setSpeed] = useState(0.7);
  const [showInfo, setShowInfo] = useState(false);
  const [, tick] = useReducer(x => x + 1, 0);

  const ctrl = useRef({ mode, speed });
  ctrl.current = { mode, speed };
  const sim = useRef({ t: 0, G: 0, act: Array(N).fill(null), last: null });

  const Vfront = (LTOT / 2) / 1.3;
  const Vdc = 55;
  const Fac = 0.32, Wac = 2 * Math.PI * Fac, Vac = Wac * 30;

  function vel(t, m) {
    if (m === "AC") return Vac * Math.sin(Wac * t);
    const r = Math.min(t / 0.8, 1);
    return Vdc * (r * r * (3 - 2 * r));
  }
  function reset(keepPlaying) {
    sim.current = { t: 0, G: 0, act: Array(N).fill(null), last: null };
    if (!keepPlaying) setPlaying(false);
    tick();
  }
  useEffect(() => {
    if (!playing) return;
    let raf;
    sim.current.last = null;
    const loop = (ts) => {
      const s = sim.current;
      if (s.last == null) s.last = ts;
      let dt = (ts - s.last) / 1000;
      s.last = ts;
      if (dt > 0.05) dt = 0.05;
      const { mode: m, speed: sp } = ctrl.current;
      const dSim = dt * sp;
      const v = vel(s.t, m);
      s.t += dSim;
      s.G += v * dSim;
      const front = Vfront * s.t;
      for (let i = 0; i < N; i++)
        if (s.act[i] == null && distFromSource(sbase[i]) <= front) s.act[i] = s.G;
      tick();
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [playing]);
  useEffect(() => { reset(true); }, [mode, carrier]);

  const s = sim.current;
  const dir = carrier === "conv" ? 1 : -1;
  const cc = carrier === "conv" ? C.conv : C.electron;
  const front = Vfront * s.t;
  const onsetDone = front >= LTOT / 2;
  const iNow = mode === "AC" ? Vac * Math.sin(Wac * s.t)
    : (s.t > 0 ? Vdc * Math.min(s.t / 0.8, 1) : 0);
  const curSign = mode === "AC" ? (Math.sin(Wac * s.t) >= 0 ? 1 : -1) : 1;

  let status;
  if (!playing && s.t === 0) status = "停止中 — 導線には電荷が詰まっています。再生で電源が押し始めます";
  else if (!onsetDone) status = "電源を起点に押し（電界）が広がり、電荷が静止から動き出します";
  else if (mode === "DC") status = "一定の力で一方向へ。電流の大きさは時間によらず一定です";
  else if (iNow > 0.06 * Vac) status = "正の半サイクル：電荷は前進（電流は正）";
  else if (iNow < -0.06 * Vac) status = "負の半サイクル：電荷は後退（電流は負）";
  else status = "電圧が反転 — 電荷は速度ゼロで一瞬停止します";

  const charges = sbase.map((b, i) => {
    const off = s.act[i] == null ? 0 : s.G - s.act[i];
    return { ...arc(b + dir * off), on: s.act[i] != null, home: arc(b) };
  });
  const pulses = [];
  if (s.t > 0 && !onsetDone) {
    const op = 1 - front / (LTOT / 2);
    pulses.push({ ...arc(front), op });
    pulses.push({ ...arc(-front), op });
  }
  const W = 320, WH = 64, mid = WH / 2, amp = 20, span = 5 * Math.PI;
  let path = "";
  for (let px = 0; px <= W; px += 4) {
    const ph = (px / W) * span;
    const y = mid - amp * Math.sin(ph);
    path += (px === 0 ? "M" : "L") + px.toFixed(1) + " " + y.toFixed(1) + " ";
  }
  const phNow = Wac * s.t;
  const curX = ((phNow % span) / span) * W;
  const curY = mid - amp * Math.sin(phNow);

  const Chevron = ({ x, y }) => {
    const d = curSign > 0 ? 1 : -1;
    return <polyline points={`${x - 4 * d},${y - 4} ${x + 4 * d},${y} ${x - 4 * d},${y + 4}`}
      fill="none" stroke={C.muted} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" opacity="0.7" />;
  };

  return (
    <>
      <div style={{ background: C.panel, borderRadius: 12, padding: 8, border: `1px solid ${C.grid}` }}>
        <svg viewBox="0 0 360 270" style={{ width: "100%", display: "block" }}>
          <defs>
            <filter id="glow" x="-60%" y="-60%" width="220%" height="220%">
              <feGaussianBlur stdDeviation="2.4" result="b" />
              <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
            </filter>
          </defs>
          {Array.from({ length: 8 }, (_, i) => (
            <line key={"v" + i} x1={20 + i * 45} y1="20" x2={20 + i * 45} y2="250" stroke={C.grid} strokeWidth="1" />
          ))}
          {Array.from({ length: 5 }, (_, i) => (
            <line key={"h" + i} x1="20" y1={40 + i * 50} x2="340" y2={40 + i * 50} stroke={C.grid} strokeWidth="1" />
          ))}
          <g stroke={C.wire} strokeWidth="2.5" fill="none" strokeLinecap="round">
            <line x1={GX1} y1={GY1} x2={GX1} y2={SRC_TOP} />
            <line x1={GX1} y1={GY1} x2={GX2} y2={GY1} />
            <line x1={GX2} y1={GY1} x2={GX2} y2={RES_T} />
            <line x1={GX2} y1={RES_B} x2={GX2} y2={GY2} />
            <line x1={GX2} y1={GY2} x2={GX1} y2={GY2} />
            <line x1={GX1} y1={GY2} x2={GX1} y2={SRC_BOT} />
          </g>
          <rect x="291" y={RES_T} width="18" height={RES_B - RES_T} rx="2" fill={C.panel} stroke={C.wire} strokeWidth="2" />
          <text x="320" y="139" fill={C.muted} fontSize="11" fontFamily={MONO}>R</text>
          {mode === "DC" ? (
            <g stroke={cc} strokeLinecap="round">
              <line x1="56" y1="127" x2="84" y2="127" strokeWidth="2" />
              <line x1="63" y1="134" x2="77" y2="134" strokeWidth="4.5" />
            </g>
          ) : (
            <g>
              <circle cx="70" cy="135" r="15" fill={C.panel} stroke={cc} strokeWidth="2" />
              <path d="M61 135 C 64 127, 67 127, 70 135 S 76 143, 79 135" fill="none" stroke={cc} strokeWidth="1.8" />
            </g>
          )}
          <text x="48" y="118" fill={curSign > 0 ? cc : C.muted} fontSize="13" fontFamily={MONO} fontWeight="700">{curSign > 0 ? "＋" : "−"}</text>
          <text x="50" y="166" fill={curSign > 0 ? C.muted : cc} fontSize="13" fontFamily={MONO} fontWeight="700">{curSign > 0 ? "−" : "＋"}</text>
          {onsetDone && <><Chevron x={150} y={GY1} /><Chevron x={210} y={GY1} /></>}
          {mode === "AC" && charges.map((c, i) => (
            <circle key={"hm" + i} cx={c.home.x} cy={c.home.y} r="5.4" fill="none" stroke={C.rest} strokeWidth="1" opacity="0.45" />
          ))}
          {pulses.map((p, i) => (
            <circle key={"p" + i} cx={p.x} cy={p.y} r="9" fill="none" stroke={cc} strokeWidth="2" opacity={0.5 * p.op} />
          ))}
          {charges.map((c, i) => (
            <circle key={i} cx={c.x} cy={c.y} r={c.on ? 5 : 4.3} fill={c.on ? cc : C.rest}
              opacity={c.on ? 1 : 0.55} filter={c.on ? "url(#glow)" : undefined} />
          ))}
        </svg>
      </div>

      <div style={{ marginTop: 10, padding: "10px 12px", background: C.panel, borderRadius: 8,
        borderLeft: `3px solid ${cc}`, fontSize: 12.5, lineHeight: 1.5, minHeight: 18 }}>
        {status}
        {mode === "AC" && onsetDone &&
          <span style={{ color: C.muted }}> ／ 往復するだけで一周期後に元の位置へ戻ります（正味の移動はほぼゼロ）。</span>}
      </div>

      <div style={{ marginTop: 10, background: C.panel, borderRadius: 8, padding: "8px 10px", border: `1px solid ${C.grid}` }}>
        <div style={{ fontFamily: MONO, fontSize: 10.5, color: C.muted, letterSpacing: ".08em", marginBottom: 4 }}>電流 i(t) ＝ 電荷の速度</div>
        <svg viewBox={`0 0 ${W} ${WH}`} style={{ width: "100%", display: "block" }}>
          <line x1="0" y1={mid} x2={W} y2={mid} stroke={C.grid} strokeWidth="1" />
          {mode === "AC" ? (
            <>
              <path d={path} fill="none" stroke={C.trace} strokeWidth="1.6" opacity="0.85" />
              <line x1={curX} y1="2" x2={curX} y2={WH - 2} stroke={C.muted} strokeWidth="1" opacity="0.5" />
              <circle cx={curX} cy={curY} r="3.5" fill={C.trace} filter="url(#glow)" />
            </>
          ) : (
            <>
              <line x1="0" y1={mid - amp * 0.6} x2={W} y2={mid - amp * 0.6} stroke={C.trace} strokeWidth="1.6" opacity="0.85" />
              <text x={W - 6} y={mid - amp * 0.6 - 5} fill={C.muted} fontSize="9" fontFamily={MONO} textAnchor="end">一定</text>
            </>
          )}
        </svg>
      </div>

      <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={() => setPlaying(p => !p)}
            style={{ flex: 1, padding: "11px", borderRadius: 8, border: "none", cursor: "pointer",
              background: cc, color: "#0E1116", fontWeight: 700, fontSize: 14, fontFamily: SANS }}>
            {playing ? "⏸ 一時停止" : "▶ 再生"}
          </button>
          <button onClick={() => reset(false)}
            style={{ padding: "11px 16px", borderRadius: 8, cursor: "pointer", fontFamily: SANS,
              background: C.bg, color: C.muted, border: `1px solid ${C.wire}`, fontSize: 14 }}>
            ⟲ 最初から
          </button>
        </div>
        <SegBar value={mode} accent={cc} onChange={setMode}
          options={[["DC", "直流 DC"], ["AC", "交流 AC"]]} />
        <SegBar value={carrier} accent={cc} onChange={setCarrier}
          options={[["conv", "慣用電流（＋）"], ["electron", "電子（−）"]]} />
        <div>
          <Label>速さ</Label>
          <input type="range" min="0.2" max="1.8" step="0.05" value={speed}
            onChange={e => setSpeed(parseFloat(e.target.value))} style={{ width: "100%", accentColor: cc }} />
        </div>
        <button onClick={() => setShowInfo(v => !v)}
          style={{ background: "none", border: "none", color: C.muted, fontFamily: MONO,
            fontSize: 11.5, textAlign: "left", cursor: "pointer", padding: "2px 0" }}>
          {showInfo ? "▾" : "▸"} 物理メモ（正しい描像）
        </button>
        {showInfo && (
          <div style={{ background: C.panel, borderRadius: 8, padding: "12px 14px", fontSize: 12, lineHeight: 1.7, color: C.muted }}>
            ・導線には<b style={{ color: C.text }}>最初から電荷が詰まっています</b>。電源は電荷を供給するのではなく、動かす力（電界）を与えます。<br />
            ・電子のドリフトは非常に遅い（〜mm/s）。電源ONで回路全体がほぼ同時に動くのは、<b style={{ color: C.text }}>電界が光速近くで伝わる</b>から。<br />
            ・<b style={{ color: C.conv }}>慣用電流</b>＝正電荷が動く向き（＋→外部→−）。金属中の実際の担体は<b style={{ color: C.electron }}>電子</b>で、逆向きに動きます。<br />
            ・交流：電荷は往復するだけで、一周期での正味移動はほぼゼロ。電流（＝電荷の速度）が正弦波になります。
          </div>
        )}
        <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 16px", fontSize: 11, color: C.muted, fontFamily: MONO, marginTop: 2 }}>
          <span><span style={{ color: cc }}>●</span> 電荷</span>
          <span><span style={{ color: C.rest }}>●</span> 静止中</span>
          {mode === "AC" && <span><span style={{ color: C.rest }}>○</span> 元の位置</span>}
          <span>› 電流の向き</span>
        </div>
      </div>
    </>
  );
}

// =======================================================================
//  RLC view (series / parallel) with resonance
// =======================================================================

// geometry for the two topologies ---------------------------------------
const SERIES_GEO = (() => {
  const x1 = 70, x2 = 300, yt = 58, yb = 200;
  const loop = makePath([[x1, yt], [x2, yt], [x2, yb], [x1, yb]], true);
  return { x1, x2, yt, yb, loop };
})();
const PAR_GEO = (() => {
  const xs = 58, yt = 60, yb = 202;
  const bx = { R: 145, L: 212, C: 279 };
  return {
    xs, yt, yb, bx,
    src: makePath([[xs, yb], [xs, yt]], false),       // left edge (source current)
    R: makePath([[bx.R, yt], [bx.R, yb]], false),
    L: makePath([[bx.L, yt], [bx.L, yb]], false),
    C: makePath([[bx.C, yt], [bx.C, yb]], false),
  };
})();

// distribute charges along a path, displaced by q = -A cos(phase+delta)
function pathCharges(path, n, swing, phase, delta, dir) {
  const off = -swing * Math.cos(phase + delta) * dir;
  const m = path.closed ? 0 : swing + 5;          // keep inset on open paths
  const span = path.tot - 2 * m;
  const out = [];
  for (let i = 0; i < n; i++) {
    const d = m + ((i + 0.5) / n) * span;
    const p = path.at(d + off);
    out.push({ x: p[0], y: p[1] });
  }
  return out;
}

function RLCView({ topology }) {
  const series = topology === "series";
  const [playing, setPlaying] = useState(true);
  const [carrier, setCarrier] = useState("conv");
  const [speed, setSpeed] = useState(1);
  const [logr, setLogr] = useState(0);                       // ln(f / f0)
  const [R, setR] = useState(series ? 20 : 600);
  const [Lmh, setLmh] = useState(10);
  const [Cuf, setCuf] = useState(2.5);
  const [, tick] = useReducer(x => x + 1, 0);

  const sim = useRef({ t: 0, last: null });
  const ctrl = useRef({ speed });
  ctrl.current = { speed };

  useEffect(() => {
    if (!playing) return;
    let raf;
    sim.current.last = null;
    const loop = (ts) => {
      const s = sim.current;
      if (s.last == null) s.last = ts;
      let dt = (ts - s.last) / 1000;
      s.last = ts;
      if (dt > 0.05) dt = 0.05;
      s.t += dt * ctrl.current.speed;
      tick();
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  // ---- physics -------------------------------------------------------
  const Lsi = Lmh * 1e-3, Csi = Cuf * 1e-6;
  const Z0 = Math.sqrt(Lsi / Csi);                  // characteristic impedance
  const f0 = 1 / (2 * Math.PI * Math.sqrt(Lsi * Csi));
  const r = Math.exp(logr);                         // f / f0
  const f = r * f0;
  const detune = r - 1 / r;                         // 0 at resonance
  const XL = Z0 * r, XC = Z0 / r;

  function respSeries(rr) {
    const x = rr - 1 / rr;
    const Z = Math.hypot(R, Z0 * x);
    return { mag: V0 / Z, Z, phi: Math.atan2(Z0 * x, R) };
  }
  function respParallel(rr) {
    const x = rr - 1 / rr;
    const G = 1 / R, B = x / Z0;
    const Y = Math.hypot(G, B);
    return { mag: 1 / Y, Z: 1 / Y, Isrc: V0 * Y, phi: Math.atan2(B, G) };
  }
  const resp = series ? respSeries(r) : respParallel(r);
  const Qf = series ? Z0 / R : R / Z0;

  // branch / loop currents (amplitudes)
  const Iloop = series ? V0 / resp.Z : 0;
  const Imax = series ? V0 / R : 0;
  const IR = V0 / R, IL = V0 / XL, IC = V0 / XC;
  const Isrc = series ? Iloop : resp.Isrc;

  // resonance state text
  const onRes = Math.abs(r - 1) < 0.05;
  let status;
  if (series) {
    if (onRes) status = "直列共振：XL = XC でインピーダンス最小（Z = R）、電流が最大になります。";
    else if (r < 1) status = "f < f₀：容量性（XC > XL）。電流は電源電圧より進みます。";
    else status = "f > f₀：誘導性（XL > XC）。電流は電源電圧より遅れます。";
  } else {
    if (onRes) status = "並列共振：インピーダンス最大・電源電流は最小。L↔C で大きな循環電流（タンク）が流れます。";
    else if (r < 1) status = "f < f₀：誘導性（IL > IC）。L枝が優勢で電源電流は電圧より遅れます。";
    else status = "f > f₀：容量性（IC > IL）。C枝が優勢で電源電流は電圧より進みます。";
  }

  // ---- animation amplitudes -----------------------------------------
  const s = sim.current;
  const env = clamp(s.t / 0.7, 0, 1);
  const phase = 2 * Math.PI * 0.32 * s.t;            // visual oscillation
  const dir = carrier === "conv" ? 1 : -1;
  const cc = carrier === "conv" ? C.conv : C.electron;

  // ---- response curve ------------------------------------------------
  const CW = 320, CH = 86, lrMin = Math.log(0.25), lrMax = Math.log(4);
  const xOfLr = (lr) => ((lr - lrMin) / (lrMax - lrMin)) * CW;
  const Ns = 160;
  let cmax = 0;
  const cs = [];
  for (let i = 0; i <= Ns; i++) {
    const lr = lrMin + (lrMax - lrMin) * (i / Ns);
    const rr = Math.exp(lr);
    const v = series ? respSeries(rr).mag : respParallel(rr).mag;
    cs.push({ lr, v });
    if (v > cmax) cmax = v;
  }
  let cpath = "";
  cs.forEach((p, i) => {
    const px = xOfLr(p.lr);
    const py = (CH - 8) - (p.v / cmax) * (CH - 16);
    cpath += (i === 0 ? "M" : "L") + px.toFixed(1) + " " + py.toFixed(1) + " ";
  });
  const curLrX = xOfLr(logr);
  const curV = series ? resp.mag : resp.mag;
  const curY = (CH - 8) - (curV / cmax) * (CH - 16);
  const resLrX = xOfLr(0);

  // ---- phasor diagram ------------------------------------------------
  const PH = 120, pc = PH / 2, S = 44;
  let arrows;
  if (series) {
    const VR = Iloop * R, VLv = Iloop * XL, VCv = Iloop * XC;
    const mmax = Math.max(VR, VLv, VCv, V0, 1e-9);
    const k = S / mmax;
    arrows = [
      { x: 30, y: 0, col: C.rest, lab: "I", dash: true },
      { x: VR * k, y: 0, col: C.R, lab: "VR" },
      { x: 0, y: VLv * k, col: C.L, lab: "VL" },
      { x: 0, y: -VCv * k, col: C.Cap, lab: "VC" },
      { x: VR * k, y: (VLv - VCv) * k, col: C.res, lab: "V", wide: true },
    ];
  } else {
    const mmax = Math.max(IR, IL, IC, Isrc, 1e-9);
    const k = S / mmax;
    arrows = [
      { x: 30, y: 0, col: C.rest, lab: "V", dash: true },
      { x: IR * k, y: 0, col: C.R, lab: "IR" },
      { x: 0, y: IL * k, col: C.L, lab: "IL" },
      { x: 0, y: -IC * k, col: C.Cap, lab: "IC" },
      { x: Isrc * k, y: -(IC - IL) * k, col: C.res, lab: "I", wide: true },
    ];
  }

  // ---- charge layers -------------------------------------------------
  const layers = [];
  if (series) {
    const sw = 17 * env * (Iloop / Math.max(Imax, 1e-9));
    layers.push({ pts: pathCharges(SERIES_GEO.loop, 30, Math.max(sw, 1.2), phase, 0, dir), col: cc });
  } else {
    // delta: I_R in phase (0), I_C leads (+90 -> +pi/2), I_L lags (-pi/2)
    const sw = (factor) => 9 * env * clamp(factor, 0.12, 2.6);
    layers.push({ pts: pathCharges(PAR_GEO.R, 6, sw(IR / IR), phase, 0, dir), col: C.R });
    layers.push({ pts: pathCharges(PAR_GEO.L, 6, sw(IL / IR), phase, -Math.PI / 2, dir), col: C.L });
    layers.push({ pts: pathCharges(PAR_GEO.C, 6, sw(IC / IR), phase, +Math.PI / 2, dir), col: C.Cap });
    layers.push({ pts: pathCharges(PAR_GEO.src, 7, sw(Isrc / IR), phase, resp.phi, dir), col: cc });
  }

  // ---- readouts ------------------------------------------------------
  const readouts = series
    ? [
        ["共振 f₀", fmtHz(f0)], ["現在 f", fmtHz(f)],
        ["Q", Qf.toFixed(2)], ["XL", XL.toFixed(0) + " Ω"],
        ["XC", XC.toFixed(0) + " Ω"], ["|Z|", resp.Z.toFixed(0) + " Ω"],
        ["|I|", (Iloop * 1000).toFixed(0) + " mA"], ["位相 φ", (resp.phi * 180 / Math.PI).toFixed(0) + "°"],
      ]
    : [
        ["共振 f₀", fmtHz(f0)], ["現在 f", fmtHz(f)],
        ["Q", Qf.toFixed(2)], ["XL", XL.toFixed(0) + " Ω"],
        ["XC", XC.toFixed(0) + " Ω"], ["|Z|", resp.Z.toFixed(0) + " Ω"],
        ["電源電流", (Isrc * 1000).toFixed(0) + " mA"], ["位相 φ", (resp.phi * 180 / Math.PI).toFixed(0) + "°"],
      ];

  const accent = onRes ? C.res : cc;

  return (
    <>
      {/* stage */}
      <div style={{ background: C.panel, borderRadius: 12, padding: 8, border: `1px solid ${C.grid}` }}>
        <svg viewBox="0 0 360 250" style={{ width: "100%", display: "block" }}>
          <defs>
            <filter id="glow2" x="-60%" y="-60%" width="220%" height="220%">
              <feGaussianBlur stdDeviation="2.2" result="b" />
              <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
            </filter>
          </defs>
          {Array.from({ length: 8 }, (_, i) => (
            <line key={"gv" + i} x1={20 + i * 45} y1="18" x2={20 + i * 45} y2="232" stroke={C.grid} strokeWidth="1" />
          ))}
          {Array.from({ length: 5 }, (_, i) => (
            <line key={"gh" + i} x1="20" y1={30 + i * 50} x2="340" y2={30 + i * 50} stroke={C.grid} strokeWidth="1" />
          ))}

          {series ? (
            <>
              <g stroke={C.wire} strokeWidth="2.5" fill="none" strokeLinecap="round">
                <rect x={SERIES_GEO.x1} y={SERIES_GEO.yt} width={SERIES_GEO.x2 - SERIES_GEO.x1}
                  height={SERIES_GEO.yb - SERIES_GEO.yt} />
              </g>
              {layers.map((ly, li) => ly.pts.map((p, i) => (
                <circle key={"c" + li + "_" + i} cx={p.x} cy={p.y} r="4.6" fill={ly.col} filter="url(#glow2)" />
              )))}
              <ACSource x={SERIES_GEO.x1} y={(SERIES_GEO.yt + SERIES_GEO.yb) / 2} color={accent} />
              <Resistor x={185} y={SERIES_GEO.yt} dir="h" color={C.R} />
              <Inductor x={SERIES_GEO.x2} y={(SERIES_GEO.yt + SERIES_GEO.yb) / 2} dir="v" color={C.L} />
              <Capacitor x={185} y={SERIES_GEO.yb} dir="h" color={C.Cap} />
              <text x="185" y={SERIES_GEO.yt - 9} fill={C.R} fontSize="11" fontFamily={MONO} textAnchor="middle">R</text>
              <text x={SERIES_GEO.x2 + 10} y={(SERIES_GEO.yt + SERIES_GEO.yb) / 2 + 4} fill={C.L} fontSize="11" fontFamily={MONO}>L</text>
              <text x="185" y={SERIES_GEO.yb + 18} fill={C.Cap} fontSize="11" fontFamily={MONO} textAnchor="middle">C</text>
            </>
          ) : (
            <>
              <g stroke={C.wire} strokeWidth="2.5" fill="none" strokeLinecap="round">
                <line x1={PAR_GEO.xs} y1={PAR_GEO.yt} x2={PAR_GEO.bx.C} y2={PAR_GEO.yt} />
                <line x1={PAR_GEO.xs} y1={PAR_GEO.yb} x2={PAR_GEO.bx.C} y2={PAR_GEO.yb} />
                <line x1={PAR_GEO.xs} y1={PAR_GEO.yt} x2={PAR_GEO.xs} y2={PAR_GEO.yb} />
                <line x1={PAR_GEO.bx.R} y1={PAR_GEO.yt} x2={PAR_GEO.bx.R} y2={PAR_GEO.yb} />
                <line x1={PAR_GEO.bx.L} y1={PAR_GEO.yt} x2={PAR_GEO.bx.L} y2={PAR_GEO.yb} />
                <line x1={PAR_GEO.bx.C} y1={PAR_GEO.yt} x2={PAR_GEO.bx.C} y2={PAR_GEO.yb} />
              </g>
              {[PAR_GEO.bx.R, PAR_GEO.bx.L, PAR_GEO.bx.C].map((bx, i) => (
                <g key={"nd" + i}>
                  <circle cx={bx} cy={PAR_GEO.yt} r="2.6" fill={C.wire} />
                  <circle cx={bx} cy={PAR_GEO.yb} r="2.6" fill={C.wire} />
                </g>
              ))}
              {layers.map((ly, li) => ly.pts.map((p, i) => (
                <circle key={"c" + li + "_" + i} cx={p.x} cy={p.y} r="4.4" fill={ly.col} filter="url(#glow2)" />
              )))}
              <ACSource x={PAR_GEO.xs} y={(PAR_GEO.yt + PAR_GEO.yb) / 2} color={accent} />
              <Resistor x={PAR_GEO.bx.R} y={(PAR_GEO.yt + PAR_GEO.yb) / 2} dir="v" color={C.R} />
              <Inductor x={PAR_GEO.bx.L} y={(PAR_GEO.yt + PAR_GEO.yb) / 2} dir="v" color={C.L} />
              <Capacitor x={PAR_GEO.bx.C} y={(PAR_GEO.yt + PAR_GEO.yb) / 2} dir="v" color={C.Cap} />
              <text x={PAR_GEO.bx.R + 11} y={(PAR_GEO.yt + PAR_GEO.yb) / 2 + 4} fill={C.R} fontSize="11" fontFamily={MONO}>R</text>
              <text x={PAR_GEO.bx.L + 11} y={(PAR_GEO.yt + PAR_GEO.yb) / 2 + 4} fill={C.L} fontSize="11" fontFamily={MONO}>L</text>
              <text x={PAR_GEO.bx.C + 11} y={(PAR_GEO.yt + PAR_GEO.yb) / 2 + 4} fill={C.Cap} fontSize="11" fontFamily={MONO}>C</text>
            </>
          )}
          {onRes && (
            <text x="180" y="22" fill={C.res} fontSize="12" fontFamily={MONO} fontWeight="700" textAnchor="middle">⚡ 共振 RESONANCE</text>
          )}
        </svg>
      </div>

      {/* status */}
      <div style={{ marginTop: 10, padding: "10px 12px", background: C.panel, borderRadius: 8,
        borderLeft: `3px solid ${accent}`, fontSize: 12.5, lineHeight: 1.5 }}>
        {status}
      </div>

      {/* response curve */}
      <div style={{ marginTop: 10, background: C.panel, borderRadius: 8, padding: "8px 10px", border: `1px solid ${C.grid}` }}>
        <div style={{ fontFamily: MONO, fontSize: 10.5, color: C.muted, letterSpacing: ".06em", marginBottom: 4 }}>
          {series ? "周波数応答  |I|（電流） vs  f / f₀" : "周波数応答  |Z|（インピーダンス） vs  f / f₀"}
        </div>
        <svg viewBox={`0 0 ${CW} ${CH}`} style={{ width: "100%", display: "block" }}>
          {[0.5, 1, 2].map((rr) => {
            const px = xOfLr(Math.log(rr));
            return <line key={"gx" + rr} x1={px} y1="2" x2={px} y2={CH - 2}
              stroke={rr === 1 ? C.res : C.grid} strokeWidth="1" strokeDasharray={rr === 1 ? "3 3" : ""} opacity={rr === 1 ? 0.7 : 1} />;
          })}
          <text x={resLrX + 3} y="11" fill={C.res} fontSize="8.5" fontFamily={MONO}>f₀</text>
          <path d={cpath} fill="none" stroke={C.trace} strokeWidth="1.8" opacity="0.9" />
          <line x1={curLrX} y1="2" x2={curLrX} y2={CH - 2} stroke={C.muted} strokeWidth="1" opacity="0.5" />
          <circle cx={curLrX} cy={curY} r="3.6" fill={C.trace} filter="url(#glow2)" />
        </svg>
        <div style={{ display: "flex", justifyContent: "space-between", fontFamily: MONO, fontSize: 9, color: C.muted, marginTop: 2 }}>
          <span>0.25</span><span>f₀</span><span>×4</span>
        </div>
      </div>

      {/* phasor + readouts */}
      <div style={{ marginTop: 10, display: "flex", gap: 10, alignItems: "stretch", flexWrap: "wrap" }}>
        <div style={{ background: C.panel, borderRadius: 8, padding: 8, border: `1px solid ${C.grid}` }}>
          <div style={{ fontFamily: MONO, fontSize: 10, color: C.muted, marginBottom: 2, textAlign: "center" }}>
            {series ? "電圧フェーザ" : "電流フェーザ"}
          </div>
          <svg viewBox={`0 0 ${PH} ${PH}`} style={{ width: 124, height: 124, display: "block" }}>
            <line x1="6" y1={pc} x2={PH - 6} y2={pc} stroke={C.grid} strokeWidth="1" />
            <line x1={pc} y1="6" x2={pc} y2={PH - 6} stroke={C.grid} strokeWidth="1" />
            {arrows.map((a, i) => {
              const ex = pc + a.x, ey = pc + a.y;
              const len = Math.hypot(a.x, a.y);
              return (
                <g key={"ar" + i}>
                  <line x1={pc} y1={pc} x2={ex} y2={ey} stroke={a.col}
                    strokeWidth={a.wide ? 2.4 : 1.6} strokeDasharray={a.dash ? "3 3" : ""}
                    opacity={a.dash ? 0.6 : 1} />
                  {len > 6 && <circle cx={ex} cy={ey} r={a.wide ? 3 : 2.3} fill={a.col} />}
                  {len > 14 && <text x={ex + (a.x >= 0 ? 3 : -3)} y={ey + (a.y > 2 ? 9 : -3)}
                    fill={a.col} fontSize="8" fontFamily={MONO} textAnchor={a.x >= 0 ? "start" : "end"}>{a.lab}</text>}
                </g>
              );
            })}
          </svg>
        </div>

        <div style={{ flex: 1, minWidth: 180, background: C.panel, borderRadius: 8, padding: "8px 10px",
          border: `1px solid ${C.grid}`, display: "grid", gridTemplateColumns: "1fr 1fr", gap: "4px 10px", alignContent: "start" }}>
          {readouts.map(([k, v], i) => (
            <div key={i} style={{ display: "flex", justifyContent: "space-between", fontFamily: MONO, fontSize: 11.5 }}>
              <span style={{ color: C.muted }}>{k}</span>
              <span style={{ color: C.text, fontWeight: 600 }}>{v}</span>
            </div>
          ))}
        </div>
      </div>

      {/* controls */}
      <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={() => setPlaying(p => !p)}
            style={{ flex: 1, padding: "11px", borderRadius: 8, border: "none", cursor: "pointer",
              background: cc, color: "#0E1116", fontWeight: 700, fontSize: 14, fontFamily: SANS }}>
            {playing ? "⏸ 一時停止" : "▶ 再生"}
          </button>
          <button onClick={() => setLogr(0)}
            style={{ padding: "11px 14px", borderRadius: 8, cursor: "pointer", fontFamily: SANS,
              background: C.bg, color: C.res, border: `1px solid ${C.res}`, fontSize: 13, fontWeight: 600 }}>
            ⚡ 共振へ
          </button>
        </div>

        <div>
          <Label>周波数 f ／ f₀ ＝ {r.toFixed(2)}　（{fmtHz(f)}）</Label>
          <input type="range" min={Math.log(0.25)} max={Math.log(4)} step="0.001" value={logr}
            onChange={e => setLogr(parseFloat(e.target.value))} style={{ width: "100%", accentColor: accent }} />
        </div>
        <div>
          <Label>R ＝ {R} Ω　（Q ＝ {Qf.toFixed(2)}）</Label>
          <input type="range" min={series ? 5 : 50} max={series ? 120 : 3000} step={series ? 1 : 10} value={R}
            onChange={e => setR(parseFloat(e.target.value))} style={{ width: "100%", accentColor: C.R }} />
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          <div style={{ flex: 1 }}>
            <Label>L ＝ {Lmh} mH</Label>
            <input type="range" min="2" max="40" step="1" value={Lmh}
              onChange={e => setLmh(parseFloat(e.target.value))} style={{ width: "100%", accentColor: C.L }} />
          </div>
          <div style={{ flex: 1 }}>
            <Label>C ＝ {Cuf} µF</Label>
            <input type="range" min="0.5" max="8" step="0.1" value={Cuf}
              onChange={e => setCuf(parseFloat(e.target.value))} style={{ width: "100%", accentColor: C.Cap }} />
          </div>
        </div>

        <SegBar value={carrier} accent={cc} onChange={setCarrier}
          options={[["conv", "慣用電流（＋）"], ["electron", "電子（−）"]]} />
        <div>
          <Label>速さ</Label>
          <input type="range" min="0.2" max="2" step="0.05" value={speed}
            onChange={e => setSpeed(parseFloat(e.target.value))} style={{ width: "100%", accentColor: cc }} />
        </div>

        <div style={{ background: C.panel, borderRadius: 8, padding: "12px 14px", fontSize: 12, lineHeight: 1.7, color: C.muted }}>
          {series ? (
            <>
              ・<b style={{ color: C.text }}>直列RLC</b>：R・L・Cが一列。電流はどこでも同じで、Z ＝ √(R² ＋ (XL − XC)²)。<br />
              ・<b style={{ color: C.res }}>共振 f₀ ＝ 1/(2π√(LC))</b> で XL ＝ XC となり、Zが最小（＝R）・<b style={{ color: C.text }}>電流が最大</b>。<br />
              ・共振の鋭さは <b style={{ color: C.text }}>Q ＝ (1/R)√(L/C)</b>。Rが小さいほど鋭いピーク。VL・VCは電源電圧を超えることもあります（電圧拡大）。
            </>
          ) : (
            <>
              ・<b style={{ color: C.text }}>並列RLC</b>：R・L・Cが電源に並列。各枝に別々の電流が流れ、IL は90°遅れ・IC は90°進みます。<br />
              ・<b style={{ color: C.res }}>共振 f₀ ＝ 1/(2π√(LC))</b> で IL と IC が打ち消し合い、<b style={{ color: C.text }}>電源電流が最小・インピーダンス最大</b>。<br />
              ・このときL↔C間を大きな<b style={{ color: C.text }}>循環電流（タンク電流）</b>が往復します。鋭さは Q ＝ R√(C/L)。
            </>
          )}
        </div>

        <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 14px", fontSize: 11, color: C.muted, fontFamily: MONO, marginTop: 2 }}>
          <span><span style={{ color: C.R }}>●</span> R</span>
          <span><span style={{ color: C.L }}>●</span> L</span>
          <span><span style={{ color: C.Cap }}>●</span> C</span>
          <span><span style={{ color: cc }}>●</span> 電源電流</span>
          <span><span style={{ color: C.res }}>—</span> 共振</span>
        </div>
      </div>
    </>
  );
}

// =======================================================================
//  small shared UI bits
// =======================================================================
function Label({ children }) {
  return <div style={{ fontFamily: MONO, fontSize: 10.5, color: C.muted, letterSpacing: ".06em",
    textTransform: "uppercase", marginBottom: 6 }}>{children}</div>;
}
function SegBar({ value, onChange, options, accent }) {
  return (
    <div style={{ display: "flex", border: `1px solid ${C.wire}`, borderRadius: 8, overflow: "hidden", background: C.bg }}>
      {options.map(([val, lab]) => {
        const active = value === val;
        return (
          <button key={val} onClick={() => onChange(val)}
            style={{ flex: 1, padding: "9px 6px", fontFamily: MONO, fontSize: 12.5, letterSpacing: ".02em",
              cursor: "pointer", border: "none", background: active ? accent : "transparent",
              color: active ? "#0E1116" : C.muted, fontWeight: active ? 700 : 500,
              transition: "background .15s, color .15s" }}>
            {lab}
          </button>
        );
      })}
    </div>
  );
}

// =======================================================================
//  top-level shell with topology tabs
// =======================================================================
export default function ChargeFlow() {
  const [tab, setTab] = useState("simple"); // 'simple' | 'series' | 'parallel'

  const titles = {
    simple: "回路を流れる電荷",
    series: "直列 RLC 回路と共振",
    parallel: "並列 RLC 回路と共振",
  };
  const subs = {
    simple: "静止状態から、電源を起点に動き出します。ゆっくり眺めてください。",
    series: "周波数を f₀ に合わせると XL ＝ XC で電流が最大になります（直列共振）。",
    parallel: "f₀ で IL と IC が打ち消し合い、電源電流が最小になります（並列共振）。",
  };

  return (
    <div style={{ background: C.bg, color: C.text, fontFamily: SANS, minHeight: "100%", padding: 16, boxSizing: "border-box" }}>
      <div style={{ maxWidth: 560, margin: "0 auto" }}>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8 }}>
          <h1 style={{ margin: 0, fontSize: 19, fontWeight: 700, letterSpacing: "-.01em" }}>{titles[tab]}</h1>
        </div>
        <p style={{ margin: "4px 0 12px", fontSize: 12.5, color: C.muted, lineHeight: 1.5 }}>{subs[tab]}</p>

        <div style={{ marginBottom: 12 }}>
          <SegBar value={tab} accent={C.conv} onChange={setTab}
            options={[["simple", "単一ループ"], ["series", "直列 RLC"], ["parallel", "並列 RLC"]]} />
        </div>

        {tab === "simple" ? <SimpleLoop /> : <RLCView key={tab} topology={tab} />}
      </div>
    </div>
  );
}
