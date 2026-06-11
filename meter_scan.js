// ================================================================
// meter_scan.js  —  Max [js meter_scan.js]   (v3, cached)
// Scans the selected clip's per-bar time signatures and outputs:
//     meters <n1> <d1> <n2> <d2> ...
//
// CACHE: each clip is scanned only ONCE (keyed by clip id). Selecting
// the same clip again, or editing its notes, replays the cached result
// instantly WITHOUT moving the playhead. So you can wire this to fire
// automatically on clip selection without slowing down editing.
//
// Messages:
//   bang        -> scan if not cached, else replay cache (cheap)
//   "rescan"    -> clear this clip's cache and scan fresh (use after
//                  changing a clip's time signature)
//   "clearall"  -> forget all cached clips
//
// A scan briefly moves the playhead (the ONLY time it does) and then
// restores it. This happens only the first time you select a clip.
// ================================================================

autowatch = 1;
inlets  = 1;
outlets = 1;

var STEP_MS  = 50;
var MAX_BARS = 1024;

var meterCache = {};            // clipId -> [n,d,n,d,...]
var song = null;
var meters = [], savedTime = 0;
var busy = false, runId = 0, task = null;
var st = null, curClipId = -1;

function num(v) { return parseFloat("" + v); }

function bang()     { run(false); }
function msg_int()  { run(false); }
function rescan()   { run(true); }
function clearall() { meterCache = {}; post("meter_scan: cache cleared\n"); }

function run(force) {
    song = new LiveAPI("live_set");
    var clip = new LiveAPI("live_set view detail_clip");
    if (!clip || clip.id == 0) { return; }
    curClipId = clip.id;

    if (!force && meterCache[curClipId]) {           // cache hit -> no playhead move
        outlet(0, "meters", meterCache[curClipId].slice());
        return;
    }

    if (busy) return;                                // a scan is already running
    busy = true; runId++;
    savedTime = num(song.get("current_song_time"));

    var clipStart = num(clip.get("start_time"));
    var clipLen   = num(clip.get("length"));
    if (isNaN(clipStart)) clipStart = 0;
    if (isNaN(clipLen) || clipLen <= 0) clipLen = 4;

    meters = [];
    st = { pos: clipStart, covered: 0, len: clipLen };
    step(runId);
}

function step(my) {
    if (my !== runId || !busy) return;
    if (st.covered >= st.len - 0.0001 || meters.length / 2 >= MAX_BARS) { finish(my); return; }
    song.set("current_song_time", st.pos);
    task = new Task(function(){ read(my); }, this);
    task.schedule(STEP_MS);
}

function read(my) {
    if (my !== runId || !busy) return;
    var n = parseInt(num(song.get("signature_numerator")), 10);
    var d = parseInt(num(song.get("signature_denominator")), 10);
    if (!n || !d) { n = 4; d = 4; }
    meters.push(n); meters.push(d);
    var beats = n * 4 / d; if (!(beats > 0)) beats = 4;
    st.pos += beats; st.covered += beats;
    step(my);
}

function finish(my) {
    if (my !== runId) return;
    song.set("current_song_time", savedTime);        // restore playhead
    busy = false; task = null;
    meterCache[curClipId] = meters.slice();           // cache for next time
    outlet(0, "meters", meters.slice());
    post("meter_scan: " + (meters.length / 2) + " bars (clip " + curClipId + ")\n");
}
