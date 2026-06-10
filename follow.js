// ================================================================
// follow.js  —  Max [js follow.js] object   (Phase 4: playback follow)
// RESTORED single-bar version (the one that worked).
// Shows the bar currently under the playhead on THIS device's track,
// auto-advancing bar by bar. Driven by an external [metro] while a
// "Follow" toggle is on. Output -> jweb inlet 0.
//
// Wiring:  [live.toggle] -> [metro 50] -> [js follow.js] -> [jweb]
//          (also: [live.toggle] -> [js follow.js]  to set on/off)
// Meters are read passively from the playhead (no transport movement).
// Most accurate when playing through a clip from (at or before) its start.
// ================================================================

autowatch = 1;
inlets  = 1;
outlets = 1;

var enabled    = true;
var song       = null;
var track      = null;

var lastClipId = -1;
var clipStart  = 0;
var clipLen    = 0;
var notes      = [];

var barStartRel = 0;
var curMeter    = { n: 4, d: 4 };
var lastKey     = "";

function num(v) { return parseFloat("" + v); }
function barBeats(m) { var b = m.n * 4 / m.d; return b > 0 ? b : 4; }

// "follow 1" / "follow 0"
function follow(on) { enabled = (on != 0); if (!enabled) lastKey = ""; }
function msg_int(i) { enabled = (i != 0); if (!enabled) lastKey = ""; }
function bang()     { if (enabled) poll(); }

function getOwnTrack() {
    try { return new LiveAPI("this_device canonical_parent"); }
    catch (e) { post("follow: track err " + e + "\n"); return null; }
}

function clipIdsOfTrack(tr) {
    var raw = tr.get("arrangement_clips");
    var ids = [];
    for (var i = 0; i < raw.length; i++) {
        if (raw[i] == "id" && i + 1 < raw.length) ids.push(parseInt(raw[i+1], 10));
    }
    return ids;
}

function loadClip(id) {
    var c = new LiveAPI("id " + id);
    clipStart = num(c.get("start_time"));
    clipLen   = num(c.get("length"));
    if (isNaN(clipStart)) clipStart = 0;
    if (isNaN(clipLen) || clipLen <= 0) clipLen = 4;

    notes = [];
    try {
        var r = c.call("get_notes_extended", 0, 128, 0, clipLen + 0.001);
        var obj = JSON.parse(r);
        if (obj && obj.notes) {
            for (var i = 0; i < obj.notes.length; i++) {
                var nt = obj.notes[i];
                notes.push({ st: num(nt.start_time), dur: num(nt.duration), pitch: parseInt(nt.pitch, 10) });
            }
        }
    } catch (e) { post("follow: get_notes err " + e + "\n"); }

    lastClipId  = id;
    barStartRel = 0;
    curMeter    = readMeter();
    lastKey     = "";
}

function readMeter() {
    var n = parseInt(num(song.get("signature_numerator")), 10);
    var d = parseInt(num(song.get("signature_denominator")), 10);
    if (!n || !d) { n = 4; d = 4; }
    return { n: n, d: d };
}

function poll() {
    if (!song)  song  = new LiveAPI("live_set");
    if (!track) track = getOwnTrack();
    if (!track) return;

    var t = num(song.get("current_song_time"));

    var ids = clipIdsOfTrack(track);
    var foundId = -1;
    for (var i = 0; i < ids.length; i++) {
        var c = new LiveAPI("id " + ids[i]);
        var s = num(c.get("start_time"));
        var l = num(c.get("length"));
        if (!isNaN(s) && !isNaN(l) && t >= s - 1e-6 && t < s + l - 1e-6) {
            foundId = ids[i]; break;
        }
    }
    if (foundId < 0) { return; }

    if (foundId !== lastClipId) loadClip(foundId);

    var clipRelT = t - clipStart;
    if (clipRelT < barStartRel - 1e-6) {
        barStartRel = 0; curMeter = readMeter();
    }
    var guard = 0;
    while (clipRelT >= barStartRel + barBeats(curMeter) - 1e-6 && guard < 4096) {
        barStartRel += barBeats(curMeter);
        curMeter = readMeter();
        guard++;
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
        if (nt.st >= s - 1e-6 && nt.st < e - 1e-6) {
            out.push({ start_time: nt.st - s, duration: nt.dur, pitch: nt.pitch });
        }
    }
    outlet(0, "meters", curMeter.n, curMeter.d);
    outlet(0, "clip_data", JSON.stringify({ notes: out }));
}
