/* ===========================================================
   app.js — 播放控制 / 交互 / MIDI 导入
   =========================================================== */
(function (global) {
  'use strict';

  var $ = function (sel) { return document.querySelector(sel); };
  var clamp = function (v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); };

  var el = {
    splash: $('#splash'),
    enter: $('#enterBtn'),
    tip: $('#splashTip'),
    eyebrow: $('#eyebrow'),
    title: $('#songTitle'),
    meta: $('#songMeta'),
    metaText: $('#songMetaText'),
    tempoNow: $('#tempoNow'),
    stage: $('#stage'),
    hint: $('#hint'),
    play: $('#playBtn'),
    progress: $('#progress'),
    fill: $('#progressFill'),
    knob: $('#progressKnob'),
    timeNow: $('#timeNow'),
    timeTotal: $('#timeTotal'),
    volume: $('#volume'),
    volBtn: $('#volBtn'),
    volPanel: $('#volPanel'),
    toast: $('#toast'),
    songBtn: $('#songBtn'),
    songMenu: $('#songMenu'),
    songBtnText: $('#songBtnText'),
    midFile: $('#midFile')
  };

  var Tone = global.Tone;
  var Audio = global.PianoAudio;
  var Renderer = global.PianoRenderer;

  var state = {
    ready: false,
    entered: false,
    playing: false,
    taskReady: false,
    song: null,
    duration: 0,
    time: 0,
    glideSet: null,
    panning: null,
    scrub: null
  };

  var transport = null;
  var vt = 0;
  var lastTs = 0;

  /* ------------------------------------------------------------
     工具
     ------------------------------------------------------------ */

  function fmt(t) {
    t = Math.max(0, t || 0);
    var m = Math.floor(t / 60);
    var s = Math.floor(t % 60);
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  function setTip(text) {
    if (el.tip) el.tip.textContent = text;
  }

  // 手机竖屏时 CSS 会把整体旋转成横屏显示（见 style.css 末尾），
  // 此时视口坐标与画布坐标不一致，需要用 offset 坐标换算
  var rotateMq = global.matchMedia
    ? global.matchMedia('(orientation: portrait) and (pointer: coarse) and (max-width: 480px)')
    : null;

  function isRotatedView() {
    return !!(rotateMq && rotateMq.matches);
  }

  /** 顶部提示条；允许受控的 <b> 标签，外部数据必须先经 escapeHtml */
  function flashHint(text) {
    if (!el.hint) return;
    el.hint.classList.remove('fade');
    el.hint.innerHTML = text;
    clearTimeout(flashHint._t);
    flashHint._t = setTimeout(function () {
      if (el.hint) el.hint.classList.add('fade');
    }, 4200);
  }

  /** 顶栏行尾实时显示当前片段 BPM（仅变速曲） */
  function updateTempoBadge(t) {
    if (!el.tempoNow) return;
    var map = state.song && state.song.tempos;
    if (!map || map.length < 2) return;
    var bpm = map[0].bpm;
    for (var i = map.length - 1; i >= 0; i--) {
      if (t >= map[i].time) { bpm = map[i].bpm; break; }
    }
    if (bpm === el.tempoNow._bpm) return;
    el.tempoNow._bpm = bpm;
    el.tempoNow.textContent = + bpm + ' BPM';
  }

  /* ------------------------------------------------------------
     曲目绑定与调度
     ------------------------------------------------------------ */

  function bindSong(song, metaText, eyebrowText) {
    state.song = song;
    state.duration = song.duration || 0;

    Renderer.setSong(song);
    Renderer.setZoom(1);
    Renderer.setViewLeft(0);
    scheduleFrom(0);
    setPosition(0);
    vt = 0;
    state.time = 0;
    state.scrub = null;

    el.title.textContent = song.title || 'Untitled';
    document.title = (song.title || '钢琴独奏') + ' · 钢琴独奏';
    var metaEl = el.metaText || el.meta;
    if (metaText) metaEl.textContent = metaText;
    else metaEl.textContent = (song.tempoLabel || ((song.bpm || 72) + ' BPM')) + ' · ' +
      (song.beatsPerBar || 4) + '/' + (song.beatUnit || 4);
    if (el.tempoNow) {
      el.tempoNow.textContent = '';
      el.tempoNow._bpm = 0;
    }
    if (eyebrowText) el.eyebrow.textContent = eyebrowText;
    el.timeTotal.textContent = fmt(state.duration);
    el.timeNow.textContent = '0:00';
    setProgressUI(0);
  }

  function scheduleFrom(fromSeconds) {
    transport.cancel();
    var notes = state.song ? state.song.notes : [];
    for (var i = 0; i < notes.length; i++) {
      var n = notes[i];
      if (n.start < fromSeconds - 0.04) continue;
      transport.schedule(makeTrigger(n), n.start);
    }
  }

  function makeTrigger(n) {
    return function (time) {
      Audio.noteOn(n.midi, n.dur, time, n.vel);
    };
  }

  /* ------------------------------------------------------------
     播放控制
     ------------------------------------------------------------ */

  function setPlayingUI(on) {
    state.playing = on;
    if (el.play) {
      el.play.classList.toggle('playing', on);
      el.play.setAttribute('aria-label', on ? '暂停' : '播放');
    }
  }

  function getPos() {
    try { return transport.seconds || 0; } catch (e) { return 0; }
  }

  function setPosition(t) {
    // Tone 15 对 seconds 赋值是可靠的，直接用秒定位。
    // 不再用 bars:beats 兜底：Transport 的 BPM/拍号与曲目并不一致，
    // 一旦触发兜底反而会把位置算错。
    transport.seconds = t;
  }

  function seek(t) {
    if (!state.taskReady) return;
    t = clamp(t, 0, Math.max(0, state.duration));
    var wasPlaying = state.playing;
    if (wasPlaying) transport.pause();
    Audio.stopAll();
    scheduleFrom(t);
    setPosition(t);
    vt = t;
    state.time = t;
    setProgressUI(state.duration ? t / state.duration : 0);
    if (wasPlaying) transport.start('+0.06');
  }

  function beginPlay() {
    if (!state.ready || !state.taskReady) return;
    // 空曲库/载入失败时没有音符可播：避免出现“正在播放但一片空白”
    if (!state.song || !state.song.notes || !state.song.notes.length || !(state.duration > 0)) {
      flashHint('暂无可播放曲目：把 <b>.mid</b> 放进 assets 目录，或直接拖入文件');
      return;
    }
    // 采样曾加载失败时，借一次用户手势再试；成功后后续音符自动有声
    if (!Audio.isSampleMode() && typeof Audio.retrySamples === 'function') {
      Audio.retrySamples();
    }
    if (state.duration > 0 && getPos() >= state.duration - 0.2) seek(0);
    else setPosition(getPos());
    transport.start('+0.05');
    setPlayingUI(true);
    if (el.hint) el.hint.classList.add('fade');
  }

  function pause() {
    if (!state.playing) return;
    transport.pause();
    setPlayingUI(false);
    Audio.stopAll();
  }

  function togglePlay() {
    if (!state.ready) return;
    if (state.playing) pause(); else beginPlay();
  }

  /* ------------------------------------------------------------
     UI 刷新
     ------------------------------------------------------------ */

  var progressPct = -1;

  function setProgressUI(ratio) {
    var pct = clamp(ratio, 0, 1) * 100;
    // 每帧都写 DOM 会无谓标脏，数值没变就跳过
    if (Math.abs(pct - progressPct) < 0.01) return;
    progressPct = pct;
    if (el.fill) el.fill.style.width = pct.toFixed(3) + '%';
    if (el.knob) el.knob.style.left = pct.toFixed(3) + '%';
    if (el.progress) el.progress.setAttribute('aria-valuenow', String(Math.round(pct)));
  }

  var toastTimer = 0;

  /** 顶部胶囊提示，3 秒后自动消失 */
  function showToast(text) {
    if (!el.toast) return;
    el.toast.textContent = text;
    el.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.toast.classList.remove('show'); }, 3000);
  }

  function notifyZoom() {
    showToast('缩放 ' + Math.round(Renderer.getZoom() * 100) + '%');
  }

  /* ------------------------------------------------------------
     主循环
     ------------------------------------------------------------ */

  function tick(ts) {
    var dt = lastTs ? Math.min(0.05, Math.max(0, (ts - lastTs) / 1000)) : 0.016;
    lastTs = ts;

    var target = getPos();

    if (state.playing) {
      vt += dt;
      var err = target - vt;
      if (Math.abs(err) > 0.3) vt = target;
      else vt += err * 0.08;
      if (vt > target + 0.4) vt = target;

      if (state.duration > 0 && vt >= state.duration) {
        transport.pause();
        setPlayingUI(false);
        Audio.stopAll();
        vt = state.duration;
        try { transport.seconds = state.duration; } catch (err2) { /* noop */ }
      }
    } else {
      vt = target;
    }

    state.time = Math.max(0, vt);
    // 拖动进度条时只预览：画面/进度跟手，音频等松手才真正 seek
    var display = state.scrub === null ? state.time : state.scrub;
    try {
      Renderer.render(display, dt, state.playing);
    } catch (err) {
      // 单帧绘制异常不能把整个循环带死
      if (!tick._warned) {
        tick._warned = true;
        if (global.console) console.error('[render] 绘制异常：', err);
      }
    }

    var dur = state.duration || 0;
    updateTempoBadge(display);
    setProgressUI(dur ? display / dur : 0);
    var nowText = fmt(Math.min(display, dur));
    if (nowText !== tick._now) {
      tick._now = nowText;
      el.timeNow.textContent = nowText;
    }
    var totalText = fmt(dur);
    if (totalText !== tick._total) {
      tick._total = totalText;
      el.timeTotal.textContent = totalText;
    }

    requestAnimationFrame(tick);
  }

  /* ------------------------------------------------------------
     交互：画布
     ------------------------------------------------------------ */

  function canvasPoint(e) {
    // 强制横屏（CSS 旋转）时，getBoundingClientRect 返回的是旋转后的包围盒，
    // clientX/Y 相减会错位；offsetX/Y 始终相对元素自身坐标系
    if (isRotatedView()) {
      return { x: e.offsetX, y: e.offsetY };
    }
    var r = el.stage.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function bindCanvas() {
    var canvas = el.stage;

    canvas.addEventListener('pointerdown', function (e) {
      var p = canvasPoint(e);
      var hit = Renderer.hitTest(p.x, p.y);
      canvas.setPointerCapture && canvas.setPointerCapture(e.pointerId);

      if (hit) {
        Audio.noteOn(hit.midi, 1.5, undefined, 0.72);
        Renderer.pressFlash(hit.midi);
        state.glideSet = { last: hit.midi };
      } else {
        state.panning = { x: p.x, left: Renderer.getViewLeft() };
        canvas.classList.add('grabbing');
        Renderer.setFollow(false);
      }
    });

    canvas.addEventListener('pointermove', function (e) {
      var p = canvasPoint(e);
      if (state.panning) {
        Renderer.setViewLeft(state.panning.left + (p.x - state.panning.x));
        return;
      }
      if (state.glideSet) {
        var hit = Renderer.hitTest(p.x, p.y);
        if (hit && hit.midi !== state.glideSet.last) {
          state.glideSet.last = hit.midi;
          Renderer.pressFlash(hit.midi);
        }
      }
    });

    function endPointer() {
      state.panning = null;
      state.glideSet = null;
      canvas.classList.remove('grabbing');
      setTimeout(function () { Renderer.setFollow(true); }, 1800);
    }

    canvas.addEventListener('pointerup', endPointer);
    canvas.addEventListener('pointercancel', endPointer);

    canvas.addEventListener('wheel', function (e) {
      e.preventDefault();
      var p = canvasPoint(e);
      var factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
      Renderer.setZoom(Renderer.getZoom() * factor, p.x);
      notifyZoom();
    }, { passive: false });
  }

  /* ------------------------------------------------------------
     交互：控件
     ------------------------------------------------------------ */

  function bindControls() {
    el.play.addEventListener('click', togglePlay);

    el.volume.addEventListener('input', function () {
      var v = Number(el.volume.value) / 100;
      Audio.setVolume(Math.pow(v, 1.5));
    });
    Audio.setVolume(Math.pow(Number(el.volume.value) / 100, 1.5));

    // 音量：图标按钮 + 竖向滑杆浮层
    if (el.volBtn && el.volPanel) {
      var toggleVol = function (open) {
        if (open === undefined) open = el.volPanel.hidden;
        el.volPanel.hidden = !open;
        el.volBtn.classList.toggle('open', open);
        el.volBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
        if (open) el.volume.focus();
      };

      el.volBtn.addEventListener('click', function () { toggleVol(); });

      document.addEventListener('pointerdown', function (e) {
        if (el.volPanel.hidden || !e.target) return;
        if (el.volPanel.contains(e.target) || el.volBtn.contains(e.target)) return;
        toggleVol(false);
      });

      document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && !el.volPanel.hidden) toggleVol(false);
      });
    }

    // 曲库下拉：自绘列表，支持键盘导航与点外关闭
    if (el.songBtn && el.songMenu) {
      el.songBtn.addEventListener('click', function () {
        if (el.songMenu.hidden) openLibrary(); else closeLibrary(true);
      });

      el.songBtn.addEventListener('keydown', function (e) {
        if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          e.stopPropagation();
          openLibrary();
        }
      });

      el.songMenu.addEventListener('click', function (e) {
        var li = e.target && e.target.closest ? e.target.closest('.song-item') : null;
        if (li) chooseLibraryItem(li);
      });

      el.songMenu.addEventListener('keydown', function (e) {
        if (e.key === 'ArrowDown') {
          e.preventDefault(); e.stopPropagation(); moveLibraryFocus(1);
        } else if (e.key === 'ArrowUp') {
          e.preventDefault(); e.stopPropagation(); moveLibraryFocus(-1);
        } else if (e.key === 'Escape') {
          e.preventDefault(); e.stopPropagation(); closeLibrary(true);
        } else if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault(); e.stopPropagation(); chooseLibraryItem(document.activeElement);
        } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
          e.stopPropagation();
        }
      });

      document.addEventListener('pointerdown', function (e) {
        if (el.songMenu.hidden || !e.target) return;
        if (el.songMenu.contains(e.target) || el.songBtn.contains(e.target)) return;
        closeLibrary(false);
      });
    }

    // 进度条拖动：拖动期间只更新预览时间，松手才重建 Transport 事件。
    // 每次 pointermove 都 seek 会把上千个音符重新排一遍，必掉帧且会爆音
    var scrubbing = false;
    var resumeAfterScrub = false;

    function previewAt(e) {
      var ratio;
      if (isRotatedView()) {
        // 旋转后 rect 不再对应进度槽方向，改用相对 .progress 的 offset
        // （.track/.fill 已设 pointer-events:none，target 恒为 .progress）
        ratio = clamp(e.offsetX / Math.max(1, el.progress.clientWidth), 0, 1);
      } else {
        var r = el.progress.getBoundingClientRect();
        ratio = clamp((e.clientX - r.left) / Math.max(1, r.width), 0, 1);
      }
      state.scrub = ratio * state.duration;
      setProgressUI(ratio);
      el.timeNow.textContent = fmt(state.scrub);
    }

    function beginScrub(e) {
      if (!state.taskReady) return;
      scrubbing = true;
      resumeAfterScrub = state.playing;
      if (state.playing) pause();
      el.progress.setPointerCapture && el.progress.setPointerCapture(e.pointerId);
      previewAt(e);
    }

    function endScrub(cancelled) {
      if (!scrubbing) return;
      scrubbing = false;
      var target = cancelled || state.scrub === null ? getPos() : state.scrub;
      state.scrub = null;
      if (!cancelled) seek(target);
      if (resumeAfterScrub) {
        resumeAfterScrub = false;
        beginPlay();
      }
    }

    el.progress.addEventListener('pointerdown', beginScrub);
    el.progress.addEventListener('pointermove', function (e) {
      if (scrubbing) previewAt(e);
    });
    el.progress.addEventListener('pointerup', function () { endScrub(false); });
    el.progress.addEventListener('pointercancel', function () { endScrub(true); });

    // 自定义 MIDI：下拉首行触发隐藏文件选择器，解析流程与拖拽一致
    if (el.midFile) {
      el.midFile.addEventListener('change', function () {
        var f = el.midFile.files && el.midFile.files[0];
        el.midFile.value = '';   // 清空，允许重复选同一文件
        if (f) loadMidiFile(f);
      });
    }

    global.addEventListener('keydown', function (e) {
      if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
      if (e.code === 'Space') {
        e.preventDefault();
        togglePlay();
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        seek(state.time + 5);
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        seek(state.time - 5);
      } else if (e.key === '+' || e.key === '=') {
        Renderer.setZoom(Renderer.getZoom() * 1.2);
        notifyZoom();
      } else if (e.key === '-') {
        Renderer.setZoom(Renderer.getZoom() / 1.2);
        notifyZoom();
      }
    });
  }

  /* ------------------------------------------------------------
     MIDI 导入
     ------------------------------------------------------------ */

  /** 读 SMF 头里的 format 字段（-1 表示不是标准 MIDI） */
  function midiFormatOf(buf) {
    if (!buf || buf.byteLength < 10) return -1;
    var b = new Uint8Array(buf, 0, 10);
    if (String.fromCharCode(b[0], b[1], b[2], b[3]) !== 'MThd') return -1;
    return (b[8] << 8) | b[9];
  }

  function parseMidi(buf) {
    // format 2 是多段互不相关的序列，叠到同一条时间线上会完全乱掉，直接拒绝
    if (midiFormatOf(buf) === 2) {
      return Promise.reject(new Error('暂不支持 format 2（多序列）MIDI'));
    }
    return import('https://cdn.jsdelivr.net/npm/@tonejs/midi@2.0.28/+esm').then(function (mod) {
      var Midi = mod.Midi || (mod.default && mod.default.Midi);
      if (!Midi) throw new Error('MIDI 解析器不可用');
      return new Midi(buf);
    });
  }

  var HAND_SPLIT = 60;   // 单轨 MIDI 没有手别信息时，C4 以下算左手

  /** 当前是否已有一首真实曲目（非空骨架） */
  function hasPlayableSong() {
    return !!(state.song && state.song.notes && state.song.notes.length);
  }

  /** 轨道名里能直接读出左右手时优先采信 */
  function handFromTrackName(name) {
    if (!name) return '';
    if (/left|bass|低音|左手|\blh\b/i.test(name)) return 'L';
    if (/right|melody|treble|高音|右手|\brh\b/i.test(name)) return 'R';
    return '';
  }

  /** @tonejs/midi 的 Midi 对象 -> 页面用的曲目结构 */
  function midiToSong(midi, fallbackName) {
    // 轨道定手：命名优先，其余按平均音高排序，低的算左手
    var trackHand = {};
    var stats = [];
    midi.tracks.forEach(function (track, index) {
      if (track.channel === 9) return;
      var sum = 0;
      var count = 0;
      track.notes.forEach(function (n) { sum += n.midi; count++; });
      if (!count) return;
      stats.push({ index: index, mean: sum / count, hint: handFromTrackName(track.name) });
    });
    if (stats.length > 1) {
      var byPitch = stats.slice().sort(function (a, b) { return a.mean - b.mean; });
      var half = Math.ceil(byPitch.length / 2);
      for (var si = 0; si < byPitch.length; si++) {
        trackHand[byPitch[si].index] = byPitch[si].hint || (si < half ? 'L' : 'R');
      }
    }

    var notes = [];
    midi.tracks.forEach(function (track, index) {
      if (track.channel === 9) return;               // 跳过打击乐
      var trackHint = trackHand[index];
      track.notes.forEach(function (n) {
        if (!isFinite(n.time) || !isFinite(n.duration)) return;
        notes.push({
          // 渲染器只覆盖 A0–C8：超出范围的音会被播放但画不出来，
          // 也点不亮琴键，这里统一夹到 88 键范围内
          midi: Math.max(21, Math.min(108, n.midi)),
          start: Math.max(0, n.time),
          dur: Math.max(0.06, n.duration),
          vel: clamp(0.22 + n.velocity * 0.9, 0.05, 1),
          hand: trackHint || (n.midi < HAND_SPLIT ? 'L' : 'R')
        });
      });
    });
    if (!notes.length) throw new Error('这个 MIDI 里没有音符');

    notes.sort(function (a, b) { return a.start - b.start; });

    var end = 0;
    for (var i = 0; i < notes.length; i++) {
      end = Math.max(end, notes[i].start + notes[i].dur);
    }

    // 速度标记可能多次变化：bpm 取首值作默认，顶栏显示区间
    var tempos = (midi.header && midi.header.tempos) ? midi.header.tempos : [];
    var firstBpm = tempos.length ? Math.round(tempos[0].bpm || 0) : 0;
    var tempo = clamp(firstBpm || 120, 20, 300);
    var minBpm = 0;
    var maxBpm = 0;
    for (var ti = 0; ti < tempos.length; ti++) {
      var bpmAt = Math.round(tempos[ti].bpm || 0);
      if (bpmAt < 20 || bpmAt > 300) continue;
      if (!minBpm || bpmAt < minBpm) minBpm = bpmAt;
      if (bpmAt > maxBpm) maxBpm = bpmAt;
    }
    if (!minBpm) { minBpm = tempo; maxBpm = tempo; }
    var tempoLabel = maxBpm - minBpm >= 1 ? (minBpm + '–' + maxBpm + ' BPM') : (tempo + ' BPM');

    // 实时 BPM 用：记录每个速度事件的时间点（秒），并去掉相邻重复值
    var tempoMap = null;
    try {
      if (tempos.length > 1 && midi.header && typeof midi.header.ticksToSeconds === 'function') {
        var points = [];
        for (var tj = 0; tj < tempos.length; tj++) {
          var ev = tempos[tj];
          var evBpm = Math.round(ev.bpm || 0);
          if (evBpm < 20 || evBpm > 300) continue;
          var evTime = (typeof ev.time === 'number' && isFinite(ev.time))
            ? ev.time
            : midi.header.ticksToSeconds(ev.ticks || 0);
          if (!isFinite(evTime)) continue;
          points.push({ time: Math.max(0, evTime), bpm: evBpm });
        }
        points.sort(function (a, b) { return a.time - b.time; });
        var compact = [];
        for (var pk = 0; pk < points.length; pk++) {
          if (!compact.length || compact[compact.length - 1].bpm !== points[pk].bpm) {
            compact.push(points[pk]);
          }
        }
        if (compact.length > 1) tempoMap = compact;
      }
    } catch (e) {
      tempoMap = null;
    }

    var ts = 4;
    var beatUnit = 4;
    if (midi.header.timeSignatures && midi.header.timeSignatures.length) {
      var sig = midi.header.timeSignatures[0].timeSignature;
      if (sig && sig[0]) ts = sig[0];
      if (sig && sig[1]) beatUnit = sig[1];
    }

    // 小节线要按真实 tempo map 换算；只拿首个 BPM 均匀铺会在变速曲里
    // 越走越偏（本仓库两首曲子都是变速的）
    var barLines = null;
    try {
      var head = midi.header;
      if (head && typeof head.ticksToSeconds === 'function') {
        var lastTick = 0;
        midi.tracks.forEach(function (track) {
          track.notes.forEach(function (n) {
            var noteEnd = (n.ticks || 0) + (n.durationTicks || 0);
            if (noteEnd > lastTick) lastTick = noteEnd;
          });
        });
        if (!lastTick && typeof head.secondsToTicks === 'function') {
          lastTick = head.secondsToTicks(end);
        }
        var stepTicks = (head.ppq || 480) * ts * 4 / beatUnit;
        if (lastTick > 0 && stepTicks > 0) {
          barLines = [];
          for (var tk = 0; tk <= lastTick; tk += stepTicks) {
            var sec = head.ticksToSeconds(tk);
            if (!isFinite(sec)) break;
            barLines.push(sec);
          }
          if (!barLines.length) barLines = null;
        }
      }
    } catch (e) {
      barLines = null;
    }

    return {
      title: (midi.name || '').trim() || (fallbackName || 'MIDI 曲谱').replace(/\.midi?$/i, ''),
      bpm: tempo,
      tempoLabel: tempoLabel,
      tempos: tempoMap,
      beatsPerBar: ts,
      beatUnit: beatUnit,
      notes: notes,
      barLines: barLines,
      duration: end + 1.5
    };
  }

  function applyMidiSong(song, label, artist, eyebrow, autoPlay, quiet) {
    if (state.playing) pause();

    var meta = (artist ? artist + ' · ' : '') +
      (song.tempoLabel || (song.bpm + ' BPM')) + ' · ' +
      song.beatsPerBar + '/' + (song.beatUnit || 4);
    bindSong(song, meta, eyebrow || 'Imported Score · 导入谱面');

    if (!quiet) flashHint('已载入 <b>' + escapeHtml(label || song.title) + '</b> · 共 ' + song.notes.length + ' 个音');
    if (autoPlay !== false && state.ready) beginPlay();
    return song;
  }

  var importSeq = 0;

  function loadMidiFile(file) {
    if (!file) return;
    if (!/\.(mid|midi)$/i.test(file.name)) {
      flashHint('只支持 <b>.mid</b> / <b>.midi</b> 文件');
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      flashHint('文件过大：上限 8 MB');
      return;
    }
    var token = ++importSeq;
    flashHint('正在解析 <b>' + escapeHtml(file.name) + '</b> …');

    file.arrayBuffer()
      .then(parseMidi)
      .then(function (midi) {
        if (token !== importSeq) return null;   // 已被后一次拖入取代
        var song = midiToSong(midi, file.name);
        // 自定义谱面不属于 assets 曲库，同时取消还在飞的曲库载入
        library.reqSeq++;
        library.customName = song.title;
        library.current = 'custom';
        library.currentPath = '';
        renderLibrary();
        return applyMidiSong(song, file.name, '', 'Custom MIDI · 自定义');
      })
      .catch(function (err) {
        if (token !== importSeq) return;
        flashHint('载入失败：' + escapeHtml(err && err.message ? err.message : err));
      });
  }

  /* ------------------------------------------------------------
     曲库：assets/ 里的 .mid 全部进入可选列表
     ------------------------------------------------------------ */

  var library = {
    items: [],
    current: -1,           // -1 = 曲库外；'custom' = 上传的自定义 MIDI
    currentPath: '',       // 当前选中的 assets 文件，重扫时用它恢复选中
    customName: '',        // 已上传的自定义曲名，用于下拉与按钮文案
    reqSeq: 0              // 选择序号：丢弃过期的异步载入结果
  };

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function assetBaseName(path) {
    var name = String(path || '').split('/').pop() || '';
    try { name = decodeURIComponent(name); } catch (e) { /* noop */ }
    return name;
  }

  function fileNameToTitle(path) {
    var base = assetBaseName(path).replace(/\.midi?$/i, '');
    return base.replace(/[_\s]+/g, ' ').trim() || '未命名曲目';
  }

  /** 本地服务器支持目录列表时，直接读出 assets/ 下的 .mid */
  function readDirMidFiles() {
    return fetch('assets/', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.text() : null; })
      .then(function (html) {
        if (html === null) return null;
        var re = /href="([^"?#]+\.midi?)"/gi;
        var out = [];
        var m;
        while ((m = re.exec(html))) {
          var href = m[1];
          try { href = decodeURIComponent(href); } catch (e) { /* noop */ }
          if (!/^(https?:|\/|assets\/)/i.test(href)) href = 'assets/' + href;
          if (out.indexOf(href) < 0) out.push(href);
        }
        return out;
      })
      .catch(function () { return null; });
  }

  function readManifest() {
    return fetch('assets/manifest.json', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; });
  }

  /** manifest.json 的 songs + 目录列表 => 曲库条目（按文件名去重） */
  function collectLibrary() {
    return Promise.all([readManifest(), readDirMidFiles()]).then(function (res) {
      var manifest = res[0] || {};
      var listed = res[1] || [];
      var names = listed.map(assetBaseName);
      var items = [];
      var seen = {};

      function push(entry) {
        var key = entry.file.toLowerCase();
        if (!key || seen[key]) return;
        seen[key] = true;
        items.push(entry);
      }

      var declared = Array.isArray(manifest.songs) ? manifest.songs.slice() : [];
      // 兼容旧版只写 default 的清单
      if (!declared.length && typeof manifest.default === 'string' && manifest.default) {
        declared.push({ file: manifest.default, title: manifest.title, artist: manifest.artist });
      }

      declared.forEach(function (raw) {
        var entry = typeof raw === 'string' ? { file: raw } : (raw || {});
        var file = entry.file || entry.path || '';
        if (!file) return;
        var path = /^(https?:|\/|assets\/)/i.test(file) ? file : 'assets/' + file;
        var name = assetBaseName(path);
        // 目录列表可用时，清单里写了但实际不存在的文件不进列表
        if (names.length && names.indexOf(name) < 0) {
          if (global.console) console.warn('[library] manifest 声明的文件不在 assets 目录：' + name);
          return;
        }
        push({
          path: path,
          file: name,
          title: String(entry.title || '').trim() || fileNameToTitle(name),
          artist: String(entry.artist || '').trim()
        });
      });

      // 目录里多出来的文件也算一份曲目，标题用文件名
      listed.forEach(function (path) {
        push({ path: path, file: assetBaseName(path), title: fileNameToTitle(path), artist: '' });
      });

      return items;
    });
  }

  /** 默认曲目：资源目录里的第一首 */
  function defaultLibraryIndex(items) {
    return items.length ? 0 : -1;
  }

  /** 曲库下拉：渲染按钮文案与自绘列表 */
  function renderLibrary() {
    if (!el.songMenu || !el.songBtn || !el.songBtnText) return;

    // 上传入口常驻首行：随时可载入本地 .mid
    var rows = [{
      index: 'custom',
      custom: true,
      title: library.customName ? '自定义 · ' + library.customName : '自定义 MIDI…',
      artist: ''
    }];
    library.items.forEach(function (it, i) {
      rows.push({ index: i, title: it.title, artist: it.artist });
    });
    if (!library.items.length) {
      // 空曲库时给一行灰字，免得看起来像功能坏了
      rows.push({ index: null, title: '（assets 暂无曲目）', artist: '', disabled: true });
    }

    var current = null;
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].index === library.current) { current = rows[i]; break; }
    }
    // 当前曲目不属于曲库（导入的 MIDI、载入失败等）时显示占位文案
    if (!current) current = { title: '选择曲目', artist: '' };
    el.songBtnText.textContent = current.artist
      ? current.title + ' · ' + current.artist
      : current.title;
    el.songBtn.title = library.items.length
      ? '切换 assets 曲目'
      : '把 .mid 放进 assets 目录后会自动出现在这里';

    var html = '';
    rows.forEach(function (r) {
      var on = r.index === library.current;
      html += '<li class="song-item' + (r.custom ? ' custom' : '') + (r.disabled ? ' disabled' : '') + (on ? ' on' : '') + '"' +
        ' role="option" tabindex="-1" aria-selected="' + (on ? 'true' : 'false') + '"' +
        (r.disabled ? ' aria-disabled="true"' : ' data-index="' + r.index + '"') + '>' +
        '<span class="t">' + escapeHtml(r.title) + '</span>' +
        (r.artist ? '<span class="a">' + escapeHtml(r.artist) + '</span>' : '') +
        '</li>';
    });
    el.songMenu.innerHTML = html;
  }

  function openLibrary() {
    if (!el.songMenu || !el.songBtn || !el.songMenu.hidden) return;
    el.songMenu.hidden = false;
    el.songBtn.classList.add('open');
    el.songBtn.setAttribute('aria-expanded', 'true');

    var pick = el.songMenu.querySelector('.song-item.on:not(.disabled)') ||
               el.songMenu.querySelector('.song-item:not(.disabled)');
    if (pick) pick.focus();
  }

  function closeLibrary(refocus) {
    if (!el.songMenu || !el.songBtn || el.songMenu.hidden) return;
    el.songMenu.hidden = true;
    el.songBtn.classList.remove('open');
    el.songBtn.setAttribute('aria-expanded', 'false');
    if (refocus) el.songBtn.focus();
  }

  function moveLibraryFocus(step) {
    if (!el.songMenu) return;
    var items = [].slice.call(el.songMenu.querySelectorAll('.song-item:not(.disabled)'));
    if (!items.length) return;
    var at = items.indexOf(document.activeElement);
    var next = items[(at + step + items.length) % items.length];
    if (next) next.focus();
  }

  function chooseLibraryItem(li) {
    if (!li || li.classList.contains('disabled') || !li.hasAttribute('data-index')) return;
    var raw = li.getAttribute('data-index');
    closeLibrary(true);
    // 首行自定义入口：打开隐藏的文件选择器，选中后复用拖拽的解析流程
    if (raw === 'custom') {
      if (el.midFile) el.midFile.click();
      return;
    }
    var idx = parseInt(raw, 10);
    selectLibraryIndex(isNaN(idx) ? -1 : idx);
  }

  /** 载入 assets 里的单个曲目：只解析，不负责应用与播放 */
  function loadAssetItem(item, quiet) {
    if (!item) return Promise.resolve(null);
    if (!quiet) flashHint('正在载入 <b>' + escapeHtml(item.title) + '</b> …');

    return fetch(item.path, { cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.arrayBuffer();
      })
      .then(function (buf) {
        if (!buf || buf.byteLength < 32) {
          throw new Error('文件太小，不像完整的 MIDI（' + (buf ? buf.byteLength : 0) + ' 字节）');
        }
        var head = new Uint8Array(buf, 0, 4);
        var sig = String.fromCharCode(head[0], head[1], head[2], head[3]);
        if (sig !== 'MThd') throw new Error('不是标准 MIDI 文件（缺少 MThd 头）');
        return buf;
      })
      .then(parseMidi)
      .then(function (midi) {
        var song = midiToSong(midi, item.file);
        if (item.title) song.title = item.title;
        if (global.console) {
          console.info('[library] 已载入 ' + item.path + '（' + song.notes.length + ' 个音，' + song.duration.toFixed(1) + ' 秒）');
        }
        return song;
      });
  }

  /** 切换曲库：index 无效或曲目缺失时保持现状 */
  function selectLibraryIndex(index, silent) {
    var item = index >= 0 ? library.items[index] : null;
    if (!item) return;
    // 已进入页面且已有真实曲目时，默认曲不再异步顶掉当前内容；
    // 空骨架阶段不能拦，否则默认曲会被永久丢弃
    if (silent && state.entered && hasPlayableSong()) return;
    // 用户主动选曲库时，取消还在解析的拖入 MIDI
    if (!silent) importSeq++;

    // 每次选择递增序号：异步载入回来时若已不是最新选择就直接丢弃，
    // 避免快速切换时“后点的先到、先点的后覆盖”
    var token = ++library.reqSeq;
    var prev = library.current;
    var prevPath = library.currentPath;
    library.current = index;
    library.currentPath = item.path;

    // 静默载入不提前改菜单文字，真正应用时再一次性更新
    if (!silent) renderLibrary();

    loadAssetItem(item, silent).then(function (song) {
      if (token !== library.reqSeq) return;
      // 载入期间用户已进入页面且已有真实曲目在播：保留当前曲目，文字不做任何变动
      if (silent && state.entered && hasPlayableSong()) {
        library.current = prev;
        library.currentPath = prevPath;
        return;
      }
      renderLibrary();
      applyMidiSong(song, song.title, item.artist, 'Asset Library · 曲库', !silent, silent);
    }).catch(function (err) {
      if (token !== library.reqSeq) return;
      var msg = err && err.message ? err.message : String(err);
      if (global.console) console.warn('[library] 曲目未载入：', msg);
      library.current = prev;
      library.currentPath = prevPath;
      renderLibrary();
      if (silent && state.entered) return;
      flashHint('载入 <b>' + escapeHtml(item.title) + '</b> 失败：' + escapeHtml(msg));
      // 入场页还在时，失败原因也能直接看到
      if (el.tip && !state.entered) {
        el.tip.textContent = 'assets 曲目未能载入（' + msg + '）';
      }
    });
  }

  function sameItems(a, b) {
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) {
      if (a[i].path !== b[i].path || a[i].title !== b[i].title || a[i].artist !== b[i].artist) {
        return false;
      }
    }
    return true;
  }

  /** 重新扫一遍 assets，只刷新下拉，不打断当前播放 */
  function refreshLibrary() {
    return collectLibrary().then(function (items) {
      if (sameItems(items, library.items)) return false;
      library.items = items;

      // 按路径恢复选中，文件被移除则清空选中；自定义曲目保持选中
      var idx = -1;
      if (library.current !== 'custom') {
        if (library.currentPath) {
          for (var i = 0; i < items.length; i++) {
            if (items[i].path === library.currentPath) { idx = i; break; }
          }
        }
        library.current = idx;
        if (idx < 0) library.currentPath = '';
      }
      renderLibrary();

      if (global.console) console.info('[library] 曲库已更新，共 ' + items.length + ' 首');
      return true;
    }).catch(function () { return false; });
  }

  function initLibrary() {
    if (global.location && global.location.protocol === 'file:') {
      if (global.console) console.warn('[library] file:// 打开时浏览器禁止读取 assets，请改用本地服务器');
      if (el.tip) el.tip.textContent = '请用本地服务器打开（如 http://127.0.0.1:8010/），否则读不到 assets 曲目';
    }

    collectLibrary().then(function (items) {
      library.items = items;
      var defIdx = defaultLibraryIndex(items);
      // 不预先改 current：载入失败时才能正确回滚
      renderLibrary();
      if (defIdx >= 0) {
        selectLibraryIndex(defIdx, true);
      } else {
        if (global.console) console.info('[library] assets 里暂无可选 MIDI');
        // 空曲库时把原因和做法写在入场页上
        if (el.tip && !(global.location && global.location.protocol === 'file:')) {
          el.tip.textContent = 'assets 里没读到 .mid，把文件放进 assets 目录后刷新即可';
        }
      }

      // 回到标签页时重扫，新丢进 assets 的 .mid 不用刷新页面
      var recheck = function () {
        clearTimeout(recheck._t);
        recheck._t = setTimeout(function () { refreshLibrary(); }, 400);
      };
      global.addEventListener('focus', recheck);
      document.addEventListener('visibilitychange', function () {
        if (!document.hidden) recheck();
      });
    }).catch(function (err) {
      var msg = err && err.message ? err.message : String(err);
      if (global.console) console.warn('[library] 曲库读取失败：', msg);
      if (el.tip) el.tip.textContent = '曲库读取失败：' + msg;
    });
  }

  function bindDrop() {
    var depth = 0;
    global.addEventListener('dragenter', function (e) {
      e.preventDefault();
      depth++;
      document.body.classList.add('dragging');
    });
    global.addEventListener('dragover', function (e) { e.preventDefault(); });
    global.addEventListener('dragleave', function (e) {
      e.preventDefault();
      depth = Math.max(0, depth - 1);
      if (!depth) document.body.classList.remove('dragging');
    });
    global.addEventListener('drop', function (e) {
      e.preventDefault();
      depth = 0;
      document.body.classList.remove('dragging');
      var files = e.dataTransfer && e.dataTransfer.files;
      if (files && files.length) loadMidiFile(files[0]);
    });
  }

  /* ------------------------------------------------------------
     入场
     ------------------------------------------------------------ */

  function hideSplash() {
    el.splash.classList.add('hide');
    setTimeout(function () {
      if (el.splash && el.splash.parentNode) el.splash.parentNode.removeChild(el.splash);
    }, 1100);
  }

  function bindSplash() {
    el.enter.addEventListener('click', function () {
      if (state.entered) return;
      state.entered = true;
      el.enter.disabled = true;
      setTip('正在唤醒钢琴…');

      Audio.init().then(function () {
        state.ready = true;
        el.play.disabled = false;
        hideSplash();
        if (Audio.isSampleMode()) {
          beginPlay();
        } else {
          // 没有采样就保持静音，不自动播放一首无声的曲子
          flashHint('钢琴采样加载失败（CDN 与本地均不可用），请检查网络或 assets/piano 后刷新 · 拖入 <b>.mid</b> 可载入任意曲谱');
          // 网络恢复时自动再试一次，不必刷新页面
          setTimeout(function () {
            Audio.retrySamples().then(function (ok) {
              if (ok) flashHint('钢琴采样已恢复，可以开始播放');
            });
          }, 2500);
        }
      }).catch(function (err) {
        state.entered = false;
        el.enter.disabled = false;
        setTip('音频启动失败：' + (err && err.message ? err.message : err));
      });
    });
  }

  /* ------------------------------------------------------------
     启动
     ------------------------------------------------------------ */

  function boot() {
    if (!Tone) {
      setTip('Tone.js 加载失败，请检查网络后刷新');
      return;
    }
    if (!Audio || !Renderer) {
      setTip('脚本加载不完整，请刷新重试');
      return;
    }

    transport = Tone.getTransport();

    Renderer.init(el.stage);
    bindCanvas();
    bindControls();
    bindDrop();
    bindSplash();

    el.play.disabled = true;

    // 拖窗改变画布尺寸时，顶部提示尺寸与缩放，3 秒后自动消失
    var rzTimer = 0;
    global.addEventListener('resize', function () {
      clearTimeout(rzTimer);
      rzTimer = setTimeout(function () {
        var w = Math.round(el.stage.clientWidth);
        var h = Math.round(el.stage.clientHeight);
        showToast('画布 ' + w + ' × ' + h + ' · 缩放 ' + Math.round(Renderer.getZoom() * 100) + '%');
      }, 180);
    });

    // 先用空谱面摆好完整键盘，曲库载入后自动换成默认曲目
    bindSong({
      title: 'Piano Solo',
      notes: [],
      bpm: 72,
      beatsPerBar: 4,
      duration: 0
    }, '等待曲目载入', 'Asset Library · 曲库');
    state.taskReady = true;

    // assets/ 里的曲目进入曲库，默认曲目自动载入
    initLibrary();

    setTimeout(function () { if (el.hint) el.hint.classList.add('fade'); }, 16000);

    requestAnimationFrame(tick);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})(window);