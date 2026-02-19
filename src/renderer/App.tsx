import { useMemo, useState } from 'react';
import { ConfigProvider, theme } from 'antd';
import './App.css';
import AppRoutes from './AppRoutes';
import StatusContext, { StatusContextType } from './hooks/status_state';
import BackendStatusSync from './components/BackendStatusSync';
import AppFooter from './components/Footer';

export default function App() {
    const [status, setStatus] = useState<StatusContextType>({
        auto_av_log: null,
        hw_stats: {
            camera1: false,
            camera2: false,
            mixer: false,
            switch: false,
            internet: false,
            errors: [],
            ip_warnings: [],
            ip_errors: [],
        },
    });

    const contextValue = useMemo(
        () => ({ status, setStatus }),
        [status, setStatus]
    );

    return (
        <ConfigProvider
            theme={{
                algorithm: theme.darkAlgorithm,
                token: {
                    // colorPrimary: '#00b96b',
                },
            }}
        >
            <StatusContext.Provider value={contextValue}>
                <BackendStatusSync />

                <div
                    className="pretty-scroll"
                    style={{ height: 'calc(100vh - 40px)', overflowY: 'auto' }}
                >
                    <AppRoutes />
                </div>

                <AppFooter />
            </StatusContext.Provider>
        </ConfigProvider>
    );
}
