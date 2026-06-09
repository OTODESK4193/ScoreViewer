// ================================================================
// m4l_score.js  v7  Phase 1
//
// [VexFlow 5.0.0 対応]
//   グローバル名: window.VexFlow（v4 の window.Vex.Flow から変更）
//
// [IOI クオンタイズエンジン]
//   start_time → 4 tick グリッド補正（3連符・5連符にも対応）
//   書くべき音価を IOI（次音符までの距離）× 実音長 で決定
//   ・実音長 >= IOI×50% → 実音長優先（サステイン・レガート）
//   ・実音長 <  IOI×50% → IOI 優先（スタッカート）
//   ・後続が休符のとき "最後の音符" の IOI が膨張する問題を
//     パターン補正（前の音符の1.5倍超 & 実音長が前より短い場合）で解決
//
// [1小節表示 + SVG viewBox 自動スケーリング]
//   currentBar で表示小節を管理（bar_index メッセージで切り替え）
//   W_virtual を音符密度から算出 → viewBox で M4L 169px に自動フィット
// ================================================================

window.onerror = function(msg, src, line) {
    if (window.max && max.post) max.post("ERR: " + msg + " L:" + line);
    return false;
};
function maxLog(m) { if (window.max && max.post) max.post("LOG: " + m); }

// ── VexFlow 5: グローバル名は window.VexFlow ───────────────────
const { Renderer, Stave, StaveNote, Voice, Formatter,
        Accidental, Barline, Beam, Tuplet, Dot,
        StaveConnector } = VexFlow;

const container = document.getElementById("score-container");

// ── 状態変数 ─────────────────────────────────────────────────────
let clipNotes  = [];
let timeSig    = { num: 4, den: 4 };
let currentBar = 0;

// ── 定数 ─────────────────────────────────────────────────────────
const TPBEAT    = 480;
const TOL       = 12;
const TUP_TOL   = 35;     // 連符検出の許容誤差（3連符レガート対応）
const GRID      = 4;      // 位置補正グリッド — 3連符(160, 80 ticks)を正しく扱うため細粒度
const IOI_RATIO = 0.50;   // IOI 判定閾値（実音長が IOI のこの割合以上なら実音長優先）
const H_VIRTUAL = 160;    // SVG 仮想高さ (px) — 固定
const K_NOTE    = 58;     // 音符 1 つあたりの仮想幅 (px)
const MIN_W     = 420;    // 最小仮想幅
const CLEF_W    = 98;     // ト音記号 + 拍子記号の幅

// 音符テーブル
const STD_NOTES = [
    {t:1920,v:"w"}, {t:1440,v:"hd"},{t:960,v:"h"}, {t:720,v:"qd"},
    {t:480, v:"q"}, {t:360, v:"8d"},{t:240,v:"8"}, {t:180,v:"16d"},
    {t:120, v:"16"},{t:90,  v:"32d"},{t:60, v:"32"}
];

// 休符テーブル（ドットなし — VexFlow 安定のため）
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

// 音符種別ごとの仮想幅（仮想 W 計算用）
const NOTE_W_MAP = { w:52, h:42, q:34, "8":28, "16":23, "32":19 };

// ── ユーティリティ ────────────────────────────────────────────────
function midiToKey(midi) {
    const n = ["c","c#","d","d#","e","f","f#","g","g#","a","a#","b"];
    return n[midi % 12] + "/" + (Math.floor(midi / 12) - 1);
}

function snapStd(ticks) {
    let best = STD_NOTES[STD_NOTES.length - 1], diff = Infinity;
    for (const d of STD_NOTES) {
        const e = Math.abs(ticks - d.t);
        if (e < diff) { diff = e; best = d; }
    }
    return best;
}

function makeRests(ticks) {
    const rests = [];
    while (ticks >= 60) {
        let ok = false;
        for (const rv of REST_VALS) {
            if (rv.t <= ticks) {
                rests.push(new StaveNote({ keys: ["b/4"], duration: rv.v }));
                ticks -= rv.t; ok = true; break;
            }
        }
        if (!ok) break;
    }
    return rests;
}

// ── 音符生成 ─────────────────────────────────────────────────────
function makeNote(pitches, vexDur) {
    const keys = pitches.slice().sort((a,b) => a-b).map(midiToKey);
    const note = new StaveNote({ keys, duration: vexDur });

    // VexFlow 4/5 共通: Dot.buildAndAttach が必須
    if (vexDur.includes("d") && !vexDur.endsWith("r")) {
        try { Dot.buildAndAttach([note]); } catch(e) {}
    }
    keys.forEach((k, i) => {
        if (k.includes("#")) note.addModifier(new Accidental("#"), i);
    });
    return note;
}

