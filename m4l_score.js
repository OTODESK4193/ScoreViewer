// ================================================================
// m4l_score.js  v13  Phase 6 (beat-grouped beams, rest clef, exact width)
// ================================================================

window.onerror = function(msg, src, line) {
    if (window.max && max.post) max.post("ERR: " + msg + " L:" + line);
    return false;
};
function maxLog(m) { if (window.max && max.post) max.post("LOG: " + m); }

const { Renderer, Stave, StaveNote, Voice, Formatter,
        Accidental, Barline, Beam, Tuplet, Dot, StaveConnector } = VexFlow;

const container = document.getElementById("score-container");

let clipNotes  = [];
let timeSig    = { num: 4, den: 4 };
let barMeters  = [];
let currentBar = 0;

// clef mode: 0 = treble, 1 = bass, 2 = grand, 3 = auto
let clefMode   = 0;
const SPLIT_PITCH = 60;

let keySpec    = "C";
let spellTable = ["c","c#","d","d#","e","f","f#","g","g#","a","a#","b"];

const SHARP_SP = ["c","c#","d","d#","e","f","f#","g","g#","a","a#","b"];
const FLAT_SP  = ["c","db","d","eb","e","f","gb","g","ab","a","bb","b"];

const KEY_TABLE = [
    { name:"C major / A minor",   vf:"C",  base:SHARP_SP },
    { name:"G major / E minor",   vf:"G",  base:SHARP_SP },
    { name:"D major / B minor",   vf:"D",  base:SHARP_SP },
    { name:"A major / F# minor",  vf:"A",  base:SHARP_SP },
    { name:"E major / C# minor",  vf:"E",  base:SHARP_SP },
    { name:"B major / G# minor",  vf:"B",  base:SHARP_SP },
    { name:"F# major / D# minor", vf:"F#", base:SHARP_SP, ovr:{5:"e#"} },
    { name:"F major / D minor",   vf:"F",  base:FLAT_SP },
    { name:"Bb major / G minor",  vf:"Bb", base:FLAT_SP },
    { name:"Eb major / C minor",  vf:"Eb", base:FLAT_SP },
    { name:"Ab major / F minor",  vf:"Ab", base:FLAT_SP },
    { name:"Db major / Bb minor", vf:"Db", base:FLAT_SP },
    { name:"Gb major / Eb minor", vf:"Gb", base:FLAT_SP, ovr:{11:"cb"} }
];

const KEYSIG_COUNT = { C:0, G:1, D:2, A:3, E:4, B:5, "F#":6,
                       F:1, Bb:2, Eb:3, Ab:4, Db:5, Gb:6 };

function applyKeyIndex(i) {
    i = Math.max(0, Math.min(KEY_TABLE.length - 1, Math.floor(i)));
    var k = KEY_TABLE[i];
    keySpec    = k.vf;
    spellTable = k.base.slice();
    if (k.ovr) for (var pc in k.ovr) spellTable[pc] = k.ovr[pc];
}

const TPBEAT    = 480;
const TPWHOLE   = 1920;
const TOL       = 12;
const TUP_TOL   = 35;
const GRID      = 4;
const IOI_RATIO = 0.50;
const MIN_W     = 420;
const CLEF_W    = 98;
const SIG_W     = 30;
const W_MARGIN  = 28;   // breathing room per bar so notes never touch the barline

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

const BEAMABLE = { "8":1, "8d":1, "16":1, "16d":1, "32":1, "32d":1 };

function midiToKey(midi) {
    var pc     = ((midi % 12) + 12) % 12;
    var name   = spellTable[pc];
    var letter = name.charAt(0);
    var oct    = Math.floor(midi / 12) - 1;
    if (pc === 11 && letter === "c") oct += 1;
    if (pc === 0  && letter === "b") oct -= 1;
    return name + "/" + oct;
}

function barTicksOf(m) { return Math.round(m.num * TPWHOLE / m.den); }

// beaming unit (ticks): compound meters -> dotted quarter, else quarter beat
function beamUnitOf(num, den) {
    if (den === 8  && num % 3 === 0) return 720;
    if (den === 16 && num % 3 === 0) return 720;
    return 480;
}

