import Store from 'electron-store';

export type AppConfig = {
    signalrUrl: unknown;
    apiKey: unknown;
    liveCaptionsDownloadBase: string;
    youtubeUploaderDownloadBase: string;
    audienceDisplayDownloadBase: string;
    runOnStartup: boolean;
    currentStep: number;
    stepsStartedAt: number;
    vmixApi: {
        baseUrl: string;
        username: string;
        password: string;
    };
    // Last event we successfully pushed stream keys to vMix for. vMix can't be
    // read back for the key, so we track "did we set it for this event" here.
    vmixStreamKeys: {
        eventCode: string;
        eventName: string;
        setAt: number;
    } | null;
    // Saved alliance-selection composite geometry (tunable live, then saved).
    vmixComposite: {
        layer: number;
        zoom: number;
        panX: number;
        panY: number;
    };
    autoAv: {
        fileNameMode: 'in-season' | 'off-season';
        // Manual event name; when set it overrides whatever FMS reports
        eventNameOverride: string;
        // program:code of the event last seen. The name is only refilled when
        // this changes, so a hand edit sticks for the rest of the event (see
        // AutoAV.noteEvent).
        lastEventKey: string;
        // Destination folder for renamed match videos; blank = alongside the
        // vMix recording
        saveFolder: string;
        // The actual event folder the last recording was filed into, so the tab
        // can show the real path even with no configured save folder
        lastSaveFolder: string;
        // Auto-cut the dead time out of each recording after it's filed,
        // producing a clean uploadable copy in a "Cut" subfolder.
        autoCut: boolean;
    };
    // FRC / FTC override from Settings; 'auto' follows detection.
    program: 'auto' | 'frc' | 'ftc';
    // FRC off-season: which audience display is used, the official FMS one
    // or our custom one (Settings; back to 'fms' on every new event). It
    // decides whether the custom display runs, which display the vMix input
    // shows and whose Bitfocus triggers the tab edits.
    frcAudienceDisplay: 'fms' | 'customAd';
    // Port Bitfocus Companion's web server listens on, on this machine
    // (FIM's carts use 8888; some AV machines run it elsewhere).
    companionPort: number;
    // Stream checks: check id -> epoch ms until which "Ignore" holds (6 h).
    checks: { ignoredUntil: Record<string, number> };
    // FTC Live scorekeeper: where it is, which event, and the Bitfocus
    // triggers FIM-AV presses for it.
    ftc: {
        address: string;
        eventCode: string;
        automations: boolean;
        triggers: Record<string, { page: number; row: number; column: number }>;
        // Recording length after MATCH_START: the match (DECODE: 30 s auto +
        // 8 s transition + 2:00 teleop) plus a few seconds. FTC Live sends no
        // match-end event, and off-season events can change the timing.
        matchSeconds: number;
        tailSeconds: number;
    };
    // YouTube + TBA upload settings for the Upload tab. Stored here only, and
    // pushed to the youtube-tba-upload process (POST /api/upload/config) when
    // it starts, when it switches event and on every save. The uploader never
    // serves the credentials back.
    upload: {
        // TBA event key videos are filed and submitted under (e.g. 2026midet).
        // Empty = season year + the FMS event code.
        tbaEventKey: string;
        // TBA event trusted-API credentials
        tbaAuthId: string;
        tbaSecret: string;
        // FTC: The Orange Alliance submission (FTC's TBA)
        toaApiKey: string;
        toaEventKey: string;
        // Title / description templates the uploader fills per match
        titleTemplate: string;
        descriptionTemplate: string;
        // Thumbnail image applied to each upload
        thumbnailPath: string;
        // YouTube visibility for uploaded videos
        visibility: 'PUBLIC' | 'UNLISTED' | 'PRIVATE';
    };
};

// Default title and description templates. This app owns them: the uploader
// is sent the stored templates whenever it starts or switches event, so its
// own built-in defaults never reach a video. The uploader drops a line whose
// team slot is not there, so the third-team lines vanish at FTC events (two
// teams per alliance) and the same template serves FRC and FTC.
export const DEFAULT_TITLE_TEMPLATE =
    '{video_prefix} {match_level} Match {match_number}{play_suffix}';
export const DEFAULT_DESCRIPTION_TEMPLATE = [
    '{title}',
    '',
    'Red Alliance:',
    '- {red[0].number} {red[0].name}',
    '- {red[1].number} {red[1].name}',
    '- {red[2].number} {red[2].name}',
    '',
    'Blue Alliance:',
    '- {blue[0].number} {blue[0].name}',
    '- {blue[1].number} {blue[1].name}',
    '- {blue[2].number} {blue[2].name}',
].join('\n');

