interface LoadingBotProps {
  /** Rendered width in px. Height scales to the 200:240 viewBox ratio. */
  width?: number;
  className?: string;
}

export function LoadingBot({ width = 72, className = '' }: LoadingBotProps) {
  const height = Math.round((width * 240) / 200);
  return (
    <svg
      width={width}
      height={height}
      viewBox="0 0 200 240"
      role="img"
      aria-label="Loading"
      className={className}
    >
      <style>{`
        .lb-antenna-dot { animation: lb-antennaPulse 1s ease-in-out infinite; }
        @keyframes lb-antennaPulse {
          0%,100% { fill: #06B6D4; }
          50% { fill: #4F46E5; }
        }
        .lb-wave1 { animation: lb-waveSignal 1.4s ease-in-out infinite; opacity: 0; stroke-dasharray: 40; stroke-dashoffset: 40; }
        .lb-wave2 { animation: lb-waveSignal 1.4s ease-in-out 0.25s infinite; opacity: 0; stroke-dasharray: 60; stroke-dashoffset: 60; }
        .lb-wave3 { animation: lb-waveSignal 1.4s ease-in-out 0.5s infinite; opacity: 0; stroke-dasharray: 80; stroke-dashoffset: 80; }
        @keyframes lb-waveSignal {
          0% { opacity: 0; stroke-dashoffset: 40; }
          30% { opacity: 0.9; }
          70% { opacity: 0.6; stroke-dashoffset: 0; }
          100% { opacity: 0; stroke-dashoffset: -20; }
        }
        .lb-bot-body { animation: lb-slideUp 0.7s cubic-bezier(0.34,1.56,0.64,1) forwards; opacity:0; transform:translateY(20px); }
        .lb-head { animation: lb-slideUp 0.7s cubic-bezier(0.34,1.56,0.64,1) 0.15s forwards; opacity:0; transform:translateY(20px); }
        .lb-antenna-group { animation: lb-slideUp 0.5s cubic-bezier(0.34,1.56,0.64,1) 0.45s forwards; opacity:0; }
        @keyframes lb-slideUp { to { opacity:1; transform:translateY(0); } }
        .lb-bar1 { animation: lb-barPulse1 1.8s ease-in-out 1s infinite; }
        .lb-bar2 { animation: lb-barPulse2 1.8s ease-in-out 1s infinite; }
        .lb-bar3 { animation: lb-barPulse3 1.8s ease-in-out 1s infinite; }
        .lb-bar4 { animation: lb-barPulse4 1.8s ease-in-out 1s infinite; }
        .lb-bar5 { animation: lb-barPulse5 1.8s ease-in-out 1s infinite; }
        @keyframes lb-barPulse1 { 0%,100%{height:14px;y:176px} 50%{height:20px;y:170px} }
        @keyframes lb-barPulse2 { 0%,100%{height:22px;y:168px} 50%{height:16px;y:174px} }
        @keyframes lb-barPulse3 { 0%,100%{height:30px;y:160px} 50%{height:36px;y:154px} }
        @keyframes lb-barPulse4 { 0%,100%{height:40px;y:150px} 50%{height:30px;y:160px} }
        @keyframes lb-barPulse5 { 0%,100%{height:50px;y:140px} 50%{height:58px;y:132px} }
        .lb-pulse-eye { animation: lb-eyePulse 2s ease-in-out infinite; }
        .lb-pulse-eye-r { animation: lb-eyePulse 2s ease-in-out 0.3s infinite; }
        @keyframes lb-eyePulse { 0%,100%{r:3.5} 50%{r:5} }
        .lb-blink-l { animation: lb-blink 4s ease-in-out 2s infinite; }
        .lb-blink-r { animation: lb-blink 4s ease-in-out 2.3s infinite; }
        @keyframes lb-blink { 0%,88%,100%{ry:8} 94%{ry:1} }
        .lb-idle-bob { animation: lb-bob 3s ease-in-out 1.2s infinite; }
        @keyframes lb-bob { 0%,100%{transform:translateY(0)} 50%{transform:translateY(-5px)} }
      `}</style>
      <g className="lb-idle-bob">
        <g className="lb-antenna-group">
          <line x1="100" y1="36" x2="100" y2="20" stroke="#4F46E5" strokeWidth="3" strokeLinecap="round" />
          <circle cx="100" cy="13" r="8" fill="#06B6D4" className="lb-antenna-dot" />
          <circle cx="100" cy="13" r="3" fill="#0D0D1A" />
          <path className="lb-wave1" d="M87,17 Q93,7 100,5 Q107,7 113,17" fill="none" stroke="#06B6D4" strokeWidth="2" strokeLinecap="round" />
          <path className="lb-wave2" d="M80,19 Q90,3 100,0 Q110,3 120,19" fill="none" stroke="#06B6D4" strokeWidth="1.5" strokeLinecap="round" />
          <path className="lb-wave3" d="M73,21 Q87,-1 100,-5 Q113,-1 127,21" fill="none" stroke="#06B6D4" strokeWidth="1" strokeLinecap="round" />
        </g>
        <g className="lb-head">
          <rect x="46" y="36" width="108" height="78" rx="16" fill="#1A1A3A" />
          <circle cx="42" cy="68" r="7" fill="#4F46E5" />
          <circle cx="42" cy="68" r="3" fill="#0D0D1A" />
          <circle cx="158" cy="68" r="7" fill="#4F46E5" />
          <circle cx="158" cy="68" r="3" fill="#0D0D1A" />
          <ellipse cx="82" cy="66" rx="13" ry="13" fill="#0D0D1A" />
          <ellipse cx="82" cy="66" rx="8" ry="8" fill="#4F46E5" className="lb-blink-l" />
          <circle cx="82" cy="66" r="3.5" fill="#06B6D4" className="lb-pulse-eye" />
          <circle cx="86" cy="62" r="2" fill="white" opacity="0.5" />
          <ellipse cx="118" cy="66" rx="13" ry="13" fill="#0D0D1A" />
          <ellipse cx="118" cy="66" rx="8" ry="8" fill="#4F46E5" className="lb-blink-r" />
          <circle cx="118" cy="66" r="3.5" fill="#06B6D4" className="lb-pulse-eye-r" />
          <circle cx="122" cy="62" r="2" fill="white" opacity="0.5" />
          <rect x="78" y="98" width="44" height="7" rx="3.5" fill="#0D0D1A" />
          <rect x="78" y="98" width="28" height="7" rx="3.5" fill="#4F46E5" />
          <rect x="108" y="98" width="10" height="7" rx="3.5" fill="#06B6D4" opacity="0.7" />
        </g>
        <g className="lb-bot-body">
          <rect x="88" y="114" width="24" height="12" rx="3" fill="#111130" />
          <rect x="46" y="126" width="108" height="76" rx="12" fill="#1A1A3A" />
          <rect className="lb-bar1" x="64" y="176" width="10" height="14" rx="3" fill="#4F46E5" opacity="0.4" />
          <rect className="lb-bar2" x="78" y="168" width="10" height="22" rx="3" fill="#4F46E5" opacity="0.6" />
          <rect className="lb-bar3" x="92" y="160" width="10" height="30" rx="3" fill="#4F46E5" opacity="0.8" />
          <rect className="lb-bar4" x="106" y="150" width="10" height="40" rx="3" fill="#4F46E5" />
          <rect className="lb-bar5" x="120" y="140" width="10" height="50" rx="3" fill="#06B6D4" />
          <circle cx="42" cy="154" r="6" fill="#111130" stroke="#4F46E5" strokeWidth="1" />
          <circle cx="158" cy="154" r="6" fill="#111130" stroke="#4F46E5" strokeWidth="1" />
        </g>
      </g>
    </svg>
  );
}
