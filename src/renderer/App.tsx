import { ConfigProvider } from 'antd';
import './App.css';
import AppRoutes from './AppRoutes';

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
