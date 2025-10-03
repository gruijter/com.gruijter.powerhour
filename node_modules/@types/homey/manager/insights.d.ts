export = ManagerInsights;
/**
 * @hideconstructor
 * @classdesc
 * You can access this manager through the {@link Homey} instance as `this.homey.insights`
 */
declare class ManagerInsights extends Manager {
    static ID: string;
    /**
     * Get all logs belonging to this app.
     * @returns {Promise<InsightsLog[]>} An array of {@link InsightsLog} instances
     */
    getLogs(): Promise<InsightsLog[]>;
    /**
     * Get a specific log belonging to this app.
     * @param {string} id - ID of the log (must be lowercase, alphanumeric)
     * @returns {Promise<InsightsLog>}
     */
    getLog(id: string): Promise<InsightsLog>;
    /**
     * Create a log.
     * @param {string} id - ID of the log (must be lowercase, alphanumeric)
     * @param {object} options
     * @param {string} options.title - Log's title
     * @param {string} options.type - Value type, can be either <em>number</em> or <em>boolean</em>
     * @param {string} [options.units] - Units of the values, e.g. <em>°C</em>
     * @param {number} [options.decimals] - Number of decimals visible
     * @returns {Promise<InsightsLog>}
     */
    createLog(id: string, options: {
        title: string;
        type: string;
        units?: string | undefined;
        decimals?: number | undefined;
    }): Promise<InsightsLog>;
    /**
     * Delete a log.
     * @param {InsightsLog} log
     * @returns {Promise<any>}
     */
    deleteLog(log: InsightsLog): Promise<any>;
}
import Manager = require("../lib/Manager.js");
import InsightsLog = require("../lib/InsightsLog.js");
