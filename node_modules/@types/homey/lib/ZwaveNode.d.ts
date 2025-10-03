export = ZwaveNode;
/**
 * This class is a representation of a Z-Wave Device in Homey.
 * This class must not be initiated by the developer, but retrieved by calling {@link ManagerZwave#getNode}.
 * @property {boolean} online - If the node is online
 * @property {object} CommandClass - An object with {@link ZwaveCommandClass} instances
 * @property {number} nodeId - The id of the node within the Zwave network
 * @property {string} deviceClassBasic - Basic device class
 * @property {string} deviceClassGeneric - Generic device class
 * @property {string} deviceClassSpecific - Specific device class
 * @property {object} manufacturerId - The manufacturer id, in the value property of the object
 * @property {object} productTypeId - The product type id, in the value property of the object
 * @property {object} productId - The product id, in the value property of the object
 * @property {number} firmwareId - Firmware identifier
 * @property {boolean} battery - Whether the node is battery operated
 * @property {number|undefined} multiChannelNodeId - If this is a multichannel node, the id
 * @property {boolean} isMultiChannelNode - Whether this node is a multichannel node
 */
declare class ZwaveNode extends SimpleClass {
    online: any;
    /** @type {Object<string, ZwaveCommandClass>} */
    CommandClass: {
        [x: string]: ZwaveCommandClass;
    };
    /** @type {Object<string, ZwaveNode>} */
    MultiChannelNodes: {
        [x: string]: ZwaveNode;
    };
    /**
     * This method can be used to send a raw command to a node.
     * @param {object} command
     * @param {number} command.commandClassId The command class identified
     * @param {number} command.commandId The command identified
     * @param {Buffer=} command.params The command data as a buffer
     * @returns {Promise<void>}
     */
    sendCommand({ commandClassId, commandId, params }: {
        commandClassId: number;
        commandId: number;
        params?: Buffer | undefined;
    }): Promise<void>;
    /**
     * This event is fired when a battery node changed it's online or offline status.
     * @property {boolean} online - If the node is online
     * @event ZwaveNode#online
     */
    /**
     * This event is fired when a Node Information Frame (NIF) has been sent.
     * @property {Buffer} nif
     * @event ZwaveNode#nif
     */
    /**
     * This event is fired when a a Node has received an unknown command, usually due to a missing Command Class.
     * @property {Buffer} data
     * @event ZwaveNode#unknownReport
     */
    nodeId: number;
    deviceClassBasic: string;
    deviceClassGeneric: string;
    deviceClassSpecific: string;
    manufacturerId: {
        value: number,
    };
    productTypeId: {
        value: number,
    };
    productId: {
        value: number,
    };
    firmwareId: number;
    battery: boolean;
    multiChannelNodeId: number|undefined;
    isMultiChannelNode: boolean;
}
import SimpleClass = require("./SimpleClass.js");
import ZwaveCommandClass = require("./ZwaveCommandClass.js");