function snapStd(ticks) {
    var best = STD_NOTES[STD_NOTES.length - 1], diff = Infinity;
    for (var i = 0; i < STD_NOTES.length; i++) {
        var e = Math.abs(ticks - STD_NOTES[i].t);
        if (e < diff) { diff = e; best = STD_NOTES[i]; }
    }
    return best;
}

function makeRests(ticks, clef) {
    var line = (clef === "bass") ? "d/3" : "b/4";
    var rests = [];
    while (ticks >= 60) {
        var ok = false;
        for (var i = 0; i < REST_VALS.length; i++) {
            if (REST_VALS[i].t <= ticks) {
                rests.push(new StaveNote({ keys: [line], duration: REST_VALS[i].v, clef: clef || "treble" }));
                ticks -= REST_VALS[i].t; ok = true; break;
            }
        }
        if (!ok) break;
    }
    return rests;
}

function wholeBarRest(clef) {
    var line = (clef === "bass") ? "d/3" : "b/4";
    var r = new StaveNote({ keys: [line], duration: "wr", clef: clef || "treble" });
    try { r.setCenterAlignment(true); } catch(e) {}
    return r;
}

function makeNote(pitches, vexDur, clef) {
    var keys = pitches.slice().sort(function(a,b){return a-b;}).map(midiToKey);
    var note = new StaveNote({ keys: keys, duration: vexDur, clef: clef || "treble" });
    if (vexDur.includes("d") && !vexDur.endsWith("r")) {
        try { Dot.buildAndAttach([note]); } catch(e) {}
    }
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
        for (var j = 1; j < def.n; j++)
            if (Math.abs(groups[gi+j].dur - def.t) > TUP_TOL) { ok = false; break; }
        if (!ok) continue;
        var lg   = groups[gi + def.n - 1];
        var span = lg.tick + lg.dur - g0.tick;
        if (Math.abs(span - def.total) > TOL * def.n) continue;
        return { def: def, grps: groups.slice(gi, gi + def.n), tick: g0.tick, total: def.total };
    }
    return null;
}

// build tickables + beam GROUPS, split at rests, non-beamables, and beat boundaries
function buildBarData(barStart, barEnd, allEvents, clef, beamUnit) {
    var barEvents = allEvents.filter(function(e){ return e.st >= barStart && e.st < barEnd; });

    if (barEvents.length === 0)
        return { tickables: [ wholeBarRest(clef) ], beamGroups: [], tupletObjs: [] };

    var groups = groupByTickIOI(barEvents, barEnd);

    var timeline = [];
    var gi = 0;
    while (gi < groups.length) {
        var tup = tryDetectTuplet(groups, gi);
        if (tup) {
            timeline.push({ type:"tup", tick:tup.tick, total:tup.total, def:tup.def, grps:tup.grps });
            gi += tup.def.n;
        } else {
            var g = groups[gi];
            var fits = (g.tick + g.dur) <= barEnd;
            if (fits) {
                var snp = snapStd(g.dur);
                timeline.push({ type:"note", tick:g.tick, vexDur:snp.v, adv:snp.t, grp:g });
            } else {
                var avail = barEnd - g.tick, snp2 = snapStd(avail);
                timeline.push({ type:"note", tick:g.tick, vexDur:snp2.v, adv:Math.min(snp2.t, avail), grp:g });
            }
            gi++;
        }
    }

    var tickables = [], beamGroups = [], tupletObjs = [], curRun = [], runBeat = -1;
    function closeRun() { if (curRun.length >= 2) beamGroups.push(curRun); curRun = []; runBeat = -1; }
    function beatOf(tick) { return Math.floor((tick - barStart) / beamUnit); }
    var cursor = barStart;

    for (var ti = 0; ti < timeline.length; ti++) {
        var item = timeline[ti];
        var gap = item.tick - cursor;
        if (gap > 30) {                              // a rest breaks the beam
            closeRun();
            makeRests(gap, clef).forEach(function(r){ tickables.push(r); });
            cursor += gap;
        }
        if (item.type === "note") {
            var note = makeNote(item.grp.pitches, item.vexDur, clef);
            tickables.push(note);
            if (BEAMABLE[item.vexDur]) {
                var beat = beatOf(item.tick);
                if (curRun.length && beat !== runBeat) closeRun();   // new beat -> new beam
                if (curRun.length === 0) runBeat = beat;
                curRun.push(note);
            } else closeRun();                       // quarter+ breaks the beam
            cursor = item.tick + item.adv;
        } else {
            closeRun();
            var tnotes = item.grps.map(function(grp){ return makeNote(grp.pitches, item.def.vex, clef); });
            tnotes.forEach(function(n){ tickables.push(n); });
            if (tnotes.length >= 2) beamGroups.push(tnotes.slice());
            try {
                tupletObjs.push(new Tuplet(tnotes, {
                    num_notes: item.def.n, notes_occupied: item.def.occ,
                    beats_occupied: item.def.occ, ratioed: false, bracketed: true, location: -1
                }));
            } catch(e) { maxLog("Tuplet: " + e.message); }
            cursor = item.tick + item.total;
        }
    }
    closeRun();
    var rem = barEnd - cursor;
    if (rem > 30) makeRests(rem, clef).forEach(function(r){ tickables.push(r); });

    return { tickables: tickables, beamGroups: beamGroups, tupletObjs: tupletObjs };
}

