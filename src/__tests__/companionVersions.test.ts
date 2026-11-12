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
} from '../main/companion/version';
import {
    missingProcedures,
    pickTrpc,
    ProbeSession,
} from '../main/companion/detect';
import { TRPC_SHAPES } from '../main/companion/adapters';
import { PROBE_INPUT, TrpcSession } from '../main/companion/trpc';
import { parseCompanionExport } from '../main/bitfocus';

jest.mock('../main/store', () => ({ getStore: () => ({ get: () => 8888 }) }));

// A Companion whose tRPC router has exactly these procedures. has() answers
// the way detect.ts reads a real probe: false only for NOT_FOUND.
function fakeProbe(procedures: string[]): ProbeSession & { asked: string[] } {
    const asked: string[] = [];
    return {
        asked,
        async has(kind, path) {
            asked.push(`${kind} ${path}`);
            return procedures.includes(`${kind} ${path}`);
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
        expect(parseVersion('4.2.6+8823-stable-4ecdfe70ba')).toMatchObject({
            major: 4,
            minor: 2,
            patch: 6,
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

    it('maps every released minor to its API generation', () => {
        const cases: [string, Generation | null][] = [
            ['2.4.2', null],
            ['3.0.1', 'sio-3.0'],
            ['3.1.2', 'sio-3.0'],
            ['3.2.0', 'sio-3.2'],
            ['3.2.2', 'sio-3.2'],
            ['3.3.1', 'sio-3.3'],
            ['3.4.4', 'sio-3.3'],
            ['3.5.5', 'sio-3.5'],
            ['4.0.3', 'sio-4.0'],
            ['4.1.0', 'trpc-4.1'],
            ['4.2.6', 'trpc-4.1'],
            ['4.3.4', 'trpc-4.3'],
            ['5.0.0', 'trpc-5.0'],
            ['5.0.7', 'trpc-5.0'],
            ['5.1.2', 'trpc-5.1'],
            // newer than any adapter: the newest, confirmed by the probe
            ['5.4.0', 'trpc-5.1'],
            ['6.0.0', 'trpc-5.1'],
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

    it('with no readable version, takes the newest adapter that fits', async () => {
        const s = fakeProbe(routerOf('trpc-4.1'));
        // 4.1 and 4.3 have the same procedures; newest first wins
        expect((await pickTrpc(s, null)).generation).toBe('trpc-4.3');
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
    it('places 3.0 bank controls on the grid', () => {
        const layout = parseCompanionExport({
            version: 3,
            pages: { '1': { name: 'Show' }, '2': { name: 'PAGE' } },
            controls: {
                'bank:1-1': { type: 'pageup' },
                'bank:1-10': {
                    type: 'button',
                    style: { text: 'Cam 1' },
                    steps: {
                        '0': {
                            action_sets: {
                                down: [
                                    {
                                        id: 'a',
                                        action: 'set_page',
                                        instance: 'internal',
                                        options: { page: 2 },
                                    },
                                ],
                            },
                        },
                    },
                },
                'bank:2-32': { type: 'button', style: { text: 'Last' } },
            },
            instances: {
                x1: { instance_type: 'studiocoast-vmix', label: 'vMix' },
            },
        });
        expect(layout.pages[0]).toMatchObject({ rows: 4, columns: 8 });
        expect(layout.pages[0].buttons['0/0'].type).toBe('pageup');
        expect(layout.pages[0].buttons['1/1']).toEqual({
            type: 'button',
            text: 'Cam 1',
            actions: [
                {
                    id: 'a',
                    definitionId: 'set_page',
                    connectionId: 'internal',
                    options: { page: 2 },
                    hasExpression: false,
                },
            ],
        });
        expect(layout.pages[1].buttons['3/7'].text).toBe('Last');
        expect(layout.connections).toEqual([
            { id: 'x1', module: 'studiocoast-vmix', label: 'vMix' },
        ]);
    });

    it('reads a 5.x layered button as a normal button', () => {
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
            type: 'button',
            text: 'Go',
        });
        expect(layout.connections[0].module).toBe('studiocoast-vmix');
    });
});
