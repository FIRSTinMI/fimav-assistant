import { detectCompanion } from '../main/companion/detect';
import { TRPC_SHAPES } from '../main/companion/adapters';
import { TrpcSession } from '../main/companion/trpc';
import { Generation } from '../main/companion/version';

// tRPC is faked: the router has the procedures given to fakeTrpc.
jest.mock('../main/companion/trpc', () => ({
    TrpcSession: { open: jest.fn() },
}));

const trpcOpen = TrpcSession.open as jest.Mock;

function fakeTrpc(router: string[]) {
    trpcOpen.mockResolvedValue({
        has: async (kind: string, path: string) =>
            router.includes(`${kind} ${path}`),
        close: () => {},
    });
}

const routerOf = (g: Generation) => [
    ...TRPC_SHAPES[g].mutations.map((p) => `mutation ${p}`),
    ...TRPC_SHAPES[g].subscriptions.map((p) => `subscription ${p}`),
];

beforeEach(() => trpcOpen.mockReset());

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

    it('a newer version with the 5.1 calls gets the 5.1 adapter', async () => {
        fakeTrpc(routerOf('trpc-5.1'));
        const info = await detectCompanion('http://c', {
            companionBuild: '5.2.0+11000-stable-0',
        });
        expect(info.generation).toBe('trpc-5.1');
    });

    it('a newer version that renamed a call is read only', async () => {
        fakeTrpc(
            routerOf('trpc-5.1').filter(
                (p) => p !== 'mutation controls.styles.updateOption'
            )
        );
        expect(
            await detectCompanion('http://c', {
                companionBuild: '5.2.0+11000-stable-0',
            })
        ).toEqual({
            version: '5.2.0+11000-stable-0',
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
