import { useMemo, useState } from 'react';

const steps = [
  {
    title: '全体像',
    focus: 'all',
    lead: '回路を常に表示したまま、強調だけを切り替えます。自動で文字は消えません。',
    points: [
      '`E` で閉回路にする',
      '`P,Q` は上側の比率腕',
      '`Rx-r-Rs` は下側の主枝',
      '`p,q` は `r` の両端をまたぐ補助腕',
    ],
    formula: '',
  },
  {
    title: '問題点：r が混ざる',
    focus: 'r',
    lead: '低抵抗測定では、接続部の抵抗 `r` が無視できません。普通に測ると `Rx` だけを取り出せません。',
    points: ['`r` は `Rx` と `Rs` の間にある', '`r` を物理的に消す話ではない', '`G` の接続点を工夫して、式から消す'],
    formula: '',
  },
  {
    title: 'p,q の役割',
    focus: 'pq',
    lead: '`p,q` は `r` に直列に足す部品ではなく、`r` の両端をまたいで中間点を作る部品です。',
    points: ['`p` は上側', '`q` は下側', '`p,q` の中点を `G` へつなぐ'],
    formula: '',
  },
  {
    title: 'G=0 の意味',
    focus: 'g',
    lead: '検流計 `G` が 0 なら、左右の接続点の電位が等しいという意味です。',
    points: ['電流が `G` に流れない', '左の中点と右の中点が同電位', 'ここで平衡条件が使える'],
    formula: 'V_G = 0',
  },
  {
    title: '比をそろえる',
    focus: 'ratio',
    lead: '`P,Q` と `p,q` の比をそろえると、`r` の影響を同じ割合で拾えます。',
    points: ['上側の比率腕と補助腕を同じ比にする', '`r` の電圧降下を左右で同じ形に入れる', 'その結果、平衡式で `r` の項が消える'],
    formula: 'P/Q = p/q',
  },
  {
    title: '結果',
    focus: 'result',
    lead: '平衡していて、さらに比がそろっていれば、求めたい低抵抗は標準抵抗と比率腕だけで決まります。',
    points: ['`r` は測定対象から外れる', '`Rx` は `Rs` と `P/Q` で決まる', 'これがケルビンダブルブリッジの狙い'],
    formula: 'Rx = Rs × P/Q',
  },
] as const;

type Focus = (typeof steps)[number]['focus'];

function activeClass(focus: Focus, targets: Focus[]) {
  return targets.includes(focus) || focus === 'all' ? 'active' : 'soft';
}

function Circuit({ focus }: { focus: Focus }) {
  return (
    <svg viewBox="0 0 920 560" className="circuit" role="img" aria-label="Kelvin double bridge circuit">
      <defs>
        <filter id="glow" x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur stdDeviation="4" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
        <linearGradient id="panelGrad" x1="0" x2="1" y1="0" y2="1">
          <stop offset="0" stopColor="#122335" />
          <stop offset="1" stopColor="#07101b" />
        </linearGradient>
      </defs>

      <rect x="24" y="24" width="872" height="512" rx="26" fill="url(#panelGrad)" stroke="#26435d" />

      {/* wires */}
      <path className="wire" d="M120 120 H790 V440 H120 Z" />
      <path className="wire muted" d="M120 120 V440" />
      <path className="wire muted" d="M790 120 V440" />

      {/* source */}
      <circle cx="120" cy="280" r="38" className="source" />
      <text x="120" y="287" textAnchor="middle" className="label big">E</text>
      <text x="84" y="220" className="smallLabel">電源</text>

      {/* top ratio arm P Q */}
      <line x1="220" y1="120" x2="220" y2="440" className={`bridge ${activeClass(focus, ['ratio', 'g', 'result'])}`} />
      <rect x="178" y="170" width="84" height="58" rx="14" className={`part p ${activeClass(focus, ['ratio', 'g', 'result'])}`} />
      <text x="220" y="207" textAnchor="middle" className="label">P</text>
      <rect x="178" y="322" width="84" height="58" rx="14" className={`part q ${activeClass(focus, ['ratio', 'g', 'result'])}`} />
      <text x="220" y="359" textAnchor="middle" className="label">Q</text>
      <circle cx="220" cy="276" r="7" className={`node ${activeClass(focus, ['g', 'ratio'])}`} />
      <text x="144" y="104" className="sectionLabel">比率腕</text>

      {/* bottom main branch */}
      <rect x="352" y="411" width="118" height="58" rx="14" className={`part rx ${activeClass(focus, ['r', 'result'])}`} />
      <text x="411" y="448" textAnchor="middle" className="label">Rx</text>

      <rect x="500" y="411" width="82" height="58" rx="14" className={`part r ${activeClass(focus, ['r', 'pq', 'ratio'])}`} />
      <text x="541" y="448" textAnchor="middle" className="label">r</text>

      <rect x="612" y="411" width="118" height="58" rx="14" className={`part rs ${activeClass(focus, ['result'])}`} />
      <text x="671" y="448" textAnchor="middle" className="label">Rs</text>
      <text x="426" y="506" textAnchor="middle" className="smallLabel">未知抵抗</text>
      <text x="672" y="506" textAnchor="middle" className="smallLabel">標準抵抗</text>

      {/* p q auxiliary branch across r */}
      <path d="M500 440 C500 308 582 308 582 440" className={`auxWire ${activeClass(focus, ['pq', 'g', 'ratio'])}`} />
      <rect x="478" y="292" width="64" height="48" rx="13" className={`part aux ${activeClass(focus, ['pq', 'ratio'])}`} />
      <text x="510" y="323" textAnchor="middle" className="label small">p</text>
      <rect x="540" y="292" width="64" height="48" rx="13" className={`part aux ${activeClass(focus, ['pq', 'ratio'])}`} />
      <text x="572" y="323" textAnchor="middle" className="label small">q</text>
      <circle cx="541" cy="316" r="7" className={`node ${activeClass(focus, ['pq', 'g', 'ratio'])}`} />
      <text x="506" y="265" className={`callout ${activeClass(focus, ['pq'])}`}>r の両端をまたぐ</text>

      {/* galvanometer */}
      <path d="M220 276 H380 C410 276 410 316 438 316 H541" className={`gWire ${activeClass(focus, ['g', 'ratio'])}`} />
      <circle cx="394" cy="276" r="30" className={`meter ${activeClass(focus, ['g'])}`} />
      <text x="394" y="285" textAnchor="middle" className="label">G</text>

      {/* result badge */}
      <g className={focus === 'result' ? 'resultBadge show' : 'resultBadge'}>
        <rect x="574" y="104" width="240" height="72" rx="18" fill="#1e2f46" stroke="#ffd166" />
        <text x="694" y="135" textAnchor="middle" className="smallLabel">平衡条件</text>
        <text x="694" y="162" textAnchor="middle" className="formula">Rx = Rs × P/Q</text>
      </g>

      {/* ratio badge */}
      <g className={focus === 'ratio' ? 'ratioBadge show' : 'ratioBadge'}>
        <rect x="580" y="186" width="224" height="58" rx="16" fill="#11263c" stroke="#54a8ff" />
        <text x="692" y="223" textAnchor="middle" className="formula">P/Q = p/q</text>
      </g>
    </svg>
  );
}

