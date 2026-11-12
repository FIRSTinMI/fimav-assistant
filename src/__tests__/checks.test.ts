/* eslint-disable max-classes-per-file */
import Checks, { loudnessVerdict } from '../main/checks/engine';
import { decodeReply, levelToDb } from '../main/checks/xair';
import { talkLog } from '../main/checks/talking';
import { talkLoudness } from '../main/checks/loudness';
import { parseStreamSettings } from '../main/checks/vmixSettings';
import { setCaptionKey } from '../main/checks/captionsYoutube';
import VmixService from '../services/VmixService';
import { setDefaultAudioDevice } from '../main/events/HWCheck';
import { CheckResult } from '../models/Checks';

// The world the checks read, set per test.
let vmix: any = null;
let match: { label: string; level: string } | null = null;
let bandwidth: any = { supported: true, streams: [] };
let mixer = new Map<string, string | number>();
let captionsRunning = true;
let captionsPhase = 'running';
// live-captions' /api/events stream as AddonEvents exposes it.
const lcEvents = {
    connected: false,
    latest: new Map<string, any>(),
    on: () => undefined,
};
let audioDevices: any[] = [];
let customAd = false;
let uploaderUsed = false;
// AutoAV's program and season: FRC off-season unless a test says so.
let ftc = false;
let offSeason = true;
let upPhase = 'running';
const upEvents = {
    connected: false,
    latest: new Map<string, any>(),
    on: () => undefined,
};
let adPhase = 'running';
const adEvents = {
    connected: false,
    latest: new Map<string, any>(),
    on: () => undefined,
};
const xairOut = (over: Record<string, unknown> = {}) => ({
    name: 'OUT 1-2',
    sub_name: 'BEHRINGER X-AIR',
    default: 'Render',
    muted: false,
    volume_percent: '100.0%',
    control_id: 'BEHRINGER X-AIR\\Device\\OUT 1-2\\Render',
    ...over,
});
let matches: any[] = [];
const store: Record<string, unknown> = {};
let settings: any = null;
let hw: any = null;
let hwPingedAt = 0;
let push: any = null;

jest.mock('electron-log', () => {
    const l = { warn: jest.fn(), error: jest.fn(), info: jest.fn() };
    return { ...l, scope: () => l };
});
jest.mock('../services/VmixService', () => ({
    __esModule: true,
    default: {
        Instance: {
            GetBase: async () => (vmix ? { vmix } : null),
            Function: jest.fn(async () => undefined),
        },
    },
}));
jest.mock('../main/events/HWCheck', () => ({
    fetchAndParseAudioDevices: async () => audioDevices,
    isXairOut: (a: any) =>
        a.name === 'OUT 1-2' && a.sub_name.includes('BEHRINGER X-AIR'),
    setDefaultAudioDevice: jest.fn(async () => true),
    setVolumePercent: jest.fn(async () => true),
    unmuteDevice: jest.fn(async () => true),
}));
jest.mock('../main/checks/xairWatch', () => ({
    __esModule: true,
    default: class {
        // eslint-disable-next-line class-methods-use-this
        start() {}

        // eslint-disable-next-line class-methods-use-this
        stop() {}
    },
}));
jest.mock('../main/checks/vmixSettings', () => ({
    ...jest.requireActual('../main/checks/vmixSettings'),
    readStreamSettings: () => settings,
}));
jest.mock('../main/checks/captionsYoutube', () => ({
    ...jest.requireActual('../main/checks/captionsYoutube'),
    setCaptionKey: jest.fn(async () => undefined),
    enableCaptionPush: jest.fn(async () => undefined),
}));
jest.mock('../main/addons/autoav', () => ({
    __esModule: true,
    default: {
        Instance: {
            matchInPlay: () => match,
            runsCustomAd: () => customAd,
            runsUploader: () => uploaderUsed,
            isFtc: () => ftc,
            isOffSeason: () => offSeason,
            getStatus: () => ({ saveFolder: '/event' }),
        },
    },
}));
jest.mock('../main/addons/live-captions', () => ({
    __esModule: true,
    default: {
        Instance: {
            isRunning: () => captionsRunning,
            getPhase: () => captionsPhase,
            get events() {
                return lcEvents;
            },
        },
    },
}));
jest.mock('../main/addons/upload-helper', () => ({
    __esModule: true,
    default: {
        Instance: {
            getPhase: () => upPhase,
            start: jest.fn(async () => true),
            get events() {
                return upEvents;
            },
        },
    },
}));
jest.mock('../main/addons/audience-display', () => ({
    __esModule: true,
    default: {
        Instance: {
            getPhase: () => adPhase,
            start: jest.fn(async () => true),
            get events() {
                return adEvents;
            },
        },
    },
}));
jest.mock('../main/addons/hw-ping', () => ({
    __esModule: true,
    default: {
        Instance: {
            mixerAddress: () => '192.168.25.13',
            get currentStatus() {
                return hw;
            },
            get lastPingAt() {
                return hwPingedAt;
            },
        },
    },
}));
jest.mock('../main/vmixBandwidth', () => ({
    __esModule: true,
    streamKeyFromUrl: jest.requireActual('../main/vmixBandwidth')
        .streamKeyFromUrl,
    default: async () => bandwidth,
}));
jest.mock('../main/recordings/matchStore', () => ({
    listMatches: () => matches,
}));
jest.mock('../main/store', () => ({
    getStore: () => ({
        get: (k: string, d: unknown) => (k in store ? store[k] : d),
        set: (k: string, v: unknown) => {
            store[k] = v;
        },
    }),
}));
jest.mock('../main/checks/xair', () => {
    const actual = jest.requireActual('../main/checks/xair');
    return {
        ...actual,
        queryXair: async (_h: string, addrs: string[]) =>
            new Map(
                addrs.filter((a) => mixer.has(a)).map((a) => [a, mixer.get(a)])
            ),
        XairMeters: class {
            latest: number[] = [];

            lastAt = 0;

            // eslint-disable-next-line class-methods-use-this
            start() {}

            // eslint-disable-next-line class-methods-use-this
            stop() {}
        },
    };
});

