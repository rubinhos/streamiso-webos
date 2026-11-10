// Small helpers shared by the whole app. Everything hangs off one global, window.Streamiso.
// All the JavaScript stays in plain ES5-style code, because older webOS TVs run apps on old Chromium engines.
window.Streamiso = window.Streamiso || {};
(function (S) {
  "use strict";

  S.$ = function (id) { return document.getElementById(id); };

  // 65 -> "1:05", 3675 -> "1:01:15"
  S.formatTime = function (seconds) {
    var total = Math.max(0, Math.floor(seconds || 0));
    var h = Math.floor(total / 3600);
    var m = Math.floor(total / 60) % 60;
    var s = total % 60;
    var ss = (s < 10 ? "0" : "") + s;
    if (h) return h + ":" + (m < 10 ? "0" : "") + m + ":" + ss;
    return m + ":" + ss;
  };
})(window.Streamiso);
