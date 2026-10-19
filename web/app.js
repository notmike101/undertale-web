import { installAgent } from './agent.js';
import createRunner from './runtime/butterscotch.mjs';

const canvas = document.querySelector('#canvas');
const status = document.querySelector('#status');
const logElement = document.querySelector('#log');
const saveStatus = document.querySelector('#save-status');
const localButton = document.querySelector('#play-local');
const folderButton = document.querySelector('#import-folder');
const folderInput = document.querySelector('#folder');
const saveList = document.querySelector('#saves');
const storageStatus = document.querySelector('#storage-status');
const state = { runtime: null, running: false, loading: false, savesReady: false, error: null, logs: [], source: null };
const META_KEY = 'meta';
const SAVE_RECORD_PREFIX = 'save:';
let saveRecords = [];
let activeSaveId;
let renamingSaveId;
let armedDeleteId;
let database;
let saveQueue = Promise.resolve();
let saveTimer;
let releaseGameLock;

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
 * Read every key and value stored in the save store in one transaction.
 *
 * @returns {Promise<Array<[string, unknown]>>} Key/value pairs for all stored entries.
 */
async function readStoreEntries() {
    database ??= await openDatabase();

    return new Promise((resolve, reject) => {
        const transaction = database.transaction('saves', 'readonly');
        const store = transaction.objectStore('saves');
        const keys = store.getAllKeys();
        const values = store.getAll();

        transaction.addEventListener('complete', () => resolve(keys.result.map((key, index) => [key, values.result[index]])));
        transaction.addEventListener('error', () => reject(transaction.error));
        transaction.addEventListener('abort', () => reject(transaction.error ?? new Error('Save read aborted.')));
    });
}

/**
 * Apply puts and deletions atomically in one readwrite transaction.
 *
 * @param {[string, object][]} entries - Key/value pairs to store.
 * @param {string[]} deletions - Keys to remove.
 * @returns {Promise<void>} Resolves when the transaction commits.
 */
async function writeStoreEntries(entries, deletions) {
    database ??= await openDatabase();

    return new Promise((resolve, reject) => {
        const transaction = database.transaction('saves', 'readwrite');
        const store = transaction.objectStore('saves');

        for (const [key, value] of entries) {
            store.put(value, key);
        }

        for (const key of deletions) {
            store.delete(key);
        }

        transaction.addEventListener('complete', resolve);
        transaction.addEventListener('error', () => reject(transaction.error));
        transaction.addEventListener('abort', () => reject(transaction.error ?? new Error('Save write aborted.')));
    });
}

/**
 * Build the storage key for one save record.
 *
 * @param {string} id - Save identifier.
 * @returns {string} IndexedDB key holding that save.
 */
function saveKey(id) {
    return `${SAVE_RECORD_PREFIX}${id}`;
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
    status.hidden = false;
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
        if (name !== '.' && name !== '..' && (fs.stat(`/saves/${name}`).mode & 0o17_0000) === 0o10_0000) {
            files.push({ name, data: fs.readFile(`/saves/${name}`) });
        }
    }

    return files;
}

/**
 * Persist the game-created files into the active save record.
 *
 * @returns {Promise<boolean>} Whether the latest snapshot was committed.
 */
async function persistSaves() {
    if (!state.savesReady) {
        return true;
    }

    const files = readSaves();
    const record = saveRecords.find((candidate) => candidate.id === activeSaveId);

    if (!files.length && !record) {
        saveStatus.textContent = 'Use a SAVE point to save your journey';

        return true;
    }

    const updated = {
        id: activeSaveId ?? crypto.randomUUID(),
        label: record?.label ?? `Automatic save · ${new Date().toLocaleString()}`,
        createdAt: record?.createdAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        files,
    };

    saveQueue = saveQueue.catch(() => undefined).then(() => writeStoreEntries([[saveKey(updated.id), updated], [META_KEY, { activeId: updated.id }]], []));

    try {
        await saveQueue;
        activeSaveId = updated.id;
        saveRecords = saveRecords.filter((candidate) => candidate.id !== updated.id);
        saveRecords.push(updated);
        saveStatus.textContent = files.length ? `Saved in this browser · ${files.length} files` : 'Use a SAVE point to save your journey';

        return true;
    } catch (error) {
        saveStatus.textContent = 'Save storage failed — export a backup now';
        log(error);

        return false;
    }
}

/**
 * Prevent a second tab from overwriting the active game's browser saves.
 *
 * @returns {Promise<void>} Resolves when this tab owns the game lock.
 */
function acquireGameLock() {
    return new Promise((resolve, reject) => {
        navigator.locks.request('undertale-web-game', { ifAvailable: true }, async (lock) => {
            if (!lock) {
                reject(new Error('Undertale is already open in another tab. Close that game before launching here.'));

                return;
            }

            await new Promise((release) => {
                releaseGameLock = release;
                resolve();
            });
        }).catch(reject);
    });
}

