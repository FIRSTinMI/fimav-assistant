import http from 'http';
import startStatusApi, { STATUS_API_PORT } from '../main/api/server';

jest.mock('electron-log', () => ({ info: jest.fn(), error: jest.fn() }));
jest.mock('../main/addons/hw-ping', () => ({
    Instance: {
        currentStatus: {
            camera1: true,
            camera2: false,
            mixer: true,
            switch: true,
            internet: true,
            errors: [],
            ip_errors: [],
            ip_warnings: [],
        },
    },
}));
jest.mock('../main/addons/autoav', () => ({
    Instance: {
        getStatus: () => ({
            running: true,
            saveFolder: null,
            currentEvent: { name: 'Test', code: 'TEST' },
        }),
        ftcRecorderSummary: () => ({
            recording: true,
            folder: null,
            waitingForScores: [{ match: 'Q4', field: 2, startedAt: 1 }],
            pendingVideos: ['Q4'],
        }),
        isFtc: () => true,
        runsCustomAd: () => false,
    },
}));
jest.mock('../main/addons/ftc-scorekeeper', () => ({
    Instance: {
        getStatus: () => ({
            address: '127.0.0.1:8080',
            connected: true,
            eventCode: 'fimavtest',
        }),
    },
}));
jest.mock('../main/addons/upload-helper', () => ({
    __esModule: true,
    default: {
        PORT: 8807,
        Instance: {
            isRunning: () => true,
            getPhase: () => 'running',
            getVersion: () => '0.1.11',
            eventKey: () => 'TEST',
        },
    },
}));
jest.mock('../main/addons/audience-display', () => ({
    __esModule: true,
    default: {
        Instance: {
            isRunning: () => false,
            getPhase: () => 'stopped',
            getVersion: () => '26.7.6',
        },
    },
}));
jest.mock('../main/bitfocus', () => ({
    companionUrl: () => 'http://127.0.0.1:8888',
    CUSTOM_AD_URL: 'http://127.0.0.1:3001',
    readCustomAd: jest.fn(),
    readFmsAutomation: jest.fn(),
}));
jest.mock('../main/checks/engine', () => ({
    __esModule: true,
    default: { Instance: { list: () => [], sources: () => ({}) } },
}));
jest.mock('../main/store', () => ({
    getStore: () => ({ get: (_k: string, d: unknown) => d }),
}));

// jsdom has neither AbortSignal.timeout nor Response (Electron's main
// process has both); minimal stand-ins are enough here.
if (!(AbortSignal as any).timeout) {
    (AbortSignal as any).timeout = () => new AbortController().signal;
}
const reply = (body: unknown) => ({
    ok: true,
    status: 200,
    json: async () => body,
});

// The uploader's state carries its settings, secrets included.
const realFetch = global.fetch;
global.fetch = jest.fn(async (url: any) => {
    const u = String(url);
    if (u.startsWith('http://127.0.0.1:8807/api/health'))
        return reply({ signed_in: true, channel_name: 'FIM', program: 'ftc' });
    if (u.startsWith('http://127.0.0.1:8807/api/upload/state'))
        return reply({
            config: { tba_secret: 'TBASECRET', toa_api_key: 'TOAKEY' },
            videos: {
                a: { status: 'uploaded' },
                b: { status: 'uploaded' },
                c: { status: 'queued' },
            },
        });
    if (u.startsWith('http://127.0.0.1:8888')) return reply('ok');
    return realFetch(url);
}) as any;
jest.mock('../main/addons/live-captions', () => ({
    Instance: {
        isRunning: () => true,
        getPhase: () => 'running',
        getVersion: () => '1.2.3',
    },
}));
jest.mock('../main/recordings/matchStore', () => ({ listMatches: () => [] }));
jest.mock('../main/vmixBandwidth', () => ({
    __esModule: true,
    default: async () => ({
        supported: true,
        streams: [
            {
                index: 1,
                liveKbps: 6000,
                targetKbps: 6000,
                maxrateKbps: 6000,
                destination: 'YouTube (primary)',
                rtmpUrl: 'rtmp://a.rtmp.youtube.com/live2/SECRETKEY',
            },
        ],
    }),
}));

const get = (path: string) =>
    new Promise<{ code: number; body: any }>((resolve, reject) => {
        http.get(`http://127.0.0.1:${STATUS_API_PORT}${path}`, (res) => {
            let data = '';
            res.on('data', (c) => {
                data += c;
            });
            res.on('end', () =>
                resolve({ code: res.statusCode ?? 0, body: JSON.parse(data) })
            );
        }).on('error', reject);
    });

describe('status API', () => {
    let server: http.Server;
    beforeAll(async () => {
        server = startStatusApi({
            vmixStatus: async () => ({
                reachable: true,
                recording: false,
                streaming: true,
                keyValidation: {
                    checked: true,
                    match: true,
                    cloudKeys: ['SECRETKEY'],
                    runningKeys: ['SECRETKEY'],
                },
            }),
        });
        await new Promise((resolve) => {
            server.on('listening', resolve);
        });
    });
    afterAll(
        () =>
            new Promise((resolve) => {
                server.close(resolve);
            })
    );

    it('serves each subsystem', async () => {
        expect((await get('/api/status/network')).body.mixer).toBe(true);
        expect((await get('/api/status/vmix')).body).toEqual({
            reachable: true,
            recording: false,
            streaming: true,
        });
        expect((await get('/api/status/autoav')).body.running).toBe(true);
        expect((await get('/api/status/captions')).body.version).toBe('1.2.3');
    });

    it('keeps stream keys out of responses', async () => {
        const { body } = await get('/api/status/stream');
        expect(JSON.stringify(body)).not.toContain('SECRETKEY');
        expect(body.streams[0].liveKbps).toBe(6000);
        expect(body.keyValidation).toEqual({ checked: true, match: true });
    });

    it('combines everything at /api/status', async () => {
        const { body } = await get('/api/status');
        expect(Object.keys(body).sort()).toEqual(
            [
                'autoav',
                'captions',
                'checks',
                'companion',
                'display',
                'ftc',
                'network',
                'sources',
                'stream',
                'upload',
                'vmix',
            ].sort()
        );
    });

    it('serves FTC, uploader, display and Companion status', async () => {
        const ftc = (await get('/api/status/ftc')).body;
        expect(ftc.eventCode).toBe('fimavtest');
        expect(ftc.recorder.waitingForScores[0].match).toBe('Q4');
        const upload = (await get('/api/status/upload')).body;
        expect(upload).toMatchObject({
            running: true,
            version: '0.1.11',
            signedIn: true,
            queue: { uploaded: 2, queued: 1 },
        });
        expect(JSON.stringify(upload)).not.toMatch(/TBASECRET|TOAKEY/);
        expect((await get('/api/status/display')).body.selected).toBe(false);
        const companion = (await get('/api/status/companion')).body;
        expect(companion).toMatchObject({
            reachable: true,
            triggerSource: 'ftc',
            automations: true,
        });
    });

    it('404s unknown and prototype names', async () => {
        expect((await get('/api/status/nope')).code).toBe(404);
        expect((await get('/api/status/constructor')).code).toBe(404);
    });
});
