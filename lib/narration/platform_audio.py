# =========================================================================
# Harlan's Legacy — PLATFORM AUDIO PIPELINE (provider-neutral)
# NARRATION_PROVIDER_SPEC.md §4 / §6 / §8
#
# Platform-owned, identical for every provider:
#   • finalize()    — Golden audio standard: per-chunk median-speech-level loudness
#                     normalization, planned gaps, 6 ms edge fades, -1.0 dBFS peak
#                     ceiling, 1.5 s end silence, zone marks. (Moved VERBATIM from the
#                     Chatterbox worker; the worker now imports it from here.)
#   • align()       — canonical wav2vec2 forced alignment (verbatim move).
#   • encode_mp3()  — mono 128 kbps, lameenc q2 (verbatim move).
#   • measure()     — acceptance metrics: peak, LUFS, loudness spread, clipping,
#                     internal gaps, speaker similarity, ASR word-error rate.
#
# CLI (post-processing any provider's output into the platform asset contract):
#   finalize --chunks-dir D --plan plan.json --out DIR [--refs a,b]   (Mode C: per-chunk audio)
#   verify   --audio FILE   --plan plan.json --out DIR [--zones z.json] [--refs a,b]  (Mode F: final mix)
# Writes: narration.mp3, narration.words.json, narration.zones.json, metrics.json
#   measure  --audio MP3 --plan plan.json --words W --zones Z --out metrics.json [--refs a,b]
#            (MEASUREMENT ONLY: re-verifies a delivered narration — decoded-artifact
#             loudness/peak, ASR, speaker similarity, and agreement between an
#             independent re-alignment and the delivered word timings. Writes one file.)
# =========================================================================
import sys, os, re, json, time, math, argparse, shutil

HERE = os.path.dirname(os.path.abspath(__file__))
_VOICELAB = os.path.normpath(os.path.join(HERE, "..", "..", "prototype", "voicelab"))
os.environ.setdefault("HF_HOME", os.path.join(_VOICELAB, "hfcache"))
os.environ.setdefault("TORCH_HOME", os.path.join(_VOICELAB, "torchcache"))
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")
import numpy as np

AUDIO_STANDARD_VERSION = "audio-standard/1"
FINALIZER_VERSION = "golden-finalizer/1"
ALIGNER_VERSION = "wav2vec2-base-960h-forced/1"
ENCODER_VERSION = "lameenc-128k-mono-q2/1"
MEASURE_VERSION = "platform-measure/1"

FADE_S = 0.006
PEAK_CEILING = 0.891           # -1.0 dBFS
END_SIL_S = 1.5

def _log(*a): print(*a, flush=True)
def tokens(s): return [t for t in re.findall(r"\S+", s) if re.search(r"[A-Za-z0-9]", t)]

# ---------------- finalizer (verbatim from harlan_golden.py) ----------------
def speech_level(a, sr):
    win, hop = int(0.025*sr), int(0.010*sr); nf = 1 + (max(0, len(a)-win))//hop
    r = np.array([np.sqrt((a[i*hop:i*hop+win]**2).mean()+1e-12) for i in range(nf)])
    thr = np.percentile(r, 55)
    return float(np.median(r[r >= thr])) if (r >= thr).any() else float(r.mean())

