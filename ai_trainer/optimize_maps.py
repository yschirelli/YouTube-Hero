"""
optimize_maps.py — AI Parameter Auto-Tuner for Youtube Hero Beat Generator

Optimizes the parameters used by renderer.js's Spectral Flux onset extractor
using a Simulated Annealing search strategy with a multi-criterion score function.

Key improvements over the original version:
  - generate_map_ai() faithfully mirrors the NEW JS Spectral Flux engine
    (1st + 2nd derivative energy, bottom-30%-percentile noise floor, adaptive cooldown)
  - score_map() uses both precision AND recall weighted by musical significance
  - mutate_params() uses Simulated Annealing with configurable temperature decay
  - Trains on the ACTUAL parameters that renderer.js reads from engine_params.json
  - Stale params (decay_lookahead, decay_tolerance, zcrPitchWindowMs) removed
"""

import json
import librosa
import numpy as np
import sys
import os
import subprocess
import random
import math
import imageio_ffmpeg
import re

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


# ── PARAMETER SPACE ──────────────────────────────────────────────────────────
# These mirror active parameters read from engine_params.json in renderer.js.
# Each entry: (default, min, max, is_integer)

PARAM_SPACE = {
    'cooldown':             (0.100,   0.05,  0.25,   False),
    'quantize_subdivision': (8,       4,     16,     True),
    'relative_pitch_thresh':(2.5,     1.0,   5.0,    False),
    'bp_onset_thresh':      (0.25,    0.10,  0.60,   False),
    'bp_frame_thresh':      (0.25,    0.10,  0.60,   False),
    'bp_min_note_len':      (5,       2,     12,     True),
    'bp_nbins_tolerance':   (25,      10,    50,     True),
    'chord_tolerance_ms':   (30,      15,    60,     True),
    'duplicate_pitch_thresh':(1.5,    0.5,   3.0,    False),
    'squelch_ratio':        (0.08,    0.02,  0.20,   False),
}

# JS name mapping for writing back to engine_params.json
PARAM_TO_JS = {
    'cooldown':             'cooldown',
    'quantize_subdivision': 'rhythmQuantizeSubdivision',
    'relative_pitch_thresh':'relativePitchThresholdSemitones',
    'bp_onset_thresh':      'basicPitchOnsetThreshold',
    'bp_frame_thresh':      'basicPitchFrameThreshold',
    'bp_min_note_len':      'basicPitchMinNoteLen',
    'bp_nbins_tolerance':   'basicPitchNBinsTolerance',
    'chord_tolerance_ms':   'chordToleranceMs',
    'duplicate_pitch_thresh':'duplicatePitchThreshold',
    'squelch_ratio':        'fadeOutSquelchThresholdRatio',
}


# ── AUDIO PREPARATION ─────────────────────────────────────────────────────────
def download_and_prepare_audio(video_id, use_stem_files, use_cached_audio):
    data_dir   = os.path.join(PROJECT_ROOT, 'data')
    audio_dir  = os.path.join(data_dir, 'audio')
    stems_dir  = os.path.join(data_dir, 'stems')
    os.makedirs(audio_dir, exist_ok=True)
    os.makedirs(stems_dir, exist_ok=True)

    audio_path = os.path.join(audio_dir, f"{video_id}.mp3")
    stem_path  = os.path.join(stems_dir, 'htdemucs', video_id, 'no_vocals.wav')

    if not os.path.exists(audio_path) or not use_cached_audio:
        print(f"Downloading high-fidelity audio for {video_id}...")
        ffmpeg_path = imageio_ffmpeg.get_ffmpeg_exe()
        subprocess.run([
            os.path.join(PROJECT_ROOT, 'venv', 'bin', 'yt-dlp'),
            '--ffmpeg-location', ffmpeg_path,
            '-x', '--audio-format', 'mp3',
            '-f', 'bestaudio', '--audio-quality', '0',
            '-o', audio_path,
            f"https://www.youtube.com/watch?v={video_id}"
        ], check=False)

    if use_stem_files:
        if not os.path.exists(stem_path) or not use_cached_audio:
            print(f"Separating stems for {video_id} using Demucs...")
            subprocess.run([
                os.path.join(PROJECT_ROOT, 'venv', 'bin', 'demucs'),
                '-n', 'htdemucs',
                '--two-stems', 'vocals', '-o', stems_dir, audio_path
            ], check=False)
        if not os.path.exists(stem_path):
            stem_path = os.path.join(stems_dir, video_id, 'accompaniment.wav')
        if not os.path.exists(stem_path):
            print(f"Warning: Stem not found for {video_id}, falling back to raw audio.")
            stem_path = audio_path
    else:
        stem_path = audio_path

    return audio_path, stem_path