// FIM's 2025 default X-Air scene, as read over OSC.
function fimMixer() {
    return new Map<string, string | number>([
        ['/ch/01/config/name', 'Wireless RED'],
        ['/ch/02/config/name', 'Wireless Blu'],
        ['/ch/03/config/name', 'DJ L'],
        ['/ch/04/config/name', 'DJ R'],
        ['/rtn/aux/config/name', 'vMix PC'],
        ['/bus/1/config/name', 'Live Stream'],
        ['/ch/03/mix/on', 1],
        ['/ch/03/mix/fader', 0.75],
        ['/ch/03/mix/lr', 1],
        ['/ch/03/mix/01/level', 0],
        ['/ch/04/mix/on', 1],
        ['/ch/04/mix/fader', 0.75],
        ['/ch/04/mix/lr', 1],
        ['/ch/04/mix/01/level', 0],
        ['/rtn/aux/mix/on', 1],
        ['/rtn/aux/mix/fader', 0.75],
        ['/rtn/aux/mix/lr', 1],
        ['/rtn/aux/mix/01/level', 0.75],
    ]);
}

function fimVmix(over: Record<string, unknown> = {}) {
    return {
        streaming: 'True',
        recording: 'True',
        inputs: {
            input: [
                {
                    key: 'fms-key',
                    number: 1,
                    title: 'FMS',
                    muted: 'False',
                    audiobusses: 'M',
                    meterF1: 0,
                },
                {
                    key: 'lc-key',
                    number: 2,
                    title: 'Live Captions',
                    muted: 'True',
                    audiobusses: 'M',
                },
            ],
        },
        overlays: { overlay: [{ number: 1 }, { number: 8, '#text': 2 }] },
        audio: { busA: { muted: 'False', meterF1: 0.3, meterF2: 0.3 } },
        ...over,
    };
}

const T0 = Date.UTC(2026, 9, 5, 12, 0, 0);
let checks: any;
const get = (id: string): CheckResult =>
    checks.list().find((c: CheckResult) => c.id === id);

async function tick(seconds: number) {
    const target = Date.now() + seconds * 1000;
    while (Date.now() < target) {
        jest.setSystemTime(Math.min(target, Date.now() + 1000));
        // Tests change the fake vMix between ticks: as if an activator said so.
        checks.dirty.vmix = true;
        // eslint-disable-next-line no-await-in-loop
        await checks.tick();
    }
}

beforeEach(() => {
    jest.useFakeTimers({ now: T0 });
    vmix = fimVmix();
    match = null;
    bandwidth = {
        supported: true,
        streams: [
            {
                index: 1,
                liveKbps: 6000,
                targetKbps: 6000,
                speed: 1,
                audioBus: 'Bus A',
                rtmpUrl: 'rtmp://a.rtmp.youtube.com/live2/abcd-efgh',
            },
        ],
    };
    settings = {
        audioBus: 'Bus A',
        output: 2,
        output2Overlays: [1, 2, 3, 4, 5, 6, 7, 9, 10, 11, 12, 13, 14, 15, 16],
        youtubeKey: 'abcd-efgh',
        recordOutput: 2,
        recordAudioBus: 'Bus A',
    };
    push = {
        enabled: true,
        url: 'http://upload.youtube.com/closedcaption?cid=abcd-efgh',
        running: true,
        lastPushAt: null,
        queueDepth: 0,
        lastError: null,
    };
    (VmixService.Instance.Function as jest.Mock).mockClear();
    (setCaptionKey as jest.Mock).mockClear();
    hw = {
        camera1: true,
        camera2: true,
        mixer: true,
        switch: true,
        internet: true,
        errors: [],
        ip_errors: [],
        ip_warnings: [],
    };
    hwPingedAt = T0;
    mixer = fimMixer();
    captionsRunning = true;
    captionsPhase = 'running';
    // live-captions' event stream: up, with its YouTube status.
    lcEvents.connected = true;
    lcEvents.latest.clear();
    lcEvents.latest.set('youtube', push);
    customAd = false;
    uploaderUsed = false;
    ftc = false;
    offSeason = true;
    upPhase = 'running';
    upEvents.connected = false;
    upEvents.latest.clear();
    adPhase = 'running';
    adEvents.connected = false;
    adEvents.latest.clear();
    audioDevices = [xairOut()];
    matches = [];
    Object.keys(store).forEach((k) => delete store[k]);
    checks = new (Checks as any)();
    // Results exist from start(); start() itself would loop forever.
    checks.results = new Map();
    checks.list = Checks.prototype.list.bind(checks);
    [
        'hw-network',
        'hw-ip',
        'hw-switch',
        'hw-mixer',
        'hw-camera1',
        'hw-camera2',
        'stream-match',
        'stream-health',
        'stream-bus',
        'stream-output',
        'recording-match',
        'recording-bus',
        'stream-audio',
        'stream-loudness',
        'dj-stream',
        'match-sounds',
        'windows-audio',
        'match-buzzer',
        'mic-balance',
        'captions',
        'captions-engine',
        'captions-youtube',
        'audience-display',
        'uploader',
    ].forEach((id) =>
        checks.results.set(id, {
            id,
            group: id.startsWith('hw-') ? 'Hardware' : 'Stream',
            label: id,
            state: 'unknown',
            detail: '',
            ignoredUntil: null,
            fix: null,
            doc: null,
            hint: null,
        })
    );
});

