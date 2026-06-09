// ================================================================
// m4l_score.js  v8  Phase 1+
// ================================================================

window.onerror = function(msg, src, line) {
    if (window.max && max.post) max.post("ERR: " + msg + " L:" + line);
    return false;
};
function maxLog(m) { if (window.max && max.post) max.post("LOG: " + m); }

const { Renderer, Stave, StaveNote, Voice, Formatter,
        Accidental, Barline, Beam, Tuplet, Dot } = VexFlow;

const container = document.getElementById("score-container");

let clipNotes  = [];
let timeSig    = { num: 4, den: 4 };
let currentBar = 0;

const TPBEAT    = 480;
const TOL       = 12;
const TUP_TOL   = 35;
const GRID      = 4;
const IOI_RATIO = 0.50;
const H_VIRTUAL = 160;
const K_NOTE    = 58;
const MIN_W     = 420;
const CLEF_W    = 98;

const STD_NOTES = [
    {t:1920,v:"w"}, {t:1440,v:"hd"},{t:960,v:"h"}, {t:720,v:"qd"},
    {t:480, v:"q"}, {t:360, v:"8d"},{t:240,v:"8"}, {t:180,v:"16d"},
    {t:120, v:"16"},{t:90,  v:"32d"},{t:60, v:"32"}
];

const REST_VALS = [
    {t:1920,v:"wr"},{t:960,v:"hr"},{t:480,v:"qr"},
    {t:240,v:"8r"}, {t:120,v:"16r"},{t:60,v:"32r"}
];

const TUPLETS = [
    {n:3,t:320,total:960, vex:"q", occ:2},
    {n:3,t:160,total:480, vex:"8", occ:2},
    {n:3,t: 80,total:240, vex:"16",occ:2},
    {n:5,t:192,total:960, vex:"8", occ:4},
    {n:5,t: 96,total:480, vex:"16",occ:4},
    {n:6,t:160,total:960, vex:"8", occ:4},
    {n:6,t: 80,total:480, vex:"16",occ:4},
];

const NOTE_W_MAP = { w:52, h:42, q:34, "8":28, "16":23, "32":19 };

function midiToKey(midi) {
    var n = ["c","c#","d","d#","e","f","f#","g","g#","a","a#","b"];
    return n[midi % 12] + "/" + (Math.floor(midi / 12) - 1);
}

function snapStd(ticks) {
    var best = STD_NOTES[STD_NOTES.length - 1], diff = Infinity;
    for (var i = 0; i < STD_NOTES.length; i++) {
        var e = Math.abs(ticks - STD_NOTES[i].t);
        if (e < diff) { diff = e; best = STD_NOTES[i]; }
    }
    return best;
}

function makeRests(ticks) {
    var rests = [];
    while (ticks >= 60) {
        var ok = false;
        for (var i = 0; i < REST_VALS.length; i++) {
            if (REST_VALS[i].t <= ticks) {
                rests.push(new StaveNote({ keys: ["b/4"], duration: REST_VALS[i].v }));
                ticks -= REST_VALS[i].t; ok = true; break;
            }
        }
        if (!ok) break;
    }
    return rests;
}

function makeNote(pitches, vexDur) {
    var keys = pitches.slice().sort(function(a,b){return a-b;}).map(midiToKey);
    var note = new StaveNote({ keys: keys, duration: vexDur });
    if (vexDur.includes("d") && !vexDur.endsWith("r")) {
        try { Dot.buildAndAttach([note]); } catch(e) {}
    }
    keys.forEach(function(k, i) {
        if (k.includes("#")) note.addModifier(new Accidental("#"), i);
    });
    return note;
}

