import nodeFetch from 'node-fetch';
import AutoAV from '../main/addons/autoav';
import { matchFileName } from '../utils/recording';

jest.mock('node-fetch', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('electron-log', () => {
    const fn = { log: jest.fn(), info: jest.fn(), error: jest.fn() };
    return { ...fn, warn: jest.fn(), scope: () => fn };
});
jest.mock('../main/store', () => ({
    getStore: () => ({ get: (_k: string, d?: unknown) => d, set: jest.fn() }),
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

// What FMS sent at Goonettes 2026-10-10 13:16:24 during quals for a test match,
// and what GetCurrentMatchAndPlayNumber answered for the same match.
const status = {
    MatchState: 'Prestarting',
    MatchNumber: 999,
    PlayNumber: 1,
    Level: 'Qualification',
} as const;

const fmsAnswers = (item1: string, item2: number, item3: number) =>
    (nodeFetch as unknown as jest.Mock).mockResolvedValue({
        status: 200,
        json: async () => ({ item1, item2, item3 }),
    });

const av = () => AutoAV.Instance as any;
const flush = () =>
    new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
    });

describe('test match level', () => {
    beforeEach(() => {
        av().loadedMatch = null;
        av().loadedMatchFetch = null;
        av().lastState = null;
        (nodeFetch as unknown as jest.Mock).mockReset();
    });

    it('takes the loaded match level, not the active level FMS sends', async () => {
        fmsAnswers('None', 999, 1);
        // First status: no answer yet, so the status level stands.
        expect(av().withLoadedLevel(status).Level).toBe('Qualification');
        av().lastState = status;
        await flush();
        // The answer corrects the last state and every later status for it.
        expect(av().lastState.Level).toBe('None');
        expect(
            av().withLoadedLevel({ ...status, MatchState: 'MatchAuto' }).Level
        ).toBe('None');
    });

    it('leaves a real qualification alone', async () => {
        fmsAnswers('Qualification', 16, 1);
        const q16 = { ...status, MatchNumber: 16 };
        av().withLoadedLevel(q16);
        await flush();
        expect(av().withLoadedLevel(q16).Level).toBe('Qualification');
    });

    it('ignores an answer for a different match', async () => {
        fmsAnswers('None', 999, 1);
        const q17 = { ...status, MatchNumber: 17 };
        av().withLoadedLevel(q17);
        await flush();
        expect(av().withLoadedLevel(q17).Level).toBe('Qualification');
    });

    it('keeps the status level when FMS does not answer', async () => {
        (nodeFetch as unknown as jest.Mock).mockRejectedValue(
            new Error('offline')
        );
        av().withLoadedLevel(status);
        await flush();
        expect(av().withLoadedLevel(status).Level).toBe('Qualification');
    });

    it('names a test match "Test Match", which the uploader never uploads', () => {
        const name = matchFileName(
            { name: 'Goonettes Invitational', isOfficial: false } as any,
            { ...status, Level: 'None' } as any
        );
        expect(name).toMatch(/ - Test Match 999\.mp4$/);
    });
});
