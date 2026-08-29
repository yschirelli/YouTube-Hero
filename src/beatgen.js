// ============================================================================
// BeatGen Algorithm Engine — YouTube Hero v4.0.0
// Extracted beat generation / onset detection / lane assignment logic.
// Includes: ZCR Percussion Discrimination, Harmonic Chord Spacing,
// Section Energy Profiling, Transient Attack Accents, & Sustain Support.
// Loaded before renderer.js. Exposes: window.BeatGen
// ============================================================================

// Global Configuration Object for the Beat Generation Algorithm.
let BeatEngineParams = {};

async function loadBeatEngineParams() {
    BeatEngineParams = await window.gameAPI.loadEngineParams();
    if (!BeatEngineParams) {
        console.warn("Failed to load engine_params.json, using fallback defaults.");
        BeatEngineParams = {
            highpassFilterHz: 70,
            lowpassFilterHz: 10000,
            cooldown: 0.100,
            rhythmQuantizeSubdivision: 8,
            relativePitchThresholdSemitones: 2.5,
            basicPitchOnsetThreshold: 0.25,
            basicPitchFrameThreshold: 0.25,
            basicPitchMinNoteLen: 5,
            basicPitchMaxFreqHz: null,
            basicPitchMinFreqHz: null,
            basicPitchInferOnsets: true,
            basicPitchMelodiaTrick: true,
            basicPitchEnergyTolerance: 11,
            basicPitchNBinsTolerance: 25,
            basicPitchPitchBendCorrected: true,
            chordToleranceMs: 30,
            maxChordSizeEasy: 1,
            maxChordSizeMedium: 2,
            maxChordSizeHard: 3,
            maxChordSizeInsane: 4,
            duplicatePitchThreshold: 1.5,
            fadeOutSquelchThresholdRatio: 0.08
        };
    }
}

/**
 * Safely decodes a WAV ArrayBuffer using pure JS DataView without invoking
 * Chromium's native C++ decodeAudioData (which crashes Electron on large WAV files).
 */
function decodeWavArrayBuffer(arrayBuffer, decodeCtx) {
    try {
        if (!arrayBuffer || arrayBuffer.byteLength < 12) return null;
        const view = new DataView(arrayBuffer);

        // Validate RIFF header ("RIFF" and "WAVE")
        const isRiff = view.getUint32(0, false) === 0x52494646; // "RIFF"
        const isWave = view.getUint32(8, false) === 0x57415645; // "WAVE"
        if (!isRiff || !isWave) return null;

        let offset = 12;
        let channels = 0, sampleRate = 0, bitsPerSample = 0, audioFormat = 1;
        let dataOffset = 0, dataSize = 0;

        while (offset + 8 <= view.byteLength) {
            const chunkId = String.fromCharCode(
                view.getUint8(offset),
                view.getUint8(offset + 1),
                view.getUint8(offset + 2),
                view.getUint8(offset + 3)
            );
            const chunkSize = view.getUint32(offset + 4, true);

            if (chunkId === 'fmt ') {
                audioFormat = view.getUint16(offset + 8, true);
                channels = view.getUint16(offset + 10, true);
                sampleRate = view.getUint32(offset + 12, true);
                bitsPerSample = view.getUint16(offset + 22, true);
            } else if (chunkId === 'data') {
                dataOffset = offset + 8;
                dataSize = chunkSize;
                break;
            }

            offset += 8 + chunkSize;
            if (chunkSize % 2 !== 0) offset += 1; // RIFF chunk 2-byte alignment padding
        }

        if (!channels || !sampleRate || !bitsPerSample || !dataOffset || dataSize <= 0) {
            return null;
        }

        // Bound dataSize to remaining bytes in arrayBuffer
        dataSize = Math.min(dataSize, view.byteLength - dataOffset);
        const bytesPerSample = bitsPerSample / 8;
        const blockAlign = channels * bytesPerSample;
        const numSamples = Math.floor(dataSize / blockAlign);

        if (numSamples <= 0) return null;

        const decodedBuffer = decodeCtx.createBuffer(channels, numSamples, sampleRate);
        const channelArrays = [];
        for (let ch = 0; ch < channels; ch++) {
            channelArrays.push(decodedBuffer.getChannelData(ch));
        }

        let byteIdx = dataOffset;
        if (bitsPerSample === 16) {
            for (let i = 0; i < numSamples; i++) {
                for (let ch = 0; ch < channels; ch++) {
                    const sample = view.getInt16(byteIdx, true);
                    channelArrays[ch][i] = sample < 0 ? sample / 32768.0 : sample / 32767.0;
                    byteIdx += 2;
                }
            }
        } else if (bitsPerSample === 24) {
            for (let i = 0; i < numSamples; i++) {
                for (let ch = 0; ch < channels; ch++) {
                    const b0 = view.getUint8(byteIdx);
                    const b1 = view.getUint8(byteIdx + 1);
                    const b2 = view.getUint8(byteIdx + 2);
                    let val = (b2 << 16) | (b1 << 8) | b0;
                    if (val & 0x800000) val |= 0xFF000000;
                    channelArrays[ch][i] = val / 8388608.0;
                    byteIdx += 3;
                }
            }
        } else if (bitsPerSample === 32 && (audioFormat === 3 || audioFormat === 65534)) {
            for (let i = 0; i < numSamples; i++) {
                for (let ch = 0; ch < channels; ch++) {
                    channelArrays[ch][i] = view.getFloat32(byteIdx, true);
                    byteIdx += 4;
                }
            }
        } else if (bitsPerSample === 32) {
            for (let i = 0; i < numSamples; i++) {
                for (let ch = 0; ch < channels; ch++) {
                    const sample = view.getInt32(byteIdx, true);
                    channelArrays[ch][i] = sample < 0 ? sample / 2147483648.0 : sample / 2147483647.0;
                    byteIdx += 4;
                }
            }
        } else {
            return null;
        }

        return decodedBuffer;
    } catch (e) {
        console.warn("[BEATGEN] Pure JS WAV decoder error:", e);
        return null;
    }
}

/**
 * Main offline audio processor.
 * Decodes audio, applies 3-band filtering, detects drum transients (Kick/Snare/Hi-Hat),
 * runs Basic Pitch AI for melodic notes + transient pick-attack accents, merges timelines,
 * and assigns playable, harmonically ordered lanes.
 */
