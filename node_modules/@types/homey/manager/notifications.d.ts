export = ManagerNotifications;
/**
 * @hideconstructor
 * @classdesc
 * You can access this manager through the {@link Homey} instance as `this.homey.notifications`
 */
declare class ManagerNotifications extends Manager {
    static ID: string;
    /**
     * Create a notification
     * @param {object} options
     * @param {string} options.excerpt A short message describing the notification. Use **asterisks** to highlight variable words.
     */
    createNotification({ excerpt }: {
        excerpt: string;
    }): Promise<void>;
}
import Manager = require("../lib/Manager.js");
