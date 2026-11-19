/* ===========================================================
   audio.js — 钢琴音频引擎
   采样优先从国内 CDN 加载整包：assets/piano.zip 一次请求（内部 6 路 Range 分块并行），
   解包后以 blob URL 直接喂给 Tone.Sampler，并写入 Cache Storage 供二次访问复用；
   CDN 不可用时回落到 GitHub Pages 上的同一个整包，再回落到分散采样。
   所有采样源都不可用时保持静音，不使用合成音色。
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

  function absolutize(path) {
    try {
      return new URL(path, document.baseURI).href;
    } catch (e) {
      return path;
    }
  }

  // 本地采样目录（绝对 URL，避免不同环境下相对路径解析差异）
  var LOCAL_SAMPLES = absolutize('assets/piano/');

  // 采样整包：采样有增删改后跑一次 tools/build_samples_zip.py，再把版本号加 1，
  // 一并刷新浏览器 HTTP 缓存和 Cache Storage 里的旧包
  var BUNDLE_VERSION = '1';
  var BUNDLE_URL = absolutize('assets/piano.zip?v=' + BUNDLE_VERSION);

  // 国内镜像 / 全球节点 / jsDelivr 主站（原 CDN）三路都在，进页面时并行测速，
  // 谁快用谁：国内会落在国内镜像，海外会落在全球节点，任何一个失败都还有本地兜底。
  // 仓库名 / 分支改名后需要同步这里。
  var CDN_REPO = 'Cabbagesvictory/music';
  var CDN_REF = 'master';
  var CDN_BASES = [
    { label: '国内 CDN 采样包', base: 'https://cdn.jsdmirror.com/gh/' + CDN_REPO + '@' + CDN_REF + '/assets/' },
    { label: '全球 CDN 采样包', base: 'https://gcore.jsdelivr.net/gh/' + CDN_REPO + '@' + CDN_REF + '/assets/' },
    { label: 'jsDelivr 采样包', base: 'https://cdn.jsdelivr.net/gh/' + CDN_REPO + '@' + CDN_REF + '/assets/' }
  ];
  var PROBE_BYTES = 32768;    // 测速只取前 32KB，按拿到数据的耗时判断节点快慢
  var PROBE_TIMEOUT = 4000;   // 单个节点测速上限，超时视为不可用

  var BUNDLE_CACHE = 'piano-bundle';
  var BUNDLE_CHUNKS = 6;      // HTTP/1.1 下 6 路分块正好吃满浏览器单域并发
  var BUNDLE_STALL = 25000;   // 下载停滞超过 25s 判定失败，交给下一个源
  var DECODE_TIMEOUT = 30000; // 整包到手后浏览器解码的最长等待
  var SOURCE_TIMEOUT = 45000; // 兜底的分散采样：弱网也给足时间，不抢先超时

  var A = {
    ready: false,
    mode: 'none',            // 'samples' | 'none'
    started: false,
    sampler: null,
    masterVol: 1,
    onProgress: null         // 入场页注册：function (stage, loaded, total)
  };

  /** 加载进度：stage = 'download' | 'unzip' | 'decode' */
  function report(stage, loaded, total) {
    if (typeof A.onProgress !== 'function') return;
    try { A.onProgress(stage, loaded, total); } catch (e) { /* noop */ }
  }

  function midiToFreq(midi) {
    return 440 * Math.pow(2, (midi - 69) / 12);
  }

  /** 从 Cache Storage 取整包；没有或不可用返回 null */
  function readCachedBundle() {
    if (!global.caches) return Promise.resolve(null);
    return global.caches.open(BUNDLE_CACHE)
      .then(function (cache) { return cache.match(BUNDLE_URL); })
      .then(function (res) { return res ? res.arrayBuffer() : null; })
      .catch(function () { return null; });
  }

  /** 整包写入 Cache Storage；无痕模式或配额满时失败也不影响播放 */
  function writeCachedBundle(buffer) {
    if (!global.caches) return Promise.resolve();
    return global.caches.open(BUNDLE_CACHE).then(function (cache) {
      // 版本号加 1 后旧包换个 URL，顺手清掉，不让它在 Cache Storage 里堆积
      return cache.keys().then(function (requests) {
        return Promise.all(requests.map(function (req) {
          return req.url === BUNDLE_URL ? null : cache.delete(req);
        }));
      }).catch(function () { /* noop */ }).then(function () {
        return cache.put(BUNDLE_URL, new Response(buffer, {
          headers: { 'Content-Type': 'application/zip' }
        }));
      });
    }).catch(function () { /* noop */ });
  }

  /** 流式读取响应体，边读边回报累计字节；不支持流时退回 arrayBuffer */
  function readStream(res, onChunk) {
    if (!res.body || !res.body.getReader) {
      return res.arrayBuffer().then(function (buf) {
        if (onChunk) onChunk(buf.byteLength);
        return buf;
      });
    }
    var reader = res.body.getReader();
    var chunks = [];
    var loaded = 0;

    function pump() {
      return reader.read().then(function (step) {
        if (step.done) {
          var out = new Uint8Array(loaded);
          var pos = 0;
          for (var i = 0; i < chunks.length; i++) {
            out.set(chunks[i], pos);
            pos += chunks[i].length;
          }
          return out.buffer;
        }
        chunks.push(step.value);
        loaded += step.value.length;
        if (onChunk) onChunk(loaded);
        return pump();
      });
    }
    return pump();
  }

  /** “无新字节即中止”的下载守卫：网络半通时不让入场页无限干等 */
  function stallGuard() {
    var ac = global.AbortController ? new AbortController() : null;
    var lastTick = Date.now();
    var timer = ac ? setInterval(function () {
      if (Date.now() - lastTick <= BUNDLE_STALL) return;
      ac.stalled = true;
      try { ac.abort(); } catch (e) { /* noop */ }
    }, 2000) : 0;

    return {
      signal: ac ? ac.signal : undefined,
      tick: function () { lastTick = Date.now(); },
      stop: function () { if (timer) clearInterval(timer); },
      stalled: function () { return !!(ac && ac.stalled); }
    };
  }

  function bundleUrl(base) {
    return base + 'piano.zip?v=' + BUNDLE_VERSION;
  }

  /** 取前 32KB 测速：拿到数据即算该节点可用，超时 / 非 2xx 都算失败 */
  function probeBase(cdn, ac) {
    var timer = ac ? setTimeout(function () {
      try { ac.abort(); } catch (e) { /* noop */ }
    }, PROBE_TIMEOUT) : 0;

    function done() { if (timer) clearTimeout(timer); }

    return fetch(bundleUrl(cdn.base), {
      headers: { Range: 'bytes=0-' + (PROBE_BYTES - 1) },
      cache: 'no-cache',
      signal: ac ? ac.signal : undefined
    }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.arrayBuffer();
    }).then(function (buf) {
      done();
      if (!buf || buf.byteLength < 1024) throw new Error('探测数据不足');
    }, function (err) {
      done();
      throw err;
    });
  }

  /**
   * 并行测速挑最快节点：国内镜像、全球节点、原 jsDelivr 主站一起探，
   * 最先拿到 32KB 的胜出，其余探测立即中止；全部失败返回 null 交给本地兜底。
   */
  function pickCdn() {
    return new Promise(function (resolve) {
      var pending = CDN_BASES.length;
      var settled = false;
      var probes = [];

      CDN_BASES.forEach(function (cdn) {
        var ac = global.AbortController ? new AbortController() : null;
        probes.push(ac);

        probeBase(cdn, ac).then(function () {
          if (settled) return;
          settled = true;
          probes.forEach(function (other) {
            if (other && other !== ac) {
              try { other.abort(); } catch (e) { /* noop */ }
            }
          });
          resolve(cdn);
        }, function () {
          pending--;
          if (!settled && pending === 0) resolve(null);
        });
      });
    });
  }

  /** 按总长度切 6 段并发 Range 下载；任意一段失败即整体失败 */
  function downloadChunked(total, url) {
    // 没有 AbortController 就无法在停滞时中断分块，直接交给整体下载
    if (!global.AbortController) return Promise.reject(new Error('环境不支持分块取消'));

    var size = Math.ceil(total / BUNDLE_CHUNKS);
    var parts = new Array(BUNDLE_CHUNKS);
    var loadedTotal = 0;
    var guard = stallGuard();

    function job(i) {
      var from = i * size;
      var to = Math.min(total - 1, from + size - 1);
      if (from > to) return Promise.resolve();
      return fetch(url, {
        headers: { Range: 'bytes=' + from + '-' + to },
        cache: 'no-cache',
        signal: guard.signal
      }).then(function (res) {
        if (res.status !== 206) throw new Error('服务器未按分块返回（HTTP ' + res.status + '）');
        var last = 0;
        return readStream(res, function (loaded) {
          loadedTotal += loaded - last;
          last = loaded;
          guard.tick();
          report('download', Math.min(total, loadedTotal), total);
        }).then(function (buf) {
          parts[i] = new Uint8Array(buf);
        });
      });
    }

    var jobs = [];
    for (var i = 0; i < BUNDLE_CHUNKS; i++) jobs.push(job(i));

    return Promise.all(jobs).then(function () {
      guard.stop();
      var out = new Uint8Array(total);
      var pos = 0;
      for (var k = 0; k < parts.length; k++) {
        if (!parts[k]) continue;
        out.set(parts[k], pos);
        pos += parts[k].length;
      }
      if (pos !== total) throw new Error('分块拼接不完整');
      return out.buffer;
    }, function (err) {
      guard.stop();
      if (guard.stalled()) throw new Error('下载停滞超过 ' + Math.round(BUNDLE_STALL / 1000) + ' 秒');
      throw err;
    });
  }

  /** 下载整包：HEAD 拿长度后分块并行；服务器不支持 Range 时退回单请求 */
  function downloadBundle(url) {
    report('download', 0, 0);
    return fetch(url, { method: 'HEAD', cache: 'no-cache' })
      .then(function (res) {
        var total = Number(res.headers.get('Content-Length')) || 0;
        if (!res.ok || total <= 0) throw new Error('整包不可用（HTTP ' + res.status + '）');
        return downloadChunked(total, url);
      })
      .catch(function () {
        var guard = stallGuard();
        return fetch(url, { cache: 'no-cache', signal: guard.signal }).then(function (res) {
          if (!res.ok) throw new Error('整包不可用（HTTP ' + res.status + '）');
          var total = Number(res.headers.get('Content-Length')) || 0;
          return readStream(res, function (loaded) {
            guard.tick();
            report('download', loaded, total);
          });
        }).then(function (buf) {
          guard.stop();
          return buf;
        }, function (err) {
          guard.stop();
          if (guard.stalled()) throw new Error('下载停滞超过 ' + Math.round(BUNDLE_STALL / 1000) + ' 秒');
          throw err;
        });
      });
  }

  /** 解析 stored（不压缩）zip：读中央目录，返回 { 文件名: Uint8Array } */
  function unzipStored(buffer) {
    var bytes = new Uint8Array(buffer);
    var view = new DataView(buffer);
    var eocd = -1;
    var floor = Math.max(0, bytes.length - 22 - 65535);

    // EOCD 后面可能跟注释，从尾部往前找签名
    for (var p = bytes.length - 22; p >= floor; p--) {
      if (view.getUint32(p, true) === 0x06054b50) { eocd = p; break; }
    }
    if (eocd < 0) throw new Error('压缩包结构无法识别');

    var decoder = global.TextDecoder ? new TextDecoder('utf-8') : null;
    var count = view.getUint16(eocd + 10, true);
    var offset = view.getUint32(eocd + 16, true);
    var files = {};

    for (var n = 0; n < count; n++) {
      if (view.getUint32(offset, true) !== 0x02014b50) throw new Error('压缩包目录损坏');
      var method = view.getUint16(offset + 10, true);
      var size = view.getUint32(offset + 20, true);
      var nameLen = view.getUint16(offset + 28, true);
      var extraLen = view.getUint16(offset + 30, true);
      var commentLen = view.getUint16(offset + 32, true);
      var local = view.getUint32(offset + 42, true);
      var nameBytes = bytes.subarray(offset + 46, offset + 46 + nameLen);
      var name = decoder ? decoder.decode(nameBytes) : String.fromCharCode.apply(null, nameBytes);
      offset += 46 + nameLen + extraLen + commentLen;

      if (name.charAt(name.length - 1) === '/') continue;
      if (method !== 0) throw new Error('压缩包内 ' + name + ' 不是 stored 格式');

      if (view.getUint32(local, true) !== 0x04034b50) throw new Error('压缩包条目损坏：' + name);
      var start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
      files[name] = bytes.subarray(start, start + size);
    }
    return files;
  }

  /** 解包后转成 blob URL 交给 Tone.Sampler：采样直接从内存解码，不再发请求 */
  function samplerFromBundle(buffer, bus) {
    var files = unzipStored(buffer);
    var urls = {};
    var blobs = [];
    var missing = [];

    Object.keys(SAMPLER_URLS).forEach(function (note) {
      var name = SAMPLER_URLS[note];
      var data = files[name];
      if (!data || !data.length) { missing.push(name); return; }
      var url = URL.createObjectURL(new Blob([data], { type: 'audio/mpeg' }));
      urls[note] = url;
      blobs.push(url);
    });

    function release() {
      blobs.forEach(function (url) {
        try { URL.revokeObjectURL(url); } catch (e) { /* noop */ }
      });
    }

    if (missing.length) {
      release();
      return Promise.reject(new Error('压缩包缺少 ' + missing.join('、')));
    }

    return openSampler({ urls: urls }, bus, DECODE_TIMEOUT).then(function (sampler) {
      release(); // 采样已解码进内存，blob 可以释放
      return sampler;
    }, function (err) {
      release();
      throw err;
    });
  }

  /** 整包加载：缓存命中直接用，否则从 url 下载后写缓存，再解包 */
  function loadBundle(bus, url) {
    return readCachedBundle().then(function (cached) {
      if (cached && cached.byteLength) return cached;
      return downloadBundle(url).then(function (buffer) {
        if (!buffer || !buffer.byteLength) throw new Error('整包内容为空');
        writeCachedBundle(buffer); // 不阻塞本次入声
        return buffer;
      });
    }).then(function (buffer) {
      report('unzip', 0, 0);
      return samplerFromBundle(buffer, bus);
    });
  }

  /**
   * 建一个 Sampler 并等它加载完成。
   * options 支持 { urls, baseUrl }；timeout 毫秒内没加载完就放弃，换下一个源。
   */
  function openSampler(options, bus, timeout) {
    return new Promise(function (resolve, reject) {
      var Tone = global.Tone;
      var timer = 0;
      var settled = false;
      var sampler = null;
      var config = {
        urls: options.urls,
        attack: 0.001,
        release: 1.15,
        curve: 'exponential',
        onload: ok,
        onerror: function () { fail('采样文件加载失败'); }
      };
      if (options.baseUrl) config.baseUrl = options.baseUrl;

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

      sampler = new Tone.Sampler(config);
      sampler.volume.value = -2;
      sampler.connect(bus);
      // 源半通不通时会一直挂着，超时后丢弃换下一个源
      timer = setTimeout(function () { fail('采样加载超时'); }, timeout);
    });
  }

  /** 测速选节点 → CDN 整包 → CDN 分散采样 → 本地整包 → 本地分散采样；全部失败返回 null */
  function loadSampler(bus) {
    return pickCdn().then(function (best) {
      var sources = [];

      // 测速最快的节点优先；国内是镜像，海外是全球节点或原 jsDelivr 主站
      if (best) {
        if (global.console) console.info('[audio] 音源节点：' + best.label + ' ' + best.base);
        sources.push({
          label: best.label, load: function () { return loadBundle(bus, bundleUrl(best.base)); }
        });
      }

      // 该节点取不到整包时，其余 CDN 依次再试
      CDN_BASES.forEach(function (cdn) {
        if (best && cdn.base === best.base) return;
        sources.push({
          label: cdn.label, load: function () { return loadBundle(bus, bundleUrl(cdn.base)); }
        });
      });

      // 整包都异常时，改用同一个 CDN 上的分散采样
      sources.push({
        label: 'CDN 分散采样', load: function () {
          return openSampler({ urls: SAMPLER_URLS, baseUrl: (best || CDN_BASES[0]).base + 'piano/' }, bus, SOURCE_TIMEOUT);
        }
      });

      // CDN 都不通时回落到 GitHub Pages 上的同一份资源
      sources.push({ label: '本地采样包', load: function () { return loadBundle(bus, BUNDLE_URL); } });
      sources.push({
        label: '本地采样', load: function () {
          return openSampler({ urls: SAMPLER_URLS, baseUrl: LOCAL_SAMPLES }, bus, SOURCE_TIMEOUT);
        }
      });

      function attempt(i) {
        if (i >= sources.length) return Promise.resolve(null);
        return sources[i].load().catch(function (err) {
          var msg = err && err.message ? err.message : String(err);
          // 记录最后一次（本地分散采样）的失败原因，供入场页展示
          A.lastError = sources[i].label + '不可用：' + msg;
          if (global.console) {
            console.warn('[audio] ' + sources[i].label + '不可用：' + msg);
          }
          return attempt(i + 1);
        });
      }
      return attempt(0);
    });
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
            A.lastError = '';
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
        A.lastError = '';
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