/* ==========================================================================
   Сезонное оформление портала (сейчас — Хэллоуин).

   Включается само 20 октября по 1 ноября включительно, если пользователь
   не выбрал режим вручную. Выбор хранится в localStorage под ключом
   sd_season: auto | on | off — и действует на всех страницах сразу.

   Проверка в браузере: ?halloween=1 включает тему, ?halloween=0 выключает.
   Файл подключается в <head> раньше splash.js, чтобы заставка успела
   увидеть класс html.halloween.
   ========================================================================== */
(function () {
  'use strict';

  var KEY = 'sd_season';
  var NIGHT = '#07070d';
  var NIGHT_HW = '#0a0512';
  var root = document.documentElement;

  /* ---------- Когда пора ---------- */
  function inSeason(date) {
    var m = date.getMonth(), d = date.getDate();
    return (m === 9 && d >= 20) || (m === 10 && d <= 1);   /* 20 окт – 1 ноя */
  }

  function stored() {
    try {
      var v = localStorage.getItem(KEY);
      return v === 'on' || v === 'off' ? v : 'auto';
    } catch (e) { return 'auto'; }
  }

  function preview() {
    var m = /[?&]halloween=(1|on|true)/.exec(location.search);
    if (m) return 'on';
    if (/[?&]halloween=(0|off|false)/.exec(location.search)) return 'off';
    return null;
  }

  var forced = preview();
  var mode = forced || stored();
  var active = mode === 'on' || (mode === 'auto' && inSeason(new Date()));

  /* ---------- Декор ---------- */
  var WING = 'M58 13c-14-9-34-11-52-2 7 1 11 5 12 11 4-6 9-8 13-7-2 5-1 9 2 12 3-6 8-9 13-9 0 4 2 7 5 9 2-6 4-10 7-11z';

  function bat(cls) {
    return '<svg class="hw-bat ' + cls + '" viewBox="0 0 120 40" aria-hidden="true">' +
      '<g class="hw-wing"><path d="' + WING + '"/></g>' +
      '<g transform="translate(120,0) scale(-1,1)"><g class="hw-wing r"><path d="' + WING + '"/></g></g>' +
      '<ellipse cx="60" cy="21" rx="6" ry="11"/><circle cx="60" cy="10" r="5"/>' +
      '<path d="M54 7l-3-6 6 3zM66 7l3-6-6 3z"/>' +
      '</svg>';
  }

  function ring(r) {
    var k = r * 0.707;
    return 'M' + r + ' 0Q' + (r * 0.74) + ' ' + (r * 0.26) + ' ' + k.toFixed(1) + ' ' + k.toFixed(1) +
      'Q' + (r * 0.26) + ' ' + (r * 0.74) + ' 0 ' + r;
  }

  function web(cls) {
    return '<svg class="hw-web ' + cls + '" viewBox="0 0 100 100" aria-hidden="true">' +
      '<path d="M0 0L100 0M0 0L90 30M0 0L70 66M0 0L35 88M0 0L0 100"/>' +
      '<path d="' + ring(26) + '"/>' +
      '<path d="' + ring(50) + '"/>' +
      '<path d="' + ring(76) + '"/>' +
      '<path d="' + ring(100) + '"/>' +
      '</svg>';
  }

  function embers() {
    var out = '', i;
    for (i = 0; i < 14; i++) {
      out += '<i class="hw-ember" style="left:' + Math.round(Math.random() * 100) + '%;' +
        'width:' + (3 + Math.round(Math.random() * 3)) + 'px;height:' + (3 + Math.round(Math.random() * 3)) + 'px;' +
        '--dx:' + (Math.random() < .5 ? -1 : 1) * Math.round(Math.random() * 60) + 'px;' +
        'animation-duration:' + (7 + Math.random() * 7).toFixed(1) + 's;' +
        'animation-delay:-' + (Math.random() * 10).toFixed(1) + 's"></i>';
    }
    return out;
  }

  function layer() {
    return '<div class="hw-layer" aria-hidden="true">' +
      '<div class="hw-moon"><i></i><i></i><i></i><i></i></div>' +
      web('tl') + web('tr') +
      bat('s1') + bat('s2') + bat('s3') +
      '<div class="hw-fog"></div>' +
      embers() +
      '<svg class="hw-joan" viewBox="0 0 120 100" aria-hidden="true">' +
        '<defs><linearGradient id="hwP" x1="0" y1="0" x2="0" y2="1">' +
          '<stop offset="0" stop-color="#fb923c"/><stop offset="1" stop-color="#ea580c"/>' +
        '</linearGradient></defs>' +
        '<g class="hw-lantern">' +
          '<path d="M58 28c-1-9 2-15 9-18-3 7-2 13 2 18z" fill="#4d7c0f"/>' +
          '<ellipse cx="60" cy="62" rx="44" ry="33" fill="url(#hwP)"/>' +
          '<ellipse cx="30" cy="62" rx="21" ry="29" fill="url(#hwP)"/>' +
          '<ellipse cx="90" cy="62" rx="21" ry="29" fill="url(#hwP)"/>' +
          '<path d="M60 30v64M42 34c-5 18-5 42 0 58M78 34c5 18 5 42 0 58" fill="none" stroke="#9a3412" stroke-opacity=".45" stroke-width="2"/>' +
          '<path d="M40 55l14 8-14 7zM80 55l-14 8 14 7z" fill="#fff2cf"/>' +
          '<path d="M60 60l6 8-6 6-6-6z" fill="#fff2cf"/>' +
          '<path d="M40 76l8 6 6-6 6 7 6-7 8 6 6-5-3 10-9 3-8-4-8 4-9-3z" fill="#fff2cf"/>' +
        '</g>' +
      '</svg>' +
    '</div>';
  }

  /* ---------- Применение ---------- */
  function paintMeta() {
    var metas = document.querySelectorAll('meta[name="theme-color"]');
    for (var i = 0; i < metas.length; i++) metas[i].setAttribute('content', active ? NIGHT_HW : NIGHT);
  }

  function mountLayer() {
    var scene = document.querySelector('.bg-scene');
    if (!scene) return;
    var old = scene.querySelector('.hw-layer');
    if (old) old.remove();
    if (active) scene.insertAdjacentHTML('beforeend', layer());
  }

  function apply() {
    root.classList.toggle('halloween', active);
    root.dataset.season = active ? 'halloween' : 'plain';
    paintMeta();
    if (document.body) mountLayer();
  }

  apply();
  if (!document.body) document.addEventListener('DOMContentLoaded', mountLayer, { once: true });

  /* ---------- Внешний API (настройки дневника) ---------- */
  window.SD_SEASON = {
    key: KEY,
    active: function () { return active; },
    mode: function () { return forced || stored(); },
    /* mode: 'auto' | 'on' | 'off' */
    set: function (next) {
      try { localStorage.setItem(KEY, next); } catch (e) { /* приватный режим — только на эту загрузку */ }
      forced = next === 'auto' ? null : next;
      mode = next;
      active = next === 'on' || (next === 'auto' && inSeason(new Date()));
      apply();
      document.dispatchEvent(new CustomEvent('sd:season', { detail: { active: active, mode: next } }));
    }
  };

  /* ---------- Оформление профиля ----------
     Выбор лежит в localStorage под ключом sd_design и применяется до отрисовки,
     чтобы страница не «моргала» из фирменной темы в розовую. Сервер проверяет,
     разрешено ли человеку это оформление; здесь только отрисовка. */
  var DESIGN_KEY = 'sd_design';
  var DESIGN_IDS = ['aurora', 'ocean', 'sunset', 'rose', 'crimson', 'gold', 'acid'];

  function designStored() {
    try {
      var v = localStorage.getItem(DESIGN_KEY);
      return DESIGN_IDS.indexOf(v) >= 0 ? v : 'aurora';
    } catch (e) { return 'aurora'; }
  }

  function paintDesign(id) {
    if (id === 'aurora') root.removeAttribute('data-design');
    else root.setAttribute('data-design', id);
  }

  paintDesign(designStored());

  window.SD_DESIGN = {
    key: DESIGN_KEY,
    ids: DESIGN_IDS,
    current: designStored,
    /* Разрешённые ids приходят с сервера: чужой эксклюзив не включается.
       fallback — оформление из профиля, если на этом устройстве ещё ничего не выбирали. */
    allowed: function (ids, fallback) {
      var list = (ids || []).filter(function (id) { return DESIGN_IDS.indexOf(id) >= 0; });
      var want = designStored();
      var pick = list.indexOf(want) >= 0 ? want
        : (list.indexOf(fallback) >= 0 ? fallback
          : (list.indexOf('aurora') >= 0 ? 'aurora' : list[0] || 'aurora'));
      paintDesign(pick);
      return pick;
    },
    set: function (id) {
      try { localStorage.setItem(DESIGN_KEY, DESIGN_IDS.indexOf(id) >= 0 ? id : 'aurora'); } catch (e) { /* приватный режим */ }
      paintDesign(DESIGN_IDS.indexOf(id) >= 0 ? id : 'aurora');
      document.dispatchEvent(new CustomEvent('sd:design', { detail: { design: id } }));
    }
  };
})();
