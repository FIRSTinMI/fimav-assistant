import Store from 'electron-store';

export type AppConfig = {
    signalrUrl: unknown;
    apiKey: unknown;
    liveCaptionsDownloadBase: string;
    runOnStartup: boolean;
    currentStep: number;
    stepsStartedAt: number;
    vmixApi: {
        baseUrl: string;
        username: string;
        password: string
    };
    autoAv: {
        fileNameMode: 'in-season' | 'off-season'
    }
};

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
                        default: 'http://127.0.0.1:8000/api'
                    },
                    username: {
                        type: 'string',
                        default: 'user'
                    },
                    password: {
                        type: 'string',
                        default: 'pass'
                    }
                }
            },
            autoAv: {
                type: 'object',
                properties: {
                    fileNameMode: {
                        type: 'string',
                        default: 'in-season'
                    }
                }
            }
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
                    password: 'pass'
                });
            },
            '0.0.29': (store) => {
                store.set('autoAv.fileNameMode', 'in-season');
            }
        },
    }) as Store<AppConfig>;
}

let store: Store<AppConfig> | undefined;

export function getStore(): Store<AppConfig> {
    if (store === undefined) store = createStore();
    return store;
}
