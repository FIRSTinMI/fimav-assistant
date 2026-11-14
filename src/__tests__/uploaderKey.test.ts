/**
 * The uploader event key (audit findings #2 and #6, 2026-10-10). Any request
 * naming a key the uploader is not on makes it start a second scan-and-upload
 * manager on the same folder, so every caller must use the key the uploader
 * is actually on until a switch is accepted; and a switch refused because an
 * upload is running must be retried, never forced by a restart (that kills
 * the upload and leaves a Studio draft).
 */
let desiredKey = 'detroit city championship';

jest.mock('electron', () => ({
    app: { isPackaged: false, getPath: () => '/tmp' },
}));
jest.mock('electron-log', () => {
    const l = {
        warn: jest.fn(),
        error: jest.fn(),
        info: jest.fn(),
        log: jest.fn(),
    };
    return { ...l, scope: () => l };
});
jest.mock('../main/store', () => ({
    getStore: () => ({ get: (_k: string, d: unknown) => d }),
}));
jest.mock('../main/addons/autoav', () => ({
    __esModule: true,
    default: {
        Instance: {
            uploadEventKey: () => desiredKey,
            isFtc: () => false,
            getStatus: () => ({
                saveFolder: '/videos/2026 Detroit City Championship',
            }),
        },
    },
}));
jest.mock('../main/addons/ftc-scorekeeper', () => ({
    __esModule: true,
    default: { Instance: { getStatus: () => ({ address: '' }) } },
}));

// eslint-disable-next-line import/first
import YoutubeUploaderAddon from '../main/addons/upload-helper';

// This jest has no advanceTimersByTimeAsync: advance, then let the
// promise chains the timers started run.
async function tick(ms: number) {
    for (let i = 0; i < ms / 1000; i += 1) {
        jest.advanceTimersByTime(1000);
        // eslint-disable-next-line no-await-in-loop
        for (let j = 0; j < 10; j += 1) await Promise.resolve();
    }
}

describe('uploader event key', () => {
    let control: jest.SpyInstance;
    let start: jest.SpyInstance;
    let busy = false;
    const up = YoutubeUploaderAddon.Instance as any;

    beforeEach(() => {
        jest.useFakeTimers();
        busy = false;
        desiredKey = 'detroit city championship';
        up.appliedKey = '';
        up.appliedDir = '/videos/2026 Detroit City Championship';
        up.appliedProgram = 'frc';
        up.running = true;
        up.phase.set('running');
        jest.spyOn(up, 'videoDir').mockReturnValue(
            '/videos/2026 Detroit City Championship'
        );
        control = jest
            .spyOn(YoutubeUploaderAddon as any, 'control')
            .mockImplementation(async () => {
                if (busy) throw new Error('409 upload running in this folder');
            });
        start = jest.spyOn(up, 'start').mockResolvedValue(true);
    });

    afterEach(() => {
        jest.useRealTimers();
        jest.restoreAllMocks();
    });

    test('a newly typed key is not used until the uploader has switched to it', async () => {
        await up.retarget();
        expect(up.eventKey()).toBe('detroit city championship');
        busy = true;
        desiredKey = '2026midet';
        const applied = jest.fn();
        up.retargetWhenIdle(applied);
        await tick(1000);
        // The refusal has been seen: one switch attempt, refused.
        expect(control.mock.calls.map((c) => c[1].eventKey)).toContain(
            '2026midet'
        );
        // Refused (upload running): every caller still sends the old key,
        // so no second manager is made on the folder.
        expect(up.eventKey()).toBe('detroit city championship');
        expect(applied).not.toHaveBeenCalled();
        expect(start).not.toHaveBeenCalled();
        // The upload finishes; the next retry takes it.
        busy = false;
        await tick(21000);
        expect(up.eventKey()).toBe('2026midet');
        expect(applied).toHaveBeenCalledTimes(1);
        expect(start).not.toHaveBeenCalled();
        const keys = control.mock.calls.map((c) => c[1].eventKey);
        expect(keys[keys.length - 1]).toBe('2026midet');
    });

    test('a refused switch is never forced by a restart', async () => {
        busy = true;
        desiredKey = '2026midet';
        up.retargetWhenIdle(() => undefined);
        await tick(61000);
        expect(start).not.toHaveBeenCalled();
        // the first try plus a retry every 20 s
        expect(control.mock.calls.length).toBeGreaterThanOrEqual(3);
    });

    test('stop() ends a pending switch: nothing fires later with old settings', async () => {
        busy = true;
        desiredKey = '2026midet';
        const applied = jest.fn();
        up.retargetWhenIdle(applied);
        await tick(1000);
        jest.spyOn(up, 'doStop').mockResolvedValue(true);
        await up.stop();
        const callsAtStop = control.mock.calls.length;
        busy = false;
        up.phase.set('running');
        await tick(61000);
        expect(applied).not.toHaveBeenCalled();
        expect(control.mock.calls.length).toBe(callsAtStop);
    });

    test('a newer switch request ends the older chain: only the newest applies', async () => {
        busy = true;
        desiredKey = '2026midet';
        const first = jest.fn();
        const second = jest.fn();
        up.retargetWhenIdle(first);
        await tick(1000);
        up.retargetWhenIdle(second);
        await tick(1000);
        busy = false;
        await tick(41000);
        expect(first).not.toHaveBeenCalled();
        expect(second).toHaveBeenCalledTimes(1);
    });

    test('the plain retarget (event or folder change) still restarts when refused, as before', async () => {
        busy = true;
        await up.retarget();
        expect(start).toHaveBeenCalledTimes(1);
    });
});