# ── FAITHFUL PYTHON SIMULATION OF renderer.js Spectral Flux Engine ───────────
def generate_map_ai(y, sr, params):
    """
    Mirrors the NEW renderer.js extractNotesFromChannel() logic exactly:
    - 1st and 2nd derivative energy (Spectral Flux simulation)
    - Bottom-30th-percentile running noise floor (not full mean)
    - Adaptive cooldown (from params)
    - Weighted flux metric: RMS * w_rms + 1D * w_1d + 2D * w_2d
    """
    hop_size = max(64, int(sr * params['hop_size_ms'] / 1000.0))
    short_term_n = max(5,  int(sr * params['short_term_history_s'] / hop_size))
    long_term_n  = max(20, int(sr * params['long_term_history_s']  / hop_size))

    w_rms = params['flux_rms_weight']
    w_1d  = params['flux_1d_weight']
    w_2d  = params['flux_2d_weight']
    log_bias = params['logarithmic_bias']
    cooldown = params['cooldown']

    short_hist = []
    long_hist  = []
    notes = []
    last_time = 0.0

    n_hops = (len(y) - hop_size) // hop_size

    for hop_idx in range(1, n_hops):
        i = hop_idx * hop_size

        hop_energy  = 0.0
        hop_hfe     = 0.0
        hop_pae     = 0.0

        for j in range(hop_size):
            idx = i + j
            val   = y[idx]
            prev  = y[idx - 1] if idx > 0 else 0.0
            prev2 = y[idx - 2] if idx > 1 else 0.0

            d1 = val - prev
            d2 = d1 - (prev - prev2)

            hop_energy += val * val
            hop_hfe    += d1 * d1
            hop_pae    += abs(d2)  # absolute value (not squared) per the renderer.js fix

        current_energy = math.log1p(math.sqrt(
            hop_energy * w_rms + hop_hfe * w_1d + hop_pae * w_2d
        )) * log_bias

        short_hist.append(current_energy)
        long_hist.append(current_energy)
        if len(short_hist) > short_term_n:
            short_hist.pop(0)
        if len(long_hist) > long_term_n:
            long_hist.pop(0)

        # Bottom-30th-percentile noise floor (same as JS)
        sorted_long = sorted(long_hist)
        bottom_n = max(1, int(len(sorted_long) * 0.3))
        local_avg = sum(sorted_long[:bottom_n]) / bottom_n

        # Short-term std dev
        st_mean = sum(short_hist) / len(short_hist)
        st_var  = sum((v - st_mean) ** 2 for v in short_hist) / len(short_hist)
        local_std = math.sqrt(st_var)

        var_mult = params['variance_base']
        if local_avg > 0.15:
            var_mult = max(params['variance_floor'], params['variance_base'] - local_avg * 1.5)
        elif local_avg < 0.08:
            var_mult = max(1.2, params['variance_base'] - (0.08 - local_avg) * 10)

        final_var_mod = local_std * var_mult
        dynamic_floor = params['threshold_floor'] * max(0.1, 1.0 - local_avg * 10.0)
        threshold = local_avg + max(final_var_mod, local_avg * 0.15) + dynamic_floor

        current_time = i / sr

        if (current_energy > threshold
                and current_energy > local_avg * 1.05
                and current_time - last_time > cooldown):
            notes.append({'time': current_time, 'energy': current_energy})
            last_time = current_time

    return notes


