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

  // A window narrower than the TV, on a PC, shows the whole 1920x1080 layout scaled down.
  function fitWindow() {
    document.documentElement.style.zoom = window.innerWidth === 1920 ? "" : String(window.innerWidth / 1920);
  }

  function openSettings() {
    S.settings.show(function () { S.catalog.show(); });
  }

  function start() {
    fitWindow();
    window.addEventListener("resize", fitWindow);
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
