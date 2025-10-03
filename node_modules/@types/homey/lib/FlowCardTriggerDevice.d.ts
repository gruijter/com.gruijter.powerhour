export = FlowCardTriggerDevice;
/**
 * @typedef {import('../manager/flow')} ManagerFlow
 * @typedef {import('./Device')} Device
 */
/**
 * The FlowCardTriggerDevice class is a programmatic representation of a Flow Card with type `trigger` and an argument with type `device` and a filter with `driver_id`, as defined in an app's <code>app.json</code>.
 * @extends FlowCard
 */
declare class FlowCardTriggerDevice extends FlowCard {
    /**
     * Trigger this card to start a Flow
     * @param {Device} device - A Device instance
     * @param {object=} tokens - An object with tokens and their typed values, as defined in an app's <code>app.json</code>
     * @param {object=} state - An object with properties which are accessible throughout the Flow
     * @returns {Promise<any>} Promise resolves when flow is triggered
     */
     trigger(device: Device, tokens?: object | undefined, state?: object | undefined): Promise<any>;
    /**
     * Get the current argument values of this card, as filled in by the user, for a specific device.
     * @param {Device} device - A Device instance
     * @returns {Promise<any[]>} A Promise that resolves to an array of key-value objects with the argument's name as key. Every array entry represents one Flow card.
     */
    getArgumentValues(device: Device): Promise<any[]>;
}
declare namespace FlowCardTriggerDevice {
    export { ManagerFlow, Device };
}
import FlowCard = require("./FlowCard.js");
type Device = import('./Device');
type ManagerFlow = import('../manager/flow');
