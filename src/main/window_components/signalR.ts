import { HubConnection, HubConnectionBuilder } from '@microsoft/signalr';
import log from 'electron-log';
import Store from 'electron-store';
import { AppConfig } from 'main/store';
import { app } from 'electron';
import { hostname } from 'os';
import { EquipmentLogCategory, EquipmentLogDetails } from '../../models/EquipmentLog';
import { SetPendingAlerts } from '../events/Alerts';
import { signalrToElectronLog } from '../util';

let signalRConnection: HubConnection | null = null;

export default function setupSignalR(
    store: Store<AppConfig>,
    createAlertsWindowCallback: () => void
): Promise<void> {
    return new Promise((resolve, reject) => {
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
            if (newAlerts.length > 0) createAlertsWindowCallback();
        });

        signalRConnection
            .start()
            .then(() => {
                log.info('Connection to SignalR established');
                sendAppInfo();
                return resolve();
            })
            .catch((err) => {
                log.error('Error connecting to SignalR', err);
                return reject(err);
            });
    });
}

/*
* Send the app version and hostname to the server
*/
function sendAppInfo() {
    invoke('AppInfo', {
        Version: app.getVersion(),
        Hostname: hostname()
    })
}

/*
* This function is used to invoke a SignalR event and wait for a response.
* @param eventName The name of the event to invoke
* @param eventResponse The name of the event to listen for the response
* @param args Any arguments to pass to the event
* @returns A promise that resolves with the response from the event
*/
function invokeExpectResponse<t>(eventName: string, eventResponse: string, ...args: any[]): Promise<t> {
    return new Promise<t>((resolve, reject) => {
        if (signalRConnection == null) {
            reject();
            return;
        }

        const listener = (response: t) => {
            signalRConnection?.off(eventResponse, listener);
            resolve(response);
        }
        signalRConnection.on(eventResponse, listener);

        signalRConnection.invoke(eventName, ...args).catch((err) => {
            log.error(`Failed to invoke '${eventName}'`, err);
            reject(err);
        });
    });
}

/*
* This function is used to invoke a SignalR event without waiting for a response.
* @param eventName The name of the event to invoke
* @param args Any arguments to pass to the event
*/
function invoke(eventName: string, ...args: any[]): void {
    if (signalRConnection == null) return;

    signalRConnection.invoke(eventName, ...args).catch((err) => {
        log.error(`Failed to invoke '${eventName}'`, err);
    });
}

/*
* This function is used to invoke a SignalR event without waiting for a response.
* @param eventName The name of the event to invoke
* @param args Any arguments to pass to the event
*/
function invokeAsync(eventName: string, ...args: any[]): Promise<any> {
    if (signalRConnection == null) return Promise.resolve();

    return signalRConnection.invoke(eventName, ...args).catch((err) => {
        log.error(`Failed to invoke '${eventName}'`, err);
    });
}

/**
 * This function calls a SignalR event to log a message.
 * @param message Message to log
 * @param opts information about the log
 * @returns void
 */
function invokeLog(message: string, opts: EquipmentLogDetails = { category: EquipmentLogCategory.General }): void {
    if (signalRConnection == null) return;

    signalRConnection.invoke('WriteLog', message, opts).catch((err) => {
        log.error(`Failed to invoke 'WriteLog'`, err);
    });
}

/*
* This function is used to register a listener for a SignalR event.
* @param eventName The name of the event to listen for
* @param listener The function to call when the event is received
*/
function registerListener<t>(eventName: string, listener: (response: t) => void): void { // eslint-disable-line
    if (signalRConnection == null) return;

    signalRConnection.on(eventName, listener);
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

export { dismissAlert, invokeExpectResponse, invoke, invokeAsync, invokeLog, registerListener };
