export = LedringAnimationSystemProgress;
/**
 * This class contains a system animation that can be played on Homey's LED Ring.
 * @extends LedringAnimationSystem
 */
declare class LedringAnimationSystemProgress extends LedringAnimationSystem {
    /**
     * Set the current progress
     * @param {number} progress - A progress number between 0 - 1
     * @returns {Promise<any>}
     */
    setProgress(progress: number): Promise<any>;
}
import LedringAnimationSystem = require("./LedringAnimationSystem.js");
