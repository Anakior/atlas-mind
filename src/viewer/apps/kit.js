// What every view shares: atlasKit(labels, app) returns the helpers bound to a view's labels
// and its root element: label lookup, DOM building, icons, dates, the loading and status states,
// and reading a tool result.
window.atlasKit = function (T, app) {
  var lang = document.documentElement.lang;

  // Stroke icons on a 24-unit grid.
  var ICONS = {
    alert: '<path d="M12 4 2.5 20h19z"/><path d="M12 10v4m0 3h.01"/>',
    archive: '<rect x="3" y="4" width="18" height="5" rx="1"/><path d="M5 9v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9m-9 4h4"/>',
    arrow: '<path d="M5 12h14m-6-6 6 6-6 6"/>',
    back: '<path d="m15 6-6 6 6 6"/>',
    bolt: '<path d="M13 3 5 14h6l-1 7 8-11h-6z"/>',
    calendar: '<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16M9 3v4m6-4v4"/>',
    check: '<path d="m5 12 5 5L20 7"/>',
    chev: '<path d="m9 6 6 6-6 6"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/>',
    fog: '<path d="M4 9h12M7 13h13M4 17h10"/>',
    pause: '<path d="M9 5v14m6-14v14"/>',
    scissors: '<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M20 4 8.1 15.9m6.4-1.4L20 20M8.1 8.1 12 12"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    spark: '<path d="m12 3 1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.4 1.4m11.2 11.2L19 19M5 19l1.4-1.4M17.6 6.4 19 5"/>',
    sync: '<path d="M20 11a8 8 0 0 0-14.9-3M4 4v4h4m-4 5a8 8 0 0 0 14.9 3M20 20v-4h-4"/>',
    term: '<path d="m4 17 6-5-6-5m8 12h8"/>',
    trash: '<path d="M4 7h16M10 11v6m4-6v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
    undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
    up: '<path d="M7 17 17 7M8 7h9v9"/>',
    wind: '<path d="M3 9h11a3 3 0 1 0-3-3M3 15h15a3 3 0 1 1-3 3"/>',
  };

  function t(key, vars) {
    return (T[key] || key).replace(/\{(\w+)\}/g, function (_, k) { return vars && vars[k] != null ? vars[k] : ''; });
  }

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function add(parent) {
    for (var i = 1; i < arguments.length; i++) {
      var child = arguments[i];
      if (child) parent.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    }
    return parent;
  }

  function icon(name) {
    var box = document.createElement('span');
    box.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"' + (name === 'chev' ? ' class="chev"' : '') + '>' + ICONS[name] + '</svg>';
    return box.firstChild;
  }

  function day(iso) {
    return iso ? new Date(iso + 'T12:00:00').toLocaleDateString(lang, { day: 'numeric', month: 'short' }) : '';
  }

  function ago(iso) {
    return iso ? Math.max(0, Math.round((Date.now() - new Date(iso + 'T12:00:00')) / 864e5)) : null;
  }

  function docName(path) {
    return path.split('/').pop().replace(/\.(md|html)$/, '');
  }

  function status(text, cls) {
    app.className = '';
    app.replaceChildren(el('p', cls || 'note', text));
  }

  function loading(what) {
    var skel = el('div', 'skel');
    [['28%', 12], ['72%', 20], ['96%', 12], ['88%', 12], ['54%', 12]].forEach(function (bar) {
      var line = el('i');
      line.style.width = bar[0];
      line.style.height = bar[1] + 'px';
      skel.appendChild(line);
    });
    app.className = '';
    app.replaceChildren(skel, el('p', 'note', t('loading', { what: what })));
  }

  // A tool result's data (its structuredContent, else its JSON text); throws its message on error.
  function data(result) {
    var text = result && result.content && result.content[0] && result.content[0].text;
    if (!result || result.isError) throw new Error(text || '?');
    if (result.structuredContent) return result.structuredContent;
    try { return JSON.parse(text); } catch (e) { throw new Error('?'); }
  }

  return { lang: lang, t: t, el: el, add: add, icon: icon, day: day, ago: ago, docName: docName,
           status: status, loading: loading, data: data };
};
