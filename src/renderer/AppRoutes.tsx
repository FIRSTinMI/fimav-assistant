
import { HashRouter, BrowserRouter, Routes, Route } from 'react-router-dom';
let Router: typeof HashRouter | typeof BrowserRouter;
if (!process.env.NODE_ENV || process.env.NODE_ENV === "development") {
    Router = HashRouter;
} else {
    Router = HashRouter;
}
import HWCheck from './pages/hwcheck';
import Welcome from './pages/welcome';
import Alerts from './pages/alerts';


const AppRoutes = () => {
    return (
        <Router>
            <Routes>
                <Route path="/" element={<Welcome />} />
                <Route path="/alerts" element={<Alerts />} />

                {/* Each Step should be defined here, and each step handles itself. Use this to rearrange steps */}
                <Route path="/step/1" element={<HWCheck nextStep={2} previousStep={0} />} />
            </Routes>
        </Router>
    );
};

export default AppRoutes;