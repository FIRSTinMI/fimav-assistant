import { EventEmitter } from 'events';
import { AddonPhase } from '../../models/AddonPhase';

// An add-on's phase, with a 'phase' event on every change (the checks and
// the status API read it).
export default class AddonPhaseTracker extends EventEmitter {
    private value: AddonPhase = 'stopped';

    public get(): AddonPhase {
        return this.value;
    }

    public set(p: AddonPhase) {
        if (p === this.value) return;
        this.value = p;
        this.emit('phase', p);
    }
}
