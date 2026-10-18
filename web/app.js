import { installAgent } from './agent.js';
import createRunner from './runtime/butterscotch.mjs';

const canvas = document.querySelector('#canvas');
const status = document.querySelector('#status');
const logElement = document.querySelector('#log');
const saveStatus = document.querySelector('#save-status');
const localButton = document.querySelector('#play-local');
const folderButton = document.querySelector('#import-folder');
const folderInput = document.querySelector('#folder');
const state = { runtime: null, running: false, loading: false, error: null, logs: [], source: null };
let database;
let saving = false;
let saveTimer;

/**
 * Open this origin's browser save database.
 *
 * @returns {Promise<IDBDatabase>} The initialized database.
 */
function openDatabase() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open('undertale-web', 1);

        request.addEventListener('upgradeneeded', () => request.result.createObjectStore('saves'));
        request.addEventListener('success', () => resolve(request.result));
        request.addEventListener('error', () => reject(request.error));
    });
}

/**
 * Read or write a complete save snapshot in one transaction.
 *
 * @param {object[]} [snapshot] - Files to save; omit to read.
 * @returns {Promise<object[]>} The saved or retrieved snapshot.
 */
async function saveTransaction(snapshot) {
    database ??= await openDatabase();

    return new Promise((resolve, reject) => {
        const transaction = database.transaction('saves', snapshot ? 'readwrite' : 'readonly');
        const store = transaction.objectStore('saves');
        const request = snapshot ? store.put(snapshot, 'undertale') : store.get('undertale');

        transaction.addEventListener('complete', () => resolve(snapshot ?? request.result ?? []));
        transaction.addEventListener('error', () => reject(transaction.error));
        transaction.addEventListener('abort', () => reject(transaction.error ?? new Error('Save transaction aborted.')));
    });
}

/**
 * Record a bounded diagnostic history without injecting HTML.
 *
 * @param {unknown} message - Runtime message.
 * @returns {void}
 */
function log(message) {
    state.logs.push(String(message));

    if (state.logs.length > 120) {
        state.logs.shift();
    }

    logElement.textContent = state.logs.join('\n');
    logElement.scrollTop = logElement.scrollHeight;
}

/**
 * Show an actionable failure and retain diagnostics.
 *
 * @param {unknown} error - Failure to display.
 * @returns {void}
 */
function fail(error) {
    state.error = String(error);
    status.textContent = state.error;
    log(error);
}

/**
 * Read every save file from the game's isolated virtual save directory.
 *
 * @returns {object[]} Names and byte arrays for all current saves.
 */
function readSaves() {
    const files = [];
    const fs = state.runtime.FS;

    for (const name of fs.readdir('/saves')) {
        if (name !== '.' && name !== '..' && fs.isFile(fs.stat(`/saves/${name}`).mode)) {
            files.push({ name, data: fs.readFile(`/saves/${name}`) });
        }
    }

    return files;
}

/**
 * Persist the game-created files without touching native Steam saves.
 *
 * @returns {Promise<void>} Resolves after the IndexedDB commit.
 */
async function persistSaves() {
    if (!state.runtime || saving) {
        return;
    }

    saving = true;

    try {
        const files = readSaves();

        await saveTransaction(files);
        saveStatus.textContent = files.length ? `Saved in this browser · ${files.length} files` : 'Use a SAVE point to save your journey';
    } catch (error) {
        saveStatus.textContent = 'Save storage failed — export a backup now';
        log(error);
    } finally {
        saving = false;
    }
}

/**
 * Validate the root-level files the runner can import.
 *
 * @param {string} name - Proposed file name.
 * @returns {boolean} Whether this is a supported game asset name.
 */
function validAsset(name) {
    return /^[\w .()-]+$/u.test(name) && (name.toLowerCase() === 'data.win' || name.toLowerCase().endsWith('.ogg'));
}

