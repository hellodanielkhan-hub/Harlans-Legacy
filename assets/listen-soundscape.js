/* =========================================================================
   Harlan's Legacy — Listening soundscape (story-specific emotional score)

   Ported VERBATIM from the legacy engine's approved soundscape so the Blue
   Chair atmosphere is preserved exactly. This module owns ONLY the music +
   atmosphere buses (an independent WebAudio graph); the narration is a plain
   <audio> element outside this graph and remains the authoritative voice
   track and reading clock. The `duck` node lowers music+atmosphere while the
   narrator is speaking. Missing zones / no WebAudio → a no-op controller
   (fails gracefully; the cinematic reading still works in silence).

   SOURCE OF TRUTH: the soundscape registry below is the approved score. Do not
   replace it with a drone or a random generator. "blue-chair" is a real chord
   progression (C · Am7 · Fmaj7 · G6) as felt-piano arpeggios through a short
   reverb, a low bass per change, soft room tone and the watch-tick motif,
   tuned to sit clearly beneath the narration.
   ========================================================================= */
(function () {
  "use strict";

  /* ---- Soundscape registry: maker(ctx,{atmos,music},isPaused) -> {drive,silence,stop} ---- */
  var SOUNDSCAPES = {
    "blue-chair": function (ctx, out, isPaused) {
      var A = out.atmos, M = out.music;
      var conv = ctx.createConvolver();
      (function () { var len = Math.floor(ctx.sampleRate * 1.5), ib = ctx.createBuffer(2, len, ctx.sampleRate); for (var ch = 0; ch < 2; ch++) { var d = ib.getChannelData(ch); for (var i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.8); } conv.buffer = ib; })();
      var wet = ctx.createGain(); wet.gain.value = 0.32; conv.connect(wet); wet.connect(M);
      var musicGain = ctx.createGain(); musicGain.gain.value = 1; musicGain.connect(M); musicGain.connect(conv);
      function note(freq, when, dur, vel) {
        var o1 = ctx.createOscillator(), o2 = ctx.createOscillator();
        o1.type = "triangle"; o2.type = "sine"; o1.frequency.value = freq; o2.frequency.value = freq; o2.detune.value = 5;
        var lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 2400; lp.Q.value = 0.5;
        var g = ctx.createGain();
        o1.connect(lp); o2.connect(lp); lp.connect(g); g.connect(musicGain);
        g.gain.setValueAtTime(0.0001, when); g.gain.linearRampToValueAtTime(vel, when + 0.014); g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
        o1.start(when); o2.start(when); o1.stop(when + dur + 0.05); o2.stop(when + dur + 0.05);
      }
      function bass(freq, when, dur, vel) {
        var o = ctx.createOscillator(); o.type = "sine"; o.frequency.value = freq;
        var g = ctx.createGain(); o.connect(g); g.connect(musicGain);
        g.gain.setValueAtTime(0.0001, when); g.gain.linearRampToValueAtTime(vel, when + 0.03); g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
        o.start(when); o.stop(when + dur + 0.05);
      }
      var CH = [
        { bass: 130.81, notes: [261.63, 329.63, 392.00, 523.25] },
        { bass: 110.00, notes: [220.00, 261.63, 329.63, 392.00] },
        { bass: 87.31,  notes: [174.61, 261.63, 329.63, 440.00] },
        { bass: 98.00,  notes: [196.00, 246.94, 329.63, 392.00] }
      ];
      var beat = 0.66, chordBeats = 8;
      var state = { level: 0, density: 0.85 };
      var step = 0, nextTime = 0, started = false, schedTimer = null;
      function scheduler() {
        if (isPaused && isPaused()) return;
        var ahead = ctx.currentTime + 0.3;
        while (nextTime < ahead) {
          var chord = CH[Math.floor(step / chordBeats) % CH.length];
          var bic = step % chordBeats, lvl = state.level;
          if (lvl > 0.02) {
            if (bic === 0) bass(chord.bass, nextTime, 2.6, 0.16 * lvl);
            var play = (bic === 0) || (bic === 4) || (Math.random() < state.density);
            if (play) { var ni = (bic + (bic >= 4 ? 1 : 0)) % chord.notes.length; var human = (Math.random() - 0.5) * 0.02; note(chord.notes[ni], nextTime + human, 1.9, (0.085 + 0.03 * (bic % 2 === 0 ? 1 : 0)) * lvl); }
          }
          nextTime += beat; step++;
        }
      }
      var rlen = ctx.sampleRate * 2, rb = ctx.createBuffer(1, rlen, ctx.sampleRate), rd = rb.getChannelData(0), last = 0;
      for (var i = 0; i < rlen; i++) { var wn = Math.random() * 2 - 1; last = (last + 0.02 * wn) / 1.02; rd[i] = last * 2.6; }
      var room = ctx.createBufferSource(); room.buffer = rb; room.loop = true;
      var rlp = ctx.createBiquadFilter(); rlp.type = "lowpass"; rlp.frequency.value = 480;
      var rg = ctx.createGain(); rg.gain.value = 0.12; room.connect(rlp); rlp.connect(rg); rg.connect(A); room.start();
      var tickG = ctx.createGain(); tickG.gain.value = 0; tickG.connect(A);
      var tickTimer = setInterval(function () { if (isPaused && isPaused()) return; var t = ctx.currentTime, o = ctx.createOscillator(); o.type = "triangle"; o.frequency.value = 1650; var bp = ctx.createBiquadFilter(); bp.type = "bandpass"; bp.frequency.value = 1800; bp.Q.value = 6; var g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.1, t + 0.004); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.06); o.connect(bp); bp.connect(g); g.connect(tickG); o.start(t); o.stop(t + 0.08); }, 1500);
      function at(g, v, tc) { g.gain.setTargetAtTime(v, ctx.currentTime, tc); }
      var ZMAP = { warmth: [0.85, 0.7, 0.5], tender: [1.0, 0.9, 0.6], reflection: [0.5, 0.4, 0.32], grief: [0.14, 0.15, 0.0], grace: [0.82, 0.7, 0.4], acceptance: [0.6, 0.55, 0.34] };
      return {
        drive: function (t, zone, dur) {
          if (!started) { started = true; nextTime = ctx.currentTime + 0.2; schedTimer = setInterval(scheduler, 25); }
          if (dur && t > dur - 3.2) { state.level = 0.7; state.density = 0.45; at(tickG, 0.14, 1.6); return; }
          var m = (zone && ZMAP[zone]) ? ZMAP[zone] : [0.6, 0.6, 0.36];
          state.level = m[0]; state.density = m[1]; at(tickG, m[2], zone === "grief" ? 0.6 : 1.0);
        },
        silence: function () { state.level = 0; at(tickG, 0, 0.4); },
        stop: function () { try { clearInterval(schedTimer); } catch (e) {} try { clearInterval(tickTimer); } catch (e) {} }
      };
    },
    // a neutral fallback for stories without a dedicated scape: quiet room tone only
    "default": function (ctx, out) {
      var A = out.atmos;
      var rlen = ctx.sampleRate * 2, rb = ctx.createBuffer(1, rlen, ctx.sampleRate), rd = rb.getChannelData(0), last = 0;
      for (var i = 0; i < rlen; i++) { var wn = Math.random() * 2 - 1; last = (last + 0.02 * wn) / 1.02; rd[i] = last * 2.4; }
      var room = ctx.createBufferSource(); room.buffer = rb; room.loop = true;
      var rlp = ctx.createBiquadFilter(); rlp.type = "lowpass"; rlp.frequency.value = 440;
      var rg = ctx.createGain(); rg.gain.value = 0.08; room.connect(rlp); rlp.connect(rg); rg.connect(A); room.start();
      return { drive: function () {}, silence: function () {}, stop: function () {} };
    }
  };

  var ZLUM = { warmth: 1.0, tender: 1.03, reflection: 0.98, grief: 0.92, grace: 1.0, acceptance: 0.98 };

  // Build the independent music+atmosphere graph. `isPaused` lets the scape idle
  // its schedulers while paused. Returns a controller the cinematic engine drives.
  function create(opts) {
    opts = opts || {};
    var name = opts.soundscape || "default";
    var zones = null;                 // set later via setZones()
    var atmosLevel = (opts.atmos != null) ? opts.atmos : 0.55;
    var actx = null, master = null, limiter = null, duck = null, atmosBus = null, musicBus = null, scape = null, lastZone = null, alive = false;
    var isPaused = opts.isPaused || function () { return false; };

    function build() {
      if (actx) return true;
      try { actx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { actx = null; return false; }
      limiter = actx.createDynamicsCompressor();
      limiter.threshold.value = -9; limiter.knee.value = 8; limiter.ratio.value = 10; limiter.attack.value = 0.005; limiter.release.value = 0.2; limiter.connect(actx.destination);
      master = actx.createGain(); master.gain.value = 0.0; master.connect(limiter);
      duck = actx.createGain(); duck.gain.value = 1; duck.connect(master);
      musicBus = actx.createGain(); musicBus.gain.value = 0.95; musicBus.connect(duck);
      atmosBus = actx.createGain(); atmosBus.gain.value = atmosLevel; atmosBus.connect(duck);
      var maker = SOUNDSCAPES[name] || SOUNDSCAPES["default"];
      try { scape = maker(actx, { atmos: atmosBus, music: musicBus }, isPaused); } catch (e) { scape = null; }
      alive = true;
      return true;
    }
    function zoneAt(t) { if (!zones || !zones.length) return null; for (var i = 0; i < zones.length; i++) if (t >= zones[i].start && t < zones[i].end) return zones[i].zone; return zones[zones.length - 1].zone; }

    return {
      ok: function () { return true; },
      setZones: function (z) { zones = (z && z.zones) ? z.zones : (Array.isArray(z) ? z : null); },
      // called when narration starts / resumes — brings the music+atmos level up
      resume: function () { if (!build()) return; try { if (actx.state === "suspended") actx.resume(); } catch (e) {} if (master && actx) master.gain.setTargetAtTime(0.9, actx.currentTime, 0.7); },
      // per-frame: drive the scape to the current zone, and duck under speech.
      // returns the luminance multiplier for the current zone (for subtle page light).
      frame: function (t, dur, speaking) {
        if (!actx || !alive) return 1;
        var z = zoneAt(t);
        if (scape) { try { scape.drive(t, z, dur); } catch (e) {} }
        if (duck) duck.gain.setTargetAtTime(speaking ? 0.66 : 1.0, actx.currentTime, speaking ? 0.12 : 0.45);
        lastZone = z;
        return ZLUM[z] || 1;
      },
      setAtmos: function (v) { atmosLevel = v; if (atmosBus && actx) atmosBus.gain.setTargetAtTime(v, actx.currentTime, 0.1); },
      silence: function () { if (scape) { try { scape.silence(); } catch (e) {} } if (master && actx) master.gain.setTargetAtTime(0, actx.currentTime, 0.3); },
      teardown: function () { alive = false; if (scape) { try { scape.stop(); } catch (e) {} } try { if (actx && actx.close) actx.close(); } catch (e) {} actx = master = duck = musicBus = atmosBus = scape = null; }
    };
  }

  window.HLSoundscape = { create: create, SOUNDSCAPES: SOUNDSCAPES };
})();
