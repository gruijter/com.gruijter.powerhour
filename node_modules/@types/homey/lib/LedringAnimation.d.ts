export = LedringAnimation;
/**
 * @typedef {import('../manager/ledring')} ManagerLedring
 */
/**
 * @typedef LedringAnimation.Frame
 * @property {number} r between 0 and 255.
 * @property {number} g between 0 and 255.
 * @property {number} b between 0 and 255.
 */
/**
 * This class contains an animation that can be played on Homey's LED Ring.
 */
declare class LedringAnimation extends events.EventEmitter {
    opts: {
        frames: LedringAnimation.Frame[];
        priority: string;
        transition: number;
        duration: number | boolean;
        options: {
            fps: number;
            tfps: number;
            rpm: number;
        };
    };
    /**
     * @event LedringAnimation#start
     * @desc When the animation has started
     */
    /**
     * @event LedringAnimation#stop
     * @desc When the animation has stopped
     */
    /**
     * @event LedringAnimation#finish
     * @desc When the animation has finished (duration has been reached)
     */
    /**
     * Start the animation.
     * @returns {Promise<any>}
     */
    start(): Promise<any>;
    /**
     * Stop the animation.
     * @returns {Promise<any>}
     */
    stop(): Promise<any>;
    /**
     * Update the animation frames.
     * @param {LedringAnimation.Frame[]} frames
     * @returns {Promise<any>}
     */
    updateFrames(frames: LedringAnimation.Frame[]): Promise<any>;
    /**
     * Unregister the animation. This is a shorthand method to {@link ManagerLedring#unregisterAnimation}.
     * @returns {Promise<LedringAnimation>}
     */
    unregister(): Promise<LedringAnimation>;
    /**
     * Register this animation as a screensaver. This is a shorthand method to {@link ManagerLedring#registerScreensaver}.
     * @param {String} screensaverName - The name of the screensaver, as defined in `/app.json`
     * @returns {Promise<any>}
     */
    registerScreensaver(screensaverName: string): Promise<any>;
    /**
     * Unregister this animation as a screensaver. This is a shorthand method to {@link ManagerLedring#unregisterScreensaver}.
     * @param {String} screensaverName - The name of the screensaver, as defined in `/app.json`
     * @returns {Promise<any>}
     */
    unregisterScreensaver(screensaverName: string): Promise<any>;
    toJSON(): {
        frames: LedringAnimation.Frame[];
        priority: string;
        transition: number;
        duration: number | boolean;
        options: {
            fps: number;
            tfps: number;
            rpm: number;
        };
    };
}
declare namespace LedringAnimation {
    export { Frame, ManagerLedring };
}
import events = require("events");
type ManagerLedring = import('../manager/ledring');
type Frame = {
    /**
     * between 0 and 255.
     */
    r: number;
    /**
     * between 0 and 255.
     */
    g: number;
    /**
     * between 0 and 255.
     */
    b: number;
};
