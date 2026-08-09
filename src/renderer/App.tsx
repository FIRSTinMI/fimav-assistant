import { useMemo, useState } from 'react';
import { ConfigProvider, theme } from 'antd';
import './App.css';
import AppRoutes, { AppRouter } from './AppRoutes';
import StatusContext, { StatusContextType } from './hooks/status_state';
import BackendStatusSync from './components/BackendStatusSync';
import AppFooter from './components/Footer';
import TabBar from './components/TabBar';

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

                <AppRouter>
                    <TabBar />

                    <div
                        className="pretty-scroll"
                        style={{
                            height: 'calc(100vh - 40px - 44px)',
                            overflowY: 'auto',
                        }}
                    >
                        <AppRoutes />
                    </div>
                </AppRouter>

                <AppFooter />
            </StatusContext.Provider>
        </ConfigProvider>
    );
}