/**
 * Allocate command-line arguments for the upstream WASM entry point.
 *
 * @param {object} runtime - Initialized Butterscotch module.
 * @param {string[]} argumentsList - Runner arguments excluding executable name.
 * @returns {Promise<number>} Resolves when the game exits.
 */
async function run(runtime, argumentsList) {
    const pointers = argumentsList.map((value) => runtime.stringToNewUTF8(value));
    const argv = runtime._malloc((pointers.length + 1) * 4);

    for (const [index, pointer] of pointers.entries()) {
        runtime.setValue(argv + index * 4, pointer, '*');
    }

    runtime.setValue(argv + pointers.length * 4, 0, '*');

    try {
        return await runtime._startRunner(pointers.length, argv);
    } finally {
        for (const pointer of pointers) {
            runtime._free(pointer);
        }

        runtime._free(argv);
    }
}

/**
 * Load authorized local game files and run their original bytecode.
 *
 * @param {object[]} files - File descriptors with name, size, and async read method.
 * @returns {Promise<void>} Resolves once startup has been dispatched.
 */
async function launch(files) {
    if (state.loading || state.running) {
        return;
    }

    state.loading = true;
    localButton.disabled = true;
    folderButton.disabled = true;

    try {
        if (typeof WebAssembly.Suspending !== 'function') {
            throw new TypeError('This runtime needs WebAssembly JSPI. Open this page in an up-to-date Chrome or Edge browser.');
        }

        if (!files.some((file) => file.name.toLowerCase() === 'data.win')) {
            throw new Error('Select the Undertale folder containing data.win and its .ogg music files.');
        }

        status.textContent = 'Starting the WebAssembly runtime…';
        const runtime = await createRunner({
            canvas,
            print: log,
            printErr: log,
            /**
             * Locate a generated runner asset beside its JavaScript module.
             *
             * @param {string} name - Runtime asset name.
             * @returns {string} Absolute runtime asset URL.
             */
            locateFile: (name) => new URL(`./runtime/${name}`, import.meta.url).href,
        });

        state.runtime = runtime;
        runtime.specialHTMLTargets['#canvas'] = canvas;
        runtime.FS.mkdir('/game');
        runtime.FS.mkdir('/saves');
        let loaded = 0;

        /**
         * Bound memory by loading six original game assets at a time.
         *
         * @param {number} [offset] - Index of the next batch.
         * @returns {Promise<void>} Resolves after every asset is loaded.
         */
        async function loadBatch(offset = 0) {
            if (offset >= files.length) {
                return;
            }

            await Promise.all(files.slice(offset, offset + 6).map(async (file) => {
                if (!validAsset(file.name) || file.size > 536_870_912) {
                    throw new Error(`Unsupported game file: ${file.name}`);
                }

                const bytes = new Uint8Array(await file.read());

                if (file.name.toLowerCase() === 'data.win' && new TextDecoder().decode(bytes.subarray(0, 4)) !== 'FORM') {
                    throw new Error('data.win is not a GameMaker archive.');
                }

                runtime.FS.writeFile(`/game/${file.name.toLowerCase() === 'data.win' ? 'data.win' : file.name}`, bytes);
                loaded += 1;
                status.textContent = `Loading your game · ${loaded} / ${files.length} files`;
            }));

            return loadBatch(offset + 6);
        }

        await loadBatch();
        const saved = await saveTransaction();

        for (const file of saved) {
            runtime.FS.writeFile(`/saves/${file.name}`, file.data);
        }

        document.querySelector('#launcher').hidden = true;
        document.querySelector('#player').hidden = false;
        document.querySelector('#import-save').disabled = true;
        state.running = true;
        state.loading = false;
        status.textContent = 'Click the game to play. Your journey stays in this browser.';
        canvas.focus();
        saveTimer = setInterval(persistSaves, 2_000);
        const argumentsList = ['/game/data.win', '--save-folder', '/saves', '--dump-frame-json-file', '/state.json', '--disable-log-colours'];

        run(runtime, argumentsList).then(async () => {
            state.running = false;
            clearInterval(saveTimer);
            await persistSaves();
            status.textContent = 'The game has closed. Relaunch to continue with your saved progress.';
        }).catch((error) => {
            state.running = false;
            clearInterval(saveTimer);
            persistSaves();
            fail(error);
        });
    } catch (error) {
        fail(error);
        state.loading = false;
        localButton.disabled = false;
        folderButton.disabled = false;
    }
}

