export = DiscoveryStrategy;
/**
 * This class should not be instanced manually, but created by calling {@link ManagerDiscovery#getStrategy} instead.
 * @since 2.5.0
 */
declare class DiscoveryStrategy extends SimpleClass {
    type: string;
    /**
     * Get all discovery results as an object.
     * @returns {Object<string, DiscoveryResultMDNSSD | DiscoveryResultSSDP | DiscoveryResultMAC>}
     */
    getDiscoveryResults(): {
        [x: string]: DiscoveryResultMDNSSD | DiscoveryResultSSDP | DiscoveryResultMAC;
    };
    /**
     * Get a specific discovery result.
     * @param {string} id
     * @returns {DiscoveryResultMDNSSD | DiscoveryResultSSDP | DiscoveryResultMAC}
     */
    getDiscoveryResult(id: string): DiscoveryResultMDNSSD | DiscoveryResultSSDP | DiscoveryResultMAC;
}
declare namespace DiscoveryStrategy {
    export { DiscoveryResultMDNSSD, DiscoveryResultSSDP, DiscoveryResultMAC };
}
import SimpleClass = require("./SimpleClass.js");
type DiscoveryResultMDNSSD = import('./DiscoveryResultMDNSSD');
type DiscoveryResultSSDP = import('./DiscoveryResultSSDP');
type DiscoveryResultMAC = import('./DiscoveryResultMAC');
