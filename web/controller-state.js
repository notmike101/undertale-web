const WRITERS = new Set(['obj_base_writer', 'obj_writer', 'obj_nomscwriter', 'obj_instawriter', 'obj_flowey_writer', 'obj_finalwriter', 'obj_songwriter']);
const EVENT_LIMIT = 4_096;
const PAGE_LIMIT = 500;

/**
 * Select explicitly allowed game state without exposing queued strings.
 *
 * @param {object} source - Game variables.
 * @param {string[]} names - Allowed names.
 * @returns {object} Selected values.
 */
function select(source, names) {
    return Object.fromEntries(names.filter((name) => source[name] !== undefined).map((name) => [name, source[name]]));
}

/**
 * Identify genuine text writers, excluding numeric damage effects.
 *
 * @param {object} instance - Runtime instance.
 * @returns {boolean} Whether the instance is a text writer.
 */
function isWriter(instance) {
    return WRITERS.has(instance.objectName?.toLowerCase());
}

/**
 * Expose writer progress only, never its future text or queue.
 *
 * @param {object[]} instances - Runtime instances.
 * @returns {object[]} Writer progress and control markers.
 */
function writerStates(instances) {
    return instances.filter(isWriter).map((instance) => {
        const variables = instance.selfVariables ?? {};
        const halt = variables.halt;

        return {
            instanceId: instance.instanceId,
            objectName: instance.objectName,
            visible: instance.visible,
            ...select(variables, ['stringno', 'stringpos', 'halt', 'active', 'at', 'scoord', 'off', 'alpha']),
            waitingForConfirm: [1, 2, 4].includes(halt),
            phase: ({ 0: 'revealing', 1: 'next-page', 2: 'close', 3: 'closing', 4: 'battle-handoff', 5: 'context-dependent', 6: 'script-controlled' })[halt] ?? 'unknown',
        };
    });
}

/**
 * Infer a control context from the documented installed-game conditions.
 *
 * @param {object} snapshot - Sampled runtime state.
 * @param {object[]} writers - Safe writer metadata.
 * @returns {object} Context, observed conditions, and control hints.
 */
