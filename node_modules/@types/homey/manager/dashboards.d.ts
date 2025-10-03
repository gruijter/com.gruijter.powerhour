export = ManagerDashboards;
/**
 * @hideconstructor
 * @classdesc
 * You can access this manager through the {@link Homey} instance as `this.homey.dashboards`
 */
declare class ManagerDashboards extends Manager {
    static ID: string;
    /**
     * Get a widget
     * @param {string} id
     * @returns {Widget}
     */
    getWidget(id: string): Widget;
}
import Manager = require("../lib/Manager.js");
import Widget = require("../lib/Widget.js");
