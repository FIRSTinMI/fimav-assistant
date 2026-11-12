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

    it('maps versions to the 5.0 and 5.1 adapters', () => {
        const cases: [string, Generation | null][] = [
            // before 5.0: no adapter, read only
            ['3.0.1', null],
            ['4.0.3', null],
            ['4.3.4', null],
            ['5.0.0', 'trpc-5.0'],
            ['5.0.7', 'trpc-5.0'],
            ['5.1.0', 'trpc-5.1'],
            ['5.1.2', 'trpc-5.1'],
            // newer than 5.1: the 5.1 adapter, confirmed by the probe
            ['5.2.0', 'trpc-5.1'],
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