afterEach(() => jest.useRealTimers());

describe('stream checks', () => {
    it('all good at an FIM-default cart', async () => {
        const v = fimVmix();
        // The match start sound on the FMS input.
        (v.inputs.input[0] as any).meterF1 = 0.5;
        vmix = v;
        match = { label: 'Q14', level: 'Qualification' };
        await tick(6);
        const bad = checks
            .list()
            .filter(
                (c: CheckResult) =>
                    c.state === 'warning' || c.state === 'critical'
            );
        expect(bad).toEqual([]);
    });

    it('a qual running without the stream, after 5 s', async () => {
        vmix = fimVmix({ streaming: 'False' });
        match = { label: 'Q14', level: 'Qualification' };
        await tick(3);
        expect(get('stream-match').state).toBe('ok');
        await tick(4);
        expect(get('stream-match')).toMatchObject({
            state: 'critical',
            detail: 'Q14 running, not streaming',
        });
    });

    it('a stalled stream, after 20 s', async () => {
        bandwidth = { supported: true, streams: [] };
        await tick(10);
        expect(get('stream-health').state).toBe('ok');
        await tick(15);
        expect(get('stream-health').state).toBe('critical');
    });

    it('low bitrate is fine (VBR); under real time is a stall', async () => {
        bandwidth = {
            supported: true,
            streams: [{ index: 1, liveKbps: 300, targetKbps: 6000, speed: 1 }],
        };
        await tick(25);
        expect(get('stream-health').state).toBe('ok');
        bandwidth = {
            supported: true,
            streams: [
                { index: 1, liveKbps: 2000, targetKbps: 6000, speed: 0.62 },
            ],
        };
        await tick(25);
        expect(get('stream-health')).toMatchObject({
            state: 'critical',
            detail: 'Stalled: 0.62x real time',
        });
    });

    it('a quiet stream during a match is not an alarm', async () => {
        const v = fimVmix();
        (v.inputs.input[0] as any).meterF1 = 0.5;
        vmix = v;
        match = { label: 'Q14', level: 'Qualification' };
        // The start sound reaches Bus A, then nobody talks for a minute.
        await tick(5);
        const quiet = fimVmix({
            audio: { busA: { muted: 'False', meterF1: 0, meterF2: 0 } },
        });
        vmix = quiet;
        await tick(60);
        expect(get('stream-audio').state).toBe('ok');
    });

    it('start sound on the FMS input but not on Bus A', async () => {
        await tick(1);
        const v = fimVmix({
            audio: { busA: { muted: 'False', meterF1: 0, meterF2: 0 } },
        });
        (v.inputs.input[0] as any).meterF1 = 0.5;
        vmix = v;
        match = { label: 'Q16', level: 'Qualification' };
        await tick(6);
        expect(get('stream-audio')).toMatchObject({
            state: 'critical',
            detail: 'No Q16 start sound on Bus A',
        });
        // Routing fixed between matches: sound on the input and Bus A
        // together clears it without waiting for the next match.
        match = null;
        vmix = fimVmix();
        (vmix.inputs.input[0] as any).meterF1 = 0.5;
        await tick(1);
        expect(get('stream-audio').state).toBe('ok');
    });

    it('a held timer does not survive a branch that stopped running', async () => {
        match = { label: 'Q20', level: 'Qualification' };
        vmix = fimVmix({ streaming: 'False' });
        await tick(3); // 3 s into a match without the stream (needs 5)
        vmix = null; // vMix gone: stream-match not evaluated
        await tick(3);
        vmix = fimVmix({ streaming: 'False' });
        await tick(1);
        // The 5 s count started again; not critical on the first tick back.
        expect(get('stream-match').state).not.toBe('critical');
    });

    it('wakes for a pending delay, not on a poll', async () => {
        match = { label: 'Q21', level: 'Qualification' };
        vmix = fimVmix({ streaming: 'False', recording: 'False' });
        await tick(1);
        // stream-match comes due in 5 s; nothing else needs a timer.
        expect(checks.nextWait()).toBeLessThanOrEqual(5000);
        // Match over, start sound window closed, nothing pending.
        match = null;
        captionsRunning = false;
        vmix = fimVmix({ streaming: 'False' });
        await tick(5);
        expect(checks.nextWait()).toBe(Infinity);
    });

    it('no Bus A in vMix is critical', async () => {
        vmix = fimVmix({ audio: { master: { muted: 'False' } } });
        await tick(1);
        expect(get('stream-audio')).toMatchObject({
            state: 'critical',
            detail: 'No Bus A in vMix audio mixer',
        });
    });

    it('DJ sent to the Live Stream bus', async () => {
        mixer.set('/ch/03/mix/01/level', 0.6);
        await tick(1);
        expect(get('dj-stream')).toMatchObject({
            state: 'critical',
            detail: 'DJ L sent to Live Stream: -6 dB',
        });
    });

    it('match sounds out of the venue are critical, off the stream a warning', async () => {
        mixer.set('/rtn/aux/mix/lr', 0);
        await tick(1);
        expect(get('match-sounds')).toMatchObject({
            state: 'critical',
            detail: 'vMix PC not in the venue mix on X-Air',
        });
        checks.mixer = null;
        mixer = fimMixer();
        mixer.set('/rtn/aux/mix/01/level', 0);
        await tick(11);
        expect(get('match-sounds')).toMatchObject({
            state: 'warning',
            detail: 'vMix PC not sent to Live Stream',
        });
    });

    it('FMS input muted in vMix', async () => {
        const v = fimVmix();
        v.inputs.input[0].muted = 'True';
        vmix = v;
        await tick(1);
        expect(get('match-sounds')).toMatchObject({
            state: 'critical',
            detail: 'FMS muted in vMix',
        });
    });

    it('FMS muted: Unmute sends AudioOn for that input', async () => {
        const v = fimVmix();
        v.inputs.input[0].muted = 'True';
        vmix = v;
        await tick(1);
        expect(get('match-sounds').fix).toBe('Unmute');
        (VmixService.Instance.Function as jest.Mock).mockImplementationOnce(
            async () => {
                v.inputs.input[0].muted = 'False';
            }
        );
        await checks.fix('match-sounds');
        expect(VmixService.Instance.Function).toHaveBeenCalledWith('AudioOn', {
            Input: 'fms-key',
        });
        // Checked again straight after the fix: the button is gone.
        expect(get('match-sounds')).toMatchObject({ state: 'ok', fix: null });
    });

    it('an input titled "Audience" is the display input', async () => {
        const v = fimVmix();
        v.inputs.input[0].title = 'Audience';
        v.inputs.input[0].muted = 'True';
        vmix = v;
        await tick(1);
        expect(get('match-sounds').detail).toBe('Audience muted in vMix');
    });

    it('captions on another overlay: fix puts them on overlay 8', async () => {
        vmix = fimVmix({
            overlays: { overlay: [{ number: 3, '#text': 2 }, { number: 8 }] },
        });
        await tick(1);
        expect(get('captions')).toMatchObject({
            state: 'warning',
            detail: 'Live Captions not on overlay 8',
            fix: 'Put on overlay 8',
        });
        await checks.fix('captions');
        expect(VmixService.Instance.Function).toHaveBeenCalledWith(
            'OverlayInput8In',
            { Input: 'lc-key' }
        );
        vmix = fimVmix();
        await tick(1);
        expect(get('captions')).toMatchObject({ state: 'ok', fix: null });
    });

    it('a live stream on Master is critical', async () => {
        bandwidth.streams[0].audioBus = 'Master';
        await tick(1);
        expect(get('stream-bus')).toMatchObject({
            state: 'critical',
            detail: 'Stream 1 on Master, not Bus A',
        });
    });

    it('stream settings on Master before going live are critical', async () => {
        vmix = fimVmix({ streaming: 'False' });
        settings.audioBus = 'Master';
        await tick(1);
        expect(get('stream-bus')).toMatchObject({
            state: 'critical',
            detail: 'Stream settings on Master, not Bus A',
        });
    });

    it('live on Bus A, settings changed to Master: a warning', async () => {
        settings.audioBus = 'Master';
        await tick(1);
        expect(get('stream-bus')).toMatchObject({
            state: 'warning',
            detail: 'Stream settings on Master, not Bus A',
        });
    });

    it('stream on Output 1 or overlay 8 on Output 2: a warning', async () => {
        settings.output = 1;
        await tick(1);
        expect(get('stream-output')).toMatchObject({
            state: 'warning',
            detail: 'Stream on Output 1, not Output 2',
        });
        settings.output = 2;
        settings.recordOutput = 1;
        await tick(1);
        expect(get('stream-output')).toMatchObject({
            state: 'warning',
            detail: 'Recorder 1 on Output 1, not Output 2',
        });
        settings.recordOutput = 2;
        settings.output2Overlays = [1, 8];
        await tick(1);
        expect(get('stream-output')).toMatchObject({
            state: 'warning',
            detail: 'Overlay 8 (captions) on Output 2',
        });
    });

    it('vMix closed: no verdict from its saved settings', async () => {
        vmix = null;
        settings.output = 1;
        settings.recordAudioBus = 'Master';
        push.url = 'http://upload.youtube.com/closedcaption?cid=old-key';
        await tick(1);
        ['stream-output', 'recording-bus'].forEach((id) =>
            expect(get(id)).toMatchObject({
                state: 'unknown',
                detail: 'vMix not answering',
            })
        );
        // No stream key to compare with, so not a mismatch.
        expect(get('captions-youtube').state).toBe('ok');
    });

    it('nothing to measure is Not checked, not OK', async () => {
        vmix = fimVmix({ streaming: 'False' });
        await tick(1);
        expect(get('stream-health')).toMatchObject({
            state: 'unknown',
            detail: 'Not streaming',
        });
        expect(get('stream-audio')).toMatchObject({
            state: 'unknown',
            detail: 'Not streaming',
        });
        expect(get('stream-loudness')).toMatchObject({
            state: 'unknown',
            detail: 'No measurement yet',
        });
        // Bus A muted before going live: a warning, with the fix.
        vmix = fimVmix({
            streaming: 'False',
            audio: { busA: { muted: 'True', meterF1: 0, meterF2: 0 } },
        });
        await tick(1);
        expect(get('stream-audio')).toMatchObject({
            state: 'warning',
            detail: 'Bus A muted',
            fix: 'Unmute',
        });
    });

    it('Live Captions updating or starting is not a problem yet', async () => {
        captionsRunning = false;
        captionsPhase = 'updating';
        await tick(1);
        expect(get('captions')).toMatchObject({
            state: 'unknown',
            detail: 'Live Captions updating',
        });
        captionsPhase = 'starting';
        await tick(1);
        expect(get('captions').detail).toBe('Live Captions starting');
        captionsPhase = 'stopped';
        await tick(1);
        expect(get('captions')).toMatchObject({
            state: 'warning',
            detail: 'Live Captions stopped',
            fix: 'Start',
        });
    });

    it('Windows audio: X-Air OUT 1-2 default, unmuted, 100%', async () => {
        const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
        Object.defineProperty(process, 'platform', { value: 'win32' });
        try {
            audioDevices = [xairOut({ default: '' })];
            await tick(1);
            expect(get('windows-audio')).toMatchObject({
                state: 'critical',
                detail: 'X-Air OUT 1-2 not default',
                fix: 'Set as default',
            });
            audioDevices = [xairOut({ volume_percent: '62.0%' })];
            await checks.fix('windows-audio');
            expect(setDefaultAudioDevice).toHaveBeenCalledWith(
                'BEHRINGER X-AIR\\Device\\OUT 1-2\\Render',
                'all'
            );
            // Re-read straight after the fix.
            expect(get('windows-audio')).toMatchObject({
                state: 'warning',
                detail: 'X-Air OUT 1-2 at 62%, not 100%',
                fix: 'Set to 100%',
            });
            audioDevices = [
                xairOut({ name: 'Speakers', sub_name: 'Realtek(R) Audio' }),
            ];
            jest.setSystemTime(Date.now() + 61000);
            await tick(1);
            expect(get('windows-audio')).toMatchObject({
                state: 'warning',
                detail: 'X-Air driver missing',
            });
            // No devices at all: SoundVolumeView did not answer.
            audioDevices = [];
            jest.setSystemTime(Date.now() + 61000);
            await tick(1);
            expect(get('windows-audio')).toMatchObject({
                state: 'unknown',
                detail: 'SoundVolumeView not answering',
            });
        } finally {
            Object.defineProperty(process, 'platform', platform);
        }
    });

    it('recorder 1 on Master is a warning', async () => {
        settings.recordAudioBus = 'Master';
        await tick(1);
        expect(get('recording-bus')).toMatchObject({
            state: 'warning',
            detail: 'Recorder 1 on Master, not Bus A',
        });
    });

    it('caption key not the stream key: Set key uses the stream key', async () => {
        push.url = 'http://upload.youtube.com/closedcaption?cid=old-key';
        await tick(1);
        expect(get('captions-youtube')).toMatchObject({
            state: 'warning',
            detail: 'Caption key not the stream key',
            fix: 'Set key',
        });
        await checks.fix('captions-youtube');
        expect(setCaptionKey).toHaveBeenCalledWith('abcd-efgh');
    });

    it('sources for the status API carry no stream key', async () => {
        await tick(1);
        const src = checks.sources();
        expect(JSON.stringify(src)).not.toContain('abcd-efgh');
        expect(src.vmixSettings).toMatchObject({
            streamAudioBus: 'Bus A',
            streamOutput: 2,
            recorder1Output: 2,
            youtubeKeySet: true,
        });
        expect(src.liveCaptions.youtube).toMatchObject({
            keySet: true,
            keyMatchesStream: true,
        });
    });

    it('Live Captions events: engine state and YouTube status, no polling', async () => {
        lcEvents.latest.clear();
        lcEvents.latest.set('hello', {
            type: 'hello',
            engine: { state: 'running', error: null },
            youtube: { ...push, url: null },
        });
        await tick(1);
        expect(get('captions-engine')).toMatchObject({
            state: 'ok',
            detail: 'Transcribing',
        });
        expect(get('captions-youtube').detail).toBe('No YouTube caption key');
        lcEvents.latest.set('engine', {
            type: 'engine',
            state: 'error',
            error: 'Google API credentials missing',
        });
        await tick(1);
        expect(get('captions-engine')).toMatchObject({
            state: 'warning',
            detail: 'Google API credentials missing',
            fix: 'Restart',
        });
    });

    it('custom audience display: not used, stopped, FMS, profile', async () => {
        await tick(1);
        expect(get('audience-display').detail).toBe('Not used');
        customAd = true;
        adPhase = 'stopped';
        await tick(1);
        expect(get('audience-display')).toMatchObject({
            state: 'warning',
            detail: 'Stopped',
            fix: 'Start',
        });
        adPhase = 'running';
        adEvents.connected = true;
        adEvents.latest.set('hello', {
            type: 'hello',
            profile: {
                id: 'fsu-roboday',
                name: 'FSU RoboDay',
                source: 'event',
            },
            fms: { connected: true, eventCode: 'MIBIG1' },
        });
        await tick(1);
        expect(get('audience-display')).toMatchObject({
            state: 'ok',
            detail: 'Profile: FSU RoboDay',
        });
        adEvents.latest.set('fms', { type: 'fms', connected: false });
        await tick(1);
        expect(get('audience-display')).toMatchObject({
            state: 'warning',
            detail: 'Not connected to FMS',
        });
    });

    it('YouTube uploads: sign-in, failures, channel', async () => {
        uploaderUsed = true;
        upEvents.connected = true;
        upEvents.latest.set('hello', {
            type: 'hello',
            signin: { signedIn: true, channel: 'FIRST in Michigan' },
            queue: { eventKey: '2026mimarc', counts: { uploaded: 12 } },
        });
        await tick(1);
        expect(get('uploader')).toMatchObject({
            state: 'ok',
            detail: 'FIRST in Michigan, 12 uploaded',
        });
        upEvents.latest.set('queue', {
            type: 'queue',
            counts: { uploaded: 12, failed: 2 },
        });
        await tick(1);
        expect(get('uploader').detail).toBe('2 uploads failed');
        upEvents.latest.set('signin', {
            type: 'signin',
            signedIn: false,
            channel: null,
        });
        await tick(1);
        expect(get('uploader')).toMatchObject({
            state: 'warning',
            detail: 'YouTube sign-in needed',
        });
    });

    it('no caption key in Live Captions', async () => {
        push.url = null;
        await tick(1);
        expect(get('captions-youtube')).toMatchObject({
            state: 'warning',
            detail: 'No YouTube caption key',
        });
    });

    it('official FRC event: caption key problems show without a warning', async () => {
        offSeason = false;
        const alerts: string[] = [];
        checks.on('alert', (r: CheckResult) => alerts.push(r.id));
        push.url = null;
        await tick(1);
        expect(get('captions-youtube')).toMatchObject({
            state: 'unknown',
            detail: 'No YouTube caption key',
            fix: 'Set key',
        });
        push.url = 'http://upload.youtube.com/closedcaption?cid=old-key';
        await tick(1);
        expect(get('captions-youtube')).toMatchObject({
            state: 'unknown',
            detail: 'Caption key not the stream key',
        });
        expect(alerts).not.toContain('captions-youtube');
        // A key that matches is still OK.
        push.url = 'http://upload.youtube.com/closedcaption?cid=abcd-efgh';
        await tick(1);
        expect(get('captions-youtube').state).toBe('ok');
    });

    it('official FTC event: a missing caption key is a warning', async () => {
        offSeason = false;
        ftc = true;
        push.url = null;
        await tick(1);
        expect(get('captions-youtube').state).toBe('warning');
    });

    it('hardware from the status bar pings, list only', async () => {
        const alerts: string[] = [];
        checks.on('alert', (r: CheckResult) => alerts.push(r.id));
        hwPingedAt = 0;
        await tick(1);
        expect(get('hw-camera2')).toMatchObject({
            state: 'unknown',
            detail: 'Not pinged yet',
        });
        hwPingedAt = T0;
        hw.camera2 = false;
        hw.internet = false;
        hw.ip_errors = [
            'AV VLAN has a self-assigned IP (169.254.3.4). Check cable or static IP config.',
            'AV VLAN is disconnected or not found.',
        ];
        await tick(1);
        expect(get('hw-camera2')).toMatchObject({
            state: 'warning',
            detail: 'No reply',
        });
        expect(get('hw-network').state).toBe('critical');
        expect(get('hw-ip')).toMatchObject({
            state: 'critical',
            detail: 'AV VLAN has a self-assigned IP (169.254.3.4) (+1)',
        });
        expect(alerts).toEqual([]);
    });

    it('loudness is judged only while someone talked', async () => {
        const rec = (loudness: any) => {
            matches = [{ level: 'Qualification', matchNumber: 14, loudness }];
            checks.dirty.loudness = true;
        };
        const talk = (lufs: number | null, seconds = 40) => ({
            heard: true,
            seconds,
            lufs,
        });
        const loud = (detail: string, state = 'warning') =>
            expect(get('stream-loudness')).toMatchObject({
                state,
                detail: `Qualification 14: ${detail}`,
            });
        // Measured before talking was tracked, or no mic levels read.
        rec({ lufs: -24.3, truePeak: -3 });
        await tick(1);
        loud('No mic levels', 'unknown');
        // A silent stream with nobody talking: no verdict, not too quiet.
        rec({
            lufs: -40,
            truePeak: -20,
            talk: { heard: true, seconds: 1.2, lufs: null },
        });
        await tick(1);
        loud('Not enough talking', 'unknown');
        // Within 5 LU of -14 is fine, whatever the whole match reads.
        rec({ lufs: -30, truePeak: -2, talk: talk(-18.6) });
        await tick(1);
        loud('-18.6 LUFS, peak -2.0 dBTP', 'ok');
        rec({ lufs: -10, truePeak: -1.5, talk: talk(-9.5) });
        await tick(1);
        loud('-9.5 LUFS, peak -1.5 dBTP', 'ok');
        // Too quiet: the boost to -14.
        rec({ lufs: -30, truePeak: -12, talk: talk(-22.24) });
        await tick(1);
        loud('Too quiet, Stream audio +8.2 dB (-22.2 LUFS, peak -12.0 dBTP)');
        // Judged on the change shown, after the headroom cap: a boost
        // capped to 5 dB or less is no warning (BGRC Q27 on FIMVIDEO3:
        // -20.0 LUFS, peak -3.9 dBTP, +2.9 dB was shown as "Too quiet").
        rec({ lufs: -30, truePeak: -3.9, talk: talk(-20) });
        await tick(1);
        loud('-20.0 LUFS, peak -3.9 dBTP', 'ok');
        rec({ lufs: -30, truePeak: -4.24, talk: talk(-22.24) });
        await tick(1);
        loud('-22.2 LUFS, peak -4.2 dBTP', 'ok');
        rec({ lufs: -30, truePeak: -1, talk: talk(-22.24) });
        await tick(1);
        loud('-22.2 LUFS, peak -1.0 dBTP', 'ok');
        // Capped, and still over 5 dB: a warning with the capped boost.
        rec({ lufs: -30, truePeak: -7.5, talk: talk(-24) });
        await tick(1);
        loud('Too quiet, Stream audio +6.5 dB (-24.0 LUFS, peak -7.5 dBTP)');
        // Exactly 5 dB is fine; just over is not.
        rec({ lufs: -30, truePeak: -20, talk: talk(-19) });
        await tick(1);
        loud('-19.0 LUFS, peak -20.0 dBTP', 'ok');
        rec({ lufs: -30, truePeak: -20, talk: talk(-19.1) });
        await tick(1);
        loud('Too quiet, Stream audio +5.1 dB (-19.1 LUFS, peak -20.0 dBTP)');
        // Too loud: the cut to -14.
        rec({ lufs: -8, truePeak: -1.5, talk: talk(-7.9) });
        await tick(1);
        loud('Too loud, Stream audio \u22126.1 dB (-7.9 LUFS, peak -1.5 dBTP)');
        // Peaking: the cut that brings the peak to -1 dBTP...
        rec({ lufs: -16, truePeak: 0.33, talk: talk(-15) });
        await tick(1);
        loud('Peaking, Stream audio \u22121.4 dB (-15.0 LUFS, peak 0.3 dBTP)');
        // ...or the loudness cut when that is bigger.
        rec({ lufs: -8, truePeak: -0.5, talk: talk(-8) });
        await tick(1);
        loud('Peaking, Stream audio \u22126.0 dB (-8.0 LUFS, peak -0.5 dBTP)');
        // Peaking needs no talking: a fader moves every peak.
        rec({ lufs: -30, truePeak: 0.2 });
        await tick(1);
        loud('Peaking, Stream audio \u22121.2 dB (peak 0.2 dBTP)');
        // Mics live and the stream silent.
        rec({ lufs: -70, truePeak: null, talk: talk(null) });
        await tick(1);
        loud('No stream audio, mics live');
    });

    it('talking is a live mic on the stream bus', async () => {
        await tick(1);
        talkLog.clear();
        const t = Date.now();
        checks.meters.lastAt = t;
        // Ch 1 (a mic) at -20 dBFS.
        checks.meters.latest = [-20, -90, -90, -90];
        checks.noteTalking();
        expect(talkLog.talk).toEqual([[t, t + 1000]]);
        // Ch 3 (DJ) loud, mics idle: not talking, but the mics were read.
        talkLog.clear();
        checks.meters.latest = [-70, -70, -5, -5];
        checks.noteTalking();
        expect(talkLog.talk).toEqual([]);
        expect(talkLog.heard).toEqual([[t, t]]);
        // Talking is read before the fader: a mic turned down, muted or off
        // the stream bus is still someone talking.
        mixer.set('/ch/01/mix/on', 0);
        mixer.set('/ch/01/mix/fader', 0);
        mixer.set('/ch/01/mix/01/level', 0);
        mixer.set('/bus/1/mix/fader', 0);
        checks.dirty.mixer = true;
        await tick(1);
        talkLog.clear();
        checks.meters.latest = [-20, -90, -90, -90];
        checks.noteTalking();
        expect(talkLog.talk).toEqual([[t, t + 1000]]);
    });

    it('the talking gate is at the reference mic gain (+20 dB)', async () => {
        // Ch 1 on In01, its preamp at +44 dB.
        mixer.set('/ch/01/config/insrc', 0);
        mixer.set('/ch/01/preamp/rtnsw', 0);
        mixer.set('/headamp/01/gain', (44 + 12) / 72);
        checks.dirty.mixer = true;
        await tick(1);
        const t = Date.now();
        checks.meters.lastAt = t;
        // -38 dBFS after +44 dB of gain is -62 at +20: not talking.
        talkLog.clear();
        checks.meters.latest = [-38, -90, -90, -90];
        checks.noteTalking();
        expect(talkLog.talk).toEqual([]);
        // At 0 dB of gain, -50 dBFS is -30 at +20: talking.
        mixer.set('/headamp/01/gain', 12 / 72);
        checks.dirty.mixer = true;
        await tick(1);
        talkLog.clear();
        checks.meters.latest = [-50, -90, -90, -90];
        checks.noteTalking();
        expect(talkLog.talk).toEqual([[t, t + 1000]]);
        // A mic fed from a USB return: its trim (0 dB reference).
        mixer.set('/ch/01/preamp/rtnsw', 1);
        mixer.set('/ch/01/preamp/rtntrim', 0.5);
        checks.dirty.mixer = true;
        await tick(1);
        talkLog.clear();
        checks.meters.latest = [-45, -90, -90, -90];
        checks.noteTalking();
        expect(talkLog.talk).toEqual([]);
    });

    // Quiet because nobody talks is never "too quiet"; quiet while someone
    // talks is, with the boost to make, whatever the faders say.
    describe('quiet stream: nobody talking vs turned down', () => {
        // 30 s of mic meter packets (50 ms) at `micDb` on ch 1, and the
        // stream's ebur128 blocks at `streamLufs` over the same 30 s.
        const run = async (micDb: number, streamLufs: number) => {
            await tick(1);
            talkLog.clear();
            const T = 5_000_000;
            for (let k = 0; k <= 600; k += 1) {
                checks.meters.lastAt = T + k * 50;
                checks.meters.latest = [micDb, -90, -90, -90];
                checks.noteTalking();
            }
            const blocks = Array.from({ length: 300 }, (_, k) => ({
                t: (k + 1) / 10,
                m: streamLufs,
            }));
            const talk = talkLoudness(
                blocks,
                [{ wallStart: T, seconds: 30 }],
                talkLog
            );
            return loudnessVerdict({ lufs: streamLufs, truePeak: -20, talk });
        };

        it('talking, Bus 1 nearly off: too quiet, +dB to -14', async () => {
            mixer.set('/bus/1/mix/fader', 0.05);
            mixer.set('/ch/01/mix/01/level', 0.05);
            checks.dirty.mixer = true;
            expect(await run(-18, -34)).toEqual({
                state: 'warning',
                detail: 'Too quiet, Stream audio +19.0 dB (-34.0 LUFS, peak -20.0 dBTP)',
            });
        });

        it('talking, mic send turned down: the boost to -14', async () => {
            mixer.set('/ch/01/mix/01/level', 0.1);
            checks.dirty.mixer = true;
            const v = await run(-18, -30);
            expect(v.state).toBe('warning');
            expect(v.detail).toMatch(/^Too quiet, Stream audio \+16\.0 dB/);
        });

        it('nobody talking, levels normal: no verdict', async () => {
            // Match sounds keep the stream at -14 LUFS; mics idle.
            expect(await run(-70, -14)).toEqual({
                state: 'unknown',
                detail: 'Not enough talking',
            });
            // A silent stream with nobody talking: still no verdict.
            expect((await run(-70, -60)).state).toBe('unknown');
        });
    });

    it('mic meters run while vMix records, not only in a match', async () => {
        const start = jest.spyOn(checks.meters, 'start');
        const stop = jest.spyOn(checks.meters, 'stop');
        vmix = fimVmix({ recording: 'True' });
        await tick(1);
        expect(start).toHaveBeenCalledWith('192.168.25.13');
        vmix = fimVmix({ recording: 'False' });
        stop.mockClear();
        await tick(1);
        expect(stop).toHaveBeenCalled();
    });

    it('no sound at match start', async () => {
        match = { label: 'Q15', level: 'Qualification' };
        await tick(5);
        expect(get('match-buzzer')).toMatchObject({
            state: 'warning',
            detail: 'No sound at Q15 start',
        });
    });

    it('Ignore stops alerting for 6 h, then lapses', async () => {
        vmix = fimVmix({ streaming: 'False' });
        match = { label: 'Q14', level: 'Qualification' };
        const alerts: string[] = [];
        checks.on('alert', (r: CheckResult) => alerts.push(r.id));
        await tick(7);
        expect(alerts).toContain('stream-match');
        checks.ignore('stream-match');
        expect(get('stream-match').ignoredUntil).toBe(
            Date.now() + 6 * 3600 * 1000
        );
        jest.setSystemTime(Date.now() + 6 * 3600 * 1000 + 1000);
        await tick(1);
        expect(get('stream-match').ignoredUntil).toBeNull();
    });
});