function groupByTickIOI(events, barEnd) {
    var map = {};
    for (var i = 0; i < events.length; i++) {
        var e = events[i];
        var s = Math.round(e.st / GRID) * GRID;
        if (!map[s]) map[s] = { tick: s, soundDur: 0, pitches: [] };
        map[s].pitches.push(e.pitch);
        map[s].soundDur = Math.max(map[s].soundDur, e.dur);
    }
    var groups = Object.values(map).sort(function(a,b){return a.tick-b.tick;});

    for (var i = 0; i < groups.length; i++) {
        var nextTick = i + 1 < groups.length ? groups[i+1].tick : barEnd;
        var ioi  = Math.min(nextTick - groups[i].tick, barEnd - groups[i].tick);
        var snd  = groups[i].soundDur;
        groups[i].dur = snd >= ioi * IOI_RATIO ? snd : ioi;
    }

    for (var i = 1; i < groups.length; i++) {
        var prev = groups[i-1].dur;
        if (groups[i].dur > prev * 1.5 && groups[i].soundDur < groups[i].dur * 0.5) {
            groups[i].dur = Math.min(prev, barEnd - groups[i].tick);
        }
    }
    return groups;
}

function tryDetectTuplet(groups, gi) {
    var g0 = groups[gi];
    var candidates = TUPLETS.filter(function(d){
        return Math.abs(g0.dur - d.t) <= TUP_TOL;
    }).sort(function(a,b){return b.n-a.n;});

    for (var ci = 0; ci < candidates.length; ci++) {
        var def = candidates[ci];
        if (gi + def.n > groups.length) continue;
        var ok = true;
        for (var j = 1; j < def.n; j++) {
            if (Math.abs(groups[gi+j].dur - def.t) > TUP_TOL) { ok = false; break; }
        }
        if (!ok) continue;
        var lg   = groups[gi + def.n - 1];
        var span = lg.tick + lg.dur - g0.tick;
        if (Math.abs(span - def.total) > TOL * def.n) continue;
        return { def: def, grps: groups.slice(gi, gi + def.n), tick: g0.tick, total: def.total };
    }
    return null;
}

function buildBarData(barStart, barEnd, allEvents) {
    var barEvents = allEvents.filter(function(e){
        return e.st >= barStart && e.st < barEnd;
    });
    var groups = groupByTickIOI(barEvents, barEnd);

    var timeline = [];
    var gi = 0;
    while (gi < groups.length) {
        var tup = tryDetectTuplet(groups, gi);
        if (tup) {
            timeline.push({ type:"tup", tick:tup.tick, total:tup.total,
                            def:tup.def, grps:tup.grps });
            gi += tup.def.n;
        } else {
            var g = groups[gi];
            var fitsInBar = (g.tick + g.dur) <= barEnd;
            if (fitsInBar) {
                var snp = snapStd(g.dur);
                timeline.push({ type:"note", tick:g.tick, vexDur:snp.v, adv:snp.t, grp:g });
            } else {
                var avail = barEnd - g.tick;
                var snp   = snapStd(avail);
                timeline.push({ type:"note", tick:g.tick, vexDur:snp.v,
                                adv:Math.min(snp.t, avail), grp:g });
            }
            gi++;
        }
    }

    var tickables      = [];
    var beamCandidates = [];
    var tupletObjs     = [];
    var cursor = barStart;

    for (var ti = 0; ti < timeline.length; ti++) {
        var item = timeline[ti];
        var gap = item.tick - cursor;
        if (gap > 30) {
            var rr = makeRests(gap);
            rr.forEach(function(r){ tickables.push(r); });
            cursor += gap;
        }
        if (item.type === "note") {
            var note = makeNote(item.grp.pitches, item.vexDur);
            tickables.push(note);
            if (["8","8d","16","16d","32","32d"].indexOf(item.vexDur) >= 0)
                beamCandidates.push(note);
            cursor = item.tick + item.adv;
        } else {
            var tnotes = item.grps.map(function(grp){
                var n = makeNote(grp.pitches, item.def.vex);
                beamCandidates.push(n);
                return n;
            });
            tnotes.forEach(function(n){ tickables.push(n); });
            try {
                tupletObjs.push(new Tuplet(tnotes, {
                    num_notes:      item.def.n,
                    notes_occupied: item.def.occ,
                    beats_occupied: item.def.occ,
                    ratioed:        false,
                    bracketed:      true,
                    location:       -1
                }));
            } catch(e) { maxLog("Tuplet: " + e.message); }
            cursor = item.tick + item.total;
        }
    }

    var rem = barEnd - cursor;
    if (rem > 30) {
        makeRests(rem).forEach(function(r){ tickables.push(r); });
    }

    return { tickables: tickables, beamCandidates: beamCandidates, tupletObjs: tupletObjs };
}

