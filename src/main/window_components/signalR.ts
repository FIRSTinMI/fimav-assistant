import { HubConnection, HubConnectionBuilder } from '@microsoft/signalr';
import log from 'electron-log';
import Store from 'electron-store';
import { AppConfig } from 'main/store';
import { SetPendingAlerts } from '../events/Alerts';
import { signalrToElectronLog } from '../util';

let signalRConnection: HubConnection | null = null;

export default function setupSignalR(
    store: Store<AppConfig>,
    createAlertsWindowCallback: () => void
) {
    if (signalRConnection != null)
        throw new Error('SignalR has already been initialized');

    signalRConnection = new HubConnectionBuilder()
        .withUrl(store.get('signalrUrl') as string, {
            accessTokenFactory: () => store.get('apiKey') as string,
        })
        .withAutomaticReconnect({
            nextRetryDelayInMilliseconds(retryContext) {
                log.warn('Retrying SignalR connection...');
                return Math.min(
                    2_000 * retryContext.previousRetryCount,
                    60_000
                );
            },
        })
        .configureLogging({
            log(logLevel, message) {
                signalrToElectronLog(log, logLevel, message);
            },
        })
        .build();

    signalRConnection.onclose((err) =>
        log.error('SignalR connection has been lost', err)
    );

    signalRConnection.on('PendingAlerts', (newAlerts) => {
        SetPendingAlerts({
            alerts: newAlerts.map((a: any) => ({
                id: a.id,
                content: a.content,
            })),
        });
        createAlertsWindowCallback();
    });

    signalRConnection
        .start()
        .then(() => log.info('Connection to SignalR established'))
        .catch((err) => log.error('Error connecting to SignalR', err));
}

function dismissAlert(id: string): void {
    if (signalRConnection == null) return;

    log.info(signalRConnection.state);

    signalRConnection.invoke('MarkAlertRead', id).then(() => {
        log.info('finished dismissing');
        return undefined;
    }).catch((err) => {
        log.error('Failed to dismiss alert', err);
    });
}

export { dismissAlert };