// ── IOI ベースのコードグルーピング ───────────────────────────────
//
// 書くべき音価を「次音符までの距離 (IOI)」と「実音長」の比較で決定。
// スタッカートなら IOI、サステインなら実音長を優先。
//
// 【パターン補正】
//   後続に休符があるとき、最後の音符の IOI が barEnd まで伸びて
//   音価が膨張する。前の音符の dur の 1.5 倍を超え、かつ実音長が
//   前より短い場合は、前の音符の dur に揃える。
// ─────────────────────────────────────────────────────────────────
function groupByTickIOI(events, barEnd) {
    // 1. 1/32 グリッドにスナップしてコード（和音）に集約
    const map = {};
    for (const e of events) {
        const s = Math.round(e.st / GRID) * GRID;
        if (!map[s]) map[s] = { tick: s, soundDur: 0, pitches: [] };
        map[s].pitches.push(e.pitch);
        map[s].soundDur = Math.max(map[s].soundDur, e.dur);
    }
    const groups = Object.values(map).sort((a, b) => a.tick - b.tick);

    // 2. IOI 計算 → 書くべき dur を決定
    for (let i = 0; i < groups.length; i++) {
        const nextTick = i + 1 < groups.length ? groups[i + 1].tick : barEnd;
        const ioi      = Math.min(nextTick - groups[i].tick, barEnd - groups[i].tick);
        const sound    = groups[i].soundDur;
        groups[i].dur  = sound >= ioi * IOI_RATIO ? sound : ioi;
    }

    // 3. パターン補正: dur > prev×1.5 かつ soundDur < dur×0.5 → prev に揃える
    //    ・休符前の最後の音符 IOI 膨張を解消
    //    ・連符最終音符（レガート/スタッカート両対応）の膨張も解消
    for (let i = 1; i < groups.length; i++) {
        const prev = groups[i - 1].dur;
        if (groups[i].dur > prev * 1.5 && groups[i].soundDur < groups[i].dur * 0.5) {
            groups[i].dur = Math.min(prev, barEnd - groups[i].tick);
        }
    }

    return groups;
}

// ── 連符検出 ──────────────────────────────────────────────────────
function tryDetectTuplet(groups, gi) {
    const g0 = groups[gi];
    const candidates = TUPLETS
        .filter(d => Math.abs(g0.dur - d.t) <= TUP_TOL)
        .sort((a, b) => b.n - a.n);

    for (const def of candidates) {
        if (gi + def.n > groups.length) continue;
        let ok = true;
        for (let j = 1; j < def.n; j++) {
            if (Math.abs(groups[gi + j].dur - def.t) > TUP_TOL) { ok = false; break; }
        }
        if (!ok) continue;
        const lg   = groups[gi + def.n - 1];
        const span = lg.tick + lg.dur - g0.tick;
        if (Math.abs(span - def.total) > TOL * def.n) continue;
        return { def, grps: groups.slice(gi, gi + def.n), tick: g0.tick, total: def.total };
    }
    return null;
}

