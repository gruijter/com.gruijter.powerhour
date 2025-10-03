export = ManagerRF;
/**
 * @hideconstructor
 * @classdesc
 * You can access this manager through the {@link Homey} instance as `this.homey.rf`
 */
declare class ManagerRF extends Manager {
    static ID: string;
    /**
     * Transmit a raw frame using the specified signal.
     *
     * > Requires the `homey:wireless:433`, `homey:wireless:868` and/or `homey:wireless:ir` permissions.
     * > For more information about permissions read the [Permissions tutorial](https://app.gitbook.com/@athom/s/homey-apps/the-basics/app/permissions).
     *
     * @param {Signal} signal used to transmit data
     * @param {Array<number> | Buffer} frame data to be transmitted
     * @param {{ repetitions: number }=} opts
     */
    tx(signal: Signal, frame: Array<number> | Buffer, opts?: {
        repetitions: number;
    } | undefined): Promise<any>;
    /**
     * Send a predefined command using the specified signal.
     *
     * > Requires the `homey:wireless:433`, `homey:wireless:868` and/or `homey:wireless:ir` permissions.
     * > For more information about permissions read the [Permissions tutorial](https://app.gitbook.com/@athom/s/homey-apps/the-basics/app/permissions).
     *
     * @param {Signal} signal used to transmit data
     * @param {string} commandId name of the command as specified in the app manifest
     * @param {{ repetitions: number }=} opts
     */
    cmd(signal: Signal, commandId: string, opts?: {
        repetitions: number;
    } | undefined): Promise<any>;
    /**
     * @param {string} id The ID of the signal, as defined in the app's <code>app.json</code>.
     * @returns {Signal433}
     */
    getSignal433(id: string): Signal433;
    /**
     * @param {string} id The ID of the signal, as defined in the app's <code>app.json</code>.
     * @returns {Signal868}
     */
    getSignal868(id: string): Signal868;
    /**
     * @param {string} id The ID of the signal, as defined in the app's <code>app.json</code>.
     * @returns {SignalInfrared}
     */
    getSignalInfrared(id: string): SignalInfrared;
    /**
     * Enables a signal to start receiving events.
     *
     * > Requires the `homey:wireless:433`, `homey:wireless:868` and/or `homey:wireless:ir` permissions.
     * > For more information about permissions read the [Permissions tutorial](https://app.gitbook.com/@athom/s/homey-apps/the-basics/app/permissions).
     *
     * @template {Signal} T
     * @param {T} signal
     * @returns {Promise<T>}
     */
    enableSignalRX<T extends Signal>(signal: T): Promise<T>;
    /**
     * Disables a signal from receiving events.
     *
     * > Requires the `homey:wireless:433`, `homey:wireless:868` and/or `homey:wireless:ir` permissions.
     * > For more information about permissions read the [Permissions tutorial](https://app.gitbook.com/@athom/s/homey-apps/the-basics/app/permissions).
     *
     * @param {Signal} signal
     * @returns {Promise<void>}
     */
    disableSignalRX(signal: Signal): Promise<void>;
}
import Manager = require("../lib/Manager.js");
import Signal = require("../lib/Signal.js");
import Signal433 = require("../lib/Signal433.js");
import Signal868 = require("../lib/Signal868.js");
import SignalInfrared = require("../lib/SignalInfrared.js");
