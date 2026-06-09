// ================================================================
// m4l_score.js  v6
//
// 主な修正:
//  1. formatToStave() 使用 → ト音記号・拍子記号スペースを自動除外して正確な音符間隔
//  2. 音符種別ごとの幅テーブル → 全音符は広く、32分は狭く
//  3. M4L エフェクトエリア 169px 対応 → ROW_H=120, STAVE_Y=22
//  4. align_rests: true → 休符を拍の位置に正しく配置
//
// 将来の2段表示（右手・左手）設計メモ:
//  - 1小節あたり treble Stave + bass Stave を y 方向に並べる
//  - joinVoices を stave ごとに分けて呼ぶ (accidental collision 対策)
//  - formatToStave([trebleV, bassV], trebleStave) で横位置を統一
//  - StaveConnector(trebleStave, bassStave).setType(StaveConnector.type.BRACE) でブレース
//  - device height を約 280px に拡張 (Presentation モードで patcher サイズ調整)
// ================================================================

window.onerror = function(msg, src, line) {
    if (window.max && max.post) max.post("ERR: " + msg + " L:" + line);
    return false;
};
function maxLog(m) { if (window.max && max.post) max.post("LOG: " + m); }

const { Renderer, Stave, StaveNote, Voice, Formatter,
        Accidental, Barline, Beam, Tuplet, Dot } = Vex.Flow;

const container = document.getElementById("score-container");

let currentLiveNotes = new Set();
let clipNotes = [];
let timeSig   = { num: 4, den: 4 };

// ── 定数 ──────────────────────────────────────────────────────────
const TPBEAT  = 480;
const TOL     = 12;
const ROW_H   = 120;   // 1段あたり高さ (M4L 169px に合わせて縮小)
const STAVE_Y = 22;    // 各段内の五線 Y オフセット

// 音符テーブル
const STD_NOTES = [
    {t:1920,v:"w"}, {t:1440,v:"hd"},{t:960,v:"h"}, {t:720,v:"qd"},
    {t:480, v:"q"}, {t:360, v:"8d"},{t:240,v:"8"}, {t:180,v:"16d"},
    {t:120, v:"16"},{t:90,  v:"32d"},{t:60, v:"32"}
];

// 休符テーブル（ドットなし ← VexFlow 互換性確保）
const REST_VALS = [
    {t:1920,v:"wr"},{t:960,v:"hr"},{t:480,v:"qr"},
    {t:240,v:"8r"}, {t:120,v:"16r"},{t:60,v:"32r"}
];

// 連符定義
const TUPLETS = [
    {n:3,t:320,total:960, vex:"q", occ:2},
    {n:3,t:160,total:480, vex:"8", occ:2},
    {n:3,t: 80,total:240, vex:"16",occ:2},
    {n:5,t:192,total:960, vex:"8", occ:4},
    {n:5,t: 96,total:480, vex:"16",occ:4},
    {n:6,t:160,total:960, vex:"8", occ:4},
    {n:6,t: 80,total:480, vex:"16",occ:4},
];

// 音符種別ごとの基本幅 (px) ─ 長い音符ほど広く
const NOTE_W = { w:52, h:42, q:34, "8":28, "16":23, "32":19 };

// ── ユーティリティ ────────────────────────────────────────────────
function midiToKey(midi) {
    const n = ["c","c#","d","d#","e","f","f#","g","g#","a","a#","b"];
    return n[midi % 12] + "/" + (Math.floor(midi / 12) - 1);
}

function snapStd(ticks) {
    let best = STD_NOTES[STD_NOTES.length-1], diff = Infinity;
    for (const d of STD_NOTES) {
        const e = Math.abs(ticks - d.t);
        if (e < diff) { diff = e; best = d; }
    }
    return best;
}

function makeRests(ticks) {
    const rests = [];
    while (ticks >= 60) {
        let found = false;
        for (const rv of REST_VALS) {
            if (rv.t <= ticks) {
                rests.push(new StaveNote({ keys: ["b/4"], duration: rv.v }));
                ticks -= rv.t;
                found = true; break;
            }
        }
        if (!found) break;
    }
    return rests;
}

