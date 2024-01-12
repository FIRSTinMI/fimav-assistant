import { HubConnection, HubConnectionBuilder, LogLevel } from "@microsoft/signalr";
import log from 'electron-log';
import Store from 'electron-store';
import { SetPendingAlerts } from '../events/Alerts';
import { AppConfig } from "main/store";

let signalRConnection: HubConnection | null = null;

export default function setupSignalR(store: Store<AppConfig>, createAlertsWindowCallback: () => void) {
  if (signalRConnection != null) throw new Error('SignalR has already been initialized');

  signalRConnection = new HubConnectionBuilder()
    .withUrl(
      store.get('signalrUrl') as string,
      {
        accessTokenFactory: () => store.get('apiKey') as string
      })
    .withAutomaticReconnect({
      nextRetryDelayInMilliseconds(retryContext) {
        log.warn('Retrying SignalR connection...')
        if (retryContext.previousRetryCount > 10) {
          return null;
        }

        return Math.min(2_000 * retryContext.previousRetryCount, 60_000);
      },
    })
    .configureLogging({
      log(logLevel, message) {
        switch (logLevel) {
          case LogLevel.Trace:
            log.info(message);
            break;
          case LogLevel.Debug:
            log.info(message);
            break;
          case LogLevel.Information:
            log.info(message);
            break;
          case LogLevel.Warning:
            log.warn(message);
            break;
          case LogLevel.Error:
            log.error(message);
            break;
          case LogLevel.Critical:
            log.error(message);
            break;
          case LogLevel.None:
            log.info(message);
            break;
        }
      },
    }).build();

  signalRConnection.onclose((err) => log.error('SignalR connection has been lost', err));

  signalRConnection.on('PendingAlerts', (newAlerts) => {
    SetPendingAlerts({ alerts: newAlerts.map((a: any) => ({ id: a.id, content: a.content })) });
    createAlertsWindowCallback();
  });

  signalRConnection.start()
    .then(() => log.info('Connection to SignalR established'))
    .catch((err) => log.error('Error connecting to SignalR', err));
}

function dismissAlert(id: string): void {
  if (signalRConnection == null) return;

  log.info(signalRConnection.state);

  signalRConnection.invoke('MarkAlertRead', id).then(() => {
    log.info('finished dismissing');
  });
}

export { dismissAlert };