/**
 * Run a save-management action while holding the browser game lock.
 *
 * @param {() => Promise<unknown>} action - Management action to serialize against launches.
 * @returns {Promise<unknown>} The action result.
 */
function withGameLock(action) {
    return navigator.locks.request('undertale-web-game', { ifAvailable: true }, (lock) => {
        if (!lock) {
            throw new Error('Undertale is already open in another tab. Close that game before managing saves here.');
        }

        return action();
    });
}

/**
 * Validate the root-level files the runner can import.
 *
 * @param {string} name - Proposed file name.
 * @returns {boolean} Whether this is a supported game asset name.
 */
function validAsset(name) {
    return /^[\w .()-]+$/u.test(name) && (['data.win', 'credits.txt'].includes(name.toLowerCase()) || name.toLowerCase().endsWith('.ogg'));
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
    state.error = null;
    state.savesReady = false;
    localButton.disabled = true;
    folderButton.disabled = true;
    document.querySelector('#import-save').disabled = true;

    try {
        if (typeof WebAssembly.Suspending !== 'function') {
            throw new TypeError('This runtime needs WebAssembly JSPI. Open this page in an up-to-date Chrome or Edge browser.');
        }

        if (!files.some((file) => file.name.toLowerCase() === 'data.win')) {
            throw new Error('Select the Undertale folder containing data.win and its .ogg music files.');
        }

        await acquireGameLock();
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
        agent.attachRuntime(runtime);
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

                runtime.FS.writeFile(`/game/${file.name.toLowerCase()}`, bytes);
                loaded += 1;
                status.textContent = `Loading your game · ${loaded} / ${files.length} files`;
            }));

            return loadBatch(offset + 6);
        }

        await loadBatch();
        await loadSaveRecords();
        const saved = saveRecords.find((record) => record.id === activeSaveId)?.files ?? [];

        for (const file of saved) {
            runtime.FS.writeFile(`/saves/${file.name}`, file.data);
        }

        state.savesReady = true;
        document.querySelector('#launcher').hidden = true;
        document.querySelector('#player').hidden = false;
        document.querySelector('#import-save').disabled = true;
        state.running = true;
        state.loading = false;
        status.hidden = true;
        canvas.focus();
        saveTimer = setInterval(persistSaves, 2_000);
        const argumentsList = ['/game/data.win', '--save-folder', '/saves', '--dump-frame-json-file', '/state.json', '--disable-log-colours'];

        run(runtime, argumentsList).then(async () => {
            state.running = false;
            clearInterval(saveTimer);
            await persistSaves();
            status.hidden = false;
            status.textContent = 'The game has closed. Relaunch to continue with your saved progress.';
        }).catch((error) => {
            state.running = false;
            clearInterval(saveTimer);
            persistSaves();
            fail(error);
        });
    } catch (error) {
        fail(error);
        releaseGameLock?.();
        releaseGameLock = undefined;
        state.loading = false;
        state.savesReady = false;
        localButton.disabled = false;
        folderButton.disabled = false;
        document.querySelector('#import-save').disabled = false;
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
 * Export the active browser save as a portable backup.
 *
 * @returns {void}
 */
function exportSave() {
    try {
        const files = state.savesReady ? readSaves() : saveRecords.find((record) => record.id === activeSaveId)?.files ?? [];

        downloadSave(files, 'undertale-save.json');
    } catch (error) {
        fail(error);
    }
}

/**
 * Export one listed save as a portable backup.
 *
 * @param {string} id - Save identifier.
 * @returns {void}
 */
function exportSaveRecord(id) {
    try {
        const record = saveRecords.find((candidate) => candidate.id === id);

        if (!record) {
            throw new Error('That save is no longer listed. Reload and try again.');
        }

        downloadSave(record.files, `undertale-save-${slugify(record.label)}.json`);
    } catch (error) {
        fail(error);
    }
}

/**
 * Download save files in the portable backup format.
 *
 * @param {object[]} files - Names and byte arrays to export.
 * @param {string} filename - Download name for the backup.
 * @returns {void}
 */
function downloadSave(files, filename) {
    const payload = { format: 'undertale-web-save-v1', files: files.map((file) => ({ name: file.name, data: Array.from(file.data) })) };
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload)], { type: 'application/json' }));
    const link = document.createElement('a');

    link.href = url;
    link.download = filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

/**
 * Turn a save label into a safe backup filename fragment.
 *
 * @param {string} label - Save label.
 * @returns {string} Filename fragment.
 */
function slugify(label) {
    return label.toLowerCase().replaceAll(/[^a-z0-9]+/gu, '-').replaceAll(/^-+|-+$/gu, '') || 'save';
}