// ── 音符生成
//   VexFlow 4 では Dot.buildAndAttach() を明示的に呼ばないとドットが描画されない
// ─────────────────────────────────────────────────────────────────
function makeNote(pitches, vexDur) {
    const keys = pitches.slice().sort((a,b)=>a-b).map(midiToKey);
    const note = new StaveNote({ keys, duration: vexDur });

    // ドット描画: VexFlow 4 必須
    if (vexDur.includes("d") && !vexDur.endsWith("r")) {
        try { Dot.buildAndAttach([note]); } catch(e) {}
    }

    note.setStyle({ fillStyle: "black", strokeStyle: "black" });
    keys.forEach((k, i) => {
        if (k.includes("#")) note.addModifier(new Accidental("#"), i);
    });
    return note;
}

function groupByTick(events) {
    const map = {};
    for (const e of events) {
        if (!map[e.st]) map[e.st] = { tick: e.st, dur: 0, pitches: [] };
        map[e.st].pitches.push(e.pitch);
        map[e.st].dur = Math.max(map[e.st].dur, e.dur);
    }
    return Object.values(map).sort((a,b) => a.tick - b.tick);
}

function tryDetectTuplet(groups, gi) {
    const g0 = groups[gi];
    const candidates = TUPLETS
        .filter(d => Math.abs(g0.dur - d.t) <= TOL)
        .sort((a,b) => b.n - a.n);

    for (const def of candidates) {
        if (gi + def.n > groups.length) continue;
        let ok = true;
        for (let j = 1; j < def.n; j++) {
            if (Math.abs(groups[gi+j].dur - def.t) > TOL) { ok = false; break; }
        }
        if (!ok) continue;
        const lg   = groups[gi + def.n - 1];
        const span = lg.tick + lg.dur - g0.tick;
        if (Math.abs(span - def.total) > TOL * def.n) continue;
        return { def, grps: groups.slice(gi, gi + def.n), tick: g0.tick, total: def.total };
    }
    return null;
}

