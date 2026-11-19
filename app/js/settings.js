// The first screen on the first launch, and the Settings screen after that: the server's addresses and key.
(function (S) {
  "use strict";

  var onDone = null;
  var message;
  var editing = null;  // the field being typed in
  var choice = "auto";

  var ROUTES = { iframe: "WebRTC, Neko page in an iframe", client: "WebRTC, built-in Neko client", plain: "plain video (HLS)", none: "none" };
  var PREFERENCES = ["auto", "plain", "webrtc"];
  var PREFERENCE_NAMES = { auto: "Automatic", plain: "Plain video", webrtc: "WebRTC" };
  var CHOICE_NAMES = { auto: "Automatic", first: "Address", second: "Second address" };

  function input(id) { return S.$(id); }

  function diagnostics() {
    var lines = ["App version  0.1.0", "Engine       " + navigator.userAgent];
    lines.push("WebRTC       " + (typeof window.RTCPeerConnection === "function" ? "available" : "not available in this engine"));
    lines.push("Video route  " + ROUTES[S.stream.mode()]);
    lines.push("Server       " + (S.api.server() || "none yet"));
    lines.push("Screen       window " + window.innerWidth + "x" + window.innerHeight + ", screen " + screen.width + "x" +
      screen.height + ", pixel ratio " + window.devicePixelRatio + ", scale " + (document.documentElement.style.zoom || "1"));
    return lines.join("\n");
  }

  function showChoices() {
    var preference = S.stream.preference();
    S.$("settings-video").textContent = "Video: " + PREFERENCE_NAMES[preference] +
      (preference === "auto" ? " (" + ROUTES[S.stream.mode()] + ")" : "");
    S.$("settings-choice").textContent = "Use: " + CHOICE_NAMES[choice];
    S.$("settings-diag").textContent = diagnostics();
  }

  function nextVideoChoice() {
    var at = PREFERENCES.indexOf(S.stream.preference());
    S.stream.setPreference(PREFERENCES[(at + 1) % PREFERENCES.length]);
    showChoices();
  }

  // Automatic, the address, the second address (only offered once one is typed).
  function nextServerChoice() {
    var list = input("server2-input").value.trim() ? S.api.choices : ["auto", "first"];
    choice = list[(list.indexOf(choice) + 1) % list.length];
    showChoices();
  }

  function startEditing(field) {
    S.focus.lock(true);
    editing = field;
    field.classList.add("editing");
    input(field.getAttribute("data-input")).focus();
  }

  function stopEditing() {
    if (!S.focus.isLocked() || !editing) return;
    var field = editing, el = input(field.getAttribute("data-input"));
    editing = null;
    S.focus.lock(false);
    field.classList.remove("editing");
    if (document.activeElement === el) el.blur();
    S.focus.focus(field);
    showChoices();
  }

  function fail(text) {
    message.className = "message";
    message.textContent = text;
  }

  // Checks the addresses that will be used, then saves. With Automatic, one of the two answering is enough.
  function save() {
    var first = S.api.normalize(input("server-input").value);
    var secondText = input("server2-input").value.trim();
    var second = secondText ? S.api.normalize(secondText) : "";
    var key = input("key-input").value.trim();
    if (!first) return fail("That does not look like an address. Try 192.168.0.10:8080.");
    if (secondText && !second) return fail("The second address does not look like an address. Try 100.101.102.103:8080.");
    if (choice === "second" && !second) choice = "auto";
    var list = choice === "first" || !second ? [first] : choice === "second" ? [second] : [first, second];
    message.className = "message ok";
    message.textContent = "Connecting to " + list.join(" or ") + "...";
    var problems = [];
    function attempt(i) {
      if (i >= list.length) return fail(problems.join("\n"));
      S.api.discsFrom(list[i], key).then(function () {
        S.api.save({ first: first, second: second, key: key, choice: choice, server: list[i] });
        input("server-input").value = first;
        input("server2-input").value = second;
        message.textContent = "";
        onDone();
      }, function (err) {
        if (err.kind === "network") {
          problems.push("No answer from " + list[i] + ". Check that StreamISO is running there.");
          attempt(i + 1);
        } else if (err.status === 403) {
          fail(list[i] + " refused the key: " + err.message + ".");
        } else {
          fail("The server answered with an error: " + err.message);
        }
      });
    }
    attempt(0);
  }

  S.settings = {
    init: function () {
      message = S.$("settings-message");
      showChoices();
      // A field loses the focus when the viewer leaves it, and also when webOS shows its keyboard, because the
      // app's window loses the focus then. Only leaving the field ends the editing, or the keyboard would close as
      // soon as it opens. When only the window lost the focus, the field is still the active element.
      ["server-input", "server2-input", "key-input"].forEach(function (id) {
        input(id).addEventListener("blur", function () {
          setTimeout(function () { if (editing && document.activeElement !== input(id)) stopEditing(); }, 0);
        });
      });
      // The keyboard was closed (Back, or its own close key). The voice key closes it for a moment and opens it
      // again, so this waits before ending the editing.
      var keyboardOpen = false;
      document.addEventListener("keyboardStateChange", function (e) {
        keyboardOpen = !!(e.detail && e.detail.visibility);
        if (keyboardOpen) return;
        setTimeout(function () {
          if (!keyboardOpen && editing && document.activeElement === input(editing.getAttribute("data-input")) &&
              document.hasFocus()) stopEditing();
        }, 1500);
      });
      S.$("settings").addEventListener("click", function (e) {
        var act = e.target.closest("[data-act]");
        if (!act) return;
        var name = act.getAttribute("data-act");
        if (name === "edit") {
          // The TV's keyboard opens when the input gets the focus, so it gets it only on purpose.
          startEditing(act);
        } else if (name === "save") {
          save();
        } else if (name === "video") {
          nextVideoChoice();
        } else if (name === "choice") {
          nextServerChoice();
        } else if (name === "cancel") {
          S.settings.back();
        }
      });
    },
    show: function (done) {
      onDone = done;
      var saved = S.api.saved();
      var configured = !!saved.first;
      input("server-input").value = saved.first.replace(/^http:\/\//, "");
      input("server2-input").value = saved.second.replace(/^http:\/\//, "");
      input("key-input").value = saved.key;
      choice = saved.choice;
      message.textContent = "";
      showChoices();
      S.$("settings-title").textContent = configured ? "Settings" : "Connect to your server";
      S.$("settings-back").hidden = !configured;
      S.show("settings");
      S.focus.setScope(S.$("settings"), configured ? S.$("settings-save") : S.$("server-field"));
    },
    back: function () {
      if (S.api.saved().first) onDone();
      else S.tv.exit();
    },
    // Keys while a field is being edited. The handler must not cancel them: the on-screen keyboard
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
