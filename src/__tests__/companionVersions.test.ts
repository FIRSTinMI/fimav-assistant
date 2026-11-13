/**
 * @jest-environment node
 */
// node, not jsdom: the tRPC probe test runs a real WebSocket server.
import { WebSocketServer } from 'ws';
import { AddressInfo } from 'net';
import {
    generationFor,
    parseVersion,
    Generation,
    isUntested,
} from '../main/companion/version';
import {
    missingProcedures,
    pickTrpc,
    ProbeSession,
} from '../main/companion/detect';
import {
    CompanionOps,
    configFromWatch,
    pagesFromWatch,
    replyShapeProblems,
    TRPC_SHAPES,
} from '../main/companion/adapters';
import { PROBE_INPUT, TrpcSession } from '../main/companion/trpc';
import { parseCompanionExport, saveButtonWith } from '../main/bitfocus';

jest.mock('../main/store', () => ({ getStore: () => ({ get: () => 8888 }) }));

type Watch = 'flat' | 'nested' | 'unknown';

const BUTTON = {
    type: 'button-layered',
    style: { layers: [{ id: 'text0', type: 'text' }] },
    steps: { '0': { action_sets: { down: [] } } },
};

// controls.watchControl's first value as 5.0/5.1 (flat), 5.2 (nested) or a
// future release (unknown) send it
function watchInit(watch: Watch, config: unknown = BUTTON) {
    if (watch === 'flat') return { type: 'init', config, runtime: {} };
    if (watch === 'nested') {
        return {
            type: 'init',
            control: { type: 'button-layered', config, runtime: {} },
        };
    }
    return { type: 'init', state: { config } };
}

const PAGES = {
    type: 'init',
    order: ['p1'],
    pages: { p1: { controls: { '0': { '0': 'bank:a' } } } },
};

// A Companion whose tRPC router has exactly these procedures. has() answers
// the way detect.ts reads a real probe: false only for NOT_FOUND. first()
// answers subscriptions in the given reply shape.
function fakeProbe(
    procedures: string[],
    watch: Watch = 'flat',
    config: unknown = BUTTON
): ProbeSession & { asked: string[] } {
    const asked: string[] = [];
    return {
        asked,
        async has(kind, path) {
            asked.push(`${kind} ${path}`);
            return procedures.includes(`${kind} ${path}`);
        },
        async first(path) {
            return path === 'pages.watch' ? PAGES : watchInit(watch, config);
        },
        close() {},
    };
}

const routerOf = (g: Generation) => [
    ...TRPC_SHAPES[g]!.mutations.map((p) => `mutation ${p}`),
    ...TRPC_SHAPES[g]!.subscriptions.map((p) => `subscription ${p}`),
];

describe('Companion version parsing', () => {
    it('reads the forms Companion reports', () => {
        expect(parseVersion('5.1.2+10019-stable-98d5d4e1a1')).toMatchObject({
            major: 5,
            minor: 1,
            patch: 2,
        });
        expect(parseVersion('v3.0.1')).toMatchObject({
            major: 3,
            minor: 0,
            patch: 1,
        });
        expect(parseVersion('5.1.0-beta.2')).toMatchObject({
            major: 5,
            minor: 1,
            patch: 0,
        });
        expect(parseVersion('5.2')).toMatchObject({ major: 5, minor: 2 });
        expect(parseVersion('')).toBeNull();
        expect(parseVersion('Companion')).toBeNull();
        expect(parseVersion(undefined)).toBeNull();
        expect(parseVersion(42)).toBeNull();
    });

    it('maps versions to the 5.0, 5.1 and 5.2 adapters', () => {
        const cases: [string, Generation | null][] = [
            // before 5.0: no adapter, read only
            ['3.0.1', null],
            ['4.0.3', null],
            ['4.3.4', null],
            ['5.0.0', 'trpc-5.0'],
            ['5.0.7', 'trpc-5.0'],
            ['5.1.0', 'trpc-5.1'],
            ['5.1.2', 'trpc-5.1'],
            ['5.1.3', 'trpc-5.1'],
            ['5.2.0', 'trpc-5.2'],
            // newer than 5.2: the 5.2 adapter, confirmed by probe and shapes
            ['5.3.0', 'trpc-5.2'],
            ['6.0.0', 'trpc-5.2'],
        ];
        cases.forEach(([v, g]) =>
            expect([v, generationFor(parseVersion(v)!)]).toEqual([v, g])
        );
    });
});

