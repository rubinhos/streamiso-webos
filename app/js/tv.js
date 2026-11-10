// What only exists on an LG TV: the remote's keys, the screen saver, closing the app. On a PC these do
// nothing, and keyboard keys stand in for the remote.
(function (S) {
  "use strict";

  // Codes from LG's webOS TV guide. webOS sends them without registering anything. With
  // disableBackHistoryAPI in appinfo.json, Back arrives here as 461 instead of going back in history.
  var KEYS = {
    37: "left", 38: "up", 39: "right", 40: "down", 13: "enter", 461: "back",
    415: "play", 19: "pause", 413: "stop", 417: "forward", 412: "rewind", 457: "info",
    27: "back"  // Esc on a PC keyboard
  };
  // Letters for trying the other media keys on a PC keyboard. LG remotes have no play/pause toggle and no
  // next or previous, so these are PC only.
  var PC_KEYS = { " ": "playpause", s: "stop", f: "forward", r: "rewind", n: "next", p: "prev", i: "info" };

  // PalmServiceBridge is how a webOS web app reaches the TV's services. LG's webOSTV.js uses it too.
  function hasWebOS() { return typeof window.PalmServiceBridge === "function"; }

  function call(uri, params, onAnswer) {
    try {
      var bridge = new window.PalmServiceBridge();
      bridge.onservicecallback = function (text) {
        var answer = null;
        try { answer = JSON.parse(text); } catch (e) { /* not JSON */ }
        if (onAnswer && answer) onAnswer(answer);
      };
      bridge.call(uri, JSON.stringify(params || {}));
      return bridge;
    } catch (e) {
      return null;
    }
  }

  // The TV asks the apps that subscribe before it starts the screen saver. While a disc plays the app says no.
  // The bridge is kept in a variable, because the subscription ends if it is garbage collected.
  var keepOn = false, screenSaverWatch = null;
  var CLIENT = "streamiso";
  function watchScreenSaver() {
    if (screenSaverWatch || !hasWebOS()) return;
    screenSaverWatch = call("luna://com.webos.service.tvpower/power/registerScreenSaverRequest",
      { subscribe: true, clientName: CLIENT }, function (answer) {
        if (!answer.timestamp) return;
        call("luna://com.webos.service.tvpower/power/responseScreenSaverRequest",
          { clientName: CLIENT, ack: !keepOn, timestamp: answer.timestamp });
      });
  }

  S.tv = {
    isTv: hasWebOS,
    keyName: function (e) { return KEYS[e.keyCode] || PC_KEYS[e.key] || null; },
    // Nothing to register on webOS. This only starts listening for the screen saver.
    registerKeys: function () { watchScreenSaver(); },
    keepScreenOn: function (on) {
      keepOn = !!on;
      watchScreenSaver();
    },
    exit: function () {
      S.tv.exited = true;
      try { window.close(); } catch (e) { /* not on a TV */ }
    }
  };
})(window.Streamiso);
