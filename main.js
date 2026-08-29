const electron = require('electron');
const app = electron.app;
const BrowserWindow = electron.BrowserWindow;
const ipcMain = electron.ipcMain;
const path = require('node:path');
const fs = require('node:fs');
const https = require('node:https');
const { execFile, spawn } = require('node:child_process');
const getBinaryPath = (pkgPath, binaryName) => {
    if (app.isPackaged) {
        // In production, binaries are unpacked to resources/app.asar.unpacked/node_modules/...
        return path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', pkgPath, binaryName);
    }
    return path.join(__dirname, 'node_modules', pkgPath, binaryName);
};

const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
const ffmpegPath = app.isPackaged
    ? ffmpegInstaller.path.replace('app.asar', 'app.asar.unpacked')
    : ffmpegInstaller.path;

const getAppPath = () => {
    if (app.isPackaged) {
        if (process.env.APPIMAGE) {
            // Running from an AppImage: save next to the AppImage file
            return path.dirname(process.env.APPIMAGE);
        }
        // General packaged app: save next to the executable
        return path.dirname(process.execPath);
    }
    // Development mode
    return __dirname;
};

const baseDir = getAppPath();
const dataDir = path.join(baseDir, 'data');
const audioDir = path.join(dataDir, 'audio');
const cacheIndexPath = path.join(dataDir, 'cache_index.json');
const userStatsPath = path.join(dataDir, 'user_stats.json');
const settingsPath = path.join(dataDir, 'settings.json');
const logDir = path.join(baseDir, 'logs');

// Load settings on startup to apply configuration before ready
let startupSettings = {};
if (fs.existsSync(settingsPath)) {
    try {
        startupSettings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    } catch (e) {
        console.error('[MAIN] Failed to parse settings.json:', e);
    }
}

if (startupSettings.useHardwareAccel === false) {
    console.log('[MAIN] Disabling hardware acceleration as per settings.');
    app.disableHardwareAcceleration();
}

// Active process cancellation system
let activeProcesses = [];
function registerProcess(p) {
    activeProcesses.push(p);
    const cleanup = () => {
        activeProcesses = activeProcesses.filter(proc => proc !== p);
    };
    p.on('close', cleanup);
    p.on('exit', cleanup);
    p.on('error', cleanup);
}

// Copy yt-dlp to a writeable local directory (e.g. data/bin) so it can self-update
const localBinDir = path.join(dataDir, 'bin');
const ytDlpPath = path.join(localBinDir, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');

if (!fs.existsSync(localBinDir)) {
    fs.mkdirSync(localBinDir, { recursive: true });
}
if (!fs.existsSync(ytDlpPath)) {
    try {
        const bundledPath = getBinaryPath('youtube-dl-exec/bin', process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
        const sourcePath = fs.existsSync(bundledPath) ? bundledPath : getBinaryPath('youtube-dl-exec/bin', 'yt-dlp');
        if (fs.existsSync(sourcePath)) {
            fs.copyFileSync(sourcePath, ytDlpPath);
            if (process.platform !== 'win32') {
                fs.chmodSync(ytDlpPath, 0o755);
            }
            console.log(`[MAIN] Copied yt-dlp to local bin: ${ytDlpPath}`);
        } else {
            console.error(`[MAIN] Bundled yt-dlp not found at: ${sourcePath}`);
        }
    } catch (e) {
        console.error(`[MAIN] Failed to copy yt-dlp:`, e);
    }
}

const getResourcePath = (...relativePath) => {
    if (app.isPackaged) {
        return path.join(process.resourcesPath, ...relativePath);
    }
    return path.join(__dirname, ...relativePath);
};

const findPythonInVenv = (venvPath) => {
    if (process.platform === 'win32') {
        const paths = [
            path.join(venvPath, 'python.exe'),
            path.join(venvPath, 'Scripts', 'python.exe')
        ];
        for (const p of paths) {
            if (fs.existsSync(p)) return p;
        }
        return null;
    } else {
        const p = path.join(venvPath, 'bin', 'python');
        return fs.existsSync(p) ? p : null;
    }
};

// Ensure all required directories exist
const requiredDirs = [dataDir, audioDir, localBinDir, logDir];
requiredDirs.forEach(dir => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        console.log(`[MAIN] Created directory: ${dir}`);
    }
});

