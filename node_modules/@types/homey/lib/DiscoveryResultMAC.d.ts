import DiscoveryResult = require("./DiscoveryResult");

export = DiscoveryResultMAC;
/**
 * This is a discovery result of a MAC discovery strategy.
 * This class should not be instanced manually.
 * @extends DiscoveryResult
 * @since 2.5.0
 */
declare class DiscoveryResultMAC extends DiscoveryResult {
    /** The identifier of the result. */
    id: string;
    /** When the device has been last discovered. */
    lastSeen: Date;
    /** The (IP) address of the device. */
    address: string;
    /** The MAC address of the device. */
    mac: string;
}
