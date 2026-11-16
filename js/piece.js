/* ===========================================================
   piece.js — 内置曲目：Letters in Aether
   一首原创钢琴小品（原创旋律，非任何既有作品的转写），
   用来自带一份完整、可播放的谱面。
   结构：前奏 4 + A 8 + A' 8 + B 8 + C 8 + A'' 8 + 尾声 4 = 48 小节
   =========================================================== */
(function (global) {
  'use strict';

  var PITCH = {
    C: 0, 'C#': 1, D: 2, 'D#': 3, E: 4, F: 5,
    'F#': 6, G: 7, 'G#': 8, A: 9, 'A#': 10, B: 11
  };

  /** "F#5" -> MIDI 编号 */
  function toMidi(name) {
    var m = /^([A-G]#?)(-?\d)$/.exec(name);
    if (!m) throw new Error('无法解析音高: ' + name);
    return (Number(m[2]) + 1) * 12 + PITCH[m[1]];
  }

  /* 和声字典
     bass : 左手低音（八度下方）
     arp  : 分解和弦的四个音，由低到高                          */
  var CHORDS = {
    D:      { bass: 38, arp: [50, 57, 62, 66] }, // D2  | D3 A3 D4 F#4
    'D/Cs': { bass: 37, arp: [49, 57, 61, 64] }, // C#2 | C#3 A3 C#4 E4
    Bm7:    { bass: 35, arp: [47, 54, 57, 62] }, // B1  | B2 F#3 A3 D4
    Bm9:    { bass: 35, arp: [47, 54, 57, 61] }, // B1  | B2 F#3 A3 C#4
    Gmaj7:  { bass: 43, arp: [50, 54, 59, 62] }, // G2  | D3 F#3 B3 D4
    G:      { bass: 43, arp: [50, 55, 59, 62] }, // G2  | D3 G3 B3 D4
    'D/Fs': { bass: 42, arp: [50, 57, 62, 66] }, // F#2 | D3 A3 D4 F#4
    A:      { bass: 45, arp: [52, 57, 61, 64] }, // A2  | E3 A3 C#4 E4
    Em7:    { bass: 40, arp: [47, 52, 55, 59] }, // E2  | B2 E3 G3 B3
    Fsm7:   { bass: 42, arp: [49, 54, 57, 61] }  // F#2 | C#3 F#3 A3 C#4
  };

  /* 主题 A —— 全曲的歌唱性主旋律 */
  var A_BARS = [
    { ch: 'D',      mel: 'A5:1.5 F#5:0.5 E5:1 F#5:1' },
    { ch: 'D/Cs',   mel: 'E5:2 C#5:1.5 r:0.5' },
    { ch: 'Bm7',    mel: 'D5:1.5 B4:0.5 D5:1 F#5:1' },
    { ch: 'Gmaj7',  mel: 'E5:1 D5:0.5 E5:0.5 G5:2' },
    { ch: 'D/Fs',   mel: 'F#5:1.5 A5:0.5 B5:1 A5:1' },
    { ch: 'G',      mel: 'G5:2 B5:1.5 r:0.5' },
    { ch: 'A',      mel: 'A5:1.5 G5:0.5 F#5:1 E5:1' },
    { ch: 'D',      mel: 'D5:3 r:1' }
  ];

  /* 主题 B —— 上行推进，情绪抬起 */
  var B_BARS = [
    { ch: 'Bm7',    mel: 'B5:1 A5:0.5 B5:0.5 D6:1 B5:1' },
    { ch: 'Gmaj7',  mel: 'A5:2 F#5:2' },
    { ch: 'D/Fs',   mel: 'E5:1 F#5:0.5 A5:0.5 F#5:1 A5:1' },
    { ch: 'A',      mel: 'B5:2 A5:2' },
    { ch: 'Bm9',    mel: 'B5:1.5 A5:0.5 F#5:1 A5:1' },
    { ch: 'Gmaj7',  mel: 'B5:1 A5:0.5 G5:0.5 A5:2' },
    { ch: 'Em7',    mel: 'G5:1 A5:0.5 B5:0.5 D6:1 B5:1' },
    { ch: 'A',      mel: 'A5:3 r:1' }
  ];

  /* 主题 C —— 桥段，气息舒展 */
  var C_BARS = [
    { ch: 'Gmaj7',  mel: 'D5:1 E5:0.5 G5:0.5 B5:2' },
    { ch: 'A',      mel: 'A5:1 B5:0.5 A5:0.5 E5:2' },
    { ch: 'Fsm7',   mel: 'F#5:1.5 A5:0.5 C#6:1 A5:1' },
    { ch: 'Bm7',    mel: 'B5:2 F#5:2' },
    { ch: 'Em7',    mel: 'E5:1 G5:0.5 B5:0.5 E6:1 D6:1' },
    { ch: 'A',      mel: 'C#6:1.5 B5:0.5 A5:2' },
    { ch: 'D',      mel: 'F#5:1 A5:1 D6:1.5 r:0.5' },
    { ch: 'A',      mel: 'A5:2 E5:2' }
  ];

  var INTRO_BARS = [
    { ch: 'Gmaj7',  mel: 'r:2 B4:1 D5:1' },
    { ch: 'A',      mel: 'E5:2 C#5:2' },
    { ch: 'D',      mel: 'D5:1 F#5:1 A5:1.5 r:0.5' },
    { ch: 'D',      mel: 'A5:1 A5:0.5 G5:0.5 F#5:1 E5:1' }
  ];

  var OUTRO_BARS = [
    { ch: 'Gmaj7',  mel: 'B5:2 A5:1 G5:1' },
    { ch: 'A',      mel: 'E5:3 r:1' },
    { ch: 'D',      mel: 'D5:4' },
    { ch: 'D',      mel: 'r:4' }
  ];

  var SECTIONS = [
    { id: 'intro', bars: INTRO_BARS, arp: 0.20, mel: 0.46, bass: 0.17 },
    { id: 'A',     bars: A_BARS,     arp: 0.29, mel: 0.70, bass: 0.24 },
    { id: 'A2',    bars: A_BARS,     arp: 0.31, mel: 0.73, bass: 0.25, oct: 0,  dbl: true  },
    { id: 'B',     bars: B_BARS,     arp: 0.33, mel: 0.78, bass: 0.27, oct: 0,  dbl: true  },
    { id: 'C',     bars: C_BARS,     arp: 0.32, mel: 0.78, bass: 0.26, oct: 0,  dbl: false },
    { id: 'A3',    bars: A_BARS,     arp: 0.35, mel: 0.82, bass: 0.29, oct: 12, dbl: true  },
    { id: 'outro', bars: OUTRO_BARS, arp: 0.18, mel: 0.44, bass: 0.15 }
  ];

  /** 把 "A5:1.5 F#5:0.5 r:1" 这样的写法解析成音符数组（单位：拍） */
  function parseMel(str, startBeat) {
    var out = [];
    var t = startBeat;
    var tokens = str.trim().split(/\s+/);
    for (var i = 0; i < tokens.length; i++) {
      var tok = tokens[i];
      if (!tok || tok === '|') continue;
      var parts = tok.split(':');
      var dur = parseFloat(parts[1]);
      if (!isFinite(dur) || dur <= 0) continue;
      if (parts[0] !== 'r') {
        out.push({ midi: toMidi(parts[0]), start: t, dur: dur, vel: 1 });
      }
      t += dur;
    }
    return out;
  }

  var ARP_PATTERN = [0, 1, 2, 3, 2, 1, 2, 3];

  /**
   * 生成整首曲子。
   * @returns {{title,subtitle,bpm,beatsPerBar,notes:Array,duration,barCount}}
   *          notes: [{ midi, start(秒), dur(秒), vel(0~1) }]，按 start 升序
   */
  function buildSong() {
    var bpm = 72;
    var beatsPerBar = 4;
    var spb = 60 / bpm;               // 每拍秒数
    var raw = [];
    var bar = 0;
    var barLines = [];

    for (var s = 0; s < SECTIONS.length; s++) {
      var sec = SECTIONS[s];
      for (var b = 0; b < sec.bars.length; b++) {
        var spec = sec.bars[b];
        var chord = CHORDS[spec.ch];
        var start = bar * beatsPerBar;
        barLines.push(start * spb);

        if (!chord) throw new Error('未知和弦: ' + spec.ch);

        // 左手低音
        raw.push({ midi: chord.bass, start: start, dur: 4, vel: sec.bass, hand: 'L' });

        // 左手分解和弦（八分音符）
        for (var i = 0; i < 8; i++) {
          var pick = ARP_PATTERN[i];
          raw.push({
            midi: chord.arp[pick],
            start: start + i * 0.5,
            // 后半段略作上扬，避免机械感
            dur: 0.95,
            vel: sec.arp * (i % 2 === 0 ? 1 : 0.82) * (i === 0 ? 1.12 : 1),
            hand: 'L'
          });
        }

        // 右手旋律
        var mel = parseMel(spec.mel, start);
        for (var k = 0; k < mel.length; k++) {
          var n = mel[k];
          raw.push({
            midi: n.midi + (sec.oct || 0),
            start: n.start,
            dur: n.dur,
            vel: sec.mel,
            hand: 'R'
          });
          // 八度加厚
          if (sec.dbl) {
            raw.push({
              midi: n.midi + (sec.oct || 0) - 12,
              start: n.start,
              dur: n.dur,
              vel: sec.mel * 0.42,
              hand: 'R'
            });
          }
        }

        bar++;
      }
    }

    // 拍 -> 秒，并做一次收尾整理
    var notes = [];
    for (var j = 0; j < raw.length; j++) {
      var x = raw[j];
      notes.push({
        midi: Math.max(21, Math.min(108, x.midi)),
        start: x.start * spb,
        dur: Math.max(0.08, x.dur * spb - 0.02),
        vel: Math.max(0.04, Math.min(1, x.vel)),
        hand: x.hand
      });
    }
    notes.sort(function (lhs, rhs) { return lhs.start - rhs.start; });

    var end = 0;
    for (var q = 0; q < notes.length; q++) {
      end = Math.max(end, notes[q].start + notes[q].dur);
    }

    return {
      title: 'Letters in Aether',
      subtitle: '原创钢琴小品 · 内置示范',
      bpm: bpm,
      beatsPerBar: beatsPerBar,
      barLines: barLines,
      barCount: bar,
      notes: notes,
      duration: end + 1.6
    };
  }

  global.Piece = {
    toMidi: toMidi,
    buildSong: buildSong
  };
})(window);