const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const https = require('https');

const projectRoot = __dirname;
const args = process.argv.slice(2);
const buildWin = args.includes('--win');
const buildLinux = args.includes('--linux');

// Helper to download files using native HTTPS
function downloadFile(url, dest) {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(dest);
        https.get(url, (response) => {
            if (response.statusCode !== 200) {
                reject(new Error(`Failed to download: Status ${response.statusCode}`));
                return;
            }
            response.pipe(file);
            file.on('finish', () => {
                file.close(resolve);
            });
        }).on('error', (err) => {
            fs.unlink(dest, () => reject(err));
        });
    });
}

async function run() {
    if (buildLinux || (!buildWin && process.platform === 'linux')) {
        const venvProdPath = path.join(projectRoot, 'venv-prod');
        console.log('[BUILD PREP] Checking production Linux Python venv...');

        if (!fs.existsSync(venvProdPath)) {
            console.log('[BUILD PREP] venv-prod not found. Creating a minimal production Linux venv...');
            try {
                execSync('python3 -m venv venv-prod', { cwd: projectRoot, stdio: 'inherit' });
                console.log('[BUILD PREP] venv-prod created. Installing production dependencies (librosa, numpy)...');
                execSync('./venv-prod/bin/pip install --no-cache-dir librosa numpy', { cwd: projectRoot, stdio: 'inherit' });
                console.log('[BUILD PREP] Production Linux venv dependencies installed successfully.');
            } catch (error) {
                console.error('[BUILD PREP] Error creating production Linux venv:', error);
                process.exit(1);
            }
        } else {
            console.log('[BUILD PREP] venv-prod already exists. Skipping Linux venv creation.');
        }
    }

    if (buildWin || (!buildLinux && process.platform === 'win32')) {
        const venvWinPath = path.join(projectRoot, 'venv-win');
        console.log('[BUILD PREP] Checking production Windows Python environment...');

        if (!fs.existsSync(venvWinPath)) {
            console.log('[BUILD PREP] venv-win not found. Setting up portable Windows Python...');
            const zipPath = path.join(projectRoot, 'python-win.zip');
            const embedPythonUrl = 'https://www.python.org/ftp/python/3.13.1/python-3.13.1-embed-amd64.zip';

            try {
                console.log(`[BUILD PREP] Downloading embeddable Windows Python from ${embedPythonUrl}...`);
                await downloadFile(embedPythonUrl, zipPath);
                
                fs.mkdirSync(venvWinPath, { recursive: true });
                console.log('[BUILD PREP] Extracting embeddable Windows Python...');
                execSync(`unzip -o "${zipPath}" -d "${venvWinPath}"`, { cwd: projectRoot, stdio: 'inherit' });
                fs.unlinkSync(zipPath);

                // Configure Python path search by uncommenting "import site"
                const pthPath = path.join(venvWinPath, 'python313._pth');
                if (fs.existsSync(pthPath)) {
                    let pthContent = fs.readFileSync(pthPath, 'utf8');
                    pthContent = pthContent.replace('#import site', 'import site');
                    fs.writeFileSync(pthPath, pthContent, 'utf8');
                    console.log('[BUILD PREP] Configured site-packages import in python313._pth.');
                }

                console.log('[BUILD PREP] Installing Windows Python dependencies (librosa, numpy)...');
                execSync(
                    'pip install --platform win_amd64 --only-binary=:all: --target ./venv-win --implementation cp --python-version 3.13 --no-cache-dir librosa numpy',
                    { cwd: projectRoot, stdio: 'inherit' }
                );
                console.log('[BUILD PREP] Production Windows Python environment populated successfully.');
            } catch (error) {
                console.error('[BUILD PREP] Error setting up Windows Python environment:', error);
                if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
                process.exit(1);
            }
        } else {
            console.log('[BUILD PREP] venv-win already exists. Skipping Windows Python environment setup.');
        }
    }
}

run();
