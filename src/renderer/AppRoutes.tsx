
import { MemoryRouter as Router, Routes, Route } from 'react-router-dom';
import HWCheck from './pages/hwcheck';
import Welcome from './pages/welcome';
import InternetSetup from './pages/internet_setup';


const AppRoutes = () => {
    return (
        <Router>
            <Routes>
                <Route path="/" element={<Welcome />} />

                {/* Each Step should be defined here, and each step handles itself. Use this to rearrange steps */}
                <Route path="/step/1" element={<HWCheck nextStep={2} previousStep={0} />} />
                <Route path="/step/2" element={<InternetSetup nextStep={3} previousStep={1} />} />
            </Routes>
        </Router>
    );
};

export default AppRoutes;