// ── Pass 1: 小節データ構築 ─────────────────────────────────────────
function buildBarData(barStart, barEnd, allEvents) {
    const barEvents = allEvents.filter(e => e.st >= barStart && e.st < barEnd);
    const groups    = groupByTick(barEvents);

    const timeline = [];
    let gi = 0;
    while (gi < groups.length) {
        const tup = tryDetectTuplet(groups, gi);
        if (tup) {
            timeline.push({ type:"tup", tick:tup.tick, total:tup.total,
                            def:tup.def, grps:tup.grps });
            gi += tup.def.n;
        } else {
            const g = groups[gi];
            const fitsInBar = (g.tick + g.dur) <= barEnd;
            if (fitsInBar) {
                // 完全にバー内 → 元 dur でスナップ（付点もそのまま）
                const snp = snapStd(g.dur);
                timeline.push({ type:"note", tick:g.tick, vexDur:snp.v, adv:snp.t, grp:g });
            } else {
                // バーまたぎ → 利用可能長にキャップ（小節線整合優先）
                const avail = barEnd - g.tick;
                const snp   = snapStd(avail);
                timeline.push({ type:"note", tick:g.tick, vexDur:snp.v,
                                adv:Math.min(snp.t, avail), grp:g });
            }
            gi++;
        }
    }

    const tickables      = [];
    const beamCandidates = [];
    const tupletObjs     = [];
    let cursor = barStart;

    for (const item of timeline) {
        const gap = item.tick - cursor;
        if (gap > 30) {
            makeRests(gap).forEach(r => tickables.push(r));
            cursor += gap;
        }

        if (item.type === "note") {
            const note = makeNote(item.grp.pitches, item.vexDur);
            tickables.push(note);
            if (["8","8d","16","16d","32","32d"].includes(item.vexDur))
                beamCandidates.push(note);
            cursor = item.tick + item.adv;

        } else {
            const tnotes = item.grps.map(grp => {
                const n = makeNote(grp.pitches, item.def.vex);
                beamCandidates.push(n);
                return n;
            });
            tnotes.forEach(n => tickables.push(n));
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

    const rem = barEnd - cursor;
    if (rem > 30) makeRests(rem).forEach(r => tickables.push(r));

    return { tickables, beamCandidates, tupletObjs };
}

// ── 小節幅計算
//   音符種別ごとの基本幅 + 臨時記号スペース + 付点スペース
//   ※ formatToStave が stave.getNoteEndX()-getNoteStartX() を使うので、
//      ここで返すのは「音符エリア」の自然幅のみ。
//      クレフ・拍子記号のスペースは呼び出し側で別途加算する。
// ─────────────────────────────────────────────────────────────────
function calcNoteAreaWidth(tickables) {
    let w = 0;
    for (const t of tickables) {
        try {
            if (t.isRest()) {
                w += 24;
            } else {
                const dur  = t.getDuration();          // "w","h","q","8","16","32"
                const hasDot = t.dots > 0;
                const keys = t.getKeys();
                const accs = keys.filter(k => k.includes("#") || k.includes("b")).length;
                const base = NOTE_W[dur] || 26;
                w += base
                   + (hasDot ? 14 : 0)
                   + Math.max(0, keys.length - 1) * 8
                   + accs * 18;                        // 臨時記号は横幅を多く取る
            }
        } catch(_) { w += 26; }
    }
    return Math.max(w, 55);
}

// ── メイン描画 ─────────────────────────────────────────────────────
//
// [formatToStave について]
//  Formatter.format(voices, width) は width を外から渡す。
//  しかし stave にはクレフ・拍子記号のスペースがあり、
//  実際に音符が描画できるエリアは stave.getNoteEndX() - stave.getNoteStartX()。
//  format() に stave 幅そのままを渡すと音符がはみ出す。
//
//  formatToStave(voices, stave) は内部で
//    stave.getNoteEndX() - stave.getNoteStartX()
//  を自動計算して format() に渡す。
//  つまり「クレフ・拍子記号の幅を除いた正確な音符エリア」を使うため
//  音符間隔が正しくなる。
// ─────────────────────────────────────────────────────────────────
function draw() {
    try {
        if (!container) return;
        container.innerHTML = "";

        const TPBAR = timeSig.num * TPBEAT;

        let numBars = 1;
        if (clipNotes.length > 0) {
            const maxEnd = clipNotes.reduce((mx, n) =>
                Math.max(mx, Math.round((n.start_time + n.duration) * TPBEAT)), 0);
            numBars = Math.ceil(maxEnd / TPBAR);
        }

        const allEvents = clipNotes.map(n => ({
            st:    Math.round(n.start_time * TPBEAT),
            dur:   Math.round(n.duration   * TPBEAT),
            pitch: n.pitch
        }));

        // Pass 1: 全小節データ構築
        const allBarData = [];
        for (let bar = 0; bar < numBars; bar++) {
            allBarData.push(buildBarData(bar * TPBAR, (bar + 1) * TPBAR, allEvents));
        }

        // Pass 2: 小節幅計算
        //  staveWidth = noteAreaWidth + (クレフ・拍子記号等の非音符幅)
        //
        //  VexFlow stave 内訳 (実測近似値):
        //    ト音記号 + 拍子記号: ~90px  → 1小節目
        //    ト音記号のみ:        ~50px  → 各段の先頭 (2段目以降)
        //    なし:                ~18px  → それ以外
        const CLEF_TIMESIG_W = 90;  // 最初の小節
        const CLEF_ONLY_W    = 50;  // 各段先頭（2段目以降）
        const NO_CLEF_W      = 18;  // 通常小節

        const noteAreaWidths = allBarData.map(d => calcNoteAreaWidth(d.tickables));

        // stave 幅 (初回計算時は各段先頭かどうか不明なので仮置き、段組み後に最終確定)
        // → 段組み後に再計算するため、ここでは仮幅を計算
        const approxWidths = noteAreaWidths.map((nw, i) =>
            nw + (i === 0 ? CLEF_TIMESIG_W : NO_CLEF_W));

        // Pass 3: 段組み
        const ROW_WIDTH = Math.max((window.innerWidth || 900) - 24, 300);

        const rows = [];
        let curRow = [], curW = 0;
        approxWidths.forEach((w, i) => {
            if (curRow.length > 0 && curW + w > ROW_WIDTH) {
                rows.push(curRow);
                curRow = [];
                curW   = 0;
            }
            curRow.push(i);
            curW += w;
        });
        if (curRow.length > 0) rows.push(curRow);

        // Pass 4: 各段の小節幅を確定
        //  段の先頭小節のスペースを CLEF_ONLY_W で更新 (2段目以降)
        const finalWidths = approxWidths.slice();
        rows.forEach((row, ri) => {
            if (ri === 0) return;                         // 1段目はすでに CLEF_TIMESIG_W
            const firstBarIdx = row[0];
            finalWidths[firstBarIdx] = noteAreaWidths[firstBarIdx] + CLEF_ONLY_W;
        });

        // SVG サイズ
        const svgWidth  = ROW_WIDTH + 10;
        const svgHeight = rows.length * ROW_H + 10;

        // Pass 5: SVG 初期化
        const renderer = new Renderer(container, Renderer.Backends.SVG);
        renderer.resize(svgWidth, svgHeight);
        const ctx = renderer.getContext();
        ctx.setFont("Arial", 10, "");

        // Pass 6: 段ごとに描画
        rows.forEach((row, rowIdx) => {
            const staveTopY = rowIdx * ROW_H + STAVE_Y;
            let x = 10;

            row.forEach(bar => {
                const d = allBarData[bar];
                const w = finalWidths[bar];

                const isFirst    = bar === 0;
                const isFirstRow = x === 10;
                const isLast     = bar === numBars - 1;

                // ── Stave 構築 ──
                const stave = new Stave(x, staveTopY, w);
                if (isFirst) {
                    stave.addClef("treble")
                         .addTimeSignature(timeSig.num + "/" + timeSig.den);
                } else if (isFirstRow) {
                    stave.addClef("treble");   // 2段目以降の先頭はクレフのみ
                }
                if (isLast) stave.setEndBarType(Barline.type.END);
                stave.setContext(ctx).draw();

                // ── Voice 構築 ──
                const v = new Voice({ num_beats: timeSig.num, beat_value: timeSig.den });
                v.setStrict(false);
                v.addTickables(d.tickables);

                // ── Beam 生成 (v.draw() 前に行うことでフラグ重複を防ぐ) ──
                let beams = [];
                try { beams = Beam.generateBeams(d.beamCandidates); }
                catch(e) { maxLog("Beam: " + e.message); }

                // ── formatToStave で正確なノート間隔 ──
                //   stave.getNoteEndX() - stave.getNoteStartX() を自動計算
                //   → クレフ・拍子記号の幅を除いた実際の音符エリアに合わせる
                try {
                    new Formatter()
                        .joinVoices([v])
                        .formatToStave([v], stave, { align_rests: true });
                } catch(e) {
                    // フォールバック: format() で幅を手動指定
                    maxLog("formatToStave fallback: " + e.message);
                    new Formatter()
                        .joinVoices([v])
                        .format([v], Math.max(w - stave.getNoteStartX() + x - 15, 50));
                }

                v.draw(ctx, stave);
                beams.forEach(b => b.setContext(ctx).draw());
                d.tupletObjs.forEach(t => t.setContext(ctx).draw());

                x += w;
            });
        });

    } catch(e) {
        maxLog("### Render Error: " + e.message);
    }
}

// ── Max メッセージ受信 ────────────────────────────────────────────
if (window.max) {
    window.max.bindInlet('clip_data', function(jsonStr) {
        try {
            const data = JSON.parse(jsonStr);
            if (data && data.notes) { clipNotes = data.notes; draw(); }
        } catch(e) { maxLog("JSON: " + e.message); }
    });
    window.max.bindInlet('reset',   ()    => { clipNotes = []; draw(); });
    window.max.bindInlet('note_in', (p,v) => {
        v > 0 ? currentLiveNotes.add(p) : currentLiveNotes.delete(p);
        draw();
    });
    window.max.bindInlet('timesig', (n,d) => { timeSig.num = n; timeSig.den = d; draw(); });
    window.max.bindInlet('tempo',   ()    => { draw(); });
}

draw();