/**
 * Load the installation exposed by the loopback development server.
 *
 * @returns {Promise<void>} Resolves after dispatching startup.
 */
async function launchLocal() {
    try {
        const response = await fetch('./api/game');

        if (!response.ok) {
            throw new Error('Installed copy is unavailable here. Use Import game folder instead.');
        }

        const manifest = await response.json();

        state.source = 'installed';
        await launch(manifest.files.map((file) => ({
            ...file,
            /**
             * Fetch one asset from the loopback game installation.
             *
             * @returns {Promise<ArrayBuffer>} Original asset bytes.
             */
            read: async () => {
                const asset = await fetch(`./game/${encodeURIComponent(file.name)}`);

                if (!asset.ok) {
                    throw new Error(`Could not load ${file.name}`);
                }

                return asset.arrayBuffer();
            },
        })));
    } catch (error) {
        fail(error);
    }
}

/**
 * Export a portable browser-save backup.
 *
 * @returns {Promise<void>} Resolves after triggering the local download.
 */
async function exportSave() {
    try {
        const files = state.runtime ? readSaves() : await saveTransaction();
        const payload = { format: 'undertale-web-save-v1', files: files.map((file) => ({ name: file.name, data: Array.from(file.data) })) };
        const url = URL.createObjectURL(new Blob([JSON.stringify(payload)], { type: 'application/json' }));
        const link = document.createElement('a');

        link.href = url;
        link.download = 'undertale-save.json';
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1_000);
    } catch (error) {
        fail(error);
    }
}

localButton.addEventListener('click', launchLocal);
folderButton.addEventListener('click', () => folderInput.click());
folderInput.addEventListener('change', () => {
    const files = Array.from(folderInput.files).filter((file) => validAsset(file.name));

    state.source = 'folder';
    launch(files.map((file) => ({
        name: file.name,
        size: file.size,
        /**
         * Read the user-selected asset without changing its bytes.
         *
         * @returns {Promise<ArrayBuffer>} Original asset bytes.
         */
        read: () => file.arrayBuffer(),
    })));
});
document.querySelector('#fullscreen').addEventListener('click', () => document.querySelector('.game-frame').requestFullscreen().catch(fail));
document.querySelector('#export-save').addEventListener('click', exportSave);
document.querySelector('#restart').addEventListener('click', async () => {
    await persistSaves();
    location.reload();
});
document.querySelector('#import-save').addEventListener('change', async (event) => {
    try {
        const file = event.target.files[0];

        if (!file || file.size > 10_485_760) {
            throw new Error('Choose a save backup smaller than 10 MB.');
        }

        const payload = JSON.parse(await file.text());

        if (payload.format !== 'undertale-web-save-v1' || !Array.isArray(payload.files) || payload.files.length > 100) {
            throw new Error('Not an Undertale Web save backup.');
        }

        const snapshot = payload.files.map((entry) => {
            if (!/^[\w.-]+$/u.test(entry.name) || entry.name === '.' || entry.name === '..' || !Array.isArray(entry.data) || !entry.data.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)) {
                throw new Error('Invalid save file in backup.');
            }

            return { name: entry.name, data: Uint8Array.from(entry.data) };
        });

        await saveTransaction(snapshot);
        status.textContent = 'Save restored. Launch the game to continue.';
    } catch (error) {
        fail(error);
    }
});
document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
        persistSaves();
    }
});
installAgent(state, canvas, persistSaves);
