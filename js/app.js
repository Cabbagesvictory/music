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
    songBtnText: $('#songBtnText')
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
    panning: null
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

  function flashHint(text) {
    if (!el.hint) return;
    el.hint.classList.remove('fade');
    el.hint.innerHTML = text;
    clearTimeout(flashHint._t);
    flashHint._t = setTimeout(function () {
      if (el.hint) el.hint.classList.add('fade');
    }, 4200);
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

    el.title.textContent = song.title || 'Untitled';
    document.title = (song.title || '钢琴独奏') + ' · 钢琴独奏';
    if (metaText) el.meta.textContent = metaText;
    else el.meta.textContent = (song.bpm || 72) + ' BPM · ' + (song.beatsPerBar || 4) + '/4';
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

  function positionString(t) {
    var bpm = (state.song && state.song.bpm) || 120;
    var perBar = (60 / bpm) * ((state.song && state.song.beatsPerBar) || 4);
    var bars = Math.floor(t / perBar);
    var rem = t - bars * perBar;
    var beats = Math.floor(rem / (60 / bpm));
    var rem2 = rem - beats * (60 / bpm);
    var six = rem2 / ((60 / bpm) / 4);
    return bars + ':' + beats + ':' + six.toFixed(3);
  }

  function setPosition(t) {
    transport.seconds = t;
    if (Math.abs(getPos() - t) > 0.35) {
      // 兜底：老版本 Tone 对 seconds 赋值支持不佳
      transport.position = positionString(t);
    }
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

  function setProgressUI(ratio) {
    var pct = clamp(ratio, 0, 1) * 100;
    if (el.fill) el.fill.style.width = pct.toFixed(3) + '%';
    if (el.knob) el.knob.style.left = pct.toFixed(3) + '%';
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
    try {
      Renderer.render(state.time, dt, state.playing);
    } catch (err) {
      // 单帧绘制异常不能把整个循环带死
      if (!tick._warned) {
        tick._warned = true;
        if (global.console) console.error('[render] 绘制异常：', err);
      }
    }

    var dur = state.duration || 0;
    setProgressUI(dur ? state.time / dur : 0);
    el.timeNow.textContent = fmt(Math.min(state.time, dur));
    el.timeTotal.textContent = fmt(dur);

    requestAnimationFrame(tick);
  }

  /* ------------------------------------------------------------
     交互：画布
     ------------------------------------------------------------ */

  function canvasPoint(e) {
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

    // 进度条拖动
    var scrubbing = false;

    function scrubTo(clientX) {
      var r = el.progress.getBoundingClientRect();
      var ratio = clamp((clientX - r.left) / Math.max(1, r.width), 0, 1);
      seek(ratio * state.duration);
    }

    el.progress.addEventListener('pointerdown', function (e) {
      scrubbing = true;
      el.progress.setPointerCapture && el.progress.setPointerCapture(e.pointerId);
      scrubTo(e.clientX);
    });
    el.progress.addEventListener('pointermove', function (e) {
      if (scrubbing) scrubTo(e.clientX);
    });
    el.progress.addEventListener('pointerup', function () { scrubbing = false; });
    el.progress.addEventListener('pointercancel', function () { scrubbing = false; });

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

  function parseMidi(buf) {
    return import('https://cdn.jsdelivr.net/npm/@tonejs/midi@2/+esm').then(function (mod) {
      var Midi = mod.Midi || (mod.default && mod.default.Midi);
      if (!Midi) throw new Error('MIDI 解析器不可用');
      return new Midi(buf);
    });
  }

  var HAND_SPLIT = 60;   // 单轨 MIDI 没有手别信息时，C4 以下算左手

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
          midi: n.midi,
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

    var tempo = midi.header.tempos && midi.header.tempos.length ? midi.header.tempos[0].bpm : 120;
    tempo = clamp(Math.round(tempo || 120), 20, 300);
    var ts = 4;
    if (midi.header.timeSignatures && midi.header.timeSignatures.length) {
      var sig = midi.header.timeSignatures[0].timeSignature;
      if (sig && sig[0]) ts = sig[0];
    }

    return {
      title: (midi.name || '').trim() || (fallbackName || 'MIDI 曲谱').replace(/\.midi?$/i, ''),
      bpm: tempo,
      beatsPerBar: ts,
      notes: notes,
      barLines: null,
      duration: end + 1.5
    };
  }

  function applyMidiSong(song, label, artist, eyebrow) {
    if (state.playing) pause();

    var meta = (artist ? artist + ' · ' : '') + song.bpm + ' BPM · ' + song.beatsPerBar + '/4';
    bindSong(song, meta, eyebrow || 'Imported Score · 导入谱面');

    // 入场遮罩如果还在，同步换个名字
    if (el.splash) {
      var h1 = el.splash.querySelector('h1');
      var sub = el.splash.querySelector('.sub');
      if (h1) h1.textContent = song.title;
      if (sub) sub.textContent = artist || '钢琴独奏';
    }

    flashHint('已载入 <b>' + (label || song.title) + '</b> · 共 ' + song.notes.length + ' 个音');
    if (state.ready) beginPlay();
    return song;
  }

  function loadMidiFile(file) {
    if (!file) return;
    if (!/\.(mid|midi)$/i.test(file.name)) {
      flashHint('只支持 <b>.mid</b> / <b>.midi</b> 文件');
      return;
    }
    flashHint('正在解析 <b>' + file.name + '</b> …');

    file.arrayBuffer()
      .then(parseMidi)
      .then(function (midi) { return applyMidiSong(midiToSong(midi, file.name), file.name); })
      .catch(function (err) {
        flashHint('载入失败：' + (err && err.message ? err.message : err));
      });
  }

  /* ------------------------------------------------------------
     曲库：assets/ 里的 .mid 全部进入可选列表
     ------------------------------------------------------------ */

  var library = {
    items: [],
    manifest: {},
    current: -1,           // -1 = 内置示范曲
    currentPath: ''        // 当前选中的 assets 文件，重扫时用它恢复选中
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
        if (names.length && names.indexOf(name) < 0) return;
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

      library.manifest = manifest;
      return items;
    });
  }

  /** 默认曲目：清单 default > 文件名含 luv letter > 第一首 */
  function defaultLibraryIndex(items) {
    if (!items.length) return -1;
    var want = assetBaseName(library.manifest.default || '');
    var i;
    if (want) {
      for (i = 0; i < items.length; i++) if (items[i].file === want) return i;
    }
    for (i = 0; i < items.length; i++) if (/luv.?letter/i.test(items[i].file)) return i;
    return 0;
  }

  /** 曲库下拉：渲染按钮文案与自绘列表 */
  function renderLibrary() {
    if (!el.songMenu || !el.songBtn || !el.songBtnText) return;

    var rows = [{ index: -1, title: '内置示范曲', artist: '' }];
    library.items.forEach(function (it, i) {
      rows.push({ index: i, title: it.title, artist: it.artist });
    });
    if (!library.items.length) {
      // 空曲库时给一行灰字，免得看起来像功能坏了
      rows.push({ index: null, title: '（assets 暂无曲目）', artist: '', disabled: true });
    }

    var current = rows[0];
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].index === library.current) { current = rows[i]; break; }
    }
    el.songBtnText.textContent = current.artist
      ? current.title + ' · ' + current.artist
      : current.title;
    el.songBtn.title = library.items.length
      ? '切换 assets 曲目'
      : '把 .mid 放进 assets 目录后会自动出现在这里';

    var html = '';
    rows.forEach(function (r) {
      var on = r.index === library.current;
      html += '<li class="song-item' + (r.disabled ? ' disabled' : '') + (on ? ' on' : '') + '"' +
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
    var idx = parseInt(li.getAttribute('data-index'), 10);
    closeLibrary(true);
    selectLibraryIndex(isNaN(idx) ? -1 : idx);
  }

  /** 载入 assets 里的单个曲目 */
  function loadAssetItem(item) {
    if (!item) return Promise.resolve(null);
    flashHint('正在载入 <b>' + escapeHtml(item.title) + '</b> …');

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
        return applyMidiSong(song, song.title, item.artist, 'Asset Library · 曲库');
      });
  }

  /** 切换曲库：index < 0 表示回到内置示范曲 */
  function selectLibraryIndex(index, silent) {
    var item = index >= 0 ? library.items[index] : null;
    if (index >= 0 && !item) return;

    var prev = library.current;
    var prevPath = library.currentPath;
    library.current = item ? index : -1;
    library.currentPath = item ? item.path : '';
    renderLibrary();

    if (!item) {
      if (state.playing) pause();
      bindSong(global.Piece.buildSong(), null, 'Piano Solo · 内置示范曲');
      if (silent) return;
      flashHint('已切回 <b>内置示范曲</b>');
      if (state.ready) beginPlay();
      return;
    }

    loadAssetItem(item).catch(function (err) {
      var msg = err && err.message ? err.message : String(err);
      if (global.console) console.warn('[library] 曲目未载入：', msg);
      // 载入失败就退回上一首，并把原因写在提示里
      library.current = prev;
      library.currentPath = prevPath;
      renderLibrary();
      flashHint('载入 <b>' + escapeHtml(item.title) + '</b> 失败：' + escapeHtml(msg));
      // 入场页还在时，失败原因也能直接看到
      if (el.tip && !state.entered) {
        el.tip.textContent = 'assets 曲目未能载入（' + msg + '），已使用内置示范曲';
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

      // 按路径恢复选中，文件被移除则回落到内置曲目
      var idx = -1;
      if (library.currentPath) {
        for (var i = 0; i < items.length; i++) {
          if (items[i].path === library.currentPath) { idx = i; break; }
        }
      }
      library.current = idx;
      if (idx < 0) library.currentPath = '';
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
      library.current = defaultLibraryIndex(items);
      renderLibrary();
      if (library.current >= 0) {
        selectLibraryIndex(library.current, true);
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
        beginPlay();
        if (!Audio.isSampleMode()) {
          flashHint('采样音色未能加载，已切换为合成钢琴 · 拖入 <b>.mid</b> 可载入任意曲谱');
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
    if (!global.Piece || !Audio || !Renderer) {
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

    // 先摆好曲谱，让入场画面背后就是完整的键盘
    bindSong(global.Piece.buildSong(), null, 'Piano Solo · 内置示范曲');
    state.taskReady = true;

    // assets/ 里的曲目进入曲库，默认那首自动顶掉内置曲目
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