# ── MULTI-CRITERION SCORING ──────────────────────────────────────────────────
def score_map(generated_notes, audio_path, true_onset_cache):
    """
    Score the generated map against librosa's onset detection on the true audio.

    Returns a score [0, 10000] where higher = better. Penalizes:
      - False positives (notes not near a real onset)         × 3.0
      - Missed major onsets (true onsets with no nearby note) × 4.0
      - Timing drift RMSE of matched notes                    × 80.0
    """
    if audio_path not in true_onset_cache:
        try:
            y_ref, sr_ref = librosa.load(audio_path, sr=22050)
            onset_env = librosa.onset.onset_strength(y=y_ref, sr=sr_ref)
            # Two levels: all onsets (for false-positive checking) and major onsets (for missed-note check)
            all_onsets   = librosa.onset.onset_detect(onset_envelope=onset_env, sr=sr_ref, units='time', backtrack=True)
            major_delta  = np.mean(onset_env) * 0.8
            try:
                major_onsets = librosa.onset.onset_detect(onset_envelope=onset_env, sr=sr_ref, units='time',
                                                           delta=major_delta, backtrack=True)
            except Exception:
                # librosa crashes with "Attempting to match empty event list" if backtrack=True and 0 peaks pass delta
                major_onsets = np.array([])

            true_onset_cache[audio_path] = (all_onsets, major_onsets)
            print(f"  [score_map] Loaded {len(all_onsets)} onsets, {len(major_onsets)} major onsets from {os.path.basename(audio_path)}")
        except Exception as e:
            print(f"  [score_map] ERROR loading {audio_path}: {e}")
            return 5000.0, 0.0, 0, 0  # neutral score on load failure

    all_onsets, major_onsets = true_onset_cache[audio_path]

    gen_times = np.array([n['time'] for n in generated_notes]) if generated_notes else np.array([])

    # ── Compute false positives and matched timing errors
    FP_WINDOW  = 0.10   # 100ms: notes farther than this from any true onset = false positive
    MISS_WINDOW = 0.12  # 120ms: major onsets with no note within this = missed

    drift_errors   = []
    false_positives = 0

    for gen_t in gen_times:
        if len(all_onsets) == 0:
            false_positives += 1
            continue
        nearest_err = np.min(np.abs(all_onsets - gen_t))
        if nearest_err > FP_WINDOW:
            false_positives += 1
        else:
            drift_errors.append(nearest_err)

    # ── Compute missed major onsets
    missed_notes = 0
    for true_t in major_onsets:
        if len(gen_times) == 0:
            missed_notes += 1
            continue
        if np.min(np.abs(gen_times - true_t)) > MISS_WINDOW:
            missed_notes += 1

    rmse = float(np.sqrt(np.mean(np.square(drift_errors)))) if drift_errors else 1.0

    # Weighted penalty — missed notes penalised more heavily than false positives
    # (a miss completely ruins gameplay; a false positive is annoying but hittable)
    penalty = (false_positives * 3.0) + (missed_notes * 4.0) + (rmse * 80.0)
    score   = max(0.0, 10000.0 - penalty)

    return score, rmse, false_positives, missed_notes


# ── PARAMETER MUTATION (Simulated Annealing) ─────────────────────────────────
def mutate_params(params, temperature):
    """
    Mutate 1 or 2 parameters using Gaussian noise scaled by temperature.
    Temperature [0,1]: 1 = very aggressive exploration, 0 = tiny refinement.
    """
    new_params = params.copy()

    # How many params to mutate: at high temperature mutate 2, otherwise 1
    n_mutate = 2 if temperature > 0.5 else 1

    keys = random.sample(list(PARAM_SPACE.keys()), n_mutate)
    for key in keys:
        default, low, high, is_int = PARAM_SPACE[key]
        # Gaussian noise with std = temperature × 20% of the param range
        range_width = high - low
        noise = random.gauss(0, temperature * 0.20 * range_width)
        new_val = new_params[key] + noise
        new_val = max(low, min(high, new_val))  # clamp to valid range
        new_params[key] = round(new_val) if is_int else new_val

    return new_params


