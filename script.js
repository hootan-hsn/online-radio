/* =====================================================================
   Raadio front end
   - Gapless two-element player that keeps playing with the screen off
   - Hardware / headset buttons through the Media Session API
   - Lite mode for old Android (real version read via UA Client Hints)
   - Mock studio: login, upload, recording, schedule, calendar
   ===================================================================== */
(function () {
  "use strict";

  /* ---------------- Config ---------------- */
  var CONFIG = {
    // Tried in order; the first that answers wins, the rest are fallbacks.
    HOSTS: [
      "https://raadio.run.place",
      "https://radio-relay.hootan-hosseiny.workers.dev"
    ],
    STREAM_PATH: "/radio.mp3",
    SKIP_PATH: "/skip",
    NOW_PLAYING_PATH: null,      // e.g. "/now-playing" once the backend returns {"title": "..."}
    NOW_PLAYING_EVERY_MS: 20000,
    CROSSFADE_MS: 400,
    ANNOUNCEMENTS: [],           // e.g. [{ text: "Weekend mix", at: "2026-10-17T20:00:00Z" }]
    RECORD_MAX_MS: 10 * 60 * 1000,
    UPLOAD_MAX_MB: 50
  };

  /* ---------------- Small helpers ---------------- */
  function $(id) { return document.getElementById(id); }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function setText(el, text) { if (el && el.textContent !== text) el.textContent = text; }
  function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }

  var store = {
    get: function (k, d) { try { var v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set: function (k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode */ } },
    del: function (k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } }
  };

  function fmt(date, opts) {
    try { return new Intl.DateTimeFormat(undefined, opts).format(date); }
    catch (e) { return date.toLocaleString(); }
  }
  function fmtClock(d) { return fmt(d, { hour: "2-digit", minute: "2-digit" }); }
  function fmtFull(d) {
    return fmt(d, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZoneName: "short" });
  }
  function fmtSoon(d) {
    var now = new Date();
    var tomorrow = new Date(now); tomorrow.setDate(now.getDate() + 1);
    if (d.toDateString() === now.toDateString()) return fmtClock(d);
    if (d.toDateString() === tomorrow.toDateString()) return fmt(d, { weekday: "short" }) + " " + fmtClock(d);
    if (d - now < 6 * 864e5) return fmt(d, { weekday: "short", hour: "2-digit", minute: "2-digit" });
    return fmt(d, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  }
  function tzLabel() {
    try {
      var parts = new Intl.DateTimeFormat(undefined, { timeZoneName: "short" }).formatToParts(new Date());
      for (var i = 0; i < parts.length; i++) if (parts[i].type === "timeZoneName") return parts[i].value;
    } catch (e) { /* ignore */ }
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "local time"; } catch (e) { return "local time"; }
  }
  function toLocalInput(d) {
    function p(n) { return String(n).padStart(2, "0"); }
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + "T" + p(d.getHours()) + ":" + p(d.getMinutes());
  }
  function fromLocalInput(v) {
    if (!v) return null;
    var d = new Date(v);               // "YYYY-MM-DDTHH:MM" is parsed as local time
    return isNaN(d.getTime()) ? null : d;
  }
  function defaultAirTime() {
    var d = new Date(Date.now() + 60 * 60 * 1000);
    d.setMinutes(Math.ceil(d.getMinutes() / 5) * 5, 0, 0);
    return d;
  }
  function onIdle(fn) {
    if ("requestIdleCallback" in window) requestIdleCallback(fn, { timeout: 3000 });
    else setTimeout(fn, 600);
  }

  /* ---------------- Performance mode ---------------- */
  var perf = (function () {
    var listeners = [];
    var params = new URLSearchParams(location.search);
    var forced = params.get("lite");
    if (forced === "1" || forced === "0") store.set("raadio.lite", forced === "1");
    var pref = store.get("raadio.lite", null);

    // The UA string is frozen on modern Chrome ("Android 10; K", "Chrome/138.0.0.0"),
    // so a plain UA match for "Android 9" / "138.0.7204.179" never fires there.
    // This sync check only catches older browsers that still send the real version.
    var ua = navigator.userAgent;
    var m = ua.match(/Android (\d+)/);
    var oldAndroidUA = !!(m && +m[1] <= 9 && ua.indexOf("; K)") === -1);
    var weak = (navigator.deviceMemory && navigator.deviceMemory <= 2) ||
               (navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 2);

    var lite = pref !== null ? pref : !!(oldAndroidUA || weak);
    document.body.classList.toggle("lite", lite);

    function set(on, reason) {
      if (on === lite) return;
      lite = on;
      document.body.classList.toggle("lite", on);
      if (on && reason) log.add("warn", "Lite mode on (" + reason + ")");
      listeners.forEach(function (fn) { fn(on); });
    }

    // Real Android / Chrome versions via UA Client Hints (Chrome 90+).
    function refine() {
      var uad = navigator.userAgentData;
      if (pref !== null || !uad || !uad.getHighEntropyValues) return;
      uad.getHighEntropyValues(["platformVersion", "fullVersionList"]).then(function (h) {
        var android = parseInt(h.platformVersion, 10);
        var list = h.fullVersionList || [];
        var chrome = 0;
        for (var i = 0; i < list.length; i++) if (/Chrom/.test(list[i].brand)) chrome = parseInt(list[i].version, 10);
        if (uad.platform === "Android" && android > 0 && android <= 9) {
          set(true, "Android " + android + (chrome ? ", Chrome " + chrome : ""));
        }
      }).catch(function () { /* hints unavailable */ });
    }

    // If the page can't hold 30 fps right after load, drop the effects.
    function probe() {
      if (lite || pref !== null) return;
      var frames = 0, start = 0;
      function tick(t) {
        if (!start) start = t;
        frames++;
        if (t - start < 2500) { requestAnimationFrame(tick); return; }
        var fps = frames * 1000 / (t - start);
        if (fps < 30 && !document.hidden) set(true, "low frame rate, " + Math.round(fps) + " fps");
      }
      requestAnimationFrame(tick);
    }

    return {
      isLite: function () { return lite; },
      onChange: function (fn) { listeners.push(fn); },
      refine: refine,
      probe: probe,
      reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches
    };
  })();

  /* ---------------- Server log (studio panel C) ---------------- */
  var log = (function () {
    var el = $("server-log");
    var items = [];
    var dirty = false;
    var visible = false;

    function render() {
      dirty = false;
      var frag = document.createDocumentFragment();
      items.forEach(function (it) {
        var li = document.createElement("li");
        var t = document.createElement("time");
        t.dateTime = it.at.toISOString();
        t.textContent = fmtClock(it.at);
        var s = document.createElement("span");
        s.className = "log-" + it.type;
        s.textContent = it.text;
        li.appendChild(t); li.appendChild(s);
        frag.appendChild(li);
      });
      el.replaceChildren(frag);
    }
    return {
      add: function (type, text) {
        if (items.length && items[0].text === text) return;
        items.unshift({ type: type, text: text, at: new Date() });
        if (items.length > 6) items.length = 6;
        // Only touch the DOM when the studio is showing (keeps audio transitions light)
        if (visible) onIdle(render); else dirty = true;
      },
      show: function (on) { visible = on; if (on && dirty) render(); }
    };
  })();

  /* ---------------- Theme ---------------- */
  function applyTheme() {
    var h = new Date().getHours();
    var dark = h >= 18 || h < 6;
    if (document.body.classList.contains("dark-mode") === dark && applyTheme.done) return;
    applyTheme.done = true;
    document.body.classList.toggle("dark-mode", dark);
    $("theme-color").setAttribute("content", dark ? "#1c1a17" : "#f4f1ea");
    wave.refreshColors();
  }

  /* ---------------- Hosts ---------------- */
  var hosts = (function () {
    var list = CONFIG.HOSTS.slice();
    var idx = Math.max(0, list.indexOf(store.get("raadio.host", list[0])));

    function probe(host, delay) {
      return new Promise(function (resolve, reject) {
        setTimeout(function () {
          var ctrl = "AbortController" in window ? new AbortController() : null;
          var t = setTimeout(function () { if (ctrl) ctrl.abort(); reject(new Error("timeout")); }, 6000);
          fetch(host + "/?probe=" + Date.now(), { mode: "no-cors", cache: "no-store", signal: ctrl ? ctrl.signal : undefined })
            .then(function () { clearTimeout(t); resolve(host); })
            .catch(function (e) { clearTimeout(t); reject(e); });
        }, delay);
      });
    }

    return {
      current: function () { return list[idx]; },
      others: function () { return list.filter(function (_, i) { return i !== idx; }); },
      next: function () { idx = (idx + 1) % list.length; store.set("raadio.host", list[idx]); return list[idx]; },
      label: function (h) { try { return new URL(h || list[idx]).hostname; } catch (e) { return h; } },
      isRelay: function () { return idx !== 0; },
      pick: function () {
        if (list.length < 2 || !Promise.any) return Promise.resolve(list[idx]);
        // the last host that worked gets a head start, so most people stay where they were
        return Promise.any(list.map(function (h, i) { return probe(h, i === idx ? 0 : 400); }))
          .then(function (h) { idx = list.indexOf(h); store.set("raadio.host", h); return h; })
          .catch(function () { return list[idx]; });
      }
    };
  })();

  /* ---------------- Audio engine ----------------
     Two <audio> elements. A new connection is prepared on the idle one while the
     current one finishes its buffered audio, then they crossfade. A near-silent
     loop runs during any gap so Android keeps the page "playing" with the screen off
     (a silent page gets its timers frozen, which is why track changes stopped). */
  var engine = (function () {
    var A = new Audio(), B = new Audio();
    var cur = A, nxt = B;
    var keep = new Audio();
    var handlers = {};
    var wanted = false, connecting = false, unlocked = false;
    var gen = 0, failures = 0, held = null, holdTimer = null, fadeTimer = null;
    var lastTime = 0, lastAdvance = 0, lastBufEnd = 0, lastGrow = 0;
    var canFade = (function () { try { var a = new Audio(); a.volume = 0.5; return a.volume === 0.5; } catch (e) { return false; } })();

    [A, B].forEach(function (el) {
      el.preload = "none";
      el.setAttribute("playsinline", "");
      el.addEventListener("ended", function () { if (el === cur && wanted && el.src !== keep.src) curDown("ended"); });
      el.addEventListener("error", function () {
        if (el === cur && wanted && el.getAttribute("src") && el.src !== keep.src) curDown("error");
      });
      // The OS paused us (call, headphones unplugged): treat it as a user pause
      el.addEventListener("pause", function () {
        if (el !== cur || !wanted || el.ended || !el.getAttribute("src") || el.src === keep.src) return;
        if (fadeTimer) return;
        stop();
      });
    });

    keep.loop = true;
    keep.preload = "auto";
    keep.src = silentWav();

    function emit(evt, data) { (handlers[evt] || []).forEach(function (fn) { try { fn(data); } catch (e) { console.error(e); } }); }
    function on(evt, fn) { (handlers[evt] = handlers[evt] || []).push(fn); }

    function silentWav() {
      var rate = 8000, n = rate;   // 1 s, 16-bit mono
      var buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
      function w(o, s) { for (var i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); }
      w(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); w(8, "WAVE"); w(12, "fmt ");
      v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
      v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
      w(36, "data"); v.setUint32(40, n * 2, true);
      // ±1 LSB (about -90 dB): inaudible, but not digital silence, so the page still counts as playing
      for (var i = 0; i < n; i++) v.setInt16(44 + i * 2, (i & 1) ? 1 : -1, true);
      return URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
    }

    function streamUrl() { return hosts.current() + CONFIG.STREAM_PATH + "?t=" + Date.now(); }

    function release(el) {
      try { el.pause(); } catch (e) { /* ignore */ }
      el.removeAttribute("src");
      try { el.load(); } catch (e) { /* ignore */ }
      el.volume = 1;
      el.preload = "none";
    }

    function audible(el) { return !!el.getAttribute("src") && el.src !== keep.src && !el.paused && !el.ended && el.readyState >= 2; }
    function bufferedEnd(el) { try { var b = el.buffered; return b.length ? b.end(b.length - 1) : 0; } catch (e) { return 0; } }
    function ahead(el) { return Math.max(0, bufferedEnd(el) - el.currentTime); }

    function startKeep() { if (keep.paused) { var p = keep.play(); if (p && p.catch) p.catch(function () {}); } }
    function stopKeep() { if (!keep.paused) keep.pause(); }

    // iOS needs each element started once inside a tap; Chrome doesn't care.
    function unlock() {
      if (unlocked) return;
      unlocked = true;
      startKeep();
      var el = cur;               // the first connection goes to the other element
      if (!el.getAttribute("src")) {
        el.muted = true;
        el.src = keep.src;
        var p = el.play();
        var done = function () { el.muted = false; if (el.src === keep.src) release(el); };
        if (p && p.then) p.then(done, done); else done();
      }
    }

    function clearHold() {
      if (holdTimer) { clearInterval(holdTimer); holdTimer = null; }
      held = null;
    }

    function resetWatch() {
      var now = Date.now();
      lastTime = 0; lastAdvance = now; lastBufEnd = 0; lastGrow = now;
    }

    function connect(reason) {
      var my = ++gen;
      connecting = true;
      clearHold();
      if (!audible(cur)) { startKeep(); emit("state", "connecting"); }
      emit("connecting", reason);
      // After our own skip the old source needs a moment to drop off the mount
      setTimeout(function () { attempt(my, reason, 0); }, reason === "skip" ? 350 : 0);
    }

    function attempt(my, reason, n) {
      if (my !== gen || !wanted) return;
      var el = nxt;
      if (el === cur) return;
      release(el);
      el.preload = "auto";
      el.volume = 1;
      el.src = streamUrl();

      var settled = false;
      var timer = setTimeout(function () { fail("timeout"); }, 9000);
      function cleanup() { clearTimeout(timer); el.removeEventListener("canplay", ok); el.removeEventListener("error", bad); }
      function ok() {
        if (settled) return; settled = true; cleanup();
        if (my !== gen) { release(el); return; }
        ready(my, el, reason);
      }
      function bad() { fail("error"); }
      function fail(why) {
        if (settled) return; settled = true; cleanup(); release(el);
        if (my !== gen || !wanted) return;
        failures++;
        if (!navigator.onLine) { connecting = false; emit("state", "offline"); return; }
        // A short 404 between tracks is normal; only a long run of failures means this route is blocked
        if (CONFIG.HOSTS.length > 1 && n + 1 >= 8 && (n + 1) % 4 === 0) emit("host", hosts.next());
        emit("retry", { n: n + 1, why: why, reason: reason });
        // Between tracks the mount is gone for under a second: poll quickly for ~2 s, then back off
        var delay = n < 6 ? 300 : Math.min(500 * Math.pow(2, n - 6), 4000);
        setTimeout(function () { attempt(my, reason, n + 1); }, delay);
      }
      el.addEventListener("canplay", ok);
      el.addEventListener("error", bad);
      el.load();
    }

    function ready(my, el, reason) {
      var old = cur;
      var waitForTail = reason === "source-closed" && audible(old);
      if (!waitForTail) { promote(my, el, old); return; }

      // The old connection still has a few seconds buffered: let it play out, then fade.
      held = { my: my, el: el };
      var started = Date.now();
      var endAtStart = bufferedEnd(old);
      holdTimer = setInterval(function () {
        if (!held || held.my !== gen) { clearHold(); return; }
        if (bufferedEnd(old) > endAtStart + 0.75) {
          // False alarm: the old stream is still flowing. Drop the spare connection.
          clearHold(); release(el); connecting = false; resetWatch(); return;
        }
        if (!audible(old) || ahead(old) <= CONFIG.CROSSFADE_MS / 1000 + 0.15 || Date.now() - started > 15000) {
          var h = held; clearHold(); promote(h.my, h.el, old);
        }
      }, 150);
    }

    function promote(my, el, old) {
      if (my !== gen || !wanted) { release(el); return; }
      if (fadeTimer) { clearInterval(fadeTimer); fadeTimer = null; }
      var fade = canFade && audible(old);
      cur = el; nxt = old;
      el.volume = fade ? 0 : 1;
      var p = el.play();
      Promise.resolve(p).then(function () {
        connecting = false;
        failures = 0;
        resetWatch();
        stopKeep();
        if (fade) crossfade(old, el); else release(old);
        emit("state", "live");
        emit("track");
      }).catch(function (err) {
        cur = old; nxt = el; release(el);
        if (err && err.name === "NotAllowedError") { stop(); emit("blocked"); }
        else { connecting = false; connect("error"); }
      });
    }

    function crossfade(from, to) {
      var start = performance.now(), D = CONFIG.CROSSFADE_MS;
      fadeTimer = setInterval(function () {
        var k = clamp((performance.now() - start) / D, 0, 1);
        to.volume = k;
        from.volume = 1 - k;
        if (k >= 1) { clearInterval(fadeTimer); fadeTimer = null; release(from); }
      }, 30);
    }

    function curDown(reason) {
      if (held) { var h = held; clearHold(); promote(h.my, h.el, cur); return; }
      if (connecting) { startKeep(); emit("state", "connecting"); return; }
      connect(reason);
    }

    // Detects a stalled stream, and a source that closed. When the server ends a track the
    // download finishes (networkState goes IDLE) while 1-3 s of audio is still buffered,
    // which is enough time to open the next connection before anything goes quiet.
    // (Chrome only updates the buffered range in ~2 s steps, so it can't be used for this.)
    setInterval(function () {
      if (!wanted || connecting || held || !cur.getAttribute("src") || cur.paused) return;
      var now = Date.now();
      var t = cur.currentTime;
      if (t > lastTime + 0.05) { lastTime = t; lastAdvance = now; }
      else if (now - lastAdvance > 6000) { connect("stall"); return; }
      if (cur.networkState === 1 /* NETWORK_IDLE */ && now - lastGrow > 1500) connect("source-closed");
    }, 300);

    function play() {
      if (wanted) return;
      wanted = true;
      unlock();
      if (!navigator.onLine) { emit("state", "offline"); return; }
      connect("start");
    }

    function stop() {
      wanted = false;
      gen++;
      connecting = false;
      clearHold();
      if (fadeTimer) { clearInterval(fadeTimer); fadeTimer = null; }
      release(cur); release(nxt);
      stopKeep();
      emit("state", "idle");
    }

    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible" && wanted && !connecting && !audible(cur)) connect("resume");
    });
    window.addEventListener("online", function () { if (wanted && !connecting) connect("online"); emit("online"); });
    window.addEventListener("offline", function () { emit("offline"); });

    return {
      on: on,
      play: play,
      stop: stop,
      toggle: function () { if (wanted) stop(); else play(); },
      skip: function () { if (wanted) connect("skip"); },
      isOn: function () { return wanted; }
    };
  })();

  /* ---------------- Front-face UI ---------------- */
  var ui = {
    player: $("player"),
    status: $("status"),
    onair: $("onair"),
    playBtn: $("play-btn"),
    playIcon: $("play-icon"),
    skipBtn: $("skip-btn"),
    badge: $("vote-badge"),
    songCard: $("song-card"),
    songName: $("song-name"),
    artistName: $("artist-name")
  };
  var state = "idle";

  function setStatus(text) { setText(ui.status, text); }

  function setState(next) {
    state = next;
    ui.player.classList.toggle("is-live", next === "live");
    ui.player.classList.toggle("is-connecting", next === "connecting");
    setText(ui.onair, next === "live" ? "On air" : next === "connecting" ? "Tuning" : next === "offline" ? "Offline" : "Off air");
    var playing = next === "live" || next === "connecting";
    ui.playIcon.setAttribute("href", playing ? "#i-pause" : "#i-play");
    ui.playBtn.setAttribute("aria-label", playing ? "Stop" : "Play");
    if ("mediaSession" in navigator) {
      try { navigator.mediaSession.playbackState = playing ? "playing" : "paused"; } catch (e) { /* ignore */ }
    }
    wave.setLive(next === "live");
  }

  engine.on("state", function (s) {
    setState(s);
    if (s === "live") setStatus(hosts.isRelay() ? "Playing live via relay" : "Playing live");
    else if (s === "connecting") setStatus("Tuning in…");
    else if (s === "offline") setStatus("Offline — music resumes when you reconnect");
    else if (s === "idle") setStatus("Ready to play");
  });
  engine.on("connecting", function (reason) {
    if (reason === "skip") setStatus("Skipping…");
    else if (reason === "start") setStatus("Tuning in…");
    if (reason !== "start" && reason !== "skip" && reason !== "source-closed") log.add("warn", "Reconnecting (" + reason + ")");
  });
  engine.on("retry", function (r) {
    if (r.n >= 4 && state !== "live") setStatus(r.reason === "start" || r.reason === "online" || r.reason === "resume" ? "Still connecting…" : "Waiting for the next track…");
    if (r.n === 6) log.add("warn", "Stream not answering yet, still trying");
  });
  engine.on("host", function (h) { setStatus("Trying another route…"); log.add("warn", "Switched to " + hosts.label(h)); });
  engine.on("track", function () { resetVote(); log.add("ok", "Connected via " + hosts.label()); });
  engine.on("blocked", function () { setStatus("Tap play to resume"); });
  engine.on("offline", function () { log.add("error", "Device went offline"); if (!engine.isOn()) setStatus("Offline"); });
  engine.on("online", function () { log.add("ok", "Back online"); if (!engine.isOn()) setStatus("Ready to play"); });

  ui.playBtn.addEventListener("click", function () { engine.toggle(); });

  /* ---------------- Skip voting ---------------- */
  var voting = false;
  var voted = false;

  function resetVote() {
    voted = false;
    ui.skipBtn.setAttribute("aria-pressed", "false");
    ui.badge.hidden = true;
  }

  function markVoted(message) {
    voted = true;
    ui.skipBtn.setAttribute("aria-pressed", "true");
    var m = /(\d+)\s*\/\s*(\d+)/.exec(message || "");
    if (m) { setText(ui.badge, m[1] + "/" + m[2]); ui.badge.hidden = false; }
  }

  function postJSON(url, ms) {
    var ctrl = "AbortController" in window ? new AbortController() : null;
    var t = setTimeout(function () { if (ctrl) ctrl.abort(); }, ms);
    return fetch(url, { method: "POST", cache: "no-store", signal: ctrl ? ctrl.signal : undefined })
      .then(function (res) {
        clearTimeout(t);
        return res.json().catch(function () { return { status: "error", message: "Unexpected reply (" + res.status + ")" }; });
      }, function (err) { clearTimeout(t); throw err; });
  }

  function voteSkip(source) {
    if (voting) return;
    if (!engine.isOn()) { setStatus("Press play to vote"); return; }
    if (voted) { setStatus("You voted — waiting for one more listener"); return; }
    voting = true;
    ui.skipBtn.classList.add("is-busy");
    setStatus("Voting to skip…");

    var order = [hosts.current()].concat(hosts.others());
    var i = 0;
    function tryNext() {
      var host = order[i++];
      return postJSON(host + CONFIG.SKIP_PATH, 7000).catch(function (err) {
        if (i < order.length && navigator.onLine) return tryNext();
        throw err;
      });
    }

    tryNext().then(function (data) {
      setStatus(data.message || "Vote sent");
      if (data.skipped) { resetVote(); engine.skip(); log.add("ok", "Track skipped by listeners"); }
      else if (data.status === "success" || data.status === "ignored") markVoted(data.message);
    }).catch(function () {
      setStatus(navigator.onLine ? "Skip server unreachable" : "You're offline");
      log.add("error", "Skip vote failed" + (source ? " (" + source + ")" : ""));
    }).then(function () {
      voting = false;
      ui.skipBtn.classList.remove("is-busy");
    });
  }

  ui.skipBtn.addEventListener("click", function () { voteSkip("button"); });

  // Swipe left anywhere on the radio face = next track
  (function setupSwipe() {
    var sx = 0, sy = 0, st = 0, active = false;
    ui.player.addEventListener("pointerdown", function (e) {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      if (e.target.closest("button, input, a, label")) return;
      active = true; sx = e.clientX; sy = e.clientY; st = performance.now();
    }, { passive: true });
    ui.player.addEventListener("pointerup", function (e) {
      if (!active) return;
      active = false;
      var dx = e.clientX - sx, dy = e.clientY - sy;
      if (dx < -60 && Math.abs(dy) < 45 && performance.now() - st < 700) {
        if (!perf.isLite()) {
          ui.songCard.classList.add("nudge");
          setTimeout(function () { ui.songCard.classList.remove("nudge"); }, 220);
        }
        voteSkip("swipe");
      }
    }, { passive: true });
    ui.player.addEventListener("pointercancel", function () { active = false; });
  })();

  // Keyboard & hardware keys
  document.addEventListener("keydown", function (e) {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
    var tag = (e.target && e.target.tagName) || "";
    if (/INPUT|TEXTAREA|SELECT/.test(tag) || document.querySelector("dialog[open]")) return;
    if (e.key === "MediaTrackNext" || e.key === "n" || e.key === "N") { e.preventDefault(); voteSkip("key"); }
    else if (e.key === "MediaPlayPause" || (e.key === " " && tag !== "BUTTON") || e.key === "k") { e.preventDefault(); engine.toggle(); }
  });

  // Speakers, headsets, car stereos and the lock-screen notification all go through this
  function setupMediaSession() {
    if (!("mediaSession" in navigator)) return;
    var ms = navigator.mediaSession;
    function set(action, fn) { try { ms.setActionHandler(action, fn); } catch (e) { /* unsupported action */ } }
    set("play", function () { engine.play(); });
    set("pause", function () { engine.stop(); });
    set("stop", function () { engine.stop(); });
    set("nexttrack", function () { voteSkip("headset"); });
    set("previoustrack", null);
    set("seekbackward", null);
    set("seekforward", null);
    set("seekto", null);
    updateMeta(ui.songName.textContent, ui.artistName.textContent);
  }
  function updateMeta(title, artist) {
    if (!("mediaSession" in navigator) || !window.MediaMetadata) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: title, artist: artist, album: "Raadio",
        artwork: [
          { src: "icons/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icons/icon-512.png", sizes: "512x512", type: "image/png" }
        ]
      });
    } catch (e) { /* ignore */ }
  }

  // Optional: live title from the backend
  function setupNowPlaying() {
    if (!CONFIG.NOW_PLAYING_PATH) return;
    var lastTitle = "";
    function poll() {
      if (!engine.isOn() || document.hidden) return;
      fetch(hosts.current() + CONFIG.NOW_PLAYING_PATH, { cache: "no-store" })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) {
          if (!d || !d.title || d.title === lastTitle) return;
          lastTitle = d.title;
          setText(ui.songName, d.title);
          setText(ui.artistName, d.artist || "Live stream");
          updateMeta(d.title, d.artist || "Raadio");
        }).catch(function () { /* ignore */ });
    }
    setInterval(poll, CONFIG.NOW_PLAYING_EVERY_MS);
    engine.on("track", function () { setTimeout(poll, 1500); });
  }

  /* ---------------- Wave ---------------- */
  var wave = (function () {
    var c = $("wave"), ctx = c.getContext("2d");
    var w = 1, h = 1, dpr = 1, live = false, raf = 0, last = 0;
    var colOn = "#c4a35a", colOff = "rgba(92,87,78,0.22)";
    var round = typeof ctx.roundRect === "function";

    function size() {
      var r = c.getBoundingClientRect();
      dpr = Math.min(window.devicePixelRatio || 1, perf.isLite() ? 1 : 2);
      w = Math.max(1, Math.round(r.width * dpr));
      h = Math.max(1, Math.round(r.height * dpr));
      c.width = w; c.height = h;
      draw(performance.now());
    }
    function draw(t) {
      ctx.clearRect(0, 0, w, h);
      var bars = w / dpr < 260 ? 26 : 38;
      var gap = Math.max(2 * dpr, w * 0.01);
      var bw = (w - gap * (bars - 1)) / bars;
      var s = t * 0.001;
      ctx.fillStyle = live ? colOn : colOff;
      ctx.beginPath();
      for (var i = 0; i < bars; i++) {
        var n = live
          ? Math.sin(i * 0.37 + s * 2.1) * 0.28 + Math.sin(i * 0.13 + s * 1.15) * 0.22 + 0.42
          : 0.2 + 0.05 * Math.sin(i * 0.9);
        var bh = Math.max(h * 0.14, n * h * 0.92);
        var x = i * (bw + gap), y = (h - bh) / 2;
        if (round) ctx.roundRect(x, y, bw, bh, bw / 2); else ctx.rect(x, y, bw, bh);
      }
      ctx.fill();
    }
    function loop(t) {
      raf = 0;
      if (!live || document.hidden) return;
      var interval = perf.isLite() || perf.reducedMotion ? 1000 / 12 : 1000 / 30;
      if (t - last >= interval) { last = t; draw(t); }
      raf = requestAnimationFrame(loop);
    }
    function kick() { if (!raf && live && !document.hidden) raf = requestAnimationFrame(loop); }

    document.addEventListener("visibilitychange", kick);
    if ("ResizeObserver" in window) new ResizeObserver(size).observe(c);
    else window.addEventListener("resize", size);
    perf.onChange(size);

    return {
      init: size,
      setLive: function (on) { if (on === live) return; live = on; if (!on) draw(0); kick(); },
      refreshColors: function () {
        var cs = getComputedStyle(document.body);
        colOn = cs.getPropertyValue("--gold").trim() || colOn;
        colOff = cs.getPropertyValue("--wave-off").trim() || colOff;
        draw(performance.now());
      }
    };
  })();

  /* ---------------- Ambient (Three.js, loaded only when the device can afford it) ---------------- */
  var ambient = (function () {
    var running = false, stopFn = null;
    function load() {
      if (perf.isLite() || perf.reducedMotion || window.THREE) return;
      var s = document.createElement("script");
      // r159 is the last release that ships the classic build/three.min.js (r160 removed it)
      s.src = "https://cdn.jsdelivr.net/npm/three@0.159.0/build/three.min.js";
      s.async = true;
      s.onload = start;
      document.head.appendChild(s);
    }
    function start() {
      if (!window.THREE || perf.isLite() || running) return;
      var THREE = window.THREE;
      var canvas = $("ambient");
      var renderer;
      try { renderer = new THREE.WebGLRenderer({ canvas: canvas, alpha: true, antialias: false, powerPreference: "low-power" }); }
      catch (e) { return; }
      running = true;
      renderer.setPixelRatio(1);
      renderer.setClearColor(0x000000, 0);
      var scene = new THREE.Scene();
      var camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
      camera.position.set(0, 0, 12);

      var count = 90, pos = new Float32Array(count * 3);
      for (var i = 0; i < count; i++) {
        pos[i * 3] = (Math.random() - 0.5) * 24;
        pos[i * 3 + 1] = (Math.random() - 0.5) * 24;
        pos[i * 3 + 2] = (Math.random() - 0.5) * 16 - 4;
      }
      var geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      var points = new THREE.Points(geo, new THREE.PointsMaterial({ color: 0xc4a35a, size: 0.06, transparent: true, opacity: 0.5, depthWrite: false }));
      scene.add(points);

      var grid = new THREE.Mesh(new THREE.PlaneGeometry(32, 32, 20, 20),
        new THREE.MeshBasicMaterial({ color: 0xc4a35a, wireframe: true, transparent: true, opacity: 0.1 }));
      grid.rotation.x = -Math.PI / 2.2; grid.position.set(0, -4, -6);
      scene.add(grid);

      var shapes = [];
      for (var j = 0; j < 6; j++) {
        var mesh = new THREE.Mesh(new THREE.IcosahedronGeometry(Math.random() * 0.5 + 0.3, 0),
          new THREE.MeshBasicMaterial({ color: 0xc4a35a, wireframe: true, transparent: true, opacity: 0.14 }));
        mesh.position.set((Math.random() - 0.5) * 18, (Math.random() - 0.5) * 18, (Math.random() - 0.5) * 8 - 2);
        shapes.push({ mesh: mesh, speed: (Math.random() - 0.5) * 0.02 });
        scene.add(mesh);
      }

      function resize() {
        renderer.setSize(window.innerWidth, window.innerHeight, false);
        camera.aspect = window.innerWidth / Math.max(window.innerHeight, 1);
        camera.updateProjectionMatrix();
      }
      var raf = 0, last = 0;
      function tick(ts) {
        raf = 0;
        if (!running || document.hidden) return;
        raf = requestAnimationFrame(tick);
        if (ts - last < 33) return;                 // ~30 fps is plenty for a backdrop
        last = ts;
        var t = ts * 0.0001;
        points.rotation.y = t * 0.3;
        grid.position.y = -4 + Math.sin(t * 1.2) * 0.5;
        for (var k = 0; k < shapes.length; k++) { shapes[k].mesh.rotation.x += shapes[k].speed; shapes[k].mesh.rotation.y += shapes[k].speed * 0.7; }
        renderer.render(scene, camera);
      }
      function wake() { if (running && !raf && !document.hidden) raf = requestAnimationFrame(tick); }
      window.addEventListener("resize", resize);
      document.addEventListener("visibilitychange", wake);
      resize(); wake();
      stopFn = function () { running = false; if (raf) cancelAnimationFrame(raf); raf = 0; try { renderer.dispose(); } catch (e) { /* ignore */ } };
    }
    perf.onChange(function (lite) { if (lite && stopFn) { stopFn(); stopFn = null; } });
    return { load: load };
  })();

  /* ---------------- Mock backend (studio is front-end only for now) ---------------- */
  var mock = {
    login: function (user, pass) {
      return sleep(500).then(function () {
        if (!user.trim()) throw new Error("Enter a username");
        if (pass.length < 4) throw new Error("Password needs at least 4 characters");
        return { user: user.trim(), token: uid(), at: Date.now() };
      });
    },
    upload: function (file, onProgress) {
      var p = 0;
      return new Promise(function (resolve) {
        var t = setInterval(function () {
          p = Math.min(1, p + 0.08 + Math.random() * 0.08);
          onProgress(p);
          if (p >= 1) { clearInterval(t); resolve({ id: uid(), name: file.name, size: file.size }); }
        }, 140);
      });
    },
    save: function () { return sleep(180); }
  };

  /* ---------------- Schedules ---------------- */
  var schedules = (function () {
    var KEY = "raadio.schedules.v1";
    var items = store.get(KEY, []);
    if (!Array.isArray(items)) items = [];
    var listeners = [];
    function persist() { store.set(KEY, items); listeners.forEach(function (fn) { fn(); }); }
    return {
      all: function () { return items.slice(); },
      get: function (id) { for (var i = 0; i < items.length; i++) if (items[i].id === id) return items[i]; return null; },
      add: function (item) { items.push(item); persist(); },
      update: function (id, patch) { var it = this.get(id); if (it) { Object.assign(it, patch); persist(); } },
      remove: function (id) { items = items.filter(function (it) { return it.id !== id; }); persist(); },
      onChange: function (fn) { listeners.push(fn); }
    };
  })();

  // Next time an item airs, honouring weekly repeat days (0 = Sunday)
  function nextAir(item, from) {
    from = from || new Date();
    var start = new Date(item.startsAt);
    if (isNaN(start.getTime())) return null;
    if (!item.days || !item.days.length) return start >= from ? start : null;
    var base = new Date(Math.max(from.getTime(), start.getTime()));
    for (var i = 0; i < 8; i++) {
      var d = new Date(base);
      d.setDate(base.getDate() + i);
      d.setHours(start.getHours(), start.getMinutes(), 0, 0);
      if (item.days.indexOf(d.getDay()) !== -1 && d >= from && d >= start) return d;
    }
    return null;
  }

  /* ---------------- "Coming up" on the black dashboard ---------------- */
  var news = (function () {
    var el = $("news-list");
    var lastKey = "";
    function render() {
      var now = new Date();
      var rows = [];
      schedules.all().forEach(function (it) {
        var at = nextAir(it, now);
        if (at) rows.push({ at: at, text: it.name + (it.repeat > 1 ? " ×" + it.repeat : "") });
      });
      CONFIG.ANNOUNCEMENTS.forEach(function (a) {
        var at = new Date(a.at);
        if (!isNaN(at.getTime()) && at >= now) rows.push({ at: at, text: a.text });
      });
      rows.sort(function (a, b) { return a.at - b.at; });
      rows = rows.slice(0, 3);

      var key = rows.map(function (r) { return r.at.getTime() + r.text; }).join("|");
      if (key === lastKey && el.childNodes.length) return;
      lastKey = key;

      var frag = document.createDocumentFragment();
      if (!rows.length) {
        var li = document.createElement("li");
        li.className = "news-empty";
        li.textContent = "Nothing scheduled yet";
        frag.appendChild(li);
      }
      rows.forEach(function (r) {
        var li = document.createElement("li");
        var t = document.createElement("time");
        t.className = "news-time";
        t.dateTime = r.at.toISOString();
        t.textContent = fmtSoon(r.at);
        t.title = fmtFull(r.at);
        var s = document.createElement("span");
        s.className = "news-text";
        s.textContent = r.text;
        li.appendChild(t); li.appendChild(s);
        frag.appendChild(li);
      });
      el.replaceChildren(frag);
    }
    schedules.onChange(render);
    setInterval(render, 60000);
    return { render: render };
  })();

  /* ---------------- Dialog helpers ---------------- */
  function openDialog(d) {
    if (typeof d.showModal === "function") { if (!d.open) d.showModal(); }
    else d.setAttribute("open", "");
  }
  function closeDialog(d) {
    if (typeof d.close === "function") { if (d.open) d.close(); }
    else d.removeAttribute("open");
  }
  Array.prototype.forEach.call(document.querySelectorAll("dialog"), function (d) {
    d.addEventListener("click", function (e) {
      if (e.target.closest("[data-close]")) { closeDialog(d); return; }
      if (e.target !== d) return;
      var r = d.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) closeDialog(d);
    });
  });

  /* ---------------- Auth + flip ---------------- */
  var flipEl = $("flip");
  var front = $("player"), back = $("studio");
  var authBtn = $("auth-btn"), authIcon = $("auth-icon");
  var session = store.get("raadio.session", null);
  var flipped = false, turning = false;

  function updateAuthButton() {
    authIcon.setAttribute("href", session ? "#i-user" : "#i-login");
    authBtn.setAttribute("aria-label", session ? "Open my studio" : "Log in");
    setText($("greeting"), session ? "Welcome back, " + session.user : "");
  }

  function setInert(el, on) {
    if (on) { el.setAttribute("inert", ""); el.setAttribute("aria-hidden", "true"); }
    else { el.removeAttribute("inert"); el.removeAttribute("aria-hidden"); }
  }

  function flip(toBack) {
    if (toBack === flipped || turning) return;
    function finish() {
      flipped = toBack;
      setInert(front, toBack);
      setInert(back, !toBack);
      log.show(toBack);
      if (toBack) { back.scrollTop = 0; studio.opened(); }
      var target = toBack ? $("back-btn") : authBtn;
      try { target.focus({ preventScroll: true }); } catch (e) { target.focus(); }
    }
    if (perf.isLite()) {
      turning = true;
      flipEl.classList.add("is-turning");
      setTimeout(function () {
        flipEl.classList.toggle("is-flipped", toBack);
        flipEl.classList.remove("is-turning");
        turning = false;
        finish();
      }, 170);
    } else {
      flipEl.classList.toggle("is-flipped", toBack);
      finish();
    }
  }

  authBtn.addEventListener("click", function () {
    if (session) { flip(true); return; }
    $("login-error").hidden = true;
    openDialog($("login-dialog"));
    setTimeout(function () { $("username").focus(); }, 30);
  });
  $("back-btn").addEventListener("click", function () { flip(false); });

  $("login-form").addEventListener("submit", function (e) {
    e.preventDefault();
    var btn = $("login-submit"), err = $("login-error");
    btn.disabled = true;
    setText(btn, "Logging in…");
    err.hidden = true;
    mock.login($("username").value, $("password").value).then(function (s) {
      session = s;
      store.set("raadio.session", { user: s.user, token: s.token, at: s.at });
      $("password").value = "";
      updateAuthButton();
      closeDialog($("login-dialog"));
      log.add("ok", "Signed in as " + s.user);
      flip(true);
    }).catch(function (ex) {
      setText(err, ex.message || "Login failed");
      err.hidden = false;
    }).then(function () {
      btn.disabled = false;
      setText(btn, "Log in");
    });
  });

  $("logout-btn").addEventListener("click", function () {
    session = null;
    store.del("raadio.session");
    updateAuthButton();
    flip(false);
  });

  /* ---------------- Studio ---------------- */
  var studio = (function () {
    var fileInput = $("audio-upload"), fileLabel = $("file-label");
    var uploadTime = $("upload-time"), uploadBtn = $("upload-btn");
    var progress = $("upload-progress"), progressBar = progress.querySelector("i");
    var recBtn = $("record-btn"), recIcon = $("record-icon"), recLabel = $("record-label"), recTime = $("record-time");
    var recResult = $("record-result"), recPreview = $("record-preview"), recTimeInput = $("record-time-input");
    var recScheduleBtn = $("record-schedule-btn");
    var countPill = $("schedule-count");
    var chosen = null;

    function refreshCount() { setText(countPill, String(schedules.all().length)); }
    schedules.onChange(refreshCount);

    function validTime(input) {
      var d = fromLocalInput(input.value);
      if (!d) { input.focus(); return null; }
      if (d.getTime() < Date.now() - 60000) { log.add("error", "Pick a time in the future"); input.focus(); return null; }
      return d;
    }

    /* A. Upload */
    fileInput.addEventListener("change", function () {
      chosen = fileInput.files && fileInput.files[0] || null;
      if (chosen && !/^audio\//.test(chosen.type) && !/\.(mp3|m4a|aac|ogg|opus|wav|flac|webm)$/i.test(chosen.name)) {
        log.add("error", "That file isn't audio");
        chosen = null;
      } else if (chosen && chosen.size > CONFIG.UPLOAD_MAX_MB * 1048576) {
        log.add("error", "File is over " + CONFIG.UPLOAD_MAX_MB + " MB");
        chosen = null;
      }
      setText(fileLabel, chosen ? chosen.name : "Choose an audio file");
      uploadBtn.disabled = !chosen;
    });

    uploadBtn.addEventListener("click", function () {
      if (!chosen) return;
      var at = validTime(uploadTime);
      if (!at) return;
      var file = chosen;
      uploadBtn.disabled = true;
      progress.hidden = false;
      progressBar.style.transform = "scaleX(0)";
      mock.upload(file, function (p) { progressBar.style.transform = "scaleX(" + p.toFixed(3) + ")"; })
        .then(function (res) {
          schedules.add({ id: res.id, name: file.name.replace(/\.[a-z0-9]+$/i, ""), kind: "upload", startsAt: at.toISOString(), repeat: 1, days: [] });
          log.add("ok", "Uploaded “" + file.name + "”, airs " + fmtFull(at));
          chosen = null;
          fileInput.value = "";
          setText(fileLabel, "Choose an audio file");
          setTimeout(function () { progress.hidden = true; }, 400);
        });
    });

    /* B. Record */
    var rec = null, recStream = null, chunks = [], recStart = 0, recTimer = 0, recUrl = "", recBlob = null;
    var canRecord = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);
    if (!canRecord) { recBtn.disabled = true; setText(recLabel, "Recording not supported here"); }

    function pickMime() {
      var types = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
      for (var i = 0; i < types.length; i++) if (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(types[i])) return types[i];
      return "";
    }
    function tickRec() {
      var s = Math.floor((Date.now() - recStart) / 1000);
      setText(recTime, String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0"));
      if (Date.now() - recStart >= CONFIG.RECORD_MAX_MS) stopRec();
    }
    function stopRec() { if (rec && rec.state !== "inactive") rec.stop(); }

    recBtn.addEventListener("click", function () {
      if (rec && rec.state === "recording") { stopRec(); return; }
      navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }).then(function (stream) {
        recStream = stream;
        var mime = pickMime();
        rec = mime ? new MediaRecorder(stream, { mimeType: mime, audioBitsPerSecond: 96000 }) : new MediaRecorder(stream);
        chunks = [];
        rec.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
        rec.onstop = function () {
          clearInterval(recTimer);
          recStream.getTracks().forEach(function (t) { t.stop(); });   // turn the mic off
          recBlob = new Blob(chunks, { type: rec.mimeType || "audio/webm" });
          if (recUrl) URL.revokeObjectURL(recUrl);
          recUrl = URL.createObjectURL(recBlob);
          recPreview.src = recUrl;
          recResult.hidden = false;
          recBtn.setAttribute("aria-pressed", "false");
          recIcon.setAttribute("href", "#i-mic");
          setText(recLabel, "Record again");
          recTime.hidden = true;
          log.add("ok", "Recording ready (" + recTime.textContent + ")");
        };
        rec.start(1000);
        recStart = Date.now();
        setText(recTime, "00:00");
        recTime.hidden = false;
        recTimer = setInterval(tickRec, 1000);
        recBtn.setAttribute("aria-pressed", "true");
        recIcon.setAttribute("href", "#i-stop");
        setText(recLabel, "Stop");
      }).catch(function () {
        log.add("error", "Microphone access denied");
      });
    });

    recScheduleBtn.addEventListener("click", function () {
      if (!recBlob) return;
      var at = validTime(recTimeInput);
      if (!at) return;
      recScheduleBtn.disabled = true;
      mock.upload({ name: "recording", size: recBlob.size }, function () {}).then(function (res) {
        var name = "Recording " + fmt(new Date(), { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
        schedules.add({ id: res.id, name: name, kind: "recording", startsAt: at.toISOString(), repeat: 1, days: [] });
        log.add("ok", name + " airs " + fmtFull(at));
        recScheduleBtn.disabled = false;
        recResult.hidden = true;
        setText(recLabel, "Start recording");
      });
    });

    /* D. Calendar */
    var calDialog = $("calendar-dialog"), calList = $("calendar-list"), tpl = $("cal-item-tpl");
    var dayOrder = [1, 2, 3, 4, 5, 6, 0];
    var dayNames = dayOrder.map(function (d) {
      var ref = new Date(2024, 0, 7 + d);     // 7 Jan 2024 was a Sunday
      return fmt(ref, { weekday: "short" });
    });

    function describe(it) {
      var at = nextAir(it);
      var parts = [];
      parts.push(at ? "Next: " + fmtFull(at) : "No upcoming air time");
      if (it.repeat > 1) parts.push("plays ×" + it.repeat);
      return parts.join(" · ");
    }

    function renderCalendar() {
      var items = schedules.all().sort(function (a, b) {
        var na = nextAir(a), nb = nextAir(b);
        return (na ? na.getTime() : Infinity) - (nb ? nb.getTime() : Infinity);
      });
      var frag = document.createDocumentFragment();
      if (!items.length) {
        var p = document.createElement("p");
        p.className = "cal-empty";
        p.textContent = "Nothing scheduled. Upload or record something first.";
        frag.appendChild(p);
      }
      items.forEach(function (it) {
        var node = tpl.content.firstElementChild.cloneNode(true);
        node.dataset.id = it.id;
        node.querySelector(".cal-name").textContent = it.name;
        node.querySelector(".kind-pill").textContent = it.kind === "recording" ? "Recording" : "Upload";
        node.querySelector(".cal-next").textContent = describe(it);
        node.querySelector(".cal-time").value = toLocalInput(new Date(it.startsAt));
        node.querySelector(".cal-repeat").value = it.repeat || 1;
        var chips = node.querySelector(".day-chips");
        dayOrder.forEach(function (d, i) {
          var label = document.createElement("label");
          label.className = "day-chip";
          var input = document.createElement("input");
          input.type = "checkbox";
          input.value = String(d);
          input.checked = (it.days || []).indexOf(d) !== -1;
          input.setAttribute("aria-label", dayNames[i]);
          var span = document.createElement("span");
          span.textContent = dayNames[i];
          label.appendChild(input); label.appendChild(span);
          chips.appendChild(label);
        });
        frag.appendChild(node);
      });
      calList.replaceChildren(frag);
    }

    calList.addEventListener("click", function (e) {
      var card = e.target.closest(".cal-item");
      if (!card) return;
      var id = card.dataset.id;
      if (e.target.closest(".cal-save")) {
        var d = fromLocalInput(card.querySelector(".cal-time").value);
        if (!d) { card.querySelector(".cal-time").focus(); return; }
        var repeat = clamp(parseInt(card.querySelector(".cal-repeat").value, 10) || 1, 1, 50);
        var days = Array.prototype.map.call(card.querySelectorAll(".day-chip input:checked"), function (i) { return +i.value; });
        var save = card.querySelector(".cal-save");
        save.disabled = true;
        mock.save().then(function () {
          schedules.update(id, { startsAt: d.toISOString(), repeat: repeat, days: days });
          card.querySelector(".cal-repeat").value = repeat;
          card.querySelector(".cal-next").textContent = describe(schedules.get(id));
          save.disabled = false;
          setText(save, "Saved");
          setTimeout(function () { setText(save, "Save"); }, 1200);
          log.add("ok", "Schedule updated");
        });
      } else if (e.target.closest(".cal-delete")) {
        var del = card.querySelector(".cal-delete");
        if (!del.classList.contains("confirm")) {
          del.classList.add("confirm");
          del.setAttribute("aria-label", "Tap again to delete");
          setTimeout(function () { del.classList.remove("confirm"); del.setAttribute("aria-label", "Delete"); }, 2500);
          return;
        }
        schedules.remove(id);
        renderCalendar();
        log.add("ok", "Removed from schedule");
      }
    });

    $("calendar-btn").addEventListener("click", function () {
      renderCalendar();
      openDialog(calDialog);
    });

    function setDefaults() {
      var d = toLocalInput(defaultAirTime());
      if (!uploadTime.value) uploadTime.value = d;
      if (!recTimeInput.value) recTimeInput.value = d;
      var min = toLocalInput(new Date());
      uploadTime.min = min;
      recTimeInput.min = min;
    }

    refreshCount();
    return {
      opened: function () { setDefaults(); refreshCount(); }
    };
  })();

  /* ---------------- PWA ---------------- */
  function registerSW() {
    if (!("serviceWorker" in navigator)) return;
    if (location.protocol !== "https:" && location.hostname !== "localhost" && location.hostname !== "127.0.0.1") return;
    window.addEventListener("load", function () {
      navigator.serviceWorker.register("sw.js").catch(function () { /* offline support unavailable */ });
    });
  }

  /* ---------------- Init ---------------- */
  Array.prototype.forEach.call(document.querySelectorAll("[data-tz]"), function (el) { el.textContent = tzLabel(); });
  wave.init();
  applyTheme();
  setInterval(applyTheme, 60000);
  updateAuthButton();
  news.render();
  setState("idle");
  setupMediaSession();
  setupNowPlaying();
  registerSW();
  log.add("ok", "Studio ready — demo mode, uploads stay on this device");
  if (!navigator.onLine) { setState("offline"); setStatus("Offline — music resumes when you reconnect"); }
  hosts.pick();
  perf.refine();
  onIdle(function () { ambient.load(); perf.probe(); });
})();