async function processAudioOffline(arrayBuffer, songTempo = 120, setProgressFill = null, cacheId = null, difficulty = 'Medium') {
    const startTime = performance.now();
    const generationLog = [];
    const log = (msg) => {
        const timestamp = new Date().toLocaleTimeString();
        generationLog.push(`[${timestamp}] ${msg}`);
        console.log(msg);
    };

    log(`[BEATGEN v2.4] processAudioOffline called. Buffer size: ${arrayBuffer.byteLength}, Difficulty: ${difficulty}`);

    if (setProgressFill) setProgressFill(5);

    let finalMap = null;
    const memCacheKey = cacheId || (arrayBuffer ? (arrayBuffer.byteLength + "_" + songTempo) : null);
    if (memCacheKey && window._beatgenFeatureCache && window._beatgenFeatureCache[memCacheKey]) {
        log(`[BEATGEN] Found in-memory feature extraction cache for ${memCacheKey}. Skipping audio extraction.`);
        finalMap = window._beatgenFeatureCache[memCacheKey];
    }

    if (!finalMap && cacheId) {
        try {
            const rawNotes = await window.gameAPI.loadRawNotes(cacheId);
            if (rawNotes && rawNotes.length > 0) {
                log(`[BEATGEN] Found cached raw notes for ${cacheId}. Skipping audio extraction.`);
                finalMap = rawNotes;
                if (memCacheKey) {
                    if (!window._beatgenFeatureCache) window._beatgenFeatureCache = {};
                    window._beatgenFeatureCache[memCacheKey] = finalMap;
                }
            }
        } catch (e) {
            log(`[BEATGEN] Error loading raw notes: ${e}`);
        }
    }

    if (!finalMap) {
        // 1. Decode Audio (Primary: Pure JS WAV Decoder, Fallback: Web Audio API decodeAudioData)
        log(`[BEATGEN] Initializing Web Audio context for decoding...`);
        const decodeCtx = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(1, 1, 44100);
        
        let decodedBuffer = null;
        try {
            log(`[BEATGEN] Attempting pure JS WAV decoder (prevents C++ decodeAudioData renderer crash)...`);
            decodedBuffer = decodeWavArrayBuffer(arrayBuffer, decodeCtx);
            if (decodedBuffer) {
                log(`[BEATGEN] Pure JS WAV decode successful. Channels: ${decodedBuffer.numberOfChannels}, Sample Rate: ${decodedBuffer.sampleRate}Hz, Duration: ${decodedBuffer.duration.toFixed(2)}s`);
            }
        } catch (jsDecodeErr) {
            log(`[BEATGEN] Pure JS WAV decoder error: ${jsDecodeErr}`);
        }

        if (!decodedBuffer) {
            try {
                log(`[BEATGEN] Falling back to Web Audio decodeAudioData...`);
                const bufferCopy = arrayBuffer.slice(0);
                decodedBuffer = await decodeCtx.decodeAudioData(bufferCopy);
                log(`[BEATGEN] decodeAudioData successful. Channels: ${decodedBuffer.numberOfChannels}, Sample Rate: ${decodedBuffer.sampleRate}Hz, Duration: ${decodedBuffer.duration.toFixed(2)}s`);
            } catch (decodeErr) {
                log(`[BEATGEN] decodeAudioData failed (${decodeErr.message || decodeErr}).`);
                throw decodeErr;
            }
        }

        if (!decodedBuffer) {
            throw new Error("Unable to decode audio buffer.");
        }

        if (setProgressFill) setProgressFill(15);

        // 2. Resample to 22050Hz and Apply 3-Band Mono-Downmixed Filters
        const TARGET_SAMPLE_RATE = 22050;
        log(`[BEATGEN] Resampling to ${TARGET_SAMPLE_RATE}Hz via 3-channel mono-downmixed OfflineAudioContext...`);
        const offlineCtx = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(
            3,
            Math.ceil(decodedBuffer.duration * TARGET_SAMPLE_RATE),
            TARGET_SAMPLE_RATE
        );

        const source = offlineCtx.createBufferSource();
        source.buffer = decodedBuffer;

        // Clean mono downmix node (prevents losing panned drum/guitar transients on channel 1)
        const monoDownmix = offlineCtx.createGain();
        monoDownmix.channelCount = 1;
        monoDownmix.channelCountMode = "explicit";
        monoDownmix.channelInterpretation = "speakers";
        source.connect(monoDownmix);

        // Channel 0: Melodic path (General bandpass filter for Basic Pitch)
        let melodicNode = monoDownmix;
        const hpFreq = BeatEngineParams.highpassFilterHz ?? 70;
        if (hpFreq > 20) {
            const hp = offlineCtx.createBiquadFilter();
            hp.type = 'highpass';
            hp.frequency.value = hpFreq;
            melodicNode.connect(hp);
            melodicNode = hp;
        }

        const lpFreq = BeatEngineParams.lowpassFilterHz ?? 10000;
        if (lpFreq < 20000) {
            const lp = offlineCtx.createBiquadFilter();
            lp.type = 'lowpass';
            lp.frequency.value = lpFreq;
            melodicNode.connect(lp);
            melodicNode = lp;
        }

        // TEMPORARY VOCAL SUPPRESSION EQ CUT (Phase 1)
        // Dips the 1.5kHz region by 8dB to reduce vocal salience
        const vocalEq = offlineCtx.createBiquadFilter();
        vocalEq.type = 'peaking';
        vocalEq.frequency.value = 1500;
        vocalEq.Q.value = 1.0;
        vocalEq.gain.value = -8;
        melodicNode.connect(vocalEq);
        melodicNode = vocalEq;

        // Channel 1: Kick drum path (Lowpass 150Hz)
        const kickFilter = offlineCtx.createBiquadFilter();
        kickFilter.type = 'lowpass';
        kickFilter.frequency.value = 150;
        monoDownmix.connect(kickFilter);

        // Channel 2: Snare/Cymbal path (Highpass 3000Hz)
        const snareFilter = offlineCtx.createBiquadFilter();
        snareFilter.type = 'highpass';
        snareFilter.frequency.value = 3000;
        monoDownmix.connect(snareFilter);

        // Merge paths into respective channels of the 3-channel rendered output
        const merger = offlineCtx.createChannelMerger(3);
        melodicNode.connect(merger, 0, 0); // melodic path -> channel 0
        kickFilter.connect(merger, 0, 1);  // kick path -> channel 1
        snareFilter.connect(merger, 0, 2);   // snare path -> channel 2

        merger.connect(offlineCtx.destination);
        source.start(0);

        const audioBuffer = await offlineCtx.startRendering();
        log(`[BEATGEN] Offline audio rendering complete. Duration: ${audioBuffer.duration.toFixed(2)}s`);

        // Extract channel arrays
        const monoData = audioBuffer.getChannelData(0); // melodic channel
        const kickData = audioBuffer.numberOfChannels > 1 ? audioBuffer.getChannelData(1) : monoData;
        const snareData = audioBuffer.numberOfChannels > 2 ? audioBuffer.getChannelData(2) : monoData;

        // Detect fade-out region
        log(`[BEATGEN] Analyzing song volume profile to detect fade-out squelch threshold...`);
        const totalSamples = monoData.length;
        const startIdx = Math.floor(totalSamples * 0.15);
        const endIdx = Math.floor(totalSamples * 0.85);

        let totalRms = 0;
        let rmsCount = 0;
        const windowSize = Math.floor(audioBuffer.sampleRate * 0.5);

        for (let i = startIdx; i < endIdx; i += windowSize) {
            let sum = 0;
            const limit = Math.min(i + windowSize, endIdx);
            for (let j = i; j < limit; j++) {
                sum += monoData[j] * monoData[j];
            }
            totalRms += Math.sqrt(sum / (limit - i));
            rmsCount++;
        }
        const baselineRMS = rmsCount > 0 ? (totalRms / rmsCount) : 0.1;
        log(`[BEATGEN] Active song baseline RMS: ${baselineRMS.toFixed(4)}`);

        const lastSegmentStartIdx = Math.floor(totalSamples * 0.80);
        const squelchThresholdRatio = BeatEngineParams.fadeOutSquelchThresholdRatio ?? 0.08;
        const squelchThreshold = baselineRMS * squelchThresholdRatio;
        let squelchTime = audioBuffer.duration;

        const step = Math.floor(audioBuffer.sampleRate * 1.0);
        let foundActive = false;
        for (let i = totalSamples - step; i >= lastSegmentStartIdx; i -= step) {
            let sum = 0;
            for (let j = i; j < i + step; j++) {
                sum += monoData[j] * monoData[j];
            }
            const chunkRms = Math.sqrt(sum / step);
            if (chunkRms > squelchThreshold) {
                squelchTime = (i + step) / audioBuffer.sampleRate + 0.5;
                foundActive = true;
                break;
            }
        }

        if (foundActive && squelchTime < audioBuffer.duration) {
            log(`[BEATGEN] Detected fade-out starting at ${squelchTime.toFixed(2)}s.`);
        } else {
            log(`[BEATGEN] No fade-out detected or song volume remained high to end.`);
        }

        // 3. Extract Percussive Hits (ZCR-Discriminated Kick / Snare / Cymbal)
        log(`[BEATGEN] Extracting percussive hits via ZCR-discriminated drum scanner...`);
        const percussiveNotes = await extractPercussionHits(kickData, snareData, audioBuffer.sampleRate, songTempo, log, setProgressFill);
        log(`[BEATGEN] Extracted ${percussiveNotes.length} percussion hits.`);

        // 4. Extract Melodic Notes using Spotify Basic Pitch + Transient Attack Accents
        log(`[BEATGEN] Running Basic Pitch AI inference...`);
        const melodicNotes = [];

        try {
            if (!window.BasicPitch) {
                throw new Error("BasicPitch model library not loaded!");
            }

            const basicPitch = new window.BasicPitch('./model/model.json');
            const duration = audioBuffer.duration;

            let totalSq = 0;
            const sampleStep = Math.max(1, Math.floor(monoData.length / 50000));
            let sampleCount = 0;
            for (let s = 0; s < monoData.length; s += sampleStep) {
                totalSq += monoData[s] * monoData[s];
                sampleCount++;
            }
            const trackRms = Math.sqrt(totalSq / Math.max(1, sampleCount));
            log(`[BEATGEN] Track global RMS: ${trackRms.toFixed(4)}`);

            const chunkSize = 60; // seconds
            const overlapSize = 1.0; // seconds
            const chunks = Math.ceil(duration / chunkSize);

            for (let i = 0; i < chunks; i++) {
                await new Promise(r => setTimeout(r, 0)); // UI yield microtask to prevent progress bar stutter
                const startSec = Math.max(0, i * chunkSize - (i > 0 ? overlapSize : 0));
                const endSec = Math.min(duration, (i + 1) * chunkSize + (i < chunks - 1 ? overlapSize : 0));

                const startFrame = Math.floor(startSec * audioBuffer.sampleRate);
                const endFrame = Math.floor(endSec * audioBuffer.sampleRate);

                const chunkData = monoData.subarray(startFrame, endFrame);
                const frames = [], onsets = [], contours = [];

                await basicPitch.evaluateModel(
                    chunkData,
                    (f, o, c) => {
                        frames.push(...f);
                        onsets.push(...o);
                        contours.push(...c);
                    },
                    (pct) => {
                        if (setProgressFill) setProgressFill(50 + ((i + pct) / chunks) * 40);
                    }
                );

                let chunkSq = 0;
                const chunkStep = Math.max(1, Math.floor(chunkData.length / 5000));
                let chunkSampleCount = 0;
                for (let s = 0; s < chunkData.length; s += chunkStep) {
                    chunkSq += chunkData[s] * chunkData[s];
                    chunkSampleCount++;
                }
                const chunkRms = Math.sqrt(chunkSq / Math.max(1, chunkSampleCount));

                let percCountInChunk = 0;
                for (const pn of percussiveNotes) {
                    if (pn.time >= startSec && pn.time <= endSec) percCountInChunk++;
                }

                const isQuietOrDrumless = percCountInChunk < ((endSec - startSec) * 0.5) || chunkRms < (trackRms * 0.75);
                if (isQuietOrDrumless) {
                    log(`[BEATGEN] Chunk ${i+1}/${chunks} detected as Quiet/Drumless (RMS: ${chunkRms.toFixed(4)}, Perc Hits: ${percCountInChunk}). Enabling Adaptive Neural Sensitivity...`);
                }

                const onsetThresh = isQuietOrDrumless ? 0.15 : (BeatEngineParams.basicPitchOnsetThreshold ?? 0.25);
                const frameThresh = isQuietOrDrumless ? 0.15 : (BeatEngineParams.basicPitchFrameThreshold ?? 0.25);
                const minNoteLen = isQuietOrDrumless ? 3 : (BeatEngineParams.basicPitchMinNoteLen ?? 5);
                const inferOnsets = BeatEngineParams.basicPitchInferOnsets ?? true;
                const maxFreqHz = BeatEngineParams.basicPitchMaxFreqHz ?? null;
                const minFreqHz = BeatEngineParams.basicPitchMinFreqHz ?? null;
                const melodiaTrick = BeatEngineParams.basicPitchMelodiaTrick ?? true;
                const energyTolerance = BeatEngineParams.basicPitchEnergyTolerance ?? 11;
                const nBinsTolerance = BeatEngineParams.basicPitchNBinsTolerance ?? 25;
                const pitchBendCorrected = BeatEngineParams.basicPitchPitchBendCorrected ?? true;

                const bpNotes = window.noteFramesToTime(
                    window.addPitchBendsToNoteEvents(
                        contours,
                        window.outputToNotesPoly(
                            frames, onsets, onsetThresh, frameThresh,
                            minNoteLen, inferOnsets, maxFreqHz, minFreqHz,
                            melodiaTrick, energyTolerance
                        ),
                        nBinsTolerance
                    )
                );

                const canonicalStart = i * chunkSize;
                const canonicalEnd = (i === chunks - 1) ? duration : (i + 1) * chunkSize;

                for (const bp of bpNotes) {
                    const absTime = startSec + bp.startTimeSeconds;
                    if (absTime >= canonicalStart && absTime < canonicalEnd) {
                        let finalPitchMidi = bp.pitchMidi;
                        let hasVibrato = false;
                        if (pitchBendCorrected && bp.pitchBends && bp.pitchBends.length > 0) {
                            let bendSum = 0;
                            let bendMin = 9999, bendMax = -9999;
                            let directionChanges = 0;
                            for (let b = 0; b < bp.pitchBends.length; b++) {
                                const bend = bp.pitchBends[b];
                                bendSum += bend;
                                if (bend < bendMin) bendMin = bend;
                                if (bend > bendMax) bendMax = bend;
                                if (b > 1 && ((bp.pitchBends[b] - bp.pitchBends[b-1]) > 0) !== ((bp.pitchBends[b-1] - bp.pitchBends[b-2]) > 0)) {
                                    directionChanges++;
                                }
                            }
                            finalPitchMidi += (bendSum / bp.pitchBends.length) / 3.0; // 3 bins per semitone

                            // Wiggle / Vibrato detection: amplitude >= 0.5 semitones (1.5 bins) and alternating direction changes
                            if (bp.durationSeconds >= 0.4 && (bendMax - bendMin) >= 1.5 && directionChanges >= 3) {
                                hasVibrato = true;
                            }
                        }

                        // Sustain length calculation (populates note length if duration >= 0.35s)
                        const sustainLen = (bp.durationSeconds && bp.durationSeconds >= 0.35) ? bp.durationSeconds : 0;

                        melodicNotes.push({
                            time: absTime,
                            pitch: Math.min(1.0, Math.max(0.0, (finalPitchMidi - 21) / (108 - 21))),
                            midiPitch: finalPitchMidi,
                            rawPitch: finalPitchMidi,
                            _comparePitch: finalPitchMidi,
                            rawFrequency: 440 * Math.pow(2, (finalPitchMidi - 69) / 12),
                            isPercussion: false,
                            hasVibrato: hasVibrato,
                            energy: bp.amplitude,
                            duration: bp.durationSeconds,
                            length: sustainLen,
                            isAccent: hasVibrato
                        });
                    }
                }
                await new Promise(r => setTimeout(r, 10)); // Unfreeze UI loop
            }

            // Calculate Physical Waveform Transient Snapping & Pick-Attack Energy
            const sr = audioBuffer.sampleRate;
            const searchBackSamples = Math.floor(sr * 0.035); // -35ms
            const searchFwdSamples = Math.floor(sr * 0.010);  // +10ms
            const attackWindowSamples = Math.floor(sr * 0.020); // 20ms

            for (const note of melodicNotes) {
                const centerSample = Math.floor(note.time * sr);
                const searchStart = Math.max(1, centerSample - searchBackSamples);
                const searchEnd = Math.min(monoData.length - 1, centerSample + searchFwdSamples);

                let maxDeriv = 0;
                let bestPeakSample = centerSample;

                // Find exact physical attack transient (steepest 1st derivative slope) with cached previous sample
                let prevS = monoData[searchStart - 1];
                for (let s = searchStart; s <= searchEnd; s++) {
                    const currS = monoData[s];
                    const diff1 = Math.abs(currS - prevS);
                    if (diff1 > maxDeriv) {
                        maxDeriv = diff1;
                        bestPeakSample = s;
                    }
                    prevS = currS;
                }

                // Snap timestamp to physical pick attack if significant slope exists
                if (maxDeriv > 0.005) {
                    note.time = bestPeakSample / sr;
                }

                // Compute transient pick-attack energy around physical attack sample with cached previous sample
                const startSmp = Math.max(0, bestPeakSample - attackWindowSamples);
                const endSmp = Math.min(monoData.length - 1, bestPeakSample + attackWindowSamples);
                let attackSum = 0;
                let prevA = monoData[startSmp];
                for (let s = startSmp + 1; s < endSmp; s++) {
                    const currA = monoData[s];
                    const d = currA - prevA;
                    attackSum += d * d;
                    prevA = currA;
                }
                note.transientAttackEnergy = Math.sqrt(attackSum / Math.max(1, endSmp - startSmp));
            }

            if (melodicNotes.length > 5) {
                const attacks = new Float64Array(melodicNotes.length);
                for (let i = 0; i < melodicNotes.length; i++) {
                    attacks[i] = melodicNotes[i].transientAttackEnergy;
                }
                attacks.sort(); // Ascending
                const cutoffIdx = Math.floor(attacks.length * 0.80);
                const attackCutoff = attacks[cutoffIdx] !== undefined ? attacks[cutoffIdx] : 0.05;
                for (const note of melodicNotes) {
                    if (note.transientAttackEnergy >= attackCutoff) {
                        note.isAccent = true;
                    }
                }
            }

            log(`[BEATGEN] Extracted ${melodicNotes.length} total melodic notes (${melodicNotes.filter(n => n.isAccent).length} transient accents).`);
        } catch (e) {
            log(`[BEATGEN] Error during Basic Pitch inference: ${e.message}`);
            console.error(e);
        }

        if (setProgressFill) setProgressFill(95);

        // 5. Merge Melodic and Percussive Notes (Single-pass O(N) merge + inline deduplication)
        finalMap = [];
        const mergeTolerance = (BeatEngineParams.chordToleranceMs ?? 30) / 1000.0;
        const duplicatePitchThresh = BeatEngineParams.duplicatePitchThreshold ?? 0.5;

        const pushDeduped = (currentNote) => {
            if (finalMap.length === 0) {
                finalMap.push(currentNote);
                return;
            }

            let isDuplicate = false;
            let duplicateIdx = -1;

            for (let j = finalMap.length - 1; j >= 0; j--) {
                const prev = finalMap[j];
                if (currentNote.time - prev.time >= mergeTolerance) {
                    break;
                }

                if (currentNote.isPercussion && prev.isPercussion) {
                    if (currentNote.isKick === prev.isKick) {
                        isDuplicate = true;
                        duplicateIdx = j;
                        break;
                    }
                } else if (!currentNote.isPercussion && !prev.isPercussion) {
                    const semitoneDiff = Math.abs(
                        (currentNote._comparePitch ?? (currentNote.midiPitch ?? currentNote.rawPitch)) -
                        (prev._comparePitch ?? (prev.midiPitch ?? prev.rawPitch))
                    );
                    if (semitoneDiff <= duplicatePitchThresh) {
                        isDuplicate = true;
                        duplicateIdx = j;
                        break;
                    }
                }
            }

            if (isDuplicate) {
                const dupNote = finalMap[duplicateIdx];
                if ((currentNote.isAccent && !dupNote.isAccent) || (currentNote.energy > dupNote.energy)) {
                    finalMap[duplicateIdx] = currentNote;
                }
            } else {
                finalMap.push(currentNote);
            }
        };

        let mIdx = 0, pIdx = 0;
        while (mIdx < melodicNotes.length && pIdx < percussiveNotes.length) {
            if (melodicNotes[mIdx].time <= percussiveNotes[pIdx].time) {
                pushDeduped(melodicNotes[mIdx++]);
            } else {
                pushDeduped(percussiveNotes[pIdx++]);
            }
        }
        while (mIdx < melodicNotes.length) pushDeduped(melodicNotes[mIdx++]);
        while (pIdx < percussiveNotes.length) pushDeduped(percussiveNotes[pIdx++]);

        // Apply fade-out squelch
        if (squelchTime < audioBuffer.duration) {
            const countBefore = finalMap.length;
            finalMap = finalMap.filter(n => n.time < squelchTime);
            log(`[BEATGEN] Squelched ${countBefore - finalMap.length} notes during fade-out.`);
        }

        log(`[BEATGEN] Merged timeline: ${finalMap.length} notes total.`);

        if (memCacheKey) {
            if (!window._beatgenFeatureCache) window._beatgenFeatureCache = {};
            window._beatgenFeatureCache[memCacheKey] = finalMap;
        }

        if (cacheId) {
            try {
                await window.gameAPI.saveRawNotes(cacheId, finalMap);
                log(`[BEATGEN] Saved raw notes cache for ${cacheId}.`);
            } catch (e) {
                log(`[BEATGEN] Error saving raw notes cache: ${e}`);
            }
        }
    }

    const globalBeatDuration = 60.0 / songTempo;
    const quantizeGrid = globalBeatDuration / (BeatEngineParams.rhythmQuantizeSubdivision || 8);

    // Assign playable, harmonically ordered lanes
    const assignedNotes = assignLanes(finalMap, songTempo, BeatEngineParams.cooldown, quantizeGrid, log, difficulty);

    const durationMs = performance.now() - startTime;
    log(`[BEATGEN] Offline audio processing finished in ${(durationMs / 1000).toFixed(3)}s.`);

    if (window.gameSettings && window.gameSettings.saveLogsEnabled) {
        window.gameAPI.saveBeatGenLog(`=== BeatGen Log ===\n\n` + generationLog.join('\n'));
    }

    if (setProgressFill) setProgressFill(100);
    return assignedNotes;
}

