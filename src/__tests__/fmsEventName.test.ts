import AutoAV from '../main/addons/autoav';
import FmsApi from '../services/FmsApi';

const mockStore = new Map<string, unknown>();

jest.mock('electron-log', () => {
    const fn = { log: jest.fn(), info: jest.fn(), error: jest.fn() };
    return { ...fn, warn: jest.fn(), scope: () => fn };
});
jest.mock('../main/store', () => ({
    getStore: () => ({
        get: (k: string, d?: unknown) => (mockStore.has(k) ? mockStore.get(k) : d),
        set: (k: string, v: unknown) => mockStore.set(k, v),
    }),
}));
jest.mock('../main/window_components/signalR', () => ({
    invokeLog: jest.fn(),
    invokeExpectResponse: jest.fn(),
}));
jest.mock('../main/util', () => ({
    getCurrentEvent: jest.fn(),
    signalrToElectronLog: jest.fn(),
}));
jest.mock('../main/cutMatch', () => ({
    __esModule: true,
    default: jest.fn(),
    enqueueCut: jest.fn(),
}));
jest.mock('../services/VmixService', () => ({ Instance: {} }));

const setFms = (eventCode: string, eventName: string) =>
    jest
        .spyOn(FmsApi.Instance, 'getEventInfo')
        .mockResolvedValue({ eventCode, eventName });

// checkFmsEvent is private; the test drives it directly.
const check = () => (AutoAV.Instance as any).checkFmsEvent();

describe('FMS event name auto-fill', () => {
    beforeEach(() => mockStore.clear());

    it('fills the name when FMS reports a new event code', async () => {
        setFms('MIMIL', 'FIM District Milford Event');
        await check();
        expect(mockStore.get('autoAv.eventNameOverride')).toBe(
            'FIM District Milford Event'
        );
    });

    it('keeps a hand edit while the code is unchanged', async () => {
        setFms('MIMIL', 'FIM District Milford Event');
        await check();
        mockStore.set('autoAv.eventNameOverride', 'Milford');
        await check();
        expect(mockStore.get('autoAv.eventNameOverride')).toBe('Milford');
    });

    it('replaces the hand edit when the code changes', async () => {
        setFms('MIMIL', 'FIM District Milford Event');
        await check();
        mockStore.set('autoAv.eventNameOverride', 'Milford');
        setFms('MITRY', 'FIM District Troy Event');
        await check();
        expect(mockStore.get('autoAv.eventNameOverride')).toBe(
            'FIM District Troy Event'
        );
    });

    it('does nothing when FMS is unreachable', async () => {
        mockStore.set('autoAv.eventNameOverride', 'Milford');
        jest.spyOn(FmsApi.Instance, 'getEventInfo').mockResolvedValue(null);
        await check();
        expect(mockStore.get('autoAv.eventNameOverride')).toBe('Milford');
    });
});