describe('Companion adapter probe', () => {
    it('takes the version’s own adapter when all its procedures exist', async () => {
        const s = fakeProbe(routerOf('trpc-5.0'));
        expect(await pickTrpc(s, 'trpc-5.0')).toEqual({
            generation: 'trpc-5.0',
            missing: [],
        });
    });

    it('names what a 5.0 client misses on 5.1 and moves to the 5.1 adapter', async () => {
        const s = fakeProbe(routerOf('trpc-5.1'));
        expect(await missingProcedures(s, 'trpc-5.0')).toEqual([
            'controls.resetControl',
        ]);
        expect(await pickTrpc(s, 'trpc-5.0')).toEqual({
            generation: 'trpc-5.1',
            missing: ['controls.resetControl'],
        });
    });

    it('leaves an unknown router read only', async () => {
        // A future release that renamed entities.add
        const s = fakeProbe(
            routerOf('trpc-5.1').filter(
                (p) => p !== 'mutation controls.entities.add'
            )
        );
        expect(await pickTrpc(s, 'trpc-5.1')).toEqual({
            generation: null,
            missing: ['controls.entities.add'],
        });
    });

    it('a 4.x router passes neither probe', async () => {
        // 4.x sets text with setStyleFields; there is no styles router
        const s = fakeProbe([
            'mutation controls.resetControl',
            'mutation controls.setStyleFields',
            'mutation controls.entities.add',
            'mutation controls.entities.setOption',
            'mutation controls.entities.remove',
            'subscription pages.watch',
            'subscription controls.watchControl',
        ]);
        expect(await pickTrpc(s, 'trpc-5.0')).toEqual({
            generation: null,
            missing: ['controls.styles.updateOption'],
        });
    });

    it('probes mutations only as mutations', async () => {
        const s = fakeProbe(routerOf('trpc-5.1'));
        await missingProcedures(s, 'trpc-5.1');
        expect(s.asked).toContain('mutation controls.resetControls');
        expect(s.asked).toContain('subscription controls.watchControl');
        expect(s.asked.filter((a) => a.startsWith('query'))).toEqual([]);
    });
});

describe('tRPC probe call', () => {
    // A tRPC endpoint that knows one mutation and records every input.
    let wss: WebSocketServer;
    let url: string;
    const inputs: unknown[] = [];

    beforeAll(async () => {
        wss = new WebSocketServer({ port: 0, path: '/trpc' });
        await new Promise((resolve) => {
            wss.once('listening', resolve);
        });
        url = `http://127.0.0.1:${(wss.address() as AddressInfo).port}`;
        wss.on('connection', (ws) =>
            ws.on('message', (raw) => {
                const m = JSON.parse(String(raw));
                if (m.method === 'subscription.stop') return;
                inputs.push(m.params.input);
                const known =
                    m.method === 'mutation' &&
                    m.params.path === 'controls.entities.add';
                ws.send(
                    JSON.stringify({
                        id: m.id,
                        error: known
                            ? {
                                  message:
                                      'Invalid or malformed input provided',
                                  code: -32603,
                                  data: { code: 'INTERNAL_SERVER_ERROR' },
                              }
                            : {
                                  message: `No "${m.method}"-procedure on path "${m.params.path}"`,
                                  code: -32004,
                                  data: { code: 'NOT_FOUND' },
                              },
                    })
                );
            })
        );
    });

    afterAll(() => wss.close());

    it('treats NOT_FOUND as missing and a rejected input as present', async () => {
        const s = await TrpcSession.open(url);
        try {
            expect(await s.has('mutation', 'controls.entities.add')).toBe(true);
            expect(await s.has('mutation', 'controls.resetControl')).toBe(
                false
            );
            // the same path as the wrong kind is missing too
            expect(await s.has('query', 'controls.entities.add')).toBe(false);
        } finally {
            s.close();
        }
        // Every probe carried the input no Companion schema accepts.
        expect(inputs.every((i) => i === PROBE_INPUT)).toBe(true);
    });
});

describe('Companion export', () => {
    it('reads a 5.x layered button', () => {
        const layout = parseCompanionExport({
            pages: {
                '1': {
                    name: 'P',
                    gridSize: {
                        minRow: 0,
                        maxRow: 3,
                        minColumn: 0,
                        maxColumn: 7,
                    },
                    controls: {
                        '0': {
                            '2': {
                                type: 'button-layered',
                                style: {
                                    layers: [
                                        {
                                            id: 'text0',
                                            type: 'text',
                                            text: {
                                                isExpression: false,
                                                value: 'Go',
                                            },
                                        },
                                    ],
                                },
                            },
                        },
                    },
                },
            },
            instances: { v: { moduleId: 'studiocoast-vmix', label: 'vMix' } },
        });
        expect(layout.pages[0].buttons['0/2']).toMatchObject({
            type: 'button-layered',
            text: 'Go',
        });
        expect(layout.connections[0].module).toBe('studiocoast-vmix');
    });
});