/**
 * Percussion extraction engine using Half-Wave Energy Derivative Rise + Adaptive Noise Floor + Zero Crossing Ratio (ZCR).
 * Maps Kicks (Lanes 0/1), Snares (Lanes 2/3), and Hi-Hats/Cymbals (Lane 4) deterministically.
 */
async function extractPercussionHits(kickData, snareData, sampleRate, songTempo, log, setProgressFill) {
    const hopSize = Math.floor(512 * (sampleRate / 44100));
    const numHops = Math.floor(kickData.length / hopSize);
    const percussiveNotes = [];

    let lastKickTime = 0;
    let lastSnareTime = 0;
    const cooldown = 60.0 / songTempo / 4; // 16th note cooldown (seconds)

    let prevRmsKick = 0;
    let prevRmsSnare = 0;

    let runningKickRms = 0.05;
    let runningSnareRms = 0.05;
    let runningZcr = 0.18;
    let runningZcrVar = 0.01;
    const alphaRunning = 0.05;

    let kickHitCount = 0;
    let snareHitCount = 0;

    const isSameBuffer = (kickData === snareData);
    let yieldCountdown = 5000;
    for (let hopIdx = 1; hopIdx < numHops - 1; hopIdx++) {
        const offset = hopIdx * hopSize;
        let sumSquareKick = 0;
        let sumSquareSnare = 0;
        let zcrSnareCount = 0;

        let prevSample = snareData[offset];
        if (isSameBuffer) {
            for (let i = 0; i < hopSize; i++) {
                const vs = snareData[offset + i];
                sumSquareSnare += vs * vs;
                if (i > 0 && ((vs >= 0) !== (prevSample >= 0))) {
                    zcrSnareCount++;
                }
                prevSample = vs;
            }
            sumSquareKick = sumSquareSnare;
        } else {
            for (let i = 0; i < hopSize; i++) {
                const vk = kickData[offset + i];
                sumSquareKick += vk * vk;

                const vs = snareData[offset + i];
                sumSquareSnare += vs * vs;

                if (i > 0 && ((vs >= 0) !== (prevSample >= 0))) {
                    zcrSnareCount++;
                }
                prevSample = vs;
            }
        }

        const rmsKick = Math.sqrt(sumSquareKick / hopSize);
        const rmsSnare = Math.sqrt(sumSquareSnare / hopSize);
        const zcrSnare = zcrSnareCount / hopSize;

        // Half-wave energy derivative rise
        const derivKick = Math.max(0, rmsKick - prevRmsKick);
        const derivSnare = Math.max(0, rmsSnare - prevRmsSnare);

        prevRmsKick = rmsKick;
        prevRmsSnare = rmsSnare;

        runningKickRms = (1 - alphaRunning) * runningKickRms + alphaRunning * rmsKick;
        runningSnareRms = (1 - alphaRunning) * runningSnareRms + alphaRunning * rmsSnare;
        const zcrDiff = zcrSnare - runningZcr;
        runningZcr += alphaRunning * zcrDiff;
        runningZcrVar = (1 - alphaRunning) * runningZcrVar + alphaRunning * (zcrDiff * zcrDiff);
        const zcrStd = Math.sqrt(runningZcrVar);
        const adaptiveZcrCutoff = Math.max(0.22, Math.min(0.38, runningZcr + 0.75 * zcrStd));

        const time = offset / sampleRate;

        // Kick Drum Onset Condition (with Ghost Roll Detection)
        const kickDerivThreshold = 0.015 + 0.12 * runningKickRms;
        const kickEnergyFloor = 0.04 + 0.20 * runningKickRms;

        if (derivKick > kickDerivThreshold && rmsKick > kickEnergyFloor) {
            const timeSinceKick = time - lastKickTime;
            let isKickRoll = false;
            if (timeSinceKick <= cooldown && timeSinceKick >= 0.055 && derivKick > kickDerivThreshold * 1.3) {
                isKickRoll = true;
            }
            if (timeSinceKick > cooldown || isKickRoll) {
                const kickPitch = (kickHitCount % 2 === 0) ? 0.05 : 0.25;
                kickHitCount++;

                percussiveNotes.push({
                    time: time,
                    pitch: kickPitch,
                    rawPitch: kickPitch,
                    _comparePitch: kickPitch,
                    isPercussion: true,
                    isKick: true,
                    isRoll: isKickRoll,
                    isGhost: isKickRoll,
                    energy: rmsKick,
                    length: 0,
                    duration: 0
                });
                lastKickTime = time;
            }
        }

        // Snare / Cymbal Onset Condition (with Adaptive ZCR and Ghost Roll Detection)
        const snareDerivThreshold = 0.012 + 0.10 * runningSnareRms;
        const snareEnergyFloor = 0.03 + 0.15 * runningSnareRms;

        if (derivSnare > snareDerivThreshold && rmsSnare > snareEnergyFloor) {
            const timeSinceSnare = time - lastSnareTime;
            let isRoll = false;
            if (timeSinceSnare <= cooldown && timeSinceSnare >= 0.050 && derivSnare > snareDerivThreshold * 1.3) {
                isRoll = true;
            }
            if (timeSinceSnare > cooldown || isRoll) {
                let snarePitch;
                let isCymbal = false;

                // Adaptive Zero Crossing Ratio (ZCR >= cutoff) indicates Cymbal crash / Hi-Hat
                if (zcrSnare >= adaptiveZcrCutoff) {
                    snarePitch = 0.95; // Maps to Lane 4 (rightmost)
                    isCymbal = true;
                } else {
                    // Snare body hit maps to Lane 2 / 3
                    snarePitch = (snareHitCount % 2 === 0) ? 0.75 : 0.55;
                }
                snareHitCount++;

                percussiveNotes.push({
                    time: time,
                    pitch: snarePitch,
                    rawPitch: snarePitch,
                    _comparePitch: snarePitch,
                    isPercussion: true,
                    isKick: false,
                    isCymbal: isCymbal,
                    isRoll: isRoll,
                    isGhost: isRoll,
                    energy: rmsSnare,
                    length: 0,
                    duration: 0
                });
                lastSnareTime = time;
            }
        }

        if (--yieldCountdown === 0) {
            if (setProgressFill) setProgressFill(15 + (hopIdx / numHops) * 35);
            await new Promise(r => setTimeout(r, 0));
            yieldCountdown = 5000;
        }
    }
    return percussiveNotes;
}