function calcNoteVirtualW(tickables) {
    var w = 0;
    for (var i = 0; i < tickables.length; i++) {
        var t = tickables[i];
        try {
            if (t.isRest()) {
                w += 24;
            } else {
                var dur  = t.getDuration();
                var hasDot = t.dots > 0;
                var keys = t.getKeys();
                var accs = keys.filter(function(k){ return k.indexOf("#") >= 0 || k.indexOf("b") >= 0; }).length;
                w += (NOTE_W_MAP[dur] || 26) + (hasDot ? 14 : 0)
                   + Math.max(0, keys.length - 1) * 8 + accs * 18;
            }
        } catch(ex) { w += 26; }
    }
    return Math.max(w, 60);
}

function calcBarsToShow(numBars, allEvents, TPBAR) {
    if (numBars <= 1) return 1;
    var bar0 = allEvents.filter(function(e){ return e.st >= 0 && e.st < TPBAR; });
    var posSet = {};
    bar0.forEach(function(e){ posSet[Math.round(e.st / GRID) * GRID] = true; });
    var pos = Object.keys(posSet).length || 1;
    if (pos <= 8)  return Math.min(4, numBars);
    if (pos <= 16) return Math.min(2, numBars);
    return 1;
}

function getNumBars() {
    var TPBAR = timeSig.num * TPBEAT;
    if (clipNotes.length === 0) return 1;
    var maxEnd = clipNotes.reduce(function(mx, n){
        return Math.max(mx, Math.round((n.start_time + n.duration) * TPBEAT));
    }, 0);
    return Math.max(1, Math.ceil(maxEnd / TPBAR));
}

