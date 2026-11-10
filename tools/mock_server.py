#!/usr/bin/env python3
"""A stand-in for a StreamISO server, for working on the app without the real one or the TV.

Standard library only. Port 8090 answers like the catalog and also serves app/ and tests/. Port 8091 stands in
for the Neko stream, on a different origin as the real one is. Every title and cover here is invented.

    python tools/mock_server.py
    docker run --rm -p 8090:8090 -p 8091:8091 -v "$PWD:/repo:ro" python:3.12-slim python /repo/tools/mock_server.py

Then open http://localhost:8090/app/ (server address: localhost:8090) or http://localhost:8090/tests/.
"""
import json
import mimetypes
import os
import re
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
API_PORT = int(os.environ.get("MOCK_PORT", "8090"))
STREAM_PORT = int(os.environ.get("MOCK_STREAM_PORT", "8091"))
VLC_START_SECONDS = 1.0


def dvd(number, title, year, genres, synopsis, **extra):
    disc = {"id": "d%011d" % number, "kind": "dvd", "title": title, "year": year, "genres": genres,
            "synopsis": synopsis, "watched": False, "resume": None, "cover_v": 1,
            "season": None, "disc": None, "tmdb_series": None}
    disc.update(extra)
    return disc


def cd(number, title, artist, year, genres, tracks, **extra):
    disc = {"id": "c%011d" % number, "kind": "cd", "title": title, "artist": artist, "year": year, "genres": genres,
            "synopsis": "", "track_count": len(tracks), "duration": sum(t[1] for t in tracks), "watched": False,
            "resume": None, "cover_v": 1, "mock_tracks": tracks}
    disc.update(extra)
    return disc


TONES = [("Morning on the Quay", 214), ("Paper Lanterns", 187), ("Slow Tide", 243), ("The Long Way Round", 201),
         ("Copper Sky", 176), ("Harbour Lights", 259), ("Salt and Cedar", 198), ("Last Ferry Home", 305)]

DISCS = [
    dvd(1, "The Lighthouse Keeper's Almanac", 1998, ["Drama"], "A keeper counts the years by storms, until a visitor brings a different calendar.",
        resume={"time": 2535, "pct": 41}),
    dvd(2, "Moonlit Marmalade", 2003, ["Comedy", "Family"], "Two rival jam makers discover the same secret recipe.", watched=True),
    dvd(3, "Orbit of the Paper Crane", 2011, ["Science Fiction"], "A folded bird drifts past a silent station, and its crew decides to follow."),
    dvd(4, "Seven Doors on Juniper Street", 1994, ["Mystery"], "Every house on the street has one door too many."),
    dvd(5, "The Cartographer's Daughter", 2007, ["Adventure"], "An unfinished map leads across a country that keeps changing shape."),
    dvd(6, "Rain Over Velvet Hill", 2001, ["Romance"], "One town, one summer, and a storm that will not leave."),
    dvd(7, "Clockwork Orchard", 2015, ["Animation", "Family"], "Machines tend the last apple trees, and one of them starts to dream."),
    dvd(8, "A Short History of Tin", 1989, ["Documentary"], "From mines to cans, told by the people who hold it."),
    dvd(9, "Night Train to Nowhere Near", 1997, ["Thriller"], "A sleeping car, a missing ticket and a station not on any map."),
    dvd(10, "Saltwater Symphony", 2009, ["Music", "Drama"], "A fishing village forms an orchestra."),
    dvd(11, "The Beekeeper's Gambit", 2013, ["Comedy"], "A chess tournament is thrown into chaos by a hive."),
    dvd(12, "Glass Mountain Radio", 2005, ["Drama"], "The last broadcaster above the snow line refuses to sign off.", watched=True),
    # A season: one disc names it in its title, the others have it set in the editor, as on the real server.
    dvd(13, "Tales from the Fifth Floor S01 D2", 2018, ["Comedy"], "The elevator is fixed, and that makes everything worse.",
        resume={"time": 1210, "pct": 30}),
    dvd(14, "Tales from the Fifth Floor", 2018, ["Comedy"], "An office, an elevator and a very long Tuesday.", season=1, disc=1),
    dvd(15, "Tales from the Fifth Floor", 2019, ["Comedy"], "A new floor opens, and nobody has the key.", season=2, disc=1,
        watched=True),
    cd(1, "Harbour Songs", "The Quayside Quartet", 2002, ["Folk"], TONES, resume={"time": 603, "pct": 35, "track": 3, "track_time": 41}),
    cd(2, "Copper and Rain", "Marla Venn", 1999, ["Jazz"], TONES[:5], watched=True),
    cd(3, "Field Recordings for Small Rooms", "Ostinato Club", 2014, ["Ambient"], TONES[2:]),
    cd(4, "Twelve Short Goodbyes", "The Paper Boats", 2008, ["Pop"], TONES + TONES[:4]),
]

