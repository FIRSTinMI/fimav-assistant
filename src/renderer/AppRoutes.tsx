import { HashRouter, BrowserRouter, Routes, Route } from 'react-router-dom';
import HWCheck from './pages/hwcheck';
import Welcome from './pages/welcome';
import InternetSetup from './pages/internet_setup';
import Alerts from './pages/alerts';
import AutoAV from './pages/autoav';
import CameraSetup from './pages/camera_setup';
import FallbackToDocs from './pages/fallbackToDocs';

let Router: typeof HashRouter | typeof BrowserRouter;
if (!process.env.NODE_ENV || process.env.NODE_ENV === 'development') {
    Router = HashRouter;
} else {
    Router = HashRouter;
}

function AppRoutes() {
    return (
        <Router>
            {/* App Routes */}
            <Routes>
                <Route path="/" element={<Welcome />} />
                <Route path="/alerts" element={<Alerts />} />
                <Route path="/autoav" element={<AutoAV />} />

                {/* Each Step should be defined here, and each step handles itself. Use this to rearrange steps */}
                <Route
                    path="/step/1"
                    element={<HWCheck nextStep={2} previousStep={0} />}
                />
                <Route
                    path="/step/2"
                    element={<InternetSetup nextStep={3} previousStep={1} />}
                />
                <Route
                    path="/step/3"
                    element={<CameraSetup nextStep={4} previousStep={2} />}
                />
                <Route
                    path="/step/4"
                    element={<FallbackToDocs nextStep={4} previousStep={3} />}
                />
            </Routes>
        </Router>
    );
}

export default AppRoutes;
