import SocketIoSession from './socketio';
import { TrpcSession } from './trpc';
import { Generation } from './version';

// One adapter per Companion editing API. Each turns the few operations the
// Bitfocus tab needs into that version's calls, written from Companion's
// source at the tags named on each one. The save logic itself (bitfocus.ts)
// is shared and only sees these operations and the normalised shapes below.

export interface DownAction {
    id: string;
    definitionId: string;
    connectionId: string;
    // As Companion stores them: plain values, or {value, isExpression}
    options: Record<string, unknown>;
}

export interface ButtonConfig {
    // 'button' for a normal button, whatever Companion calls it
    type: string;
    actions: DownAction[];
    // Present when the version keeps its text in a layer (5.0 and later)
    textLayerId?: string;
}

export interface CompanionOps {
    generation: Generation;
    controlIdAt(
        _page: number,
        _row: number,
        _column: number
    ): Promise<string | null>;
    createButton(_page: number, _row: number, _column: number): Promise<void>;
    // null when there is no control with this id
    readButton(_controlId: string): Promise<ButtonConfig | null>;
    setText(
        _controlId: string,
        _config: ButtonConfig,
        _text: string
    ): Promise<void>;
    // Resolves the new action's id. Versions whose add call returns no id
    // read the button back and take the one action that was not there.
    addAction(
        _controlId: string,
        _connectionId: string,
        _definitionId: string
    ): Promise<string>;
    setOption(
        _controlId: string,
        _actionId: string,
        _key: string,
        _value: unknown
    ): Promise<void>;
    removeAction(_controlId: string, _actionId: string): Promise<void>;
    clearButton(_page: number, _row: number, _column: number): Promise<void>;
    close(): void;
}

const DOWN = { stepId: '0', setId: 'down' };

// Companion's down actions, from any version's control config: 3.x calls the
// fields action/instance, 4.0 and later definitionId/connectionId.
export function downActions(config: any): DownAction[] {
    const down: any[] = config?.steps?.['0']?.action_sets?.down ?? [];
    return down.map((a) => ({
        id: String(a.id),
        definitionId: a.definitionId ?? a.action,
        connectionId: a.connectionId ?? a.instance,
        options: a.options ?? {},
    }));
}

function toButtonConfig(config: any): ButtonConfig | null {
    if (!config) return null;
    const textLayer = (config.style?.layers ?? []).find(
        (l: any) => l?.type === 'text'
    );
    return {
        type: config.type === 'button-layered' ? 'button' : config.type,
        actions: downActions(config),
        textLayerId: textLayer?.id,
    };
}

async function newActionId(
    ops: CompanionOps,
    controlId: string,
    before: Set<string>,
    definitionId: string
): Promise<string> {
    const after = await ops.readButton(controlId);
    const added = (after?.actions ?? []).filter((a) => !before.has(a.id));
    if (added.length !== 1) {
        throw new Error(`Companion refused action ${definitionId}`);
    }
    return added[0].id;
}

// #region socket.io (3.0 to 4.0)

interface SioShape {
    // 3.0 and 3.1 address a button by "bank:<page>-<bank>" and reset it by
    // that id; 3.2 and later by {pageNumber, row, column}.
    bankIds: boolean;
    // controls:action:add takes an ownerId before the connection (3.5)
    ownerArg: boolean;
    // controls:entity:* replaced controls:action:* (4.0)
    entities: boolean;
}

const SIO_SHAPES: Partial<Record<Generation, SioShape>> = {
    // v3.0.1, v3.1.2
    'sio-3.0': { bankIds: true, ownerArg: false, entities: false },
    // v3.2.2 (spread args), v3.3.1 and v3.4.4 (array args)
    'sio-3.2': { bankIds: false, ownerArg: false, entities: false },
    'sio-3.3': { bankIds: false, ownerArg: false, entities: false },
    // v3.5.5
    'sio-3.5': { bankIds: false, ownerArg: true, entities: false },
    // v4.0.3
    'sio-4.0': { bankIds: false, ownerArg: false, entities: true },
};

export const isSocketIo = (g: Generation) => g.startsWith('sio-');

// 3.0 to 3.2 spread a call's arguments into the event; 3.3 and later send
// them as one array.
export const sioArgsAsArray = (g: Generation) =>
    g !== 'sio-3.0' && g !== 'sio-3.2';

const bankId = (page: number, row: number, column: number) =>
    `bank:${page}-${row * 8 + column + 1}`;

