/* Анимированная заставка при запуске сайта как приложения (PWA).
   Показывается один раз за запуск приложения (пока открыто окно приложения).
   Принудительный показ для проверки в браузере: добавьте к адресу ?splash=1 */
(function () {
  'use strict';
  var KEY = 'sd_splash_shown';
  var forced = /[?&]splash(=|&|$)/.test(location.search);
  var standalone = false;
  try {
    standalone = matchMedia('(display-mode: standalone)').matches
      || matchMedia('(display-mode: fullscreen)').matches
      || matchMedia('(display-mode: minimal-ui)').matches
      || navigator.standalone === true
      || /^android-app:\/\//.test(document.referrer);
  } catch (e) { /* старый браузер — считаем, что это обычная вкладка */ }
  if (!forced && !standalone) return;
  try {
    if (!forced && sessionStorage.getItem(KEY)) return;
    sessionStorage.setItem(KEY, '1');
  } catch (e) { /* без sessionStorage просто покажем заставку */ }

  var reduce = false;
  try { reduce = matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) {}
  var MIN_MS = reduce ? 700 : 2500;   // минимальное время показа
  var MAX_MS = 6000;                  // страховка: дольше не держим, даже если страница грузится медленно

  var css = '' +
    '#sd-splash{position:fixed;top:0;left:0;right:0;bottom:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;' +
      'background:#07070d;overflow:hidden;color:#ecedf5;font-family:Inter,system-ui,-apple-system,"Segoe UI",sans-serif;' +
      'transition:opacity .55s ease,transform .55s cubic-bezier(.4,0,.2,1);-webkit-tap-highlight-color:transparent;touch-action:none;cursor:default}' +
    '#sd-splash.sd-out{opacity:0;transform:scale(1.08);pointer-events:none}' +
    '#sd-splash *{box-sizing:border-box}' +
    /* светящиеся пятна фона */
    '.sd-glow{position:absolute;border-radius:50%;opacity:0;animation:sd-fade .9s ease forwards}' +
    '.sd-g1{width:80vmax;height:80vmax;left:-30vmax;top:-34vmax;background:radial-gradient(circle,rgba(124,108,255,.55),transparent 62%);animation:sd-fade .9s ease forwards,sd-d1 7s ease-in-out infinite alternate}' +
    '.sd-g2{width:70vmax;height:70vmax;right:-28vmax;bottom:-32vmax;background:radial-gradient(circle,rgba(176,108,255,.45),transparent 62%);animation:sd-fade .9s ease .15s forwards,sd-d2 8s ease-in-out infinite alternate}' +
    '.sd-g3{width:40vmax;height:40vmax;left:30%;top:42%;background:radial-gradient(circle,rgba(52,211,153,.16),transparent 65%);animation:sd-fade 1.2s ease 1s forwards,sd-d1 9s ease-in-out infinite alternate}' +
    /* всплывающие частицы */
    '.sd-p{position:absolute;bottom:-12px;width:5px;height:5px;border-radius:50%;background:rgba(196,181,253,.8);opacity:0;animation:sd-float linear infinite}' +
    /* центр */
    '.sd-center{position:relative;display:flex;flex-direction:column;align-items:center;padding:0 24px;text-align:center}' +
    '.sd-tile{position:relative;width:132px;height:132px;border-radius:32px;background:linear-gradient(135deg,#8b5cf6,#4f46e5);' +
      'box-shadow:0 24px 70px rgba(124,108,255,.5),inset 0 1px 0 rgba(255,255,255,.28);' +
      'animation:sd-pop .95s cubic-bezier(.34,1.56,.64,1) both,sd-bob 3.2s ease-in-out 1s infinite}' +
    '.sd-tile:before,.sd-tile:after{content:"";position:absolute;left:0;top:0;right:0;bottom:0;border-radius:inherit;border:2px solid rgba(167,139,250,.75);opacity:0;animation:sd-ring 2s ease-out .55s infinite}' +
    '.sd-tile:after{animation-delay:1.35s}' +
    '.sd-tile svg{position:absolute;left:0;top:0;width:100%;height:100%;overflow:visible}' +
    '.sd-d{fill:none;stroke:#fff;stroke-width:24;stroke-linecap:round;stroke-linejoin:round;stroke-dasharray:1;stroke-dashoffset:1;animation:sd-draw .75s cubic-bezier(.5,.1,.2,1) forwards}' +
    '.sd-ringl{animation:sd-draw .45s ease forwards,sd-drop .5s cubic-bezier(.34,1.56,.64,1) forwards;opacity:0;transform-box:fill-box}' +
    '.sd-dot{fill:#fff;transform-box:fill-box;transform-origin:center;transform:scale(0);animation:sd-dotin .45s cubic-bezier(.34,1.56,.64,1) forwards}' +
    '.sd-live{fill:#6ee7b7}' +
    '.sd-ping{fill:none;stroke:#6ee7b7;stroke-width:6;transform-box:fill-box;transform-origin:center;opacity:0;animation:sd-ping 1.6s ease-out 1.7s infinite}' +
    /* заголовок */
    '.sd-title{margin:34px 0 0;display:flex;flex-wrap:wrap;justify-content:center;gap:0 .34em;font-family:Unbounded,Inter,system-ui,sans-serif;font-weight:800;font-size:26px;line-height:1.2;letter-spacing:-.01em;color:#fff}' +
    '.sd-w{display:inline-block;white-space:nowrap}' +
    '.sd-l{display:inline-block;opacity:0;transform:translateY(18px) scale(.9);animation:sd-rise .6s cubic-bezier(.2,.8,.2,1) forwards}' +
    '.sd-sub{margin:12px 0 0;font-size:12.5px;letter-spacing:.2em;text-transform:uppercase;color:rgba(236,237,245,.5);opacity:0;animation:sd-fade .7s ease 1.6s forwards}' +
    '.sd-bar{margin-top:38px;width:150px;height:3px;border-radius:9px;background:rgba(255,255,255,.1);overflow:hidden;opacity:0;animation:sd-fade .4s ease .35s forwards}' +
    '.sd-bar b{display:block;width:100%;height:100%;border-radius:inherit;transform-origin:left;transform:scaleX(0);background:linear-gradient(90deg,#a78bfa,#6ee7b7);animation:sd-load 2s cubic-bezier(.45,.05,.25,1) .4s forwards}' +
    '@keyframes sd-fade{to{opacity:1}}' +
    '@keyframes sd-d1{to{transform:translate(8vmax,6vmax) scale(1.12)}}' +
    '@keyframes sd-d2{to{transform:translate(-7vmax,-6vmax) scale(1.1)}}' +
    '@keyframes sd-pop{from{opacity:0;transform:scale(.35) rotate(-14deg)}to{opacity:1;transform:none}}' +
    '@keyframes sd-bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-6px)}}' +
    '@keyframes sd-ring{0%{opacity:.8;transform:scale(1)}100%{opacity:0;transform:scale(1.75)}}' +
    '@keyframes sd-draw{to{stroke-dashoffset:0}}' +
    '@keyframes sd-drop{from{opacity:0;transform:translateY(-26px)}to{opacity:1;transform:none}}' +
    '@keyframes sd-dotin{to{transform:scale(1)}}' +
    '@keyframes sd-ping{0%{opacity:.9;transform:scale(1)}100%{opacity:0;transform:scale(3)}}' +
    '@keyframes sd-rise{to{opacity:1;transform:none}}' +
    '@keyframes sd-load{to{transform:scaleX(1)}}' +
    '@keyframes sd-float{0%{opacity:0;transform:translateY(0)}15%{opacity:.9}100%{opacity:0;transform:translateY(-95vh)}}' +
    '@media (prefers-reduced-motion:reduce){#sd-splash *,#sd-splash *:before,#sd-splash *:after{animation-duration:.01s!important;animation-delay:0s!important;animation-iteration-count:1!important}.sd-p{display:none}}' +
    '@media (max-width:360px){.sd-title{font-size:22px}}' +
    /* Сезонный вариант: theme.js вешает класс на <html> до загрузки заставки,
       поэтому здесь только переопределения цвета. */
    '.halloween #sd-splash{background:#0a0512}' +
    '.halloween .sd-tile{background:linear-gradient(135deg,#ff8a3d,#8b5cf6);box-shadow:0 24px 70px rgba(255,138,61,.45),inset 0 1px 0 rgba(255,255,255,.28)}' +
    '.halloween .sd-tile:before,.halloween .sd-tile:after{border-color:rgba(253,186,116,.7)}' +
    '.halloween .sd-g1{background:radial-gradient(circle,rgba(249,115,22,.5),transparent 62%)}' +
    '.halloween .sd-g2{background:radial-gradient(circle,rgba(139,92,246,.42),transparent 62%)}' +
    '.halloween .sd-g3{background:radial-gradient(circle,rgba(163,230,53,.13),transparent 65%)}' +
    '.halloween .sd-p{background:rgba(253,186,116,.85)}' +
    '.halloween .sd-d{stroke:#1c1226}' +
    '.halloween .sd-dot{fill:#1c1226}' +
    '.halloween .sd-live{fill:#fde68a}' +
    '.halloween .sd-ping{stroke:#fbbf24}' +
    '.halloween .sd-bar b{background:linear-gradient(90deg,#fbbf24,#8b5cf6)}';

  function letters(word, start) {
    var out = '', i;
    for (i = 0; i < word.length; i++) {
      out += '<span class="sd-l" style="animation-delay:' + (start + i * 0.035).toFixed(3) + 's">' + word.charAt(i) + '</span>';
    }
    return out;
  }

  function particles() {
    var out = '', i, left, size, dur, delay;
    for (i = 0; i < 16; i++) {
      left = Math.round(Math.random() * 100);
      size = 3 + Math.round(Math.random() * 4);
      dur = (4 + Math.random() * 4).toFixed(1);
      delay = (Math.random() * 3).toFixed(1);
      out += '<i class="sd-p" style="left:' + left + '%;width:' + size + 'px;height:' + size + 'px;animation-duration:' + dur + 's;animation-delay:' + delay + 's"></i>';
    }
    return out;
  }

  var html = '' +
    '<div class="sd-glow sd-g1"></div><div class="sd-glow sd-g2"></div><div class="sd-glow sd-g3"></div>' +
    particles() +
    '<div class="sd-center">' +
      '<div class="sd-tile"><svg viewBox="0 0 512 512" aria-hidden="true">' +
        '<rect class="sd-d" pathLength="1" x="121" y="151" width="270" height="235" rx="42" style="animation-delay:.45s"/>' +
        '<line class="sd-d" pathLength="1" x1="121" y1="229" x2="391" y2="229" style="animation-delay:.95s"/>' +
        '<line class="sd-d sd-ringl" pathLength="1" x1="195" y1="108" x2="195" y2="176" style="animation-delay:1.1s,1.1s"/>' +
        '<line class="sd-d sd-ringl" pathLength="1" x1="318" y1="108" x2="318" y2="176" style="animation-delay:1.2s,1.2s"/>' +
        '<circle class="sd-dot" cx="193" cy="296" r="15" style="animation-delay:1.3s"/>' +
        '<circle class="sd-dot" cx="256" cy="296" r="15" style="animation-delay:1.38s"/>' +
        '<circle class="sd-ping" cx="318" cy="296" r="15"/>' +
        '<circle class="sd-dot sd-live" cx="318" cy="296" r="15" style="animation-delay:1.46s"/>' +
        '<circle class="sd-dot" cx="193" cy="346" r="15" style="animation-delay:1.54s"/>' +
        '<circle class="sd-dot" cx="256" cy="346" r="15" style="animation-delay:1.62s"/>' +
      '</svg></div>' +
      '<h1 class="sd-title" aria-label="Электронный дневник">' +
        '<span class="sd-w" aria-hidden="true">' + letters('Электронный', 1.0) + '</span>' +
        '<span class="sd-w" aria-hidden="true">' + letters('дневник', 1.4) + '</span>' +
      '</h1>' +
      '<p class="sd-sub">оценки · расписание · дз</p>' +
      '<div class="sd-bar"><b></b></div>' +
    '</div>';

  var root = document.createElement('div');
  root.id = 'sd-splash';
  root.setAttribute('role', 'presentation');
  root.innerHTML = '<style>' + css + '</style>' + html;
  // Скрипт стоит в <head>: <body> ещё нет, поэтому вешаем заставку на <html>, чтобы страница не мелькнула.
  (document.body || document.documentElement).appendChild(root);

  var started = Date.now(), closed = false, minTimer, maxTimer;
  function close() {
    if (closed) return;
    closed = true;
    clearTimeout(minTimer); clearTimeout(maxTimer);
    root.classList.add('sd-out');
    setTimeout(function () { if (root.parentNode) root.parentNode.removeChild(root); }, 650);
  }
  function pageReady() { return document.readyState !== 'loading'; }
  function tryClose() {
    if (!pageReady()) return document.addEventListener('DOMContentLoaded', tryClose, { once: true });
    var left = MIN_MS - (Date.now() - started);
    if (left <= 0) close(); else minTimer = setTimeout(close, left);
  }
  maxTimer = setTimeout(close, MAX_MS);
  tryClose();
  root.addEventListener('click', close);        // тап — пропустить
  root.addEventListener('touchstart', close, { passive: true });
})();
