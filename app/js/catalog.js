// The library: a grid of covers, the discs in progress first, then DVDs and then CDs. The discs of a TV season,
// or of a film on several discs, form one card, which opens a view with those discs. Discs already watched or
// listened to are hidden until the eye button in the header shows them, as on the web page.
(function (S) {
  "use strict";

  var data = null;            // the last answer of /api/discs
  var lastId = null;          // the card that had the focus: a disc id, or a season's key
  var openKey = null;         // the season being shown, if any
  var gridScroll = 0;         // where the full grid was scrolled when the season opened
  var observer = null;
  var onOpen = null, onSettings = null;
  // The "Hide watched" switch, on unless turned off. (It replaced "streamiso.showSeen", which is ignored, so
  // every TV starts with it on.)
  var SEEN_KEY = "streamiso.hideSeen";
  var showSeen = false;       // also list the discs already watched / listened to
  try { showSeen = localStorage.getItem(SEEN_KEY) === "0"; } catch (e) { /* storage is optional */ }

  // ---------------------------------------------------------------- seasons
  // Season and disc numbers written in a title, e.g. "Friends S01 D02", "Lost - Season 2 Disc 3", "Dexter T1
  // Disco 4". The series name is what comes before the season. Keep SEASON_RE, DISC_RE, FILM_DISC_RE and
  // seasonOf() in step with catalog/static/app.js in the StreamISO repository, so the TV groups discs as the web
  // page does.
  var SEASON_RE = /(?:^|[\s\-\u2013:,(])(?:season|temporada|saison|staffel|s|t)\s*0*(\d{1,3})(?=$|[\s\-\u2013:,)]|d(?:is[ck]o?)?\s*\d|e\d)/i;
  var DISC_RE = /(?:^|[\s\-\u2013:,(\d])(?:dis[ck]o?|dvd|d)\s*0*(\d{1,3})(?=$|[^\d])/i;
  // Disc number of a film on several discs, e.g. "Titanic Disc 2", "Ben-Hur D2", "Gandhi (Disco 1 de 2)".
  var FILM_DISC_RE = /(?:^|[\s\-\u2013:,(\[])(?:dis[ck]o?|dvd|cd|d)\s*0*(\d{1,2})(?=$|[\s\-\u2013:,)\]]|\s*(?:of|de|\/)\s*\d)/i;

  function given(v) { return v !== null && v !== undefined; }

  function parseTitle(title) {
    var t = String(title || "");
    var m = SEASON_RE.exec(t);
    if (!m) return null;
    var name = t.slice(0, m.index).replace(/[\s\-\u2013:,(]+$/, "").trim();
    var dm = DISC_RE.exec(t.slice(m.index + m[0].length));
    return { name: name, season: Number(m[1]), disc: dm ? Number(dm[1]) : null };
  }

  function parseFilmDisc(title) {
    var t = String(title || "");
    var m = FILM_DISC_RE.exec(t);
    if (!m) return null;
    var name = t.slice(0, m.index).replace(/[\s\-\u2013:,(\[]+$/, "").trim();
    return name ? { name: name, disc: Number(m[1]) } : null;
  }

  // The season a DVD belongs to, from its edited season, its title, or (when the title says nothing) its file
  // name or volume label. Discs matched to a TV series on TMDB are grouped by that series, so a revival with the
  // same name as the original stays apart from it. Without a season, a DVD with a disc number (edited, or
  // "Titanic Disc 2" in its title, file name or label) is a film on several discs: season is null and the discs
  // of the same film name form one group. Otherwise null.
  function seasonOf(d) {
    if (d.kind === "cd") return null;
    var fromTitle = parseTitle(d.title);
    var file = String(d.rel || "").replace(/^.*\//, "").replace(/\.[^.]*$/, "").replace(/[_.]+/g, " ");
    var label = String(d.label || "").replace(/[_.]+/g, " ");
    var p = fromTitle || parseTitle(file) || parseTitle(label) || {};
    var name = (fromTitle && fromTitle.name) || d.title;
    var season = given(d.season) ? d.season : p.season;
    if (!name) return null;
    if (!given(season)) {
      var film = parseFilmDisc(d.title);
      var f = film || parseFilmDisc(file) || parseFilmDisc(label) || {};
      var disc = given(d.disc) ? d.disc : f.disc;
      if (!given(disc)) return null;
      name = (film && film.name) || d.title;
      return { key: "film:" + name.toLowerCase(), name: name, season: null, disc: disc };
    }
    var series = d.tmdb_series ? "tmdb:" + d.tmdb_series : name.toLowerCase();
    return { key: series + "|" + season, name: name, season: season, disc: given(d.disc) ? d.disc : p.disc };
  }

  // "Friends – Season 2", or just the name of a film on several discs.
  function groupHeading(s) { return s.season === null ? s.name : s.name + " – Season " + s.season; }

  function byDiscNumber(a, b) {
    var da = seasonOf(a).disc, db = seasonOf(b).disc;
    return ((given(da) ? da : 9999) - (given(db) ? db : 9999)) || (a.title < b.title ? -1 : a.title > b.title ? 1 : 0);
  }

  // Replaces the discs of a season that has more than one by a single group, at the place of its first disc.
  function collapse(items) {
    var groups = {};
    items.forEach(function (d) {
      var s = seasonOf(d);
      if (!s) return;
      if (!groups[s.key]) groups[s.key] = { key: s.key, name: s.name, season: s.season, discs: [] };
      groups[s.key].discs.push(d);
    });
    var out = [], placed = {};
    items.forEach(function (d) {
      var s = seasonOf(d);
      var g = s && groups[s.key];
      if (!g || g.discs.length < 2) { out.push(d); return; }
      if (placed[g.key]) return;
      placed[g.key] = true;
      g.discs.sort(byDiscNumber);
      out.push(g);
    });
    return out;
  }

  function seasonDiscs(key) {
    return data.discs.filter(function (d) {
      var s = seasonOf(d);
      return s && s.key === key;
    }).sort(byDiscNumber);
  }

  function selector(attr, value) {
    return "[" + attr + '="' + String(value).replace(/["\\]/g, "\\$&") + '"]';
  }

  function element(tag, className, text) {
    var el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
  }

  function buildCard(disc, playing) {
    var card = element("button", "card " + disc.kind);
    card.type = "button";
    card.tabIndex = -1;
    card.setAttribute("data-focusable", "");
    card.setAttribute("data-id", disc.id);

    var cover = element("span", "cover");
    var img = document.createElement("img");
    img.alt = "";
    img.setAttribute("data-src", S.api.coverUrl(disc));
    if (disc.cover_fill) img.className = "fill";  // cropped to fill the space, as set in the editor
    cover.appendChild(img);
    cover.appendChild(element("span", "tag", disc.kind === "cd" ? "CD" : "DVD"));
    if (disc.watched) cover.appendChild(element("span", "seen", disc.kind === "cd" ? "Listened" : "Watched"));
    if (disc.resume && disc.resume.pct) {
      var bar = element("span", "bar-resume");
      bar.style.width = Math.min(100, disc.resume.pct) + "%";
      cover.appendChild(bar);
    }
    card.appendChild(cover);
    card.appendChild(element("span", "card-title", disc.title));
    var note = disc.id === playing ? "Now open" : disc.resume ? "Continue at " + S.formatTime(disc.resume.time) : "";
    card.appendChild(element("span", "card-resume", note));

    card.addEventListener("click", function () { open(disc); });
    card.addEventListener("focus", function () { showDetail(disc); });
    return card;
  }

  // A season's card: the first disc's cover drawn as a small stack of cases.
  function buildGroup(g, playing) {
    var first = g.discs[0];
    var watched = g.discs.every(function (d) { return d.watched; });
    var resumed = null, open = false;
    g.discs.forEach(function (d) {
      if (d.resume && !resumed) resumed = d;
      if (d.id === playing) open = true;
    });

    var card = element("button", "card dvd stack");
    card.type = "button";
    card.tabIndex = -1;
    card.setAttribute("data-focusable", "");
    card.setAttribute("data-group", g.key);

    var cover = element("span", "cover");
    var img = document.createElement("img");
    img.alt = "";
    img.setAttribute("data-src", S.api.coverUrl(first));
    if (first.cover_fill) img.className = "fill";
    cover.appendChild(img);
    cover.appendChild(element("span", "tag", g.discs.length + " discs"));
    if (watched) cover.appendChild(element("span", "seen", "Watched"));
    card.appendChild(cover);
    card.appendChild(element("span", "card-title", g.name));
    var number = resumed && seasonOf(resumed).disc;
    var note = open ? "Now open" : resumed ? "Continue" + (given(number) ? " disc " + number : "")
      : g.season === null ? (first.year ? String(first.year) : "") : "Season " + g.season;
    card.appendChild(element("span", "card-resume", note));

    card.addEventListener("click", function () { openSeason(g.key); });
    card.addEventListener("focus", function () { showGroupDetail(g); });
    return card;
  }

  function showGroupDetail(g) {
    lastId = g.key;
    var first = g.discs[0];
    var seen = g.discs.filter(function (d) { return d.watched; }).length;
    S.$("detail-title").textContent = groupHeading(g);
    var meta = [];
    if (first.year) meta.push(first.year);
    meta.push(g.discs.length + " discs" + (seen && seen < g.discs.length ? ", " + seen + " watched" : ""));
    if (first.genres && first.genres.length) meta.push(first.genres.join(", "));
    S.$("detail-meta").textContent = meta.join("  ·  ");
    S.$("detail-text").textContent = first.synopsis || "";
  }

  function showDetail(disc) {
    lastId = disc.id;
    S.$("detail-title").textContent = disc.title;
    var meta = [];
    if (disc.artist) meta.push(disc.artist);
    if (disc.year) meta.push(disc.year);
    if (disc.kind === "cd" && disc.track_count) meta.push(disc.track_count + " tracks");
    if (disc.genres && disc.genres.length) meta.push(disc.genres.join(", "));
    S.$("detail-meta").textContent = meta.join("  ·  ");
    S.$("detail-text").textContent = disc.synopsis || "";
  }

  function open(disc) {
    if (!disc.resume) { onOpen(disc, false); return; }
    S.dialog.show({
      title: disc.title,
      text: "You stopped at " + S.formatTime(disc.resume.time) + ".",
      buttons: [
        { label: "Continue", action: function () { onOpen(disc, true); } },
        { label: "Start over", action: function () { onOpen(disc, false); } },
        // leaves "Continue watching"; the catalog reloads with the focus on the disc in its own section
        { label: "Remove from Continue", action: function () {
          lastId = disc.id;
          S.api.clearResume(disc.id).then(S.catalog.show, S.catalog.show);
        } }
      ],
      onBack: function () {}
    });
  }

  function addSection(list, title, items, playing) {
    if (!items.length) return;
    list.appendChild(element("div", "section-title", title));
    var grid = element("div", "grid");
    items.forEach(function (item) { grid.appendChild(item.discs ? buildGroup(item, playing) : buildCard(item, playing)); });
    list.appendChild(grid);
  }

  // Covers load as they come near the screen: a big library would otherwise fetch them all at once.
  function loadCovers(list) {
    if (observer) observer.disconnect();
    observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        var img = entry.target;
        img.src = img.getAttribute("data-src");
        observer.unobserve(img);
      });
    }, { root: S.$("catalog-scroll"), rootMargin: "500px 0px" });
    Array.prototype.forEach.call(list.querySelectorAll("img[data-src]"), function (img) { observer.observe(img); });
  }

  // Hidden by the eye button: a disc already watched / listened to, or a group whose discs all are.
  function seenHidden(item) {
    if (showSeen) return false;
    return item.discs ? item.discs.every(function (d) { return d.watched; }) : !!item.watched;
  }

  // The eye button's words: "watched" for DVDs, "listened" for CDs, "played" for a mix.
  function seenLabel() {
    var hasCd = false, hasDvd = false;
    (data ? data.discs : []).forEach(function (d) { if (d.kind === "cd") hasCd = true; else hasDvd = true; });
    var word = hasCd && !hasDvd ? "listened" : hasCd ? "played" : "watched";
    var btn = S.$("catalog-seen");
    // says what is on screen: "Hide watched" (on) while they are hidden, "Show watched" while shown
    btn.querySelector(".lbl").textContent = (showSeen ? "Show " : "Hide ") + word;
    btn.setAttribute("aria-pressed", showSeen ? "false" : "true");
  }

  function toggleSeen() {
    showSeen = !showSeen;
    try { localStorage.setItem(SEEN_KEY, showSeen ? "0" : "1"); } catch (e) { /* lasts until the app closes */ }
    if (!data) return;
    render();
    S.focus.focus(S.$("catalog-seen"));  // the focus stays on the button, to press it again
  }

  // The library: discs in progress first, in a section of their own (even when already watched; one of a season
  // also stays in its season's card), then the DVDs and the CDs that are not hidden.
  function renderLibrary(list) {
    var discs = data.discs;
    var progress = discs.filter(function (d) { return d.resume; });
    var grouped = {};
    collapse(discs).forEach(function (it) {
      if (it.discs) it.discs.forEach(function (d) { grouped[d.id] = true; });
    });
    var rest = discs.filter(function (d) { return !d.resume || grouped[d.id]; });
    var onlyCd = progress.every(function (d) { return d.kind === "cd"; });
    var anyCd = progress.some(function (d) { return d.kind === "cd"; });
    addSection(list, onlyCd ? "Continue listening" : anyCd ? "Continue" : "Continue watching", progress, data.playing);
    var hidden = 0;
    [["DVDs", function (d) { return d.kind !== "cd"; }], ["Music CDs", function (d) { return d.kind === "cd"; }]].forEach(function (s) {
      var items = collapse(rest.filter(s[1]));
      var visible = items.filter(function (it) { return !seenHidden(it); });
      hidden += items.length - visible.length;
      addSection(list, s[0], visible, data.playing);
    });
    if (discs.length && !list.querySelector(".card")) {
      list.appendChild(element("div", "empty", hidden
        ? "Everything here has been played already. Press the eye button above to show it."
        : "No discs found. Add images to the media folders on the server."));
    }
  }

  // The whole library, or the open season's discs.
  function render() {
    seenLabel();
    var list = S.$("catalog-list");
    list.innerHTML = "";
    var season = openKey ? seasonDiscs(openKey) : [];
    if (openKey && !season.length) openKey = null;  // its discs are gone, or have another season now
    var again = null;
    if (openKey) {
      var s = seasonOf(season[0]);
      addSection(list, groupHeading(s), season, data.playing);
      again = lastId && list.querySelector(selector("data-id", lastId));
    } else {
      renderLibrary(list);
      if (lastId) {
        again = list.querySelector(selector("data-id", lastId)) || list.querySelector(selector("data-group", lastId));
        // a disc that is now inside a season's card
        var disc = !again && data.discs.filter(function (d) { return d.id === lastId; })[0];
        var inSeason = disc && seasonOf(disc);
        if (inSeason) again = list.querySelector(selector("data-group", inSeason.key));
      }
    }
    if (!data.discs.length) {
      list.appendChild(element("div", "empty", "No discs found. Add images to the media folders on the server."));
    }
    if (!list.querySelector(".card")) {
      ["detail-title", "detail-meta", "detail-text"].forEach(function (id) { S.$(id).textContent = ""; });
    }
    loadCovers(list);
    S.focus.setScope(S.$("catalog"), again || list.querySelector(".card") || S.$("catalog-seen"));
  }

  function load(answer) {
    data = answer;
    render();
  }

  function openSeason(key) {
    gridScroll = S.$("catalog-scroll").scrollTop;
    openKey = key;
    lastId = null;
    S.$("catalog-scroll").scrollTop = 0;
    render();
  }

  function closeSeason() {
    lastId = openKey;
    openKey = null;
    S.$("catalog-scroll").scrollTop = gridScroll;
    render();
  }

  function showError(err) {
    S.focus.setScope(S.$("catalog"), S.$("catalog-settings"));
    S.dialog.show({
      title: err.kind === "network" ? "Server unreachable" : "The server answered with an error",
      text: err.kind === "network"
        ? "No answer from " + S.api.server() + ".\nCheck that StreamISO is running and that CORS_ORIGIN=null is in its .env file."
        : err.message,
      buttons: [
        { label: "Try again", action: function () { S.catalog.show(); } },
        { label: "Settings", action: onSettings }
      ],
      onBack: function () { S.tv.exit(); }
    });
  }

  S.catalog = {
    init: function (handlers) {
      onOpen = handlers.open;
      onSettings = handlers.settings;
      S.$("catalog-settings").addEventListener("click", onSettings);
      S.$("catalog-seen").addEventListener("click", toggleSeen);
    },
    show: function () {
      S.show("catalog");
      S.focus.setScope(S.$("catalog"), S.$("catalog-settings"));
      return S.api.discs().then(load, showError);
    },
    seasonOf: seasonOf,
    isSeasonOpen: function () { return !!openKey; },
    showsSeen: function () { return showSeen; },
    handleKey: function (name) {
      if (name === "back") {
        if (openKey) closeSeason();
        else S.tv.exit();
      } else if (name === "enter") S.focus.activate();
      else if (name === "left" || name === "right" || name === "up" || name === "down") S.focus.move(name);
    }
  };
})(window.Streamiso);