function buildBars() {
    var maxEnd = 0;
    for (var i = 0; i < clipNotes.length; i++) {
        var end = Math.round((clipNotes[i].start_time + clipNotes[i].duration) * TPBEAT);
        if (end > maxEnd) maxEnd = end;
    }
    var bars = [], acc = 0, prev = null;
    function push(m) {
        var L = barTicksOf(m); if (L < 1) L = barTicksOf(timeSig);
        var chg = !prev || prev.num !== m.num || prev.den !== m.den;
        bars.push({ start: acc, len: L, num: m.num, den: m.den, chg: chg });
        acc += L; prev = m;
    }
    if (barMeters && barMeters.length) {
        for (var b = 0; b < barMeters.length; b++) push(barMeters[b]);
        var last = barMeters[barMeters.length - 1];
        while (acc < maxEnd) push(last);
    } else { do { push(timeSig); } while (acc < maxEnd); }
    if (bars.length === 0) push(timeSig);
    return bars;
}

function countPosInRange(allEvents, s, e) {
    var set = {};
    allEvents.forEach(function(ev){ if (ev.st >= s && ev.st < e) set[Math.round(ev.st / GRID) * GRID] = 1; });
    return Object.keys(set).length;
}

function calcBarsToShow(bars, startIdx, allEvents) {
    if (bars.length <= 1) return 1;
    var b = bars[startIdx];
    var pos = countPosInRange(allEvents, b.start, b.start + b.len) || 1;
    var max = pos <= 8 ? 4 : (pos <= 16 ? 2 : 1);
    return Math.min(max, bars.length - startIdx);
}

function getNumBars() { return buildBars().length; }

function autoClef() {
    if (clipNotes.length === 0) return 0;
    var lo = Infinity, hi = -Infinity;
    for (var i = 0; i < clipNotes.length; i++) {
        var p = clipNotes[i].pitch;
        if (p < lo) lo = p; if (p > hi) hi = p;
    }
    if (lo >= 55) return 0;
    if (hi <= 64) return 1;
    return 2;
}

function makeVoice(bd, bar) {
    var v = new Voice({ num_beats: bar.num, beat_value: bar.den });
    v.setStrict(false);
    v.addTickables(bd.tickables);
    try { Accidental.applyAccidentals([v], keySpec); } catch(e) { maxLog("acc: " + e.message); }
    return v;
}

function minWidthOf(voices) {
    try { return new Formatter().joinVoices(voices).preCalculateMinTotalWidth(voices); }
    catch(e) { return 120; }
}

function makeBeams(bd) {
    var arr = [];
    bd.beamGroups.forEach(function(g){ try { arr.push(new Beam(g)); } catch(e){} });
    return arr;
}