def finalize(raw, sr, chunks, log=_log):
    # --- per-chunk loudness normalization (median RMS target; preserves dynamics) ---
    levels = [speech_level(a, sr) for a in raw]
    target = float(np.median(levels))
    before = 20*math.log10(max(levels)/max(min(levels), 1e-9))
    norm = [a*(target/max(lv, 1e-9)) for a, lv in zip(raw, levels)]
    after = [speech_level(a, sr) for a in norm]
    log(f"loudness spread BEFORE={before:.1f}dB AFTER={20*math.log10(max(after)/max(min(after),1e-9)):.1f}dB")
    # --- concat with per-chunk gap_before + 6ms edge fades; record zone marks ---
    fade = int(FADE_S*sr); pieces = []; cursor = 0.0; zmarks = []
    for c, a in zip(chunks, norm):
        gap = float(c.get("gap_before_s", 0.0) or 0.0)
        if gap > 0: pieces.append(np.zeros(int(gap*sr), dtype=np.float32)); cursor += gap
        a = a.copy()
        if len(a) > 2*fade: a[:fade] *= np.linspace(0, 1, fade); a[-fade:] *= np.linspace(1, 0, fade)
        start = cursor; pieces.append(a); cursor += len(a)/sr
        zmarks.append({"zone": c.get("zone", "conversational"), "start": round(start, 3), "end": round(cursor, 3)})
    pieces.append(np.zeros(int(END_SIL_S*sr), dtype=np.float32)); cursor += END_SIL_S
    audio = np.concatenate(pieces)
    pk = float(np.max(np.abs(audio)))
    if pk > PEAK_CEILING: audio *= PEAK_CEILING/pk                 # -1.0 dBFS ceiling, no compression
    # merge consecutive same-zone marks
    zones = []
    for z in zmarks:
        if zones and zones[-1]["zone"] == z["zone"]: zones[-1]["end"] = z["end"]
        else: zones.append(dict(z))
    return audio, zones

# ---------------- canonical aligner (verbatim from harlan_golden.py) ----------------
def load_align_model(device="cpu"):
    import torchaudio
    bundle = torchaudio.pipelines.WAV2VEC2_ASR_BASE_960H
    model = bundle.get_model().to(device); model.eval()
    return bundle, model

def align(audio, sr, display, bundle=None, model=None, device="cpu", return_emission=False):
    import torch, torchaudio
    if bundle is None: bundle = torchaudio.pipelines.WAV2VEC2_ASR_BASE_960H
    D = {c: i for i, c in enumerate(bundle.get_labels())}
    ALIGN = ["".join(c for c in re.sub(r"[^A-Z']", "", t.upper()) if c in D) or "A" for t in display]
    if model is None: model = bundle.get_model().to(device); model.eval()
    wav = torch.tensor(audio, dtype=torch.float32).unsqueeze(0)
    if sr != bundle.sample_rate: wav = torchaudio.functional.resample(wav, sr, bundle.sample_rate)
    asr = bundle.sample_rate; wav = wav.to(device)
    with torch.inference_mode(): emission, _ = model(wav)
    emission = emission.cpu()
    tokenized = [D[c] for w in ALIGN for c in w]
    aligned, scores = torchaudio.functional.forced_align(emission, torch.tensor([tokenized], dtype=torch.int32), blank=0)
    spans = torchaudio.functional.merge_tokens(aligned[0], scores[0].exp())
    out, i = [], 0; word_spans = []
    for L in [len(w) for w in ALIGN]: word_spans.append(spans[i:i+L]); i += L
    ratio = wav.size(1)/emission.size(1); words = []
    for k, (disp, ws) in enumerate(zip(display, word_spans)):
        s = ws[0].start*ratio/asr; e = ws[-1].end*ratio/asr
        words.append({"i": k, "w": disp, "start": round(float(s), 3), "end": round(float(e), 3)})
    for k in range(1, len(words)):
        if words[k]["start"] < words[k-1]["end"]: words[k]["start"] = words[k-1]["end"]
        if words[k]["end"] < words[k]["start"]: words[k]["end"] = words[k]["start"] + 0.02
    if return_emission: return words, emission, bundle
    return words

# ---------------- encoder (verbatim from harlan_golden.py) ----------------
def encode_mp3(path, audio, sr):
    import lameenc
    pcm = (np.clip(audio, -1, 1)*32767).astype(np.int16).tobytes()
    enc = lameenc.Encoder(); enc.set_bit_rate(128); enc.set_in_sample_rate(int(sr)); enc.set_channels(1); enc.set_quality(2)
    open(path, "wb").write(enc.encode(pcm) + enc.flush())

# ---------------- measurement suite ----------------
def decode(path, sr=None):
    import librosa
    a, s = librosa.load(path, sr=sr, mono=True)
    return a.astype(np.float32), int(s)

def peak_dbfs(audio):
    pk = float(np.max(np.abs(audio))) if len(audio) else 0.0
    return round(20*math.log10(max(pk, 1e-9)), 2)

