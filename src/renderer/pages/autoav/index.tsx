import { LoadingOutlined } from '@ant-design/icons';
import { Button, Empty, Space, Spin } from 'antd';
import { useCallback, useEffect, useRef, useState } from 'react';

import { AutoAVSettings } from 'main/addons/autoav';

function AutoAVIndex() {
    const [settings, setSettings] = useState<AlertsResponse | null>(null);
    const [isLoading, setIsLoading] = useState<boolean>(true);

    useEffect(() => {
        if (!window.electron) return;
        window.electron.ipcRenderer.on(
            'autoav:settings',
            (resp: AutoAVSettings) => {
                setSettings(resp);
                setIsLoading(false);
            }
        );
        window.electron.ipcRenderer.sendMessage('autoav:getSettings');
    }, []);

    return window.electron && (
        <>
            {isLoading ? (
                <div
                    style={{
                        position: 'fixed',
                        height: '100vh',
                        width: '100vw',
                        left: 0,
                        top: 0,
                        background: '#fffc',
                        display: 'flex',
                        justifyContent: 'center',
                        alignItems: 'center',
                    }}
                >
                    <Spin
                        indicator={
                            <LoadingOutlined style={{ fontSize: 48 }} spin />
                        }
                    />
                </div>
            ) : (
                <div>Settings loaded {JSON.stringify(settings)}</div>
            )}
        </>
    );
}

export default AutoAVIndex;
