// ================================================================
// meter_scan.js  —  Max [js meter_scan.js] object
// Scans the song's time signature across the currently shown clip
// (live_set view detail_clip) and outputs a per-bar meter list:
//     meters <num1> <den1> <num2> <den2> ...
// Trigger with a [bang] or the message "scan".
// Works by stepping current_song_time bar by bar and reading
// signature_numerator / signature_denominator at each position.
// The original playhead position is restored when finished.
// ================================================================

autowatch = 1;
inlets  = 1;
outlets = 1;

var STEP_MS   = 25;     // delay between moving the playhead and reading the meter
var MAX_BARS  = 1024;   // safety cap

var song      = null;
var meters    = [];
var savedTime = 0;
var st        = null;   // scan state: { pos, covered, len }
var readTask  = null;

function num(v) { return parseFloat("" + v); }   // LiveAPI.get returns arrays; coerce

function bang() { scan(); }
function msg_int() { scan(); }

function scan() {
    song = new LiveAPI("live_set");
    var clip = new LiveAPI("live_set view detail_clip");
    if (!clip || clip.id == 0) { post("meter_scan: no clip selected\n"); return; }

    savedTime = num(song.get("current_song_time"));

    var clipStart = num(clip.get("start_time"));   // arrangement position (beats); NaN for session
    var clipLen   = num(clip.get("length"));       // clip length (beats)
    if (isNaN(clipStart)) clipStart = 0;
    if (isNaN(clipLen) || clipLen <= 0) clipLen = 4;

    meters = [];
    st = { pos: clipStart, covered: 0, len: clipLen };
    stepNext();
}

function stepNext() {
    if (st.covered >= st.len - 0.0001 || (meters.length / 2) >= MAX_BARS) {
        finishScan();
        return;
    }
    song.set("current_song_time", st.pos);          // move playhead
    readTask = new Task(readMeter, this);
    readTask.schedule(STEP_MS);                      // let Live update the signature
}

function readMeter() {
    var n = parseInt(num(song.get("signature_numerator")), 10);
    var d = parseInt(num(song.get("signature_denominator")), 10);
    if (!n || !d) { n = 4; d = 4; }
    meters.push(n);
    meters.push(d);
    var barBeats = n * 4 / d;                        // quarter-note beats in this bar
    if (!(barBeats > 0)) barBeats = 4;
    st.pos     += barBeats;
    st.covered += barBeats;
    stepNext();
}

function finishScan() {
    song.set("current_song_time", savedTime);        // restore playhead
    outlet(0, "meters", meters);
    post("meter_scan: " + (meters.length / 2) + " bars -> " + meters.join(" ") + "\n");
}