describe('vMix autosave', () => {
    const dest = (url: string, key: string) =>
        `&lt;Stream&gt;${key}&lt;/Stream&gt;&lt;URL&gt;${url}&lt;/URL&gt;`;
    const xml = `<XML><StreamingSettings SelectedIndex="1">
<StreamingSetting><AudioChannel>0</AudioChannel><Source>0</Source></StreamingSetting>
<StreamingSetting><Destination0>${dest(
        'rtmp://a.rtmp.youtube.com/live2',
        'yt-key'
    )}</Destination0><AudioChannel>10</AudioChannel><AudioChannel1>0</AudioChannel1><Source>1</Source></StreamingSetting>
</StreamingSettings>
<RecordingSettings><AudioChannel>10</AudioChannel><Channel>1</Channel></RecordingSettings>
<RecordingSettings2><Channel>0</Channel></RecordingSettings2>
<OutputsExternal><Overlay7>1</Overlay7></OutputsExternal>
<OutputsExternal2><Overlay0>1</Overlay0><Overlay7>0</Overlay7></OutputsExternal2></XML>`;

    it('reads the selected stream profile and Output 2 overlays', () => {
        expect(parseStreamSettings(xml)).toEqual({
            audioBus: 'Bus A',
            output: 2,
            output2Overlays: [1],
            youtubeKey: 'yt-key',
            recordOutput: 2,
            recordAudioBus: 'Bus A',
        });
    });
});