COLORS = ["#27496d", "#6d2e46", "#2e6d5b", "#6b5b2e", "#3f2e6d", "#6d4a2e"]

lock = threading.Lock()
state = {}
log = []


RESUME = {d["id"]: d["resume"] for d in DISCS}  # what reset() puts back after a test forgets a position


def reset():
    for d in DISCS:
        d["resume"] = RESUME[d["id"]]
    state.clear()
    state.update({"disc": None, "resume": False, "opened_at": 0, "started": False, "paused": True, "time": 0.0,
                  "tick": time.time(), "volume": 80, "track": 0, "in_menu": True, "api_down": False,
                  "stream_silent": False, "audio_blocked": True, "unlock_blocked": 0, "fail_start": 0, "film_length": 6300})
    del log[:]


reset()


def find(disc_id):
    return next((d for d in DISCS if d["id"] == disc_id), None)


def advance():
    now = time.time()
    if state["disc"] and state["started"] and not state["paused"]:
        state["time"] += now - state["tick"]
    state["tick"] = now


def vlc_ready():
    return time.time() - state["opened_at"] >= VLC_START_SECONDS


def public_disc(disc):
    return {k: v for k, v in disc.items() if k != "mock_tracks"}


def tracks_of(disc):
    return [{"n": i + 1, "title": t[0], "artist": disc.get("artist", ""), "start": sum(x[1] for x in disc["mock_tracks"][:i]), "length": t[1]}
            for i, t in enumerate(disc["mock_tracks"])]


def status():
    disc = state["disc"]
    if not disc:
        return {"state": "idle"}
    if not vlc_ready():
        return {"state": "offline"}
    advance()
    vlc_state = "paused" if state["paused"] else "playing"
    if disc["kind"] == "cd":
        tracks = disc["mock_tracks"]
        state["track"] = min(state["track"], len(tracks) - 1)
        length = tracks[state["track"]][1]
        return {"state": vlc_state, "kind": "cd", "volume": state["volume"], "track": state["track"], "tracks": len(tracks),
                "time": int(state["time"]), "length": length, "abs": int(state["time"])}
    # A real disc's menu reports title 0 and a short duration, not "no duration".
    return {"state": vlc_state, "time": int(state["time"]) % 190 if state["in_menu"] else int(state["time"]),
            "length": 190 if state["in_menu"] else state["film_length"],
            "volume": state["volume"], "chapter": 0 if state["in_menu"] else 3, "title": 0 if state["in_menu"] else 1,
            "audio": [{"id": 1, "name": "English"}, {"id": 2, "name": "Portuguese"}],
            "subtitles": [{"id": -1, "name": "Disable"}, {"id": 3, "name": "English"}, {"id": 4, "name": "Portuguese"}]}


