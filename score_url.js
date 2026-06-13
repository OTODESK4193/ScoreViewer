// ================================================================
// score_url.js  —  Max [js score_url.js]
// Loads m4l_score_inline.html from THIS DEVICE'S OWN FOLDER, on any
// machine/drive, without depending on the Max search path.
//
// Replaces the [m4l_score_inline.html]->[absolutepath]->[sprintf]->
// [prepend url] chain. Wire a trigger (loadbang / delay 500) into it,
// and its output to the jweb inlet 0.
//
//   [loadbang] / [delay 500] -> [js score_url.js] -> [jweb]
//
// It reads this.patcher.filepath (the .amxd location), derives the
// folder, and outputs:  url file:///<folder>/m4l_score_inline.html
// (Windows -> file:///C:/...   macOS -> file:///Users/...)
// ================================================================

autowatch = 1;
inlets  = 1;
outlets = 1;

var HTML = "m4l_score_inline.html";

function bang()     { send(); }
function loadbang() { send(); }
function msg_int()  { send(); }

function send() {
    var p = "";
    try { p = "" + this.patcher.filepath; } catch (e) {}
    if (!p || p === "undefined" || p === "") {
        post("score_url: cannot read patcher filepath\n");
        return;
    }
    p = p.replace(/\\/g, "/");              // normalize separators to "/"
    var dir = p.replace(/[^\/]*$/, "");     // strip the .amxd filename -> folder/
    var pre = (dir.charAt(0) === "/") ? "file://" : "file:///";  // mac vs windows
    var url = pre + dir + HTML;
    outlet(0, "url", url);
    post("score_url: " + url + "\n");
}