describe('X-Air OSC', () => {
    it('decodes int, float and string replies', () => {
        const msg = (addr: string, tag: string, arg: Buffer) => {
            const pad = (b: Buffer) =>
                Buffer.concat([b, Buffer.alloc(4 - (b.length % 4))]);
            return Buffer.concat([
                pad(Buffer.from(addr)),
                pad(Buffer.from(tag)),
                arg,
            ]);
        };
        const i = Buffer.alloc(4);
        i.writeInt32BE(1);
        expect(decodeReply(msg('/ch/03/mix/on', ',i', i))).toEqual({
            address: '/ch/03/mix/on',
            value: 1,
        });
        const f = Buffer.alloc(4);
        f.writeFloatBE(0.75);
        expect(
            decodeReply(msg('/ch/03/mix/fader', ',f', f))?.value
        ).toBeCloseTo(0.75);
        const s = Buffer.concat([Buffer.from('DJ L'), Buffer.alloc(4)]);
        expect(decodeReply(msg('/ch/03/config/name', ',s', s))?.value).toBe(
            'DJ L'
        );
    });

    it('converts levels with the X-Air fader law', () => {
        expect(levelToDb(0.75)).toBe(0);
        expect(levelToDb(0.5)).toBe(-10);
        expect(levelToDb(0)).toBe(-Infinity);
    });
});