describe('untested versions', () => {
    test.each([
        ['5.0.7', false],
        ['5.1.2', false],
        ['5.1.2+10019-stable-98d5d4e1a1', false],
        ['5.1.3', false],
        ['5.1.3+10036-stable-93ea3fa61c', false],
        ['5.1.4', true],
        ['5.2.0', true],
        ['5.2.0-beta.1', true],
        ['6.0.0', true],
    ])('%s untested=%s', (raw, untested) => {
        const v = parseVersion(raw);
        expect(v).not.toBeNull();
        expect(isUntested(v!)).toBe(untested);
    });
});

describe('reply shapes', () => {
    it('reads each version’s watchControl first value', () => {
        expect(
            configFromWatch(TRPC_SHAPES['trpc-5.1'], watchInit('flat'))
        ).toEqual(BUTTON);
        expect(
            configFromWatch(TRPC_SHAPES['trpc-5.2'], watchInit('nested'))
        ).toEqual(BUTTON);
        // each adapter refuses the other's shape and anything new
        expect(
            configFromWatch(TRPC_SHAPES['trpc-5.1'], watchInit('nested'))
        ).toBeNull();
        expect(
            configFromWatch(TRPC_SHAPES['trpc-5.2'], watchInit('flat'))
        ).toBeNull();
        expect(
            configFromWatch(TRPC_SHAPES['trpc-5.2'], watchInit('unknown'))
        ).toBeNull();
        expect(pagesFromWatch(PAGES)).not.toBeNull();
        expect(pagesFromWatch({ type: 'init', pages: [] })).toBeNull();
    });

    it('passes the shapes the adapter knows', async () => {
        const router = routerOf('trpc-5.2');
        expect(
            await replyShapeProblems(fakeProbe(router, 'nested'), 'trpc-5.2')
        ).toEqual([]);
        expect(
            await replyShapeProblems(fakeProbe(router, 'flat'), 'trpc-5.1')
        ).toEqual([]);
    });

    it('names a reply the adapter does not know', async () => {
        const router = routerOf('trpc-5.2');
        expect(
            await replyShapeProblems(fakeProbe(router, 'unknown'), 'trpc-5.2')
        ).toEqual(['controls.watchControl reply']);
        // a normal button without a text layer
        expect(
            await replyShapeProblems(
                fakeProbe(router, 'nested', { ...BUTTON, style: {} }),
                'trpc-5.2'
            )
        ).toEqual(['controls.watchControl button config']);
        // pages in a new shape
        const s = fakeProbe(router, 'nested');
        s.first = async () => ({ type: 'init', pageList: [] });
        expect(await replyShapeProblems(s, 'trpc-5.2')).toEqual([
            'pages.watch reply',
        ]);
    });

    it('a 5.2 with an unknown reply is read only', async () => {
        const s = fakeProbe(routerOf('trpc-5.2'), 'unknown');
        expect(await pickTrpc(s, 'trpc-5.2', true)).toEqual({
            generation: null,
            missing: ['controls.watchControl reply'],
        });
    });

    it('tells 5.1 and 5.2 apart by reply, as they share every name', async () => {
        // 5.0 version on a router with 5.1's names: falls back past 5.2,
        // whose shape does not fit, to 5.1
        expect(
            (
                await pickTrpc(
                    fakeProbe(routerOf('trpc-5.1'), 'flat'),
                    'trpc-5.0'
                )
            ).generation
        ).toBe('trpc-5.1');
        expect(
            (
                await pickTrpc(
                    fakeProbe(routerOf('trpc-5.1'), 'nested'),
                    'trpc-5.0'
                )
            ).generation
        ).toBe('trpc-5.2');
    });
});

describe('saving a new button', () => {
    // A Companion where the cell is empty, creating works, and reading the
    // new button back fails the way a changed reply would.
    function fakeOps(): CompanionOps & { cells: Set<string> } {
        const cells = new Set<string>();
        const at = (p: number, r: number, c: number) => `${p}/${r}/${c}`;
        return {
            cells,
            generation: 'trpc-5.2',
            async controlIdAt(p, r, c) {
                return cells.has(at(p, r, c)) ? `bank:${at(p, r, c)}` : null;
            },
            async createButton(p, r, c) {
                cells.add(at(p, r, c));
            },
            async readButton() {
                throw new Error(
                    'Companion: controls.watchControl reply not understood'
                );
            },
            setText: async () => undefined,
            async addAction() {
                return 'a1';
            },
            setOption: async () => undefined,
            removeAction: async () => undefined,
            async clearButton(p, r, c) {
                cells.delete(at(p, r, c));
            },
            close() {},
        };
    }

    it('removes the button it made when the rest of the save fails', async () => {
        const ops = fakeOps();
        await expect(
            saveButtonWith(ops, {
                page: 1,
                row: 0,
                column: 3,
                text: 'X',
                actions: [],
            })
        ).rejects.toThrow('controls.watchControl reply not understood');
        expect(ops.cells.size).toBe(0);
    });
});
