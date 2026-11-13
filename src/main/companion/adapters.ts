import { TrpcSession } from './trpc';
import { Generation } from './version';

// Companion 5.0 and 5.1 edit over the same tRPC calls except one: 5.1
// replaced controls.resetControl with controls.resetControls (a list of
// locations), which a 5.0 client hits as "mutation does not exist". Each
// version gets an adapter with the calls it has, written from Companion's
// routers at v5.0.7 and v5.1.2 (unchanged in v5.1.3). The save logic
// (bitfocus.ts) is shared and only sees the operations below.

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
    // controls.resetControl (5.0) or controls.resetControls (5.1)
    reset: 'one' | 'many';
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
    },
    'trpc-5.1': {
        mutations: ['controls.resetControls', ...COMMON],
        subscriptions: WATCH,
        reset: 'many',
    },
};

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
            const pages = await s.first('pages.watch', undefined);
            const pageId = pages?.order?.[page - 1];
            return pages?.pages?.[pageId]?.controls?.[row]?.[column] ?? null;
        },
        async createButton(page, row, column) {
            await reset(page, row, column, 'button-layered');
        },
        async readButton(controlId) {
            const init = await s.first('controls.watchControl', { controlId });
            return toButtonConfig(init?.config);
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
