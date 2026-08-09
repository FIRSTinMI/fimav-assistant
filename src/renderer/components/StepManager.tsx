import { useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { getStep } from 'renderer/web_utils/step_manager';

function StepManager() {
    const nav = useNavigate();
    const { pathname } = useLocation();

    // On first load, resume the saved step. Only redirect from the root so
    // that landing on another tab (e.g. Auto AV) isn't bounced into the wizard.
    useEffect(() => {
        if (pathname !== '/') return;
        getStep()
            .then((step) => {
                if (step > 0) {
                    nav(`/step/${step}`);
                }

                return null;
            })
            .catch(() => {});
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    return null;
}

export default StepManager;
