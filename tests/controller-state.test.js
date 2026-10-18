import assert from 'node:assert/strict';
import { createTelemetry } from '../web/controller-state.js';

/**
 * Construct a synthetic frame containing only rendered text.
 *
 * @param {number} frame - Presented frame number.
 * @param {string} text - Text actually drawn in this fixture.
 * @returns {object} Presentation payload.
 */
function presented(frame, text) {
    return { frame, room: { index: 1, name: 'fixture' }, timestamp: frame, paused: false, droppedDraws: 0, draws: text ? [{ text, x: 10, y: 10, alpha: 1, scaleX: 1, surface: -1, gui: false }] : [] };
}

/**
 * Construct a sampled game state.
 *
 * @param {number} frame - Sampled frame number.
 * @param {object} [globals] - Game globals.
 * @param {object[]} [instances] - Active instances.
 * @returns {object} Snapshot fixture.
 */
function sampled(frame, globals = {}, instances = []) {
    return { frame, room: { index: 1, name: 'fixture' }, paused: false, globalVariables: globals, instances };
}

/**
 * Construct a runtime instance with named self variables.
 *
 * @param {string} objectName - Runtime object name.
 * @param {object} [selfVariables] - Self variables.
 * @returns {object} Instance fixture.
 */
function instance(objectName, selfVariables = {}) {
    return { instanceId: 100_001, objectName, x: 32, y: 64, visible: true, selfVariables };
}

const telemetry = createTelemetry();
const writer = instance('OBJ_WRITER', { originalstring: 'future secret', mystring: ['queued secret'], stringpos: 1, stringno: 0, halt: 0 });

telemetry.onFrame(presented(0, 'A'), sampled(0, { msg: ['future global secret'] }, [writer]));
telemetry.onFrame(presented(1, 'AB'), null);
telemetry.onFrame(presented(2, 'ABC'), null);
assert.equal(telemetry.look().dialogue.text, 'ABC');
assert.equal(telemetry.look().snapshotAgeFrames, 2);
assert.equal(telemetry.history().pages.length, 1);
assert.equal(telemetry.history({ afterId: 1 }).pages[0].text, 'ABC');
assert.ok(!JSON.stringify([telemetry.look(), telemetry.history(), telemetry.replay()]).includes('secret'));
telemetry.onFrame(presented(3, ''), sampled(3));
assert.equal(telemetry.history().pages[0].text, 'ABC');
assert.equal(telemetry.history().pages[0].closed, true);
telemetry.onFrame(presented(4, 'custom room caption'), null);
assert.equal(telemetry.history().pages.at(-1).kind, 'rendered-text');
assert.equal(telemetry.look().dialogue.writerPresent, false);
assert.equal(telemetry.look().dialogue.renderedTextPresent, true);
assert.ok(telemetry.replay().events.some((event) => event.type === 'text-page-updated' && event.frame === 2));

const battle = sampled(6, { inbattle: 1, mnfight: 0, myfight: 0, bmenuno: 0, bmenucoord: [2] }, [writer, instance('obj_battlecontroller', { active: 1 })]);

assert.equal(telemetry.look(battle).context, 'battle-menu');
assert.equal(telemetry.look(battle).controls.details.selection, 2);
assert.equal(telemetry.look(sampled(7, { inbattle: 1, mnfight: 2 }, [writer, instance('obj_heart', { movement: 1 })])).context, 'battle-dodge');
assert.equal(telemetry.look(sampled(8, {}, [writer, instance('obj_choicer', { mychoice: 0, canchoose: 1, choiced: 0 })])).context, 'choice');
assert.equal(telemetry.look(sampled(9, {}, [writer, instance('obj_essaystuff', { keyboard_present: 1, cantype: 1 })])).context, 'text-entry');
assert.equal(telemetry.look(sampled(10, {}, [instance('OBJ_WRITER', { halt: 2 })])).context, 'dialogue-wait');

const received = [];
const unsubscribe = telemetry.subscribe((event) => received.push(event));

telemetry.refresh({ ...sampled(10), paused: true });
assert.equal(received.at(-1).type, 'state');
assert.equal(received.at(-1).state.paused, true);
assert.equal(received.at(-1).state.frame, 10);
assert.equal(received.at(-1).state.renderFrame, 4);
unsubscribe();
telemetry.refresh(sampled(11));
assert.equal(received.length, 1);

const bounded = createTelemetry();

for (let frame = 0; frame < 1_500; frame++) {
    bounded.onFrame(presented(frame, `page ${frame}!`), sampled(frame));
}

assert.equal(bounded.history().pages.length, 500);
assert.equal(bounded.history().gap, true);
assert.equal(bounded.replay().events.length, 4_096);
assert.equal(bounded.replay().gap, true);
assert.equal(bounded.replay(bounded.replay().latestSeq).events.length, 0);
assert.equal(bounded.replay(999_999).gap, true);
assert.equal(bounded.history({ afterId: 999_999 }).gap, true);
assert.throws(() => bounded.replay(-1), TypeError);
assert.throws(() => bounded.history({ afterId: 0.5 }), TypeError);
console.info('Controller telemetry assertions passed.');
