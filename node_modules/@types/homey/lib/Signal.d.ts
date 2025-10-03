export = Signal;
/**
 * @typedef {import('../manager/rf')} ManagerRF
 */
/**
 * The Signal class represents an Signal as defined in the app's <code>app.json</code>.
 */
declare class Signal extends SimpleClass {
    id: string;
    frequency: string;
    /**
     * Start receiving messages for this signal.
     * This is a shorthand method for {@link ManagerRF#enableSignalRX}.
     * @returns {Promise<void>}
     */
    enableRX(): Promise<void>;
    /**
     * Stop receiving messages for this signal.
     * This is a shorthand method for {@link ManagerRF#disableSignalRX}.
     * @returns {Promise<void>}
     */
    disableRX(): Promise<void>;
    /**
     * Transmit a frame
     * @param {number[]} frame - An array of word indexes
     * @param {object} [opts] - Transmission options
     * @param {object} [opts.repetitions] - A custom amount of repetitions
     * @returns {Promise<any>}
     */
    tx(frame: number[], opts?: {
        repetitions?: object | undefined;
    } | undefined): Promise<any>;
    /**
     * Transmit a command
     * @param {string} commandId - The ID of the command, as specified in `/app.json`
     * @param {object} [opts] - Transmission options
     * @param {object} [opts.repetitions] - A custom amount of repetitions
     * @returns {Promise<any>}
     */
    cmd(commandId: string, opts?: {
        repetitions?: object | undefined;
    } | undefined): Promise<any>;
}
declare namespace Signal {
    export { ManagerRF };
}
import SimpleClass = require("./SimpleClass.js");
type ManagerRF = import('../manager/rf');