/**
 * Assigns valid notes to target game lanes.
 * Features: Dynamic Section Energy Profiling, Boundary-Reset EMA Pitch Smoothing,
 * Harmonically Ordered Chord Spacing, and Density/Collision Management.
 */
function assignLanes(validNotes, songTempo, baseCooldown, quantizeGrid, log, difficulty) {
    if (!log) log = console.log;
    const lanes = 5;
    const diff = difficulty || ((typeof sessionDifficulty !== 'undefined') ? sessionDifficulty : 'Medium');
    const targetLanes = diff === 'Easy' ? 4 : 5;
    const globalBeatDuration = 60.0 / songTempo;

    const isSoftMode = validNotes.length > 0 ? (validNotes[0].softInstrumentMode || false) : false;

    // 1. Dynamic Section Energy & Intensity Profiling (TypedArray zero-allocation sort)
    const lenNotes = validNotes.length;
    const sortedEnergies = new Float64Array(lenNotes);
    for (let i = 0; i < lenNotes; i++) {
        sortedEnergies[i] = validNotes[i].energy || 0.1;
    }
    sortedEnergies.sort();
    const p25Energy = sortedEnergies[Math.floor(lenNotes * 0.25)] || 0.05;
    const p75Energy = sortedEnergies[Math.floor(lenNotes * 0.75)] || 0.30;

    // 2. Dynamic Track Pitch Scaling for Melodic Notes
    const melodicNotes = [];
    for (let i = 0; i < lenNotes; i++) {
        const n = validNotes[i];
        if (!n.isPercussion && n.rawFrequency > 0) {
            melodicNotes.push(n);
        }
    }
    let dynLogMin = Math.log2(isSoftMode ? 27 : 40);
    let dynLogMax = Math.log2(isSoftMode ? 4200 : 8000);

    if (melodicNotes.length > 10) {
        const mLen = melodicNotes.length;
        const freqs = new Float64Array(mLen);
        for (let i = 0; i < mLen; i++) {
            freqs[i] = melodicNotes[i].rawFrequency;
        }
        freqs.sort();
        const p15Idx = Math.floor(mLen * 0.15);
        const p85Idx = Math.floor(mLen * 0.85);

        const trackMinFreq = freqs[p15Idx];
        const trackMaxFreq = freqs[p85Idx];
        const trackMedianFreq = freqs[Math.floor(mLen * 0.5)];

        log(`[BEATGEN] Dynamic Pitch Range: median=${trackMedianFreq.toFixed(1)}Hz, p15=${trackMinFreq.toFixed(1)}Hz, p85=${trackMaxFreq.toFixed(1)}Hz`);

        const minOctaveWidth = 4.0;
        let trackLogMin = Math.log2(trackMinFreq);
        let trackLogMax = Math.log2(trackMaxFreq);

        if (trackLogMax - trackLogMin < minOctaveWidth) {
            const center = Math.log2(trackMedianFreq);
            trackLogMin = center - (minOctaveWidth / 2);
            trackLogMax = center + (minOctaveWidth / 2);
        }

        dynLogMin = dynLogMin * 0.4 + trackLogMin * 0.6;
        dynLogMax = dynLogMax * 0.4 + trackLogMax * 0.6;

        for (const n of melodicNotes) {
            const logFreq = Math.log2(n.rawFrequency);
            n.pitch = Math.max(0, Math.min(1.0, (logFreq - dynLogMin) / (dynLogMax - dynLogMin)));
        }
    }

    const totalOctaves = dynLogMax - dynLogMin;

    // 3. Pitch EMA Smoothing (with Phrase-Boundary Reset)
    const EMA_ALPHA = 0.4;
    let emaPitch = -1;
    let lastMelodicTime = -1;

    for (let i = 0; i < validNotes.length; i++) {
        const n = validNotes[i];
        if (n.isPercussion) continue;

        const currentPitch = n.pitch;
        if (lastMelodicTime < 0 || (n.time - lastMelodicTime) > globalBeatDuration * 1.5) {
            emaPitch = currentPitch;
        } else {
            emaPitch = EMA_ALPHA * currentPitch + (1 - EMA_ALPHA) * emaPitch;
        }
        n._emaPitch = emaPitch;
        lastMelodicTime = n.time;
    }

    // 4. Phrase Segmentation
    const phrases = [];
    let currentPhrase = [];
    for (let i = 0; i < validNotes.length; i++) {
        currentPhrase.push(validNotes[i]);
        if (i === validNotes.length - 1 || (validNotes[i + 1].time - validNotes[i].time) > globalBeatDuration * 1.5) {
            phrases.push(currentPhrase);
            currentPhrase = [];
        }
    }

    const laneMap = [];
    const laneUsage = new Array(lanes).fill(0);
    const riffSignatures = {};

    function pitchToLane(note) {
        const effectivePitch = (!note.isPercussion && note._emaPitch !== undefined) ? note._emaPitch : note.pitch;
        if (!note.isPercussion && note.rawFrequency > 0 && targetLanes === 5 && (diff === 'Medium' || diff === 'Hard' || diff === 'Insane')) {
            if (note.rawFrequency < 180) {
                // Bass / Rhythm Tier -> Lanes 0 or 1
                const norm = Math.max(0, Math.min(1.0, (note.rawFrequency - 60) / 120));
                return Math.min(1, Math.floor(norm * 2));
            } else if (note.rawFrequency <= 520) {
                // Center Mids / Arpeggio Body Tier -> Lane 2
                return 2;
            } else {
                // Lead Solo / High Tier -> Lanes 3 or 4
                const norm = Math.max(0, Math.min(1.0, (note.rawFrequency - 520) / 600));
                return Math.min(4, Math.max(3, 3 + Math.floor(norm * 2)));
            }
        }
        return Math.min(targetLanes - 1, Math.max(0, Math.floor(effectivePitch * targetLanes)));
    }

    function balancedLane(preferred) {
        let total = 0;
        for (let c = 0; c < targetLanes; c++) total += laneUsage[c];
        const avgUsage = total / targetLanes;

        if (laneUsage[preferred] > avgUsage * 1.8) {
            let best = preferred;
            let bestUsage = laneUsage[preferred];
            const candidates = [preferred - 1, preferred + 1, preferred - 2, preferred + 2];

            for (const cand of candidates) {
                if (cand >= 0 && cand < targetLanes) {
                    if (laneUsage[cand] < bestUsage) {
                        bestUsage = laneUsage[cand];
                        best = cand;
                    }
                }
            }
            return best;
        }
        return preferred;
    }

    const pitchThreshold = BeatEngineParams.relativePitchThresholdSemitones || 2.5;
    const pitchThreshold15x = pitchThreshold * 1.5;

    for (const phrase of phrases) {
        // Section Intensity Modulation: Adjust phrase threshold based on Verse vs Chorus energy
        const phraseEnergy = phrase.reduce((sum, n) => sum + (n.energy || 0.1), 0) / phrase.length;
        let melodicCount = 0;
        let percCount = 0;
        let minPitch = 999, maxPitch = -999;
        for (const n of phrase) {
            if (n.isPercussion) percCount++;
            else {
                melodicCount++;
                if (n.pitch < minPitch) minPitch = n.pitch;
                if (n.pitch > maxPitch) maxPitch = n.pitch;
            }
        }
        const phraseDuration = phrase.length > 1 ? (phrase[phrase.length - 1].time - phrase[0].time) : 1.0;
        const melodicDensity = phraseDuration > 0 ? (melodicCount / phraseDuration) : 0;
        const pitchSpan = maxPitch - minPitch;

        let intensityMod = 1.0;
        let sectionType = "Verse";
        let sectionDensityMod = 1.0;
        if (melodicDensity >= 3.5 && percCount <= (phraseDuration * 0.5) && pitchSpan >= 0.20) {
            intensityMod = 0.85; // Allow fast melodic transitions
            sectionType = "Intricate Arpeggio";
            sectionDensityMod = 0.65; // 0.65x cooldown for fast fingerpicking/arpeggios!
        } else if (phraseEnergy < p25Energy) {
            intensityMod = 1.15; // Quiet Verse: keep melody clean
            sectionType = "Intro/Verse";
            sectionDensityMod = 1.20;
        } else if (phraseEnergy > p75Energy) {
            intensityMod = 0.88; // Chorus: allow full rhythm density
            sectionType = "Chorus/Solo";
            sectionDensityMod = 0.80;
        }

        // Phantom Rhythm Anchoring in drumless passages: promote bass root notes
        if (percCount === 0 && melodicCount > 0 && minPitch < 999) {
            for (const n of phrase) {
                if (!n.isPercussion && n.pitch <= minPitch + 0.15) {
                    n.isAccent = true; // Tag root note as rhythm anchor
                }
            }
        }

        const effectivePitchThresh = pitchThreshold * intensityMod;
        const effectivePitchThresh15x = pitchThreshold15x * intensityMod;

        if (phrase.length < 3) {
            let currentLane = balancedLane(pitchToLane(phrase[0]));
            let lastMelodicNote = phrase[0].isPercussion ? null : phrase[0];
            let lastLaneDir = 0;

            for (let i = 0; i < phrase.length; i++) {
                let l = currentLane;
                if (i > 0) {
                    if (phrase[i].isPercussion) {
                        l = balancedLane(pitchToLane(phrase[i]));
                        lastLaneDir = 0;
                    } else if (lastMelodicNote) {
                        const noteEma = phrase[i]._emaPitch !== undefined ? phrase[i]._emaPitch : phrase[i].pitch;
                        const lastEma = lastMelodicNote._emaPitch !== undefined ? lastMelodicNote._emaPitch : lastMelodicNote.pitch;
                        const semitoneDiff = (noteEma - lastEma) * totalOctaves * 12;
                        const thresh = lastLaneDir !== 0 ? effectivePitchThresh15x : effectivePitchThresh;

                        if (semitoneDiff >= thresh) {
                            l = balancedLane(Math.min(targetLanes - 1, currentLane + 1));
                            lastLaneDir = 1;
                        } else if (semitoneDiff <= -thresh) {
                            l = balancedLane(Math.max(0, currentLane - 1));
                            lastLaneDir = -1;
                        }
                    } else {
                        l = balancedLane(pitchToLane(phrase[i]));
                        lastLaneDir = 0;
                    }
                }
                if (!phrase[i].isPercussion) {
                    lastMelodicNote = phrase[i];
                }
                currentLane = l;
                laneUsage[l]++;
                laneMap.push({
                    time: phrase[i].time,
                    lane: l,
                    length: phrase[i].length || phrase[i].duration || 0,
                    duration: phrase[i].duration || 0,
                    isAccent: phrase[i].isAccent || false,
                    isRoll: phrase[i].isRoll || false,
                    isGhost: phrase[i].isGhost || false,
                    hasVibrato: phrase[i].hasVibrato || false,
                    sectionType: sectionType,
                    sectionDensityMod: sectionDensityMod,
                    origPitch: phrase[i].isPercussion ? undefined : (phrase[i].rawFrequency || phrase[i].midiPitch || phrase[i].pitch),
                    hit: false, missed: false
                });
            }
            continue;
        }

        // Zero-allocation 32-bit FNV-1a integer hash for motif recognition
        let motifHash = 0x811c9dc5;
        let sigLastMelodicIdx = -1;
        for (let i = 1; i < phrase.length; i++) {
            if (!phrase[i - 1].isPercussion) sigLastMelodicIdx = i - 1;
            const r1 = phrase[i].time - phrase[i - 1].time;
            const rRatio = Math.round(r1 / quantizeGrid);
            let pDirCode = 1; // 'S'
            if (!phrase[i].isPercussion && sigLastMelodicIdx >= 0) {
                const prevMelodic = phrase[sigLastMelodicIdx];
                const noteEma = phrase[i]._emaPitch !== undefined ? phrase[i]._emaPitch : phrase[i].pitch;
                const prevEma = prevMelodic._emaPitch !== undefined ? prevMelodic._emaPitch : prevMelodic.pitch;
                const semitoneDiff = (noteEma - prevEma) * totalOctaves * 12;
                if (semitoneDiff >= effectivePitchThresh) pDirCode = 2; // 'U'
                else if (semitoneDiff <= -effectivePitchThresh) pDirCode = 3; // 'D'
            }
            motifHash ^= rRatio;
            motifHash = Math.imul(motifHash, 0x01000193) >>> 0;
            motifHash ^= pDirCode;
            motifHash = Math.imul(motifHash, 0x01000193) >>> 0;
        }
        const key = motifHash;

        let laneAssignments = [];

        if (riffSignatures[key]) {
            const phraseSeedLane = balancedLane(pitchToLane(phrase[0]));
            const relativeOffsets = riffSignatures[key];
            for (let i = 0; i < phrase.length; i++) {
                const rel = relativeOffsets[i] !== undefined ? relativeOffsets[i] : 0;
                laneAssignments.push(Math.min(targetLanes - 1, Math.max(0, phraseSeedLane + rel)));
            }
        } else {
            let currentLane = pitchToLane(phrase[0]);
            let phraseLaneDir = 0;
            let lastMelodicIndex = -1;
            const relativeOffsets = [];

            for (let i = 0; i < phrase.length; i++) {
                let l;
                if (i > 0) {
                    if (phrase[i].isPercussion) {
                        l = pitchToLane(phrase[i]);
                        phraseLaneDir = 0;
                    } else {
                        const prevMelodic = lastMelodicIndex >= 0 ? phrase[lastMelodicIndex] : null;
                        const prevMelodicIndex = lastMelodicIndex;

                        if (prevMelodic) {
                            const noteEma = phrase[i]._emaPitch !== undefined ? phrase[i]._emaPitch : phrase[i].pitch;
                            const prevEma = prevMelodic._emaPitch !== undefined ? prevMelodic._emaPitch : prevMelodic.pitch;
                            const semitoneDiff = (noteEma - prevEma) * totalOctaves * 12;
                            const thresh = phraseLaneDir !== 0 ? effectivePitchThresh15x : effectivePitchThresh;

                            if (semitoneDiff >= thresh) {
                                const baseLane = laneAssignments[prevMelodicIndex] !== undefined ? laneAssignments[prevMelodicIndex] : currentLane;
                                l = Math.min(targetLanes - 1, baseLane + 1);
                                phraseLaneDir = 1;
                            } else if (semitoneDiff <= -thresh) {
                                const baseLane = laneAssignments[prevMelodicIndex] !== undefined ? laneAssignments[prevMelodicIndex] : currentLane;
                                l = Math.max(0, baseLane - 1);
                                phraseLaneDir = -1;
                            } else if (phrase[i].time - phrase[i - 1].time < globalBeatDuration * 0.3) {
                                l = (currentLane + 1) % targetLanes;
                            } else {
                                l = currentLane;
                                phraseLaneDir = 0;
                            }
                        } else {
                            l = pitchToLane(phrase[i]);
                            phraseLaneDir = 0;
                        }
                    }
                } else {
                    l = currentLane;
                }
                if (!phrase[i].isPercussion) lastMelodicIndex = i;
                laneAssignments.push(l);
                relativeOffsets.push(l - laneAssignments[0]);
                currentLane = l;
            }
            riffSignatures[key] = relativeOffsets;
        }

        for (let i = 0; i < phrase.length; i++) {
            let targetLane = laneAssignments[i] !== undefined
                ? laneAssignments[i]
                : balancedLane(pitchToLane(phrase[i]));

            if (targetLane >= targetLanes) targetLane = targetLanes - 1;
            const balancedTarget = balancedLane(targetLane);
            laneUsage[balancedTarget]++;
            laneMap.push({
                time: phrase[i].time,
                lane: balancedTarget,
                length: phrase[i].length || phrase[i].duration || 0,
                duration: phrase[i].duration || 0,
                isAccent: phrase[i].isAccent || false,
                isRoll: phrase[i].isRoll || false,
                isGhost: phrase[i].isGhost || false,
                hasVibrato: phrase[i].hasVibrato || false,
                sectionType: sectionType,
                sectionDensityMod: sectionDensityMod,
                origPitch: phrase[i].isPercussion ? undefined : (phrase[i].rawFrequency || phrase[i].midiPitch || phrase[i].pitch),
                hit: false, missed: false
            });
        }
    }

    laneMap.sort((a, b) => a.time - b.time);

    // 5. Harmonically Ordered & Ergonomic Chord Spacing (Sort simultaneous chord notes by pitch left-to-right)
    const chordTolerance = (BeatEngineParams.chordToleranceMs ?? 30) / 1000.0;
    let chordIdx = 0;
    let lastChordCenter = 2.0;
    while (chordIdx < laneMap.length) {
        let endChordIdx = chordIdx + 1;
        while (endChordIdx < laneMap.length && (laneMap[endChordIdx].time - laneMap[chordIdx].time) < chordTolerance) {
            endChordIdx++;
        }
        const chordSize = endChordIdx - chordIdx;
        if (chordSize > 1) {
            const chordGroup = laneMap.slice(chordIdx, endChordIdx);
            const notePitches = chordGroup.map((lmNote) => {
                if (lmNote.origPitch !== undefined) {
                    return lmNote.origPitch;
                }
                return lmNote.lane;
            });

            // Sort indices by pitch (lowest pitch first)
            const sortedIndicesByPitch = chordGroup.map((_, idx) => idx).sort((a, b) => notePitches[a] - notePitches[b]);
            // Sort assigned lanes ascending
            let sortedLanes = chordGroup.map(lmNote => lmNote.lane).sort((a, b) => a - b);

            // Ergonomic Hand-Alternation Bias on Hard/Insane
            if (diff === 'Hard' || diff === 'Insane') {
                const avgLane = sortedLanes.reduce((a, b) => a + b, 0) / chordSize;
                if (lastChordCenter >= 2.5 && avgLane >= 2.2 && sortedLanes[0] > 0) {
                    sortedLanes = sortedLanes.map(l => Math.max(0, l - 1));
                } else if (lastChordCenter <= 1.5 && avgLane <= 1.8 && sortedLanes[chordSize - 1] < targetLanes - 1) {
                    sortedLanes = sortedLanes.map(l => Math.min(targetLanes - 1, l + 1));
                }
                lastChordCenter = sortedLanes.reduce((a, b) => a + b, 0) / chordSize;
            }

            // Reassign sorted lanes to pitch-ordered notes
            for (let k = 0; k < chordSize; k++) {
                const targetNoteIdx = sortedIndicesByPitch[k];
                laneMap[chordIdx + targetNoteIdx].lane = sortedLanes[k];
            }
        }
        chordIdx = endChordIdx;
    }

    // 6. Per-Lane & Global Density / Chord Collision Logic
    let diffCooldownMod = 1.0;
    if (diff === 'Easy') diffCooldownMod = 1.5;
    if (diff === 'Hard') diffCooldownMod = 0.7;
    if (diff === 'Insane') diffCooldownMod = 0.5;
    const minNoteDist = baseCooldown * diffCooldownMod;

    const globalMinNoteDist = diff === 'Easy' ? 0.220 : (diff === 'Medium' ? 0.130 : (diff === 'Hard' ? 0.070 : 0.040));

    const maxChordSize = diff === 'Easy' ? (BeatEngineParams.maxChordSizeEasy ?? 1)
                       : (diff === 'Medium' ? (BeatEngineParams.maxChordSizeMedium ?? 2)
                       : (diff === 'Hard' ? (BeatEngineParams.maxChordSizeHard ?? 3)
                       : (BeatEngineParams.maxChordSizeInsane ?? 4)));

    const finalLaneMap = [];
    const lastNoteInLane = new Array(lanes).fill(null);
    let lastChordTime = -999;
    let currentChordNotes = [];

    for (let i = 0; i < laneMap.length; i++) {
        const src = laneMap[i];
        let note = {
            time: src.time,
            lane: src.lane,
            length: src.length || 0,
            duration: src.duration || 0,
            isAccent: src.isAccent || false,
            isRoll: src.isRoll || false,
            isGhost: src.isGhost || false,
            hasVibrato: src.hasVibrato || false,
            sectionType: src.sectionType || "Verse",
            hit: false,
            missed: false
        };

        if (currentChordNotes.length > 0 && note.time - currentChordNotes[0].time >= chordTolerance) {
            currentChordNotes = [];
        }

        let prevSameLane = lastNoteInLane[note.lane];
        if (prevSameLane) {
            let gap = note.time - prevSameLane.time;
            let effectiveMinDist = minNoteDist * (src.sectionDensityMod || 1.0);
            if (src.sectionType === "Intricate Arpeggio") {
                effectiveMinDist = Math.min(effectiveMinDist, 0.040); // 40ms universal zero-drop protection
            }
            if (src.isRoll || src.isGhost) {
                if (diff === 'Hard' || diff === 'Insane') effectiveMinDist *= 0.45;
            }
            if (gap < effectiveMinDist) {
                // Intelligent Lane Nudging (nudgeLane fallback)
                let nudged = false;
                const cands = [note.lane - 1, note.lane + 1, note.lane - 2, note.lane + 2];
                for (const cand of cands) {
                    if (cand >= 0 && cand < targetLanes) {
                        const prevCand = lastNoteInLane[cand];
                        const candGap = prevCand ? (note.time - prevCand.time) : 999;
                        if (candGap >= effectiveMinDist) {
                            if (currentChordNotes.length > 0 && currentChordNotes.some(n => n.lane === cand)) {
                                continue;
                            }
                            note.lane = cand;
                            nudged = true;
                            break;
                        }
                    }
                }
                if (!nudged) {
                    continue; // Only drop if all nearby lanes are also blocked!
                }
            }
        }

        const isChordNote = currentChordNotes.length > 0;
        if (isChordNote) {
            let effectiveMaxChord = maxChordSize;
            if (src.sectionType === "Chorus/Solo" && (diff === 'Hard' || diff === 'Insane')) {
                effectiveMaxChord = Math.min(targetLanes, maxChordSize + 1);
            } else if (src.sectionType === "Intro/Verse") {
                effectiveMaxChord = Math.max(1, maxChordSize - 1);
            } else if (src.sectionType === "Intricate Arpeggio" && (diff === 'Hard' || diff === 'Insane')) {
                effectiveMaxChord = Math.max(2, maxChordSize);
            }
            if (currentChordNotes.length + 1 > effectiveMaxChord) {
                continue;
            }
            const sameLaneChord = currentChordNotes.some(n => n.lane === note.lane);
            if (sameLaneChord) {
                continue;
            }
        } else {
            if (lastChordTime >= 0) {
                let globalGap = note.time - lastChordTime;
                let effectiveGlobalDist = globalMinNoteDist * (src.sectionDensityMod || 1.0);
                if (src.sectionType === "Intricate Arpeggio") {
                    effectiveGlobalDist = Math.min(effectiveGlobalDist, 0.040); // 40ms universal zero-drop protection
                }
                if (src.isRoll || src.isGhost) {
                    if (diff === 'Hard' || diff === 'Insane') effectiveGlobalDist *= 0.45;
                }
                if (globalGap < effectiveGlobalDist) {
                    continue;
                }
            }
        }

        finalLaneMap.push(note);
        lastNoteInLane[note.lane] = note;

        if (!isChordNote) {
            lastChordTime = note.time;
        }
        currentChordNotes.push(note);
    }

    log(`[BEATGEN v2.4] Lane assignment finished: ${finalLaneMap.length} playable notes.`);
    return finalLaneMap;
}

// Expose API
window.BeatGen = {
    loadBeatEngineParams,
    processAudioOffline,
    assignLanes
};