function draw() {
    try {
        if (!container) return;
        container.innerHTML = "";

        var mode  = (clefMode === 3) ? autoClef() : clefMode;
        var grand = (mode === 2);
        var clef1 = (mode === 1) ? "bass" : "treble";

        var allEvents = clipNotes.map(function(n){
            return { st: Math.round(n.start_time*TPBEAT), dur: Math.round(n.duration*TPBEAT), pitch: n.pitch };
        });
        var trebleEv = grand ? allEvents.filter(function(e){ return e.pitch >= SPLIT_PITCH; }) : null;
        var bassEv   = grand ? allEvents.filter(function(e){ return e.pitch <  SPLIT_PITCH; }) : null;

        var bars    = buildBars();
        var numBars = bars.length;
        if (currentBar >= numBars) currentBar = Math.max(0, numBars - 1);

        var startBar   = currentBar;
        var barsToShow = calcBarsToShow(bars, startBar, allEvents);
        var endBar     = Math.min(startBar + barsToShow - 1, numBars - 1);
        var actual     = endBar - startBar + 1;

        var keyAccW = (KEYSIG_COUNT[keySpec] || 0) * 12;

        // --- phase A: build data + voices, measure exact min note width ---
        var TOP = [], BOT = [], TV = [], BV = [], noteWidths = [], headWs = [], showSigs = [];
        for (var b = 0; b < actual; b++) {
            var bar = bars[startBar + b];
            var s = bar.start, e = bar.start + bar.len;
            var bu = beamUnitOf(bar.num, bar.den);
            var minW;
            if (grand) {
                TOP[b] = buildBarData(s, e, trebleEv, "treble", bu);
                BOT[b] = buildBarData(s, e, bassEv,   "bass",   bu);
                TV[b]  = makeVoice(TOP[b], bar);
                BV[b]  = makeVoice(BOT[b], bar);
                minW   = minWidthOf([TV[b], BV[b]]);
            } else {
                TOP[b] = buildBarData(s, e, allEvents, clef1, bu);
                TV[b]  = makeVoice(TOP[b], bar);
                minW   = minWidthOf([TV[b]]);
            }
            noteWidths[b] = minW + W_MARGIN;
            var showSig = (b === 0) || bar.chg;
            showSigs[b] = showSig;
            var head = 0;
            if (b === 0) head += CLEF_W + keyAccW;
            if (showSig) head += SIG_W;
            headWs[b] = head;
        }

        var totalNoteW = noteWidths.reduce(function(s,w){ return s+w; }, 0);
        var totalHeadW = headWs.reduce(function(s,w){ return s+w; }, 0);
        var W_virtual  = Math.max(MIN_W, totalNoteW + totalHeadW + 20);
        var H_virtual  = grand ? 250 : 160;
        var trebleY    = grand ? 20 : 30;
        var bassY      = 130;

        var renderer = new Renderer(container, Renderer.Backends.SVG);
        renderer.resize(W_virtual, H_virtual);
        var ctx = renderer.getContext();

        var totalStaveW = W_virtual - 20;
        var denomW      = totalNoteW + totalHeadW;
        var staveWidths = noteWidths.map(function(nw, b){
            return Math.floor(totalStaveW * (nw + headWs[b]) / denomW);
        });
        var sw_sum = staveWidths.reduce(function(s,w){ return s+w; }, 0);
        staveWidths[actual - 1] += totalStaveW - sw_sum;

        // --- phase B: render ---
        var curX = 10;
        for (var b = 0; b < actual; b++) {
            var bar = bars[startBar + b];
            var sw  = staveWidths[b];
            var fw  = Math.max(sw - headWs[b] - 12, 30);   // note area, leaves margin before barline

            var tStave = new Stave(curX, trebleY, sw);
            if (b === 0) tStave.addClef(grand ? "treble" : clef1).addKeySignature(keySpec);
            if (showSigs[b]) tStave.addTimeSignature(bar.num + "/" + bar.den);
            tStave.setEndBarType(b < actual - 1 ? Barline.type.NONE : Barline.type.END);
            tStave.setContext(ctx).draw();

            var bStave = null;
            if (grand) {
                bStave = new Stave(curX, bassY, sw);
                if (b === 0) bStave.addClef("bass").addKeySignature(keySpec);
                if (showSigs[b]) bStave.addTimeSignature(bar.num + "/" + bar.den);
                bStave.setEndBarType(b < actual - 1 ? Barline.type.NONE : Barline.type.END);
                bStave.setContext(ctx).draw();
                if (b === 0) {
                    try { new StaveConnector(tStave, bStave).setType(StaveConnector.type.BRACE).setContext(ctx).draw(); } catch(e){}
                    try { new StaveConnector(tStave, bStave).setType(StaveConnector.type.SINGLE_LEFT).setContext(ctx).draw(); } catch(e){}
                }
            }

            if (grand) {
                var tv = TV[b], bv = BV[b];
                try { var fmt = new Formatter(); fmt.joinVoices([tv]); fmt.joinVoices([bv]); fmt.format([tv, bv], fw); }
                catch(e) { maxLog("fmt grand b"+b+": "+e.message); }
                var tBeams = makeBeams(TOP[b]), bBeams = makeBeams(BOT[b]);
                tv.draw(ctx, tStave); bv.draw(ctx, bStave);
                tBeams.forEach(function(bm){ try{bm.setContext(ctx).draw();}catch(e){} });
                bBeams.forEach(function(bm){ try{bm.setContext(ctx).draw();}catch(e){} });
                TOP[b].tupletObjs.forEach(function(t){ try{t.setContext(ctx).draw();}catch(e){} });
                BOT[b].tupletObjs.forEach(function(t){ try{t.setContext(ctx).draw();}catch(e){} });
            } else {
                var v = TV[b];
                try { new Formatter().joinVoices([v]).format([v], fw); }
                catch(e) { maxLog("fmt b"+b+": "+e.message); }
                var beams = makeBeams(TOP[b]);
                v.draw(ctx, tStave);
                beams.forEach(function(bm){ try{bm.setContext(ctx).draw();}catch(e){} });
                TOP[b].tupletObjs.forEach(function(t){ try{t.setContext(ctx).draw();}catch(e){} });
            }
            curX += sw;
        }

        ctx.save();
        ctx.setFillStyle("#888888");
        var barLabel = actual > 1
            ? ("bar " + (startBar+1) + "-" + (endBar+1) + " / " + numBars)
            : ("bar " + (startBar+1) + " / " + numBars);
        ctx.fillText(barLabel, 12, 12);
        ctx.restore();

        var dbg = document.getElementById("dbg");
        if (dbg) dbg.textContent = barLabel + " notes:" + clipNotes.length
                                 + (barMeters.length ? " meters:" + barMeters.length : "");

        var svgEl = container.querySelector("svg");
        if (svgEl) {
            svgEl.setAttribute("viewBox", "0 0 " + W_virtual + " " + H_virtual);
            svgEl.setAttribute("width", "100%");
            svgEl.setAttribute("height", "100%");
            svgEl.setAttribute("preserveAspectRatio", "xMidYMid meet");
        }
    } catch(e) { maxLog("### Render Error: " + e.message); }
}