def integrated_lufs(audio, sr):
    try:
        import pyloudnorm as pyln
        return round(float(pyln.Meter(sr).integrated_loudness(audio.astype(np.float64))), 2)
    except Exception:
        return None

def span_level_spread_db(audio, sr, spans):
    levels = []
    for sp in spans:
        a = audio[int(sp["start"]*sr):int(sp["end"]*sr)]
        if len(a) > int(0.05*sr): levels.append(speech_level(a, sr))
    if len(levels) < 2: return None
    return round(20*math.log10(max(levels)/max(min(levels), 1e-9)), 2)

def clipped_samples(audio, thr=0.999):
    return int(np.sum(np.abs(audio) >= thr))

def max_internal_gap_s(audio, sr, silence_dbfs=-50.0):
    hop = int(0.010*sr); thr = 10**(silence_dbfs/20)
    n = len(audio)//hop
    if n < 3: return 0.0
    rms = np.sqrt(np.array([np.mean(audio[i*hop:(i+1)*hop]**2) for i in range(n)]) + 1e-12)
    quiet = rms < thr
    lead = int(0.3/0.010); tail = int((END_SIL_S+0.5)/0.010)   # ignore leading 0.3 s and the planned end silence
    best = run = 0
    for i in range(lead, max(lead, n-tail)):
        run = run+1 if quiet[i] else 0
        best = max(best, run)
    return round(best*0.010, 2)

def asr_greedy(emission, bundle):
    labels = bundle.get_labels()
    ids = emission[0].argmax(dim=-1).tolist()
    out = []; prev = None
    for t in ids:
        if t != prev and t != 0: out.append(labels[t])
        prev = t
    return [w for w in "".join(out).split("|") if w]

def _norm_ref(display):
    return [w for w in (re.sub(r"[^A-Z']", "", t.upper()) for t in display) if w]

def wer(ref, hyp):
    n, m = len(ref), len(hyp)
    if n == 0: return None
    prev = list(range(m+1))
    for i in range(1, n+1):
        cur = [i] + [0]*m
        for j in range(1, m+1):
            cur[j] = min(prev[j]+1, cur[j-1]+1, prev[j-1] + (0 if ref[i-1] == hyp[j-1] else 1))
        prev = cur
    return round(prev[m]/n, 4)

_ENC = None
def speaker_similarity(audio, sr, refs):
    global _ENC
    try:
        from resemblyzer import VoiceEncoder, preprocess_wav
        if _ENC is None: _ENC = VoiceEncoder("cpu", verbose=False)
        e = _ENC.embed_utterance(preprocess_wav(audio, source_sr=sr))
        out = {}
        for name, path in refs.items():
            if not path or not os.path.exists(path): out[name] = None; continue
            ra, rsr = decode(path)
            re_ = _ENC.embed_utterance(preprocess_wav(ra, source_sr=rsr))
            out[name] = round(float(np.dot(e, re_) / (np.linalg.norm(e)*np.linalg.norm(re_) + 1e-12)), 4)
        return out
    except Exception as ex:
        return {"error": str(ex)}

def alignment_checks(words, duration):
    mono = all(words[k]["start"] >= words[k-1]["end"] - 1e-6 for k in range(1, len(words)))
    within = bool(words) and words[-1]["end"] <= duration + 1e-3 and all(w["end"] >= w["start"] for w in words)
    return {"timedWords": len(words), "monotonic": mono, "withinDuration": within,
            "coverage": round(words[-1]["end"]/duration, 4) if words and duration else 0}

