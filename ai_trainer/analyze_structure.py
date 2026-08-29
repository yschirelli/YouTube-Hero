import sys
import json
import librosa
import numpy as np
import warnings

warnings.filterwarnings('ignore')

def analyze_structure(audio_path):
    try:
        # ── 1. LOAD ──────────────────────────────────────────────────────────
        y, sr = librosa.load(audio_path, sr=22050, mono=True)
        
        # ── 2. ONSET ENVELOPES ──────────────────────────────────────────────
        hop_length = 512
        n_fft = 2048
        
        # SuperFlux-style onset envelope (handles vibrato/pitch variations and complex rhythms better)
        S = np.abs(librosa.stft(y, hop_length=hop_length, n_fft=n_fft))
        S_db = librosa.amplitude_to_db(S, ref=np.max)
        onset_env_full = librosa.onset.onset_strength(S=S_db, sr=sr, hop_length=hop_length, aggregate=np.median, max_size=3)
        
        # Low frequency onset envelope: slice STFT directly to focus on kick drum/bass (< 250 Hz)
        fmax = 250
        max_bin = int(np.round(fmax * n_fft / sr))
        S_low = S[:max_bin, :]
        S_low_db = librosa.amplitude_to_db(S_low, ref=np.max)
        onset_env_low = librosa.onset.onset_strength(S=S_low_db, sr=sr, hop_length=hop_length, aggregate=np.median, max_size=3)
        
        # Combine envelopes (gives extra weight to the low-end beat foundation)
        onset_combo = 0.7 * onset_env_full + 0.3 * onset_env_low

        # ── 3. TEMPO ESTIMATION WITH HARMONIC REINFORCEMENT ─────────────────
        # Compute global autocorrelation of the combined envelope up to lag 120 (approx 21.5 BPM)
        ac = librosa.autocorrelate(onset_combo, max_size=120)
        
        # Find local peaks in autocorrelation
        peaks = []
        for i in range(10, len(ac) - 1):
            if ac[i] > ac[i-1] and ac[i] > ac[i+1]:
                bpm = 60.0 * sr / (hop_length * i)
                peaks.append((bpm, ac[i], i))
                
        def get_ac_val(lag):
            lag_round = int(round(lag))
            if 0 <= lag_round < len(ac):
                return ac[lag_round]
            return 0.0
            
        best_bpm = 120.0
        if peaks:
            scored_candidates = []
            for bpm, val, lag in peaks:
                # Score calculation with harmonic reinforcement
                score = val
                score += 0.6 * get_ac_val(lag * 2)    # half tempo support
                score += 0.6 * get_ac_val(lag / 2)    # double tempo support
                score += 0.3 * get_ac_val(lag * 4)    # quarter tempo support
                score += 0.3 * get_ac_val(lag / 4)    # quadruple tempo support
                
                # Soft Gaussian prior centered at 120 BPM
                prior_weight = np.exp(-0.5 * ((bpm - 120.0) / 50.0) ** 2)
                final_score = score * prior_weight
                
                scored_candidates.append((bpm, final_score))
                
            scored_candidates.sort(key=lambda x: x[1], reverse=True)
            best_bpm = scored_candidates[0][0]
            
        # Fold to standard playing range [70, 160] BPM for chart playability
        folded_tempo = best_bpm
        while folded_tempo < 70.0:
            folded_tempo *= 2.0
        while folded_tempo > 160.0:
            folded_tempo /= 2.0

        # Track beats using the combined envelope and the robust tempo estimate
        tempo, beat_frames = librosa.beat.beat_track(
            onset_envelope=onset_combo, sr=sr, hop_length=hop_length, bpm=folded_tempo
        )
        
        # Use our final folded tempo for the returned data
        tempo_val = float(folded_tempo)
        print(f"[STRUCT] Detected tempo: {tempo_val:.1f} BPM, {len(beat_frames)} beats",
              file=sys.stderr)

        print(json.dumps({
            "tempo": tempo_val
        }))

    except Exception as e:
        import traceback
        err_msg = str(e) + "\n" + traceback.format_exc()
        print(json.dumps({"error": err_msg}))


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"error": "No audio path provided"}))
        sys.exit(1)

    analyze_structure(sys.argv[1])
