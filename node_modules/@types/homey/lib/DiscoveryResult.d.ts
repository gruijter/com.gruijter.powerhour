export = DiscoveryResult;
/**
 * @classdesc
 * This class should not be instanced manually.
 * @since 2.5.0
 * @hideconstructor
 */
declare class DiscoveryResult extends SimpleClass {
    /**
     * The identifier of the result.
     * @type {string}
     */
    id: string;
    /**
     * When the device has been last discovered.
     * @type {Date}
     */
    lastSeen: Date;
}
import SimpleClass = require("./SimpleClass.js");
