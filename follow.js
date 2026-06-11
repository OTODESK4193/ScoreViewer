// ================================================================
// follow.js  —  Max [js follow.js]   (v1.2 — light: plays-only + cache)
// Single-bar playback follower for THIS device's own track.
// Driven by [metro] while a "Follow" toggle is on, but it now does
// real work ONLY while the transport is playing. When stopped it
// returns immediately (one cheap read), so editing clips stays snappy.
// It NEVER moves the playhead (meters are read passively).
//
// Wiring:  [live.toggle] -> [metro 80] -> [js follow.js] -> [jweb]
//          (also: [live.toggle] -> [js follow.js])
// ================================================================

autowatch = 1;
inlets  = 1;
outlets = 1;

var enabled    = true;
var song       = null;
var track      = null;

var clipList   = null;   // cached [{id,start,len}] for this track (built lazily)
var lastClipId = -1;
var clipStart  = 0;
var notes      = [];

var barStartRel = 0;
var curMeter    = { n: 4, d: 4 };
var lastKey     = "";

function num(v) { return parseFloat("" + v); }
function barBeats(m) { var b = m.n * 4 / m.d; return b > 0 ? b : 4; }

function follow(on) { enabled = (on != 0); if (!enabled) lastKey = ""; }
function msg_int(i) { enabled = (i != 0); if (!enabled) lastKey = ""; }
function bang()     { poll(); }

function getOwnTrack() {
    try { return new LiveAPI("this_device canonical_parent"); }
    catch (e) { post("follow: track err " + e + "\n"); return null; }
}

// enumerate the track's arrangement clips ONCE and cache start/len
function buildClipList() {
    clipList = [];
    if (!track) return;
    var raw = track.get("arrangement_clips");
    if (!raw) return;
    for (var i = 0; i < raw.length; i++) {
        if (raw[i] == "id" && i + 1 < raw.length) {
            var id = parseInt(raw[i+1], 10);
            var c = new LiveAPI("id " + id);
            var s = num(c.get("start_time")), l = num(c.get("length"));
            if (!isNaN(s) && !isNaN(l)) clipList.push({ id: id, start: s, len: l });
        }
    }
}

function findClip(t) {
    if (!clipList) buildClipList();
    for (var pass = 0; pass < 2; pass++) {
        for (var i = 0; i < clipList.length; i++) {
            var c = clipList[i];
            if (t >= c.start - 1e-6 && t < c.start + c.len - 1e-6) return c;
        }
        buildClipList();   // not found -> refresh once (clips may have changed) and retry
    }
    return null;
}

function loadClip(c) {
    clipStart = c.start;
    notes = [];
    try {
        var api = new LiveAPI("id " + c.id);
        var r = api.call("get_notes_extended", 0, 128, 0, c.len + 0.001);
        var obj = JSON.parse(r);
        if (obj && obj.notes)
            for (var i = 0; i < obj.notes.length; i++) {
                var nt = obj.notes[i];
                notes.push({ st: num(nt.start_time), dur: num(nt.duration), pitch: parseInt(nt.pitch, 10) });
            }
    } catch (e) { post("follow: get_notes err " + e + "\n"); }
    lastClipId = c.id; barStartRel = 0; curMeter = readMeter(); lastKey = "";
}

function readMeter() {
    var n = parseInt(num(song.get("signature_numerator")), 10);
    var d = parseInt(num(song.get("signature_denominator")), 10);
    if (!n || !d) { n = 4; d = 4; }
    return { n: n, d: d };
}

function poll() {
    if (!enabled) return;
    if (!song) song = new LiveAPI("live_set");
    // CHEAP GATE: do nothing unless the transport is actually playing.
    if (parseInt(num(song.get("is_playing")), 10) !== 1) return;

    if (!track) { track = getOwnTrack(); clipList = null; }
    if (!track) return;

    var t = num(song.get("current_song_time"));
    var c = findClip(t);
    if (!c) return;

    if (c.id !== lastClipId) loadClip(c);

    var clipRelT = t - clipStart;
    if (clipRelT < barStartRel - 1e-6) { barStartRel = 0; curMeter = readMeter(); }
    var guard = 0;
    while (clipRelT >= barStartRel + barBeats(curMeter) - 1e-6 && guard < 4096) {
        barStartRel += barBeats(curMeter); curMeter = readMeter(); guard++;
    }
    emitBar();
}

function emitBar() {
    var s = barStartRel, e = barStartRel + barBeats(curMeter);
    var key = lastClipId + ":" + s.toFixed(3) + ":" + curMeter.n + "/" + curMeter.d;
    if (key === lastKey) return;
    lastKey = key;
    var out = [];
    for (var i = 0; i < notes.length; i++) {
        var nt = notes[i];
        if (nt.st >= s - 1e-6 && nt.st < e - 1e-6)
            out.push({ start_time: nt.st - s, duration: nt.dur, pitch: nt.pitch });
    }
    outlet(0, "meters", curMeter.n, curMeter.d);
    outlet(0, "clip_data", JSON.stringify({ notes: out }));
}

// force a fresh clip-list lookup (e.g. after editing the arrangement)
function rescan() { clipList = null; lastClipId = -1; lastKey = ""; }
