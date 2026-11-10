// Runs the real app in an iframe against tools/mock_server.py, pressing keys and checking where the focus went
// and which commands the server received. Open http://localhost:8090/tests/ in a browser. No dependencies.
// The stream page is on another origin, as on the real server, so its focus stealing is the real thing.
(function () {
  "use strict";

  var frame = document.getElementById("app");
  var out = document.getElementById("out");
  var passed = 0, failed = [], lines = [];

  function print(kind, text) {
    var div = document.createElement("div");
    div.className = kind;
    div.textContent = text;
    out.appendChild(div);
    // The title carries the failures and the total, so a headless browser can be read over its debug port.
    if (kind !== "ok" || /^DONE/.test(text)) lines.push(text);
    document.title = lines.join(" || ");
  }

  function check(name, ok, detail) {
    if (ok) { passed++; print("ok", "ok   " + name); }
    else { failed.push(name); print("bad", "FAIL " + name + (detail !== undefined ? ": " + JSON.stringify(detail) : "")); }
  }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function until(test, what, ms) {
    var end = Date.now() + (ms || 8000);
    return new Promise(function (resolve, reject) {
      (function again() {
        var v;
        try { v = test(); } catch (e) { v = false; }
        if (v) resolve(v);
        else if (Date.now() > end) reject(new Error("timed out waiting for " + what));
        else setTimeout(again, 40);
      })();
    });
  }

  function post(path, body) {
    return fetch(path, { method: "POST", body: JSON.stringify(body || {}) }).then(function (r) { return r.json(); });
  }
  function mockLog() { return fetch("/_mock/log").then(function (r) { return r.json(); }); }
  function actions() { return mockLog().then(function (d) { return d.log; }); }
  function clearLog() { return post("/_mock/clear-log"); }

  function win() { return frame.contentWindow; }
  function doc() { return frame.contentDocument; }
  function S() { return win().Streamiso; }
  function active() { return doc().activeElement; }
  function $(id) { return doc().getElementById(id); }
  function shown(id) { var el = $(id); return !!el && !el.hidden && el.getBoundingClientRect().height > 0; }

  // LG remote codes. The keys an LG remote does not have are pressed as the PC keyboard letters that stand in for them.
  var CODES = { left: 37, up: 38, right: 39, down: 40, enter: 13, back: 461, play: 415, pause: 19,
    stop: 413, forward: 417, rewind: 412, info: 457 };
  var LETTERS = { playpause: " ", next: "n", prev: "p" };
  function press(name) {
    var target = doc().activeElement && doc().activeElement.tagName !== "IFRAME" ? doc().activeElement : doc().body;
    var code = CODES[name] || 0;
    target.dispatchEvent(new (win().KeyboardEvent)("keydown", { key: LETTERS[name] || "", keyCode: code, which: code, bubbles: true, cancelable: true }));
    return sleep(60);
  }
  function pressAll(names) {
    return names.reduce(function (p, n) { return p.then(function () { return press(n); }); }, Promise.resolve());
  }

  // showSeen: false starts the app as it does at first, with the discs already played hidden. Most tests need
  // them, so they are shown otherwise.
  function loadApp(server, showSeen) {
    localStorage.setItem("streamiso.server", server === undefined ? location.origin : server);
    localStorage.removeItem("streamiso.showSeen");
    localStorage.removeItem("streamiso.video");
    localStorage.setItem("streamiso.hideSeen", showSeen === false ? "1" : "0");
    return new Promise(function (resolve) {
      frame.onload = resolve;
      frame.src = "/app/index.html?" + Date.now();
    });
  }
  function toCatalog(showSeen) {
    return post("/_mock/reset").then(function () { return loadApp(undefined, showSeen); }).then(function () {
      return until(function () { return doc().querySelector(".card:focus"); }, "first card focused");
    });
  }
  function discCard(id) { return doc().querySelector('[data-id="' + id + '"]'); }
  function cardId() { return active().getAttribute("data-id"); }

  var DVD_RESUME = "d00000000001", DVD_PLAIN = "d00000000002", CD_RESUME = "c00000000001", CD_PLAIN = "c00000000002";
  function openDisc(id) {
    S().focus.focus(discCard(id));
    return press("enter").then(function () {
      return until(function () { return shown("sink") !== null && S().player.isOpen() && !shown("loading"); }, "the disc to start");
    }).then(closeBar);
  }
  // A DVD starts with the bar closed; this only matters if something opened it.
  function closeBar() {
    return shown("bar") && !shown("cd") ? press("back") : null;
  }
  function hasAction(log, action, value) {
    return log.some(function (e) { return e.action === action && (value === undefined || JSON.stringify(e.value) === JSON.stringify(value)); });
  }

  var tests = [
    function pickGeometry() {
      var pick = function (from, rects, dir) { return window.__pick(from, rects, dir); };
      var r = function (l, t, w, h) { return { left: l, top: t, right: l + w, bottom: t + h }; };
      var grid = [r(0, 0, 100, 100), r(120, 0, 100, 100), r(240, 0, 100, 100), r(0, 120, 100, 100), r(120, 120, 100, 100), r(240, 120, 100, 100)];
      check("down goes to the card right below", pick(grid[1], grid, "down") === 4);
      check("right goes to the next in the row", pick(grid[3], grid, "right") === 4);
      check("right at the end of a row stops", pick(grid[2], [grid[0], grid[1], grid[3], grid[4], grid[5]], "right") === -1);
      check("up from the top row stops", pick(grid[0], [grid[1], grid[2]], "up") === -1);
      check("down prefers a card in line over a nearer one to the side",
        pick(r(0, 0, 100, 100), [r(300, 110, 100, 100), r(0, 160, 100, 100)], "down") === 1);
      check("down reaches a shorter last row", pick(grid[5], [r(0, 240, 100, 100)], "down") === 0);
    },

    function catalog() {
      return toCatalog().then(function () {
        check("sections for discs in progress, DVDs and CDs", doc().querySelectorAll(".section-title").length === 3);
        check("first card has the focus", cardId() === DVD_RESUME, cardId());
        check("details follow the focus", /Lighthouse/.test($("detail-title").textContent));
        var first = discCard(DVD_RESUME);
        check("type tag", first.querySelector(".tag").textContent === "DVD");
        check("continue time on the card", /Continue at 42:15/.test(first.textContent), first.textContent);
        check("watched badge", discCard(DVD_PLAIN).querySelector(".seen").textContent === "Watched");
        check("listened badge on a CD", discCard(CD_PLAIN).querySelector(".seen").textContent === "Listened");
        return press("right");
      }).then(function () {
        check("right moves one card", cardId() === "d00000000013", cardId());  // the next disc in progress
        return press("left");
      }).then(function () {
        check("left moves back", cardId() === DVD_RESUME);
        return press("left");
      }).then(function () {
        check("left at the edge keeps the focus", cardId() === DVD_RESUME);
        return press("down");
      }).then(function () {
        var from = discCard(DVD_RESUME).getBoundingClientRect(), to = active().getBoundingClientRect();
        check("down stays in the column", Math.abs(from.left - to.left) < 4 && to.top > from.top);
        return pressAll(["down", "down", "down"]);
      }).then(function () {
        check("down reaches the CD section", active().classList.contains("cd"), cardId());
        var box = $("catalog-scroll").getBoundingClientRect(), r = active().getBoundingClientRect();
        check("the focused card is on screen after scrolling", r.top >= box.top && r.bottom <= box.bottom, [r.top, r.bottom, box.top, box.bottom]);
        return pressAll(["up", "up", "up", "up", "up", "up", "up"]);
      }).then(function () {
        check("up from the top row reaches the header", active().id === "catalog-seen", active().id);
        return press("right");
      }).then(function () {
        check("right in the header reaches Settings", active().id === "catalog-settings", active().id);
        return press("down");
      }).then(function () {
        check("down from Settings returns to the grid", !!cardId());
        active().blur();
        doc().body.focus();
        return sleep(650);
      }).then(function () {
        check("focus comes back on its own after being lost", !!cardId(), active().tagName);
        S().tv.exited = false;
        return press("back");
      }).then(function () {
        check("Back in the catalog exits the app", S().tv.exited === true);
      });
    },

    function seenAndProgress() {
      var SEASON_D1 = "d00000000014", SEASON_D2 = "d00000000013", OTHER_SEASON = "d00000000015";
      var titles = function () {
        return Array.prototype.map.call(doc().querySelectorAll(".section-title"), function (t) { return t.textContent; });
      };
      var inSection = function (n) {
        return Array.prototype.map.call(doc().querySelectorAll("#catalog-list .grid")[n].querySelectorAll(".card"), function (c) {
          return c.getAttribute("data-id") || "group";
        });
      };
      return toCatalog(false).then(function () {
        check("discs in progress come first", JSON.stringify(titles()) === '["Continue","DVDs","Music CDs"]', titles());
        check("the progress section lists them", JSON.stringify(inSection(0)) === JSON.stringify([DVD_RESUME, SEASON_D2, CD_RESUME]), inSection(0));
        check("the first one has the focus", cardId() === DVD_RESUME, cardId());
        check("a disc in progress leaves its section", inSection(1).indexOf(DVD_RESUME) === -1 && inSection(2).indexOf(CD_RESUME) === -1);
        check("watched DVDs are hidden", !discCard(DVD_PLAIN) && !discCard("d00000000012") && !discCard(OTHER_SEASON));
        check("listened CDs are hidden", !discCard(CD_PLAIN));
        check("a season in progress keeps its card", inSection(1).indexOf("group") >= 0 && !discCard(SEASON_D1), inSection(1));
        var eye = $("catalog-seen");
        check("the Hide switch is on", /Hide played/.test(eye.textContent) && eye.getAttribute("aria-pressed") === "true",
          eye.textContent.trim());
        S().focus.focus(eye);
        return press("enter");
      }).then(function () {
        check("the eye button shows them", !!discCard(DVD_PLAIN) && !!discCard(CD_PLAIN) && !!discCard(OTHER_SEASON));
        check("the eye button keeps the focus", active().id === "catalog-seen", active().id);
        check("the switch is now off and says Show", $("catalog-seen").getAttribute("aria-pressed") === "false" && /Show played/.test($("catalog-seen").textContent), $("catalog-seen").textContent.trim());
        check("the choice is kept", localStorage.getItem("streamiso.hideSeen") === "0" && S().catalog.showsSeen());
        return press("enter");
      }).then(function () {
        check("and hides them again", !discCard(DVD_PLAIN) && localStorage.getItem("streamiso.hideSeen") === "1");
      });
    },

    function seasons() {
      var SEASON_D1 = "d00000000014", SEASON_D2 = "d00000000013", OTHER_SEASON = "d00000000015";
      var seasonOf = function (d) { return S().catalog.seasonOf(d); };
      var parsed = function (title) { var s = seasonOf({ kind: "dvd", title: title }); return s && [s.name, s.season, s.disc]; };
      return toCatalog().then(function () {
        check("a season in the title", JSON.stringify(parsed("Lost - Season 2 Disc 3")) === '["Lost",2,3]', parsed("Lost - Season 2 Disc 3"));
        check("S01 D02 in the title", JSON.stringify(parsed("Friends S01 D02")) === '["Friends",1,2]', parsed("Friends S01 D02"));
        check("a title without a season", parsed("Moonlit Marmalade") === null);
        check("a film on several discs", JSON.stringify(parsed("Titanic Disc 2")) === '["Titanic",null,2]', parsed("Titanic Disc 2"));
        check("a film's disc in Portuguese", JSON.stringify(parsed("Gandhi (Disco 1 de 2)")) === '["Gandhi",null,1]', parsed("Gandhi (Disco 1 de 2)"));
        check("a number in a film's name is not a disc", parsed("District 9") === null && parsed("Avatar 3D") === null);
        check("an edited disc with a plain title is a film's disc", seasonOf({ kind: "dvd", title: "Titanic", disc: 1 }).key === "film:titanic");
        check("an edited season with a plain title", seasonOf({ kind: "dvd", title: "Show", season: 3 }).key === "show|3");
        check("a TMDB series id groups apart from the name",
          seasonOf({ kind: "dvd", title: "Show", season: 1, tmdb_series: 42 }).key === "tmdb:42|1");
        var groups = doc().querySelectorAll("[data-group]");
        // the disc in progress is also listed above, in the progress section
        var inGrid = discCard(SEASON_D2) && discCard(SEASON_D2).parentNode !== doc().querySelectorAll("#catalog-list .grid")[0];
        check("the discs of a season form one card", groups.length === 1 && !discCard(SEASON_D1) && !inGrid, groups.length);
        check("a season with one disc stays a plain card", !!discCard(OTHER_SEASON));
        var g = groups[0];
        check("the season card counts its discs", g.querySelector(".tag").textContent === "2 discs", g.querySelector(".tag").textContent);
        check("the season card is named after the series", g.querySelector(".card-title").textContent === "Tales from the Fifth Floor");
        check("the season card says which disc to continue", g.querySelector(".card-resume").textContent === "Continue disc 2",
          g.querySelector(".card-resume").textContent);
        S().focus.focus(g);
        check("details name the season", /Fifth Floor . Season 1/.test($("detail-title").textContent), $("detail-title").textContent);
        return press("enter");
      }).then(function () {
        check("OK opens the season", S().catalog.isSeasonOpen());
        var title = doc().querySelector(".section-title").textContent;
        check("the season view has the season's title", /Season 1$/.test(title), title);
        var ids = Array.prototype.map.call(doc().querySelectorAll("#catalog-list .card"), function (c) { return c.getAttribute("data-id"); });
        check("the season lists its discs in disc order", JSON.stringify(ids) === JSON.stringify([SEASON_D1, SEASON_D2]), ids);
        check("the first disc has the focus", cardId() === SEASON_D1, cardId());
        return press("right");
      }).then(function () {
        check("right moves to the next disc", cardId() === SEASON_D2, cardId());
        return press("back");
      }).then(function () {
        check("Back closes the season", !S().catalog.isSeasonOpen() && !S().tv.exited);
        check("the focus returns to the season card", active().hasAttribute("data-group"), active().className);
        return press("enter");
      }).then(function () {
        return openDisc(SEASON_D1);
      }).then(function () {
        return press("stop");
      }).then(function () {
        return until(function () { return S().currentScreen() === "catalog" && doc().querySelector(".card:focus"); }, "the catalog");
      }).then(function () {
        check("leaving a disc returns to its season", S().catalog.isSeasonOpen() && cardId() === SEASON_D1, cardId());
        return press("back");
      });
    },

    function resumeDialog() {
      return toCatalog().then(function () {
        S().focus.focus(discCard(DVD_RESUME));
        return press("enter");
      }).then(function () {
        check("a saved position asks first", shown("dialog") && active().textContent === "Continue", active().textContent);
        return press("back");
      }).then(function () {
        check("Back cancels and restores the focus", !shown("dialog") && cardId() === DVD_RESUME);
        return actions();
      }).then(function (log) {
        check("cancelling plays nothing", !hasAction(log, "play"));
        return press("enter");
      }).then(function () {
        return press("right");
      }).then(function () {
        check("right reaches Start over", active().textContent === "Start over");
        return press("enter");
      }).then(function () {
        return until(function () { return S().player.isOpen() && !shown("loading"); }, "start over");
      }).then(actions).then(function (log) {
        check("start over sends resume false", hasAction(log, "play", { id: DVD_RESUME, resume: false }), log);
        check("start over does not send resume_apply", !hasAction(log, "resume_apply"), log);
      });
    },

    function removeFromContinue() {
      var inProgress = function (id) {
        var grid = doc().querySelectorAll("#catalog-list .grid")[0];
        return !!grid.querySelector('[data-id="' + id + '"]');
      };
      return toCatalog().then(function () {
        check("the disc starts in the progress section", inProgress(DVD_RESUME));
        S().focus.focus(discCard(DVD_RESUME));
        return press("enter");
      }).then(function () {
        return pressAll(["right", "right"]);
      }).then(function () {
        check("the dialog offers to remove it", active().textContent === "Remove from Continue", active().textContent);
        return press("enter");
      }).then(function () {
        return until(function () { return !shown("dialog") && discCard(DVD_RESUME) && !inProgress(DVD_RESUME); }, "the disc to leave Continue");
      }).then(actions).then(function (log) {
        check("removing tells the server", hasAction(log, "resume_clear", DVD_RESUME), log);
        check("removing plays nothing", !hasAction(log, "play"), log);
        check("the disc is back in the DVDs", !inProgress(DVD_RESUME) && !/Continue at/.test(discCard(DVD_RESUME).textContent));
        check("the focus stays on it", cardId() === DVD_RESUME, cardId());
      });
    },

    function openingFlow() {
      return toCatalog().then(function () {
        S().focus.focus(discCard(DVD_RESUME));
        return press("enter");
      }).then(function () {
        return press("enter");
      }).then(function () {
        check("loading is shown while it opens", shown("loading"));
        check("the sink has the focus while loading", active().id === "sink", active().id);
        return until(function () { return !shown("loading"); }, "the disc to start");
      }).then(actions).then(function (log) {
        var names = log.map(function (e) { return e.action; }).filter(function (a) { return a !== "nav"; });
        check("continue sends resume true", hasAction(log, "play", { id: DVD_RESUME, resume: true }));
        var apply = names.indexOf("resume_apply"), start = names.indexOf("start");
        check("resume_apply comes before start", apply >= 0 && apply < start, names);
        return sleep(300);
      }).then(function () {
        check("the start message unlocked the sound", S().player.isOpen() && !shown("hint"));
      });
    },

    function blockedSound() {
      return toCatalog().then(function () {
        // Blocks the start itself. A DVD starts with the bar closed, so the next key press is the one that turns
        // the sound on.
        return post("/_mock/set", { unlock_blocked: 1 });
      }).then(function () {
        S().player.config.soundCheckMs = 200;
        return openDisc(DVD_PLAIN);
      }).then(function () {
        return until(function () { return shown("hint"); }, "the sound hint", 3000);
      }).then(function () {
        check("blocked sound tells the viewer what to do", /sound on/.test($("hint").textContent));
        return press("up");
      }).then(function () {
        return until(function () { return !shown("hint"); }, "the hint to clear", 2000);
      }).then(function () {
        check("the next key press turns the sound on", !shown("hint"));
        return press("stop");
      });
    },

    // Plain video: the app asks the server for it and plays its URL with a <video>. A desktop Chrome cannot
    // play HLS, so this only checks the request and the URL, not the picture.
    function plainVideo() {
      return toCatalog().then(function () {
        localStorage.setItem("streamiso.video", "plain");
        check("Settings can choose plain video", S().stream.mode() === "plain", S().stream.mode());
        return clearLog();
      }).then(function () {
        S().focus.focus(discCard(DVD_PLAIN));
        return press("enter");
      }).then(function () {
        return until(function () { var v = doc().querySelector("#stage video"); return v && //_mock/plain.m3u8$/.test(v.src); }, "the plain video", 8000)
          .then(function () { return true; }, function () { return false; });
      }).then(function (playing) {
        check("the plain video plays the URL the server gives", playing);
        return actions();
      }).then(function (log) {
        check("the app asks the server for the plain video", hasAction(log, "plain_video"), log);
        check("the WebRTC page is not loaded", !doc().querySelector("#stage iframe"));
        localStorage.removeItem("streamiso.video");
        return toCatalog();
      });
    },

    function dvdKeys() {
      return toCatalog().then(function () { return openDisc(DVD_PLAIN); }).then(clearLog).then(function () {
        return sleep(1200);  // lets the stream page try to take the focus
      }).then(function () {
        check("the stream never keeps the focus", active().id === "sink", active().tagName + "#" + active().id);
        return pressAll(["up", "down", "left", "right", "enter"]);
      }).then(actions).then(function (log) {
        var navs = log.filter(function (e) { return e.action === "nav"; }).map(function (e) { return e.value; });
        check("arrows and OK go to the DVD menu", JSON.stringify(navs) === JSON.stringify(["up", "down", "left", "right", "activate"]), navs);
        check("the bar stays closed for those keys", !shown("bar"));
        // OK left the menu, and the rest of this test needs the menu.
        return post("/api/player/cmd", { action: "menu" });
      }).then(function () {
        return sleep(1200);
      }).then(clearLog).then(function () {
        return press("back");
      }).then(function () {
        check("Back opens the bar", shown("bar"));
        check("the bar focuses Pause or Play", active().id === "btn-toggle", active().id);
        return press("right");
      }).then(actions).then(function (log) {
        check("arrows do not reach the DVD while the bar is open", !hasAction(log, "nav"), log);
        check("right moves between the buttons", active().getAttribute("data-act") === "prev", active().getAttribute("data-act"));
        check("the focused button's name is on screen", $("bar-caption").textContent === "Previous", $("bar-caption").textContent);
        check("the buttons are icons, without words", !!active().querySelector("svg") && active().textContent === "");
        return press("left");
      }).then(function () {
        return press("enter");
      }).then(actions).then(function (log) {
        check("OK runs the focused button", hasAction(log, "toggle"), log);
        check("OK does not reach the DVD while the bar is open", !hasAction(log, "nav"));
        check("the icon follows the state", $("btn-toggle").getAttribute("aria-label") === "Play" && !!$("btn-toggle").querySelector("svg"), $("btn-toggle").getAttribute("aria-label"));
        return press("back");
      }).then(function () {
        check("Back closes the bar", !shown("bar"));
        check("the focus returns to the sink", active().id === "sink");
        return clearLog();
      }).then(function () {
        return press("up");
      }).then(actions).then(function (log) {
        check("arrows go to the DVD again", hasAction(log, "nav", "up"), log);
        S().player.config.barHideMs = 300;
        return press("info");
      }).then(function () {
        check("Info also opens the bar", shown("bar"));
        return sleep(500);
      }).then(function () {
        check("the bar closes by itself", !shown("bar"));
        check("the focus is safe after it closes", active().id === "sink");
        S().player.config.barHideMs = 6000;
        return clearLog();
      }).then(function () {
        return press("down");
      }).then(actions).then(function (log) {
        check("arrows go to the DVD after it closes by itself", hasAction(log, "nav", "down"), log);
        return clearLog();
      }).then(function () {
        return press("back");
      }).then(function () {
        S().focus.focus(doc().querySelector('[data-act="menu"]'));
        return press("enter");
      }).then(actions).then(function (log) {
        check("DVD menu button sends menu", hasAction(log, "menu"), log);
        check("the bar closes so arrows work in the menu", !shown("bar"));
        return post("/api/player/cmd", { action: "nav", value: "activate" });  // from the menu into the film
      }).then(function () {
        return sleep(1500);  // the status says it is a film
      }).then(clearLog).then(function () {
        return press("back");
      }).then(actions).then(function (log) {
        check("in a film, Back is Return", hasAction(log, "return") && !shown("bar"), log);
        return post("/api/player/cmd", { action: "nav", value: "activate" });
      }).then(function () {
        return sleep(1500);
      }).then(function () {
        return press("info");
      }).then(clearLog).then(function () {
        S().focus.focus(doc().querySelector('[data-act="back"]'));
        return press("enter");
      }).then(actions).then(function (log) {
        check("the Return button sends return", hasAction(log, "return") && !shown("bar"), log);
        return press("info");
      }).then(function () {
        S().focus.focus(doc().querySelector('[data-act="subs"]'));
        return press("enter");
      }).then(function () {
        return until(function () { return shown("pop"); }, "the subtitles list");
      }).then(function () {
        check("the list has the focus", active().parentElement.id === "pop-list", active().tagName);
        check("id -1 reads Off", active().textContent === "Off", active().textContent);
        return press("down");
      }).then(function () {
        return press("enter");
      }).then(actions).then(function (log) {
        check("choosing sends the subtitle id", hasAction(log, "subtitle", 3), log);
        check("the list closes and the button gets the focus", !shown("pop") && active().getAttribute("data-act") === "subs");
        return press("enter");
      }).then(function () {
        return press("back");
      }).then(function () {
        check("Back closes only the list", !shown("pop") && shown("bar"));
        return press("back");
      });
    },

    function mediaKeys() {
      return toCatalog().then(function () {
        S().focus.focus(discCard(DVD_RESUME));
        return press("enter");
      }).then(function () {
        return press("enter");  // Continue
      }).then(function () {
        return until(function () { return S().player.isOpen() && !shown("loading"); }, "start");
      }).then(closeBar).then(function () {
        return sleep(1200);
      }).then(clearLog).then(function () {
        return press("playpause");
      }).then(actions).then(function (log) {
        check("Space (play/pause) toggles", hasAction(log, "toggle"), log);
        check("media keys do not open the bar", !shown("bar"));
        return clearLog();
      }).then(function () {
        return press("pause");
      }).then(actions).then(function (log) {
        check("MediaPause does nothing when already paused", !hasAction(log, "toggle"), log);
        return press("play");
      }).then(actions).then(function (log) {
        check("MediaPlay plays when paused", hasAction(log, "toggle"), log);
        return clearLog();
      }).then(function () {
        return press("forward");
      }).then(actions).then(function (log) {
        var seek = log.filter(function (e) { return e.action === "seek"; })[0];
        check("fast forward seeks 10 s ahead", !!seek && seek.value >= 2500, log);
        return pressAll(["next", "prev"]);
      }).then(actions).then(function (log) {
        check("next and previous change chapter", hasAction(log, "chapter_next") && hasAction(log, "chapter_prev"), log);
        return press("stop");
      }).then(function () {
        return until(function () { return S().currentScreen() === "catalog" && doc().querySelector(".card:focus"); }, "the catalog");
      }).then(actions).then(function (log) {
        check("stop closes the disc on the server", hasAction(log, "stop"), log);
        check("the focus returns to the same disc", cardId() === DVD_RESUME, cardId());
      });
    },

    function barKeys() {
      return toCatalog().then(function () {
        S().player.config.barHideMs = 400;
        S().player.config.navWindowMs = 300;
        S().focus.focus(discCard(DVD_PLAIN));
        return press("enter");
      }).then(function () {
        return until(function () { return S().player.isOpen() && !shown("loading"); }, "the disc to start");
      }).then(function () {
        check("the bar stays closed when the video starts", !shown("bar"));
        check("the focus starts in the sink", active().id === "sink", active().id);
        return press("back");
      }).then(function () {
        check("Back opens it on Pause or Play", shown("bar") && active().id === "btn-toggle", active().id);
        return until(function () { return !shown("bar"); }, "the bar to close by itself", 2000);
      }).then(function () {
        return sleep(1200);  // the status now reports the menu
      }).then(clearLog).then(function () {
        return pressAll(["up", "down"]);
      }).then(actions).then(function (log) {
        check("in a menu with a duration, Up and Down go to the disc", hasAction(log, "nav", "up") && hasAction(log, "nav", "down"), log);
        check("in a menu, Up and Down do not open the bar", !shown("bar"));
        return press("enter");
      }).then(actions).then(function (log) {
        check("in a menu, OK presses the disc's button", hasAction(log, "nav", "activate"), log);
        check("in a menu, OK does not open the bar", !shown("bar"));
        return sleep(1200);  // the status now reports the film
      }).then(clearLog).then(function () {
        return press("enter");
      }).then(actions).then(function (log) {
        check("in the film, OK never opens the bar", !shown("bar"));
        check("in the film, OK still goes to the disc", hasAction(log, "nav", "activate"), log);
        return sleep(450);
      }).then(clearLog).then(function () {
        return press("up");
      }).then(actions).then(function (log) {
        check("in the film, Up opens the bar", shown("bar"));
        check("that Up does not reach the disc", !hasAction(log, "nav"), log);
        return press("back");
      }).then(function () {
        check("Back closes it", !shown("bar"));
        return sleep(100);
      }).then(function () {
        return press("down");
      }).then(function () {
        check("in the film, Down opens the bar", shown("bar"));
        return press("back");
      }).then(clearLog).then(function () {
        return press("back");
      }).then(actions).then(function (log) {
        check("in the film, Back is Return, not the bar", hasAction(log, "return") && !shown("bar"), log);
        return post("/api/player/cmd", { action: "nav", value: "activate" });  // from that menu into the film again
      }).then(function () {
        return sleep(1500);
      }).then(clearLog).then(function () {
        return pressAll(["left", "up"]);
      }).then(actions).then(function (log) {
        check("in the film, Left goes to the disc", hasAction(log, "nav", "left"), log);
        check("right after using the disc, Up stays with it", hasAction(log, "nav", "up") && !shown("bar"), log);
        return post("/_mock/set", { film_length: 120 });
      }).then(function () {
        return sleep(1500);
      }).then(clearLog).then(function () {
        return press("up");
      }).then(actions).then(function (log) {
        check("in a short title, Up goes to the disc", hasAction(log, "nav", "up") && !shown("bar"), log);
        return post("/_mock/set", { film_length: 6300 });
      }).then(function () {
        return post("/api/player/cmd", { action: "menu" });
      }).then(function () {
        return sleep(1200);
      }).then(function () {
        return press("back");
      }).then(function () {
        check("in a menu, Back opens the bar", shown("bar"));
        return press("stop");
      });
    },

    function seekLine() {
      return toCatalog().then(function () {
        S().focus.focus(discCard(DVD_RESUME));
        return press("enter");
      }).then(function () {
        return press("enter");
      }).then(function () {
        return until(function () { return S().player.isOpen() && !shown("loading"); }, "start");
      }).then(function () {
        return sleep(1200);
      }).then(function () {
        return press("info");  // a DVD starts with the bar closed (Back would be Return in the film)
      }).then(function () {
        return press("up");
      }).then(function () {
        check("up from the buttons reaches the progress line", active().id === "progress", active().outerHTML.slice(0, 90));
        return clearLog();
      }).then(function () {
        var before = parseInt($("progress-fill").style.width, 10);
        return pressAll(["right", "right", "right"]).then(function () { return before; });
      }).then(function (before) {
        check("the bar stays open while moving", shown("bar"));
        check("the preview moves on the screen", parseFloat($("progress-fill").style.width) >= before, $("progress-fill").style.width);
        return actions();
      }).then(function (log) {
        check("no seek is sent while still pressing", !hasAction(log, "seek"), log);
        return sleep(800);
      }).then(actions).then(function (log) {
        var seeks = log.filter(function (e) { return e.action === "seek"; });
        check("one seek is sent when the presses stop", seeks.length === 1, seeks);
        check("the seek went 30 s ahead", seeks.length === 1 && seeks[0].value >= 2560 && seeks[0].value < 2590, seeks);
        // The stream page still takes the focus now and then, and the app takes it back within half a second,
        // so a single look could land in between.
        return until(function () { return active().id === "progress"; }, "the focus on the line", 1500)
          .then(function () { return true; }, function () { return false; });
      }).then(function (onLine) {
        check("left and right do not leave the line", onLine, active().id);
        return clearLog();
      }).then(function () {
        return pressAll(["left", "enter"]);
      }).then(actions).then(function (log) {
        check("OK jumps right away", hasAction(log, "seek"), log);
        return press("down");
      }).then(function () {
        check("down returns to the buttons", active().hasAttribute("data-act") && active().id !== "progress", active().id);
        return press("stop");
      });
    },

    function leaveFromBar() {
      return toCatalog().then(function () { return openDisc(DVD_PLAIN); }).then(function () {
        return press("back");
      }).then(function () {
        S().focus.focus(doc().querySelector('[data-act="leave"]'));
        return press("enter");
      }).then(function () {
        return until(function () { return S().currentScreen() === "catalog" && doc().querySelector(".card:focus"); }, "the catalog");
      }).then(actions).then(function (log) {
        check("Library button stops the disc", hasAction(log, "stop"));
        check("back on the same card", cardId() === DVD_PLAIN, cardId());
        check("the stream is gone", !doc().querySelector("#stage iframe"));
      });
    },

    function cdKeys() {
      return toCatalog().then(function () { return openDisc(CD_PLAIN); }).then(clearLog).then(function () {
        check("cover and title shown", shown("cd") && /Copper and Rain/.test($("cd-title").textContent));
        check("artist shown", /Marla Venn/.test($("cd-artist").textContent));
        check("every track is listed", $("cd-tracks").children.length === 5);
        check("the bar is always there on a CD", shown("bar"));
        check("no DVD buttons on a CD", !doc().querySelector('[data-act="menu"]').getBoundingClientRect().width);
        check("a track has the focus", active().tagName === "LI", active().tagName);
        return until(function () { return $("cd-tracks").children[0].classList.contains("current"); }, "current track");
      }).then(function () {
        return pressAll(["down", "down"]);
      }).then(actions).then(function (log) {
        check("arrows move through the tracks, nothing reaches the player", log.length === 0, log);
        check("two down lands on the third track", active() === $("cd-tracks").children[2]);
        return press("enter");
      }).then(actions).then(function (log) {
        check("OK plays that track", hasAction(log, "track", 2), log);
        return until(function () { return $("cd-tracks").children[2].classList.contains("current"); }, "track highlight");
      }).then(function () {
        check("the focus stays put as the status updates", active() === $("cd-tracks").children[2]);
        return pressAll(["down", "down", "down"]);
      }).then(function () {
        check("down leaves the list for the buttons", active().hasAttribute("data-act"), active().tagName);
        return press("up");
      }).then(function () {
        check("up returns to the list", active().tagName === "LI", active().tagName);
        return press("back");
      }).then(function () {
        return until(function () { return S().currentScreen() === "catalog" && doc().querySelector(".card:focus"); }, "the catalog");
      }).then(function () {
        check("Back leaves a CD for the same card", cardId() === CD_PLAIN, cardId());
      });
    },

    function cdResume() {
      return toCatalog().then(function () {
        S().focus.focus(discCard(CD_RESUME));
        return press("enter");
      }).then(function () {
        return press("enter");
      }).then(function () {
        return until(function () { return S().player.isOpen() && !shown("loading"); }, "start");
      }).then(actions).then(function (log) {
        check("CD continue sends resume_apply", hasAction(log, "resume_apply"), log);
        return until(function () { return $("cd-tracks").children[2].classList.contains("current"); }, "saved track");
      }).then(function () {
        check("the saved track is highlighted", $("cd-tracks").children[2].classList.contains("current"));
      });
    },

    function errors() {
      return toCatalog().then(function () {
        return post("/_mock/set", { api_down: true });
      }).then(function () {
        return loadApp();
      }).then(function () {
        return until(function () { return shown("dialog"); }, "the error", 15000);
      }).then(function () {
        check("server down says so", /unreachable/i.test($("dialog-title").textContent), $("dialog-title").textContent);
        check("the error's button has the focus", active().textContent === "Try again");
        return post("/_mock/set", { api_down: false });
      }).then(function () {
        return press("enter");
      }).then(function () {
        return until(function () { return doc().querySelector(".card:focus"); }, "the catalog after retrying");
      }).then(function () {
        check("Try again recovers", !shown("dialog"));
        return post("/_mock/set", { stream_silent: true });
      }).then(function () {
        S().player.config.readyTimeoutMs = 1500;
        S().focus.focus(discCard(DVD_PLAIN));
        return press("enter");
      }).then(function () {
        return until(function () { return shown("dialog"); }, "the stream error", 6000);
      }).then(function () {
        check("a stream that never arrives says so", /did not start/.test($("dialog-title").textContent), $("dialog-title").textContent);
        check("it says the last step it reached", /Last step: /.test($("dialog-text").textContent), $("dialog-text").textContent);
        check("it does not blame the network before the TV answered", !/SERVER_IP/.test($("dialog-text").textContent), $("dialog-text").textContent);
        return actions();
      }).then(function (log) {
        check("start waits for the video", !hasAction(log, "start"), log);
        return post("/_mock/set", { stream_silent: false });
      }).then(function () {
        S().player.config.readyTimeoutMs = 25000;
        return press("right");
      }).then(function () {
        return press("enter");
      }).then(function () {
        return until(function () { return S().currentScreen() === "catalog" && doc().querySelector(".card:focus"); }, "the catalog");
      }).then(function () {
        return openDisc(DVD_PLAIN);
      }).then(function () {
        return post("/api/stop");  // someone closes the disc from another screen
      }).then(function () {
        return until(function () { return shown("dialog"); }, "nothing playing", 5000);
      }).then(function () {
        check("a closed disc says Nothing is playing", /Nothing is playing/.test($("dialog-title").textContent), $("dialog-title").textContent);
        return press("back");
      }).then(function () {
        return until(function () { return S().currentScreen() === "catalog" && doc().querySelector(".card:focus"); }, "the catalog");
      }).then(function () {
        return post("/_mock/set", { fail_start: 2 });
      }).then(function () {
        return openDisc(DVD_PLAIN);
      }).then(actions).then(function (log) {
        var starts = log.filter(function (e) { return e.action === "start"; }).length;
        check("start is retried while VLC answers 503", starts >= 3, starts);
        return press("stop");
      });
    },

    function offlineMessage() {
      return toCatalog().then(function () {
        S().focus.focus(discCard(DVD_PLAIN));
        return press("enter");
      }).then(function () {
        return until(function () { return /VLC is starting/.test($("loading-text").textContent); }, "the offline message", 3000);
      }).then(function () {
        check("offline shows VLC is starting", /VLC is starting/.test($("loading-text").textContent));
        return until(function () { return !shown("loading"); }, "start");
      }).then(function () {
        return press("stop");
      });
    },

    function vlcUpMessage() {
      return toCatalog().then(function () {
        return post("/_mock/set", { stream_silent: true });
      }).then(function () {
        S().focus.focus(discCard(DVD_PLAIN));
        return press("enter");
      }).then(function () {
        return until(function () { return /Connecting to the video/.test($("loading-text").textContent); }, "the message to change once VLC is up", 4000);
      }).then(function () {
        check("the VLC message goes away once VLC is up", !/VLC is starting/.test($("loading-text").textContent));
        return post("/_mock/set", { stream_silent: false });
      }).then(function () {
        return press("back");
      });
    },

    function firstRun() {
      return post("/_mock/reset").then(function () { return loadApp(""); }).then(function () {
        return until(function () { return shown("settings"); }, "the settings screen");
      }).then(function () {
        check("first launch asks for the server", /Connect/.test($("settings-title").textContent));
        check("the field has the focus", active().id === "server-field", active().id);
        check("no keyboard until OK is pressed", !S().focus.isLocked());
        return press("enter");
      }).then(function () {
        check("OK starts typing in the field", S().focus.isLocked() && active().id === "server-input", active().id);
        $("server-input").value = "not an address!";
        return press("enter");
      }).then(function () {
        check("OK leaves the field", !S().focus.isLocked() && active().id === "server-field", active().id);
        return press("down");
      }).then(function () {
        check("down reaches Save", active().id === "settings-save", active().id);
        return press("enter");
      }).then(function () {
        check("a bad address is refused", /does not look like/.test($("settings-message").textContent));
        S().focus.focus($("server-field"));
        return press("enter");
      }).then(function () {
        $("server-input").value = location.host;
        return press("enter");
      }).then(function () {
        S().focus.focus($("settings-save"));
        return press("enter");
      }).then(function () {
        return until(function () { return doc().querySelector(".card:focus"); }, "the catalog");
      }).then(function () {
        check("the address is stored", localStorage.getItem("streamiso.server") === location.origin, localStorage.getItem("streamiso.server"));
        return pressAll(["up", "up", "up", "right", "enter"]);  // the eye button, then Settings
      }).then(function () {
        return until(function () { return shown("settings"); }, "settings from the catalog");
      }).then(function () {
        check("Settings shows the saved address", $("server-input").value === location.host, $("server-input").value);
        return press("back");
      }).then(function () {
        return until(function () { return doc().querySelector(".card:focus"); }, "the catalog again");
      }).then(function () {
        check("Back leaves Settings without changing anything", localStorage.getItem("streamiso.server") === location.origin);
      });
    }
  ];

  function finish() {
    print(failed.length ? "bad" : "ok", "DONE passed=" + passed + " failed=" + failed.length + (failed.length ? " :: " + failed.join(" | ") : ""));
    localStorage.removeItem("streamiso.server");
  }

  function run(index) {
    if (index >= tests.length) { finish(); return; }
    var test = tests[index];
    print("", "-- " + test.name);
    Promise.resolve().then(test).catch(function (e) {
      check(test.name + " stopped", false, String(e.message || e));
    }).then(function () { run(index + 1); });
  }

  // pick() is pure, so it runs before the app has loaded.
  localStorage.setItem("streamiso.server", location.origin);
  frame.onload = function () {
    frame.onload = null;
    window.__pick = frame.contentWindow.Streamiso.focus.pick;
    run(0);
  };
  frame.src = "/app/index.html";
})();