/**
 * Load the save records, migrating the legacy single snapshot exactly once.
 *
 * @returns {Promise<void>} Resolves when the save list reflects stored state.
 */
async function loadSaveRecords() {
    const records = [];
    const writes = [];
    const deletions = [];
    let storedActiveId;
    let persistedActiveId;

    for (const [key, value] of await readStoreEntries()) {
        if (key === META_KEY && value && typeof value.activeId === 'string') {
            storedActiveId = value.activeId;
            persistedActiveId = value.activeId;
        } else if (key.startsWith(SAVE_RECORD_PREFIX) && value && typeof value.id === 'string' && Array.isArray(value.files)) {
            records.push(value);
        } else if (key === 'undertale' && Array.isArray(value)) {
            const migrated = { id: crypto.randomUUID(), label: 'Original browser save', createdAt: null, updatedAt: null, files: value };

            records.push(migrated);
            writes.push([saveKey(migrated.id), migrated]);
            deletions.push(key);
            storedActiveId ??= migrated.id;
        }
    }

    records.sort((left, right) => String(right.updatedAt ?? right.createdAt ?? '').localeCompare(String(left.updatedAt ?? left.createdAt ?? '')));

    if (!records.some((record) => record.id === storedActiveId)) {
        storedActiveId = records[0]?.id ?? null;
    }

    if (storedActiveId !== persistedActiveId) {
        writes.push([META_KEY, { activeId: storedActiveId }]);
    }

    if (writes.length) {
        await writeStoreEntries(writes, deletions);
    }

    saveRecords = records;
    activeSaveId = storedActiveId;
    renderSaveList();
}

/**
 * Redraw the launcher save list without injecting markup.
 *
 * @returns {void}
 */
function renderSaveList() {
    saveList.textContent = '';

    if (!saveRecords.length) {
        const empty = document.createElement('li');

        empty.textContent = 'No browser saves yet. Launch the game and use a SAVE point, or create a new save.';
        saveList.append(empty);

        return;
    }

    for (const record of saveRecords) {
        const item = document.createElement('li');
        const heading = document.createElement('p');
        const meta = document.createElement('p');
        const actions = document.createElement('div');
        const isActive = record.id === activeSaveId;
        const captured = record.updatedAt ?? record.createdAt;

        item.classList.toggle('active', isActive);
        meta.className = 'save-meta';
        meta.textContent = `${captured ? new Date(captured).toLocaleString() : 'Capture time unknown'} · ${record.files.length ? record.files.map((file) => file.name).join(', ') : 'no saved files yet'}`;
        actions.className = 'save-actions';

        if (renamingSaveId === record.id) {
            const name = document.createElement('input');

            name.type = 'text';
            name.className = 'save-name';
            name.value = record.label;
            name.maxLength = 80;
            name.addEventListener('keydown', (event) => {
                if (event.key === 'Escape') {
                    renamingSaveId = undefined;
                    renderSaveList();
                }
            });
            heading.append(name, saveButton('Save name', () => {
                renameSave(record.id, name.value);
            }), saveButton('Cancel', () => {
                renamingSaveId = undefined;
                renderSaveList();
            }));
        } else {
            heading.textContent = `${record.label}${isActive ? ' · active' : ''}`;
        }

        actions.append(saveButton(isActive ? 'Active' : 'Use', () => {
            selectSave(record.id);
        }, isActive), saveButton('Rename', () => {
            renamingSaveId = record.id;
            armedDeleteId = undefined;
            renderSaveList();
        }), saveButton('Export', () => {
            exportSaveRecord(record.id);
        }), saveButton(armedDeleteId === record.id ? 'Confirm delete' : 'Delete', () => {
            deleteSave(record.id);
        }));

        item.append(heading, meta, actions);
        saveList.append(item);
    }
}

/**
 * Create a small management button for a save row.
 *
 * @param {string} label - Button text.
 * @param {() => void} onClick - Click handler.
 * @param {boolean} [disabled] - Whether the button is inert.
 * @returns {HTMLButtonElement} The configured button.
 */
function saveButton(label, onClick, disabled) {
    const button = document.createElement('button');

    button.type = 'button';
    button.textContent = label;
    button.disabled = Boolean(disabled);
    button.addEventListener('click', onClick);

    return button;
}

/**
 * Create an empty save and select it for the next launch.
 *
 * @returns {Promise<void>} Resolves when the new save is stored.
 */
async function createSave() {
    const record = { id: crypto.randomUUID(), label: `New save · ${new Date().toLocaleString()}`, createdAt: new Date().toISOString(), updatedAt: null, files: [] };

    try {
        await withGameLock(async () => {
            await writeStoreEntries([[saveKey(record.id), record], [META_KEY, { activeId: record.id }]], []);
        });
    } catch (error) {
        fail(error);

        return;
    }

    saveRecords.push(record);
    activeSaveId = record.id;
    renderSaveList();
    status.textContent = 'New save selected. Launch the game to start a separate playthrough.';
}

