import FtcScorekeeper from '../main/addons/ftc-scorekeeper';

jest.mock('os', () => ({ networkInterfaces: () => ({}) }));
jest.mock('electron-log', () => {
    const l = { warn: jest.fn(), error: jest.fn(), info: jest.fn() };
    return { ...l, scope: () => l };
});
const store: Record<string, unknown> = {};
jest.mock('../main/store', () => ({
    getStore: () => ({
        get: (k: string, d: unknown) => (k in store ? store[k] : d),
        set: (k: string, v: unknown) => {
            store[k] = v;
        },
    }),
}));
if (!(AbortSignal as any).timeout) {
    (AbortSignal as any).timeout = () => new AbortController().signal;
}

// FTC Live answers on 127.0.0.1:8080 only.
const asked: string[] = [];
global.fetch = jest.fn(async (url: any) => {
    const u = String(url);
    asked.push(u);
    if (u === 'http://127.0.0.1:8080/api/v1/version/')
        return { ok: true, json: async () => ({ version: '8.0.0' }) };
    throw new Error('refused');
}) as any;

describe('FTC Live scan', () => {
    beforeEach(() => {
        asked.length = 0;
    });

    it('the Scan button tries 80, then 8080, and stops there', async () => {
        const sk = new (FtcScorekeeper as any)();
        expect(await sk.scan()).toEqual(['127.0.0.1:8080']);
        expect(asked).toEqual([
            'http://127.0.0.1/api/v1/version/',
            'http://127.0.0.1:8080/api/v1/version/',
        ]);
    });

    it('an automatic try covers one port', async () => {
        const sk = new (FtcScorekeeper as any)();
        expect(await sk.scan([80])).toEqual([]);
        expect(asked).toEqual(['http://127.0.0.1/api/v1/version/']);
    });
});
