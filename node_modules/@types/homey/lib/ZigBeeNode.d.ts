export = ZigBeeNode;
/**
 * This class is a representation of a Zigbee Device in Homey.
 * This class must not be initiated directly, but retrieved by calling {@link ManagerZigBee#getNode}.
 * @property {string} manufacturerName
 * @property {string} productId
 * @property {boolean} receiveWhenIdle Reflects whether ZigBeeNode can receive commands while
 * idle. If this property is false the ZigBeeNode is a Sleepy End Device (SED, check the [Zigbee Cluster Specification (PDF)](https://etc.athom.com/zigbee_cluster_specification.pdf) for more information). In that case it can not be assumed that
 * the device will timely respond to commands and or requests, it will only be 'awake' for a
 * short amount of time on an unknown interval.
 *
 * @example
 * // device.js
 * const zigBeeNode = await this.homey.zigbee.getNode(this);
 */
declare class ZigBeeNode extends SimpleClass {
    /**
     * This method should not be used. It is available as fallback in case app
     * migrations require interviewing of nodes to determine their endpoint
     * descriptors.
     * @returns {Promise<void>}
     * @private
     */
    private interview;
    /**
     * Call this method to send a frame this ZigBeeNode.
     * @param {number} endpointId
     * @param {number} clusterId
     * @param {Buffer} frame
     * @returns {Promise<void>}
     */
    sendFrame(endpointId: number, clusterId: number, frame: Buffer): Promise<void>;
    /**
     * This method is called when a frame has been received from this ZigBeeNode.
     * This method must be overridden.
     * @param {number} endpointId
     * @param {number} clusterId
     * @param {Buffer} frame
     * @param {object} meta
     * @returns {Promise<void>}
     */
    handleFrame(endpointId: number, clusterId: number, frame: Buffer, meta: object): Promise<void>;
}
import SimpleClass = require("./SimpleClass.js");
