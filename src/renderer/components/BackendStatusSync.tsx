// This returns a blank component that is used to monitor the backend status and sync with the status state

import { useContext, useEffect } from 'react';
import StatusContext, { StatusContextType } from '../hooks/status_state';

function BackendStatusSync() {
    const { setStatus } = useContext(StatusContext);

    useEffect(() => {
        // Callback function
        const callback = (arg: { key: keyof StatusContextType; val: any }) => {
            setStatus((prevState) => ({ ...prevState, [arg.key]: arg.val }));
        };

        // Register listener
        window.electron.ipcRenderer.on('backend-status-update', callback);

        // Send message to backend.  Any service that makes a status should be listening, and send their most recent status here
        window.electron.ipcRenderer.sendMessage('backend-status', []);

        return () => {
            // Unregister listener
            window.electron.ipcRenderer.removeListener(
                'backend-status',
                callback
            );
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []); // only run once

    return null;
}

export default BackendStatusSync;
