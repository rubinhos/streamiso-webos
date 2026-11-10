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
      input.addEventListener("blur", function () { setTimeout(stopEditing, 0); });
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