function socketIoOps(
    s: SocketIoSession,
    generation: Generation,
    shape: SioShape
): CompanionOps {
    const location = (page: number, row: number, column: number) =>
        shape.bankIds
            ? bankId(page, row, column)
            : { pageNumber: page, row, column };

    // Subscribing is how the UI reads; leave again so Companion does not
    // keep pushing this control's changes to a client that stops listening.
    const readConfig = async (controlId: string) => {
        const r = await s.call('controls:subscribe', [controlId]);
        await s.call('controls:unsubscribe', [controlId]).catch(() => {});
        return r?.config;
    };

    const ops: CompanionOps = {
        generation,
        async controlIdAt(page, row, column) {
            if (shape.bankIds) {
                const id = bankId(page, row, column);
                return (await readConfig(id)) ? id : null;
            }
            const pages = await s.call('pages:subscribe', []);
            await s.call('pages:unsubscribe', []).catch(() => {});
            // 3.5 and later: {order: [pageId], pages: {[pageId]: page}};
            // before: {[pageNumber]: page}
            const p = pages?.order
                ? pages.pages?.[pages.order[page - 1]]
                : pages?.[page];
            return p?.controls?.[row]?.[column] ?? null;
        },
        async createButton(page, row, column) {
            await s.call('controls:reset', [
                location(page, row, column),
                'button',
            ]);
        },
        async readButton(controlId) {
            return toButtonConfig(await readConfig(controlId));
        },
        async setText(controlId, _config, text) {
            await s.call('controls:set-style-fields', [controlId, { text }]);
        },
        async addAction(controlId, connectionId, definitionId) {
            const before = new Set(
                ((await ops.readButton(controlId))?.actions ?? []).map(
                    (a) => a.id
                )
            );
            let args: unknown[];
            if (shape.entities) {
                args = [
                    controlId,
                    DOWN,
                    null,
                    connectionId,
                    'action',
                    definitionId,
                ];
            } else if (shape.ownerArg) {
                args = [
                    controlId,
                    '0',
                    'down',
                    null,
                    connectionId,
                    definitionId,
                ];
            } else {
                args = [controlId, '0', 'down', connectionId, definitionId];
            }
            const ok = await s.call(
                shape.entities ? 'controls:entity:add' : 'controls:action:add',
                args
            );
            if (ok === false) {
                throw new Error(`Companion refused action ${definitionId}`);
            }
            return newActionId(ops, controlId, before, definitionId);
        },
        async setOption(controlId, actionId, key, value) {
            const ok = shape.entities
                ? await s.call('controls:entity:set-option', [
                      controlId,
                      DOWN,
                      actionId,
                      key,
                      value,
                  ])
                : await s.call('controls:action:set-option', [
                      controlId,
                      '0',
                      'down',
                      actionId,
                      key,
                      value,
                  ]);
            if (ok === false)
                throw new Error(`Companion refused option ${key}`);
        },
        async removeAction(controlId, actionId) {
            await (shape.entities
                ? s.call('controls:entity:remove', [controlId, DOWN, actionId])
                : s.call('controls:action:remove', [
                      controlId,
                      '0',
                      'down',
                      actionId,
                  ]));
        },
        async clearButton(page, row, column) {
            await s.call('controls:reset', [location(page, row, column)]);
        },
        close: () => s.close(),
    };
    return ops;
}

// #endregion

// #region tRPC (4.1 and later)

export interface TrpcShape {
    // Procedures the adapter calls, each with its kind, so a probe can check
    // every one exists before the tab offers editing.
    mutations: string[];
    subscriptions: string[];
    // Control type for a normal button. 4.x ignores 'button-layered' and 5.x
    // ignores 'button' without an error, so this must match the version.
    buttonType: 'button' | 'button-layered';
    // Option values go as {isExpression, value} from 4.3. 4.1 and 4.2 take
    // plain values and would store the wrapper itself as the value.
    wrapOptions: boolean;
    // Button text: controls.setStyleFields (4.x) or the text layer through
    // controls.styles.updateOption (5.0 and later)
    textVia: 'styleFields' | 'textLayer';
    // controls.resetControl (to 5.0) or controls.resetControls (5.1)
    reset: 'one' | 'many';
}

const ENTITIES = [
    'controls.entities.add',
    'controls.entities.setOption',
    'controls.entities.remove',
];
const WATCH = ['pages.watch', 'controls.watchControl'];

