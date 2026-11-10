// The player. The same keys do different things depending on what is on screen:
//   DVD starting:    the bar stays closed, so nothing covers the disc's own menu. Back or Info open it.
//   DVD, bar closed: Left, Right and OK always go to the disc through the API. Up and Down go to it in a menu,
//                    and open the bar during a film. During a film Back is Return, the Menu key of a DVD remote:
//                    back to the menu of what is playing. In a menu Back opens the bar (a remote without an Info
//                    key has no other way to it there), and Info always does.
//   DVD, bar open:   arrows move between the buttons. Back closes it, and so do a few seconds without a key.
//   CD:              there is no video menu, so arrows move through the track list and the buttons.
//                    Back leaves the player.
// Media keys work everywhere in the player. The focus never goes into the stream.
(function (S) {
  "use strict";

  var config = { readyTimeoutMs: 25000, barHideMs: 6000, pollMs: 1000, osdMs: 2500, idleGraceMs: 5000, startRetries: 20, soundCheckMs: 2000, scrubCommitMs: 600, navWindowMs: 5000 };
  var ARROWS = { left: 1, right: 1, up: 1, down: 1 };
  var SCRUB_RUN_MS = 700;
  var STATUS_SETTLE_MS = 300;
  var MENU_MAX_SECONDS = 300;
  // The same icons as StreamISO's web player.
  var ICON_PLAY = '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>';
  var ICON_PAUSE = '<svg viewBox="0 0 24 24"><path d="M6 5h4v14H6zm8 0h4v14h-4z"/></svg>';
  var session = null;
  var onExit = null;
  var S$ = S.$;

  function osd(text) {
    var el = S$("osd");
    el.textContent = text;
    el.hidden = false;
    clearTimeout(osd.timer);
    osd.timer = setTimeout(function () { el.hidden = true; }, config.osdMs);
  }

  function cmd(action, value) {
    if (session) session.lastCmd = Date.now();
    return S.api.cmd(action, value).catch(function (err) {
      if (err.status === 503) osd("The player is not ready yet");
      else if (err.status !== 409) osd(err.kind === "network" ? "No answer from the server" : err.message);
      throw err;
    });
  }
  function fire(action, value) { cmd(action, value).catch(function () { /* already shown */ }); }

  // Up and Down open the bar during a film, but a disc's menu needs them. On real discs a menu reports title 0
  // and a duration of seconds to a few minutes, so a short title counts as a menu, as it does for StreamISO's
  // resume. A menu may still look like a film, so these keys also stay with the disc right after using it.
  function inMenu() {
    var st = session.status;
    return !st || !st.length || st.title === 0 || st.length < MENU_MAX_SECONDS;
  }
  function upDownGoToDisc() {
    return inMenu() || Date.now() - session.lastNav < config.navWindowMs;
  }
  // Return: the Root menu of the part of the disc that is playing, where the disc's author sends the Menu key of
  // a DVD remote, often the menu the film or extra was started from.
  function sendReturn() {
    session.lastNav = Date.now();  // the menu it opens needs Up and Down
    fire("return");
    osd("Return");
  }
  function sendNav(value) {
    session.lastNav = Date.now();
    fire("nav", value);
  }

  // ------------------------------------------------------------- the bar (DVD)
  function bumpBar() {
    clearTimeout(session.barTimer);
    if (session.kind === "cd") return;
    session.barTimer = setTimeout(closeBar, config.barHideMs);
  }
  function openBar() {
    session.barOpen = true;
    S$("bar").hidden = false;
    renderStatus();
    S.focus.setScope(S$("bar"), S$("btn-toggle"));
    bumpBar();
  }
  function closeBar() {
    if (!session) return;
    clearTimeout(session.barTimer);
    commitScrub();
    closePop();
    session.barOpen = false;
    S$("bar").hidden = true;
    S.focus.setScope(S$("sink"));
  }

  function closePop() {
    if (!session.pop) return;
    session.pop = null;
    S$("pop").hidden = true;
    S.focus.setScope(S$("bar"), session.popButton);
  }
  function openPop(button, title, items, action) {
    if (!items || !items.length) { osd(title + ": none on this disc"); return; }
    var list = S$("pop-list");
    list.innerHTML = "";
    items.forEach(function (item) {
      var b = document.createElement("button");
      b.type = "button";
      b.tabIndex = -1;
      b.setAttribute("data-focusable", "");
      var name = item.id === -1 ? "Off" : item.name;
      b.textContent = name;
      b.addEventListener("click", function () {
        fire(action, item.id);
        osd(title + ": " + name);
        closePop();
      });
      list.appendChild(b);
    });
    S$("pop-title").textContent = title;
    session.pop = true;
    session.popButton = button;
    S$("pop").hidden = false;
    S.focus.setScope(S$("pop"));
  }

  // ---------------------------------------------------------------- the actions
  function seekBy(seconds) {
    var st = session.status;
    if (!st || !st.length) { osd("Not available here"); return; }
    var target = Math.max(0, Math.min(st.length, (st.time || 0) + seconds));
    st.time = target;
    renderStatus();
    osd((seconds > 0 ? "+" : "−") + Math.abs(seconds) + " s   " + S.formatTime(target));
    fire("seek", Math.floor(target));
  }
  function setVolume(delta) {
    var st = session.status;
    var volume = Math.max(0, Math.min(100, (st && typeof st.volume === "number" ? st.volume : 100) + delta));
    if (st) st.volume = volume;
    osd("Volume " + volume + "%");
    fire("volume", volume);
  }
  function toggleMute() {
    var st = session.status;
    var volume = st && typeof st.volume === "number" ? st.volume : 100;
    if (volume > 0) {
      session.premute = volume;
      setVolume(-volume);
      osd("Muted");
    } else {
      setVolume(session.premute || 100);
    }
  }

  // The progress line: each press moves a preview, and the jump happens when the presses stop. Holding the
  // key moves faster, because a film is too long to cross in steps of 10 seconds.
  function scrub(direction) {
    var st = session.status;
    if (!st || !st.length) { osd("Not available here"); return; }
    var now = Date.now();
    var run = session.scrub;
    if (!run) run = session.scrub = { target: st.time || 0, presses: 0, last: 0 };
    run.presses = now - run.last < SCRUB_RUN_MS ? run.presses + 1 : 1;
    run.last = now;
    var size = run.presses > 12 ? 60 : run.presses > 4 ? 30 : 10;
    run.target = Math.max(0, Math.min(st.length - 1, run.target + direction * size));
    renderStatus();
    clearTimeout(session.scrubTimer);
    session.scrubTimer = setTimeout(commitScrub, config.scrubCommitMs);
  }
  function commitScrub() {
    if (!session || !session.scrub) return;
    clearTimeout(session.scrubTimer);
    var target = Math.floor(session.scrub.target);
    session.scrub = null;
    if (session.status) session.status.time = target;
    renderStatus();
    osd(S.formatTime(target));
    fire("seek", target);
  }
  function toggle() {
    var playing = session.status && session.status.state === "playing";
    if (session.status) session.status.state = playing ? "paused" : "playing";
    renderStatus();
    osd(playing ? "Paused" : "Playing");
    fire("toggle");
  }
  // The media keys Play and Pause only act when they would change something.
  function playOnly(wanted) {
    var playing = session.status && session.status.state === "playing";
    if (playing !== wanted) toggle();
  }
  function step(direction) {
    osd(direction > 0 ? "Next" : "Previous");
    fire(direction > 0 ? "chapter_next" : "chapter_prev");
  }

  var ACTIONS = {
    prev: function () { step(-1); },
    next: function () { step(1); },
    back10: function () { seekBy(-10); },
    fwd10: function () { seekBy(10); },
    toggle: toggle,
    voldown: function () { setVolume(-5); },
    volup: function () { setVolume(5); },
    mute: toggleMute,
    commit: commitScrub,
    audio: function (button) { openPop(button, "Audio", session.status && session.status.audio, "audio"); },
    subs: function (button) { openPop(button, "Subtitles", session.status && session.status.subtitles, "subtitle"); },
    menu: function () { fire("menu"); closeBar(); },
    // the menu of the part that is playing, as the Menu key of a DVD remote: often the one it was started from
    back: function () { closeBar(); sendReturn(); },
    leave: function () { leave(); }
  };

  // Both the remote and the bridge in the stream's page end up here.
  function mediaKey(name) {
    switch (name) {
      case "playpause": toggle(); return true;
      case "play": playOnly(true); return true;
      case "pause": playOnly(false); return true;
      case "forward": seekBy(10); return true;
      case "rewind": seekBy(-10); return true;
      case "next": step(1); return true;
      case "prev": step(-1); return true;
      case "stop": leave(); return true;
      default: return false;
    }
  }

  // ------------------------------------------------------------------ rendering
  function renderTracks(st) {
    var current = typeof st.track === "number" ? st.track : -1;
    if (current === session.track) return;
    session.track = current;
    var items = S$("cd-tracks").children;
    for (var i = 0; i < items.length; i++) items[i].classList.toggle("current", i === current);
  }

  // Only changes text and classes: replacing a button here would drop the focus.
  function renderStatus() {
    var st = session && session.status;
    if (!st) return;
    var playing = st.state === "playing";
    var toggleButton = S$("btn-toggle");
    var wanted = playing ? "Pause" : "Play";
    if (toggleButton.getAttribute("aria-label") !== wanted || !toggleButton.firstChild) {
      toggleButton.setAttribute("aria-label", wanted);
      toggleButton.innerHTML = playing ? ICON_PAUSE : ICON_PLAY;
    }
    renderCaption();
    var length = st.length || 0;
    var now = session.scrub ? session.scrub.target : st.time || 0;
    S$("time-now").textContent = length ? S.formatTime(now) : "";
    S$("time-left").textContent = length ? "−" + S.formatTime(length - now) : "";
    S$("progress-fill").style.width = (length ? Math.min(100, now / length * 100) : 0) + "%";
    var extra = "";
    if (session.kind === "cd") {
      if (typeof st.track === "number") extra = "Track " + (st.track + 1) + (st.tracks ? " of " + st.tracks : "");
      renderTracks(st);
    } else if (st.title === 0 || !length) {
      extra = "DVD menu";
    } else if (typeof st.chapter === "number") {
      extra = "Chapter " + (st.chapter + 1);
    }
    S$("bar-extra").textContent = extra;
  }

  function renderCaption() {
    var active = document.activeElement;
    var inBar = active && S$("bar").contains(active);
    S$("bar-caption").textContent = inBar ? active.getAttribute("aria-label") || "" : "";
  }

  function showLoading(title, text) {
    S$("loading").hidden = false;
    S$("loading-title").textContent = title;
    S$("loading-text").textContent = text || "";
  }

  function buildCd(info) {
    S$("cd-cover").src = info.cover ? absolute(info.cover) : S.api.coverUrl(session.disc);
    S$("cd-title").textContent = info.title || "";
    S$("cd-artist").textContent = info.artist || "";
    var list = S$("cd-tracks");
    list.innerHTML = "";
    (info.tracks || []).forEach(function (t, i) {
      var li = document.createElement("li");
      li.tabIndex = -1;
      li.setAttribute("data-focusable", "");
      [["n", String(t.n)], ["t", t.title], ["d", t.length ? S.formatTime(t.length) : ""]].forEach(function (cell) {
        var span = document.createElement("span");
        span.className = cell[0];
        span.textContent = cell[1];
        li.appendChild(span);
      });
      li.addEventListener("click", function () {
        fire("track", i);
        osd("Track " + t.n);
      });
      list.appendChild(li);
    });
    S$("cd").hidden = false;
    S$("bar").hidden = false;
  }

  function absolute(path) { return /^https?:/i.test(path) ? path : S.api.server() + path; }

  // ---------------------------------------------------------------------- errors
  function failure(title, text, retry) {
    if (!session || session.failed) return;
    session.failed = true;
    clearInterval(session.poll);
    clearTimeout(session.readyTimer);
    var buttons = [{ label: "Back to library", action: function () { leave(); } }];
    if (retry) buttons.unshift({ label: "Try again", action: retry });
    S.dialog.show({ title: title, text: text, buttons: buttons, onBack: function () { leave(); } });
  }

  function reopen() {
    var disc = session.disc, resume = session.resume;
    teardown();
    S.player.open(disc, resume);
  }

  // The network is only worth blaming once the TV has answered the server's offer.
  function streamFailure() {
    var step = session.stream && session.stream.step ? session.stream.step() : "";
    var text = "No picture after " + Math.round(config.readyTimeoutMs / 1000) + " seconds. Last step: " + step + ".";
    if (/network/.test(step)) text += "\nCheck SERVER_IP on the server and that UDP ports 52000-52100 are open.";
    failure("The video did not start", text, reopen);
  }

  // ------------------------------------------------------------- the opening flow
  // Discs open paused. Once VLC is up and the video has arrived: jump to the saved position, then start.
  function tryStart() {
    var current = session;
    if (!current || current.starting || current.started || !current.streamReady || !current.vlcUp) return;
    current.starting = true;
    var attempts = 0;
    function attempt() {
      if (current !== session) return;
      var first = current.info.resume ? S.api.cmd("resume_apply") : Promise.resolve();
      first.then(function () { return S.api.cmd("start"); }).then(function () {
        if (current !== session) return;
        started();
      }, function () {
        if (current !== session) return;
        // 503 means VLC is not ready yet. Both commands are safe to send again.
        if (++attempts >= config.startRetries) failure("The disc did not start", "VLC did not accept the start command.", reopen);
        else setTimeout(attempt, 1000);
      });
    }
    attempt();
  }

  function started() {
    session.started = true;
    clearTimeout(session.readyTimer);
    S$("loading").hidden = true;
    session.stream.unlock();
    // The stream only reports a change, so a sound that stays blocked has to be noticed from here.
    var current = session;
    setTimeout(function () {
      if (current === session && session.audible === false) S$("hint").hidden = false;
    }, config.soundCheckMs);
    if (session.kind === "cd") {
      var items = S$("cd-tracks").children;
      var at = session.status && typeof session.status.track === "number" ? session.status.track : 0;
      S.focus.setScope(S$("player"), items[at] || S$("btn-toggle"));
    }
    // A DVD starts with the bar closed: many discs open on a menu, and the bar would cover its buttons.
  }

  function poll() {
    var current = session;
    var sentAt = Date.now();
    S.api.status().then(function (st) {
      if (current !== session || current.failed) return;
      current.failures = 0;
      // Asked before the last command took effect: it would undo what the screen already shows.
      if (current.started && sentAt < current.lastCmd + STATUS_SETTLE_MS) return;
      if (st.state === "offline") {
        current.vlcUp = false;
        if (current.started) showLoading("VLC is starting", current.disc.title);
        else S$("loading-text").textContent = "VLC is starting";
        return;
      }
      if (st.state === "idle") {
        if (current.started || Date.now() - current.openedAt > config.idleGraceMs) {
          failure("Nothing is playing", "The disc was closed on the server, or it has not opened.");
        }
        return;
      }
      current.vlcUp = true;
      current.status = st;
      if (current.started) S$("loading").hidden = true;
      else S$("loading-text").textContent = current.streamReady ? "Starting the disc" : "Connecting to the video";
      renderStatus();
      tryStart();
    }, function (err) {
      if (current !== session || current.failed) return;
      if (err.kind !== "network") return;
      if (++current.failures >= 3) {
        failure("Server unreachable", "No answer from " + S.api.server() + " while playing.", function () {
          current.failed = false;
          current.failures = 0;
          current.poll = setInterval(poll, config.pollMs);
        });
      }
    });
  }

  function startStream(info) {
    session.info = info;
    S$("bar-title").textContent = info.title || session.disc.title;
    if (session.kind === "cd") buildCd(info);
    if (S.stream.mode() === "none") {
      failure("This TV cannot play the stream", "The web engine for installed apps on this TV has no WebRTC.");
      return;
    }
    session.stream = S.stream.open(info.url, S$("stage"), {
      onReady: function () {
        if (!session) return;
        session.streamReady = true;
        tryStart();
      },
      onError: function (detail) {
        failure("This TV did not accept the stream", detail + "\n\n" + navigator.userAgent, reopen);
      },
      onAudio: function (ok) {
        if (!session) return;
        session.audible = ok;
        S$("hint").hidden = ok || !session.started;
      },
      onKey: function (action) {
        if (!session) return;
        // Same meaning as the remote, for a key pressed while the page briefly held the focus.
        if (action === "toggle") S.player.handleKey("playpause");
        else if (action === "back" || action === "stop" || action === "next" || action === "prev" ||
                 action === "forward" || action === "rewind") S.player.handleKey(action);
        else if (action.indexOf("nav-") === 0) S.player.handleKey(action === "nav-activate" ? "enter" : action.slice(4));
      }
    });
    session.readyTimer = setTimeout(function () {
      if (session && !session.streamReady) streamFailure();
    }, config.readyTimeoutMs);
    session.poll = setInterval(poll, config.pollMs);
    poll();
  }

  function teardown() {
    if (!session) return;
    clearInterval(session.poll);
    clearTimeout(session.readyTimer);
    clearTimeout(session.barTimer);
    clearTimeout(session.scrubTimer);
    if (session.stream) session.stream.close();
    session = null;
    S.tv.keepScreenOn(false);
    S$("stage").innerHTML = "";
    S$("bar").hidden = true;
    S$("pop").hidden = true;
    S$("cd").hidden = true;
    S$("hint").hidden = true;
    S$("osd").hidden = true;
    document.body.classList.remove("cd-mode");
  }

  function leave() {
    if (S.dialog.isOpen()) S.dialog.close();
    S.api.stop().catch(function () { /* the library shows if the server is gone */ });
    teardown();
    onExit();
  }

  // --------------------------------------------------------------------- the API
  S.player = {
    config: config,
    init: function (handlers) {
      onExit = handlers.exit;
      S$("bar").addEventListener("click", function (e) {
        var button = e.target.closest("[data-act]");
        if (button && session) ACTIONS[button.getAttribute("data-act")](button);
      });
      S$("bar").addEventListener("focusin", renderCaption);
    },
    isOpen: function () { return !!session; },
    open: function (disc, resume) {
      S.show("player");
      session = {
        disc: disc, resume: resume, kind: disc.kind === "cd" ? "cd" : "dvd", openedAt: Date.now(),
        status: null, stream: null, info: null, failures: 0, track: -1, lastCmd: 0, lastNav: 0,
        streamReady: false, vlcUp: false, starting: false, started: false, failed: false,
        audible: null, barOpen: false, pop: null
      };
      document.body.classList.toggle("cd-mode", session.kind === "cd");
      showLoading("Opening " + disc.title, "");
      S.focus.setScope(S$("sink"));
      S.tv.keepScreenOn(true);
      var current = session;
      S.api.play(disc.id, resume).then(S.api.player).then(function (info) {
        if (current !== session) return;
        if (!info.id) { failure("Nothing is playing", "The server did not open the disc.", reopen); return; }
        startStream(info);
      }, function (err) {
        if (current !== session) return;
        failure(err.kind === "network" ? "Server unreachable" : "The disc did not open",
          err.kind === "network" ? "No answer from " + S.api.server() + "." : err.message, reopen);
      });
    },
    handleKey: function (name) {
      if (!session) return;
      // A key press is what lets an engine turn the sound on.
      if (session.started && session.audible === false && session.stream) session.stream.unlock();

      if (!session.started) {
        if (name === "back" || name === "stop") leave();
        return;
      }
      if (mediaKey(name)) {
        if (session && session.barOpen) bumpBar();
        return;
      }
      var onProgress = document.activeElement === S$("progress");
      if (session.kind === "cd") {
        if (name === "back") leave();
        else if (name === "enter") S.focus.activate();
        else if (onProgress && (name === "left" || name === "right")) scrub(name === "right" ? 1 : -1);
        else if (ARROWS[name]) S.focus.move(name);
        return;
      }
      if (!session.barOpen) {
        if (name === "info" || (name === "back" && inMenu())) openBar();
        else if (name === "back") sendReturn();
        else if (name === "enter") sendNav("activate");
        else if (name === "left" || name === "right") sendNav(name);
        else if (name === "up" || name === "down") {
          if (upDownGoToDisc()) sendNav(name);
          else openBar();
        }
        return;
      }
      bumpBar();
      if (name === "back") { if (session.pop) closePop(); else closeBar(); }
      else if (name === "info") closeBar();
      else if (name === "enter") S.focus.activate();
      else if (onProgress && (name === "left" || name === "right")) scrub(name === "right" ? 1 : -1);
      else if (ARROWS[name]) S.focus.move(name);
    },
    // The app went to the background (Home, Source): do not let the film run on with nobody watching.
    onHidden: function () {
      if (session && session.started && session.status && session.status.state === "playing") {
        session.status.state = "paused";
        fire("toggle");
      }
    },
    onClosing: function () { if (session) S.api.stopBeacon(); }
  };
})(window.Streamiso);
