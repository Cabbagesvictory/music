/* ===========================================================
   renderer.js — Canvas 绘制层
   横向钢琴键盘 + 上方瀑布流谱面（piano roll）
   支持缩放、平移、演奏跟随
   =========================================================== */
(function (global) {
  'use strict';

  var BLACK_PC = { 1: 1, 3: 1, 6: 1, 8: 1, 10: 1 };
  function isBlackKey(m) { return !!BLACK_PC[((m % 12) + 12) % 12]; }

  /* 键盘固定为完整 88 键：A0(21) ~ C8(108) */
  var KEY_LOW = 21;
  var KEY_HIGH = 108;

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  /* 配色：暖沙背景；左手蓝、右手杏黄，各自白键浅 / 黑键深，全平面无发光 */
  var COL = {
    bg: '#f5e8d6',
    ink: '59, 42, 30',
    keyW: '#fcf8f1',
    keyB: '#241c16',
    lhWhite: '#b8dcf0',
    lhBlack: '#5f93bd',
    lhWhiteOn: '#a6d2ec',
    lhBlackOn: '#6f9fc8',
    rhWhite: '#f5d0a3',
    rhBlack: '#cf8c46',
    rhWhiteOn: '#f2c894',
    rhBlackOn: '#daa05c'
  };

  /** 音符属于哪只手：优先用解析时标注的结果，缺失时按音高分界 */
  function noteHand(n) {
    if (n.hand === 'L' || n.hand === 'R') return n.hand;
    return n.midi < 60 ? 'L' : 'R';
  }

  /** 按下时的键色：左手蓝、右手杏黄，白键浅、黑键深 */
  function onKeyColor(hand, black) {
    if (hand === 'L') return black ? COL.lhBlackOn : COL.lhWhiteOn;
    return black ? COL.rhBlackOn : COL.rhWhiteOn;
  }

  /** 有序数组中第一个 start >= t 的下标 */
  function lowerBound(arr, t) {
    var lo = 0, hi = arr.length;
    while (lo < hi) {
      var mid = (lo + hi) >> 1;
      if (arr[mid].start < t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  var R = {
    canvas: null,
    ctx: null,
    W: 0, H: 0, dpr: 1,
    keyH: 150, hitY: 0,
    low: KEY_LOW, high: KEY_HIGH,
    zoom: 1, viewLeft: 0, kw: 0, totalW: 0,
    whites: [], keyMap: new Map(),
    pps: 100, lookAhead: 4.2,
    notes: [], bpm: 72, beatsPerBar: 4, barLines: [], songDuration: 0,
    maxDur: 2,
    glow: new Map(),
    flash: new Map(),
    snapshot: null,
    snapshotAt: 0,
    _painted: false,
    _lastTime: null,
    _lastPlaying: false,
    follow: true,
    layoutDirty: true,
    _cx: null, _cn: 0
  };

  /* ------------------------------------------------------------
     初始化
     ------------------------------------------------------------ */

  R.init = function (canvas) {
    R.canvas = canvas;
    // 用透明画布：即使背面缓冲被清空，露出的也是 CSS 底色而不是黑
    R.ctx = canvas.getContext('2d');
    R.resize();
    if (typeof ResizeObserver !== 'undefined') {
      var ro = new ResizeObserver(function () { R.resize(); });
      ro.observe(canvas.parentElement || canvas);
    } else {
      global.addEventListener('resize', function () { R.resize(); });
    }
  };

  R.resize = function () {
    if (!R.canvas) return;
    var rect = R.canvas.getBoundingClientRect();
    R.dpr = Math.min(2, global.devicePixelRatio || 1);
    R.W = Math.max(1, Math.round(rect.width));
    R.H = Math.max(1, Math.round(rect.height));
    R.canvas.width = Math.round(R.W * R.dpr);
    R.canvas.height = Math.round(R.H * R.dpr);
    R.ctx.setTransform(R.dpr, 0, 0, R.dpr, 0, 0);
    R.snapshot = null;

    R.keyH = clamp(R.H * 0.27, 96, 190);
    R.hitY = R.H - R.keyH;
    R.pps = (R.hitY - 8) / R.lookAhead;
    R.layoutDirty = true;

    // 改 canvas.width/height 会把画布清空成黑色（alpha:false），
    // 先铺上底色，有上一帧的话立刻补画，避免中间被合成出一帧黑屏
    R._painted = false;
    R.ctx.fillStyle = COL.bg;
    R.ctx.fillRect(0, 0, R.W, R.H);
    if (R._lastTime !== null) R.render(R._lastTime, 0, R._lastPlaying);
  };

  /* ------------------------------------------------------------
     曲目与布局
     ------------------------------------------------------------ */

  R.setSong = function (song) {
    captureSnapshot();
    R.notes = song.notes || [];
    R.bpm = song.bpm || 72;
    R.beatsPerBar = song.beatsPerBar || 4;
    R.songDuration = song.duration || 0;
    R.barLines = song.barLines && song.barLines.length ? song.barLines : null;

    var maxDur = 0.5;
    for (var i = 0; i < R.notes.length; i++) {
      var n = R.notes[i];
      if (n.dur > maxDur) maxDur = n.dur;
    }
    R.maxDur = maxDur;

    // 无论曲目音域如何，都画一整台 88 键钢琴
    R.low = KEY_LOW;
    R.high = KEY_HIGH;

    // 重建键位映射（88 键固定，切歌不需要改范围）
    R.layoutDirty = true;
    buildBarTimes();
  };

  /** 换曲前把当前画面存一份，用于交叉淡出 */
  var SWAP_FADE_MS = 340;

  function captureSnapshot() {
    // 画布还没画过（刚 resize 或刚启动）时不要取样，否则会淡出一张黑图
    if (!R.canvas || !R.ctx || !R._painted) return;
    try {
      var c = document.createElement('canvas');
      c.width = R.canvas.width;
      c.height = R.canvas.height;
      var cctx = c.getContext('2d');
      cctx.drawImage(R.canvas, 0, 0);
      var px = cctx.getImageData(0, 0, 1, 1).data;
      if (px[0] === 0 && px[1] === 0 && px[2] === 0) {
        R.snapshot = null;
        return;
      }
      R.snapshot = c;
      R.snapshotAt = performance.now();
    } catch (e) {
      R.snapshot = null;
    }
  }

  /** 旧帧盖在新画面上淡出，遮掉切歌时的布局硬跳 */
  function drawSwapFade() {
    if (!R.snapshot) return;
    var p = (performance.now() - R.snapshotAt) / SWAP_FADE_MS;
    if (p >= 1) { R.snapshot = null; return; }

    var ctx = R.ctx;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1 - p;
    ctx.drawImage(R.snapshot, 0, 0, R.canvas.width, R.canvas.height);
    ctx.restore();
  }

  function buildBarTimes() {
    var barDur = (60 / R.bpm) * R.beatsPerBar;
    if (R.barLines && R.barLines.length) {
      R.barTimes = R.barLines.slice();
      R.barDur = barDur;
      return;
    }
    // MIDI 导入等没有小节信息时，按拍号推算
    var total = R.songDuration + 8;
    R.barDur = barDur;
    R.barTimes = [];
    for (var t = 0; t <= total; t += barDur) R.barTimes.push(t);
  }

  function layout() {
    var whites = [];
    for (var m = R.low; m <= R.high; m++) {
      if (!isBlackKey(m)) whites.push(m);
    }
    if (!whites.length) return;

    var kw = (R.W / whites.length) * R.zoom;
    var map = new Map();
    for (var i = 0; i < whites.length; i++) {
      map.set(whites[i], { x: i * kw, w: kw, black: false });
    }
    for (var j = 0; j < whites.length; j++) {
      var next = whites[j] + 1;
      if (next <= R.high && isBlackKey(next)) {
        var bw = kw * 0.6;
        map.set(next, { x: (j + 1) * kw - bw / 2, w: bw, black: true });
      }
    }

    R.whites = whites;
    R.keyMap = map;
    R.kw = kw;
    R.totalW = kw * whites.length;
    R.layoutDirty = false;
  }

  function clampView() {
    if (R.totalW <= R.W + 0.5) {
      R.viewLeft = (R.W - R.totalW) / 2;
    } else {
      R.viewLeft = clamp(R.viewLeft, R.W - R.totalW, 0);
    }
  }

  /* ------------------------------------------------------------
     缩放 / 平移
     ------------------------------------------------------------ */

  R.setZoom = function (z, anchorX) {
    var before = R.zoom;
    var next = clamp(z, 1, 3.2);
    if (Math.abs(next - before) < 0.0001) return;
    var ax = (anchorX === undefined) ? R.W / 2 : anchorX;
    var fitX = (ax - R.viewLeft) / before;   // 锚点对应的“适应态”坐标
    R.zoom = next;
    layout();
    R.viewLeft = ax - fitX * next;
    clampView();
  };

  R.getZoom = function () { return R.zoom; };
  R.getViewLeft = function () { return R.viewLeft; };
  R.setViewLeft = function (v) { R.viewLeft = v; clampView(); };
  R.getKeyWidth = function () { return R.kw; };
  R.setFollow = function (on) { R.follow = !!on; };

  /* ------------------------------------------------------------
     命中测试 / 试弹高亮
     ------------------------------------------------------------ */

  R.hitTest = function (x, y) {
    if (y < R.hitY - 1) return null;
    var i, k, kx;
    // 黑键在上层
    for (i = R.low; i <= R.high; i++) {
      if (!isBlackKey(i)) continue;
      k = R.keyMap.get(i);
      if (!k) continue;
      kx = R.viewLeft + k.x;
      if (x >= kx && x <= kx + k.w && y <= R.hitY + R.keyH * 0.63) {
        return { midi: i, black: true };
      }
    }
    for (i = 0; i < R.whites.length; i++) {
      var m = R.whites[i];
      k = R.keyMap.get(m);
      if (!k) continue;
      kx = R.viewLeft + k.x;
      if (x >= kx && x <= kx + k.w) return { midi: m, black: false };
    }
    return null;
  };

  R.pressFlash = function (midi) {
    R.flash.set(midi, performance.now() + 420);
  };

  /* ------------------------------------------------------------
     主绘制
     ------------------------------------------------------------ */

  R.render = function (time, dt, playing) {
    if (!R.ctx) return;
    if (R.layoutDirty) { layout(); clampView(); }

    // 演奏跟随：把正在演奏的音符推到画面偏左处
    if (playing && R.follow && R.zoom > 1.02 && R._cx !== null && R._cn > 0) {
      var target = R.W * 0.42 - R._cx * R.zoom;
      if (R.totalW > R.W + 0.5) {
        R.viewLeft += (target - R.viewLeft) * clamp(dt * 2.4, 0, 1);
        clampView();
      }
    }

    var ctx = R.ctx;
    drawBackdrop();
    drawGrid(time);

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, R.W, R.hitY);
    ctx.clip();
    drawNotes(time);
    ctx.restore();

    drawHitLine();
    drawKeys(performance.now());
    drawSwapFade();

    R._lastTime = time;
    R._lastPlaying = playing;
    R._painted = true;
  };

  function drawBackdrop() {
    var ctx = R.ctx;
    ctx.fillStyle = COL.bg;
    ctx.fillRect(0, 0, R.W, R.H);
  }

  function drawGrid(time) {
    var ctx = R.ctx;
    var beatDur = 60 / R.bpm;
    var bars = R.barTimes;
    if (!bars || !bars.length) return;

    var endT = time + R.lookAhead;
    ctx.save();
    ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';

    // 拍线（淡）
    ctx.strokeStyle = 'rgba(' + COL.ink + ', 0.07)';
    ctx.lineWidth = 1;
    var firstBeat = Math.floor(time / beatDur);
    for (var bi = firstBeat; bi * beatDur <= endT; bi++) {
      var tb = bi * beatDur;
      if (tb < time - 0.01) continue;
      var yb = R.hitY - (tb - time) * R.pps;
      if (yb < -2 || yb > R.hitY) continue;
      ctx.beginPath();
      ctx.moveTo(0, Math.round(yb) + 0.5);
      ctx.lineTo(R.W, Math.round(yb) + 0.5);
      ctx.stroke();
    }

    // 小节线（亮） + 小节号
    for (var i = 0; i < bars.length; i++) {
      var tb2 = bars[i];
      if (tb2 > endT) break;
      if (tb2 < time - 0.4) continue;
      var y = R.hitY - (tb2 - time) * R.pps;
      if (y < -2 || y > R.hitY) continue;
      var fade = clamp((R.hitY - y) / 60, 0, 1);
      ctx.strokeStyle = 'rgba(' + COL.ink + ',' + (0.17 * fade) + ')';
      ctx.beginPath();
      ctx.moveTo(0, Math.round(y) + 0.5);
      ctx.lineTo(R.W, Math.round(y) + 0.5);
      ctx.stroke();

      if (R.kw > 16) {
        ctx.fillStyle = 'rgba(' + COL.ink + ',' + (0.42 * fade) + ')';
        ctx.fillText(String(i + 1), 12, y - 7);
      }
    }
    ctx.restore();
  }

  function drawNotes(time) {
    var ctx = R.ctx;
    var from = lowerBound(R.notes, time - R.maxDur - 0.2);
    var endT = time + R.lookAhead;
    var sumX = 0, count = 0;
    var i, n, end, k;

    R.glow.clear();

    // 第一遍：按键高亮 + 视窗跟随焦点
    for (i = from; i < R.notes.length; i++) {
      n = R.notes[i];
      if (n.start > endT) break;
      end = n.start + n.dur;

      // 亮键与块体严格同源：块体在键盘线上还留有可见残头时才点亮，
      // 块体完全沉入键盘的同时键就熄灭，不再出现“空键盘上色”
      if (n.start <= time && (end - time) * R.pps >= 0.5) R.glow.set(n.midi, noteHand(n));

      if (n.start > time - 0.6 && n.start < time + 2.6) {
        k = R.keyMap.get(n.midi);
        if (k) { sumX += (k.x + k.w / 2) / R.zoom; count++; }
      }
    }

    if (count) { R._cx = sumX / count; R._cn = count; }
    else { R._cn = 0; }

    // 第二遍：先白键音符，再黑键音符（黑键压在上层）
    for (var pass = 0; pass < 2; pass++) {
      for (i = from; i < R.notes.length; i++) {
        n = R.notes[i];
        if (n.start > endT) break;
        end = n.start + n.dur;
        k = R.keyMap.get(n.midi);
        if (!k) continue;
        if ((pass === 0) === k.black) continue;

        var x = R.viewLeft + k.x;
        if (x + k.w < -24 || x > R.W + 24) continue;
        // 块体下沿对准音符起点：起音瞬间底边刚好压到键盘线上，
        // 余下的时值继续向下沉入键盘，避免长音整个提前“贴”在键盘上
        var yBottom = R.hitY - (n.start - time) * R.pps;
        var h = Math.max(3, n.dur * R.pps);
        var yTop = yBottom - h;
        if (yTop > R.hitY || yBottom < -4) continue;
        if (end <= time) continue;

        drawNoteBody(ctx, x, yTop, k.w, h, k.black, noteHand(n));
      }
    }
  }

  function drawNoteBody(ctx, x, y, w, h, black, hand) {
    // 与琴键用同一套取整规则，保证块体和键同列同宽
    var nx = Math.round(x);
    var nw = Math.max(1, Math.round(w));

    ctx.fillStyle = black
      ? (hand === 'L' ? COL.lhBlack : COL.rhBlack)
      : (hand === 'L' ? COL.lhWhite : COL.rhWhite);
    ctx.fillRect(nx, y, nw, h);
  }

  function drawHitLine() {
    var ctx = R.ctx;
    var y = Math.round(R.hitY) - 0.5;
    ctx.strokeStyle = 'rgba(' + COL.ink + ', 0.28)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(R.W, y);
    ctx.stroke();
  }

  function drawKeys(now) {
    var ctx = R.ctx;
    var y0 = R.hitY;
    var h = R.keyH;
    var i, m, k, x, w;

    // ---- 白键 ----
    for (i = 0; i < R.whites.length; i++) {
      m = R.whites[i];
      k = R.keyMap.get(m);
      if (!k) continue;
      x = R.viewLeft + k.x;
      w = k.w;
      if (x + w < -2 || x > R.W + 2) continue;

      var kx = Math.round(x);
      var kw2 = Math.max(1, Math.round(w));
      var handW = R.glow.get(m);
      var onKey = !!handW || flashLevel(m, now) > 0.01;

      ctx.fillStyle = onKey ? onKeyColor(handW || 'R', false) : COL.keyW;
      ctx.fillRect(kx, y0, kw2, h);

      // 键缝
      ctx.strokeStyle = 'rgba(90, 64, 43, 0.22)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, y0);
      ctx.lineTo(Math.round(x) + 0.5, y0 + h - 4);
      ctx.stroke();

      // C 音标记（88 键时键宽更窄，放宽阈值让 C1~C8 都标得出来）
      if (m % 12 === 0 && w > 12) {
        ctx.fillStyle = 'rgba(59, 42, 30, 0.46)';
        ctx.font = (w > 20 ? 9 : 8) + 'px ui-monospace, Menlo, monospace';
        ctx.textAlign = 'center';
        ctx.fillText('C' + (m / 12 - 1), x + w / 2, y0 + h - 9);
        ctx.textAlign = 'left';
      }
    }

    // ---- 黑键 ----
    for (m = R.low; m <= R.high; m++) {
      if (!isBlackKey(m)) continue;
      k = R.keyMap.get(m);
      if (!k) continue;
      x = R.viewLeft + k.x;
      w = k.w;
      if (x + w < -2 || x > R.W + 2) continue;

      var bh = h * 0.63;
      var bx = Math.round(x);
      var bw2 = Math.max(1, Math.round(w));
      var handB = R.glow.get(m);
      var onKeyB = !!handB || flashLevel(m, now) > 0.01;

      ctx.save();
      ctx.beginPath();
      ctx.rect(0, y0, R.W, R.keyH);
      ctx.clip();
      ctx.shadowColor = 'rgba(74, 50, 32, 0.28)';
      ctx.shadowBlur = 6;
      ctx.shadowOffsetY = 2;

      ctx.fillStyle = onKeyB ? onKeyColor(handB || 'R', true) : COL.keyB;
      ctx.fillRect(bx, y0, bw2, bh);
      ctx.restore();
    }
  }

  function flashLevel(midi, now) {
    var until = R.flash.get(midi);
    if (!until) return 0;
    var left = until - now;
    if (left <= 0) { R.flash.delete(midi); return 0; }
    return Math.min(1, left / 420);
  }

  global.PianoRenderer = R;
})(window);