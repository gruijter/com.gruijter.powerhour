export = ManagerZigBee;
/**
 * @hideconstructor
 * @classdesc
 * You can access this manager through the {@link Homey} instance as `this.homey.zigbee`
 */
declare class ManagerZigBee extends Manager {
    static ID: string;
    /**
     * Get a ZigBeeNode instance for a Device
     * @param {Device} device - An instance of Device
     * @returns {Promise<ZigBeeNode>}
     */
    getNode(device: Device): Promise<ZigBeeNode>;
}
import Manager = require("../lib/Manager.js");
import Device = require("../lib/Device.js");
import ZigBeeNode = require("../lib/ZigBeeNode.js");
