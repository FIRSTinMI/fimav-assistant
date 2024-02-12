import Store from 'electron-store';

export type AppConfig = {
    signalrUrl: unknown;
    apiKey: unknown;
    liveCaptionsDownloadBase: string;
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
        },
        migrations: {
            '0.0.4': (store) => {
                store.set(
                    'liveCaptionsDownloadBase',
                    'https://github.com/Filip-Kin/live-captions/releases'
                );
                if (!store.has('apiKey')) store.set('apiKey', null);
            },
        },
    }) as Store<AppConfig>;
}

let store: Store<AppConfig> | undefined;

export function getStore(): Store<AppConfig> {
    if (store === undefined) store = createStore();
    return store;
}
