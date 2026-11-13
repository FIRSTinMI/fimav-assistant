import { detectCompanion } from '../main/companion/detect';
import { TRPC_SHAPES } from '../main/companion/adapters';
import { TrpcSession } from '../main/companion/trpc';
import { Generation } from '../main/companion/version';

// tRPC is faked: the router has the procedures given to fakeTrpc.
jest.mock('../main/companion/trpc', () => ({
    TrpcSession: { open: jest.fn() },
}));

const trpcOpen = TrpcSession.open as jest.Mock;

const BUTTON = {
    type: 'button-layered',
    style: { layers: [{ id: 'text0', type: 'text' }] },
    steps: { '0': { action_sets: { down: [] } } },
};

// controls.watchControl's first value: 5.0/5.1 (flat), 5.2 (nested), or a
// shape no adapter knows
const WATCH = {
    flat: { type: 'init', config: BUTTON, runtime: {} },
    nested: {
        type: 'init',
        control: { type: 'button-layered', config: BUTTON, runtime: {} },
    },
    unknown: { type: 'init', state: { config: BUTTON } },
};

const first = jest.fn();

function fakeTrpc(router: string[], watch: keyof typeof WATCH = 'flat') {
    first.mockImplementation(async (path: string) =>
        path === 'pages.watch'
            ? {
                  type: 'init',
                  order: ['p1'],
                  pages: { p1: { controls: { '0': { '0': 'bank:a' } } } },
              }
            : WATCH[watch]
    );
    trpcOpen.mockResolvedValue({
        has: async (kind: string, path: string) =>
            router.includes(`${kind} ${path}`),
        first,
        close: () => {},
    });
}

const routerOf = (g: Generation) => [
    ...TRPC_SHAPES[g].mutations.map((p) => `mutation ${p}`),
    ...TRPC_SHAPES[g].subscriptions.map((p) => `subscription ${p}`),
];

beforeEach(() => {
    trpcOpen.mockReset();
    first.mockReset();
});

describe('detectCompanion', () => {
    it('5.0 gets the 5.0 adapter', async () => {
        fakeTrpc(routerOf('trpc-5.0'));
        const info = await detectCompanion('http://c', {
            companionBuild: '5.0.7+9763-stable-cec2f88e6f',
        });
        expect(info.generation).toBe('trpc-5.0');
    });

    it('5.1 gets the 5.1 adapter', async () => {
        fakeTrpc(routerOf('trpc-5.1'));
        const info = await detectCompanion('http://c', {
            companionBuild: '5.1.2+10019-stable-98d5d4e1a1',
        });
        expect(info.generation).toBe('trpc-5.1');
    });

    it('older than 5.0 is read only and never opens tRPC', async () => {
        // 4.1 to 4.3 exports name their build
        expect(
            await detectCompanion('http://c', {
                companionBuild: '4.3.4+9244-stable-c14e5e3334',
            })
        ).toEqual({
            version: '4.3.4+9244-stable-c14e5e3334',
            generation: null,
            missing: [],
        });
        // 4.0 and older exports carry no build at all
        expect(await detectCompanion('http://c', { version: 7 })).toEqual({
            version: '',
            generation: null,
            missing: [],
        });
        expect(trpcOpen).not.toHaveBeenCalled();
    });

    it('a tested version is not shape-checked', async () => {
        fakeTrpc(routerOf('trpc-5.1'));
        const info = await detectCompanion('http://c', {
            companionBuild: '5.1.3+10036-stable-93ea3fa61c',
        });
        expect(info.generation).toBe('trpc-5.1');
        expect(first).not.toHaveBeenCalled();
    });

    it('5.2 gets the 5.2 adapter once its replies are checked', async () => {
        fakeTrpc(routerOf('trpc-5.2'), 'nested');
        const info = await detectCompanion('http://c', {
            companionBuild: '5.2.0+10262-main-ea722db1e6',
        });
        expect(info.generation).toBe('trpc-5.2');
        expect(first).toHaveBeenCalledWith('controls.watchControl', {
            controlId: 'bank:a',
        });
    });

    it('a newer version with a reply no adapter knows is read only', async () => {
        fakeTrpc(routerOf('trpc-5.2'), 'unknown');
        expect(
            await detectCompanion('http://c', {
                companionBuild: '5.3.0+11000-stable-0',
            })
        ).toEqual({
            version: '5.3.0+11000-stable-0',
            generation: null,
            missing: ['controls.watchControl reply'],
        });
    });

    it('a newer version that renamed a call is read only', async () => {
        fakeTrpc(
            routerOf('trpc-5.2').filter(
                (p) => p !== 'mutation controls.styles.updateOption'
            ),
            'nested'
        );
        expect(
            await detectCompanion('http://c', {
                companionBuild: '5.3.0+11000-stable-0',
            })
        ).toEqual({
            version: '5.3.0+11000-stable-0',
            generation: null,
            missing: ['controls.styles.updateOption'],
        });
    });

    it('no tRPC answer is read only', async () => {
        trpcOpen.mockRejectedValue(new Error('Companion did not answer'));
        expect(
            (
                await detectCompanion('http://c', {
                    companionBuild: '5.1.2+10019-stable-98d5d4e1a1',
                })
            ).generation
        ).toBeNull();
    });
});
