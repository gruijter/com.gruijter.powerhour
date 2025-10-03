import DiscoveryResult = require("./DiscoveryResult");

export = DiscoveryResultSSDP;
/**
 * This is a discovery result of a SSDP discovery strategy.
 * This class should not be instanced manually.
 * @extends DiscoveryResult
 * @since 2.5.0
 */
declare class DiscoveryResultSSDP extends DiscoveryResult {
    /** The identifier of the result. */
    id: string;
    /** When the device has been last discovered. */
    lastSeen: Date;
    /** The (IP) address of the device. */
    address: string;
    /** The port of the device. */
    port: string;
    /** The headers (lowercase) in the SSDP response. */
    headers: object;
}