// Written from Companion's routers at v4.1.6, v4.2.6, v4.3.4, v5.0.7 and
// v5.1.2; each .0 release matches its last patch for these procedures. In
// order, oldest first.
export const TRPC_SHAPES: Partial<Record<Generation, TrpcShape>> = {
    // 4.1, 4.2
    'trpc-4.1': {
        mutations: [
            'controls.resetControl',
            'controls.setStyleFields',
            ...ENTITIES,
        ],
        subscriptions: WATCH,
        buttonType: 'button',
        wrapOptions: false,
        textVia: 'styleFields',
        reset: 'one',
    },
    // 4.3: same procedures, option values wrapped
    'trpc-4.3': {
        mutations: [
            'controls.resetControl',
            'controls.setStyleFields',
            ...ENTITIES,
        ],
        subscriptions: WATCH,
        buttonType: 'button',
        wrapOptions: true,
        textVia: 'styleFields',
        reset: 'one',
    },
    // 5.0: layered buttons, text in a layer
    'trpc-5.0': {
        mutations: [
            'controls.resetControl',
            'controls.styles.updateOption',
            ...ENTITIES,
        ],
        subscriptions: WATCH,
        buttonType: 'button-layered',
        wrapOptions: true,
        textVia: 'textLayer',
        reset: 'one',
    },
    // 5.1: resetControl became resetControls (a list of locations)
    'trpc-5.1': {
        mutations: [
            'controls.resetControls',
            'controls.styles.updateOption',
            ...ENTITIES,
        ],
        subscriptions: WATCH,
        buttonType: 'button-layered',
        wrapOptions: true,
        textVia: 'textLayer',
        reset: 'many',
    },
};

function trpcOps(
    s: TrpcSession,
    generation: Generation,
    shape: TrpcShape
): CompanionOps {
    const optionValue = (v: unknown) =>
        shape.wrapOptions ? { isExpression: false, value: v } : v;

    // newType null deletes the control and leaves the cell empty.
    const reset = (
        page: number,
        row: number,
        column: number,
        newType: string | null
    ) => {
        const location = { pageNumber: page, row, column };
        return shape.reset === 'many'
            ? s.mutate('controls.resetControls', {
                  locations: [location],
                  newType,
              })
            : s.mutate('controls.resetControl', {
                  location,
                  ...(newType ? { newType } : {}),
              });
    };

    const ops: CompanionOps = {
        generation,
        async controlIdAt(page, row, column) {
            const pages = await s.first('pages.watch', undefined);
            const pageId = pages?.order?.[page - 1];
            return pages?.pages?.[pageId]?.controls?.[row]?.[column] ?? null;
        },
        async createButton(page, row, column) {
            await reset(page, row, column, shape.buttonType);
        },
        async readButton(controlId) {
            const init = await s.first('controls.watchControl', { controlId });
            return toButtonConfig(init?.config);
        },
        async setText(controlId, config, text) {
            if (shape.textVia === 'styleFields') {
                await s.mutate('controls.setStyleFields', {
                    controlId,
                    styleFields: { text },
                });
                return;
            }
            if (!config.textLayerId) {
                throw new Error('Button has no text layer');
            }
            await s.mutate('controls.styles.updateOption', {
                controlId,
                elementId: config.textLayerId,
                key: 'text',
                value: { isExpression: false, value: text },
            });
        },
        async addAction(controlId, connectionId, definitionId) {
            const id = await s.mutate('controls.entities.add', {
                controlId,
                entityLocation: DOWN,
                ownerId: null,
                connectionId,
                entityType: 'action',
                entityDefinition: definitionId,
            });
            if (!id)
                throw new Error(`Companion refused action ${definitionId}`);
            return id;
        },
        async setOption(controlId, actionId, key, value) {
            await s.mutate('controls.entities.setOption', {
                controlId,
                entityLocation: DOWN,
                entityId: actionId,
                key,
                value: optionValue(value),
            });
        },
        async removeAction(controlId, actionId) {
            await s.mutate('controls.entities.remove', {
                controlId,
                entityLocation: DOWN,
                entityId: actionId,
            });
        },
        async clearButton(page, row, column) {
            await reset(page, row, column, null);
        },
        close: () => s.close(),
    };
    return ops;
}

// #endregion

export async function openOps(
    baseUrl: string,
    generation: Generation
): Promise<CompanionOps> {
    const sio = SIO_SHAPES[generation];
    if (sio) {
        const s = await SocketIoSession.open(
            baseUrl,
            sioArgsAsArray(generation)
        );
        return socketIoOps(s, generation, sio);
    }
    const t = TRPC_SHAPES[generation];
    if (!t) throw new Error(`No adapter for ${generation}`);
    return trpcOps(await TrpcSession.open(baseUrl), generation, t);
}
