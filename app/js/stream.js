// Shows the WebRTC stream. There are two ways, with the same interface:
//   open(url, mount, events) -> { unlock(), close() }
//   events: onReady(), onAudio(ok), onKey(action)
//
// The iframe is the route docs/API.md describes. The Neko page needs a newer engine than older webOS TVs give
// installed apps (it uses ?. ?? and ||=), and it would not load there. So when this engine cannot parse that
// syntax, the app talks to Neko by itself: a WebSocket for the signalling, RTCPeerConnection and a <video>.
(function (S) {
  "use strict";

  function parses(code) {
    try { new Function(code); return true; } catch (e) { return false; }
  }

  function canLoadNekoPage() {
    return parses("var a={};a?.b;a??1;a.c||=1;");
  }

  function openIframe(url, mount, events) {
    var frame = document.createElement("iframe");
    frame.tabIndex = -1;
    frame.setAttribute("allow", "autoplay");
    frame.src = url;
    function onMessage(e) {
      var data = e.data;
      if (e.source !== frame.contentWindow || !data || data.streamiso !== true) return;
      if (data.type === "video-ready") events.onReady();
      else if (data.type === "audio-state") events.onAudio(!!data.ok);
      // A key that reached the page while it held the focus, before the app took the focus back.
      else if (data.type === "key" && typeof data.action === "string") events.onKey(data.action);
    }
    window.addEventListener("message", onMessage);
    mount.appendChild(frame);
    return {
      step: function () { return "waiting for the Neko page"; },
      unlock: function () {
        if (frame.contentWindow) frame.contentWindow.postMessage({ streamiso: true, type: "start" }, "*");
      },
      close: function () {
        window.removeEventListener("message", onMessage);
        frame.src = "about:blank";
        if (frame.parentNode) frame.parentNode.removeChild(frame);
      }
    };
  }

  // Neko's login answer can only be read with NEKO_SERVER_CORS set. Without it, each attempt still leaves a
  // session on the server, so the app stops trying after the first failure.
  var loginBlocked = false;

  function login(base, user, password) {
    if (loginBlocked) return Promise.resolve(null);
    return fetch(base + "/api/login", {
      method: "POST",
      // text/plain needs no preflight, which Neko answers with an error when CORS is off.
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({ username: user, password: password })
    }).then(function (res) {
      return res.ok ? res.json() : null;
    }).then(function (data) {
      return data && data.token ? data.token : null;
    }).catch(function () {
      loginBlocked = true;
      return null;
    });
  }

  // Ways to answer Neko's offer, in order. Older Chromium engines default to the older "plan B" and may only know the
  // older way of writing the data channel in an SDP.
  var VARIANTS = [
    { name: "unified-plan", semantics: "unified-plan", oldDataChannel: false },
    { name: "plan-b", semantics: "plan-b", oldDataChannel: false },
    { name: "old data channel", semantics: "unified-plan", oldDataChannel: true }
  ];

  function toOldDataChannel(sdp) {
    return sdp
      .replace(/a=extmap-allow-mixed\r?\n/g, "")
      .replace(/a=max-message-size:\d+\r?\n/g, "")
      .replace(/m=application (\d+) UDP\/DTLS\/SCTP webrtc-datachannel/, "m=application $1 DTLS/SCTP 5000")
      .replace(/a=sctp-port:5000/, "a=sctpmap:5000 webrtc-datachannel 1024");
  }

  function toNewDataChannel(sdp) {
    return sdp
      .replace(/m=application (\d+) (?:UDP\/)?DTLS\/SCTP 5000/, "m=application $1 UDP/DTLS/SCTP webrtc-datachannel")
      .replace(/a=sctpmap:5000 webrtc-datachannel \d+/, "a=sctp-port:5000");
  }

  function describe(error) {
    return (error && error.name ? error.name + ": " : "") + (error && error.message ? error.message : String(error));
  }

  function openClient(url, mount, events) {
    var parts = /^(https?):\/\/([^\/?#]+)/i.exec(url);
    var base = parts[1] + "://" + parts[2];
    var user = (/[?&]usr=([^&]*)/.exec(url) || [])[1] || "tv";
    var password = decodeURIComponent((/[?&]pwd=([^&]*)/.exec(url) || [])[1] || "");
    var socketBase = base.replace(/^http/i, "ws");
    var closed = false, ws = null, pc = null, token = null, legacy = false, reported = null;
    var step = "signing in to Neko", variantAt = 0, errors = [], lastOffer = "", pendingCandidates = [];

    var video = document.createElement("video");
    video.autoplay = true;
    video.playsInline = true;
    // Muted first, because an engine may refuse to autoplay with sound. unlock() turns the sound on.
    video.muted = true;
    mount.appendChild(video);

    function reportAudio() {
      var ok = !video.paused && !video.muted;
      if (ok !== reported) { reported = ok; events.onAudio(ok); }
    }
    var audioTimer = setInterval(reportAudio, 1000);

    video.addEventListener("playing", function ready() {
      if (!video.videoWidth) { setTimeout(ready, 200); return; }
      events.onReady();
    });

    function send(event, payload) {
      var body = legacy ? payload : { event: event, payload: payload };
      if (legacy) body.event = event;
      if (ws && ws.readyState === 1) ws.send(JSON.stringify(body));
    }

    function createPeer(variant) {
      var peer = new RTCPeerConnection({ iceServers: [], sdpSemantics: variant.semantics });
      peer.onicecandidate = function (e) {
        if (!e.candidate) return;
        if (legacy) send("signal/candidate", { data: JSON.stringify(e.candidate) });
        else send("signal/candidate", e.candidate.toJSON());
      };
      peer.oniceconnectionstatechange = function () {
        step = "network: " + peer.iceConnectionState;
      };
      peer.ontrack = function (e) {
        // One stream for both tracks: assigning srcObject again would abort the pending play().
        if (!video.srcObject) video.srcObject = new MediaStream();
        video.srcObject.addTrack(e.track);
        var played = video.play();
        if (played && played.catch) played.catch(function () { /* unlock() tries again */ });
      };
      return peer;
    }

    function addCandidate(candidate) {
      pc.addIceCandidate(candidate).catch(function () { /* one bad candidate is not fatal */ });
    }

    // Tries each variant in turn. The offer stays valid on the server, so a new peer can answer it.
    function tryNextVariant(problem) {
      errors.push(VARIANTS[variantAt].name + ": " + problem);
      if (pc) { try { pc.close(); } catch (e) { /* already closed */ } }
      pc = null;
      variantAt++;
      if (variantAt < VARIANTS.length) negotiate(lastOffer);
      else events.onError(errors.join("\n"));
    }

    function negotiate(sdp) {
      lastOffer = sdp;
      var variant = VARIANTS[variantAt];
      var stage = "creating the connection";
      try {
        if (!pc) pc = createPeer(variant);
      } catch (e) {
        tryNextVariant(stage + ", " + describe(e));
        return;
      }
      var peer = pc;
      stage = step = "reading the offer";
      peer.setRemoteDescription({ type: "offer", sdp: variant.oldDataChannel ? toOldDataChannel(sdp) : sdp }).then(function () {
        pendingCandidates.splice(0).forEach(addCandidate);
        stage = step = "creating the answer";
        return peer.createAnswer();
      }).then(function (answer) {
        stage = step = "applying the answer";
        return peer.setLocalDescription(answer);
      }).then(function () {
        step = "answer sent, waiting for the network";
        var answer = peer.localDescription.sdp;
        if (variant.oldDataChannel) answer = toNewDataChannel(answer);
        if (legacy) send("signal/answer", { displayname: user, sdp: answer });
        else send("signal/answer", { sdp: answer });
      }).catch(function (e) {
        if (!closed && peer === pc) tryNextVariant(stage + ", " + describe(e));
      });
    }

    function connect(socketUrl) {
      step = "connecting to Neko";
      ws = new WebSocket(socketUrl);
      ws.onopen = function () {
        step = "waiting for the offer";
        if (!legacy) send("signal/request", { video: {}, audio: {} });
      };
      ws.onmessage = function (e) {
        var msg = JSON.parse(e.data);
        var data = legacy ? msg : (msg.payload || {});
        if (msg.event === "system/heartbeat") send("client/heartbeat", {});
        else if (msg.event === "signal/provide" || msg.event === "signal/offer") negotiate(data.sdp);
        else if (msg.event === "signal/candidate") {
          var candidate = legacy && typeof data.data === "string" ? JSON.parse(data.data) : data;
          // A candidate can arrive before the offer has been read, and adding it then would fail.
          if (pc && pc.remoteDescription) addCandidate(candidate);
          else pendingCandidates.push(candidate);
        }
      };
    }

    login(base, user, password).then(function (result) {
      if (closed) {
        if (result) fetch(base + "/api/logout", { method: "POST", headers: { Authorization: "Bearer " + result } }).catch(function () {});
        return;
      }
      token = result;
      if (token) {
        connect(socketBase + "/api/ws?token=" + encodeURIComponent(token));
      } else {
        // The older socket takes the password in the URL, so it needs no login and no CORS.
        legacy = true;
        connect(socketBase + "/ws?password=" + encodeURIComponent(password) + "&username=" + encodeURIComponent(user));
      }
    });

    return {
      step: function () { return step; },
      unlock: function () {
        video.muted = false;
        var played = video.play();
        if (played && played.catch) played.catch(function () { /* still blocked: reportAudio says so */ });
        setTimeout(reportAudio, 300);
      },
      close: function () {
        closed = true;
        clearInterval(audioTimer);
        if (ws) { ws.onmessage = null; ws.close(); }
        if (pc) pc.close();
        video.srcObject = null;
        if (video.parentNode) video.parentNode.removeChild(video);
        if (token) fetch(base + "/api/logout", { method: "POST", headers: { Authorization: "Bearer " + token } }).catch(function () {});
      }
    };
  }

  // Plain video (HLS) from the server's /api/stream/hls, played by the TV's own player. For engines whose WebRTC
  // cannot connect to Neko. The picture is a few seconds late, and nothing else changes: commands still go through
  // the API, and the TV's player has no autoplay limits for an installed app.
  function openPlain(url, mount, events) {
    var video = document.createElement("video");
    var step = "waiting for the plain video";
    var reported = false;
    video.autoplay = true;
    mount.appendChild(video);
    video.addEventListener("playing", function ready() {
      step = "playing";
      if (reported) return;
      if (!video.videoWidth) { setTimeout(ready, 200); return; }
      reported = true;
      events.onReady();
      events.onAudio(true);
    });
    video.addEventListener("error", function () {
      var code = video.error ? video.error.code : 0;
      if (code) events.onError("The TV's player could not play the plain video (error " + code + ").");
    });
    video.src = url;
    var played = video.play();
    if (played && played.catch) played.catch(function () { /* autoplay starts it */ });
    return {
      step: function () { return step; },
      unlock: function () {
        var again = video.play();
        if (again && again.catch) again.catch(function () {});
      },
      close: function () {
        video.removeAttribute("src");
        try { video.load(); } catch (e) { /* releases the TV's player */ }
        if (video.parentNode) video.parentNode.removeChild(video);
      }
    };
  }

  var PREFERENCE_KEY = "streamiso.video";

  // The Chrome major version in the user agent, or 0 when it is not Chrome.
  function chromeVersion() {
    var match = /Chrome\/(\d+)/.exec(navigator.userAgent);
    return match ? parseInt(match[1], 10) : 0;
  }

  function webrtcMode() {
    if (typeof window.RTCPeerConnection !== "function") return "none";
    return canLoadNekoPage() ? "iframe" : "client";
  }

  S.stream = {
    // "auto", "webrtc" or "plain", chosen in Settings.
    preference: function () {
      var value = "";
      try { value = localStorage.getItem(PREFERENCE_KEY) || ""; } catch (e) { /* storage is optional */ }
      return value === "webrtc" || value === "plain" ? value : "auto";
    },
    setPreference: function (value) {
      try { localStorage.setItem(PREFERENCE_KEY, value); } catch (e) { /* lasts until the app closes */ }
    },
    // "iframe" or "client" (WebRTC), "plain" (HLS), or "none".
    // Automatic takes the plain video where WebRTC cannot work: no RTCPeerConnection, or an engine before Chrome 48,
    // the first with DTLS 1.2, which Neko requires (webOS 3 runs apps on Chrome 38 and fails with
    // "unsupported protocol version").
    mode: function () {
      var preference = S.stream.preference();
      if (preference === "plain") return "plain";
      var webrtc = webrtcMode();
      if (preference === "webrtc") return webrtc;
      var version = chromeVersion();
      if (webrtc === "none" || (version && version < 48)) return "plain";
      return webrtc;
    },
    open: function (url, mount, events) {
      var mode = S.stream.mode();
      var open = mode === "plain" ? openPlain : mode === "iframe" ? openIframe : openClient;
      return open(url, mount, events);
    },
    openClient: openClient,
    openIframe: openIframe,
    openPlain: openPlain
  };
})(window.Streamiso);