def measure(audio, sr, words, zones, refs, emission=None, bundle=None, display=None, chunk_spans=None):
    t = {}; m = {"versions": {"measure": MEASURE_VERSION, "aligner": ALIGNER_VERSION, "audioStandard": AUDIO_STANDARD_VERSION}}
    duration = len(audio)/sr
    m["durationS"] = round(duration, 3); m["sr"] = sr
    m["peakDbfs"] = peak_dbfs(audio)
    t0 = time.time(); m["integratedLufs"] = integrated_lufs(audio, sr); t["lufsS"] = round(time.time()-t0, 2)
    m["loudnessSpreadDb"] = span_level_spread_db(audio, sr, chunk_spans) if chunk_spans else None
    m["zoneLoudnessSpreadDb"] = span_level_spread_db(audio, sr, zones) if zones else None
    m["clippedSamples"] = clipped_samples(audio)
    m["maxInternalGapS"] = max_internal_gap_s(audio, sr)
    m["alignment"] = alignment_checks(words, duration)
    if emission is not None and bundle is not None and display is not None:
        t0 = time.time()
        hyp = asr_greedy(emission, bundle); ref = _norm_ref(display)
        m["asr"] = {"model": "wav2vec2-base-960h greedy CTC", "wer": wer(ref, hyp), "refWords": len(ref), "hypWords": len(hyp)}
        t["asrS"] = round(time.time()-t0, 2)
    t0 = time.time(); m["speakerSimilarity"] = speaker_similarity(audio, sr, refs or {}); t["speakerS"] = round(time.time()-t0, 2)
    m["timings"] = t
    return m

# ---------------- CLI (post-process a provider's output) ----------------
def _display_from_plan(plan):
    disp = []
    for c in plan["chunks"]: disp.extend(tokens(c["text"]))
    return disp

def _refs(arg):
    out = {}
    for item in (arg or "").split(","):
        if "=" in item:
            k, v = item.split("=", 1); out[k.strip()] = v.strip()
    return out

def _write_outputs(out, audio, sr, words, zones, metrics, method, mp3_src=None):
    os.makedirs(out, exist_ok=True)
    t0 = time.time()
    if mp3_src and mp3_src.lower().endswith(".mp3"): shutil.copyfile(mp3_src, os.path.join(out, "narration.mp3"))
    else: encode_mp3(os.path.join(out, "narration.mp3"), audio, sr)
    metrics.setdefault("timings", {})["encodeS"] = round(time.time()-t0, 2)
    json.dump({"count": len(words), "sr": sr, "method": method, "aligner": ALIGNER_VERSION, "words": words},
              open(os.path.join(out, "narration.words.json"), "w", encoding="utf-8"))
    json.dump({"duration": round(len(audio)/sr, 2), "zones": zones}, open(os.path.join(out, "narration.zones.json"), "w", encoding="utf-8"))
    json.dump(metrics, open(os.path.join(out, "metrics.json"), "w", encoding="utf-8"), indent=1)

def cli_finalize(a):
    plan = json.load(open(a.plan, encoding="utf-8")); chunks = plan["chunks"]
    t0 = time.time(); raw = []; sr = None
    for c in chunks:
        x, s = decode(os.path.join(a.chunks_dir, "chunk_%d.wav" % c["i"]))
        if sr is None: sr = s
        if s != sr: raise SystemExit("chunk sample rates differ")
        raw.append(x)
    decode_s = time.time()-t0
    t0 = time.time(); audio, zones = finalize(raw, sr, chunks); fin_s = time.time()-t0
    # chunk spans for loudness-spread measurement
    spans = []; cur = 0.0
    for c, x in zip(chunks, raw):
        cur += float(c.get("gap_before_s", 0) or 0); spans.append({"start": cur, "end": cur + len(x)/sr}); cur += len(x)/sr
    disp = _display_from_plan(plan)
    t0 = time.time(); words, em, bundle = align(audio, sr, disp, return_emission=True); al_s = time.time()-t0
    m = measure(audio, sr, words, zones, _refs(a.refs), em, bundle, disp, spans)
    m["timings"].update({"decodeS": round(decode_s, 2), "finalizeS": round(fin_s, 2), "alignS": round(al_s, 2)})
    m["mode"] = "C"; m["versions"]["finalizer"] = FINALIZER_VERSION; m["versions"]["encoder"] = ENCODER_VERSION
    _write_outputs(a.out, audio, sr, words, zones, m, "platform canonical: golden finalizer + wav2vec2 forced alignment")
    _log("PLATFORM_DONE " + json.dumps({"mode": "C", "durationS": m["durationS"], "timedWords": len(words)}))

