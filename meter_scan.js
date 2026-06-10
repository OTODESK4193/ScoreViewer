// ================================================================
// meter_scan.js  —  Max [js meter_scan.js] object   (v2, re-entrancy safe)
// Scans the song's time signature across the currently shown clip
// (live_set view detail_clip) and outputs a per-bar meter list:
//     meters <num1> <den1> <num2> <den2> ...
// Trigger with a [bang] or the message "scan".
//
// v2 fixes a multi-trigger bug: selecting a clip can fire several
// triggers, which used to start overlapping scans that corrupted
// each other and left the playhead in the wrong place. Now each
// scan carries a run id; a newer request supersedes the older run,
// and the original playhead position is captured only once and
// restored when the final run finishes.
// ================================================================

autowatch = 1;
inlets  = 1;
outlets = 1;

var STEP_MS  = 50;      // delay between moving the playhead and reading the meter
var MAX_BARS = 1024;    // safety cap

var song      = null;
var meters    = [];
var savedTime = 0;
var busy      = false;  // a scan is in progress
var runId     = 0;      // increments on every (re)start; stale runs abort
var st        = null;   // { pos, covered, len }
var task      = null;

function num(v) { return parseFloat("" + v); }   // LiveAPI.get returns arrays; coerce

function bang() { scan(); }
function msg_int() { scan(); }

function scan() {
    song = new LiveAPI("live_set");
    var clip = new LiveAPI("live_set view detail_clip");
    if (!clip || clip.id == 0) { post("meter_scan: no clip selected\n"); return; }

    // capture the true original playhead position only once
    if (!busy) { savedTime = num(song.get("current_song_time")); busy = true; }

    // cancel any in-flight step and supersede previous run
    if (task) { task.cancel(); task = null; }
    runId++;
    var myRun = runId;

    var clipStart = num(clip.get("start_time"));   // arrangement position (beats)
    var clipLen   = num(clip.get("length"));       // clip length (beats)
    if (isNaN(clipStart)) clipStart = 0;
    if (isNaN(clipLen) || clipLen <= 0) clipLen = 4;

    meters = [];
    st = { pos: clipStart, covered: 0, len: clipLen };
    stepNext(myRun);
}

function stepNext(myRun) {
    if (myRun !== runId) return;                      // superseded by a newer scan
    if (st.covered >= st.len - 0.0001 || (meters.length / 2) >= MAX_BARS) {
        finishScan(myRun);
        return;
    }
    song.set("current_song_time", st.pos);            // move playhead
    task = new Task(function() { readMeter(myRun); }, this);
    task.schedule(STEP_MS);                            // let Live update the signature
}

function readMeter(myRun) {
    if (myRun !== runId) return;                      // superseded
    var n = parseInt(num(song.get("signature_numerator")), 10);
    var d = parseInt(num(song.get("signature_denominator")), 10);
    if (!n || !d) { n = 4; d = 4; }
    meters.push(n);
    meters.push(d);
    var barBeats = n * 4 / d;                          // quarter-note beats in this bar
    if (!(barBeats > 0)) barBeats = 4;
    st.pos     += barBeats;
    st.covered += barBeats;
    stepNext(myRun);
}

function finishScan(myRun) {
    if (myRun !== runId) return;                      // superseded
    song.set("current_song_time", savedTime);          // restore original playhead
    busy = false;
    task = null;
    outlet(0, "meters", meters);
    post("meter_scan: " + (meters.length / 2) + " bars -> " + meters.join(" ") + "\n");
}