export function createStore(): Store<AppConfig> {
    return new Store({
        schema: {
            signalrUrl: {
                type: 'string',
                default: 'https://fim-admin.evandoes.dev/AssistantHub',
            },
            apiKey: {
                type: ['string', 'null'],
                default: null,
            },
            liveCaptionsDownloadBase: {
                type: 'string',
                default: 'https://github.com/Filip-Kin/live-captions/releases',
            },
            youtubeUploaderDownloadBase: {
                type: 'string',
                default:
                    'https://github.com/Filip-Kin/youtube-tba-upload/releases',
            },
            audienceDisplayDownloadBase: {
                type: 'string',
                default:
                    'https://github.com/Filip-Kin/audience-display/releases',
            },
            runOnStartup: {
                type: 'boolean',
                default: true,
            },
            currentStep: {
                type: 'number',
                default: 0,
            },
            stepsStartedAt: {
                type: 'number',
                default: 0,
            },
            vmixApi: {
                type: 'object',
                properties: {
                    baseUrl: {
                        type: 'string',
                        default: 'http://127.0.0.1:8088/api',
                    },
                    username: {
                        type: 'string',
                        default: 'user',
                    },
                    password: {
                        type: 'string',
                        default: 'pass',
                    },
                },
            },
            vmixStreamKeys: {
                type: ['object', 'null'],
                default: null,
            },
            vmixComposite: {
                type: 'object',
                // Perfect-fit values for the official AD camera box, measured
                // live (X133.6 Y29.2 W844.4 H475 in 1920x1080): zoom = W/1920,
                // panX = (centerX-960)/960, panY = (540-centerY)/540.
                default: {
                    layer: 1,
                    zoom: 0.4398,
                    panX: -0.421,
                    panY: 0.5061,
                },
            },
            autoAv: {
                type: 'object',
                properties: {
                    fileNameMode: {
                        type: 'string',
                        default: 'in-season',
                    },
                    eventNameOverride: {
                        type: 'string',
                        default: '',
                    },
                    lastEventKey: {
                        type: 'string',
                        default: '',
                    },
                    saveFolder: {
                        type: 'string',
                        default: '',
                    },
                    lastSaveFolder: {
                        type: 'string',
                        default: '',
                    },
                    autoCut: {
                        type: 'boolean',
                        default: false,
                    },
                },
            },
            program: { type: 'string', default: 'auto' },
            frcAudienceDisplay: { type: 'string', default: 'fms' },
            companionPort: { type: 'number', default: 8888 },
            checks: {
                type: 'object',
                properties: {
                    ignoredUntil: { type: 'object', default: {} },
                },
                default: { ignoredUntil: {} },
            },
            ftc: {
                type: 'object',
                properties: {
                    address: { type: 'string', default: '' },
                    eventCode: { type: 'string', default: '' },
                    automations: { type: 'boolean', default: true },
                    triggers: { type: 'object', default: {} },
                    matchSeconds: { type: 'number', default: 158 },
                    tailSeconds: { type: 'number', default: 5 },
                },
                default: {
                    address: '',
                    eventCode: '',
                    automations: true,
                    triggers: {},
                    matchSeconds: 158,
                    tailSeconds: 5,
                },
            },
            upload: {
                type: 'object',
                properties: {
                    tbaEventKey: { type: 'string', default: '' },
                    tbaAuthId: { type: 'string', default: '' },
                    tbaSecret: { type: 'string', default: '' },
                    toaApiKey: { type: 'string', default: '' },
                    toaEventKey: { type: 'string', default: '' },
                    titleTemplate: {
                        type: 'string',
                        default: DEFAULT_TITLE_TEMPLATE,
                    },
                    descriptionTemplate: {
                        type: 'string',
                        default: DEFAULT_DESCRIPTION_TEMPLATE,
                    },
                    thumbnailPath: { type: 'string', default: '' },
                    visibility: { type: 'string', default: 'UNLISTED' },
                },
                default: {
                    tbaAuthId: '',
                    tbaSecret: '',
                    toaApiKey: '',
                    toaEventKey: '',
                    titleTemplate: DEFAULT_TITLE_TEMPLATE,
                    descriptionTemplate: DEFAULT_DESCRIPTION_TEMPLATE,
                    thumbnailPath: '',
                    visibility: 'UNLISTED',
                },
            },
        },
        migrations: {
            '0.0.4': (store) => {
                store.set(
                    'liveCaptionsDownloadBase',
                    'https://github.com/Filip-Kin/live-captions/releases'
                );
                if (!store.has('apiKey')) store.set('apiKey', null);
            },
            '0.0.6': (store) => {
                store.set('runOnStartup', true);
            },
            '0.0.11': (store) => {
                store.set('currentStep', 0);
                store.set('stepsStartedAt', 0);
            },
            '0.0.17': (store) => {
                store.set('vmixApi', {
                    baseUrl: 'http://127.0.0.1:8000/api',
                    username: 'user',
                    password: 'pass',
                });
            },
            '0.0.29': (store) => {
                store.set('autoAv.fileNameMode', 'in-season');
            },
            // vMix serves its web API on 8088 by default; the old 8000 default
            // was a placeholder that never matched a stock vMix. Repoint any
            // install still on it.
            '2026.2.3': (store) => {
                const vmix = store.get('vmixApi') as
                    | AppConfig['vmixApi']
                    | undefined;
                if (vmix?.baseUrl === 'http://127.0.0.1:8000/api') {
                    store.set('vmixApi', {
                        ...vmix,
                        baseUrl: 'http://127.0.0.1:8088/api',
                    });
                }
            },
            // Seed the Upload tab's settings for installs that predate it.
            '2026.3.3': (store) => {
                const existing =
                    (store.get('upload') as Partial<AppConfig['upload']>) ?? {};
                store.set('upload', {
                    tbaAuthId: existing.tbaAuthId ?? '',
                    tbaSecret: existing.tbaSecret ?? '',
                    titleTemplate:
                        existing.titleTemplate || DEFAULT_TITLE_TEMPLATE,
                    descriptionTemplate:
                        existing.descriptionTemplate ||
                        DEFAULT_DESCRIPTION_TEMPLATE,
                    thumbnailPath: existing.thumbnailPath ?? '',
                    visibility: existing.visibility ?? 'UNLISTED',
                });
            },
        },
    }) as Store<AppConfig>;
}

let store: Store<AppConfig> | undefined;

export function getStore(): Store<AppConfig> {
    if (store === undefined) store = createStore();
    return store;
}
