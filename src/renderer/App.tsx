import { ConfigProvider } from 'antd';
import './App.css';
import AppRoutes from './AppRoutes';
import { useEffect } from 'react';
import { getStep } from './web_utils/step_manager';
import { useNavigate } from 'react-router-dom';

export default function App() {
    return (
        <ConfigProvider
            theme={{
                token: {
                    // colorPrimary: '#00b96b',
                },
            }}
        >
            <AppRoutes />
        </ConfigProvider>
    );
}
