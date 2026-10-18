const keyCodes = { ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Enter: 13, Escape: 27, Shift: 16, z: 90, x: 88, c: 67 };

/**
 * Yield to the real game loop for a bounded duration.
 *
 * @param {number} milliseconds - Time to wait.
 * @returns {Promise<void>} Resolves after the delay.
 */
function delay(milliseconds) {
    return new Promise((resolve) => {
        setTimeout(resolve, milliseconds);
    });
}

/**
 * Install human controls and the browser agent's observation/action interface.
 *
 * @param {object} state - Shared runtime lifecycle state.
 * @param {HTMLCanvasElement} canvas - Game surface.
 * @param {() => Promise<void>} persistSaves - Save-flush callback.
 * @returns {void}
 */
export function installAgent(state, canvas, persistSaves) {
    const held = new Set();
    let acting = false;
    let observing = false;

    /**
     * Send a supported game key transition through the real runner input queue.
     *
     * @param {string} key - Supported keyboard key.
     * @param {boolean} down - Whether to hold or release it.
     * @returns {void}
     */
    function setKey(key, down) {
        const normalized = key.length === 1 ? key.toLowerCase() : key;
        const code = keyCodes[normalized];

        if (!code) {
            throw new Error(`Unsupported key: ${key}`);
        }

        if (!state.running) {
            return;
        }

        if (down && !held.has(normalized)) {
            held.add(normalized);
            state.runtime._onKeyDown(code);
        } else if (!down && held.has(normalized)) {
            held.delete(normalized);
            state.runtime._onKeyUp(code);
        }
    }

    /**
     * Release held controls when focus changes or an action ends.
     *
     * @returns {void}
     */
    function releaseAll() {
        for (const key of held) {
            setKey(key, false);
        }

        held.clear();
    }

    /**
     * Read the runner's own JSON state dump without modifying game variables.
     *
     * @returns {Promise<object>} Current game state and lifecycle details.
     */
    async function observe() {
        if (!state.running) {
            return { running: false, loading: state.loading, error: state.error, logs: state.logs.slice(-15) };
        }

        if (observing) {
            throw new Error('An observation is already in progress.');
        }

        observing = true;

        try {
            state.runtime._onKeyDown(122);
            await delay(80);
            state.runtime._onKeyUp(122);
            await delay(40);
            const snapshot = JSON.parse(state.runtime.FS.readFile('/state.json', { encoding: 'utf8' }));

            return { running: true, ...snapshot };
        } finally {
            state.runtime._onKeyUp(122);
            observing = false;
        }
    }

    /**
     * Hold real game keys for a bounded time, then return a fresh observation.
     *
     * @param {string[]} keys - Supported keyboard keys to hold together.
     * @param {number} [milliseconds] - Duration between zero and five seconds.
     * @returns {Promise<object>} Observation after the action.
     */
    async function act(keys, milliseconds = 100) {
        if (!state.running) {
            throw new Error('Launch the game before acting.');
        }

        if (acting) {
            throw new Error('Wait for the previous action to complete.');
        }

        if (!Array.isArray(keys) || keys.some((key) => typeof key !== 'string' || !keyCodes[key.length === 1 ? key.toLowerCase() : key])) {
            throw new Error('Use supported key names: ArrowUp, ArrowDown, ArrowLeft, ArrowRight, z, x, c, Enter, Shift, Escape.');
        }

        if (!Number.isFinite(milliseconds) || milliseconds < 0 || milliseconds > 5_000) {
            throw new Error('Action duration must be between 0 and 5000 milliseconds.');
        }

        acting = true;

        try {
            for (const key of keys) {
                setKey(key, true);
            }

            await delay(milliseconds);
        } finally {
            releaseAll();
            acting = false;
        }

        await delay(40);

        return observe();
    }

    globalThis.undertaleAgent = Object.freeze({
        version: 1,
        keys: Object.keys(keyCodes),
        observe,
        act,
        release: releaseAll,
        save: persistSaves,
        /**
         * Capture the current game canvas as a PNG data URL.
         *
         * @returns {string} Encoded canvas image.
         */
        screenshot: () => canvas.toDataURL('image/png'),
        /**
         * Read lifecycle details without requesting a game-state dump.
         *
         * @returns {object} Current runtime lifecycle and recent logs.
         */
        status: () => ({ running: state.running, loading: state.loading, error: state.error, source: state.source, logs: state.logs.slice(-15) }),
    });
    canvas.addEventListener('click', () => canvas.focus());
    globalThis.addEventListener('keydown', (event) => {
        if (document.activeElement !== canvas) {
            return;
        }

        const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;

        if (keyCodes[key]) {
            event.preventDefault();
            setKey(key, true);
        }
    });
    globalThis.addEventListener('keyup', (event) => {
        const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;

        if (keyCodes[key]) {
            setKey(key, false);
        }
    });
    globalThis.addEventListener('blur', releaseAll);
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            releaseAll();
        }
    });

    for (const button of document.querySelectorAll('[data-key]')) {
        button.addEventListener('pointerdown', (event) => {
            event.preventDefault();
            button.setPointerCapture(event.pointerId);
            setKey(button.dataset.key, true);
        });
        button.addEventListener('pointerup', () => setKey(button.dataset.key, false));
        button.addEventListener('pointercancel', releaseAll);
        button.addEventListener('lostpointercapture', releaseAll);
    }
}
