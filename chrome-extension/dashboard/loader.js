// Client Engine loading overlay
// Injected at document_start so it appears immediately while the dashboard loads.
// Removes itself once window fires 'load' (with a small minimum display time).

(function () {
  if (window.__clientEngineLoaderInjected) return;
  window.__clientEngineLoaderInjected = true;

  var LOADER_ID = 'ce-loader';
  var STYLE_ID = 'ce-loader-style';
  var MIN_DISPLAY_MS = 2800;
  var startedAt = Date.now();

  var css = ''
    + '#ce-loader{position:fixed;inset:0;z-index:2147483647;display:flex;flex-direction:column;align-items:center;justify-content:center;background:rgba(10,10,20,0.82);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);transition:opacity 0.6s ease;font-family:"Trebuchet MS","Gill Sans",sans-serif;}'
    + '#ce-loader.ce-hidden{opacity:0;pointer-events:none;}'
    + '#ce-loader .ce-bot-wrap{width:180px;height:220px;}'
    + '#ce-loader .antenna-dot{animation:ceAntennaPulse 1s ease-in-out infinite;}'
    + '@keyframes ceAntennaPulse{0%,100%{fill:#06B6D4;}50%{fill:#4F46E5;}}'
    + '#ce-loader .wave1{animation:ceWaveSignal 1.6s ease-in-out infinite;opacity:0;stroke-dasharray:40;stroke-dashoffset:40;}'
    + '#ce-loader .wave2{animation:ceWaveSignal 1.6s ease-in-out 0.3s infinite;opacity:0;stroke-dasharray:60;stroke-dashoffset:60;}'
    + '#ce-loader .wave3{animation:ceWaveSignal 1.6s ease-in-out 0.6s infinite;opacity:0;stroke-dasharray:80;stroke-dashoffset:80;}'
    + '@keyframes ceWaveSignal{0%{opacity:0;stroke-dashoffset:40;}25%{opacity:1;}65%{opacity:0.6;stroke-dashoffset:0;}100%{opacity:0;stroke-dashoffset:-20;}}'
    + '#ce-loader .bot-body{animation:ceSlideUp 0.7s cubic-bezier(0.34,1.56,0.64,1) 0s forwards;opacity:0;transform:translateY(20px);}'
    + '#ce-loader .head{animation:ceSlideUp 0.7s cubic-bezier(0.34,1.56,0.64,1) 0.15s forwards;opacity:0;transform:translateY(20px);}'
    + '#ce-loader .antenna-grp{animation:ceSlideUp 0.5s cubic-bezier(0.34,1.56,0.64,1) 0.45s forwards;opacity:0;}'
    + '@keyframes ceSlideUp{to{opacity:1;transform:translateY(0);}}'
    + '#ce-loader .bar1{animation:ceBarPulse1 1.8s ease-in-out 0.9s infinite;}'
    + '#ce-loader .bar2{animation:ceBarPulse2 1.8s ease-in-out 1.0s infinite;}'
    + '#ce-loader .bar3{animation:ceBarPulse3 1.8s ease-in-out 1.1s infinite;}'
    + '#ce-loader .bar4{animation:ceBarPulse4 1.8s ease-in-out 1.2s infinite;}'
    + '#ce-loader .bar5{animation:ceBarPulse5 1.8s ease-in-out 1.3s infinite;}'
    + '@keyframes ceBarPulse1{0%,100%{height:14px;y:176px;}50%{height:22px;y:168px;}}'
    + '@keyframes ceBarPulse2{0%,100%{height:22px;y:168px;}50%{height:14px;y:176px;}}'
    + '@keyframes ceBarPulse3{0%,100%{height:32px;y:158px;}50%{height:40px;y:150px;}}'
    + '@keyframes ceBarPulse4{0%,100%{height:42px;y:148px;}50%{height:30px;y:160px;}}'
    + '@keyframes ceBarPulse5{0%,100%{height:52px;y:138px;}50%{height:62px;y:128px;}}'
    + '#ce-loader .pulse-eye{animation:ceEyePulse 2s ease-in-out infinite;}'
    + '#ce-loader .pulse-eye-r{animation:ceEyePulse 2s ease-in-out 0.3s infinite;}'
    + '@keyframes ceEyePulse{0%,100%{r:3.5;}50%{r:5.5;}}'
    + '#ce-loader .blink-l{animation:ceBlink 5s ease-in-out 2s infinite;}'
    + '#ce-loader .blink-r{animation:ceBlink 5s ease-in-out 2.3s infinite;}'
    + '@keyframes ceBlink{0%,88%,100%{ry:8;}94%{ry:1;}}'
    + '#ce-loader .idle-bob{animation:ceBob 3s ease-in-out 1.2s infinite;}'
    + '@keyframes ceBob{0%,100%{transform:translateY(0);}50%{transform:translateY(-6px);}}'
    + '#ce-loader .ce-brand{margin-top:20px;font-size:13px;font-weight:700;letter-spacing:5px;color:rgba(255,255,255,0.18);text-transform:uppercase;animation:ceFadeInBrand 1s ease 0.8s forwards;opacity:0;}'
    + '@keyframes ceFadeInBrand{to{opacity:1;}}';

  var html = ''
    + '<div class="ce-bot-wrap">'
    +   '<svg width="100%" height="100%" viewBox="0 0 200 220" role="img" xmlns="http://www.w3.org/2000/svg">'
    +     '<title>Client Engine loading</title>'
    +     '<desc>Animated Client Engine bot mascot displayed while page loads</desc>'
    +     '<g class="idle-bob">'
    +       '<g class="antenna-grp">'
    +         '<line x1="100" y1="34" x2="100" y2="18" stroke="#4F46E5" stroke-width="3" stroke-linecap="round"/>'
    +         '<circle cx="100" cy="11" r="8" fill="#06B6D4" class="antenna-dot"/>'
    +         '<circle cx="100" cy="11" r="3" fill="#0A0A14"/>'
    +         '<path class="wave1" d="M88,15 Q94,5 100,3 Q106,5 112,15" fill="none" stroke="#06B6D4" stroke-width="2" stroke-linecap="round"/>'
    +         '<path class="wave2" d="M81,17 Q91,1 100,-2 Q109,1 119,17" fill="none" stroke="#06B6D4" stroke-width="1.5" stroke-linecap="round"/>'
    +         '<path class="wave3" d="M74,19 Q88,-3 100,-7 Q112,-3 126,19" fill="none" stroke="#06B6D4" stroke-width="1" stroke-linecap="round"/>'
    +       '</g>'
    +       '<g class="head">'
    +         '<rect x="46" y="34" width="108" height="80" rx="16" fill="#1A1A3A"/>'
    +         '<circle cx="42" cy="66" r="7" fill="#4F46E5"/>'
    +         '<circle cx="42" cy="66" r="3" fill="#0A0A14"/>'
    +         '<circle cx="158" cy="66" r="7" fill="#4F46E5"/>'
    +         '<circle cx="158" cy="66" r="3" fill="#0A0A14"/>'
    +         '<ellipse cx="82" cy="64" rx="13" ry="13" fill="#0A0A14"/>'
    +         '<ellipse cx="82" cy="64" rx="8" ry="8" fill="#4F46E5" class="blink-l"/>'
    +         '<circle cx="82" cy="64" r="3.5" fill="#06B6D4" class="pulse-eye"/>'
    +         '<circle cx="86" cy="60" r="2" fill="white" opacity="0.45"/>'
    +         '<ellipse cx="118" cy="64" rx="13" ry="13" fill="#0A0A14"/>'
    +         '<ellipse cx="118" cy="64" rx="8" ry="8" fill="#4F46E5" class="blink-r"/>'
    +         '<circle cx="118" cy="64" r="3.5" fill="#06B6D4" class="pulse-eye-r"/>'
    +         '<circle cx="122" cy="60" r="2" fill="white" opacity="0.45"/>'
    +         '<rect x="78" y="96" width="44" height="7" rx="3.5" fill="#0A0A14"/>'
    +         '<rect x="78" y="96" width="28" height="7" rx="3.5" fill="#4F46E5"/>'
    +         '<rect x="108" y="96" width="10" height="7" rx="3.5" fill="#06B6D4" opacity="0.8"/>'
    +       '</g>'
    +       '<g class="bot-body">'
    +         '<rect x="88" y="114" width="24" height="12" rx="3" fill="#111130"/>'
    +         '<rect x="46" y="126" width="108" height="76" rx="12" fill="#1A1A3A"/>'
    +         '<rect class="bar1" x="64" y="176" width="10" height="14" rx="3" fill="#4F46E5" opacity="0.4"/>'
    +         '<rect class="bar2" x="78" y="168" width="10" height="22" rx="3" fill="#4F46E5" opacity="0.6"/>'
    +         '<rect class="bar3" x="92" y="158" width="10" height="32" rx="3" fill="#4F46E5" opacity="0.8"/>'
    +         '<rect class="bar4" x="106" y="148" width="10" height="42" rx="3" fill="#4F46E5"/>'
    +         '<rect class="bar5" x="120" y="138" width="10" height="52" rx="3" fill="#06B6D4"/>'
    +         '<circle cx="42" cy="152" r="6" fill="#111130" stroke="#4F46E5" stroke-width="1"/>'
    +         '<circle cx="158" cy="152" r="6" fill="#111130" stroke="#4F46E5" stroke-width="1"/>'
    +       '</g>'
    +     '</g>'
    +   '</svg>'
    + '</div>'
    + '<div class="ce-brand">Client Engine</div>';

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = css;
    (document.head || document.documentElement).appendChild(style);
  }

  function injectOverlay() {
    if (document.getElementById(LOADER_ID)) return;
    var overlay = document.createElement('div');
    overlay.id = LOADER_ID;
    overlay.innerHTML = html;
    (document.body || document.documentElement).appendChild(overlay);
  }

  function mount() {
    injectStyle();
    injectOverlay();
  }

  function hide() {
    var elapsed = Date.now() - startedAt;
    var wait = Math.max(0, MIN_DISPLAY_MS - elapsed);
    setTimeout(function () {
      var loader = document.getElementById(LOADER_ID);
      if (!loader) return;
      loader.classList.add('ce-hidden');
      setTimeout(function () {
        if (loader && loader.parentNode) loader.parentNode.removeChild(loader);
      }, 700);
    }, wait);
  }

  mount();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount, { once: true });
  }

  if (document.readyState === 'complete') {
    hide();
  } else {
    window.addEventListener('load', hide, { once: true });
  }
})();