def command(action, value):
    log.append({"action": action, "value": value})
    disc = state["disc"]
    if not disc:
        return 409, {"error": "nothing is playing"}
    if not vlc_ready():
        return 503, {"error": "VLC is not ready"}
    advance()
    if action == "start":
        if state["fail_start"] > 0:
            state["fail_start"] -= 1
            return 503, {"error": "VLC is not ready"}
        state["started"] = True
        state["paused"] = False
    elif action == "resume_apply":
        if state["resume"] and disc["resume"]:
            state["time"] = float(disc["resume"]["time"])
            state["in_menu"] = False
            if disc["kind"] == "cd":
                state["track"] = disc["resume"].get("track", 1) - 1
                state["time"] = float(disc["resume"].get("track_time", 0))
    elif action == "toggle":
        state["paused"] = not state["paused"]
    elif action == "seek":
        state["time"] = float(value)
    elif action == "volume":
        state["volume"] = int(value)
    elif action == "track":
        state["track"] = int(value)
        state["time"] = 0.0
    elif action in ("chapter_next", "track_next") and disc["kind"] == "cd":
        state["track"] += 1
        state["time"] = 0.0
    elif action == "nav" and value == "activate":
        state["in_menu"] = False
    elif action == "return":
        state["in_menu"] = True
    elif action == "menu":
        state["in_menu"] = True
    elif action not in ("chapter_next", "chapter_prev", "track_prev", "audio", "subtitle", "nav"):
        return 400, {"error": "unknown action"}
    return 200, {"ok": True}


