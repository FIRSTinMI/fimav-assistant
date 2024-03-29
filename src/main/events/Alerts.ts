import { getAlertsWindow } from '../window_components/alertsWindow';
import AlertsResponse from '../../models/AlertsResponse';

let pendingAlerts: AlertsResponse = { alerts: [] };

export function SetPendingAlerts(alerts: AlertsResponse) {
    pendingAlerts = alerts;
    const alertsWindow = getAlertsWindow();
    if (alertsWindow) alertsWindow.webContents.send('alerts:alerts', alerts);
}

export default function Alerts(): AlertsResponse {
    return pendingAlerts;
}
