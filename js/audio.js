/* ===========================================================
   audio.js — 钢琴音频引擎
   采样优先走 CDN（jsDelivr → 官方源），两者都不可用时改用
   assets/piano/ 下的本地采样，全部失败才降级为加法合成钢琴。
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

  // 优先走 CDN；jsDelivr 不通时直接回落到本地文件（比再等一个远程源快），
  // 官方 GitHub Pages 源作为最后的远程备份
  var SAMPLER_SOURCES = [
    'https://cdn.jsdelivr.net/gh/nbrosowsky/tonejs-instruments@master/samples/piano/',
    LOCAL_SAMPLES,
    'https://tonejs.github.io/audio/salamander/'
  ];
  var LOAD_TIMEOUT = 6500;   // 超过这个时间先用合成音色顶上
  var SOURCE_TIMEOUT = 4000; // 单个采样源的最长等待，超时就换下一个源

  var A = {
    ready: false,
    mode: 'none',            // 'samples' | 'synth'
    started: false,
    sampler: null,
    synth: null,
    masterVol: 1
  };

  function delay(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  function midiToFreq(midi) {
    return 440 * Math.pow(2, (midi - 69) / 12);
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

        // ---- 降级用合成钢琴 ----
        A.synth = new Tone.PolySynth(Tone.Synth, {
          oscillator: {
            type: 'custom',
            partials: [1, 0.44, 0.19, 0.09, 0.045, 0.022, 0.01]
          },
          envelope: {
            attack: 0.004,
            decay: 1.7,
            sustain: 0.035,
            release: 1.6,
            decayCurve: 'exponential',
            releaseCurve: 'exponential'
          }
        });
        A.synth.maxPolyphony = 64;
        A.synth.volume.value = -8;
        A.synth.connect(bus);

        // ---- 真实采样：按镜像顺序尝试，任一源成功即用 ----
        function loadSampler(i) {
          if (i >= SAMPLER_SOURCES.length) return Promise.resolve(false);
          var timer = 0;
          return new Promise(function (resolve, reject) {
            var sampler = new Tone.Sampler({
              urls: SAMPLER_URLS,
              baseUrl: SAMPLER_SOURCES[i],
              attack: 0.001,
              release: 1.15,
              curve: 'exponential',
              onload: function () {
                clearTimeout(timer);
                resolve(sampler);
              },
              onerror: function () {
                clearTimeout(timer);
                try { sampler.dispose(); } catch (e) { /* noop */ }
                reject(new Error('取样失败'));
              }
            });
            sampler.volume.value = -2;
            sampler.connect(bus);
            // 源半通不通时会一直挂着，超时后丢弃它换下一个
            timer = setTimeout(function () {
              try { sampler.dispose(); } catch (e) { /* noop */ }
              reject(new Error('取样超时'));
            }, SOURCE_TIMEOUT);
          }).then(function (sampler) {
            A.sampler = sampler;
            return true;
          }).catch(function () {
            return loadSampler(i + 1);
          });
        }

        var loaded = loadSampler(0);

        var settle = Promise.race([
          loaded,
          delay(LOAD_TIMEOUT).then(function () { return 'timeout'; })
        ]);

        return settle.then(function (result) {
          A.mode = result === true ? 'samples' : 'synth';
          A.ready = true;
          // 采样如果晚到，静默升级
          if (result !== true) {
            loaded.then(function (ok) { if (ok) A.mode = 'samples'; });
          }
          return A;
        });
      });
    })();
    return A._promise;
  };

  /** 触发一个音 */
  A.noteOn = function (midi, dur, time, velocity) {
    if (!A.ready) return;
    var tone = (A.mode === 'samples' && A.sampler) ? A.sampler : A.synth;
    if (!tone) return;
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
      if (A.synth) A.synth.releaseAll();
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