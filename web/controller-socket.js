/**
 * Send one protocol message with a bounded network backlog.
 *
 * @param {WebSocket} connection - Connection that owns the message.
 * @param {object} message - Protocol envelope.
 * @returns {void}
 */
function send(connection, message) {
    if (connection.readyState !== WebSocket.OPEN) {
        return;
    }

    if (connection.bufferedAmount > 4 * 1_024 * 1_024) {
        connection.close(4_013, 'Reconnect and replay');

        return;
    }

    connection.send(JSON.stringify(message));
}

/**
 * Display connection health without exposing private connection details.
 *
 * @param {string} status - Human-readable connection state.
 * @returns {void}
 */
function showStatus(status) {
    const element = document.querySelector('#controller-status');

    if (element) {
        element.textContent = `AI controller: ${status}`;
    }
}

/**
 * Connect the authenticated local broker to the browser's real-input controller.
 *
 * @param {object} agent - Public agent actions and observations.
 * @param {object} telemetry - Sequenced event subscription and replay interface.
 * @returns {() => void} Stop reconnecting and close the bridge.
 */
export function connectController(agent, telemetry) {
    const methods = new Set(['look', 'observe', 'screenshot', 'save', 'act', 'type', 'pause', 'resume', 'keysDown', 'keysUp', 'releaseAll', 'controls', 'dialogueHistory', 'status']);
    let socket;
    let timer;
    let attempts = 0;
    let stopped = false;
    let ready = false;

    /**
     * Dispatch only the controller's public methods, preserving request identity.
     *
     * @param {WebSocket} connection - Connection that received the request.
     * @param {object} message - Validated request envelope.
     * @returns {Promise<void>} Resolves after its response is sent or disconnected.
     */
    async function request(connection, message) {
        const { id, method, params = {} } = message;

        try {
            if (!methods.has(method) || typeof agent[method] !== 'function') {
                throw new Error('Unsupported controller method.');
            }

            if (!params || typeof params !== 'object' || Array.isArray(params)) {
                throw new Error('Request params must be an object.');
            }

            let result;

            if (method === 'act') {
                result = await agent.act(params.keys, params.milliseconds);
            } else if (method === 'type') {
                result = await agent.type(params.text);
            } else {
                result = await agent[method](params);
            }

            send(connection, { type: 'response', id, ok: true, result: result ?? null });
        } catch (error) {
            send(connection, { type: 'response', id, ok: false, error: error instanceof Error ? error.message : 'Controller command failed.' });
        }
    }

    /**
     * Retry connection setup with capped exponential delay and eight attempts.
     *
     * @returns {void}
     */
    function reconnect() {
        if (stopped || attempts >= 8) {
            showStatus(stopped ? 'disconnected' : 'unavailable');

            return;
        }

        timer = setTimeout(open, Math.min(500 * 2 ** attempts, 10_000));
        attempts += 1;
    }

    /**
     * Fetch fresh credentials and install handlers on a single connection.
     *
     * @returns {Promise<void>} Resolves when connection setup is dispatched.
     */
    async function open() {
        try {
            showStatus('connecting');
            const response = await fetch('./api/controller', { cache: 'no-store' });

            if (response.status === 404 || stopped) {
                showStatus(stopped ? 'disconnected' : 'unavailable');

                return;
            }

            if (!response.ok) {
                throw new Error('Controller configuration unavailable.');
            }

            const config = await response.json();
            const url = new URL('/bridge', config.url);

            if (config.protocol !== 1 || typeof config.token !== 'string' || !['ws:', 'wss:'].includes(url.protocol)
                || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
                throw new Error('Invalid local controller configuration.');
            }

            if (stopped) {
                return;
            }

            url.searchParams.set('token', config.token);
            const connection = new WebSocket(url);

            socket = connection;
            connection.addEventListener('message', (event) => {
                try {
                    const message = JSON.parse(event.data);

                    if (message.type === 'hello') {
                        const available = telemetry.replay(0);
                        const replay = message.sessionId === available.sessionId ? telemetry.replay(message.latestSeq ?? 0) : available;

                        attempts = 0;
                        ready = true;
                        showStatus('connected');

                        for (const item of replay.events) {
                            send(connection, { type: 'event', event: item });
                        }
                    } else if (message.type === 'request' && typeof message.id === 'string' && message.id.length <= 128) {
                        request(connection, message);
                    }
                } catch {
                    connection.close(4_008, 'Invalid bridge message');
                }
            });
            connection.addEventListener('close', () => {
                ready = false;
                showStatus('disconnected');
                Promise.resolve().then(() => agent.releaseAll({ pause: true })).catch(() => undefined);
                reconnect();
            });
            connection.addEventListener('error', () => connection.close());
        } catch {
            showStatus('disconnected');
            reconnect();
        }
    }

    const unsubscribe = telemetry.subscribe((event) => {
        if (ready && socket) {
            send(socket, { type: 'event', event });
        }
    });

    open();

    return () => {
        stopped = true;
        ready = false;
        showStatus('disconnected');
        clearTimeout(timer);
        unsubscribe();
        socket?.close();
    };
}
