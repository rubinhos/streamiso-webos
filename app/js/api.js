// The StreamISO HTTP API. See docs/API.md in the StreamISO repository.
(function (S) {
  "use strict";

  // The first address, as before there were two; the second (optional) is the same server by another way, such
  // as its Tailscale address away from home. The choice says which one to use: "auto" tries the first and, if it
  // does not answer, the second.
  var KEYS = { first: "streamiso.server", second: "streamiso.server2", key: "streamiso.key", choice: "streamiso.serverChoice" };
  var CHOICES = ["auto", "first", "second"];
  var TIMEOUT_MS = 10000;
  // Long enough for a server that is on, short enough not to keep the viewer waiting before the second address.
  var PROBE_MS = 4000;

  function load(name) {
    try { return localStorage.getItem(KEYS[name]) || ""; } catch (e) { return ""; /* storage is optional */ }
  }
  function store(name, value) {
    try {
      if (value) localStorage.setItem(KEYS[name], value);
      else localStorage.removeItem(KEYS[name]);
    } catch (e) { /* lasts until the app closes */ }
  }

  var saved = { first: load("first"), second: load("second"), key: load("key"), choice: load("choice") };
  if (CHOICES.indexOf(saved.choice) < 0) saved.choice = "auto";
  // The address the app talks to: the one that answered last.
  var server = saved.choice === "second" && saved.second ? saved.second : saved.first;

  // "192.168.0.10" -> "http://192.168.0.10:8080". Returns "" for something that is not an address.
  function normalize(text) {
    var value = String(text || "").trim().replace(/\/+$/, "");
    if (!value) return "";
    if (!/^https?:\/\//i.test(value)) value = "http://" + value;
    var match = /^(https?:\/\/)([^\/:\s]+)(:\d+)?$/i.exec(value);
    if (!match) return "";
    return match[1].toLowerCase() + match[2] + (match[3] || ":8080");
  }

  function ApiError(kind, message, status) {
    this.kind = kind;  // "network" (no answer) or "http" (an error answer)
    this.message = message;
    this.status = status || 0;
  }

  // The server refuses calls from other origins (this app runs from file://) unless they carry its API_KEY.
  function request(base, path, body, timeoutMs, key) {
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, timeoutMs || TIMEOUT_MS);
    var options = { method: body === undefined ? "GET" : "POST", signal: controller.signal, headers: {} };
    key = key === undefined ? saved.key : key;
    if (key) options.headers["X-StreamISO-Key"] = key;
    if (body !== undefined) {
      options.headers["Content-Type"] = "application/json";
      options.body = JSON.stringify(body);
    }
    return fetch(base + path, options).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        clearTimeout(timer);
        if (!res.ok) throw new ApiError("http", data.error || "HTTP " + res.status, res.status);
        return data;
      });
    }, function () {
      clearTimeout(timer);
      throw new ApiError("network", "No answer from " + base);
    });
  }

  // The addresses to try, in order, for the current choice.
  function candidates() {
    if (saved.choice === "first" || !saved.second) return [saved.first];
    if (saved.choice === "second") return [saved.second];
    return [saved.first, saved.second];
  }

  // Reads the library from the first address that answers, which becomes the one the app talks to. An address
  // that answers with an error (a wrong key) is the right server, so the error is not a reason to try the next.
  function discs() {
    var list = candidates();
    function attempt(i) {
      var last = i === list.length - 1;
      return request(list[i], "/api/discs", undefined, last ? TIMEOUT_MS : PROBE_MS).then(function (data) {
        server = list[i];
        return data;
      }, function (err) {
        if (err.kind === "network" && !last) return attempt(i + 1);
        server = list[i];
        throw err;
      });
    }
    return attempt(0);
  }

  S.api = {
    normalize: normalize,
    choices: CHOICES,
    server: function () { return server; },
    saved: function () { return { first: saved.first, second: saved.second, key: saved.key, choice: saved.choice }; },
    // Saves what Settings checked: { first, second, key, choice }. The first address is required.
    save: function (values) {
      saved.first = values.first;
      saved.second = values.second || "";
      saved.key = values.key || "";
      saved.choice = CHOICES.indexOf(values.choice) < 0 || (values.choice === "second" && !saved.second) ? "auto" : values.choice;
      store("first", saved.first);
      store("second", saved.second);
      store("key", saved.key);
      store("choice", saved.choice === "auto" ? "" : saved.choice);
      server = values.server || saved.first;
    },
    // Reads the library from an address that has not been saved yet, to check it first.
    discsFrom: function (base, key) { return request(base, "/api/discs", undefined, undefined, key); },
    discs: discs,
    coverUrl: function (disc) {
      return server + "/api/cover/" + encodeURIComponent(disc.id) + "?v=" + encodeURIComponent(disc.cover_v || "");
    },
    // Forgets where a disc was left, so it leaves "Continue watching".
    clearResume: function (id) { return request(server, "/api/disc/" + encodeURIComponent(id) + "/resume/clear", {}); },
    play: function (id, resume) { return request(server, "/api/play/" + encodeURIComponent(id), { resume: !!resume }); },
    player: function () { return request(server, "/api/player"); },
    status: function () { return request(server, "/api/player/status"); },
    stop: function () { return request(server, "/api/stop", {}); },
    // Starts the plain video (HLS) for a TV whose WebRTC cannot connect, and gives its full URL. The server
    // answers once it can be played, which takes a few seconds.
    plainVideo: function () {
      return request(server, "/api/stream/hls", {}, 20000).then(function (data) { return server + data.url; });
    },
    // Best effort, for when the app is closing and cannot wait for an answer. A beacon cannot carry headers, so
    // the key goes in the address.
    stopBeacon: function () {
      var query = saved.key ? "?key=" + encodeURIComponent(saved.key) : "";
      try { navigator.sendBeacon(server + "/api/stop" + query, ""); } catch (e) { /* closing anyway */ }
    },
    cmd: function (action, value) {
      var body = { action: action };
      if (value !== undefined) body.value = value;
      return request(server, "/api/player/cmd", body);
    }
  };
})(window.Streamiso);
