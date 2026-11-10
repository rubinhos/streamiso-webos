// What the oldest webOS engines lack. webOS 3.x runs apps on Chrome 38 (2014), which has Promise but not
// Element.closest, fetch or AbortController. Each one is only added when missing, so newer TVs use their own.
// Loaded before everything else.
(function () {
  "use strict";

  var proto = window.Element && Element.prototype;
  if (proto && !proto.matches) {
    proto.matches = proto.webkitMatchesSelector || proto.msMatchesSelector;
  }
  if (proto && !proto.closest) {
    proto.closest = function (selector) {
      for (var el = this; el && el.nodeType === 1; el = el.parentNode) {
        if (el.matches(selector)) return el;
      }
      return null;
    };
  }

  if (window.NodeList && !NodeList.prototype.forEach) NodeList.prototype.forEach = Array.prototype.forEach;

  if (!window.AbortController) {
    window.AbortController = function () {
      var signal = { aborted: false, onabort: null };
      this.signal = signal;
      this.abort = function () {
        if (signal.aborted) return;
        signal.aborted = true;
        if (signal.onabort) signal.onabort();
      };
    };
  }

  // Only what the app uses: method, headers, body and signal; the answer's ok, status, json() and text().
  if (!window.fetch) {
    window.fetch = function (url, options) {
      options = options || {};
      return new Promise(function (resolve, reject) {
        var xhr = new XMLHttpRequest();
        xhr.open(options.method || "GET", url, true);
        var headers = options.headers || {};
        for (var name in headers) {
          if (Object.prototype.hasOwnProperty.call(headers, name)) xhr.setRequestHeader(name, headers[name]);
        }
        xhr.onload = function () {
          var text = xhr.responseText;
          resolve({
            ok: xhr.status >= 200 && xhr.status < 300,
            status: xhr.status,
            text: function () { return Promise.resolve(text); },
            json: function () {
              return new Promise(function (ok) { ok(JSON.parse(text)); });
            }
          });
        };
        xhr.onerror = xhr.ontimeout = function () { reject(new TypeError("Network request failed")); };
        xhr.onabort = function () { reject(new Error("Aborted")); };
        if (options.signal) {
          if (options.signal.aborted) { reject(new Error("Aborted")); return; }
          options.signal.onabort = function () { xhr.abort(); };
        }
        xhr.send(options.body === undefined ? null : options.body);
      });
    };
  }
})();
