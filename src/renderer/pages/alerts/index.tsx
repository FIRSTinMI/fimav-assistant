import { LoadingOutlined } from "@ant-design/icons";
import { Button, Space, Spin } from "antd";
import AlertsResponse from "models/AlertsResponse";
import { useCallback, useEffect, useState } from "react";


const Alerts = () => {
  if (!window.electron) return;
  const [alerts, setAlerts] = useState<AlertsResponse | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  useEffect(() => {
    window.electron.ipcRenderer.on('alerts:alerts', (alerts: AlertsResponse) => {
      setAlerts(alerts);
      setIsLoading(false);
      if (alerts.alerts.length == 0) {
        window.electron.ipcRenderer.sendMessage('alerts:closeWindow', []);
      }
    });
    window.electron.ipcRenderer.sendMessage('alerts:getAlerts', []);
  }, []);

  const dismissAlert = useCallback((alertId: string) => {
    setIsLoading(true);
    window.electron.ipcRenderer.sendMessage('alerts:dismissAlert', [alertId]);
  }, []);

  return (<>
    {isLoading && (
      <div style={{
        position: 'fixed',
        height: '100vh',
        width: '100vw',
        left: 0,
        top: 0,
        background: '#fffc',
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center'
      }}>
        <Spin indicator={<LoadingOutlined style={{ fontSize: 48 }} spin />} />
      </div>
    )}
    <Space direction="vertical" style={{ textAlign: "left" }}>
      {alerts && alerts.alerts.map((alert) => (
        <div key={alert.id}>
          <div dangerouslySetInnerHTML={{ __html: alert.content }}></div>
          <div style={{ textAlign: 'center' }}>
            <Button type="text" danger onClick={() => dismissAlert(alert.id)}>Dismiss</Button>
          </div>
        </div>
      ))}
    </Space>
    </>)
}

export default Alerts;