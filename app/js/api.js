// The StreamISO HTTP API. See docs/API.md in the StreamISO repository.
(function (S) {
  "use strict";

  var STORAGE_KEY = "streamiso.server";
  var TIMEOUT_MS = 10000;
  var server = "";
  try { server = localStorage.getItem(STORAGE_KEY) || ""; } catch (e) { /* storage is optional */ }

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

  function request(base, path, body, timeoutMs) {
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, timeoutMs || TIMEOUT_MS);
    var options = { method: body === undefined ? "GET" : "POST", signal: controller.signal };
    if (body !== undefined) {
      options.headers = { "Content-Type": "application/json" };
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

  S.api = {
    normalize: normalize,
    server: function () { return server; },
    setServer: function (value) {
      server = value;
      try { localStorage.setItem(STORAGE_KEY, value); } catch (e) { /* lasts until the app closes */ }
    },
    // Reads the library from an address that has not been saved yet, to check it first.
    discsFrom: function (base) { return request(base, "/api/discs"); },
    discs: function () { return request(server, "/api/discs"); },
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
    // Best effort, for when the app is closing and cannot wait for an answer.
    stopBeacon: function () { try { navigator.sendBeacon(server + "/api/stop", ""); } catch (e) { /* closing anyway */ } },
    cmd: function (action, value) {
      var body = { action: action };
      if (value !== undefined) body.value = value;
      return request(server, "/api/player/cmd", body);
    }
  };
})(window.Streamiso);
