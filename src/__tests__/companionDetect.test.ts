import { detectCompanion } from '../main/companion/detect';
import { TRPC_SHAPES } from '../main/companion/adapters';
import SocketIoSession from '../main/companion/socketio';
import { TrpcSession } from '../main/companion/trpc';

// Both transports are faked: socket.io answers app-version-info, tRPC has the
// procedures in `router`.
jest.mock('../main/companion/socketio', () => ({
    __esModule: true,
    default: { open: jest.fn() },
}));
jest.mock('../main/companion/trpc', () => ({
    TrpcSession: { open: jest.fn() },
}));

const sioOpen = SocketIoSession.open as jest.Mock;
const trpcOpen = TrpcSession.open as jest.Mock;

function fakeTrpc(router: string[]) {
    trpcOpen.mockResolvedValue({
        has: async (kind: string, path: string) =>
            router.includes(`${kind} ${path}`),
        close: () => {},
    });
}

const routerOf = (g: keyof typeof TRPC_SHAPES) => [
    ...TRPC_SHAPES[g]!.mutations.map((p) => `mutation ${p}`),
    ...TRPC_SHAPES[g]!.subscriptions.map((p) => `subscription ${p}`),
];

beforeEach(() => {
    sioOpen.mockReset();
    trpcOpen.mockReset();
});

describe('detectCompanion', () => {
    it('reads 3.x/4.0 over socket.io and never opens tRPC', async () => {
        const call = jest.fn().mockResolvedValue({
            appVersion: '3.4.4',
            appBuild: '3.4.4+7361-stable-03160d5b',
        });
        sioOpen.mockResolvedValue({ call, close: () => {} });
        const info = await detectCompanion('http://c', { version: 4 });
        expect(info).toEqual({
            version: '3.4.4',
            generation: 'sio-3.3',
            missing: [],
        });
        // the version is read with the array argument form
        expect(sioOpen).toHaveBeenCalledWith('http://c', true);
        expect(call).toHaveBeenCalledWith('app-version-info', []);
        expect(trpcOpen).not.toHaveBeenCalled();
    });

    it('takes the version from a 4.1+ export and confirms it by probe', async () => {
        fakeTrpc(routerOf('trpc-5.1'));
        const info = await detectCompanion('http://c', {
            companionBuild: '5.1.2+10019-stable-98d5d4e1a1',
        });
        expect(info.generation).toBe('trpc-5.1');
        expect(sioOpen).not.toHaveBeenCalled();
    });

    it('a newer version whose router still fits gets the newest adapter', async () => {
        fakeTrpc(routerOf('trpc-5.1'));
        const info = await detectCompanion('http://c', {
            companionBuild: '5.3.0+11000-stable-0',
        });
        expect(info).toMatchObject({ version: '5.3.0+11000-stable-0' });
        expect(info.generation).toBe('trpc-5.1');
    });

    it('a newer version that renamed a call is read only', async () => {
        fakeTrpc(
            routerOf('trpc-5.1').filter(
                (p) => p !== 'mutation controls.styles.updateOption'
            )
        );
        const info = await detectCompanion('http://c', {
            companionBuild: '6.0.0+12000-stable-0',
        });
        expect(info).toEqual({
            version: '6.0.0+12000-stable-0',
            generation: null,
            missing: ['controls.styles.updateOption'],
        });
    });

    it('no version and no tRPC: read only', async () => {
        sioOpen.mockRejectedValue(new Error('Companion did not answer'));
        trpcOpen.mockRejectedValue(new Error('Companion did not answer'));
        expect(await detectCompanion('http://c', {})).toEqual({
            version: '',
            generation: null,
            missing: [],
        });
    });

    it('a version older than 3.0 is read only', async () => {
        sioOpen.mockResolvedValue({
            call: async () => ({ appVersion: '2.4.2' }),
            close: () => {},
        });
        trpcOpen.mockRejectedValue(new Error('Companion did not answer'));
        expect((await detectCompanion('http://c', {})).generation).toBeNull();
    });
});