// Ensure required JSON files exist
if (!fs.existsSync(cacheIndexPath)) {
    fs.writeFileSync(cacheIndexPath, JSON.stringify([], null, 2));
    console.log(`[MAIN] Created cache index: ${cacheIndexPath}`);
}

if (!fs.existsSync(userStatsPath)) {
    const defaultStats = { playHistory: [], playCounts: {}, favorites: [], highScores: {} };
    fs.writeFileSync(userStatsPath, JSON.stringify(defaultStats, null, 2));
    console.log(`[MAIN] Created user stats: ${userStatsPath}`);
}

// Copy engine_params.json to local data directory if not present
const localEngineParamsPath = path.join(dataDir, 'engine_params.json');
if (!fs.existsSync(localEngineParamsPath)) {
    try {
        const bundledParamsPath = getResourcePath('engine_params.json');
        if (fs.existsSync(bundledParamsPath)) {
            fs.copyFileSync(bundledParamsPath, localEngineParamsPath);
            console.log(`[MAIN] Copied engine_params.json to local data: ${localEngineParamsPath}`);
        } else {
            // Fallback default parameters if bundled file is missing
            const defaultParams = {
                highpassFilterHz: 20,
                lowpassFilterHz: 16000,
                derivativeMultiplier: 5.0,
                logarithmicBias: 1.5,
                hopSize: 512,
                energyHistorySize: 43,
                cooldown: 0.100,
                varianceMultiplierBase: 1.9,
                varianceMultiplierFloor: 1.0,
                thresholdFloor: 0.05,
                peakScanLookahead: 8,
                decayScanLookaheadMs: 0.08374294155929288,
                decayToleranceRatio: 0.6610965295847911,
                zcrPitchWindowMs: 0.03,
                rhythmQuantizeSubdivision: 8,
                ghostNoteGridToleranceMs: 0.09,
                onsetRiseRatio: 1.03,
                swingGrooveTolerancePct: 0.12,
                globalEnergyGateSigmas: -1.2,
                delayEchoEnergyRatio: 0.80,
                delayEchoPitchTolerance: 0.08,
                delayMinOccurrences: 5,
                chorusMaxGapMs: 0.050,
                chorusPitchTolerance: 0.06
            };
            fs.writeFileSync(localEngineParamsPath, JSON.stringify(defaultParams, null, 4));
            console.log(`[MAIN] Created default engine_params.json at: ${localEngineParamsPath}`);
        }
    } catch (e) {
        console.error(`[MAIN] Failed to initialize local engine_params.json:`, e);
    }
}


function createWindow() {
    const mainWindow = new BrowserWindow({
        width: 1280,
        height: 720,
        useContentSize: true, // This locks the inner content to the dimensions
        resizable: true, // we might want to let them resize, but maintain aspect ratio using aspect ratio
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            nodeIntegration: false, // Security best practice
            contextIsolation: true, // Security best practice
            autoplayPolicy: 'no-user-gesture-required' // Allow youtube video to play automatically
        }
    });

    // Set 16:9 Aspect Ratio
    mainWindow.setAspectRatio(16 / 9);

    // Remove default menu for cleaner look
    mainWindow.setMenuBarVisibility(false);

    mainWindow.loadFile('src/index.html');
}

