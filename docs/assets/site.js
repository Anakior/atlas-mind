// The language: ?lang= in the address, else the last one chosen, else the browser's.
(function () {
  var asked = new URLSearchParams(location.search).get('lang');
  var saved = null;
  try { saved = localStorage.getItem('atlas-site-lang'); } catch (e) {}
  var lang = asked || saved || ((navigator.language || '').slice(0, 2) === 'fr' ? 'fr' : 'en');
  var root = document.documentElement;
  var titles = { en: document.title, fr: root.dataset.titleFr || document.title };
  var buttons = document.querySelectorAll('.lang-switch button');
  function show(l) {
    lang = l === 'fr' ? 'fr' : 'en';
    root.lang = lang;
    document.title = titles[lang];
    buttons.forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset.lang === lang)); });
  }
  buttons.forEach(function (b) {
    b.addEventListener('click', function () {
      show(b.dataset.lang);
      try { localStorage.setItem('atlas-site-lang', lang); } catch (e) {}
    });
  });
  show(lang);
})();
