// The first screen on the first launch, and the Settings screen after that: the server's address.
(function (S) {
  "use strict";

  var onDone = null;
  var input, field, message;

  function diagnostics() {
    var lines = ["App version  0.1.0", "Engine       " + navigator.userAgent];
    var mode = S.stream.mode();
    lines.push("WebRTC       " + (mode === "none" ? "not available in this engine" : "available"));
    lines.push("Video route  " + (mode === "iframe" ? "Neko page in an iframe" : mode === "client" ? "built-in Neko client" : "none"));
    lines.push("Screen       window " + window.innerWidth + "x" + window.innerHeight + ", screen " + screen.width + "x" +
      screen.height + ", pixel ratio " + window.devicePixelRatio + ", scale " + (document.documentElement.style.zoom || "1"));
    return lines.join("\n");
  }

  function stopEditing() {
    if (!S.focus.isLocked()) return;
    S.focus.lock(false);
    field.classList.remove("editing");
    if (document.activeElement === input) input.blur();
    S.focus.focus(field);
  }

  function save() {
    var base = S.api.normalize(input.value);
    if (!base) {
      message.className = "message";
      message.textContent = "That does not look like an address. Try 192.168.0.10:8080.";
      return;
    }
    message.className = "message ok";
    message.textContent = "Connecting to " + base + "...";
    S.api.discsFrom(base).then(function () {
      S.api.setServer(base);
      input.value = base;
      message.textContent = "";
      onDone();
    }, function (err) {
      message.className = "message";
      message.textContent = err.kind === "network"
        ? "No answer from " + base + ". Check that StreamISO is running and that CORS_ORIGIN=null is in its .env file."
        : "The server answered with an error: " + err.message;
    });
  }

  S.settings = {
    init: function () {
      input = S.$("server-input");
      field = S.$("server-field");
      message = S.$("settings-message");
      S.$("settings-diag").textContent = diagnostics();
      // The field loses the focus when the viewer leaves it, and also when webOS shows its keyboard, because the
      // app's window loses the focus then. Only leaving the field ends the editing, or the keyboard would close as
      // soon as it opens. When only the window lost the focus, the field is still the active element.
      input.addEventListener("blur", function () {
        setTimeout(function () { if (document.activeElement !== input) stopEditing(); }, 0);
      });
      // The keyboard was closed (Back, or its own close key). The voice key closes it for a moment and opens it
      // again, so this waits before ending the editing.
      var keyboardOpen = false;
      document.addEventListener("keyboardStateChange", function (e) {
        keyboardOpen = !!(e.detail && e.detail.visibility);
        if (keyboardOpen) return;
        setTimeout(function () {
          if (!keyboardOpen && document.activeElement === input && document.hasFocus()) stopEditing();
        }, 1500);
      });
      S.$("settings").addEventListener("click", function (e) {
        var act = e.target.closest("[data-act]");
        if (!act) return;
        var name = act.getAttribute("data-act");
        if (name === "edit") {
          // The TV's keyboard opens when the input gets the focus, so it gets it only on purpose.
          S.focus.lock(true);
          field.classList.add("editing");
          input.focus();
        } else if (name === "save") {
          save();
        } else if (name === "cancel") {
          S.settings.back();
        }
      });
    },
    show: function (done) {
      onDone = done;
      var configured = !!S.api.server();
      input.value = S.api.server().replace(/^http:\/\//, "");
      message.textContent = "";
      S.$("settings-title").textContent = configured ? "Settings" : "Connect to your server";
      S.$("settings-back").hidden = !configured;
      S.show("settings");
      S.focus.setScope(S.$("settings"), configured ? S.$("settings-save") : field);
    },
    back: function () {
      if (S.api.server()) onDone();
      else S.tv.exit();
    },
    // Keys while the field is being edited. The handler must not cancel them: the on-screen keyboard
    // needs them.
    handleEditingKey: function (e) {
      var done = e.keyCode === 461 || e.keyCode === 13 || e.keyCode === 27;
      if (done) stopEditing();
    },
    handleKey: function (name) {
      if (name === "back") S.settings.back();
      else if (name === "enter") S.focus.activate();
      else if (name === "left" || name === "right" || name === "up" || name === "down") S.focus.move(name);
    }
  };
})(window.Streamiso);
