export = InsightsLog;
/**
 * This class represents a Log in Insights.
 * This class should not be instanced manually, but retrieved using a method in {@link ManagerInsights} instead.
 */
declare class InsightsLog {
    get name(): any;
    /**
     * Create a new log entry with the given value.
     * @param {number|boolean} value
     * @returns {Promise<any>}
     */
    createEntry(value: number | boolean): Promise<any>;
    toJSON(): {
        name: any;
        options: any;
    };
}
