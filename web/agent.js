import { connectController } from './controller-socket.js';
import { createTelemetry } from './controller-state.js';

const keyCodes = {
    ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Enter: 13, Escape: 27, Shift: 16, Control: 17, Backspace: 8,
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
 * Normalize a supported key name the same way setKey does.
 *
 * @param {string} key - Supported keyboard key.
 * @returns {string} Normalized key name.
 */
function normalizeKey(key) {
    return key.length === 1 ? key.toLowerCase() : key;
}

/**
 * Install human controls and the browser agent's observation/action interface.
 *
 * @param {object} state - Shared runtime lifecycle state.
 * @param {HTMLCanvasElement} canvas - Game surface.
 * @param {() => Promise<boolean>} persistSaves - Save-flush callback.
 * @param {(message: string) => void} log - Diagnostics log callback.
 * @returns {object} Runtime attachment hook.
 */
export function installAgent(state, canvas, persistSaves, log) {
    /*
       The runner drains its fixed 64-entry per-frame input queue once per presented
       frame. Keep injected transitions well below that limit so no input is ever
       silently dropped, and prove each queued event was consumed by observing
       frame progress.
     */
    const MAX_PENDING_INJECTIONS = 48;
    const DRAIN_CONFIRM_MS = 2_000;
    const held = new Set();
    let acting = false;
    let actionEpoch = 0;
    const telemetry = createTelemetry();
    let watchdog;
    let latestSnapshot = null;
    let sampledFrame = -1;
    let paused = false;
    let pendingInjections = 0;
    let queueFloorFrame = null;
    let lastPresentedFrame = -1;
    const inputHealth = { injectedEvents: 0, gatedWaits: 0, stalledActions: 0, rejectedInjections: 0, healedReleases: 0 };

    /**
     * Record events written into the runner's per-frame input queue.
     *
     * @param {number} count - Number of injected events.
     * @returns {void}
     */
    function noteInjections(count) {
        pendingInjections += count;
        inputHealth.injectedEvents += count;
        queueFloorFrame = lastPresentedFrame;
    }

    /**
     * Track frame progress and prove the runner consumed queued input.
     *
     * A frame counter at least two ahead of the last injection floor means a
     * full drain ran after those events were queued; the second frame covers
     * events injected during a mid-frame runtime suspension.
     *
     * @param {number} frame - Runner frame counter from a snapshot or presented frame.
     * @returns {void}
     */
    function noteFrame(frame) {
        if (!Number.isFinite(frame)) {
            return;
        }

        if (frame > lastPresentedFrame) {
            lastPresentedFrame = frame;
        }

        if (queueFloorFrame !== null && lastPresentedFrame >= queueFloorFrame + 2) {
            pendingInjections = 0;
        }
    }

    /**
     * Wait until the runner is proven to have drained its input queue.
     *
     * @param {number} [timeoutMs] - Maximum time to wait for frame progress.
     * @returns {Promise<boolean>} True when the drain is confirmed or the runner
     * is paused (paused loops present no frames; queued events drain on resume).
     */
    async function waitForDrain(timeoutMs = DRAIN_CONFIRM_MS) {
        if (pendingInjections === 0) {
            return true;
        }

        return await new Promise((resolve) => {
            const deadline = Date.now() + timeoutMs;
            const poller = setInterval(() => {
                if (pendingInjections === 0 || paused) {
                    clearInterval(poller);
                    resolve(true);
                } else if (Date.now() >= deadline) {
                    clearInterval(poller);
                    resolve(false);
                }
            }, 10);
        });
    }

    /**
     * Reserve input-queue room for a batch of injected events.
     *
     * Waits for a proven drain when the pending budget is exhausted. A drain
     * never arriving within the timeout is a runner pipeline stall; that case
     * is logged and reported instead of injecting into a possibly full queue.
     *
     * @param {number} count - Events about to be injected.
     * @returns {Promise<boolean>} Whether the events may be injected.
     */
    async function reserveInjections(count) {
        if (pendingInjections + count <= MAX_PENDING_INJECTIONS) {
            return true;
        }

        inputHealth.gatedWaits++;

        if (await waitForDrain()) {
            return true;
        }

        inputHealth.stalledActions++;
        inputHealth.rejectedInjections += count;

        if (log) {
            log(`Input pipeline stall: no runner frame within ${DRAIN_CONFIRM_MS} ms; ${count} input event(s) were not injected. See undertaleAgent.status().input.`);
        }

        return false;
    }

    /**
     * Send a supported game key transition through the real runner input queue.
     *
     * @param {string} key - Supported keyboard key.
     * @param {boolean} down - Whether to hold or release it.
     * @returns {void}
     */
    function setKey(key, down) {
        const normalized = normalizeKey(key);
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
            noteInjections(1);
        } else if (!down && held.has(normalized)) {
            held.delete(normalized);
            state.runtime._onKeyUp(code);
            noteInjections(1);
        }

        if (down && key.length === 1) {
            state.runtime._onCharacter(key.codePointAt(0));
            noteInjections(1);
        } else if (down && key === 'Backspace') {
            state.runtime._onCharacter(8);
            noteInjections(1);
        }
    }

    /**
     * Release held controls when focus changes or an action ends.
     *
     * @returns {void}
     */
    function releaseAll() {
        clearTimeout(watchdog);

        for (const key of held) {
            setKey(key, false);
        }

        held.clear();
    }

    /**
     * Read the runner's live pause flag and keep the cached field in step.
     *
     * Both `look()` and `status()` must answer from the runner's current state,
     * never from a value that a later runner-side change silently outran. The
     * cache only survives for lifecycle phases with no runner to query.
     *
     * @returns {boolean} Whether the runner is currently paused.
     */
    function livePaused() {
        if (state.running && state.runtime) {
            paused = Boolean(state.runtime._agentIsPaused());
        }

        return paused;
    }

    /**
     * Toggle the runner's existing pause control, leaving game state untouched.
     *
     * @param {boolean} value - Desired pause state.
     * @returns {void} Applies the pause state immediately.
     */
    function setPaused(value) {
        if (!state.running) {
            return;
        }

        state.runtime._agentSetPaused(value ? 1 : 0);
        paused = Boolean(state.runtime._agentIsPaused());
        document.querySelector('#pause').textContent = paused ? 'Resume' : 'Pause';
        telemetry.refresh(observe());
    }

    /**
     * Read the runner's own JSON state dump without modifying game variables.
     *
     * @returns {object} Current game state and lifecycle details.
     */
    function observe() {
        if (!state.running) {
            return { running: false, loading: state.loading, error: state.error, logs: state.logs.slice(-15) };
        }

        const pointer = state.runtime._agentSnapshot();

        if (!pointer) {
            return { running: false, error: 'Runner is not ready.' };
        }

        try {
            const snapshot = JSON.parse(state.runtime.UTF8ToString(pointer));

            paused = snapshot.paused;
            noteFrame(snapshot.frame);
            latestSnapshot = { running: true, ...snapshot };

            return latestSnapshot;
        } finally {
            state.runtime._free(pointer);
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

        clearTimeout(watchdog);
        acting = true;
        const resumePause = paused;
        const epoch = actionEpoch;

        try {
            if (resumePause) {
                await setPaused(false);
            }

            const freshKeys = keys.filter((key) => !held.has(normalizeKey(key)));
            const charKeys = keys.filter((key) => key.length === 1 || key === 'Backspace');
            const reservation = freshKeys.length * 3 + charKeys.length + held.size;

            if (reservation > 0 && !await reserveInjections(reservation)) {
                throw new Error('Runner input queue stalled; the action was not injected. Check undertaleAgent.status().input.');
            }

            /*
               Heal runner-side latched keys: release every key being pressed first, so a
               previously dropped key-up cannot leave the runner holding it and swallow
               this press.
             */
            for (const key of freshKeys) {
                state.runtime._onKeyUp(keyCodes[normalizeKey(key)]);
                noteInjections(1);
                inputHealth.healedReleases++;
            }

            for (const key of keys) {
                setKey(key, true);
            }

            await delay(milliseconds);
        } finally {
            releaseAll();

            if (!await waitForDrain()) {
                inputHealth.stalledActions++;

                if (log) {
                    log('Input action release was not confirmed by a runner frame; queued input may still be pending. See undertaleAgent.status().input.');
                }
            }

            if (resumePause && epoch === actionEpoch) {
                await setPaused(true);
            }

            acting = false;
        }

        await delay(40);

        return look();
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

        if (!state.running || acting) {
            throw new Error('Launch the game and wait for the current action before typing.');
        }

        releaseAll();
        acting = true;
        const resumePause = paused;
        const epoch = actionEpoch;

        /**
         * Deliver one character per game step interval.
         *
         * @param {number} index - Current character index.
         * @returns {Promise<void>} Resolves after the remaining text is delivered.
         */
        async function typeNext(index) {
            if (epoch !== actionEpoch) {
                throw new Error('Text input cancelled because controller inputs were released.');
            }

            if (index >= text.length) {
                return;
            }

            if (!await reserveInjections(1)) {
                throw new Error('Runner input queue stalled; typing stopped. Check undertaleAgent.status().input.');
            }

            state.runtime._onCharacter(text.codePointAt(index));
            noteInjections(1);

            await delay(80);

            return typeNext(index + 1);
        }

        try {
            if (resumePause) {
                await setPaused(false);
            }

            await typeNext(0);
        } finally {
            if (resumePause && epoch === actionEpoch) {
                await setPaused(true);
            }

            acting = false;
        }

        return look();
    }

    /**
     * Return a compact observation suited to an agent's decision loop.
     *
     * @returns {object} Current state, dialogue, history cursors, and contextual controls.
     */
    function look() {
        return telemetry.look(observe());
    }

    /**
     * Validate a realtime key request before changing any key.
     *
     * @param {object} params - Key request.
     * @param {boolean} down - Desired key state.
     * @returns {object} Current compact observation.
     */
    function changeKeys(params, down) {
        const keys = params?.keys;

        if (!state.running || acting) {
            throw new Error('Launch the game and wait for the current action.');
        }

        if (!Array.isArray(keys) || keys.length > 16 || keys.some((key) => typeof key !== 'string' || !keyCodes[key.length === 1 ? key.toLowerCase() : key])) {
            throw new Error('keys must be an array of at most 16 supported keys.');
        }

        const freshKeys = keys.filter((key) => down && !held.has(normalizeKey(key)));
        const charKeys = down ? keys.filter((key) => key.length === 1 || key === 'Backspace') : [];
        const releaseKeys = down ? 0 : keys.filter((key) => held.has(normalizeKey(key))).length;
        const reservation = freshKeys.length * 2 + charKeys.length + releaseKeys;

        if (pendingInjections + reservation > MAX_PENDING_INJECTIONS) {
            throw new Error(`${pendingInjections} injected events are still waiting for the runner input queue; retry on the next frame. Check undertaleAgent.status().input.`);
        }

        for (const key of freshKeys) {
            state.runtime._onKeyUp(keyCodes[normalizeKey(key)]);
            noteInjections(1);
            inputHealth.healedReleases++;
        }

        for (const key of keys) {
            setKey(key, down);
        }

        clearTimeout(watchdog);

        if (held.size > 0) {
            watchdog = setTimeout(() => {
                releaseAll();
                setPaused(true);
            }, 2_000);
        }

        return look();
    }

    /**
     * Release real inputs and optionally freeze the game on disconnection.
     *
     * @param {object} [params] - Release options.
     * @returns {Promise<object>} State after release.
     */
    async function releaseAgentKeys(params = {}) {
        actionEpoch += 1;
        releaseAll();
        clearTimeout(watchdog);

        if (params.pause === true) {
            await setPaused(true);
        }

        return look();
    }

    globalThis.undertaleAgent = Object.freeze({
        version: 2,
        keys: Object.keys(keyCodes),
        observe,
        look,
        act,
        type: typeText,
        /**
         * Pause gameplay while an agent decides its next action.
         *
         * @returns {void} Pauses immediately.
         */
        pause: () => setPaused(true),
        /**
         * Return to continuous human gameplay.
         *
         * @returns {void} Resumes immediately.
         */
        resume: () => setPaused(false),
        release: releaseAll,
        releaseAll: releaseAgentKeys,
        /**
         * Hold keys for realtime play, with a two-second safety timeout.
         *
         * @param {object} params - Keys to hold.
         * @returns {object} Current state.
         */
        keysDown: (params) => changeKeys(params, true),
        /**
         * Release selected realtime controls.
         *
         * @param {object} params - Keys to release.
         * @returns {object} Current state.
         */
        keysUp: (params) => changeKeys(params, false),
        /**
         * Read controls expected in the current context.
         *
         * @returns {object} Contextual controls.
         */
        controls: () => look().controls,
        dialogueHistory: telemetry.history,
        events: telemetry.replay,
        save: persistSaves,
        /**
         * Capture the current game canvas as a PNG data URL.
         *
         * @returns {string} Encoded canvas image.
         */
        screenshot: () => canvas.toDataURL('image/png'),
        /**
         * Read lifecycle and input-health details without requesting a game-state dump.
         *
         * @returns {object} Current runtime lifecycle, recent logs, and input pipeline counters.
         */
        status: () => ({ running: state.running, loading: state.loading, paused: livePaused(), error: state.error, source: state.source, logs: state.logs.slice(-15), input: { pendingInjections, ...inputHealth, maxPendingInjections: MAX_PENDING_INJECTIONS } }),
    });
    connectController(globalThis.undertaleAgent, telemetry, log);

    document.querySelector('#pause').addEventListener('click', async () => {
        await setPaused(!livePaused());
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

    return {
        /**
         * Observe every presented frame without advancing the game.
         *
         * @param {object} runtime - Initialized Emscripten runner.
         * @returns {void}
         */
        attachRuntime(runtime) {
            /**
             * Capture rendered text and periodically refresh semantic state.
             *
             * @param {object} frame - Presented game frame.
             * @returns {void}
             */
            runtime.onAgentFrame = (frame) => {
                noteFrame(frame.frame);

                if (frame.frame !== sampledFrame && (frame.frame % 3 === 0 || !latestSnapshot || frame.room.index !== latestSnapshot.room.index)) {
                    observe();
                    sampledFrame = frame.frame;
                }

                telemetry.onFrame(frame, latestSnapshot);
            };
        },
    };
}
