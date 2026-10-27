// The MCP Apps bridge (spec 2026-01-26): a view talks to the host that renders it over
// postMessage, in JSON-RPC 2.0. atlasApp.start() runs the handshake, then follows the host's
// theme and reports the view's height; request() and notify() reach the host (tools/call,
// ui/message, ui/update-model-context…) and on() receives what it pushes (the tool's input and
// result). Only messages from the parent window are read.
(function () {
  var nextId = 1;
  var pending = {};
  var handlers = {};

  function send(message) {
    message.jsonrpc = '2.0';
    window.parent.postMessage(message, '*');
  }

  function request(method, params) {
    var id = nextId++;
    send({ id: id, method: method, params: params || {} });
    return new Promise(function (resolve, reject) {
      pending[id] = { resolve: resolve, reject: reject };
    });
  }

  function notify(method, params) {
    send({ method: method, params: params || {} });
  }

  function applyContext(context) {
    var root = document.documentElement;
    if (!context) return;
    if (context.theme) root.setAttribute('data-theme', context.theme);
    var vars = context.styles && context.styles.variables;
    for (var name in vars || {}) root.style.setProperty(name, vars[name]);
  }

  // The host sizes the frame to the view: tell it whenever the content's height changes.
  function reportSize() {
    var last = 0;
    var observer = new ResizeObserver(function () {
      var height = Math.ceil(document.documentElement.getBoundingClientRect().height);
      if (height !== last) {
        last = height;
        notify('ui/notifications/size-changed', { height: height });
      }
    });
    observer.observe(document.body);
  }

  window.addEventListener('message', function (event) {
    var message = event.data;
    if (event.source !== window.parent || !message || message.jsonrpc !== '2.0') return;
    if (message.id != null && !message.method) {
      var waiting = pending[message.id];
      delete pending[message.id];
      if (waiting && message.error) waiting.reject(new Error(message.error.message || 'error'));
      else if (waiting) waiting.resolve(message.result);
      return;
    }
    if (message.method === 'ui/resource-teardown' || message.method === 'ping') {
      send({ id: message.id, result: {} });
      return;
    }
    if (message.method === 'ui/notifications/host-context-changed') applyContext(message.params);
    var handler = handlers[message.method];
    if (handler) handler(message.params || {});
  });

  window.atlasApp = {
    request: request,
    notify: notify,
    on: function (method, handler) { handlers[method] = handler; },
    // Field names as the SDK's schema has them (appInfo, not the spec prose's clientInfo):
    // hosts validate the request with it and drop one that doesn't match.
    start: function (name) {
      return request('ui/initialize', {
        protocolVersion: '2026-01-26',
        appInfo: { name: name, version: '1' },
        appCapabilities: { availableDisplayModes: ['inline'] },
      }).then(function (result) {
        applyContext(result && result.hostContext);
        notify('ui/notifications/initialized', {});
        reportSize();
        return result;
      }, function (error) {
        reportSize();  // a host keeps the frame closed until it knows its height: show the error
        throw error;
      });
    },
  };
})();
