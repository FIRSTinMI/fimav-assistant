import { TrpcSession } from './trpc';
import { Generation } from './version';

// Companion 5.0, 5.1 and 5.2 edit over the same tRPC calls with two
// differences: 5.1 replaced controls.resetControl with controls.resetControls
// (a list of locations), which a 5.0 client hits as "mutation does not
// exist", and 5.2 moved controls.watchControl's first value from
// {type:'init', config, runtime} to {type:'init', control:{type, config,
// runtime}}. Each version gets an adapter with the calls and reply shapes it
// has, written from Companion's routers at v5.0.7, v5.1.2 (unchanged in
// v5.1.3) and main at 5.2.0 (ea722db1). The save logic (bitfocus.ts) is
// shared and only sees the operations below.

export interface DownAction {
    id: string;
    definitionId: string;
    connectionId: string;
    // As Companion stores them: {value, isExpression}
    options: Record<string, unknown>;
}

export interface ButtonConfig {
    // 'button-layered' for a normal button
    type: string;
    actions: DownAction[];
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
    // Resolves the new action's id.
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

export interface TrpcShape {
    // Procedures the adapter calls, each with its kind, so a probe can check
    // every one exists before the tab offers editing.
    mutations: string[];
    subscriptions: string[];
    // controls.resetControl (5.0) or controls.resetControls (5.1 on)
    reset: 'one' | 'many';
    // Where controls.watchControl's first value keeps the config: at the top
    // (to 5.1) or under `control` (5.2)
    watchInit: 'flat' | 'nested';
}

const COMMON = [
    'controls.styles.updateOption',
    'controls.entities.add',
    'controls.entities.setOption',
    'controls.entities.remove',
];
const WATCH = ['pages.watch', 'controls.watchControl'];

// In order, oldest first.
export const TRPC_SHAPES: Record<Generation, TrpcShape> = {
    'trpc-5.0': {
        mutations: ['controls.resetControl', ...COMMON],
        subscriptions: WATCH,
        reset: 'one',
        watchInit: 'flat',
    },
    'trpc-5.1': {
        mutations: ['controls.resetControls', ...COMMON],
        subscriptions: WATCH,
        reset: 'many',
        watchInit: 'flat',
    },
    // Same procedures and inputs as 5.1; only the watchControl reply moved.
    'trpc-5.2': {
        mutations: ['controls.resetControls', ...COMMON],
        subscriptions: WATCH,
        reset: 'many',
        watchInit: 'nested',
    },
};

// #region Reply shapes
//
// The probe can only see that a procedure exists, not what it answers, so a
// release that keeps a name but changes its reply would pass it and then
// half-work. Each reply the adapter reads is checked here; anything else is
// an error, never a guess.

const isObject = (v: unknown): v is Record<string, any> =>
    !!v && typeof v === 'object' && !Array.isArray(v);

// pages.watch first value: {type:'init', order: [pageId], pages: {...}}
export function pagesFromWatch(init: unknown): {
    order: string[];
    pages: Record<string, any>;
} | null {
    if (!isObject(init) || init.type !== 'init') return null;
    if (!Array.isArray(init.order) || !isObject(init.pages)) return null;
    return { order: init.order, pages: init.pages };
}

// controls.watchControl first value -> the control's config
export function configFromWatch(shape: TrpcShape, init: unknown): any | null {
    if (!isObject(init) || init.type !== 'init') return null;
    const config =
        shape.watchInit === 'nested' ? init.control?.config : init.config;
    return isObject(config) && typeof config.type === 'string' ? config : null;
}

// A normal button's config: a text layer to write the label to and a down
// action list to edit.
export function layeredButtonOk(config: any): boolean {
    const layers = config?.style?.layers;
    const down = config?.steps?.['0']?.action_sets?.down;
    return (
        Array.isArray(layers) &&
        layers.some(
            (l: any) => l?.type === 'text' && typeof l.id === 'string'
        ) &&
        Array.isArray(down)
    );
}

// Read-only check that this Companion answers in the shapes the adapter
// reads. Returns what did not match; empty means it fits. It looks at the
// pages and at existing controls only, so nothing is created or changed.
export async function replyShapeProblems(
    s: Pick<TrpcSession, 'first'>,
    generation: Generation
): Promise<string[]> {
    const shape = TRPC_SHAPES[generation];
    const pages = pagesFromWatch(await s.first('pages.watch', undefined));
    if (!pages) return ['pages.watch reply'];
    const ids: string[] = pages.order.flatMap((pageId) =>
        Object.values(pages.pages[pageId]?.controls ?? {}).flatMap((row: any) =>
            Object.values(row ?? {}).filter(
                (id): id is string => typeof id === 'string'
            )
        )
    );
    // Every page starts with page up/number/down, so a Companion with no
    // control at all has had them removed; with nothing to read, the reply
    // shape cannot be confirmed.
    if (!ids.length) return ['controls.watchControl reply (no control)'];
    // The first normal button shows the text layer and actions too. A few
    // controls are enough; a large layout is not read in full.
    // eslint-disable-next-line no-restricted-syntax
    for (const controlId of ids.slice(0, 32)) {
        const config = configFromWatch(
            shape,
            // eslint-disable-next-line no-await-in-loop
            await s.first('controls.watchControl', { controlId })
        );
        if (!config) return ['controls.watchControl reply'];
        if (config.type === 'button-layered') {
            return layeredButtonOk(config)
                ? []
                : ['controls.watchControl button config'];
        }
    }
    return [];
}

// #endregion

const DOWN = { stepId: '0', setId: 'down' };

const value = (v: unknown) => ({ isExpression: false, value: v });

function toButtonConfig(config: any): ButtonConfig | null {
    if (!config) return null;
    const down: any[] = config.steps?.['0']?.action_sets?.down ?? [];
    return {
        type: config.type,
        actions: down.map((a) => ({
            id: String(a.id),
            definitionId: a.definitionId,
            connectionId: a.connectionId,
            options: a.options ?? {},
        })),
        textLayerId: (config.style?.layers ?? []).find(
            (l: any) => l?.type === 'text'
        )?.id,
    };
}

function trpcOps(
    s: TrpcSession,
    generation: Generation,
    shape: TrpcShape
): CompanionOps {
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

    return {
        generation,
        async controlIdAt(page, row, column) {
            const pages = pagesFromWatch(
                await s.first('pages.watch', undefined)
            );
            if (!pages)
                throw new Error('Companion: pages.watch reply not understood');
            const pageId = pages.order[page - 1];
            return pages.pages[pageId]?.controls?.[row]?.[column] ?? null;
        },
        async createButton(page, row, column) {
            await reset(page, row, column, 'button-layered');
        },
        async readButton(controlId) {
            const init = await s.first('controls.watchControl', { controlId });
            const config = configFromWatch(shape, init);
            if (!config) {
                throw new Error(
                    'Companion: controls.watchControl reply not understood'
                );
            }
            return toButtonConfig(config);
        },
        async setText(controlId, config, text) {
            if (!config.textLayerId) {
                throw new Error('Button has no text layer');
            }
            await s.mutate('controls.styles.updateOption', {
                controlId,
                elementId: config.textLayerId,
                key: 'text',
                value: value(text),
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
            if (!id) {
                throw new Error(`Companion refused action ${definitionId}`);
            }
            return id;
        },
        async setOption(controlId, actionId, key, v) {
            await s.mutate('controls.entities.setOption', {
                controlId,
                entityLocation: DOWN,
                entityId: actionId,
                key,
                value: value(v),
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
}

export async function openOps(
    baseUrl: string,
    generation: Generation
): Promise<CompanionOps> {
    return trpcOps(
        await TrpcSession.open(baseUrl),
        generation,
        TRPC_SHAPES[generation]
    );
}