function draw() {
    try {
        if (!container) return;
        container.innerHTML = "";

        var TPBAR = timeSig.num * TPBEAT;
        var numBars = getNumBars();
        if (currentBar >= numBars) currentBar = Math.max(0, numBars - 1);

        var allEvents = clipNotes.map(function(n){
            return {
                st:    Math.round(n.start_time * TPBEAT),
                dur:   Math.round(n.duration   * TPBEAT),
                pitch: n.pitch
            };
        });

        var barsToShow = calcBarsToShow(numBars, allEvents, TPBAR);
        var startBar   = currentBar;
        var endBar     = Math.min(startBar + barsToShow - 1, numBars - 1);
        var actual     = endBar - startBar + 1;

        var barDatas = [];
        for (var b = 0; b < actual; b++) {
            var bs = (startBar + b) * TPBAR;
            barDatas.push(buildBarData(bs, bs + TPBAR, allEvents));
        }

        var noteWidths = barDatas.map(function(bd){ return calcNoteVirtualW(bd.tickables); });
        var totalNoteW = noteWidths.reduce(function(s,w){ return s+w; }, 0);
        var W_virtual  = Math.max(MIN_W, totalNoteW + CLEF_W + 20);

        var renderer = new Renderer(container, Renderer.Backends.SVG);
        renderer.resize(W_virtual, H_VIRTUAL);
        var ctx = renderer.getContext();

        var totalStaveW = W_virtual - 20;
        var denomW      = totalNoteW + CLEF_W;
        var staveWidths = noteWidths.map(function(nw, b){
            return Math.floor(totalStaveW * (b === 0 ? nw + CLEF_W : nw) / denomW);
        });
        var sw_sum = staveWidths.reduce(function(s,w){ return s+w; }, 0);
        staveWidths[actual - 1] += totalStaveW - sw_sum;

        var staveY = 30;
        var curX = 10;
        for (var b = 0; b < actual; b++) {
            var bd = barDatas[b];
            var sw = staveWidths[b];
            var stave = new Stave(curX, staveY, sw);

            if (b === 0) {
                stave.addClef("treble").addTimeSignature(timeSig.num + "/" + timeSig.den);
            }
            stave.setEndBarType(b < actual - 1 ? Barline.type.NONE : Barline.type.END);
            stave.setContext(ctx).draw();

            var v = new Voice({ num_beats: timeSig.num, beat_value: timeSig.den });
            v.setStrict(false);
            v.addTickables(bd.tickables);

            var beams = [];
            try { beams = Beam.generateBeams(bd.beamCandidates); } catch(e) {}

            try {
                new Formatter()
                    .joinVoices([v])
                    .formatToStave([v], stave, { align_rests: true });
            } catch(e) {
                maxLog("formatToStave b" + b + ": " + e.message);
                var fw = sw - (b === 0 ? CLEF_W + 15 : 15);
                new Formatter().joinVoices([v]).format([v], Math.max(fw, 30));
            }

            v.draw(ctx, stave);
            beams.forEach(function(bm){ bm.setContext(ctx).draw(); });
            bd.tupletObjs.forEach(function(t){ t.setContext(ctx).draw(); });

            curX += sw;
        }

        ctx.save();
        ctx.setFillStyle("#888888");
        var barLabel = actual > 1
            ? ("bar " + (startBar+1) + "-" + (endBar+1) + " / " + numBars)
            : ("bar " + (startBar+1) + " / " + numBars);
        ctx.fillText(barLabel, 12, 14);
        ctx.restore();

        var dbg = document.getElementById("dbg");
        if (dbg) dbg.textContent = barLabel + " notes:" + clipNotes.length;

        var svgEl = container.querySelector("svg");
        if (svgEl) {
            svgEl.setAttribute("viewBox",             "0 0 " + W_virtual + " " + H_VIRTUAL);
            svgEl.setAttribute("width",               "100%");
            svgEl.setAttribute("height",              "100%");
            svgEl.setAttribute("preserveAspectRatio", "xMidYMid meet");
        }

    } catch(e) {
        maxLog("### Render Error: " + e.message);
    }
}

var _maxBound = false;

function setupMaxBindings() {
    if (_maxBound) return;
    if (!window.max) return;
    _maxBound = true;

    var dbg = document.getElementById("dbg");
    if (dbg) dbg.textContent = "max ready";

    window.max.bindInlet("clip_data", function(jsonStr) {
        try {
            var data = JSON.parse(jsonStr);
            if (data && data.notes) { clipNotes = data.notes; draw(); }
        } catch(e) { maxLog("JSON parse: " + e.message); }
    });

    window.max.bindInlet("bar_index", function(n) {
        currentBar = Math.max(0, Math.floor(n));
        draw();
    });

    window.max.bindInlet("bar_next", function() {
        currentBar = Math.min(currentBar + 1, getNumBars() - 1);
        draw();
    });

    window.max.bindInlet("bar_prev", function() {
        currentBar = Math.max(0, currentBar - 1);
        draw();
    });

    window.max.bindInlet("timesig", function(n, d) {
        timeSig.num = n; timeSig.den = d; draw();
    });

    window.max.bindInlet("reset", function() {
        clipNotes = []; currentBar = 0; draw();
    });
}

setupMaxBindings();
var _pollTimer = setInterval(function() {
    if (_maxBound) { clearInterval(_pollTimer); return; }
    setupMaxBindings();
}, 50);
setTimeout(function() { clearInterval(_pollTimer); }, 5000);

draw();