describe('uploader key, second audit', () => {
    let control: jest.SpyInstance;
    let start: jest.SpyInstance;
    let busy = false;
    let dir = '/videos/2026 Detroit City Championship';
    const up = YoutubeUploaderAddon.Instance as any;

    beforeEach(() => {
        jest.useFakeTimers();
        busy = false;
        dir = '/videos/2026 Detroit City Championship';
        desiredKey = 'detroit city championship';
        up.appliedKey = '';
        up.appliedDir = dir;
        up.appliedProgram = 'frc';
        up.running = true;
        up.phase.set('running');
        jest.spyOn(up, 'videoDir').mockImplementation(() => dir);
        control = jest
            .spyOn(YoutubeUploaderAddon as any, 'control')
            .mockImplementation(async () => {
                if (busy) throw new Error('409');
            });
        start = jest.spyOn(up, 'start').mockResolvedValue(true);
    });
    afterEach(() => {
        jest.useRealTimers();
        jest.restoreAllMocks();
    });

    test('#5 the key latches on first use: a newly typed key does not move it', () => {
        expect(up.eventKey()).toBe('detroit city championship');
        desiredKey = '2026midet';
        expect(up.eventKey()).toBe('detroit city championship');
    });

    test('#2 a switch tells listeners (the Upload tab is re-sent the key)', async () => {
        const seen: string[] = [];
        up.events.on('key', (k: string) => seen.push(k));
        up.eventKey();
        desiredKey = '2026midet';
        await up.retarget({ restartIfRefused: false });
        expect(seen).toEqual(['detroit city championship', '2026midet']);
    });

    test('#3 a key-only status change waits out a running upload, no restart', async () => {
        up.eventKey();
        busy = true;
        desiredKey = '2026midet';
        const applied = jest.fn();
        await expect(up.retargetForStatus(applied)).resolves.toBe(true);
        await tick(41000);
        expect(start).not.toHaveBeenCalled();
        expect(up.eventKey()).toBe('detroit city championship');
        busy = false;
        await tick(21000);
        expect(up.eventKey()).toBe('2026midet');
        expect(applied).toHaveBeenCalledTimes(1);
        expect(start).not.toHaveBeenCalled();
    });

    test('#3 a new folder is a full retarget, as before', async () => {
        dir = '/videos/2026 Next Event';
        busy = true;
        await up.retargetForStatus(() => undefined);
        expect(start).toHaveBeenCalledTimes(1);
    });

    test('a program change in the same folder is a full retarget', async () => {
        up.appliedProgram = 'ftc';
        busy = true;
        await up.retargetForStatus(() => undefined);
        expect(start).toHaveBeenCalledTimes(1);
    });

    test('#8 a saved key while the uploader is not running never starts it', async () => {
        up.phase.set('stopped');
        await expect(up.retarget({ restartIfRefused: false })).resolves.toBe(
            false
        );
        expect(start).not.toHaveBeenCalled();
        expect(control).not.toHaveBeenCalled();
    });
});
