# Development

The app is plain HTML, CSS and JavaScript in `app/`, with no framework and no build step. It has no dependencies at run time.
Keep it to plain ES5 and to CSS that old Chromium engines understand. webOS 3 runs apps on Chrome 38 (2014), so
`js/compat.js`, loaded first, adds what it lacks and the app uses: `Element.closest`, `fetch` and `AbortController`.
Covers load on scroll there, without `IntersectionObserver`, and the CSS animation needs its `-webkit-` form.
webOS 4 runs apps on Chromium 53, webOS 5 on Chromium 68.

`appinfo.json` asks for a 1280x720 window, and the layout, drawn for 1920x1080, is scaled down to it. With the
default 1920x1080 window, a TV with a 1366x768 panel (24TL520S) drew only 1366x768 of it, the top left 71% of the
screen, and left the rest black. Check the fit with a photo of the screen: `outerWidth` and DevTools screenshots
did not match what that TV showed.

To look at the app on the TV, run `ares-inspect --device tv --app io.github.rubinhos.streamiso --host-port 9998` in the
CLI image with `-p 9998:9998`: the TV's DevTools protocol is then at `http://localhost:9998/json`.
GitHub Actions checks that the JavaScript parses as ES5, runs the tests in a headless Chrome and builds the `.ipk`.

## Run it on a PC

The simulated server uses only Python's standard library. All its titles and covers are invented.

```sh
python tools/mock_server.py
# or
docker run --rm -p 8090:8090 -p 8091:8091 -v "$PWD:/repo:ro" python:3.12-slim python /repo/tools/mock_server.py
```

- **App:** <http://localhost:8090/app/>, with `localhost:8090` as the server's address.
- **Tests:** <http://localhost:8090/tests/>. They press keys in the real app, and check the focus and the commands sent.

## The remote

| Where | Arrows and OK | Back |
|---|---|---|
| Catalog | Move and open | Leave the app |
| A season's discs | Move and open | Return to the catalog |
| Settings | Move, OK to type | Return to the catalog |
| DVD menu, bar closed | Go to the disc's menu | Open the bar |
| DVD film, bar closed | Up and Down open the bar. Left, Right and OK go to the disc | Return: the menu of what is playing |
| DVD, bar open | Move between the controls | Close the bar |
| Blu-ray, bar closed | Go to the disc (its menu, or its pop-up menu over the film) | Open the bar |
| CD | Move through the tracks and controls | Return to the catalog |

- The discs of a TV season (`Show S02 D1`, or a season set in StreamISO's editor) form one card, as on StreamISO's web
  page. OK opens the season's discs in disc order. Leaving a disc returns to its season.
- A DVD starts with the bar closed, so it never covers the disc's own menu. Info opens it, and so do Up or Down during a
  film and Back in a menu. The bar closes by itself after 6 seconds, and then the arrows go to the disc's menu again.
- **Return** (Back during a film, or the Return button in the bar) asks StreamISO for the Root menu of the part of the
  disc that is playing, as the Menu key of a DVD remote does. The disc decides which menu that is: often the one the
  film or extra was started from, sometimes the main menu. **Disc menu** goes to the disc's main menu.
- A Blu-ray (`format: "bluray"` in the API) counts as always in a menu: the background of its menu is a long video,
  so its length says nothing. All arrows and OK go to the disc; Back or Info open the bar, and its **Disc menu** opens
  the disc's pop-up menu over the film (discs refuse their main menu during the film). After the start the loading
  screen stays up, saying why, until the disc's time moves: its Java program takes about 20 seconds to start.
- A menu is recognized by title 0, no duration, or a duration under 5 minutes. Real menus report a duration, so that alone
  is not enough. For 5 seconds after using the disc (any arrow or OK), Up and Down stay with it even in what looks like a film.
- The back arrow in the bar, or Stop, leaves a DVD.
- **Progress line:** press Up from the buttons to reach it, then Left and Right to move. The jump happens when you stop
  pressing, or right away with OK. Holding the key moves faster.
- Media keys work anywhere in the player, when the remote has them.
- LG remotes send Back as 461, and Play, Pause, Stop, Rewind and Fast forward when they have those keys. They have no
  play/pause toggle and no next or previous; those stay on the bar. The newer Magic Remotes have no media keys at all.
- On a PC keyboard: Esc is Back, Space is play or pause, and S, F, R, N, P and I are stop, forward, rewind, next, previous and info.

## The video

The app picks one of three routes. **Settings** shows which one it is using, and lets you force one (Automatic,
Plain video or WebRTC).

- **Neko page in an iframe,** as StreamISO's `docs/API.md` describes, on engines that can run that page.
- **Built-in client** (a WebSocket, `RTCPeerConnection` and a `<video>`) on older engines. The current Neko page uses syntax
  (`?.`, `??`, `||=`) that engines before Chromium 85 cannot parse.
- **Plain video** (HLS in a `<video>`, played by the TV's own player) where WebRTC cannot work: no `RTCPeerConnection`,
  or an engine before Chrome 48, the first with DTLS 1.2, which Neko requires. webOS 3 runs apps on Chrome 38, whose
  WebRTC fails with "unsupported protocol version". The app asks the server with `POST /api/stream/hls`, which starts
  Neko's broadcast and stops it once the TV stops fetching it. The picture arrives about 5 seconds late, because the
  TV's player keeps about 2.5 seconds of buffer and cannot be told to keep less, so DVD menus answer slowly. Playing
  faster to catch up broke that player, and one continuous MPEG-TS stream stalled: HLS was the steadiest.

The built-in client reads Neko's login answer. A 2020 Samsung TV read it without any setting on the server, but a desktop browser
needs CORS on Neko. Without the answer the client falls back to Neko's older socket, which connected less reliably in
testing. If you need it, in the `neko` service of StreamISO's `docker-compose.yml`:

```yaml
NEKO_SERVER_CORS: "${CORS_ORIGIN:-}"
```

Pin `NEKO_IMAGE` to a release when using the built-in client, since it depends on Neko's protocol.

The focus stays in the app, which takes it back whenever the stream's page asks for it. DVD menu moves go to `POST /api/player/cmd`.

## Tested and not tested

**Tested in a headless Chrome (GitHub Actions), against the simulated server:** focus movement, the rule for each key, the opening order
(`resume_apply`, then `start`), the errors and the first launch.

**Tested against a real Neko, from a PC, with the same code in the Samsung app:** both video routes connect and deliver
the picture.

**Not tested, because it needs a TV.** Check these on one:

1. **Video:** does a DVD play? Is the picture full size, without flicker? Do installed apps on this webOS version have
   WebRTC?
2. **Sound:** if "Press any key to turn the sound on" stays up after a key press, sound is blocked.
3. **Settings:** which engine and video route show up?
4. **DVD menu:** do the arrows and OK work, including in the first 20 seconds, when the stream's page asks for the focus?
5. **Back:** in each row of the table above. Back in the catalog should close the app.
6. **Media keys:** which ones the remote has, and whether they work.
7. **Typing the address:** does the keyboard open with OK, and does the focus return when you finish or cancel?
8. **Screen saver:** leave a disc playing for longer than it takes to start. The app refuses it through
   `com.webos.service.tvpower`, which may not be open to apps in developer mode.
9. **Magic Remote pointer:** pointing and clicking on cards and buttons, and the arrows again after the pointer hides.
10. **Home button during a film:** it should pause. See what happens when you return.
