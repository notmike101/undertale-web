const keyCodes = {
    ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Enter: 13, Escape: 27, Shift: 16, Backspace: 8,
    ...Object.fromEntries(Array.from('abcdefghijklmnopqrstuvwxyz0123456789 ', (key) => [key, key.toUpperCase().codePointAt(0)])),
    '.': 190, ',': 188, '-': 189, '=': 187, '!': 49, '?': 191, '/': 191, '\'': 222, ';': 186,
};

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
 * @param {() => Promise<boolean>} persistSaves - Save-flush callback.
 * @returns {void}
 */
export function installAgent(state, canvas, persistSaves) {
    const held = new Set();
    let acting = false;
    let observing = false;
    let paused = false;

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

        if (down && key.length === 1) {
            state.runtime._onCharacter(key.codePointAt(0));
        } else if (down && key === 'Backspace') {
            state.runtime._onCharacter(8);
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
     * Toggle the runner's existing pause control, leaving game state untouched.
     *
     * @param {boolean} value - Desired pause state.
     * @returns {Promise<void>} Resolves after the input queue processes the toggle.
     */
    async function setPaused(value) {
        if (!state.running || value === paused) {
            return;
        }

        state.runtime._onKeyDown(119);
        await delay(80);
        state.runtime._onKeyUp(119);
        await delay(40);
        paused = value;
        document.querySelector('#pause').textContent = paused ? 'Resume' : 'Pause';
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

            return { running: true, paused, ...snapshot };
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
            throw new Error('Use a supported key from undertaleAgent.keys.');
        }

        if (!Number.isFinite(milliseconds) || milliseconds < 0 || milliseconds > 5_000) {
            throw new Error('Action duration must be between 0 and 5000 milliseconds.');
        }

        acting = true;
        const resumePause = paused;

        try {
            if (resumePause) {
                await setPaused(false);
            }

            for (const key of keys) {
                setKey(key, true);
            }

            await delay(milliseconds);
        } finally {
            releaseAll();

            if (resumePause) {
                await setPaused(true);
            }

            acting = false;
        }

        await delay(40);

        return observe();
    }

    /**
     * Type ordinary ASCII characters through the game's real text-input path.
     *
     * @param {string} text - Up to 256 printable characters.
     * @returns {Promise<object>} Observation after typing.
     */
    async function typeText(text) {
        if (typeof text !== 'string' || text.length > 256 || !/^[\x20-\x7E]*$/u.test(text)) {
            throw new Error('Text input accepts up to 256 printable ASCII characters.');
        }

        if (!state.running || acting || observing) {
            throw new Error('Launch the game and wait for the current action before typing.');
        }

        acting = true;
        const resumePause = paused;

        /**
         * Deliver one character per game step interval.
         *
         * @param {number} index - Current character index.
         * @returns {Promise<void>} Resolves after the remaining text is delivered.
         */
        async function typeNext(index) {
            if (index >= text.length) {
                return;
            }

            state.runtime._onCharacter(text.codePointAt(index));
            await delay(80);

            return typeNext(index + 1);
        }

        try {
            if (resumePause) {
                await setPaused(false);
            }

            await typeNext(0);
        } finally {
            if (resumePause) {
                await setPaused(true);
            }

            acting = false;
        }

        return observe();
    }

    /**
     * Return a compact observation suited to an agent's decision loop.
     *
     * @returns {Promise<object>} Room, player stats, actors, and writer text fields.
     */
    async function look() {
        const snapshot = await observe();

        if (!snapshot.running) {
            return snapshot;
        }

        const globals = snapshot.globalVariables;

        return {
            frame: snapshot.frame,
            room: snapshot.room,
            paused,
            player: { hp: globals.hp, maxhp: globals.maxhp, lv: globals.lv, gold: globals.gold, plot: globals.plot, inbattle: globals.inbattle },
            actors: snapshot.instances.map((instance) => ({ id: instance.instanceId, object: instance.objectName, x: instance.x, y: instance.y, visible: instance.visible, solid: instance.solid })),
            dialogue: snapshot.instances.filter((instance) => /writer/iu.test(instance.objectName)).map((instance) => ({
                object: instance.objectName,
                text: Object.fromEntries(Object.entries(instance.selfVariables).filter(([, value]) => typeof value === 'string')),
            })),
        };
    }

    globalThis.undertaleAgent = Object.freeze({
        version: 1,
        keys: Object.keys(keyCodes),
        observe,
        look,
        act,
        type: typeText,
        /**
         * Pause gameplay while an agent decides its next action.
         *
         * @returns {Promise<void>} Resolves when paused.
         */
        pause: () => setPaused(true),
        /**
         * Return to continuous human gameplay.
         *
         * @returns {Promise<void>} Resolves when resumed.
         */
        resume: () => setPaused(false),
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
        status: () => ({ running: state.running, loading: state.loading, paused, error: state.error, source: state.source, logs: state.logs.slice(-15) }),
    });
    document.querySelector('#pause').addEventListener('click', async () => {
        await setPaused(!paused);
        canvas.focus();
    });
    canvas.addEventListener('click', () => canvas.focus());
    globalThis.addEventListener('keydown', (event) => {
        if (document.activeElement !== canvas) {
            return;
        }

        const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;

        if (keyCodes[key]) {
            event.preventDefault();
            setKey(event.key, true);
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