function controlState(snapshot, writers) {
    const globals = snapshot.globalVariables ?? {};
    const instances = snapshot.instances ?? [];
    /**
     * Find an instance by its normalized object name.
     *
     * @param {string} name - Lowercase object name.
     * @returns {object | undefined} Matching runtime instance.
     */
    const find = (name) => instances.find((instance) => instance.objectName?.toLowerCase() === name);
    const main = find('obj_mainchara');
    const heart = find('obj_heart');
    const chooser = find('obj_choicer');
    const essay = find('obj_essaystuff');
    const controller = find('obj_battlecontroller');
    const world = find('obj_overworldcontroller');
    const intro = find('obj_intromenu');
    const title = find('obj_titleimage');
    const defeated = find('obj_heartdefeated');
    const target = instances.find((instance) => /targetchoice/i.test(instance.objectName ?? '') && instance.selfVariables?.active !== 0);
    const actions = [];
    let context = 'unknown-or-cutscene';
    let details = {};

    if (intro && [1, 2, 3].includes(intro.selfVariables?.naming)) {
        const naming = intro.selfVariables.naming;

        details = select(intro.selfVariables, ['naming', 'selected_row', 'selected_col', 'selected2', 'selected3', 'charname', 'allow']);

        if (naming === 1) {
            context = 'naming';
            actions.push('Arrows select a letter or bottom-row action', 'Z or Enter selects the highlighted letter or action', 'X or Shift deletes the last letter');
        } else if (naming === 2) {
            context = 'name-confirmation';
            actions.push('Left or Right selects an answer', 'Z or Enter confirms the selected answer');
        } else {
            context = 'title-menu';
            actions.push('Arrows choose a displayed menu option', 'Z or Enter confirms; inspect the selected option before choosing a reset');
        }
    } else if (title) {
        context = 'title-screen';
        actions.push('Z or Enter proceeds');
    } else if (defeated) {
        context = 'game-over';
        details = select(defeated.selfVariables ?? {}, ['dingus', 'heartcon', 'hearttimer']);

        if (writers.some((writer) => writer.waitingForConfirm)) {
            actions.push('Z or Enter advances the waiting text');
        } else if (details.dingus === 1 && writers.length === 0) {
            actions.push('Z or Enter continues from the game-over screen');
        } else {
            actions.push('Wait for the current game-over animation or text');
        }
    } else if (essay?.selfVariables?.keyboard_present && essay.selfVariables.cantype === 1) {
        context = 'text-entry';
        details = select(essay.selfVariables, ['cantype', 'endbuffer']);
        actions.push('type printable characters', 'Backspace edits the entered text');
    } else if (chooser) {
        context = 'choice';
        details = select(chooser.selfVariables ?? {}, ['mychoice', 'canchoose', 'choiced', 'creator']);
        details.confirmReady = details.canchoose === 1 && details.choiced === 0;
        actions.push('Left or Right toggles the choice');

        if (details.confirmReady) {
            actions.push('Z or Enter confirms');
        }
    } else if (globals.inbattle === 1 && globals.myfight === 1 && target) {
        context = 'attack-timing';
        details = { objectName: target.objectName, x: target.x, ...select(target.selfVariables ?? {}, ['hspeed', 'active', 'image_speed']) };
        actions.push('Z or Enter attempts the timing hit; weapon variants have different timing rules');
    } else if (globals.inbattle === 1 && globals.mnfight === 2 && heart) {
        context = 'battle-dodge';
        details = { x: heart.x, y: heart.y, ...select(heart.selfVariables ?? {}, ['movement', 'shot']) };
        actions.push('Arrows control the heart according to its movement mode', 'X or Shift slows standard free movement');

        if (details.shot === 1) {
            actions.push('Z or Enter shoots');
        }
    } else if (globals.inbattle === 1 && globals.myfight === 3 && writers.some((writer) => writer.halt > 0)) {
        context = 'battle-response';
        details = { selection: globals.bmenucoord?.[6] };
        actions.push('Left or Right selects a response', 'Z or Enter confirms');
    } else if (globals.inbattle === 1 && globals.mnfight === 0 && globals.myfight === 0 && controller?.selfVariables?.active === 1) {
        const menu = globals.bmenuno;
        let coordinate = menu;

        if (menu === 10) {
            coordinate = 2;
        } else if ([1, 2, 11].includes(menu)) {
            coordinate = 1;
        } else if (menu >= 3 && menu < 4) {
            coordinate = 3;
        }

        context = 'battle-menu';
        details = { menu, selection: globals.bmenucoord?.[coordinate], rootActions: menu === 0 ? ['FIGHT', 'ACT', 'ITEM', 'MERCY'] : undefined };
        actions.push('Arrows select', 'Z or Enter confirms', 'X or Shift cancels a submenu');
    } else if (globals.interact === 5 || (world && main && (globals.menuno ?? -1) >= 0)) {
        context = 'overworld-menu';
        details = { menu: globals.menuno, selection: globals.menucoord?.[globals.menuno] };
        actions.push('Arrows select', 'Z or Enter confirms', 'X or Shift returns');
    } else if (writers.some((writer) => writer.waitingForConfirm)) {
        context = 'dialogue-wait';
        actions.push('Z or Enter advances or closes the waiting dialogue');
    } else if (writers.some((writer) => writer.halt === 0)) {
        context = 'dialogue-revealing';
        actions.push('Wait for text to reveal');

        if (globals.typer !== 10) {
            actions.push('X or Shift can reveal remaining text when the current dialogue controller allows it');
        }
    } else if (world && main?.selfVariables?.movement === 1 && (globals.interact ?? 0) === 0) {
        context = 'overworld';
        details = { x: main.x, y: main.y, ...select(main.selfVariables, ['facing', 'movement', 'uncan']) };
        actions.push('Arrows move');

        if (main.selfVariables.uncan === 0) {
            actions.push('Z or Enter interacts with an adjacent target');
        }

        if ((globals.flag?.[17] ?? 0) === 0) {
            actions.push('C or Control opens the menu');
        }
    }

    if (actions.length === 0) {
        actions.push('Inspect the screenshot and rendered text for current instructions');
    }

    return {
        context,
        inference: 'Derived from sampled game variables; bespoke scenes can override these controls.',
        details,
        actions,
        observationActions: ['Pause while deciding, then resume before acting', 'act([], 100) waits without pressing keys', 'Inspect a screenshot when sprite text or animation matters'],
        conditions: select(globals, ['inbattle', 'interact', 'mnfight', 'myfight', 'bmenuno', 'menuno']),
        input: { confirm: ['z', 'Enter'], cancel: ['x', 'Shift'], menu: ['c', 'Control'], directions: ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'], repeat: 'Release between presses. Escape can exit the game.' },
    };
}

/**
 * Reconstruct readable rows while keeping draw commands as the source evidence.
 *
 * @param {object[]} draws - Captured text draw calls.
 * @returns {object} Approximate reading order and exact source commands.
 */
function renderedText(draws) {
    const visible = draws.filter((draw) => typeof draw.text === 'string' && draw.text.length > 0 && draw.alpha !== 0);
    const rows = [];
    const seen = new Set();

    for (const draw of visible) {
        const key = JSON.stringify([draw.text, Math.round(draw.x), Math.round(draw.y), draw.surface, draw.gui]);

        if (seen.has(key)) {
            continue;
        }

        seen.add(key);
        let row = rows.find((candidate) => Math.abs(candidate.y - draw.y) <= 4 && candidate.surface === draw.surface && candidate.gui === draw.gui);

        if (!row) {
            row = { y: draw.y, surface: draw.surface, gui: draw.gui, draws: [] };
            rows.push(row);
        }

        row.draws.push(draw);
    }

    rows.sort((left, right) => left.y - right.y);

    const lines = rows.map((row) => {
        row.draws.sort((left, right) => left.x - right.x);
        let text = '';
        let previous;

        for (const draw of row.draws) {
            if (previous && draw.x - previous.x > Math.max(8, previous.text.length * 8 * Math.abs(previous.scaleX ?? 1)) + 7) {
                text += ' ';
            }

            text += draw.text;
            previous = draw;
        }

        return { text, x: row.draws[0].x, y: row.y, surface: row.surface, gui: row.gui };
    });

    return { text: lines.map((line) => line.text).join('\n'), lines, draws: visible };
}

/**
 * Determine whether a rendered revision only extends its earlier rows.
 *
 * @param {string} previous - Previously observed text.
 * @param {string} current - Newly observed text.
 * @returns {boolean} Whether every earlier row remains a prefix.
 */
function extendsText(previous, current) {
    const oldLines = previous.split('\n');
    const newLines = current.split('\n');

    return newLines.length >= oldLines.length && oldLines.every((line, index) => newLines[index].startsWith(line));
}

/**
 * Create a bounded, session-scoped journal of observed game presentation.
 *
 * @returns {object} Observation, history, replay, and subscription methods.
 */
export function createTelemetry() {
    const sessionId = globalThis.crypto.randomUUID();
    const events = [];
    const pages = [];
    const subscribers = new Set();
    let sequence = 0;
    let pageId = 0;
    let latestFrame;
    let latestSnapshot = {};
    let rendered = { text: '', lines: [], draws: [] };
    let currentPage;
    let writerBoundary = '';

    /**
     * Append a journal event and deliver it without letting listeners stop capture.
     *
     * @param {string} type - Event type.
     * @param {object} payload - Safe event content.
     * @returns {number} Event sequence number.
     */
    function emit(type, payload) {
        const event = { sessionId, seq: ++sequence, type, frame: latestFrame?.frame, timestamp: latestFrame?.timestamp, ...payload };

        events.push(event);

        if (events.length > EVENT_LIMIT) {
            events.shift();
        }

        for (const listener of subscribers) {
            try {
                listener(structuredClone(event));
            } catch {
                // An external subscriber must not interrupt the game's frame hook.
            }
        }

        return event.seq;
    }

    /**
     * Return a compact semantic observation without mutating history.
     *
     * @param {object} [snapshot] - Optional fresh runtime state.
     * @returns {object} Current observation with sampling provenance.
     */
    function look(snapshot = latestSnapshot) {
        const sample = snapshot ?? latestSnapshot;
        const globals = sample.globalVariables ?? {};
        const instances = sample.instances ?? [];
        const writers = writerStates(instances);
        const avatar = instances.find((instance) => instance.objectName?.toLowerCase() === 'obj_mainchara');
        const controls = controlState(sample, writers);

        return structuredClone({
            sessionId,
            frame: Math.max(latestFrame?.frame ?? 0, sample.frame ?? 0),
            renderFrame: latestFrame?.frame ?? null,
            snapshotFrame: sample.frame,
            snapshotAgeFrames: latestFrame && Number.isFinite(sample.frame) ? Math.max(0, latestFrame.frame - sample.frame) : null,
            room: (sample.frame ?? -1) >= (latestFrame?.frame ?? -1) ? sample.room : latestFrame?.room,
            paused: sample.paused ?? latestFrame?.paused,
            running: sample.running,
            context: controls.context,
            controls,
            player: { ...select(globals, ['hp', 'maxhp', 'lv', 'gold', 'plot', 'inbattle']), ...(avatar ? select(avatar, ['x', 'y']) : {}) },
            battle: select(globals, ['turn', 'mnfight', 'myfight', 'mytarget', 'monster', 'monsterhp', 'monstermaxhp', 'idealborder']),
            dialogue: {
                present: writers.length > 0,
                writerPresent: writers.length > 0,
                renderedTextPresent: rendered.text.length > 0,
                text: rendered.text,
                lines: rendered.lines,
                writers,
                historyId: currentPage?.id,
                source: 'Captured text draw calls; reading order and association with dialogue are inferred.',
                waitingForConfirm: writers.some((writer) => writer.waitingForConfirm),
                choice: controls.context === 'choice' || controls.context === 'battle-response' ? controls.details : null,
            },
            actors: instances.slice(0, 256).map((instance) => select(instance, ['instanceId', 'objectName', 'x', 'y', 'depth', 'sprite', 'scale', 'angle', 'alpha', 'visible', 'solid', 'speed', 'hspeed', 'vspeed'])),
            actorCount: instances.length,
            actorsTruncated: instances.length > 256,
            capture: {
                droppedDraws: latestFrame?.droppedDraws ?? 0,
                eventCursor: sequence,
                coverage: 'Text draw commands are captured every presented frame. Sprite lettering, occlusion, and offscreen render targets require screenshot interpretation. Queued writer text is excluded.',
            },
        });
    }

    /**
     * Capture every presented frame, including text between state samples.
     *
     * @param {object} frame - Native presentation hook payload.
     * @param {object | null} snapshot - Most recent sampled state, possibly absent.
     * @returns {void}
     */
    function onFrame(frame, snapshot) {
        const priorRoom = latestFrame?.room?.index;
        const newSample = snapshot && snapshot.frame !== latestSnapshot.frame;

        latestFrame = frame;

        if (snapshot) {
            latestSnapshot = snapshot;
        }

        const writers = writerStates(latestSnapshot.instances ?? []);
        const boundary = JSON.stringify(writers.map((writer) => [writer.instanceId, writer.stringno]));
        const nextRendered = renderedText(frame.draws ?? []);
        const changed = rendered.text !== nextRendered.text;
        const pageChanged = priorRoom !== frame.room?.index || boundary !== writerBoundary;

        if (changed || pageChanged) {
            const canExtend = currentPage && !pageChanged && nextRendered.text && extendsText(currentPage.text, nextRendered.text);

            if (currentPage && !canExtend) {
                currentPage.closed = true;
                currentPage.closedFrame = frame.frame;
                currentPage.updatedSeq = emit('text-page-closed', { pageId: currentPage.id });
                currentPage = undefined;
            }

            if (nextRendered.text) {
                if (!currentPage) {
                    currentPage = {
                        id: ++pageId,
                        sessionId,
                        kind: writers.length ? 'rendered-text-with-writer' : 'rendered-text',
                        room: frame.room,
                        firstFrame: frame.frame,
                        closed: false,
                    };
                    pages.push(currentPage);

                    if (pages.length > PAGE_LIMIT) {
                        pages.shift();
                    }
                }

                Object.assign(currentPage, { lastFrame: frame.frame, text: nextRendered.text, lines: nextRendered.lines, writers, droppedDraws: frame.droppedDraws ?? 0 });
                currentPage.updatedSeq = emit(canExtend ? 'text-page-updated' : 'text-page-started', { page: { ...currentPage } });
            }
        }

        rendered = nextRendered;
        writerBoundary = boundary;

        if (frame.droppedDraws) {
            emit('capture-gap', { reason: 'draw-limit', droppedDraws: frame.droppedDraws });
        }

        if (newSample) {
            emit('state', { state: look() });
        }
    }

    /**
     * Read retained rendered-text pages, including the growing current page.
     *
     * @param {object} [options] - History cursor.
     * @param {number} [options.afterId] - Last page seen by the caller.
     * @returns {object} Pages and explicit retention metadata.
     */
    function history({ afterId = 0 } = {}) {
        if (!Number.isSafeInteger(afterId) || afterId < 0) {
            throw new TypeError('afterId must be a nonnegative safe integer.');
        }

        const oldestId = pages[0]?.id ?? pageId + 1;

        return structuredClone({
            sessionId,
            pages: pages.filter((page) => page.id > afterId || (!page.closed && page.id === afterId)),
            oldestId,
            latestId: pageId,
            gap: afterId < oldestId - 1 || afterId > pageId,
            note: 'Pages are observed screen-text revisions, not guaranteed speech boundaries. The current page can grow under the same id; replay events for every observed revision.',
        });
    }

    /**
     * Replay retained journal events after a sequence cursor.
     *
     * @param {number} [afterSeq] - Last event received by the caller.
     * @returns {object} Journal events and cursor gap information.
     */
    function replay(afterSeq = 0) {
        if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) {
            throw new TypeError('afterSeq must be a nonnegative safe integer.');
        }

        const oldestSeq = events[0]?.seq ?? sequence + 1;

        return structuredClone({ sessionId, events: events.filter((event) => event.seq > afterSeq), gap: afterSeq < oldestSeq - 1 || afterSeq > sequence, oldestSeq, latestSeq: sequence });
    }

    /**
     * Subscribe to new journal events.
     *
     * @param {(event: object) => void} callback - Event listener.
     * @returns {() => boolean} Unsubscribe callback.
     */
    function subscribe(callback) {
        subscribers.add(callback);

        return () => subscribers.delete(callback);
    }

    /**
     * Publish lifecycle state when a paused runner presents no new frames.
     *
     * @param {object} snapshot - Fresh state captured by the caller.
     * @returns {void}
     */
    function refresh(snapshot) {
        latestSnapshot = snapshot ?? latestSnapshot;
        emit('state', { state: look() });
    }

    return { onFrame, look, history, replay, subscribe, refresh, sessionId };
}
