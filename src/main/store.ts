import Store from 'electron-store';

export type AppConfig = {
    signalrUrl: unknown;
    apiKey: unknown;
    liveCaptionsDownloadBase: string;
    runOnStartup: boolean;
    currentStep: number;
    stepsStartedAt: number;
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
        },
    }) as Store<AppConfig>;
}

let store: Store<AppConfig> | undefined;

export function getStore(): Store<AppConfig> {
    if (store === undefined) store = createStore();
    return store;
}
