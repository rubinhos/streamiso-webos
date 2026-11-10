// Starts the app and sends every key to whatever is on screen.
(function (S) {
  "use strict";

  var SCREENS = ["settings", "catalog", "player"];
  var current = null;

  S.show = function (name) {
    current = name;
    SCREENS.forEach(function (id) { S.$(id).hidden = id !== name; });
  };
  S.currentScreen = function () { return current; };

  function controller() {
    return current === "player" ? S.player : current === "settings" ? S.settings : S.catalog;
  }

  function onKeyDown(e) {
    if (S.focus.isLocked()) { S.settings.handleEditingKey(e); return; }
    var name = S.tv.keyName(e);
    if (!name) return;
    e.preventDefault();
    if (S.dialog.isOpen()) S.dialog.handleKey(name);
    else controller().handleKey(name);
  }

  // The layout is drawn for 1920x1080 and scaled to the window. The TV should give the app a 1920x1080 window
  // (appinfo.json), but some report another size, or their final size only after the app has started, so this
  // runs again a little later. On a PC, a smaller window shows the whole layout scaled down.
  function fitWindow() {
    var w = window.innerWidth, h = window.innerHeight;
    if (!w || !h) return;
    var scale = Math.min(w / 1920, h / 1080);
    document.documentElement.style.zoom = Math.abs(scale - 1) < 0.01 ? "" : String(scale);
  }

  function openSettings() {
    S.settings.show(function () { S.catalog.show(); });
  }

  function start() {
    fitWindow();
    window.addEventListener("resize", fitWindow);
    window.addEventListener("load", fitWindow);
    setTimeout(fitWindow, 500);
    setTimeout(fitWindow, 2000);
    S.tv.registerKeys();
    S.settings.init();
    S.catalog.init({
      open: function (disc, resume) { S.player.open(disc, resume); },
      settings: openSettings
    });
    S.player.init({ exit: function () { S.catalog.show(); } });
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("visibilitychange", function () {
      if (document.hidden) S.player.onHidden();
    });
    window.addEventListener("pagehide", S.player.onClosing);
    S.focus.guard();
    if (S.api.server()) S.catalog.show();
    else openSettings();
  }

  start();
})(window.Streamiso);