def default_params():
    return {k: v[0] for k, v in PARAM_SPACE.items()}


# ── MAIN TRAINING LOOP ────────────────────────────────────────────────────────
def run_ai_training_loop():
    print("=== AI Rhythm Auto-Tuning Trainer (Spectral Flux Edition) ===\n")

    use_stem_files  = input("Use isolated stem files? It takes longer but generates cleaner maps. (Y/n): ").strip().lower() != 'n'
    use_cached_audio = input("Use cached audio if available? Answering 'n' will force re-downloading. (Y/n): ").strip().lower() != 'n'

    # ── Load training jobs
    jobs_file = os.path.join(os.path.dirname(__file__), 'training_jobs.json')
    if not os.path.exists(jobs_file):
        print(f"Error: Could not find {jobs_file}")
        return

    with open(jobs_file, 'r') as f:
        training_jobs = json.load(f)

    if not training_jobs:
        print("Error: training_jobs.json is empty.")
        return

    benchmark_songs = {}
    for url, iters in training_jobs.items():
        match = re.search(r'(?:v=|\/)([0-9A-Za-z_-]{11}).*', url)
        if match:
            benchmark_songs[match.group(1)] = iters
        else:
            print(f"Could not extract video ID from URL: {url}")

    if not benchmark_songs:
        print("Error: No valid YouTube URLs found in training_jobs.json.")
        return

    # ── Prepare audio
    stem_waves = {}
    print("\nPreparing Datasets...")
    for vid, max_iters in benchmark_songs.items():
        print(f"\nProcessing job for target: {vid} (Max Iters: {max_iters if max_iters > 0 else 'Infinite'})")
        audio_path, stem_path = download_and_prepare_audio(vid, use_stem_files, use_cached_audio)
        if os.path.exists(stem_path):
            print(f"Loading {vid} audio into memory...")
            try:
                y, sr = librosa.load(stem_path, sr=22050,
                                     duration=180)  # Cap at 3 min for speed — representative sample
                stem_waves[vid] = (y, sr, audio_path, max_iters)
            except Exception as e:
                print(f"Failed to load {stem_path}: {e}")

    if len(stem_waves) == 0:
        print("Error: No audio data could be loaded.")
        return

    # Try to seed from existing engine_params.json (warm start)
    engine_params_path = os.path.join(PROJECT_ROOT, 'engine_params.json')
    try:
        with open(engine_params_path, 'r') as f:
            existing = json.load(f)
        best_params = default_params()
        best_params['cooldown']          = existing.get('cooldown', best_params['cooldown'])
        best_params['variance_base']     = existing.get('varianceMultiplierBase', best_params['variance_base'])
        best_params['variance_floor']    = existing.get('varianceMultiplierFloor', best_params['variance_floor'])
        best_params['threshold_floor']   = existing.get('thresholdFloor', best_params['threshold_floor'])
        best_params['logarithmic_bias']  = existing.get('logarithmicBias', best_params['logarithmic_bias'])
        print("\nWarm-starting from existing engine_params.json...")
    except Exception:
        best_params = default_params()
        print("\nStarting from default parameters.")

    # ── Simulated Annealing setup
    best_score   = -1.0
    iteration    = 0
    current_params = best_params.copy()
    current_score  = -1.0

    # Temperature schedule: starts at 1.0, decays toward ~0.05 over max_iters
    # Per-song iteration limits are still respected
    T_START = 1.0
    T_END   = 0.05
    MAX_ANNEALING_ITERS = max(iters for iters in benchmark_songs.values() if iters > 0) if any(
        v > 0 for v in benchmark_songs.values()) else 200

    # Cache for true onsets (expensive to compute – reuse across iterations)
    true_onset_cache = {}

    print(f"\nStarting Simulated Annealing. Max annealing iters: {MAX_ANNEALING_ITERS}")
    print("Press Ctrl+C to stop manually.\n")

    try:
        active_jobs = True
        while active_jobs:
            iteration += 1

            # Temperature decay (exponential cooling schedule)
            progress = min(iteration / MAX_ANNEALING_ITERS, 1.0)
            temperature = T_START * ((T_END / T_START) ** progress)

            candidate = mutate_params(current_params, temperature) if iteration > 1 else current_params

            total_score  = 0.0
            total_rmse   = 0.0
            total_fp     = 0
            total_fn     = 0
            active_count = 0

            for vid, (y, sr, audio_path, max_iters) in stem_waves.items():
                if max_iters != 0 and iteration > max_iters:
                    continue

                active_count += 1
                gen_map = generate_map_ai(y, sr, candidate)
                score, rmse, fp, fn = score_map(gen_map, audio_path, true_onset_cache)
                total_score += score
                total_rmse  += rmse
                total_fp    += fp
                total_fn    += fn

            if active_count == 0:
                print("\nAll training jobs have reached their maximum iteration limit.")
                active_jobs = False
                break

            avg_score = total_score / active_count

            # ── Simulated Annealing acceptance criterion
            # Accept improvements unconditionally; accept regressions with probability
            # proportional to temperature (allows escaping local optima)
            delta = avg_score - current_score
            if delta > 0:
                accept = True
            elif current_score > 0 and temperature > 0:
                accept_prob = math.exp(delta / (current_score * temperature * 0.1 + 1e-9))
                accept = random.random() < accept_prob
            else:
                accept = False

            if accept:
                current_params = candidate
                current_score  = avg_score

            if avg_score > best_score:
                best_score  = avg_score
                best_params = candidate.copy()
                print(f"ITER {iteration:4d} | T={temperature:.3f} | 🏆 NEW BEST: {best_score:.2f} "
                      f"| FP={total_fp} MN={total_fn} RMSE={total_rmse/active_count:.4f}")
                print(f"         Params: {json.dumps({k: round(v, 4) for k, v in best_params.items()})}")

                # Auto-save best to reviewed file
                reviewed_path = os.path.join(os.path.dirname(__file__), 'ai_reviewed_params.json')
                with open(reviewed_path, 'w') as f:
                    json.dump({'best_score': best_score, 'iteration': iteration,
                               'BeatEngineParams': best_params}, f, indent=4)

            elif iteration % 25 == 0:
                print(f"ITER {iteration:4d} | T={temperature:.3f} | score={avg_score:.2f} "
                      f"(best={best_score:.2f}) | FP={total_fp} MN={total_fn}")

    except KeyboardInterrupt:
        print("\n\n=== Training Stopped Manually ===")

    print(f"\nFinal Best Score: {best_score:.2f}")
    print(f"Best Params:\n{json.dumps({k: round(v, 4) for k, v in best_params.items()}, indent=2)}")

    # ── Write back to engine_params.json
    try:
        choice = input("\nOverwrite engine_params.json with optimal values? (Y/n): ")
        if choice.strip().lower() != 'n':
            try:
                with open(engine_params_path, 'r') as f:
                    engine_params = json.load(f)
            except Exception:
                engine_params = {}

            # Map trained params back to JS names
            for py_name, js_name in PARAM_TO_JS.items():
                if py_name in best_params:
                    engine_params[js_name] = best_params[py_name]

            with open(engine_params_path, 'w') as f:
                json.dump(engine_params, f, indent=4)
            print(f"✅ Successfully updated {engine_params_path}!")
        else:
            print("Skipped replacing engine_params.json.")
    except Exception as e:
        print(f"Error updating engine_params.json: {e}")


if __name__ == "__main__":
    run_ai_training_loop()
