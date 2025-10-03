export = ManagerLedring;
/**
 * @hideconstructor
 * @classdesc
 * You can access this manager through the {@link Homey} instance as `this.homey.ledring`
 */
declare class ManagerLedring extends Manager {
    static ID: string;
    /**
     * > Requires the `homey:manager:ledring` permission.
     * > For more information about permissions read the [Permissions tutorial](https://app.gitbook.com/@athom/s/homey-apps/the-basics/app/permissions).
     *
     * @param {object} opts
     * @param {LedringAnimation.Frame[]} opts.frames An array of frames. A frame is an Array of 24 objects with a `r`, `g` and `b` property, which are numbers between 0 and 255.
     * @param {string} opts.priority How high the animation will have on the priority stack. Can be either `INFORMATIVE`, `FEEDBACK` or `CRITICAL`.
     * @param {number} opts.transition Transition time (in ms) how fast to fade the information in. Defaults to `300`.
     * @param {number|Boolean} opts.duration Duration (in ms) how long the animation should be shown. Defaults to `false`. `false` is required for screensavers.
     * @param {object} opts.options
     * @param {number} opts.options.fps Frames per second
     * @param {number} opts.options.tfps Target frames per second (must be divisible by fps)
     * @param {number} opts.options.rpm Rotations per minute
     * @returns {Promise<LedringAnimation>}
     */
    createAnimation(opts: {
        frames: LedringAnimation.Frame[];
        priority: string;
        transition: number;
        duration: number | boolean;
        options: {
            fps: number;
            tfps: number;
            rpm: number;
        };
    }): Promise<LedringAnimation>;
    /**
     * > Requires the `homey:manager:ledring` permission.
     * > For more information about permissions read the [Permissions tutorial](https://app.gitbook.com/@athom/s/homey-apps/the-basics/app/permissions).
     *
     * @param {string} systemId The system animation's ID. Can be either `colorwipe`, `loading`, `off`, `progress`, `pulse`, `rainbow`, `rgb` or `solid`.
     * @param {object} opts
     * @param {string} opts.priority How high the animation will have on the priority stack. Can be either `INFORMATIVE`, `FEEDBACK` or `CRITICAL`.
     * @param {number|boolean} opts.duration Duration (in ms) how long the animation should be shown. Defaults to `false`. `false` is required for screensavers.
     * @returns {Promise<LedringAnimation>}
     */
    createSystemAnimation(systemId: string, opts: {
        priority: string;
        duration: number | boolean;
    }): Promise<LedringAnimation>;
    /**
     * > Requires the `homey:manager:ledring` permission.
     * > For more information about permissions read the [Permissions tutorial](https://app.gitbook.com/@athom/s/homey-apps/the-basics/app/permissions).
     *
     * @param {object} opts
     * @param {string} opts.priority How high the animation will have on the priority stack. Can be either `INFORMATIVE`, `FEEDBACK` or `CRITICAL`.
     * @param {object} opts.options
     * @param {string} opts.options.color=#0092ff A HEX string
     */
    createProgressAnimation(opts: {
        priority: string;
        options: {
            color: string;
        };
    }): Promise<LedringAnimation>;
    /**
     * Register a LED Ring animation.
     *
     * > Requires the `homey:manager:ledring` permission.
     * > For more information about permissions read the [Permissions tutorial](https://app.gitbook.com/@athom/s/homey-apps/the-basics/app/permissions).
     *
     * @param {LedringAnimation} animation
     * @returns {Promise<LedringAnimation>}
     */
    registerAnimation(animation: LedringAnimation): Promise<LedringAnimation>;
    /**
     * Unregister a LED Ring animation.
     *
     * > Requires the `homey:manager:ledring` permission.
     * > For more information about permissions read the [Permissions tutorial](https://app.gitbook.com/@athom/s/homey-apps/the-basics/app/permissions).
     *
     * @param {LedringAnimation} animation
     * @returns {Promise<LedringAnimation>}
     */
    unregisterAnimation(animation: LedringAnimation): Promise<LedringAnimation>;
    /**
     * Register a LED Ring screensaver.
     *
     * > Requires the `homey:manager:ledring` permission.
     * > For more information about permissions read the [Permissions tutorial](https://app.gitbook.com/@athom/s/homey-apps/the-basics/app/permissions).
     *
     * @param {string} name - Name of the animation as defined in your app's `app.json`.
     * @param {LedringAnimation} animation
     * @returns {Promise<any>}
     */
    registerScreensaver(name: string, animation: LedringAnimation): Promise<any>;
    /**
     * Unregister a LED Ring screensaver.
     *
     * > Requires the `homey:manager:ledring` permission.
     * > For more information about permissions read the [Permissions tutorial](https://app.gitbook.com/@athom/s/homey-apps/the-basics/app/permissions).
     *
     * @param {string} name - Name of the animation as defined in your app's `app.json`.
     * @param {LedringAnimation} animation
     * @returns {Promise<any>}
     */
    unregisterScreensaver(name: string, animation: LedringAnimation): Promise<any>;
}
import Manager = require("../lib/Manager.js");
import LedringAnimation = require("../lib/LedringAnimation.js");