function setMetersFromList(args) {
    var m = [];
    for (var i = 0; i + 1 < args.length; i += 2) {
        var n = Math.round(args[i]), d = Math.round(args[i+1]);
        if (n > 0 && d > 0) m.push({ num: n, den: d });
    }
    barMeters = m;
}

var _maxBound = false;
function setupMaxBindings() {
    if (_maxBound) return;
    if (!window.max) return;
    _maxBound = true;
    var dbg = document.getElementById("dbg");
    if (dbg) dbg.textContent = "max ready";

    window.max.bindInlet("clip_data", function(jsonStr) {
        try { var data = JSON.parse(jsonStr); if (data && data.notes) { clipNotes = data.notes; draw(); } }
        catch(e) { maxLog("JSON parse: " + e.message); }
    });
    window.max.bindInlet("bar_index", function(n) { currentBar = Math.max(0, Math.floor(n)); draw(); });
    window.max.bindInlet("bar_next", function() { currentBar = Math.min(currentBar + 1, getNumBars() - 1); draw(); });
    window.max.bindInlet("bar_prev", function() { currentBar = Math.max(0, currentBar - 1); draw(); });
    window.max.bindInlet("timesig", function(n, d) { timeSig.num = n; timeSig.den = d; draw(); });
    window.max.bindInlet("meters", function() { setMetersFromList(Array.prototype.slice.call(arguments)); currentBar = 0; draw(); });
    window.max.bindInlet("meters_clear", function() { barMeters = []; draw(); });
    window.max.bindInlet("key", function(idx) { applyKeyIndex(idx); draw(); });
    window.max.bindInlet("clef", function(i) { clefMode = Math.max(0, Math.min(3, Math.floor(i))); draw(); });
    window.max.bindInlet("reset", function() { clipNotes = []; currentBar = 0; barMeters = []; draw(); });
}

setupMaxBindings();
var _pollTimer = setInterval(function() {
    if (_maxBound) { clearInterval(_pollTimer); return; }
    setupMaxBindings();
}, 50);
setTimeout(function() { clearInterval(_pollTimer); }, 5000);

draw();