/**
 * Select the save that a normal launch resumes.
 *
 * @param {string} id - Save identifier.
 * @returns {Promise<void>} Resolves when the selection is stored.
 */
async function selectSave(id) {
    try {
        await withGameLock(async () => {
            await writeStoreEntries([[META_KEY, { activeId: id }]], []);
        });
    } catch (error) {
        fail(error);

        return;
    }

    activeSaveId = id;
    renderSaveList();
    status.textContent = 'Selected save. Launching resumes from it.';
}

/**
 * Rename a stored save.
 *
 * @param {string} id - Save identifier.
 * @param {string} label - Proposed label.
 * @returns {Promise<void>} Resolves when the save list refreshes.
 */
async function renameSave(id, label) {
    const trimmed = label.trim().slice(0, 80);

    renamingSaveId = undefined;

    if (!trimmed) {
        fail(new Error('Save names cannot be empty.'));

        return;
    }

    try {
        await withGameLock(async () => {
            const stored = (await readStoreEntries()).find(([key]) => key === saveKey(id))?.[1];

            if (!stored) {
                throw new Error('That save is no longer listed. Reload and try again.');
            }

            await writeStoreEntries([[saveKey(id), { ...stored, label: trimmed }]], []);
        });
    } catch (error) {
        fail(error);
    }

    await loadSaveRecords().catch(fail);
}

/**
 * Delete one stored save after a second confirming click.
 *
 * @param {string} id - Save identifier.
 * @returns {Promise<void>} Resolves when the save list refreshes.
 */
async function deleteSave(id) {
    if (armedDeleteId !== id) {
        armedDeleteId = id;
        renderSaveList();
        status.textContent = 'Click Delete again to remove this browser save.';

        return;
    }

    armedDeleteId = undefined;

    try {
        await withGameLock(() => writeStoreEntries([], [saveKey(id)]));
    } catch (error) {
        fail(error);

        return;
    }

    await loadSaveRecords().catch(fail);
    status.textContent = 'Save deleted. Other browser saves are untouched.';
}

/**
 * Reflect the browser's storage durability and request it under user gestures.
 *
 * @param {boolean} [request] - Whether to call `navigator.storage.persist()` now.
 * @returns {Promise<void>} Resolves when the storage status updates.
 */
async function refreshStorageStatus(request = false) {
    if (!navigator.storage?.persisted) {
        storageStatus.textContent = 'This browser cannot make save storage durable. Export backups regularly.';

        return;
    }

    let persisted = await navigator.storage.persisted();

    if (!persisted && request && navigator.storage.persist) {
        persisted = await navigator.storage.persist();
    }

    storageStatus.textContent = persisted
        ? 'Browser storage is durable for this site: saves are protected from eviction.'
        : 'Browser storage is not durable yet: the browser may evict saves under storage pressure. Launch or create a save to request durability.';

    if (!state.running) {
        saveStatus.textContent = persisted ? 'Browser saves ready' : 'Browser saves active · storage not durable';
    }
}

localButton.addEventListener('click', () => {
    refreshStorageStatus(true);
    launchLocal();
});
folderButton.addEventListener('click', () => {
    refreshStorageStatus(true);
    folderInput.click();
});
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
document.querySelector('#fullscreen').addEventListener('click', () => document.documentElement.requestFullscreen().catch(fail));
document.querySelector('#export-save').addEventListener('click', exportSave);
document.querySelector('#restart').addEventListener('click', async () => {
    if (await persistSaves()) {
        location.reload();
    }
});
document.querySelector('#new-save').addEventListener('click', () => {
    refreshStorageStatus(true);
    createSave();
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

        const record = { id: crypto.randomUUID(), label: `Imported save · ${new Date().toLocaleString()}`, createdAt: new Date().toISOString(), updatedAt: null, files: snapshot };

        await withGameLock(async () => {
            await writeStoreEntries([[saveKey(record.id), record], [META_KEY, { activeId: record.id }]], []);
        });

        saveRecords.push(record);
        activeSaveId = record.id;
        renderSaveList();
        status.textContent = 'Backup imported as a new save. Launch the game to continue from it.';
    } catch (error) {
        fail(error);
    }
});
document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
        persistSaves();
    }
});
window.addEventListener('pagehide', () => {
    if (state.running) {
        persistSaves();
    }
});
canvas.addEventListener('pointerdown', () => {
    document.querySelector('#game-menu').open = false;
});
const agent = installAgent(state, canvas, persistSaves, log);

loadSaveRecords().catch(fail);
refreshStorageStatus();
