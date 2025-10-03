import DiscoveryResult = require("./DiscoveryResult");

export = DiscoveryResultMDNSSD;
/**
 * This is a discovery result of a mDNS-SD discovery strategy.
 * This class should not be instanced manually.
 * @extends DiscoveryResult
 * @since 2.5.0
 */
declare class DiscoveryResultMDNSSD extends DiscoveryResult {
    /** The identifier of the result. */
    id: string;
    /** When the device has been last discovered. */
    lastSeen: Date;
    /** The (IP) address of the device. */
    address: string;
    /** The port of the device. */
    port: string;
    /** The TXT records of the device, key-value. */
    txt: object;
    /** The name of the device. */
    name: string;
    /** The full name of the device. */
    fullname: string;
    /** The host of the device. */
    host: string;
}
