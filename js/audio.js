/* ===========================================================
   audio.js — 钢琴音频引擎
   采样默认走 jsDelivr CDN，失败或超时后回落到 assets/piano/
   下的本地采样；所有采样源都不可用时保持静音，不使用合成音色。
   =========================================================== */
(function (global) {
  'use strict';

  // Salamander Grand Piano（Yamaha C5 三角钢琴录音）：每 6 个半音一个采样，
  // 其余音高由浏览器变调，文件更少、首屏更快
  var SAMPLER_URLS = {
    C1: 'C1.mp3', 'F#1': 'Fs1.mp3', C2: 'C2.mp3', 'F#2': 'Fs2.mp3',
    C3: 'C3.mp3', 'F#3': 'Fs3.mp3', C4: 'C4.mp3', 'F#4': 'Fs4.mp3',
    C5: 'C5.mp3', 'F#5': 'Fs5.mp3', C6: 'C6.mp3', 'F#6': 'Fs6.mp3',
    C7: 'C7.mp3', 'F#7': 'Fs7.mp3', C8: 'C8.mp3'
  };

  // 本地采样目录（转成绝对 URL，避免不同环境下相对路径解析差异）
  var LOCAL_SAMPLES = (function () {
    try {
      return new URL('assets/piano/', document.baseURI).href;
    } catch (e) {
      return 'assets/piano/';
    }
  })();

  // 默认走 CDN；jsDelivr 不通或超时后回落到本地文件，本地是最终兜底
  var SAMPLER_SOURCES = [
    'https://cdn.jsdelivr.net/gh/nbrosowsky/tonejs-instruments@master/samples/piano/',
    LOCAL_SAMPLES
  ];
  var SOURCE_TIMEOUT = 4000; // 单个采样源的最长等待，超时就换下一个源

  var A = {
    ready: false,
    mode: 'none',            // 'samples' | 'none'
    started: false,
    sampler: null,
    masterVol: 1
  };

  function midiToFreq(midi) {
    return 440 * Math.pow(2, (midi - 69) / 12);
  }

  /** 从单个源加载完整采样，带超时与统一 settle */
  function loadSource(baseUrl, bus) {
    return new Promise(function (resolve, reject) {
      var Tone = global.Tone;
      var timer = 0;
      var settled = false;
      var sampler = null;

      function ok() {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(sampler);
      }

      function fail(message) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { sampler.dispose(); } catch (e) { /* noop */ }
        reject(new Error(message));
      }

      sampler = new Tone.Sampler({
        urls: SAMPLER_URLS,
        baseUrl: baseUrl,
        attack: 0.001,
        release: 1.15,
        curve: 'exponential',
        onload: ok,
        onerror: function () { fail('取样失败'); }
      });
      sampler.volume.value = -2;
      sampler.connect(bus);
      // 源半通不通时会一直挂着，超时后丢弃它换下一个
      timer = setTimeout(function () { fail('取样超时'); }, SOURCE_TIMEOUT);
    });
  }

  /** 按 CDN → 本地的顺序加载；全部失败返回 null */
  function loadSampler(bus) {
    function attempt(i) {
      if (i >= SAMPLER_SOURCES.length) return Promise.resolve(null);
      return loadSource(SAMPLER_SOURCES[i], bus).catch(function (err) {
        if (global.console) {
          console.warn('[audio] 采样源不可用：' + SAMPLER_SOURCES[i] +
            '（' + (err && err.message ? err.message : err) + '）');
        }
        return attempt(i + 1);
      });
    }
    return attempt(0);
  }

  /** 初始化音频图。必须在用户手势中调用（内部会 resume AudioContext）。 */
  A.init = function () {
    if (A._promise) return A._promise;
    A._promise = (function () {
      var Tone = global.Tone;
      if (!Tone) return Promise.reject(new Error('Tone.js 未加载'));

      return Tone.start().then(function () {
        A.started = true;

        var master = Tone.getDestination();
        var volume = new Tone.Gain(A.masterVol);
        var reverb = new Tone.Reverb({ decay: 3.6, preDelay: 0.012, wet: 0.3 });
        var bus = new Tone.Gain(1);

        bus.chain(reverb, volume, master);
        // 混响的脉冲响应是异步生成的，不阻塞主流程
        if (reverb.ready && reverb.ready.catch) reverb.ready.catch(function () {});

        A.bus = bus;
        A.volume = volume;

        // 等采样加载出结果（成功或所有源都失败）再就绪，
        // 保证第一枚音符就是真实钢琴采样（或彻底静音）
        return loadSampler(bus).then(function (sampler) {
          if (sampler) {
            A.sampler = sampler;
            A.mode = 'samples';
          } else {
            A.mode = 'none';
          }
          A.ready = true;
          return A;
        });
      });
    })();

    // 初始化失败（如音频上下文被拒）时清掉缓存，允许用户再点一次重试
    A._promise = A._promise.catch(function (err) {
      A._promise = null;
      throw err;
    });
    return A._promise;
  };

  /** 采样全部失败后重新加载（不重建音频图），返回是否成功 */
  A.retrySamples = function () {
    if (A.sampler) return Promise.resolve(true);
    if (!A.ready || !A.bus) return Promise.resolve(false);
    if (A._retry) return A._retry;
    A._retry = loadSampler(A.bus).then(function (sampler) {
      A._retry = null;
      if (sampler) {
        A.sampler = sampler;
        A.mode = 'samples';
      }
      return !!sampler;
    }, function () {
      A._retry = null;
      return false;
    });
    return A._retry;
  };

  /** 触发一个音；采样未就绪时静默跳过，不发声也不合成 */
  A.noteOn = function (midi, dur, time, velocity) {
    if (!A.ready || A.mode !== 'samples' || !A.sampler) return;
    var tone = A.sampler;
    var freq = midiToFreq(midi);
    var v = Math.max(0.03, Math.min(1, velocity === undefined ? 0.7 : velocity));
    var d = Math.max(0.05, dur || 0.8);
    try {
      if (time === undefined || time === null) tone.triggerAttackRelease(freq, d, undefined, v);
      else tone.triggerAttackRelease(freq, d, time, v);
    } catch (e) {
      // 极少见的调度冲突，忽略即可
    }
  };

  /** 松掉所有正在发声的音 */
  A.stopAll = function () {
    try {
      if (A.sampler) A.sampler.releaseAll();
    } catch (e) { /* noop */ }
  };

  /** 0 ~ 1 音量 */
  A.setVolume = function (v) {
    A.masterVol = Math.max(0, Math.min(1, v));
    if (A.volume) {
      try { A.volume.gain.rampTo(A.masterVol, 0.06); } catch (e) { /* noop */ }
    }
  };

  A.isSampleMode = function () { return A.mode === 'samples'; };

  global.PianoAudio = A;
})(window);