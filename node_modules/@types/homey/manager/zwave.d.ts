export = ManagerZwave;
/**
 * @hideconstructor
 * @classdesc
 * You can access this manager through the {@link Homey} instance as `this.homey.zwave`
 */
declare class ManagerZwave extends Manager {
    static ID: string;
    /**
     * Create a ZwaveNode instance for a Device
     * @param {Device} device - An instance of Device
     * @returns {Promise<ZwaveNode>}
     * @example
     * const node = await this.homey.zwave.getNode(this);
     *
     * node.CommandClass.COMMAND_CLASS_BASIC.on('report', (command, report) => {
     *   this.log('onReport', command, report);
     * });
     *
     * node.CommandClass.COMMAND_CLASS_BASIC.BASIC_SET({ Value: 0xFF })
     *   .then(this.log)
     *   .catch(this.error);
     */
    getNode(device: Device): Promise<ZwaveNode>;
}
import Manager = require("../lib/Manager.js");
import Device = require("../lib/Device.js");
import ZwaveNode = require("../lib/ZwaveNode.js");