// ── 小節データ構築 ────────────────────────────────────────────────
function buildBarData(barStart, barEnd, allEvents) {
    const barEvents = allEvents.filter(e => e.st >= barStart && e.st < barEnd);
    const groups    = groupByTickIOI(barEvents, barEnd);

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
                const snp = snapStd(g.dur);
                timeline.push({ type:"note", tick:g.tick, vexDur:snp.v, adv:snp.t, grp:g });
            } else {
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

// ── SVG 仮想幅の計算 ─────────────────────────────────────────────
function calcNoteVirtualW(tickables) {
    let w = 0;
    for (const t of tickables) {
        try {
            if (t.isRest()) {
                w += 24;
            } else {
                const dur    = t.getDuration();
                const hasDot = t.dots > 0;
                const keys   = t.getKeys();
                const accs   = keys.filter(k => k.includes("#") || k.includes("b")).length;
                w += (NOTE_W_MAP[dur] || 26) + (hasDot ? 14 : 0)
                   + Math.max(0, keys.length - 1) * 8 + accs * 18;
            }
        } catch(_) { w += 26; }
    }
    return Math.max(w, 60);
}

// ── メイン描画 ─────────────────────────────────────────────────────
function draw() {
    try {
        if (!container) return;
        container.innerHTML = "";

        const TPBAR    = timeSig.num * TPBEAT;
        const barStart = currentBar * TPBAR;
        const barEnd   = barStart + TPBAR;

        // 全体の小節数
        let numBars = 1;
        if (clipNotes.length > 0) {
            const maxEnd = clipNotes.reduce((mx, n) =>
                Math.max(mx, Math.round((n.start_time + n.duration) * TPBEAT)), 0);
            numBars = Math.ceil(maxEnd / TPBAR);
        }
        if (currentBar >= numBars) currentBar = Math.max(0, numBars - 1);

        const allEvents = clipNotes.map(n => ({
            st:    Math.round(n.start_time * TPBEAT),
            dur:   Math.round(n.duration   * TPBEAT),
            pitch: n.pitch
        }));

        // 現在の小節のデータ
        const d = buildBarData(barStart, barEnd, allEvents);

        // 仮想幅（音符密度に応じて拡張）
        const noteW    = calcNoteVirtualW(d.tickables);
        const W_virtual = Math.max(MIN_W, noteW + CLEF_W);

        // SVG 初期化（仮想サイズで描画）
        const renderer = new Renderer(container, Renderer.Backends.SVG);
        renderer.resize(W_virtual, H_VIRTUAL);
        const ctx = renderer.getContext();

        // デフォルト色（黒）をそのまま使用 — 白背景に黒音符で確実に表示

        // 五線譜描画
        const staveX = 10;
        const staveY = 30;
        const staveW = W_virtual - staveX * 2;
        const stave  = new Stave(staveX, staveY, staveW);
        stave.addClef("treble").addTimeSignature(timeSig.num + "/" + timeSig.den);
        stave.setEndBarType(Barline.type.END);
        stave.setContext(ctx).draw();

        // Voice & Format
        const v = new Voice({ num_beats: timeSig.num, beat_value: timeSig.den });
        v.setStrict(false);
        v.addTickables(d.tickables);

        // Beam は v.draw() 前に生成（個別フラグ抑制）
        let beams = [];
        try { beams = Beam.generateBeams(d.beamCandidates); } catch(e) {}

        // formatToStave: クレフ・拍子記号を除いた正確な音符幅を自動計算
        try {
            new Formatter()
                .joinVoices([v])
                .formatToStave([v], stave, { align_rests: true });
        } catch(e) {
            maxLog("formatToStave fallback: " + e.message);
            new Formatter().joinVoices([v]).format([v], staveW - CLEF_W - 15);
        }

        v.draw(ctx, stave);
        beams.forEach(b => b.setContext(ctx).draw());
        d.tupletObjs.forEach(t => t.setContext(ctx).draw());

        // 小節番号（左上）
        ctx.save();
        ctx.setFillStyle("#888888");
        ctx.fillText(`bar ${currentBar + 1} / ${numBars}`, staveX + 2, 14);
        ctx.restore();

        // デバッグ表示更新
        const dbg = document.getElementById("dbg");
        if (dbg) dbg.textContent = `bar ${currentBar+1}/${numBars} notes:${clipNotes.length}`;

        // ── SVG viewBox による自動スケーリング ──────────────────
        //   W_virtual × H_VIRTUAL を仮想解像度として描画し、
        //   viewBox + preserveAspectRatio で M4L 169px に自動フィット。
        //   音数が多くて仮想幅が広くても絶対に見切れない。
        const svgEl = container.querySelector("svg");
        if (svgEl) {
            svgEl.setAttribute("viewBox",              `0 0 ${W_virtual} ${H_VIRTUAL}`);
            svgEl.setAttribute("width",                "100%");
            svgEl.setAttribute("height",               "100%");
            svgEl.setAttribute("preserveAspectRatio",  "xMidYMid meet");
        }

    } catch(e) {
        maxLog("### Render Error: " + e.message);
    }
}

// ── Max メッセージ受信 ────────────────────────────────────────────
// window.max は jweb ロード後しばらくして注入される場合があるため
// ポーリングで確実にバインドする
let _maxBound = false;

function setupMaxBindings() {
    if (_maxBound) return;
    if (!window.max) return;         // まだ準備できていない
    _maxBound = true;

    const dbg = document.getElementById("dbg");
    if (dbg) dbg.textContent = "max ready";

    // クリップの全ノートデータ（JSON 文字列）
    window.max.bindInlet("clip_data", function(jsonStr) {
        try {
            const data = JSON.parse(jsonStr);
            if (data && data.notes) { clipNotes = data.notes; draw(); }
        } catch(e) { maxLog("JSON parse: " + e.message); }
    });

    // 表示小節（0始まり）— Phase 2 の ◀▶ ボタン用
    window.max.bindInlet("bar_index", function(n) {
        currentBar = Math.max(0, Math.floor(n));
        draw();
    });

    // 拍子記号
    window.max.bindInlet("timesig", function(n, d) {
        timeSig.num = n; timeSig.den = d; draw();
    });

    // リセット
    window.max.bindInlet("reset", function() {
        clipNotes = []; currentBar = 0; draw();
    });
}

// 初回チェック → 50ms ごとに最大 5 秒間ポーリング
setupMaxBindings();
const _pollTimer = setInterval(function() {
    if (_maxBound) { clearInterval(_pollTimer); return; }
    setupMaxBindings();
}, 50);
setTimeout(function() { clearInterval(_pollTimer); }, 5000);

// 初期描画（空の五線を表示）
draw();