export default function App() {
  const [step, setStep] = useState(0);
  const current = steps[step];

  const progress = useMemo(() => ((step + 1) / steps.length) * 100, [step]);

  return (
    <main className="appShell">
      <style>{`
        :root{ color-scheme: dark; }
        *{ box-sizing:border-box; }
        body{ margin:0; background:#05080d; }
        .appShell{
          min-height:100vh;
          padding:18px;
          color:#eef7ff;
          background:
            radial-gradient(1200px 720px at 50% -180px, #14314f 0%, #07101a 55%, #04070c 100%);
          font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Hiragino Sans", "Noto Sans JP", sans-serif;
        }
        .wrap{ max-width:1180px; margin:0 auto; }
        .header{
          display:flex; align-items:flex-end; justify-content:space-between; gap:16px;
          margin-bottom:14px;
        }
        h1{ margin:0; font-size:clamp(23px,4vw,42px); letter-spacing:.02em; line-height:1.05; }
        .sub{ color:#91a8bd; margin:7px 0 0; font-size:14px; line-height:1.6; }
        .badge{ border:1px solid #2e4965; color:#9fc8f5; border-radius:999px; padding:8px 12px; font-weight:700; white-space:nowrap; background:#071523cc; }
        .stage{
          display:grid;
          grid-template-columns:minmax(0, 1.4fr) minmax(300px, .8fr);
          gap:16px;
          align-items:stretch;
        }
        .card{
          border:1px solid #243a52;
          border-radius:24px;
          background:rgba(7,15,25,.78);
          box-shadow:0 24px 80px rgba(0,0,0,.34), inset 0 1px 0 rgba(255,255,255,.04);
          overflow:hidden;
        }
        .diagramCard{ padding:10px; }
        .side{ padding:18px; display:flex; flex-direction:column; gap:14px; }
        .stepTitle{ margin:0; font-size:22px; line-height:1.25; }
        .lead{ margin:0; color:#c7d7e6; line-height:1.75; font-size:15px; }
        .formulaBox{
          min-height:48px;
          border:1px solid #345270;
          border-radius:16px;
          background:#071827;
          display:flex; align-items:center; justify-content:center;
          font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
          font-size:22px; font-weight:800; color:#ffd166;
        }
        .formulaBox.empty{ color:#64788e; font-size:13px; font-weight:600; }
        ul{ margin:0; padding-left:20px; color:#aebfd0; line-height:1.8; font-size:14px; }
        code{
          font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
          color:#7fe7c5;
          background:#0b2031;
          border:1px solid #234058;
          padding:.08em .35em;
          border-radius:6px;
        }
        .controls{ display:flex; gap:10px; flex-wrap:wrap; margin-top:auto; }
        button{
          border:1px solid #2f4a64;
          border-radius:14px;
          background:#0b1826;
          color:#dff2ff;
          padding:11px 14px;
          font-weight:800;
          cursor:pointer;
          min-height:44px;
        }
        button.primary{ background:#1b6cff; border-color:#5d9dff; }
        button:disabled{ opacity:.35; cursor:not-allowed; }
        .steps{ display:grid; grid-template-columns:repeat(6,1fr); gap:8px; margin-top:12px; }
        .stepChip{
          min-height:42px; padding:8px 6px; border-radius:14px; font-size:12px;
          border:1px solid #253e58; background:#07131f; color:#7f98ae;
        }
        .stepChip.on{ border-color:#7fe7c5; color:#dcfff4; background:#0d2a2a; }
        .progress{ height:6px; border-radius:999px; background:#122437; overflow:hidden; margin:14px 0 0; }
        .bar{ height:100%; background:linear-gradient(90deg,#7fe7c5,#54a8ff,#ffd166); transition:width .18s ease; }
        .circuit{ width:100%; height:auto; display:block; }
        .wire{ fill:none; stroke:#67829e; stroke-width:7; stroke-linecap:round; stroke-linejoin:round; }
        .wire.muted{ stroke:#2d465d; stroke-width:5; }
        .bridge,.auxWire,.gWire{ fill:none; stroke:#7996b0; stroke-width:7; stroke-linecap:round; stroke-linejoin:round; }
        .auxWire{ stroke:#4fb6ff; stroke-width:6; }
        .gWire{ stroke:#b98cff; stroke-width:5; }
        .part{ fill:#102034; stroke:#47627c; stroke-width:3; }
        .part.p,.part.q{ fill:#122846; }
        .part.rx{ fill:#2b1d18; stroke:#ff8a65; }
        .part.r{ fill:#381b24; stroke:#ff5c8a; }
        .part.rs{ fill:#182a20; stroke:#7fe7a1; }
        .part.aux{ fill:#102c35; stroke:#54d4ff; }
        .label{ fill:#f2fbff; font-weight:900; font-size:30px; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
        .label.big{ font-size:32px; }
        .label.small{ font-size:24px; }
        .smallLabel{ fill:#9db2c5; font-size:20px; font-weight:700; }
        .sectionLabel{ fill:#b8cbde; font-size:22px; font-weight:900; }
        .callout{ fill:#73d7ff; font-size:20px; font-weight:900; opacity:.3; }
        .formula{ fill:#ffd166; font-size:24px; font-weight:900; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
        .node{ fill:#cfeaff; stroke:#06101b; stroke-width:4; }
        .source{ fill:#0d1f30; stroke:#83b7e7; stroke-width:4; }
        .meter{ fill:#171125; stroke:#d6a1ff; stroke-width:4; }
        .soft{ opacity:.28; }
        .active{ opacity:1; filter:url(#glow); }
        .resultBadge,.ratioBadge{ opacity:0; transition:opacity .16s ease; }
        .resultBadge.show,.ratioBadge.show{ opacity:1; }
        @media (max-width:850px){
          .appShell{ padding:12px; }
          .header{ align-items:flex-start; flex-direction:column; }
          .stage{ grid-template-columns:1fr; }
          .side{ padding:15px; }
          .steps{ grid-template-columns:repeat(3,1fr); }
          .stepChip{ font-size:11px; }
          .lead,ul{ font-size:14px; }
        }
      `}</style>

      <div className="wrap">
        <header className="header">
          <div>
            <h1>ケルビンダブルブリッジ</h1>
            <p className="sub">自動再生なし。回路図は固定。ボタンで見たい場所だけ切り替えます。</p>
          </div>
          <div className="badge">Step {step + 1} / {steps.length}</div>
        </header>

        <section className="stage">
          <div className="card diagramCard">
            <Circuit focus={current.focus} />
          </div>

          <aside className="card side">
            <h2 className="stepTitle">{current.title}</h2>
            <p className="lead">{current.lead}</p>
            <div className={current.formula ? 'formulaBox' : 'formulaBox empty'}>
              {current.formula || '式はこのステップでは出さない'}
            </div>
            <ul>
              {current.points.map((p) => (
                <li key={p} dangerouslySetInnerHTML={{ __html: p.replaceAll('`', '<code>').replace(/<code>([^<]*)<code>/g, '<code>$1</code>') }} />
              ))}
            </ul>
            <div className="controls">
              <button onClick={() => setStep(0)}>最初</button>
              <button onClick={() => setStep((v) => Math.max(0, v - 1))} disabled={step === 0}>戻る</button>
              <button className="primary" onClick={() => setStep((v) => Math.min(steps.length - 1, v + 1))} disabled={step === steps.length - 1}>次へ</button>
            </div>
          </aside>
        </section>

        <div className="progress" aria-hidden="true"><div className="bar" style={{ width: `${progress}%` }} /></div>
        <nav className="steps" aria-label="steps">
          {steps.map((s, i) => (
            <button key={s.title} className={i === step ? 'stepChip on' : 'stepChip'} onClick={() => setStep(i)}>
              {i + 1}. {s.title}
            </button>
          ))}
        </nav>
      </div>
    </main>
  );
}