def cover_svg(disc):
    size = (300, 300) if disc["kind"] == "cd" else (300, 450)
    color = COLORS[hash(disc["id"]) % len(COLORS)]
    words, line, lines = disc["title"].split(), "", []
    for word in words:
        if len(line) + len(word) > 15:
            lines.append(line)
            line = ""
        line = (line + " " + word).strip()
    lines.append(line)
    text = "".join('<text x="24" y="%d" font-family="Georgia,serif" font-size="30" fill="#fff">%s</text>' % (70 + i * 38, l.replace("&", "&amp;"))
                   for i, l in enumerate(lines))
    return ('<svg xmlns="http://www.w3.org/2000/svg" width="%d" height="%d"><rect width="100%%" height="100%%" fill="%s"/>'
            '<circle cx="%d" cy="%d" r="90" fill="#ffffff" opacity=".1"/>%s</svg>' % (size[0], size[1], color, size[0] - 60, size[1] - 70, text))


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def send_bytes(self, code, body, kind):
        self.send_response(code)
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        # Plays the part of CORS_ORIGIN=null on the real server.
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.end_headers()
        self.wfile.write(body)

    def send_json(self, code, data):
        self.send_bytes(code, json.dumps(data).encode(), "application/json")

    def read_json(self):
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""
        try:
            return json.loads(raw or b"{}")
        except ValueError:
            return {}

    def send_file(self, relative):
        path = os.path.normpath(os.path.join(ROOT, relative))
        if not path.startswith(ROOT) or not os.path.isfile(path):
            self.send_json(404, {"error": "not found"})
            return
        with open(path, "rb") as handle:
            body = handle.read()
        self.send_bytes(200, body, mimetypes.guess_type(path)[0] or "application/octet-stream")

    def drop_if_down(self, path):
        if state["api_down"] and path.startswith("/api/"):
            self.close_connection = True
            self.connection.close()
            return True
        return False

    def do_OPTIONS(self):
        self.send_bytes(204, b"", "text/plain")

    def do_GET(self):
        path = self.path.split("?")[0]
        if self.server.server_port == STREAM_PORT:
            self.send_file("tools/mock_stream.html")
            return
        with lock:
            if self.drop_if_down(path):
                return
            if path == "/api/discs":
                playing = state["disc"]["id"] if state["disc"] else None
                self.send_json(200, {"discs": [public_disc(d) for d in DISCS], "genres": [],
                                     "media_dir": "/media", "tmdb": False, "playing": playing})
            elif path.startswith("/api/cover/"):
                disc = find(path.rsplit("/", 1)[1])
                self.send_bytes(200, cover_svg(disc).encode(), "image/svg+xml") if disc else self.send_json(404, {"error": "no disc"})
            elif path == "/api/player":
                self.send_json(200, self.player_info())
            elif path == "/api/player/status":
                self.send_json(200, status())
            elif path == "/healthz":
                self.send_json(200, {"ok": True, "version": "mock"})
            elif path == "/_mock/log":
                self.send_json(200, {"log": log, "state": {k: v for k, v in state.items() if k != "disc"}})
            elif path == "/_mock/stream-config":
                self.send_json(200, {"silent": state["stream_silent"], "audio_blocked": state["audio_blocked"],
                                     "unlock_blocked": state["unlock_blocked"]})
            elif path == "/":
                self.send_json(200, {"app": "/app/", "tests": "/tests/"})
            else:
                relative = path.lstrip("/")
                if relative.endswith("/") or relative in ("app", "tests"):
                    relative = relative.rstrip("/") + "/index.html"
                self.send_file(relative)

    def player_info(self):
        host = self.headers.get("Host", "localhost").split(":")[0]
        disc = state["disc"]
        info = {"url": "http://%s:%d/?usr=tv&pwd=neko&cast=1" % (host, STREAM_PORT), "title": None, "id": None,
                "kind": "dvd", "resume": False, "resume_at": None}
        if disc:
            info.update({"title": disc["title"], "id": disc["id"], "kind": disc["kind"], "resume": bool(state["resume"] and disc["resume"]),
                         "resume_at": disc["resume"]["time"] if state["resume"] and disc["resume"] else None})
            if disc["kind"] == "cd":
                info.update({"artist": disc["artist"], "cover": "/api/cover/" + disc["id"], "tracks": tracks_of(disc)})
        return info

    def do_POST(self):
        path = self.path.split("?")[0]
        body = self.read_json()
        with lock:
            if self.drop_if_down(path):
                return
            match = re.match(r"^/api/play/([^/]+)$", path)
            if match:
                disc = find(match.group(1))
                if not disc:
                    self.send_json(404, {"error": "no such disc"})
                    return
                state.update({"disc": disc, "resume": bool(body.get("resume")), "opened_at": time.time(), "started": False,
                              "paused": True, "time": 0.0, "track": 0, "in_menu": True, "tick": time.time()})
                log.append({"action": "play", "value": {"id": disc["id"], "resume": bool(body.get("resume"))}})
                self.send_json(200, {"player_url": "/player", "title": disc["title"], "kind": disc["kind"]})
            elif re.match(r"^/api/disc/[^/]+/resume/clear$", path):
                disc = find(path.split("/")[3])
                if not disc:
                    self.send_json(404, {"error": "no such disc"})
                    return
                disc["resume"] = None
                log.append({"action": "resume_clear", "value": disc["id"]})
                self.send_json(200, {"ok": True})
            elif path == "/api/stop":
                state.update({"disc": None, "started": False})
                log.append({"action": "stop", "value": None})
                self.send_json(200, {"ok": True})
            elif path == "/api/player/cmd":
                code, answer = command(body.get("action"), body.get("value"))
                self.send_json(code, answer)
            elif path == "/_mock/reset":
                reset()
                self.send_json(200, {"ok": True})
            elif path == "/_mock/set":
                state.update(body)
                self.send_json(200, {"ok": True})
            elif path == "/_mock/clear-log":
                del log[:]
                self.send_json(200, {"ok": True})
            else:
                self.send_json(404, {"error": "not found"})


def main():
    servers = [ThreadingHTTPServer(("0.0.0.0", port), Handler) for port in (API_PORT, STREAM_PORT)]
    threading.Thread(target=servers[1].serve_forever, daemon=True).start()
    print("Mock StreamISO: http://localhost:%d/app/  tests: http://localhost:%d/tests/" % (API_PORT, API_PORT), flush=True)
    servers[0].serve_forever()


if __name__ == "__main__":
    main()
