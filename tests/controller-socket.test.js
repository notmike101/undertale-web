import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as yieldTurn } from 'node:timers/promises';

import { connectController } from '../web/controller-socket.js';

test('controller bridge replays events, correlates commands, and releases controls on disconnect', async () => {
    const originals = { document: globalThis.document, fetch: globalThis.fetch, WebSocket: globalThis.WebSocket };
    const status = {};
    const actions = [];
    const replayCursors = [];
    const releases = [];
    const history = [
        { sessionId: 'socket-check', seq: 1, type: 'state' },
        { sessionId: 'socket-check', seq: 2, type: 'dialogue' },
    ];
    let connection;
    let listener;
    let unsubscribed = false;
    let stop;

    /**
     * Record cleanup of the event subscription.
     *
     * @returns {void}
     */
    function unsubscribe() {
        unsubscribed = true;
    }

    /** Stub the browser socket without opening a network connection. */
    class FakeWebSocket extends EventTarget {
        static OPEN = 1;

        readyState = 1;
        bufferedAmount = 0;
        sent = [];
        closedWith = undefined;

        /**
         * Capture the local connection target without logging credentials.
         *
         * @param {URL} url - Broker URL.
         */
        constructor(url) {
            super();
            assert.equal(url.pathname, '/bridge');
            assert.equal(url.hostname, '127.0.0.1');
            connection = this;
        }

        /**
         * Record a serialized protocol message.
         *
         * @param {string} value - Serialized message.
         * @returns {void}
         */
        send(value) {
            this.sent.push(JSON.parse(value));
        }

        /**
         * Enforce browser close-code rules and notify the disconnect handler.
         *
         * @param {number} [code] - Application close code.
         * @returns {void}
         */
        close(code = 1_000) {
            assert.ok(code === 1_000 || (code >= 3_000 && code <= 4_999));

            if (this.readyState === 3) {
                return;
            }

            this.closedWith = code;
            this.readyState = 3;
            this.dispatchEvent(new Event('close'));
        }
    }

    try {
        globalThis.document = {
            /**
             * Return the status element stub.
             *
             * @returns {object} Mutable status element.
             */
            querySelector: () => status,
        };
        /**
         * Supply synthetic local configuration without network access.
         *
         * @returns {Promise<object>} Successful configuration response.
         */
        globalThis.fetch = () => Promise.resolve({
            ok: true,
            status: 200,
            /**
             * Decode the synthetic configuration response.
             *
             * @returns {Promise<object>} Local broker settings.
             */
            json: () => Promise.resolve({ url: 'ws://127.0.0.1:8767', token: 'synthetic-test-token', protocol: 1 }),
        });
        globalThis.WebSocket = FakeWebSocket;

        const agent = {
            /**
             * Capture positional action arguments.
             *
             * @param {string[]} keys - Pressed keys.
             * @param {number} milliseconds - Hold duration.
             * @returns {Promise<object>} Synthetic action result.
             */
            act: (keys, milliseconds) => {
                actions.push({ keys, milliseconds });

                return Promise.resolve({ done: true });
            },
            /**
             * Capture the positional text argument.
             *
             * @param {string} text - Typed text.
             * @returns {Promise<object>} Synthetic typing result.
             */
            type: (text) => {
                actions.push({ text });

                return Promise.resolve({ typed: text.length });
            },
            /**
             * Record the release and pause policy.
             *
             * @param {object} params - Release options.
             * @returns {number} Recorded release count.
             */
            releaseAll: (params) => releases.push(params),
        };
        const telemetry = {
            /**
             * Return only events after the requested cursor.
             *
             * @param {number} cursor - Last acknowledged sequence.
             * @returns {object} Replay envelope.
             */
            replay: (cursor) => {
                replayCursors.push(cursor);

                return { sessionId: 'socket-check', events: history.filter((event) => event.seq > cursor) };
            },
            /**
             * Attach the bridge's live event listener.
             *
             * @param {(event: object) => void} callback - Live event consumer.
             * @returns {() => void} Subscription cleanup.
             */
            subscribe: (callback) => {
                listener = callback;

                return unsubscribe;
            },
        };

        stop = connectController(agent, telemetry);
        await yieldTurn();
        connection.dispatchEvent(new MessageEvent('message', {
            data: JSON.stringify({ type: 'hello', sessionId: 'socket-check', latestSeq: 1 }),
        }));
        assert.deepEqual(replayCursors, [0, 1]);
        assert.equal(status.textContent, 'AI controller: connected');
        assert.deepEqual(connection.sent, [{ type: 'event', event: history[1] }]);

        for (const message of [
            { type: 'request', id: 'action', method: 'act', params: { keys: ['z'], milliseconds: 50 } },
            { type: 'request', id: 'typing', method: 'type', params: { text: 'Hello!' } },
            { type: 'request', id: 'unsupported', method: 'configure', params: {} },
        ]) {
            connection.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(message) }));
        }

        await yieldTurn();
        assert.deepEqual(actions, [{ keys: ['z'], milliseconds: 50 }, { text: 'Hello!' }]);
        assert.ok(connection.sent.some((message) => message.id === 'action' && message.ok && message.result.done));
        assert.ok(connection.sent.some((message) => message.id === 'typing' && message.ok && message.result.typed === 6));
        assert.ok(connection.sent.some((message) => message.id === 'unsupported' && !message.ok && message.error));

        const live = { sessionId: 'socket-check', seq: 3, type: 'state' };

        listener(live);
        assert.deepEqual(connection.sent.at(-1), { type: 'event', event: live });
        connection.bufferedAmount = 5 * 1_024 * 1_024;
        listener({ sessionId: 'socket-check', seq: 4, type: 'state' });
        await yieldTurn();
        assert.equal(connection.closedWith, 4_013);
        assert.deepEqual(releases, [{ pause: true }]);
        assert.equal(status.textContent, 'AI controller: disconnected');
        stop();
        assert.equal(unsubscribed, true);
    } finally {
        stop?.();
        Object.assign(globalThis, originals);
    }
});
