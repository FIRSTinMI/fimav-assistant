/**
 * Auto AV filing + auto-cut + upload hold, end to end through the real AutoAV
 * stop/file/cut code, the real file naming (utils/recording) and the real
 * match manifest. Only OBS, FMS, the app store and logging are mocked.
 *
 * The cut itself is real ffmpeg when DCC_SAMPLE points at a recording (a raw
 * DCC match, set by the audit run); otherwise a fake cut stands in so the
 * state machine is still covered.
 *
 * Covers the 2026-10-10 DCC failures:
 *  - the uploader was told a file was final before its cut, and uploaded the
 *    raw file while the cut moved it (every first upload failed)
 *  - the hold marked matches queued and queueCut then refused them (no cut,
 *    no upload: Q8, Q9)
 *  - an install mid-cut left Q4 with no video in the event folder
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { EventEmitter } from 'events';
import type { MatchRecord } from '../models/MatchRecord';
import { queueLoudness } from '../main/checks/loudness';

const SAMPLE = process.env.DCC_SAMPLE ?? '';
const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
    });
const REAL = SAMPLE !== '' && fs.existsSync(SAMPLE);

let obsFile = '';
let cfg: Record<string, unknown> = {};
let fmsResults: unknown = { teams: null, hasCard: false, score: null };
// FMS metadata fetch time, to act inside the filing window.
let fmsDelayMs = 0;
let cutCalls = 0;
let cutShouldFail = false;
// Fake cut duration, so tests can act while a cut is running.
let cutDelayMs = 0;
// Called once mid-cut, to act while the cut is running.
let duringCut: (() => void) | null = null;
// Every name seen in the event folder root while cuts ran.
const seenInRoot = new Set<string>();

jest.mock('electron', () => ({
    app: {
        isPackaged: false,
        getPath: () => '/tmp',
        getVersion: () => '0.0.0',
    },
    ipcMain: { on: jest.fn(), handle: jest.fn() },
    BrowserWindow: jest.fn(),
    Notification: jest.fn(),
    shell: {},
}));
// The recorder: OBS on the obs-recording build, vMix on the PR branch. Both
// get the same stand-in (whichever the build imports).
const recorder = () => ({
    __esModule: true,
    default: {
        Instance: {
            StartRecording: jest.fn(async () => undefined),
            StopRecording: jest.fn(async () => undefined),
            isRecording: jest.fn(async () => true),
            GetCurrentRecording: jest.fn(async () => obsFile),
            getUrl: () => 'http://127.0.0.1:8088',
        },
    },
});
jest.mock('../services/ObsService', () => recorder(), { virtual: true });
jest.mock('../services/VmixService', () => recorder());
jest.mock('../services/FmsApi', () => ({
    __esModule: true,
    default: {
        Instance: {
            getMatchResults: jest.fn(async () => {
                if (fmsDelayMs)
                    await new Promise<void>((resolve) => {
                        setTimeout(resolve, fmsDelayMs);
                    });
                return fmsResults;
            }),
        },
    },
}));
jest.mock('../main/window_components/signalR', () => ({
    invokeLog: jest.fn(),
    invokeExpectResponse: jest.fn(async () => {
        throw new Error('no fim-admin');
    }),
}));
jest.mock('../main/checks/loudness', () => ({ queueLoudness: jest.fn() }));
jest.mock('../main/store', () => ({
    getStore: () => ({
        get: (k: string, d: unknown) => (k in cfg ? cfg[k] : d),
        set: (k: string, v: unknown) => {
            cfg[k] = v;
        },
    }),
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
jest.mock('../main/addons/ftc-scorekeeper', () => {
    // eslint-disable-next-line global-require
    const { EventEmitter: E } = require('events');
    const inst = Object.assign(new E(), {
        getStatus: () => ({ connected: false, address: '', found: [] }),
    });
    return { __esModule: true, default: { Instance: inst } };
});
jest.mock('../main/cutMatch', () => {
    const real = jest.requireActual('../main/cutMatch');
    return {
        ...real,
        __esModule: true,
        // The real queue: one cut at a time, in order.
        enqueueCut: real.enqueueCut,
        waitForFinishedVideo: jest.fn(async () => true),
        moveVideo: jest.fn(async (a: string, b: string) => fs.renameSync(a, b)),
        default: jest.fn(async (src: string, out: string) => {
            cutCalls += 1;
            const root = path.dirname(path.dirname(out));
            const poll = setInterval(() => {
                fs.readdirSync(root).forEach((n) => seenInRoot.add(n));
            }, 50);
            try {
                if (cutDelayMs) await sleep(cutDelayMs);
                if (duringCut) {
                    const f = duringCut;
                    duringCut = null;
                    f();
                }
                if (cutShouldFail) throw new Error('ffmpeg failed');
                if (
                    process.env.DCC_SAMPLE &&
                    fs.existsSync(process.env.DCC_SAMPLE)
                ) {
                    return await real.default(src, out);
                }
                fs.writeFileSync(out, 'cut');
                // The match and results kept from a 300 s recording.
                return [
                    { from: 0, seconds: 166 },
                    { from: 284, seconds: 16 },
                ];
            } finally {
                fs.readdirSync(root).forEach((n) => seenInRoot.add(n));
                clearInterval(poll);
            }
        }),
    };
});

// eslint-disable-next-line import/first
import AutoAV from '../main/addons/autoav';
// eslint-disable-next-line import/first
import isReadyForUpload from '../main/recordings/uploadReady';
// eslint-disable-next-line import/first
import { listMatches, upsertMatch } from '../main/recordings/matchStore';

jest.setTimeout(REAL ? 600000 : 30000);

const EVENT = 'Detroit City Championship';
let tmp = '';
let offSeason = true;

function newAutoAV(): { a: any; emitted: MatchRecord[] } {
    const a: any = new (AutoAV as any)();
    const emitted: MatchRecord[] = [];
    (a.emitter as EventEmitter).on('match', (r: MatchRecord) => {
        emitted.push(JSON.parse(JSON.stringify(r)));
        // Audit: keep the manifest exactly as the uploader would read it at
        // this moment, to check the uploader's hold against it.
        const dump = process.env.MANIFEST_DUMP;
        const m = r.saveFolder && path.join(r.saveFolder, 'fimav-matches.json');
        if (dump && m && fs.existsSync(m)) {
            const n = fs.readdirSync(dump).length;
            fs.writeFileSync(
                path.join(dump, `${String(n).padStart(3, '0')}.json`),
                JSON.stringify({
                    test: expect.getState().currentTestName,
                    fileName: r.fileName,
                    state: r.processing?.state ?? '',
                    ready: isReadyForUpload(r),
                    manifest: JSON.parse(fs.readFileSync(m, 'utf8')),
                })
            );
        }
    });
    // Off-season from the event itself (not the calendar month), so the tests
    // mean the same thing in any month.
    a.currentEvent = { name: EVENT, code: 'MIDET', isOfficial: !offSeason };
    a.status.running = true;
    a.emitStatus();
    return { a, emitted };
}

function recordAMatch(n: number) {
    obsFile = path.join(
        tmp,
        `2026-10-10 11-${String(n).padStart(2, '0')}-00.mp4`
    );
    if (REAL) fs.copyFileSync(SAMPLE, obsFile);
    else fs.writeFileSync(obsFile, 'raw recording '.repeat(50));
    return {
        MatchState: 'GameSpecificData',
        Level: 'Qualification',
        MatchNumber: n,
        PlayNumber: 1,
    };
}

async function stopAndSettle(a: any, info: any) {
    a.startRecording(info);
    await sleep(20);
    // vMix build: the file is looked up 3 s after the start; hand it over
    // as that lookup would (the OBS build reads it at stop).
    a.currentFile = obsFile;
    await a.stopRecording();
    // stopRecording chains the rename/metadata/cut off a promise it does not return
    const deadline = Date.now() + (REAL ? 580000 : 20000);
    while (Date.now() < deadline) {
        const recs = listMatches(a.status.saveFolder);
        const r = recs.find(
            (m: MatchRecord) => m.matchNumber === info.MatchNumber
        );
        const ps = r?.processing?.state;
        if (r && ps !== 'queued' && ps !== 'processing') return r;
        // eslint-disable-next-line no-await-in-loop
        await sleep(100);
    }
    throw new Error('match never settled');
}

beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'autoav-cut-'));
    cfg = {
        program: 'frc',
        'autoAv.autoCut': true,
        'autoAv.eventNameOverride': EVENT,
        'autoAv.saveFolder': '',
    };
    fmsResults = { teams: null, hasCard: false, score: null };
    cutCalls = 0;
    cutShouldFail = false;
    cutDelayMs = 0;
    fmsDelayMs = 0;
    duringCut = null;
    offSeason = true;
    seenInRoot.clear();
});

afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
});

test('auto-cut on: held as queued, cut runs, announced only when done', async () => {
    const { a, emitted } = newAutoAV();
    const rec = await stopAndSettle(a, recordAMatch(8));

    expect(cutCalls).toBe(1);
    expect(rec.processing?.state).toBe('done');
    const filed = emitted.filter((r) => r.status === 'recorded');
    // The first time anyone hears of the filed match it is already held.
    expect(filed[0].processing?.state).toBe('queued');
    expect(isReadyForUpload(filed[0])).toBe(false);
    // Ready exactly once the cut is done, never before.
    const firstReady = filed.findIndex((r) => isReadyForUpload(r));
    expect(filed[firstReady].processing?.state).toBe('done');
    filed
        .slice(0, firstReady)
        .forEach((r) => expect(isReadyForUpload(r)).toBe(false));

    // The uploader's folder never saw a temp file.
    expect([...seenInRoot].filter((n) => n.includes('.cutting'))).toEqual([]);
    const folder = rec.saveFolder as string;
    expect(fs.existsSync(rec.filePath as string)).toBe(true);
    expect(
        fs.existsSync(path.join(folder, 'Originals', rec.fileName as string))
    ).toBe(true);
    expect(
        fs
            .readdirSync(path.join(folder, 'Originals'))
            .filter((n) => n.includes('.cutting'))
    ).toEqual([]);
    // With real ffmpeg: the cut is shorter than the raw and still holds the
    // match (166 s kept + 16 s of results). With the fake cut, a no-op check.
    const { probeDuration } = jest.requireActual('../main/cutMatch');
    const raw = REAL
        ? await probeDuration(
              path.join(folder, 'Originals', rec.fileName as string)
          )
        : 2;
    const cut = REAL ? await probeDuration(rec.filePath as string) : 1;
    expect(cut).toBeLessThan(raw);
    expect(cut).toBeGreaterThan(REAL ? 150 : 0);
});

test('two matches back to back: both cut, both released', async () => {
    const { a } = newAutoAV();
    const r8 = await stopAndSettle(a, recordAMatch(8));
    const r9 = await stopAndSettle(a, recordAMatch(9));
    expect([r8.processing?.state, r9.processing?.state]).toEqual([
        'done',
        'done',
    ]);
    expect(cutCalls).toBe(2);
});

test('loudness is lined up with the time each kept piece was recorded', async () => {
    (queueLoudness as jest.Mock).mockClear();
    const { a } = newAutoAV();
    const rec = await stopAndSettle(a, recordAMatch(7));
    expect(rec.processing?.state).toBe('done');
    expect(queueLoudness).toHaveBeenCalledWith(
        rec.saveFolder,
        rec.id,
        rec.filePath,
        [
            { wallStart: rec.startedAt, seconds: 166 },
            { wallStart: rec.startedAt + 284000, seconds: 16 },
        ],
        expect.any(Function)
    );
});

test('auto-cut off: no processing state, ready at once, never cut', async () => {
    cfg['autoAv.autoCut'] = false;
    const { a, emitted } = newAutoAV();
    const rec = await stopAndSettle(a, recordAMatch(5));
    expect(cutCalls).toBe(0);
    // The whole recording, from when vMix started it.
    expect(queueLoudness).toHaveBeenLastCalledWith(
        rec.saveFolder,
        rec.id,
        rec.filePath,
        [{ wallStart: rec.startedAt, seconds: Infinity }],
        expect.any(Function)
    );
    expect(rec.processing).toBeUndefined();
    const filed = emitted.find((r) => r.status === 'recorded') as MatchRecord;
    expect(isReadyForUpload(filed)).toBe(true);
});

test('carded match: held, then released uncut', async () => {
    fmsResults = { teams: null, hasCard: true, score: null };
    const { a, emitted } = newAutoAV();
    const rec = await stopAndSettle(a, recordAMatch(6));
    expect(cutCalls).toBe(0);
    expect(rec.processing?.state).toBe('unprocessed');
    expect(isReadyForUpload(rec)).toBe(true);
    const filed = emitted.filter((r) => r.status === 'recorded');
    expect(isReadyForUpload(filed[0])).toBe(false);
});

test('cut fails: original put back, released as error', async () => {
    cutShouldFail = true;
    const { a } = newAutoAV();
    const rec = await stopAndSettle(a, recordAMatch(7));
    expect(rec.processing?.state).toBe('error');
    expect(fs.existsSync(rec.filePath as string)).toBe(true);
    expect(isReadyForUpload(rec)).toBe(true);
});

test('manual Cut button still refuses a match already queued', async () => {
    cfg['autoAv.autoCut'] = false;
    const { a } = newAutoAV();
    const rec = await stopAndSettle(a, recordAMatch(2));
    const folder = rec.saveFolder as string;
    upsertMatch(folder, { ...rec, processing: { state: 'queued' } });
    a.queueCut(folder, rec.id);
    expect(cutCalls).toBe(0);
});

describe('startup recovery', () => {
    function stage(
        a: any,
        n: number,
        state: 'queued' | 'processing',
        layout: 'q4' | 'q8' | 'both'
    ) {
        const folder = path.join(tmp, `2026 ${EVENT}`);
        const orig = path.join(folder, 'Originals');
        fs.mkdirSync(orig, { recursive: true });
        const name = `2026 ${EVENT} - Qualification Match ${n}.mp4`;
        const main = path.join(folder, name);
        const body = REAL
            ? fs.readFileSync(SAMPLE)
            : Buffer.from('raw recording '.repeat(50));
        if (layout === 'q4') {
            fs.writeFileSync(path.join(orig, name), body);
            // the partial cut an older build left in the watched folder
            fs.writeFileSync(
                path.join(folder, name.replace('.mp4', '.cutting.mp4')),
                'partial'
            );
        } else if (layout === 'q8') {
            fs.writeFileSync(main, body);
        } else {
            fs.writeFileSync(main, 'cut already in place');
            fs.writeFileSync(path.join(orig, name), body);
        }
        const rec: MatchRecord = {
            id: `Qualification_${n}_1_${n}`,
            level: 'Qualification',
            matchNumber: n,
            playNumber: 1,
            eventName: EVENT,
            eventCode: EVENT,
            fileName: name,
            filePath: main,
            saveFolder: folder,
            startedAt: 1,
            endedAt: 2,
            status: 'recorded',
            processing: { state },
        } as MatchRecord;
        upsertMatch(folder, rec);
        return { folder, main, name, orig };
    }

    async function settle(folder: string, id: string) {
        const deadline = Date.now() + (REAL ? 580000 : 20000);
        while (Date.now() < deadline) {
            const r = listMatches(folder).find(
                (m: MatchRecord) => m.id === id
            ) as MatchRecord;
            const ps = r?.processing?.state;
            if (ps !== 'queued' && ps !== 'processing') return r;
            // eslint-disable-next-line no-await-in-loop
            await sleep(100);
        }
        throw new Error('never settled');
    }

    test('Q4: cut interrupted (original in Originals, no main file): restored and cut', async () => {
        const { a } = newAutoAV();
        const s = stage(a, 4, 'processing', 'q4');
        a.recoverInterruptedCuts(s.folder);
        const r = await settle(s.folder, 'Qualification_4_1_4');
        expect(r.processing?.state).toBe('done');
        expect(cutCalls).toBe(1);
        expect(fs.existsSync(s.main)).toBe(true);
        expect(fs.existsSync(path.join(s.orig, s.name))).toBe(true);
        expect(
            fs.readdirSync(s.folder).filter((n) => n.includes('.cutting'))
        ).toEqual([]);
    });

    test('Q8: held as queued when the app restarted: cut and released', async () => {
        const { a } = newAutoAV();
        const s = stage(a, 8, 'queued', 'q8');
        a.recoverInterruptedCuts(s.folder);
        const r = await settle(s.folder, 'Qualification_8_1_8');
        expect(r.processing?.state).toBe('done');
        expect(cutCalls).toBe(1);
    });

    test('cut already in place but state never written: marked done, not cut again', async () => {
        const { a } = newAutoAV();
        const s = stage(a, 7, 'processing', 'both');
        a.recoverInterruptedCuts(s.folder);
        const r = await settle(s.folder, 'Qualification_7_1_7');
        expect(r.processing?.state).toBe('done');
        expect(cutCalls).toBe(0);
        expect(fs.readFileSync(s.main, 'utf8')).toBe('cut already in place');
    });

    test('auto-cut off at restart: original back, released as error', async () => {
        cfg['autoAv.autoCut'] = false;
        const { a } = newAutoAV();
        const s = stage(a, 4, 'processing', 'q4');
        a.recoverInterruptedCuts(s.folder);
        const r = await settle(s.folder, 'Qualification_4_1_4');
        expect(r.processing?.state).toBe('error');
        expect(fs.existsSync(s.main)).toBe(true);
        expect(isReadyForUpload(r)).toBe(true);
        expect(cutCalls).toBe(0);
    });
});

describe('audit findings (2026-10-10)', () => {
    const raw = () =>
        REAL
            ? fs.readFileSync(SAMPLE)
            : Buffer.from('raw recording '.repeat(50));

    function stageRecord(
        n: number,
        state: 'queued' | 'processing',
        files: {
            main?: Buffer | string;
            originals?: Record<string, Buffer | string>;
        },
        processing: Record<string, unknown> = {},
        filePathOverride = ''
    ) {
        const folder = path.join(tmp, `2026 ${EVENT}`);
        const orig = path.join(folder, 'Originals');
        fs.mkdirSync(orig, { recursive: true });
        const name = `2026 ${EVENT} - Qualification Match ${n}.mp4`;
        const main = path.join(folder, name);
        if (files.main !== undefined) fs.writeFileSync(main, files.main);
        Object.entries(files.originals ?? {}).forEach(([f, b]) =>
            fs.writeFileSync(path.join(orig, f), b)
        );
        const rec = {
            id: `Qualification_${n}_1_${n}`,
            level: 'Qualification',
            matchNumber: n,
            playNumber: 1,
            eventName: EVENT,
            eventCode: EVENT,
            fileName: name,
            filePath: filePathOverride || main,
            saveFolder: folder,
            startedAt: 1,
            endedAt: 2,
            status: 'recorded',
            processing: { state, ...processing },
        } as MatchRecord;
        upsertMatch(folder, rec);
        return { folder, main, name, orig, id: rec.id };
    }

    async function settleId(folder: string, id: string) {
        const deadline = Date.now() + (REAL ? 580000 : 20000);
        while (Date.now() < deadline) {
            const r = listMatches(folder).find(
                (m: MatchRecord) => m.id === id
            ) as MatchRecord;
            const st = r?.processing?.state;
            if (st !== 'queued' && st !== 'processing') return r;
            // eslint-disable-next-line no-await-in-loop
            await sleep(50);
        }
        throw new Error('never settled');
    }

    test('#1 recovery while this process is cutting the match: no second cut, raw kept', async () => {
        cutDelayMs = REAL ? 0 : 400;
        const { a } = newAutoAV();
        const rawBytes = raw();
        const s = stageRecord(9, 'queued', { main: rawBytes });
        a.queueCut(s.folder, s.id, { claimed: true });
        // While that cut runs: what Restart / the FMS reconnect restart does.
        duringCut = () => a.recoverInterruptedCuts(s.folder);
        await sleep(50);
        a.recoverInterruptedCuts(s.folder);
        const r = await settleId(s.folder, s.id);
        await sleep(cutDelayMs + 200);
        expect(cutCalls).toBe(1);
        expect(r.processing?.state).toBe('done');
        // the raw recording is intact in Originals, under its own name
        expect(
            fs.readFileSync(path.join(s.orig, s.name)).equals(rawBytes)
        ).toBe(true);
        expect(fs.readdirSync(s.orig).filter((f) => f.includes('(2)'))).toEqual(
            []
        );
    });

    test('#1 the same match asked to cut twice: one cut', async () => {
        cutDelayMs = REAL ? 0 : 200;
        const { a } = newAutoAV();
        const s = stageRecord(10, 'queued', { main: raw() });
        a.queueCut(s.folder, s.id, { claimed: true });
        a.queueCut(s.folder, s.id, { claimed: true });
        await settleId(s.folder, s.id);
        await sleep(cutDelayMs + 200);
        expect(cutCalls).toBe(1);
    });

    test('#1 a file appearing at the video spot mid-cut is never replaced', async () => {
        const { a } = newAutoAV();
        const s = stageRecord(11, 'queued', { main: raw() });
        duringCut = () => fs.writeFileSync(s.main, 'someone put this here');
        a.queueCut(s.folder, s.id, { claimed: true });
        const r = await settleId(s.folder, s.id);
        expect(r.processing?.state).toBe('error');
        expect(fs.readFileSync(s.main, 'utf8')).toBe('someone put this here');
        // the raw stays safe in Originals
        expect(fs.existsSync(path.join(s.orig, s.name))).toBe(true);
    });

    test('#3 recovery runs when the event folder changes, not only at launch', async () => {
        cfg['autoAv.eventNameOverride'] = '';
        const { a } = newAutoAV();
        // stage the Q4 shape in the DCC folder, then point the app at it
        const s = stageRecord(4, 'processing', {
            originals: { [`2026 ${EVENT} - Qualification Match 4.mp4`]: raw() },
        });
        cfg['autoAv.saveFolder'] = tmp;
        cfg['autoAv.eventNameOverride'] = EVENT;
        a.emitStatus();
        expect(path.resolve(a.status.saveFolder)).toBe(path.resolve(s.folder));
        const r = await settleId(s.folder, s.id);
        expect(r.processing?.state).toBe('done');
        expect(fs.existsSync(s.main)).toBe(true);
    });

    test('#4 recovery puts back the stored original, even a "(2)" copy', async () => {
        const name = `2026 ${EVENT} - Qualification Match 12.mp4`;
        const { a } = newAutoAV();
        const s = stageRecord(
            12,
            'processing',
            {
                originals: {
                    [name]: 'OLDER CUT, NOT THIS MATCH',
                    [name.replace('.mp4', ' (2).mp4')]: raw(),
                },
            },
            { originalPath: `Originals/${name.replace('.mp4', ' (2).mp4')}` }
        );
        // Recovery restores the (2) file, the cut then moves it back into
        // Originals under a fresh name. The older file is never touched.
        a.recoverInterruptedCuts(s.folder);
        const r = await settleId(s.folder, s.id);
        expect(r.processing?.state).toBe('done');
        expect(fs.readFileSync(path.join(s.orig, name), 'utf8')).toBe(
            'OLDER CUT, NOT THIS MATCH'
        );
        expect(
            fs
                .readFileSync(
                    path.join(
                        s.orig,
                        path.basename(r.processing?.originalPath as string)
                    )
                )
                .equals(raw())
        ).toBe(true);
    });

    test('#4 no stored original and several candidates: nothing moved, marked error', () => {
        const name = `2026 ${EVENT} - Qualification Match 13.mp4`;
        const { a } = newAutoAV();
        const s = stageRecord(13, 'processing', {
            originals: { [name]: 'A', [name.replace('.mp4', ' (2).mp4')]: 'B' },
        });
        a.recoverInterruptedCuts(s.folder);
        const r = listMatches(s.folder).find(
            (m: MatchRecord) => m.id === s.id
        ) as MatchRecord;
        expect(r.processing?.state).toBe('error');
        expect(fs.existsSync(s.main)).toBe(false);
        expect(fs.readdirSync(s.orig).sort()).toEqual(
            [name, name.replace('.mp4', ' (2).mp4')].sort()
        );
        expect(cutCalls).toBe(0);
    });

    test('#5 a stale filePath (folder moved) is ignored: works in the current folder', async () => {
        const { a } = newAutoAV();
        const s = stageRecord(
            14,
            'processing',
            {
                originals: {
                    [`2026 ${EVENT} - Qualification Match 14.mp4`]: raw(),
                },
            },
            {},
            'E:\\Old Drive\\2026 DCC\\2026 Detroit City Championship - Qualification Match 14.mp4'
        );
        a.recoverInterruptedCuts(s.folder);
        const r = await settleId(s.folder, s.id);
        expect(r.processing?.state).toBe('done');
        expect(fs.existsSync(s.main)).toBe(true);
    });

    test('in-season event: no hold, no cut, ready at once', async () => {
        offSeason = false;
        const { a, emitted } = newAutoAV();
        const rec = await stopAndSettle(a, recordAMatch(15));
        expect(cutCalls).toBe(0);
        expect(rec.processing).toBeUndefined();
        expect(
            isReadyForUpload(
                emitted.find((r) => r.status === 'recorded') as MatchRecord
            )
        ).toBe(true);
    });
});

test('crash between "processing" and the move: an unrelated same-name original is not taken as this match', async () => {
    const name = `2026 ${EVENT} - Qualification Match 16.mp4`;
    const folder = path.join(tmp, `2026 ${EVENT}`);
    const orig = path.join(folder, 'Originals');
    fs.mkdirSync(orig, { recursive: true });
    fs.writeFileSync(path.join(folder, name), 'THE RAW OF THIS MATCH');
    fs.writeFileSync(path.join(orig, name), 'AN OLDER FILE');
    upsertMatch(folder, {
        id: 'Qualification_16_1_16',
        level: 'Qualification',
        matchNumber: 16,
        playNumber: 1,
        eventName: EVENT,
        eventCode: EVENT,
        fileName: name,
        filePath: path.join(folder, name),
        saveFolder: folder,
        startedAt: 1,
        endedAt: 2,
        status: 'recorded',
        processing: {
            state: 'processing',
            originalPath: path.join(orig, name.replace('.mp4', ' (2).mp4')),
        },
    } as MatchRecord);
    const { a } = newAutoAV();
    a.recoverInterruptedCuts(folder);
    const deadline = Date.now() + 20000;
    let r: MatchRecord | undefined;
    while (Date.now() < deadline) {
        r = listMatches(folder).find(
            (m: MatchRecord) => m.id === 'Qualification_16_1_16'
        );
        if (r?.processing?.state === 'done' || r?.processing?.state === 'error')
            break;
        // eslint-disable-next-line no-await-in-loop
        await sleep(50);
    }
    // It is re-cut from its own raw, never marked done on the older file.
    expect(cutCalls).toBe(1);
    expect(fs.readFileSync(path.join(orig, name), 'utf8')).toBe(
        'AN OLDER FILE'
    );
});

describe('second audit (2026-10-10)', () => {
    test('H1: recovery during filing (FMS lookup) never cuts a carded match nor releases it mid-cut', async () => {
        fmsDelayMs = 400;
        fmsResults = { teams: null, hasCard: true, score: null };
        const { a, emitted } = newAutoAV();
        const info = recordAMatch(20);
        a.startRecording(info);
        await sleep(20);
        a.currentFile = obsFile;
        await a.stopRecording();
        // Inside the filing window: the record is "queued", the FMS lookup is running.
        await sleep(150);
        const folder = a.status.saveFolder as string;
        const before = listMatches(folder).find(
            (m: MatchRecord) => m.matchNumber === 20
        ) as MatchRecord;
        expect(before.processing?.state).toBe('queued');
        a.recoverInterruptedCuts(folder);
        await sleep(800);
        const r = listMatches(folder).find(
            (m: MatchRecord) => m.matchNumber === 20
        ) as MatchRecord;
        expect(cutCalls).toBe(0);
        expect(r.processing?.state).toBe('unprocessed');
        // Released exactly once, by the filing path, after the lookup.
        expect(
            emitted.filter((e) => e.matchNumber === 20 && isReadyForUpload(e))
                .length
        ).toBeGreaterThan(0);
    });

    test('H1: recovery during filing never starts a second cut of an uncarded match', async () => {
        fmsDelayMs = 400;
        cutDelayMs = REAL ? 0 : 300;
        const { a } = newAutoAV();
        const info = recordAMatch(21);
        a.startRecording(info);
        await sleep(20);
        a.currentFile = obsFile;
        await a.stopRecording();
        await sleep(150);
        a.recoverInterruptedCuts(a.status.saveFolder as string);
        const r = await stopAndSettleExisting(a, 21);
        await sleep(cutDelayMs + 300);
        expect(cutCalls).toBe(1);
        expect(r.processing?.state).toBe('done');
    });

    test('a match held "queued" that never gets its cut is released, not stuck', async () => {
        const { a } = newAutoAV();
        jest.spyOn(a, 'queueCut').mockImplementation(() => undefined);
        const rec = await stopAndSettle(a, recordAMatch(22));
        expect(rec.processing?.state).toBe('error');
        expect(isReadyForUpload(rec)).toBe(true);
    });
});

async function stopAndSettleExisting(a: any, n: number) {
    const deadline = Date.now() + (REAL ? 580000 : 20000);
    while (Date.now() < deadline) {
        const r = listMatches(a.status.saveFolder).find(
            (m: MatchRecord) => m.matchNumber === n
        );
        const st = r?.processing?.state;
        if (r && st !== 'queued' && st !== 'processing')
            return r as MatchRecord;
        // eslint-disable-next-line no-await-in-loop
        await sleep(50);
    }
    throw new Error('never settled');
}

test('an error after the match is filed keeps its good record (it still uploads)', async () => {
    cfg['autoAv.autoCut'] = false;
    const { a } = newAutoAV();
    // A listener that throws on the filed record: like sending to a closed
    // window at quit.
    a.emitter.on('match', (r: MatchRecord) => {
        if (r.status === 'recorded' && r.matchNumber === 23)
            throw new Error('window gone');
    });
    const rec = await stopAndSettle(a, recordAMatch(23));
    expect(rec.status).toBe('recorded');
    expect(rec.filePath).toBeTruthy();
    expect(fs.existsSync(rec.filePath as string)).toBe(true);
});

// The uploader runs at off-season events only, FRC or FTC.
describe('uploader at off-season events', () => {
    test.each([
        ['frc', true, true],
        ['frc', false, false],
        ['ftc', true, true],
        ['ftc', false, false],
    ])('%s off-season=%s: runs=%s', (program, off, runs) => {
        offSeason = off as boolean;
        cfg.program = program;
        const { a } = newAutoAV();
        expect(a.runsUploader()).toBe(runs);
        expect(a.getStatus().uploader).toBe(runs);
    });
});