app.whenReady().then(() => {
    // IPC for loading map data
    ipcMain.handle('load-map-data', async (event, videoId, difficulty) => {
        // Try difficulty-specific file first
        const diffPath = path.join(dataDir, `${videoId}_${difficulty}.json`);
        if (fs.existsSync(diffPath)) {
            const data = fs.readFileSync(diffPath, 'utf-8');
            return JSON.parse(data);
        }

        // Fallback to legacy file — but only if the stored difficulty matches
        const legacyPath = path.join(dataDir, `${videoId}.json`);
        if (fs.existsSync(legacyPath)) {
            const data = fs.readFileSync(legacyPath, 'utf-8');
            const parsed = JSON.parse(data);
            // Legacy files without a difficulty field are assumed Medium
            const storedDiff = Array.isArray(parsed) ? 'Medium' : (parsed.difficulty || 'Medium');
            if (storedDiff === difficulty) {
                return parsed;
            }
        }

        return null;
    });

    ipcMain.handle('load-user-stats', async () => {
        if (fs.existsSync(userStatsPath)) {
            try {
                const data = fs.readFileSync(userStatsPath, 'utf-8');
                return JSON.parse(data);
            } catch (e) {
                console.error("Error parsing user_stats.json:", e);
            }
        }
        return { playHistory: [], playCounts: {}, favorites: [], highScores: {} };
    });

    ipcMain.handle('save-user-stats', async (event, data) => {
        try {
            fs.writeFileSync(userStatsPath, JSON.stringify(data, null, 2));
            return true;
        } catch (e) {
            console.error("Error saving user_stats.json:", e);
            return false;
        }
    });

    ipcMain.handle('save-settings', async (event, settings) => {
        try {
            fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
            return true;
        } catch (e) {
            console.error("Error saving settings.json:", e);
            return false;
        }
    });

    // IPC for saving map data
    ipcMain.handle('save-map-data', async (event, videoId, mapData) => {
        const diff = mapData.difficulty || 'Medium';
        const filePath = path.join(dataDir, `${videoId}_${diff}.json`);
        fs.writeFileSync(filePath, JSON.stringify(mapData, null, 2));
        return true;
    });

    ipcMain.handle('save-raw-notes', async (event, videoId, rawNotes) => {
        const filePath = path.join(dataDir, `${videoId}_raw.json`);
        fs.writeFileSync(filePath, JSON.stringify(rawNotes, null, 2));
        return true;
    });

    ipcMain.handle('load-raw-notes', async (event, videoId) => {
        const filePath = path.join(dataDir, `${videoId}_raw.json`);
        if (fs.existsSync(filePath)) {
            try {
                const data = fs.readFileSync(filePath, 'utf-8');
                return JSON.parse(data);
            } catch (e) {
                console.error("[MAIN] Error loading raw notes", e);
            }
        }
        return null;
    });

    // Helper: read duration from a WAV file header without external tools
    function getWavDuration(wavPath) {
        try {
            if (!fs.existsSync(wavPath)) return null;
            const fd = fs.openSync(wavPath, 'r');
            const header = Buffer.alloc(256);
            fs.readSync(fd, header, 0, 256, 0);

            // Validate RIFF/WAVE header
            const riff = header.toString('ascii', 0, 4);
            const wave = header.toString('ascii', 8, 12);
            if (riff !== 'RIFF' || wave !== 'WAVE') {
                fs.closeSync(fd);
                return null;
            }

            // Parse fmt chunk basics (always at offset 12)
            const numChannels = header.readUInt16LE(22);
            const sampleRate = header.readUInt32LE(24);
            const bitsPerSample = header.readUInt16LE(34);

            // Walk chunks to find the 'data' chunk (it may not be right after fmt)
            let offset = 12;
            let dataSize = 0;
            while (offset + 8 <= 256) {
                const chunkId = header.toString('ascii', offset, offset + 4);
                const chunkSize = header.readUInt32LE(offset + 4);
                if (chunkId === 'data') {
                    dataSize = chunkSize;
                    break;
                }
                offset += 8 + chunkSize;
            }

            // If the data chunk wasn't within the first 256 bytes, read further
            if (dataSize === 0) {
                const stat = fs.statSync(wavPath);
                const bigger = Buffer.alloc(Math.min(stat.size, 4096));
                fs.readSync(fd, bigger, 0, bigger.length, 0);
                let off = 12;
                while (off + 8 <= bigger.length) {
                    const cId = bigger.toString('ascii', off, off + 4);
                    const cSize = bigger.readUInt32LE(off + 4);
                    if (cId === 'data') {
                        dataSize = cSize;
                        break;
                    }
                    off += 8 + cSize;
                }
            }

            fs.closeSync(fd);

            if (dataSize === 0 || sampleRate === 0 || numChannels === 0 || bitsPerSample === 0) return null;

            const bytesPerSample = bitsPerSample / 8;
            const totalSamples = dataSize / (numChannels * bytesPerSample);
            const durationSec = totalSamples / sampleRate;

            const mins = Math.floor(durationSec / 60);
            const secs = Math.floor(durationSec % 60);
            return `${mins}:${secs.toString().padStart(2, '0')}`;
        } catch (e) {
            console.error(`[MAIN] Error reading WAV duration: ${e.message}`);
            return null;
        }
    }

    const activeTempoAnalyzers = new Set();

    async function getOrAnalyzeSongTempo(songId, sender) {
        if (activeTempoAnalyzers.has(songId)) return null;
        activeTempoAnalyzers.add(songId);

        try {
            const allFiles = fs.readdirSync(dataDir);
            const variants = allFiles.filter(f => f.startsWith(`${songId}_`) && f.endsWith('.json'));
            const legacyPath = path.join(dataDir, `${songId}.json`);

            let existingTempo = null;
            const filesToUpdate = [];

            // Check variants
            for (const file of variants) {
                const filePath = path.join(dataDir, file);
                try {
                    const content = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
                    if (content.tempo) {
                        existingTempo = content.tempo;
                    } else {
                        filesToUpdate.push({ path: filePath, content });
                    }
                } catch (e) {}
            }

            // Check legacy
            if (fs.existsSync(legacyPath)) {
                try {
                    const content = JSON.parse(fs.readFileSync(legacyPath, 'utf-8'));
                    if (content.tempo) {
                        existingTempo = content.tempo;
                    } else {
                        filesToUpdate.push({ path: legacyPath, content });
                    }
                } catch (e) {}
            }

            // If tempo exists, backfill it to files missing it and return
            if (existingTempo) {
                for (const item of filesToUpdate) {
                    try {
                        item.content.tempo = existingTempo;
                        fs.writeFileSync(item.path, JSON.stringify(item.content, null, 2));
                        console.log(`[MAIN] Backfilled existing tempo (${existingTempo} BPM) to ${path.basename(item.path)}`);
                    } catch (e) {
                        console.error(`[MAIN] Failed to backfill tempo to ${item.path}:`, e);
                    }
                }
                activeTempoAnalyzers.delete(songId);
                return existingTempo;
            }

            // If no tempo exists, analyze via python structure analyzer
            console.log(`[MAIN] No tempo found for song ${songId}. Running python analyzer...`);
            const audioPath = path.join(audioDir, `${songId}.wav`);
            if (!fs.existsSync(audioPath)) {
                console.warn(`[MAIN] Audio file not found for ${songId}, cannot analyze tempo.`);
                activeTempoAnalyzers.delete(songId);
                return null;
            }

            return new Promise((resolve) => {
                const isWin = process.platform === 'win32';
                let pythonBin = '';
                let useSystemFallback = false;

                const devVenvPath = getResourcePath('venv');
                const localDir = path.dirname(process.env.APPIMAGE || process.execPath);
                const localVenvPath = path.join(localDir, 'venv');

                const devVenvBin = findPythonInVenv(devVenvPath);
                const localVenvBin = findPythonInVenv(localVenvPath);

                if (devVenvBin) {
                    pythonBin = devVenvBin;
                } else if (localVenvBin) {
                    pythonBin = localVenvBin;
                } else {
                    pythonBin = isWin ? 'python.exe' : 'python3';
                    useSystemFallback = true;
                }

                const analyzeScript = getResourcePath('ai_trainer', 'analyze_structure.py');

                if (!useSystemFallback && !fs.existsSync(pythonBin)) {
                    console.error("Python VENV not found, cannot analyze tempo.");
                    activeTempoAnalyzers.delete(songId);
                    return resolve(null);
                }

                const pythonProcess = spawn(pythonBin, [analyzeScript, audioPath]);
                registerProcess(pythonProcess);
                let output = "";

                pythonProcess.stdout.on('data', (data) => {
                    output += data.toString();
                });

                pythonProcess.on('close', (code) => {
                    activeTempoAnalyzers.delete(songId);
                    try {
                        const result = JSON.parse(output.trim());
                        if (result.error) {
                            console.error("Python structure analysis error during tempo check:", result.error);
                            return resolve(null);
                        }
                        const analyzedTempo = result.tempo || 120;
                        console.log(`[MAIN] Successfully analyzed tempo for ${songId}: ${analyzedTempo} BPM`);

                        // Update all files that were missing it
                        const allJSONs = [...variants.map(f => path.join(dataDir, f))];
                        if (fs.existsSync(legacyPath)) allJSONs.push(legacyPath);

                        for (const filePath of allJSONs) {
                            try {
                                const content = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
                                content.tempo = analyzedTempo;
                                fs.writeFileSync(filePath, JSON.stringify(content, null, 2));
                                console.log(`[MAIN] Saved analyzed tempo (${analyzedTempo} BPM) in ${path.basename(filePath)}`);
                            } catch (e) {
                                console.error(`[MAIN] Error updating tempo in ${filePath}:`, e);
                            }
                        }

                        if (sender && !sender.isDestroyed()) {
                            sender.send('cached-songs-updated');
                        }
                        resolve(analyzedTempo);
                    } catch (e) {
                        console.error("Error parsing python structure output during tempo check:", e, output);
                        resolve(null);
                    }
                });

                pythonProcess.on('error', (err) => {
                    activeTempoAnalyzers.delete(songId);
                    console.error("Failed to start python structure analyzer for tempo check", err);
                    resolve(null);
                });
            });
        } catch (err) {
            activeTempoAnalyzers.delete(songId);
            console.error("Failed to run getOrAnalyzeSongTempo:", err);
            return null;
        }
    }

    // IPC for cache_index
    ipcMain.handle('get-cached-songs', async (event) => {
        if (fs.existsSync(cacheIndexPath)) {
            const data = fs.readFileSync(cacheIndexPath, 'utf-8');
            const songs = JSON.parse(data);

            const allFiles = fs.readdirSync(dataDir);

            // Enrich each song with its cached difficulty, duration, and tempo
            return songs.map(song => {
                const difficulties = [];
                let songTempo = null;

                // Check for separate difficulty files
                const variants = allFiles.filter(f => f.startsWith(`${song.id}_`) && f.endsWith('.json'));
                variants.forEach(v => {
                    const diffMatch = v.match(new RegExp(`${song.id}_(Easy|Medium|Hard|Insane)\\.json`));
                    if (diffMatch) {
                        difficulties.push(diffMatch[1]);
                        if (!songTempo) {
                            try {
                                const mapRaw = fs.readFileSync(path.join(dataDir, v), 'utf-8');
                                const mapData = JSON.parse(mapRaw);
                                if (mapData.tempo) {
                                    songTempo = mapData.tempo;
                                }
                            } catch (e) {}
                        }
                    }
                });

                // Fallback to legacy file
                const legacyPath = path.join(dataDir, `${song.id}.json`);
                if (fs.existsSync(legacyPath)) {
                    if (difficulties.length === 0) {
                        try {
                            const mapRaw = fs.readFileSync(legacyPath, 'utf-8');
                            const mapData = JSON.parse(mapRaw);
                            if (mapData.difficulty) difficulties.push(mapData.difficulty);
                            else difficulties.push('Medium'); // assume legacy is medium
                            if (mapData.tempo) songTempo = mapData.tempo;
                        } catch (e) { /* ignore read errors */ }
                    } else if (!songTempo) {
                        try {
                            const mapRaw = fs.readFileSync(legacyPath, 'utf-8');
                            const mapData = JSON.parse(mapRaw);
                            if (mapData.tempo) songTempo = mapData.tempo;
                        } catch (e) {}
                    }
                }

                // If no tempo is found, trigger background analysis asynchronously
                if (!songTempo) {
                    getOrAnalyzeSongTempo(song.id, event.sender);
                }

                // Read duration from the cached WAV file
                const wavPath = path.join(audioDir, `${song.id}.wav`);
                const duration = getWavDuration(wavPath);

                return { ...song, cachedDifficulties: difficulties, duration, tempo: songTempo };
            });
        }
        return [];
    });

    ipcMain.handle('save-cached-song', async (event, songData) => {
        let cache = [];
        if (fs.existsSync(cacheIndexPath)) {
            cache = JSON.parse(fs.readFileSync(cacheIndexPath, 'utf-8'));
        }
        // Check if already in cache
        const index = cache.findIndex(s => s.id === songData.id);
        if (index === -1) {
            cache.push(songData);
        } else {
            cache[index] = { ...cache[index], ...songData };
        }
        fs.writeFileSync(cacheIndexPath, JSON.stringify(cache, null, 2));
        return true;
    });

    ipcMain.handle('delete-cached-song', async (event, videoId) => {
        // Remove from cache json
        if (fs.existsSync(cacheIndexPath)) {
            let cache = JSON.parse(fs.readFileSync(cacheIndexPath, 'utf-8'));
            cache = cache.filter(s => s.id !== videoId);
            fs.writeFileSync(cacheIndexPath, JSON.stringify(cache, null, 2));
        }

        // Delete all map variants (Easy, Medium, Hard)
        const allDataFiles = fs.readdirSync(dataDir);
        allDataFiles.filter(f => (f.startsWith(`${videoId}_`) || f === `${videoId}.json`) && f.endsWith('.json')).forEach(f => {
            const mapPath = path.join(dataDir, f);
            if (fs.existsSync(mapPath)) fs.unlinkSync(mapPath);
        });

        // Delete audio wav
        const wavPath = path.join(audioDir, `${videoId}.wav`);
        if (fs.existsSync(wavPath)) fs.unlinkSync(wavPath);

        return true;
    });

    ipcMain.handle('delete-cached-song-difficulty', async (event, videoId, difficulty) => {
        // Delete the difficulty-specific JSON file
        const diffPath = path.join(dataDir, `${videoId}_${difficulty}.json`);
        if (fs.existsSync(diffPath)) {
            fs.unlinkSync(diffPath);
        }

        // Also handle legacy or default if difficulty is Medium
        if (difficulty === 'Medium') {
            const legacyPath = path.join(dataDir, `${videoId}.json`);
            if (fs.existsSync(legacyPath)) {
                try {
                    const data = fs.readFileSync(legacyPath, 'utf-8');
                    const parsed = JSON.parse(data);
                    const storedDiff = Array.isArray(parsed) ? 'Medium' : (parsed.difficulty || 'Medium');
                    if (storedDiff === 'Medium') {
                        fs.unlinkSync(legacyPath);
                    }
                } catch (e) {
                    fs.unlinkSync(legacyPath);
                }
            }
        }

        // Check if there are ANY other difficulty maps remaining for this song
        const allFiles = fs.readdirSync(dataDir);
        const remainingVariants = allFiles.filter(f => {
            if (f === `${videoId}.json`) {
                try {
                    const data = fs.readFileSync(path.join(dataDir, f), 'utf-8');
                    const parsed = JSON.parse(data);
                    const storedDiff = Array.isArray(parsed) ? 'Medium' : (parsed.difficulty || 'Medium');
                    return storedDiff !== difficulty;
                } catch (e) {
                    return false;
                }
            }
            const match = f.match(new RegExp(`^${videoId}_(Easy|Medium|Hard|Insane)\\.json$`));
            return !!match;
        });

        // If no other difficulty json remains, delete the audio and stems and remove from cache index
        if (remainingVariants.length === 0) {
            try {
                // Delete audio wav
                const wavPath = path.join(audioDir, `${videoId}.wav`);
                if (fs.existsSync(wavPath)) fs.unlinkSync(wavPath);
            } catch (err) {
                console.error("[MAIN] Failed to delete audio wav:", err);
            }

            try {
                // Delete raw notes json
                const rawPath = path.join(dataDir, `${videoId}_raw.json`);
                if (fs.existsSync(rawPath)) fs.unlinkSync(rawPath);
            } catch (err) {
                console.error("[MAIN] Failed to delete raw notes json:", err);
            }

            try {
                // Remove from cache index
                if (fs.existsSync(cacheIndexPath)) {
                    let cache = JSON.parse(fs.readFileSync(cacheIndexPath, 'utf-8'));
                    cache = cache.filter(s => s.id !== videoId);
                    fs.writeFileSync(cacheIndexPath, JSON.stringify(cache, null, 2));
                }
            } catch (err) {
                console.error("[MAIN] Failed to update cache index:", err);
            }
        }
        return true;
    });

    ipcMain.handle('cancel-active-downloads', async () => {
        console.log(`[MAIN] Cancelling active download/processing child processes (Count: ${activeProcesses.length})...`);
        activeProcesses.forEach(p => {
            try {
                p.kill('SIGKILL');
            } catch (e) {
                console.error(`[MAIN] Failed to kill process:`, e);
            }
        });
        activeProcesses = [];
        return true;
    });

    ipcMain.handle('delete-all-cached-songs', async () => {
        try {
            // clear cache index
            if (fs.existsSync(cacheIndexPath)) {
                fs.writeFileSync(cacheIndexPath, JSON.stringify([]));
            }

            // clear all map variants
            if (fs.existsSync(dataDir)) {
                const allDataFiles = fs.readdirSync(dataDir);
                for (const f of allDataFiles) {
                    if (f.endsWith('.json') && f !== 'cache_index.json' && f !== 'user_stats.json' && f !== 'engine_params.json') {
                        fs.unlinkSync(path.join(dataDir, f));
                    }
                }
            }

            // clear all audio wavs
            if (fs.existsSync(audioDir)) {
                const allAudioFiles = fs.readdirSync(audioDir);
                for (const f of allAudioFiles) {
                    if (f.endsWith('.wav')) {
                        fs.unlinkSync(path.join(audioDir, f));
                    }
                }
            }

            return true;
        } catch (e) {
            console.error("[MAIN] Failed to delete all cached songs:", e);
            return false;
        }
    });

    // IPC for searching youtube
    ipcMain.handle('search-youtube', async (event, query) => {
        return new Promise((resolve, reject) => {
            execFile(ytDlpPath, ['ytsearch10:' + query, '--dump-json', '--flat-playlist', '--no-warnings', '--no-playlist'], { maxBuffer: 1024 * 1024 * 100 }, (error, stdout, stderr) => {
                if (error) {
                    console.error("Search failed:", error);
                    return resolve([]); // Return empty on error so UI doesn't crash completely
                }
                try {
                    const lines = stdout.trim().split('\n');
                    const results = lines.map(line => {
                        try { return JSON.parse(line); } catch (e) { return null; }
                    }).filter(v => v !== null && (v._type !== 'url' || v.ie_key === 'Youtube') && v.id).map(v => ({
                        id: v.id,
                        title: v.title,
                        thumbnail: v.thumbnail || (v.thumbnails && v.thumbnails.length ? v.thumbnails[0].url : ''),
                        duration: v.duration_string || v.duration
                    }));
                    resolve(results);
                } catch (e) {
                    console.error("Error parsing search results:", e);
                    resolve([]);
                }
            });
        });
    });
    ipcMain.handle('load-engine-params', async () => {
        try {
            const localParamsPath = path.join(dataDir, 'engine_params.json');
            if (fs.existsSync(localParamsPath)) {
                return JSON.parse(fs.readFileSync(localParamsPath, 'utf8'));
            }
            const bundledParamsPath = getResourcePath('engine_params.json');
            if (fs.existsSync(bundledParamsPath)) {
                return JSON.parse(fs.readFileSync(bundledParamsPath, 'utf8'));
            }
        } catch (e) {
            console.error(e);
        }
        return null;
    });

    // IPC for downloading and extracting audio
    ipcMain.handle('download-audio', async (event, videoId) => {
        return new Promise((resolve, reject) => {
            const audioPath = path.join(audioDir, `${videoId}.wav`);

            // If it already exists, just return path
            if (fs.existsSync(audioPath)) {
                return resolve(`file://${audioPath}`);
            }

            const url = `https://www.youtube.com/watch?v=${videoId}`;

            const ytDlpProcess = spawn(ytDlpPath, [
                url,
                '-f', 'bestaudio',
                '--audio-quality', '0',
                '--extract-audio',
                '--audio-format', 'wav',
                '--ffmpeg-location', ffmpegPath,
                '--newline',
                '--no-playlist',
                '-o', audioPath
            ]);
            registerProcess(ytDlpProcess);

            ytDlpProcess.stdout.on('data', (data) => {
                const output = data.toString();
                // [download]   1.5% of    4.16MiB at    1.55MiB/s ETA 00:02
                const match = output.match(/\[download\]\s+(\d+\.?\d*)%/);
                if (match && match[1]) {
                    const percent = parseFloat(match[1]);
                    event.sender.send('download-progress', percent);
                }
            });

            ytDlpProcess.on('close', (code) => {
                if (code === 0) {
                    resolve(`file://${audioPath}`);
                } else {
                    reject(new Error(`yt-dlp exited with code ${code}`));
                }
            });

            ytDlpProcess.on('error', (err) => {
                reject(err);
            });
        });
    });

    ipcMain.handle('separate-audio-stems', async (event, videoId) => {
        const audioPath = path.join(audioDir, `${videoId}.wav`);
        const instrumentalPath = path.join(audioDir, `${videoId}_instrumental.wav`);

        if (fs.existsSync(instrumentalPath)) {
            return { success: true, path: `file://${instrumentalPath}` };
        }

        if (!fs.existsSync(audioPath)) {
            throw new Error(`Audio file not found for ${videoId}`);
        }

        return new Promise((resolve, reject) => {
            const isWin = process.platform === 'win32';
            let pythonBin = '';
            let useSystemFallback = false;

            const devVenvPath = getResourcePath('venv');
            const localDir = path.dirname(process.env.APPIMAGE || process.execPath);
            const localVenvPath = path.join(localDir, 'venv');

            const devVenvBin = findPythonInVenv(devVenvPath);
            const localVenvBin = findPythonInVenv(localVenvPath);

            if (devVenvBin) {
                pythonBin = devVenvBin;
            } else if (localVenvBin) {
                pythonBin = localVenvBin;
            } else {
                pythonBin = isWin ? 'python.exe' : 'python3';
                useSystemFallback = true;
            }

            const separateScript = getResourcePath('ai_trainer', 'separate_vocals.py');

            if (!useSystemFallback && !fs.existsSync(pythonBin)) {
                return reject(new Error("Python VENV not found, cannot separate vocals."));
            }

            console.log(`[MAIN] Spawning separate_vocals.py: ${pythonBin} ${separateScript} ${audioPath} ${instrumentalPath}`);
            const pythonProcess = spawn(pythonBin, [separateScript, audioPath, instrumentalPath]);
            registerProcess(pythonProcess);
            let output = "";
            let stderrOutput = "";

            pythonProcess.stdout.on('data', (data) => {
                output += data.toString();
            });

            pythonProcess.stderr.on('data', (data) => {
                stderrOutput += data.toString();
                console.log(`[SEP PY] ${data.toString().trim()}`);
            });

            pythonProcess.on('close', (code) => {
                if (code === 0) {
                    try {
                        const result = JSON.parse(output.trim());
                        if (result.error) {
                            reject(new Error(result.error));
                        } else {
                            resolve({ success: true, path: `file://${instrumentalPath}` });
                        }
                    } catch (e) {
                        reject(new Error(`Failed to parse python separation output: ${output}`));
                    }
                } else {
                    reject(new Error(`Python process exited with code ${code}. Stderr: ${stderrOutput}`));
                }
            });

            pythonProcess.on('error', (err) => {
                reject(err);
            });
        });
    });

    ipcMain.handle('analyze-structure', async (event, videoId) => {
        const tempo = await getOrAnalyzeSongTempo(videoId, event.sender);
        return { tempo: tempo || 120 };
    });

    ipcMain.handle('save-beatgen-log', async (event, logString) => {
        try {
            if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

            const now = new Date();
            const timestamp = now.toISOString().replace(/[:T]/g, '-').replace('Z', '').replace('.', '-');
            const filename = `logfile.${timestamp}.txt`;
            const filePath = path.join(logDir, filename);

            fs.writeFileSync(filePath, logString);
            console.log(`[MAIN] BeatGen log saved to: ${filePath}`);
            return true;
        } catch (e) {
            console.error("[MAIN] Failed to save BeatGen log:", e);
            return false;
        }
    });

    ipcMain.handle('clear-all-logs', async () => {
        try {
            if (fs.existsSync(logDir)) {
                const files = fs.readdirSync(logDir);
                for (const file of files) {
                    if (file.endsWith('.txt')) {
                        fs.unlinkSync(path.join(logDir, file));
                    }
                }
                console.log("[MAIN] Cleared all debug logs.");
            }
            return true;
        } catch (e) {
            console.error("[MAIN] Failed to clear logs:", e);
            return false;
        }
    });

    ipcMain.handle('check-file-exists', async (event, checkPath) => {
        try {
            // Because paths might originate from `file://` or `../data`, let's normalize them 
            let absolutePath = checkPath;
            if (checkPath.startsWith('file://')) absolutePath = checkPath.replace('file://', '');
            else if (checkPath.startsWith('../')) {
                // If the path comes from the renderer as relative to HTML
                absolutePath = path.resolve(__dirname, 'src', checkPath);
            }
            return fs.existsSync(absolutePath);
        } catch (e) {
            console.error("[MAIN] Error checking if file exists:", e);
            return false;
        }
    });

    ipcMain.handle('read-file-buffer', async (event, filePath) => {
        try {
            const absolutePath = filePath.replace('file://', '');
            if (!fs.existsSync(absolutePath)) return null;
            // Return raw buffer. Electron IPC will serialize it to Uint8Array natively.
            return fs.readFileSync(absolutePath);
        } catch (e) {
            console.error("[MAIN] Error reading file buffer:", e);
            return null;
        }
    });

    createWindow();

    // Auto-update yt-dlp on startup in the background
    setTimeout(() => {
        console.log('[MAIN] Starting background update check for yt-dlp...');
        const updateProcess = spawn(ytDlpPath, ['-U']);
        updateProcess.on('close', (code) => {
            console.log(`[MAIN] yt-dlp update check finished with code: ${code}`);
        });
        updateProcess.on('error', (err) => {
            console.error(`[MAIN] Failed to run yt-dlp update:`, err);
        });
    }, 5000);

    app.on('activate', function () {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', function () {
    if (process.platform !== 'darwin') app.quit();
});
