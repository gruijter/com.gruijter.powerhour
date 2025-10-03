export = ManagerFlow;
/**
 * @hideconstructor
 * @classdesc
 * You can access this manager through the {@link Homey} instance as `this.homey.flow`
 */
declare class ManagerFlow extends Manager {
    static ID: string;
    /**
     * @param {string} id The ID of the card as defined in the app's `app.json`.
     * @returns {FlowCardAction}
     */
    getActionCard(id: string): FlowCardAction;
    /**
     * @param {string} id The ID of the card as defined in the app's `app.json`.
     * @returns {FlowCardCondition}
     */
    getConditionCard(id: string): FlowCardCondition;
    /**
     * @param {string} id The ID of the card as defined in the app's `app.json`.
     * @returns {FlowCardTrigger}
     */
    getTriggerCard(id: string): FlowCardTrigger;
    /**
     * @param {string} id The ID of the card as defined in the app's `app.json`.
     * @returns {FlowCardTriggerDevice}
     */
    getDeviceTriggerCard(id: string): FlowCardTriggerDevice;
    /**
     * The FlowToken class can be used to create a Tag in the Flow Editor.
     * @param {string} id - ID of the token, should be alphanumeric.
     * @param {object} opts
     * @param {string} opts.type - Type of the token, can be either `string`, `number`, `boolean` or `image`.
     * @param {string} opts.title - Title of the token
     * @param {*} opts.value - Initial value of the token
     * @returns {Promise<FlowToken>}
     */
    createToken(id: string, opts: {
        type: string;
        title: string;
        value: any,
    }): Promise<FlowToken>;

    /**
    * @param {string} id The ID of the token, as provided in `createToken`.
    * @returns {FlowToken}
    */
    getToken(id: string): FlowToken

    /**
     * Unregister a {@link FlowToken}.
     * @param {FlowToken} tokenInstance
     * @returns {Promise<any>}
     */
    unregisterToken(tokenInstance: FlowToken): Promise<any>;
}
import Manager = require("../lib/Manager.js");
import FlowCardAction = require("../lib/FlowCardAction.js");
import FlowCardCondition = require("../lib/FlowCardCondition.js");
import FlowCardTrigger = require("../lib/FlowCardTrigger.js");
import FlowCardTriggerDevice = require("../lib/FlowCardTriggerDevice.js");
import FlowToken = require("../lib/FlowToken.js");
