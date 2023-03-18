
import { MemoryRouter as Router, Routes, Route } from 'react-router-dom';
import HWCheck from './pages/hwcheck';
import Welcome from './pages/welcome';


const AppRoutes = () => {
    return (
        <Router>
            <Routes>
                <Route path="/" element={<Welcome />} />

                {/* Each Step should be defined here, and each step handles itself. Use this to rearrange steps */}
                <Route path="/step/1" element={<HWCheck nextStep={2} previousStep={0} />} />
            </Routes>
        </Router>
    );
};

export default AppRoutes;