def cli_verify(a):
    plan = json.load(open(a.plan, encoding="utf-8"))
    t0 = time.time(); audio, sr = decode(a.audio); decode_s = time.time()-t0
    zones = json.load(open(a.zones, encoding="utf-8")).get("zones", []) if a.zones else []
    disp = _display_from_plan(plan)
    t0 = time.time(); words, em, bundle = align(audio, sr, disp, return_emission=True); al_s = time.time()-t0
    m = measure(audio, sr, words, zones, _refs(a.refs), em, bundle, disp, None)
    m["timings"].update({"decodeS": round(decode_s, 2), "alignS": round(al_s, 2)})
    m["mode"] = "F"
    _write_outputs(a.out, audio, sr, words, zones, m, "platform canonical: wav2vec2 forced alignment (verify)", mp3_src=a.audio)
    _log("PLATFORM_DONE " + json.dumps({"mode": "F", "durationS": m["durationS"], "timedWords": len(words)}))

def cli_measure(a):
    plan = json.load(open(a.plan, encoding="utf-8"))
    t0 = time.time(); audio, sr = decode(a.audio); decode_s = time.time()-t0
    delivered = json.load(open(a.words, encoding="utf-8"))["words"]
    zones = json.load(open(a.zones, encoding="utf-8")).get("zones", []) if a.zones else []
    disp = _display_from_plan(plan)
    t0 = time.time(); words, em, bundle = align(audio, sr, disp, return_emission=True); al_s = time.time()-t0
    m = measure(audio, sr, delivered, zones, _refs(a.refs), em, bundle, disp, None)
    # Delivered timings come from the pre-encode mix; this re-alignment decodes the MP3, which adds a
    # constant codec delay. Report the constant offset and the offset-corrected (relative) spread.
    sd = sorted([x["start"]-y["start"] for x, y in zip(words, delivered)] + [x["end"]-y["end"] for x, y in zip(words, delivered)])
    d = sorted(abs(v) for v in sd)
    off = sd[len(sd)//2] if sd else None
    dc = sorted(abs(v - off) for v in sd) if sd else []
    q = lambda arr, p: round(arr[max(0, int(p*len(arr))-1)], 4) if arr else None
    m["realignment"] = {"words": len(words), "deliveredWords": len(delivered), "sameCount": len(words) == len(delivered),
                        "medianAbsDeltaS": round(d[len(d)//2], 4) if d else None, "p95AbsDeltaS": q(d, 0.95), "maxAbsDeltaS": round(d[-1], 4) if d else None,
                        "medianSignedDeltaS": round(off, 4) if off is not None else None, "offsetCorrectedP95S": q(dc, 0.95),
                        "offsetCorrectedMaxS": round(dc[-1], 4) if dc else None}
    m["timings"].update({"decodeS": round(decode_s, 2), "realignS": round(al_s, 2)})
    m["mode"] = "measure"; m["source"] = "decoded delivered artifact"
    json.dump(m, open(a.out, "w", encoding="utf-8"), indent=1)
    _log("PLATFORM_DONE " + json.dumps({"mode": "measure", "durationS": m["durationS"]}))

def main():
    ap = argparse.ArgumentParser(); sub = ap.add_subparsers(dest="cmd", required=True)
    f = sub.add_parser("finalize"); f.add_argument("--chunks-dir", required=True); f.add_argument("--plan", required=True); f.add_argument("--out", required=True); f.add_argument("--refs", default="")
    v = sub.add_parser("verify"); v.add_argument("--audio", required=True); v.add_argument("--plan", required=True); v.add_argument("--out", required=True); v.add_argument("--zones", default=""); v.add_argument("--refs", default="")
    ms = sub.add_parser("measure"); ms.add_argument("--audio", required=True); ms.add_argument("--plan", required=True); ms.add_argument("--words", required=True); ms.add_argument("--zones", default=""); ms.add_argument("--out", required=True); ms.add_argument("--refs", default="")
    a = ap.parse_args()
    import torch
    if not torch.cuda.is_available(): torch.set_num_threads(os.cpu_count() or 4)
    {"finalize": cli_finalize, "verify": cli_verify, "measure": cli_measure}[a.cmd](a)

if __name__ == "__main__":
    main()
